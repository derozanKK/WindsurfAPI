import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountState, classifyTransition, cooldownState, collapse, createPoolEventDetector } from '../src/dashboard/pool-events.js';

const acc = (id, over = {}) => ({ id, ref: id, status: 'active', rateLimited: false, capacityThrottled: false, quotaCooled: false, ...over });

describe('accountState', () => {
  it('maps flags to coarse state by priority', () => {
    assert.equal(accountState(acc('a')), 'active');
    assert.equal(accountState(acc('a', { capacityThrottled: true })), 'capacity');
    assert.equal(accountState(acc('a', { rateLimited: true })), 'rate_limited');
    assert.equal(accountState(acc('a', { quotaCooled: true })), 'quota');
    assert.equal(accountState(acc('a', { status: 'disabled' })), 'disabled');
    assert.equal(accountState(acc('a', { status: 'error' })), 'error');
    assert.equal(accountState(acc('a', { status: 'reauth' })), 'reauth');
  });
  it('rate-limit outranks capacity; quota outranks rate-limit; disabled wins all', () => {
    assert.equal(accountState(acc('a', { rateLimited: true, capacityThrottled: true })), 'rate_limited');
    assert.equal(accountState(acc('a', { quotaCooled: true, rateLimited: true })), 'quota');
    assert.equal(accountState(acc('a', { status: 'disabled', quotaCooled: true })), 'disabled');
  });
  it('reauth is terminal: it outranks every self-healing cooldown', () => {
    assert.equal(accountState(acc('a', { status: 'reauth', quotaCooled: true, rateLimited: true, capacityThrottled: true })), 'reauth');
    assert.equal(accountState(acc('a', { status: 'banned' })), 'banned');
    assert.equal(accountState(acc('a', { status: 'disabled' })), 'disabled');
  });
});

describe('classifyTransition', () => {
  it('no event when unchanged', () => {
    assert.equal(classifyTransition('active', 'active'), null);
  });
  it('→active is a recovery (success)', () => {
    assert.deepEqual(classifyTransition('rate_limited', 'active'), { kind: 'recovered', severity: 'success' });
  });
  it('→disabled / →quota are errors, others warn', () => {
    assert.equal(classifyTransition('active', 'disabled').severity, 'error');
    assert.equal(classifyTransition('active', 'quota').severity, 'error');
    assert.equal(classifyTransition('active', 'capacity').severity, 'warn');
    assert.equal(classifyTransition('active', 'rate_limited').severity, 'warn');
  });
  it('→reauth is an error (it never self-heals), and →active from it is a recovery', () => {
    assert.deepEqual(classifyTransition('active', 'reauth'), { kind: 'reauth', severity: 'error' });
    assert.deepEqual(classifyTransition('reauth', 'active'), { kind: 'recovered', severity: 'success' });
  });
});

describe('collapse', () => {
  it('collapses >=N same-kind into a summary, keeps small groups', () => {
    const ev = [
      { type: 'account', kind: 'rate_limited', severity: 'warn', id: 1 },
      { type: 'account', kind: 'rate_limited', severity: 'warn', id: 2 },
      { type: 'account', kind: 'rate_limited', severity: 'warn', id: 3 },
      { type: 'account', kind: 'capacity', severity: 'warn', id: 4 },
    ];
    const out = collapse(ev, 3);
    const summary = out.find(e => e.type === 'summary');
    assert.equal(summary.kind, 'rate_limited');
    assert.equal(summary.count, 3);
    // capacity (only 1) stays an individual event
    assert.ok(out.some(e => e.type === 'account' && e.kind === 'capacity'));
  });
  it('NEVER drops events — a big storm becomes a summary, not silence', () => {
    const ev = Array.from({ length: 20 }, (_, i) => ({ type: 'account', kind: 'disabled', severity: 'error', id: i }));
    const out = collapse(ev, 3);
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 20, 'all 20 accounted for in the summary');
  });
});

describe('createPoolEventDetector', () => {
  it('first snapshot primes silently (no storm on panel open)', () => {
    const d = createPoolEventDetector();
    const events = d.push([acc('a', { rateLimited: true }), acc('b', { status: 'disabled' })]);
    assert.deepEqual(events, []);
    assert.equal(d.primed, true);
  });

  it('emits only on transitions', () => {
    const d = createPoolEventDetector();
    d.push([acc('a')]);                                  // prime: a=active
    let ev = d.push([acc('a')]);                          // no change
    assert.deepEqual(ev, []);
    ev = d.push([acc('a', { rateLimited: true })], 1000); // active → rate_limited
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'rate_limited');
    assert.equal(ev[0].from, 'active');
    assert.equal(ev[0].to, 'rate_limited');
  });

  it('reports recovery when an account returns to active', () => {
    const d = createPoolEventDetector();
    d.push([acc('a')]);
    d.push([acc('a', { rateLimited: true })], 1000);
    const ev = d.push([acc('a')], 100000);   // past backoff window
    assert.equal(ev[0].kind, 'recovered');
    assert.equal(ev[0].severity, 'success');
  });

  it('per-fingerprint backoff suppresses re-report within the window', () => {
    const d = createPoolEventDetector({ backoffMs: 60000 });
    d.push([acc('a')]);                                       // prime
    let ev = d.push([acc('a', { rateLimited: true })], 1000); // emits
    assert.equal(ev.length, 1);
    // flaps back and forth quickly — within 60s window → suppressed
    ev = d.push([acc('a')], 2000);
    assert.deepEqual(ev, []);
    ev = d.push([acc('a', { rateLimited: true })], 3000);
    assert.deepEqual(ev, []);
    // after the window, a transition reports again
    ev = d.push([acc('a')], 70000);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'recovered');
  });

  it('collapses a multi-account storm in one tick', () => {
    const d = createPoolEventDetector();
    d.push([acc('a'), acc('b'), acc('c'), acc('d')]);   // prime all active
    const ev = d.push([
      acc('a', { rateLimited: true }),
      acc('b', { rateLimited: true }),
      acc('c', { rateLimited: true }),
      acc('d', { status: 'disabled' }),
    ], 1000);
    const summary = ev.find(e => e.type === 'summary');
    assert.equal(summary.kind, 'rate_limited');
    assert.equal(summary.count, 3);
    assert.ok(ev.some(e => e.kind === 'disabled'));
  });

  it('forgets accounts removed from the snapshot (re-add re-baselines)', () => {
    const d = createPoolEventDetector();
    d.push([acc('a', { rateLimited: true })]);   // prime a=rate_limited
    // 'a' disappears (removed), then comes back active — must NOT fire a bogus
    // "recovered" from stale state; it re-baselines instead.
    d.push([], 1000);
    const ev = d.push([acc('a')], 2000);
    assert.deepEqual(ev, [], 're-added account re-baselines silently');
  });
});

describe('cooldownState', () => {
  const now = 1_000_000;

  it('uses a strict deadline boundary: now-1 and now are not cooling, now+1 is', () => {
    const before = cooldownState({ rateLimitedUntil: now - 1, now });
    assert.equal(before.rateLimited, false);
    assert.equal(before.cooldownUntil, null);
    assert.equal(before.cooldownRemainingMs, 0);

    const at = cooldownState({ rateLimitedUntil: now, now });
    assert.equal(at.rateLimited, false);
    assert.equal(at.cooldownUntil, null);

    const after = cooldownState({ rateLimitedUntil: now + 1, now });
    assert.equal(after.rateLimited, true);
    assert.equal(after.cooldownUntil, now + 1);
    assert.equal(after.cooldownRemainingMs, 1);
  });

  it('quota outranks rate_limit and the deadline is the later one', () => {
    const out = cooldownState({
      rateLimitedUntil: now + 60_000,
      quotaResetAt: now + 120_000,
      capacityThrottled: true,
      now,
    });
    assert.equal(out.cooldownReason, 'quota');
    assert.equal(out.cooldownUntil, now + 120_000);
    assert.equal(out.cooldownRemainingMs, 120_000);
    assert.equal(out.quotaCooled, true);
    assert.equal(out.rateLimited, true);
  });

  it('rate_limit outranks capacity', () => {
    const out = cooldownState({
      rateLimitedUntil: now + 90_000,
      quotaResetAt: 0,
      capacityThrottled: true,
      now,
    });
    assert.equal(out.cooldownReason, 'rate_limit');
    assert.equal(out.cooldownUntil, now + 90_000);
  });

  it('capacity alone has no account-wide deadline', () => {
    const out = cooldownState({ capacityThrottled: true, now });
    assert.equal(out.cooldownReason, 'capacity');
    assert.equal(out.cooldownUntil, null);
    assert.equal(out.cooldownRemainingMs, 0);
  });

  it('an expired deadline reports null, not a stale timestamp', () => {
    const out = cooldownState({ rateLimitedUntil: now - 5_000, quotaResetAt: now - 1, now });
    assert.equal(out.cooldownUntil, null);
    assert.equal(out.cooldownReason, null);
    assert.equal(out.cooldownRemainingMs, 0);
  });

  it('feeds accountState with the same strict boundary rule', () => {
    const expired = cooldownState({ rateLimitedUntil: now - 1, now });
    assert.equal(accountState(acc('a', expired)), 'active');
    const active = cooldownState({ rateLimitedUntil: now + 1, now });
    assert.equal(accountState(acc('a', active)), 'rate_limited');
  });
});

// Reviewer #1 — a MODEL-level rejection must not be read as an account auth
// failure.
//
// Measured upstream body: "This model is no longer available for your account",
// carried on gRPC `permission_denied` / HTTP 401. Before this suite existed,
// classifyUpstreamError matched it with the UNAUTHORIZED arm, and the rest of the
// chain inherited the wrong scope:
//
//   classify → UNAUTHORIZED
//     → finalizeConnectAccount → reportError → three requests for ONE retired
//       selector flipped a healthy account to status='error' (persisted), which
//       blacked out every OTHER model that account could still serve;
//     → the UNAUTHORIZED arm also fired a background re-login for a token that
//       was never dead, and the handler's dead-token path ran requestReauthCheck;
//     → isAccountFailoverError('UNAUTHORIZED') is false, and the MODEL_BLOCKED
//       fallback is excluded too, so the request never moved to a peer that COULD
//       serve the selector;
//     → isLastUsableAccount only compared tier buckets, so a same-tier peer that
//       could not serve the selector still counted as a fallback and disqualified
//       the sole account that could.
//
// The fix gives the condition its own scope — the (account, canonical selector)
// PAIR — and this file pins each link of the chain:
//   1. classification (and its near-misses: a real bad token stays UNAUTHORIZED)
//   2. blame (three rejections touch no auth state, no re-login, no reauth)
//   3. routing (the account stays selectable for every other selector)
//   4. failover (the request lands on a peer eligible for that selector)
//   5. the last-account exemption is selector-aware
//   6. a genuine bad token still trips the existing protection

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getApiKey, releaseAccount, getAccountInternal,
  setAccountTier, isSelectorIneligible, isConnectSelectorAllowedForAccount,
  resolveAccountState, reportError, __isLastUsableAccount,
  __setReloginDeps, __resetReloginState, markAccountReauthenticated,
} from '../src/auth.js';
import { classifyUpstreamError, isRetryable } from '../src/devin-connect.js';
import { getConnectMetrics } from '../src/devin-connect-metrics.js';
import {
  handleChatCompletions, finalizeConnectAccount, connectErrorToHttp,
  isAccountFailoverError, __setConnectDeps, __resetConnectDeps,
} from '../src/handlers/chat.js';

// Canonical connect selectors, used as the SELECTOR dimension directly (the
// classifier and finalizeConnectAccount both take the resolved selector).
const X = 'gpt-5-5-low';       // paid selector — needs a paid bucket
const Y = 'swe-1-6-slow';      // free-reachable selector — any bucket
const X_MODEL = 'gpt-5.5';     // client-facing name that resolves to X
const BODY = 'This model is no longer available for your account';

const created = [];
const prevEnv = {};

function seed(label, tier = 'pro') {
  const acct = addAccountByKey(`devin-session-token$sel-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(acct.id);
  if (tier) setAccountTier(acct.id, tier);
  return getAccountInternal(acct.id);
}

function rejectSelector() {
  const c = classifyUpstreamError(BODY, 'permission_denied', 401);
  return Object.assign(new Error(c.message), { code: c.code, status: 401 });
}

function unauthorized() {
  return Object.assign(new Error('invalid token'), { code: 'UNAUTHORIZED' });
}

function failSelector(acct, selector = X, times = 3) {
  for (let i = 0; i < times; i++) {
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: X_MODEL, selector, startTime: Date.now() - 3, err: rejectSelector() },
    );
  }
  return getAccountInternal(acct.id);
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '', writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; for (const cb of listeners.get('close') || []) cb(); },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
  };
}

function parseFrames(raw) {
  return raw.split('\n\n').filter(Boolean).filter(f => !f.startsWith(':')).map(f => {
    const d = f.split('\n').find(l => l.startsWith('data: '))?.slice(6) || '';
    return d === '[DONE]' ? '[DONE]' : JSON.parse(d);
  });
}

beforeEach(() => {
  prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
  process.env.DEVIN_CONNECT = '1';
});

afterEach(() => {
  __resetConnectDeps();
  __resetReloginState();
  __setReloginDeps(null);
  if (prevEnv.DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = prevEnv.DEVIN_CONNECT;
  while (created.length) removeAccount(created.pop());
});

// ─────────────────────────────────────────────────────────────────────────────
describe('1. classification — the model-level rejection has its own scope', () => {
  it('the measured body is SELECTOR_NOT_ELIGIBLE, not UNAUTHORIZED', () => {
    for (const [code, status] of [['permission_denied', 401], ['permission_denied', 403], [null, null]]) {
      const c = classifyUpstreamError(BODY, code, status);
      assert.equal(c.code, 'SELECTOR_NOT_ELIGIBLE',
        `body must not classify as ${c.code} (code=${code} status=${status}) — an auth verdict here is `
        + 'what charged the account error budget and fired a re-login for a live token');
    }
  });

  it('a real auth failure still classifies as UNAUTHORIZED (no over-broad pattern)', () => {
    // The new branch must not swallow the auth vocabulary it sits in front of.
    for (const [text, code, status] of [
      ['invalid token', 'unauthenticated', 401],
      ['Authentication failed', null, 401],
      ['permission_denied', null, 403],
      ['unauthenticated', 'unauthenticated', null],
    ]) {
      assert.equal(classifyUpstreamError(text, code, status).code, 'UNAUTHORIZED', `${text} must stay an auth failure`);
    }
  });

  it('the new code is failover-eligible, non-retryable, and not an auth HTTP surface', () => {
    const c = classifyUpstreamError(BODY, 'permission_denied', 401);
    assert.equal(isAccountFailoverError(c.code), true,
      'a peer entitled to the selector can serve this request, so it must fail over');
    assert.equal(isRetryable({ code: c.code }), false,
      'the same account rejects it identically, so an in-place retry only burns an attempt');
    const http = connectErrorToHttp(c.code);
    assert.equal(http.status, 403, 'not 401 — the account was never unauthenticated');
    assert.notEqual(http.type, 'authentication_error');
  });

  it('MODEL_BLOCKED stays excluded from failover (tier wall vs per-account wall)', () => {
    assert.equal(isAccountFailoverError('MODEL_BLOCKED'), false,
      'a tier wall is shared by every account of that tier — hopping would storm the pool');
  });

  it('an explicit tier wall stays MODEL_BLOCKED (account-only branch does not preempt it)', () => {
    // Reviewer F-classifier: the SELECTOR_NOT_ELIGIBLE arm used to accept
    // plan/tier/subscription/workspace, so this body classified as a per-account
    // selector verdict — which fails over and latches — instead of the tier wall
    // it states. The two codes route differently on purpose.
    const wall = 'This model is no longer available for your plan. Please /upgrade to access it';
    assert.equal(classifyUpstreamError(wall, 'permission_denied', 403).code, 'MODEL_BLOCKED',
      'a plan/tier noun plus /upgrade is a tier wall, not evidence about one account');
    assert.equal(classifyUpstreamError('Please /upgrade to access this model').code, 'MODEL_BLOCKED',
      'the plain /upgrade form keeps its existing verdict');
    for (const text of [
      'This model is no longer available for your plan',
      'This model is no longer available for your workspace',
    ]) {
      assert.notEqual(classifyUpstreamError(text, 'permission_denied', 403).code, 'SELECTOR_NOT_ELIGIBLE',
        `${text} is not the measured account-scoped body — it must not latch/hop`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2. blame — three rejections touch no account auth state', () => {
  it('leaves the account active with no error budget, cooldown, reauth or re-login', () => {
    const a = seed('blame-a');
    seed('blame-peer'); // voids the last-account exemption, so an eviction WOULD show
    let logins = 0;
    __setReloginDeps({ windsurfLogin: async () => { logins++; throw new Error('no credential'); } });

    const after = failSelector(a, X, 3);

    assert.equal(after.status, 'active', 'the account never lost a credential');
    assert.equal(after.errorCount || 0, 0, 'a selector-scoped rejection must not charge the eviction counter');
    assert.equal(after.reauth, undefined, 'a selector-scoped rejection is not a reauth verdict');
    assert.equal(after.rateLimitedUntil || 0, 0, 'not an account-wide cooldown');
    assert.equal(after.quotaResetAt || 0, 0, 'not a quota dry-well');
    assert.deepEqual(Object.keys(after._modelRateLimits || {}), [],
      'not a capacity throttle either — the dashboard would label the account "capacity"');
    assert.equal(resolveAccountState(after), 'active', 'the account still reads healthy to the operator');
    assert.equal(logins, 0, 'no re-login for a token that was never dead');
  });

  it('latches the SELECTOR for that account only, and the latch self-heals', () => {
    const a = seed('latch-a');
    seed('latch-peer');

    const after = failSelector(a, X, 3);
    assert.equal(isSelectorIneligible(after, X), true, 'the rejected selector is recorded');
    assert.equal(isSelectorIneligible(after, Y), false, 'every other selector is untouched');
    // Bounded + self-healing: the entry expires on its own (30-minute window).
    assert.equal(isSelectorIneligible(after, X, Date.now() + 31 * 60 * 1000), false,
      'the latch must expire — a re-enabled model has to come back without a restart');
    assert.equal(after._selectorIneligible[X], undefined, 'expiry also drops the entry (bounded map)');
  });

  it('does not latch when no peer could serve the selector', () => {
    // A pro account, and a same-tier peer whose operator blocklist excludes X:
    // the pool cannot serve X at all. Latching A would turn the upstream's honest
    // 403 into "pool exhausted" for every later request.
    const a = seed('nopeer-a');
    const b = seed('nopeer-b');
    b.blockedModels = [X];
    assert.equal(isConnectSelectorAllowedForAccount(b, X), false, 'precondition: peer cannot serve X');

    const after = failSelector(a, X, 3);
    assert.equal(after.status, 'active');
    assert.equal(isSelectorIneligible(after, X), false,
      'no peer can take over, so the account must stay selectable and surface the real error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reviewer F1/F2 — the latch is availability state, so it must belong to the
// credential that produced the verdict AND agree with the scheduler about
// whether a peer can actually take over.
describe('2b. latch safety — credential epoch (F1) and scheduler admission (F2)', () => {
  it('late_old_selector_denial_must_not_override_new_credential_success', () => {
    const a = seed('epoch-a');
    const b = seed('epoch-b'); // admitted peer: pre-fix this made the latch writable
    const oldSnapshot = { id: a.id, apiKey: a.apiKey };

    // A fresh login installs a new credential on the SAME account (same id).
    const newKey = `${oldSnapshot.apiKey}-fresh`;
    markAccountReauthenticated(a.id, { apiKey: newKey, via: 'manual' });
    assert.equal(getAccountInternal(a.id).apiKey, newKey, 'precondition: the pool moved to a new epoch');

    // The new credential serves the selector.
    finalizeConnectAccount(
      { id: a.id, apiKey: newKey },
      { model: X_MODEL, selector: X, startTime: Date.now() - 2, err: null },
    );

    // The OLD attempt's denial then lands (it was in flight across the rotation).
    const m0 = getConnectMetrics();
    finalizeConnectAccount(
      oldSnapshot,
      { model: X_MODEL, selector: X, startTime: Date.now() - 2, err: rejectSelector() },
    );
    const m1 = getConnectMetrics();

    const after = getAccountInternal(a.id);
    assert.equal(after.status, 'active', 'a selector-scoped denial never benches the account');
    assert.equal(isSelectorIneligible(after, X), false,
      "the old epoch's denial must not latch the NEW credential — it may still serve this selector");
    assert.equal(m1.selector_ineligible - m0.selector_ineligible, 1,
      'the observation is still counted; only the availability write is skipped');

    // "selectableWithoutB": with the only peer gone, the account must still be
    // handed out for X. Pre-fix the latch made the pool empty (getApiKey → null).
    removeAccount(b.id);
    const picked = getApiKey([], null, '', X);
    assert.equal(picked?.id, a.id, 'the fresh credential remains selectable for X without the peer');
    releaseAccount(picked.apiKey);
  });

  it('selector_latch_requires_a_peer_admitted_by_scheduler_maintenance_filter', () => {
    const a = seed('maint-a');
    const b = seed('maint-b');
    b._maintenance = 1; // a background / language-server maintenance slot is held
    const pre = getApiKey([], null, '', X);
    assert.equal(pre?.id, a.id, 'precondition: the scheduler already skips the busy peer');
    releaseAccount(pre.apiKey);

    const after = failSelector(a, X, 1);
    assert.equal(isSelectorIneligible(after, X), false,
      'the only peer is in maintenance — latching A would empty the pool');
    const picked = getApiKey([], null, '', X);
    assert.equal(picked?.id, a.id, 'A stays selectable for X (no empty-pool 504)');
    releaseAccount(picked.apiKey);
  });

  it('selector_latch_requires_a_peer_admitted_by_scheduler_inflight_filter', () => {
    const ENV = 'DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT';
    const prev = process.env[ENV];
    process.env[ENV] = '1';
    try {
      const a = seed('cap-a');
      const b = seed('cap-b');
      b._inflight = 1; // the peer is at the per-account hard cap
      b._inflightAt = Date.now();
      const pre = getApiKey([], null, '', X);
      assert.equal(pre?.id, a.id, 'precondition: the scheduler already skips the capped peer');
      releaseAccount(pre.apiKey);

      const after = failSelector(a, X, 1);
      assert.equal(isSelectorIneligible(after, X), false,
        'the capped peer cannot take over, so latching A would leave no candidate');
      const picked = getApiKey([], null, '', X);
      assert.equal(picked?.id, a.id, 'A stays selectable for X; the in-flight cap is not bypassed');
      releaseAccount(picked.apiKey);
    } finally {
      if (prev === undefined) delete process.env[ENV];
      else process.env[ENV] = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3. routing — the account stays usable for every other selector', () => {
  it('skips the latched account for the rejected selector, keeps it for the others', () => {
    const a = seed('route-a');
    const b = seed('route-b');
    failSelector(a, X, 3);

    const picks = [];
    for (let i = 0; i < 3; i++) {
      const p = getApiKey([], null, '', X);
      assert.ok(p, 'a peer eligible for X must still be selectable');
      picks.push(p.id);
      releaseAccount(p.apiKey);
    }
    assert.deepEqual(picks, [b.id, b.id, b.id], 'X never lands on the latched account');

    // Y is a different dimension: the SAME account must remain selectable for it.
    const yPicks = new Set();
    for (let i = 0; i < 4; i++) {
      const p = getApiKey([], null, '', Y);
      assert.ok(p, 'Y must stay serviceable');
      yPicks.add(p.id);
      releaseAccount(p.apiKey);
    }
    assert.ok(yPicks.has(a.id),
      'the account rejected for X must still serve Y — the whole point of the selector scope');
  });

  it('the pinned re-acquire path honors the latch too', async () => {
    const { acquireAccountByKey } = await import('../src/auth.js');
    const a = seed('pin-a');
    seed('pin-peer');
    failSelector(a, X, 1);
    assert.equal(acquireAccountByKey(a.apiKey, null, X), null,
      'a pinned re-acquire must not hand back an account the upstream just refused this selector');
    const ok = acquireAccountByKey(a.apiKey, null, Y);
    assert.ok(ok, 'the same account is still acquirable for Y');
    releaseAccount(ok.apiKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4. failover — the request moves to a peer eligible for the selector', () => {
  it('non-stream: serves from the eligible peer and never penalizes the rejecting account', async () => {
    const a = seed('fo-a');
    const b = seed('fo-b');
    let logins = 0;
    __setReloginDeps({ windsurfLogin: async () => { logins++; throw new Error('no credential'); } });

    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        const who = params.token === a.apiKey ? 'A' : (params.token === b.apiKey ? 'B' : '?');
        seen.push(`${who}:${params.model}`);
        if (who === 'A' && params.model === X) throw rejectSelector();
        return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'FAILOVER_OK' } }] } };
      },
    });

    const m0 = getConnectMetrics();
    const result = await handleChatCompletions(
      { model: X_MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const m1 = getConnectMetrics();
    // The new scope must be observable, and it must NOT be filed under the
    // quota/rate dry-well counter — that counter's contract is "out of credit".
    assert.equal(m1.selector_ineligible - m0.selector_ineligible, 1, 'the refusal has its own counter');
    assert.equal(m1.selector_failover_hops - m0.selector_failover_hops, 1, 'the hop is a SELECTOR hop');
    assert.equal(m1.quota_failover_hops - m0.quota_failover_hops, 0, 'not mislabeled as a quota dry-well');
    assert.equal(result.status, 200, `expected the eligible peer to serve it, got ${result.status}`);
    assert.equal(result.body.choices[0].message.content, 'FAILOVER_OK');
    assert.deepEqual(seen, [`A:${X}`, `B:${X}`], 'one hop, onto the peer that is eligible for X');

    const after = getAccountInternal(a.id);
    assert.equal(after.status, 'active');
    assert.equal(after.errorCount || 0, 0);
    assert.equal(after.reauth, undefined, 'the rejecting account was never sent to reauth');
    assert.equal(logins, 0, 'and never re-logged in');

    // Second request: the latch means A is skipped BEFORE the upstream call.
    seen.length = 0;
    const second = await handleChatCompletions(
      { model: X_MODEL, stream: false, messages: [{ role: 'user', content: 'again' }] },
      { callerKey: '' },
    );
    assert.equal(second.status, 200);
    assert.deepEqual(seen, [`B:${X}`], 'the latched account is not re-probed for the same selector');

    // And the account is still healthy for the other selector.
    seen.length = 0;
    const other = await handleChatCompletions(
      { model: Y, stream: false, messages: [{ role: 'user', content: 'y' }] },
      { callerKey: '' },
    );
    assert.equal(other.status, 200, 'Y is unaffected by the X latch');
    assert.ok(seen.length >= 1);
  });

  it('stream: fails over before any byte is emitted', async () => {
    const a = seed('fo-s-a');
    const b = seed('fo-s-b');
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no credential'); } });

    const seen = [];
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        const who = params.token === a.apiKey ? 'A' : (params.token === b.apiKey ? 'B' : '?');
        seen.push(`${who}:${params.model}`);
        if (who === 'A' && params.model === X) throw rejectSelector();
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      },
    });

    const result = await handleChatCompletions(
      { model: X_MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    const res = fakeRes();
    await result.handler(res);
    const frames = parseFrames(res.body);
    assert.ok(frames.some(f => f !== '[DONE]' && f.choices?.[0]?.delta?.content === 'OK'),
      'the eligible peer streamed the answer');
    assert.deepEqual(seen, [`A:${X}`, `B:${X}`], 'one pre-emit hop');
    assert.equal(getAccountInternal(a.id).status, 'active');
  });

  // The reviewer's exact client-visible symptom. A is the ONLY account that can
  // serve a paid selector Y; B is free-tier, so it cannot serve Y either. Three
  // requests for a selector X that upstream retired for A must leave A active, or
  // the pool loses Y entirely.
  it('a paid Y keeps working after X rejections when only A can serve Y', async () => {
    const Y_PAID = 'claude-opus-4-8-medium';
    const Y_MODEL = 'claude-opus-4.8';
    const a = seed('paidY-a', 'pro');
    const b = seed('paidY-b', 'free');
    assert.equal(isConnectSelectorAllowedForAccount(b, Y_PAID), false, 'precondition: B cannot serve Y');

    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        const who = params.token === a.apiKey ? 'A' : 'B';
        seen.push(`${who}:${params.model}`);
        if (params.model === X) throw rejectSelector();
        return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'Y_OK' } }] } };
      },
    });

    for (let i = 0; i < 3; i++) {
      const r = await handleChatCompletions(
        { model: X_MODEL, stream: false, messages: [{ role: 'user', content: 'x' }] },
        { callerKey: '' },
      );
      // 403 is the selector verdict. The pre-fix chain answered 401 here ("all
      // accounts exhausted (dead session tokens)") because the body was read as
      // an auth failure and the dead-token path owned the request.
      assert.equal(r.status, 403, `X rejection ${i + 1} must surface the selector verdict, not auth`);
    }
    assert.equal(getAccountInternal(a.id).status, 'active', 'A still owns Y');

    seen.length = 0;
    const y = await handleChatCompletions(
      { model: Y_MODEL, stream: false, messages: [{ role: 'user', content: 'y' }] },
      { callerKey: '' },
    );
    assert.equal(y.status, 200, 'the paid selector must still be servable by the pool');
    assert.equal(y.body.choices[0].message.content, 'Y_OK');
    assert.deepEqual(seen, [`A:${Y_PAID}`], 'served by A, the only account entitled to Y');
  });

  it('surfaces the honest 403 when no peer is eligible (no pool blackout)', async () => {
    const a = seed('fo-none-a');
    const b = seed('fo-none-b');
    b.blockedModels = [X];

    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen.push(params.token === a.apiKey ? 'A' : 'B');
        throw rejectSelector();
      },
    });

    const m0 = getConnectMetrics();
    const result = await handleChatCompletions(
      { model: X_MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 403, 'the upstream verdict, not 401 and not 429');
    assert.equal(result.body.error.code, 'SELECTOR_NOT_ELIGIBLE');
    assert.equal(getConnectMetrics().selector_ineligible - m0.selector_ineligible, 1,
      'the refusal is counted even though no latch was written (no eligible peer to take over)');
    assert.deepEqual(seen, ['A'], 'the ineligible peer is never sent the request');
    const after = getAccountInternal(a.id);
    assert.equal(after.status, 'active');
    assert.equal(isSelectorIneligible(after, X), false,
      'nothing latched — the account stays selectable so the next request can still surface the truth');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5. last-account exemption is selector-aware', () => {
  it('a same-tier peer that cannot serve the selector does not disqualify the account', () => {
    const a = seed('exempt-a');
    const b = seed('exempt-b');
    b.blockedModels = [X];

    assert.equal(__isLastUsableAccount(getAccountInternal(a.id), Date.now(), X), true,
      'the peer cannot serve X, so disabling A would black out X for the whole pool');
    assert.equal(__isLastUsableAccount(getAccountInternal(a.id), Date.now(), Y), false,
      'for Y the peer IS a real fallback');
    assert.equal(__isLastUsableAccount(getAccountInternal(a.id), Date.now()), false,
      'no selector keeps the account-wide meaning unchanged');
  });

  it('three auth errors for a selector the peer cannot serve keep the account in rotation', () => {
    const a = seed('exempt-c');
    const b = seed('exempt-d');
    b.blockedModels = [X];

    for (let i = 0; i < 3; i++) reportError(a.apiKey, { selector: X });
    const after = getAccountInternal(a.id);
    assert.equal(after.status, 'active',
      'the account is the only one that can serve X — the exemption must keep it selectable');
    assert.ok(after.errorCount >= 3, 'the streak is still recorded (it resumes the moment a peer appears)');

    // A selector the peer CAN serve is a different story: the breaker trips.
    reportError(a.apiKey, { selector: Y });
    assert.equal(getAccountInternal(a.id).status, 'error',
      'with a real fallback for Y the normal breaker applies');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6. a genuine bad token still trips the existing protection', () => {
  it('three UNAUTHORIZED with an eligible peer disables the account', () => {
    const a = seed('auth-a');
    seed('auth-b'); // same tier, eligible for X → a real fallback
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no credential'); } });

    for (let i = 0; i < 3; i++) {
      finalizeConnectAccount(
        { id: a.id, apiKey: a.apiKey },
        { model: X_MODEL, selector: X, startTime: Date.now() - 3, err: unauthorized() },
      );
    }
    const after = getAccountInternal(a.id);
    assert.equal(after.status, 'error', 'the fix must not weaken real account-fault handling');
    assert.ok(after.errorCount >= 3);
    assert.equal(isSelectorIneligible(after, X), false,
      'a dead token is NOT a selector-scoped rejection — it must not be recorded as one');
  });

  it('a dead token on one account still fails the request over to the healthy peer', async () => {
    const a = seed('auth-c');
    const b = seed('auth-d');
    __setReloginDeps({ windsurfLogin: async () => { throw new Error('no credential'); } });
    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen.push(params.token === a.apiKey ? 'A' : 'B');
        if (params.token === a.apiKey) throw unauthorized();
        return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'OK' } }] } };
      },
    });

    const result = await handleChatCompletions(
      { model: X_MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(seen, ['A', 'B'], 'dead-token failover path is intact');
    assert.notEqual(getAccountInternal(b.id).status, 'error');
  });
});

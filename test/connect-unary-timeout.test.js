// GAP-1 (RATE-RETRY audit, 2026-10-15): the GetUserJwt unary mint had NO timeout.
//
// The mint runs BEFORE the chat request is built (streamChat awaits it), and
// mintUserJwt coalesces concurrent mints per (token, host). So one upstream that
// accepts the TCP connection and then never answers hung the chat request forever
// AND amplified that hang to every other request sharing the token — with no timer
// running anywhere: the stream's own absolute deadline starts after the mint, and
// a cold cache entry has nothing to serve.
//
// These tests pin the bound and the three properties it must have:
//   1. the mint resolves null at the deadline — the same resolve-null contract as
//      every other failure in postConnectUnary — instead of hanging;
//   2. it does not fire early: a mint that degrades to null immediately is a mint
//      that silently disables the opt-in feature;
//   3. the deadline destroys the socket and releases the in-flight slot, so the
//      next request mints again instead of joining a promise that already gave up.
//
// The hanging transport is injected through the same __setRequestImpl seam the
// body-bound tests use, so no socket is opened (test/setup-env.mjs also installs a
// fail-closed network guard). The module is imported as a namespace on purpose:
// pre-fix there is no USER_JWT_MINT_TIMEOUT_MS export, and a named import would
// fail at load time — turning the behavioural red (the mint hangs) into an import
// error that says nothing about the bug.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const connect = await import('../src/devin-connect.js');
const { mintUserJwt, invalidateUserJwtCache, __setRequestImpl } = connect;
const { writeStringField } = await import('../src/proto.js');
const { wrapEnvelope } = await import('../src/connect.js');

const TOKEN = 'devin-session-token$gap1';
const JWT = 'header.payload.signature';
// Generous next to the deadlines under test (150-250ms) so a loaded machine
// cannot turn "the bound works" into a flaky watchdog hit; still far below the
// 15s default, so a missing deadline cannot pass by luck.
const WATCHDOG_MS = 3000;
const WATCHDOG = Symbol('watchdog: the mint never settled');

/** Await `p` with a watchdog that is cleared as soon as either side settles. */
async function withWatchdog(p, ms = WATCHDOG_MS) {
  let timer;
  const watchdog = new Promise((resolve) => { timer = setTimeout(() => resolve(WATCHDOG), ms); });
  try {
    return await Promise.race([p, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A transport that accepts the request and then never answers: no response
 * callback, no error, no close. `destroy()` is recorded because the bound is only
 * a bound if it also stops the connection from sitting there — resolving null
 * while leaving the request open leaks one connection per mint.
 */
function hangingTransport() {
  const state = { calls: 0, destroyed: 0 };
  state.impl = () => {
    state.calls += 1;
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {};
    req.destroy = () => { state.destroyed += 1; };
    return req;
  };
  return state;
}

/**
 * A transport that answers with a valid credential after `delayMs`. The delay is
 * what makes the "0 must not mean instant" case deterministic: an instant timer
 * fires first and the mint returns null, while the documented fallback (15s)
 * leaves the response time to arrive.
 */
function answeringTransport(delayMs = 5) {
  return (_opts, cb) => {
    const listeners = {};
    const res = {
      statusCode: 200,
      on(ev, fn) { listeners[ev] = fn; return res; },
    };
    setTimeout(() => {
      cb(res);
      listeners.data?.(wrapEnvelope(writeStringField(1, JWT), { compress: false }));
      listeners.end?.();
    }, delayMs);
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {};
    req.destroy = () => {};
    return req;
  };
}

beforeEach(() => { invalidateUserJwtCache(); });
afterEach(() => { __setRequestImpl(null); invalidateUserJwtCache(); });

describe('the GetUserJwt mint is bounded (GAP-1)', () => {
  it('resolves null at the deadline instead of hanging, and destroys the request', async () => {
    const transport = hangingTransport();
    __setRequestImpl(transport.impl);
    const timeoutMs = 250;
    const started = Date.now();
    const result = await withWatchdog(mintUserJwt(TOKEN, { timeoutMs }));
    const elapsed = Date.now() - started;

    assert.notEqual(result, WATCHDOG, `the mint must settle within ${timeoutMs}ms, not hang`);
    assert.equal(result, null, 'a timed-out mint degrades to null, exactly like a non-200');
    assert.ok(
      elapsed >= timeoutMs / 2,
      `settled after ${elapsed}ms — the deadline must be a deadline, not an early bail`,
    );
    assert.equal(transport.calls, 1);
    assert.equal(transport.destroyed, 1, 'the deadline must destroy the request it gave up on');
  });

  it('releases the in-flight slot, so the next mint opens a NEW request', async () => {
    const transport = hangingTransport();
    __setRequestImpl(transport.impl);

    const first = await withWatchdog(mintUserJwt(TOKEN, { timeoutMs: 150 }));
    assert.equal(first, null, 'the first mint must degrade to null, not hang');
    const second = await withWatchdog(mintUserJwt(TOKEN, { timeoutMs: 150 }));
    assert.equal(second, null, 'the second mint must settle too, not join a promise that gave up');
    assert.equal(
      transport.calls, 2,
      'a timed-out mint must leave _userJwtInflight, or every later request re-awaits the hang',
    );
    assert.equal(transport.destroyed, 2);
  });

  it('bounds every waiter of a coalesced burst at the ONE shared deadline', async () => {
    const transport = hangingTransport();
    __setRequestImpl(transport.impl);
    const results = await withWatchdog(Promise.all([
      mintUserJwt(TOKEN, { timeoutMs: 250 }),
      mintUserJwt(TOKEN, { timeoutMs: 250 }),
      mintUserJwt(TOKEN, { timeoutMs: 250 }),
    ]));

    assert.notEqual(results, WATCHDOG, 'every waiter of the coalesced mint must settle');
    assert.deepEqual(results, [null, null, null]);
    assert.equal(transport.calls, 1, 'the burst still mints exactly once');
    assert.equal(transport.destroyed, 1, 'one request, one deadline — not one timer per waiter');
  });

  it('defaults to 15s, and a 0 override falls back to it instead of arming an instant timer', async () => {
    assert.equal(
      connect.USER_JWT_MINT_TIMEOUT_MS, 15_000,
      'the documented default: 15s, the ceiling for an RPC that gates a user request',
    );

    __setRequestImpl(answeringTransport(5));
    assert.equal(
      await withWatchdog(mintUserJwt(TOKEN, { timeoutMs: 0 })),
      JWT,
      'a 0 override must not fire on the next turn of the loop and kill a healthy mint',
    );
  });
});

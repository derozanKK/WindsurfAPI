// ReviewChatCore P2-1/P2-2 — identity writes must follow the account id, never
// the acquire-time apiKey snapshot.
//
// Every mark*/report*/updateCapability helper in auth.js resolves its account
// with `accounts.find(a => a.apiKey === apiKey)`. The Cascade arms passed the
// snapshot captured when the turn started, so a credential rotation that lands
// mid-flight (dashboard token paste-over, or a connect re-login on the same
// shared account) made each write a silent no-op:
//   - a 429's cooldown was lost → the pool immediately re-picked the throttled
//     account (the #224 shape the connect lane fixed at finalizeConnectAccount);
//   - capability updates vanished;
//   - the connect dead-token arm's 'd' health event was dropped, so the
//     dashboard's dead-token count under-reported exactly the rotation-prone
//     accounts.
//
// These are BEHAVIOUR tests, not source greps: the upstream is faked at the
// handler seams (WindsurfClient for Cascade, __setConnectDeps for connect), the
// rotation uses the real setAccountTokens, and every assertion reads the real
// account state. Two accounts are seeded in every case so "landed on the right
// account" and "left the peer alone" are both observable.
//
// The credential-epoch discipline is pinned too: an old-key success must not
// clear the NEW credential's error budget, and an old-key 401 must not charge
// it — the same split finalizeConnectAccount already enforces (2803/2802).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireAccountByKey,
  addAccountByKey,
  getAccountInternal,
  removeAccount,
  setAccountTokens,
  __resetReloginState,
  __setReloginDeps,
} from '../src/auth.js';
import {
  handleChatCompletions,
  __resetConnectDeps,
  __setConnectDeps,
} from '../src/handlers/chat.js';
import { cacheClear } from '../src/cache.js';
import { poolClear } from '../src/conversation-pool.js';

const createdIds = [];
const prevEnv = {};
const MODEL = 'gemini-2.5-flash';
const CONNECT_MODEL = 'swe-1-6-slow';

function seed(label) {
  const key = `devin-session-token$p2id-${label}-${Math.random().toString(36).slice(2)}`;
  const a = addAccountByKey(key, label);
  createdIds.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

/** What a dashboard paste-over / background re-login does to a live account. */
function rotate(acct) {
  const next = `${acct.apiKey}$ROTATED-${Math.random().toString(36).slice(2, 8)}`;
  assert.equal(setAccountTokens(acct.id, { apiKey: next }), true,
    'precondition: the rotation landed in the pool');
  return next;
}

const live = (acct) => getAccountInternal(acct.id);

function modelCooldowns(acct) {
  return Object.keys(live(acct)._modelRateLimits || {});
}

function healthCounts(acct) {
  const win = live(acct)._health || [];
  return {
    dead: win.filter((e) => e.k === 'd').length,
    throttle: win.filter((e) => e.k === 't' || e.k === 'c').length,
  };
}

function successCapabilities(acct) {
  return Object.values(live(acct).capabilities || {})
    .filter((c) => c && c.ok === true && c.reason === 'success');
}

function streamSuccess(opts) {
  opts.onChunk({ text: 'OK' });
  return { text: '', toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } };
}

function nonStreamSuccess() {
  // The non-stream path consumes an ARRAY of chunks with toolCalls attached;
  // a plain object yields a 502.
  return Object.assign([{ text: 'OK' }], { toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } });
}

/**
 * Cascade handler context. `served` is the ordered pool handout (attempt 1, 2,
 * …), so the test — not auth.js sort order — decides who serves.
 */
function cascadeCtx({ served, onAttempt, callerKey }) {
  let handouts = 0;
  class FakeClient {
    constructor(apiKey) { this.apiKey = apiKey; }
    async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
      return onAttempt(this.apiKey, opts);
    }
  }
  return {
    callerKey,
    waitForAccount() {
      const acct = served[Math.min(handouts, served.length - 1)];
      handouts++;
      return acquireAccountByKey(acct.apiKey);
    },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17771, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
  };
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

const unique = (label) => `p2-identity ${label} ${Math.random().toString(36).slice(2)}`;

beforeEach(() => {
  prevEnv.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
  prevEnv.DEVIN_ONLY = process.env.DEVIN_ONLY;
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_ONLY;
  cacheClear();
  poolClear();
});

afterEach(() => {
  __resetConnectDeps();
  __resetReloginState();
  __setReloginDeps(null);
  while (createdIds.length) {
    try { removeAccount(createdIds.pop()); } catch { /* already gone */ }
  }
  cacheClear();
  poolClear();
  if (prevEnv.DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = prevEnv.DEVIN_CONNECT;
  if (prevEnv.DEVIN_ONLY === undefined) delete process.env.DEVIN_ONLY;
  else process.env.DEVIN_ONLY = prevEnv.DEVIN_ONLY;
});

describe('P2-1 — Cascade cooldowns follow the account id across a rotation', () => {
  it('non-stream: a 429 that races the rotation still cools the account that failed', async () => {
    const a = seed('ns-rl-a');
    const b = seed('ns-rl-b');
    const acquireKey = a.apiKey;
    let rotatedKey = '';
    let peerServed = false;

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-ns-rl',
      served: [a, b],
      onAttempt(apiKey) {
        if (apiKey === acquireKey) {
          rotatedKey = rotate(a);
          throw Object.assign(new Error('429 rate limit exceeded for this model'), { code: 'RATE_LIMITED' });
        }
        assert.equal(apiKey, b.apiKey, 'the retry presents the peer, not the retired credential');
        peerServed = true;
        return nonStreamSuccess();
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: unique('ns-rl') }] },
      ctx,
    );

    assert.equal(result.status, 200, 'the peer completed the turn');
    assert.ok(rotatedKey && peerServed, 'precondition: rotation and failover both happened');
    assert.equal(live(a).apiKey, rotatedKey, 'precondition: A now carries the new key');
    assert.ok(modelCooldowns(a).length > 0,
      'the 429 cooldown must land on A through its immutable id — keyed on the snapshot it is dropped and the pool re-picks the throttled account');
    assert.ok(healthCounts(a).throttle > 0, 'the throttle health event is recorded on A');
    assert.deepEqual(modelCooldowns(b), [], 'the peer was never rate-limited');
  });

  it('non-stream: a success that races the rotation records the capability on the account', async () => {
    const a = seed('ns-ok-a');
    const b = seed('ns-ok-b');
    const acquireKey = a.apiKey;
    let rotatedKey = '';

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-ns-ok',
      served: [a, b],
      onAttempt(apiKey) {
        assert.equal(apiKey, acquireKey, 'the attempt presents the acquire-time credential');
        rotatedKey = rotate(a);
        return nonStreamSuccess();
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: unique('ns-ok') }] },
      ctx,
    );

    assert.equal(result.status, 200);
    assert.equal(live(a).apiKey, rotatedKey, 'precondition: the rotation landed');
    assert.equal(successCapabilities(a).length, 1,
      'updateCapability must resolve A by id; the stale snapshot misses and the capability write is lost');
    assert.deepEqual(Object.keys(live(b).capabilities || {}), [], 'the peer gained no capability from A\'s turn');
  });

  it('stream: a 429 that races the rotation still cools the account that failed', async () => {
    const a = seed('st-rl-a');
    const b = seed('st-rl-b');
    const acquireKey = a.apiKey;
    let rotatedKey = '';
    let peerServed = false;

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-st-rl',
      served: [a, b],
      onAttempt(apiKey, opts) {
        if (apiKey === acquireKey) {
          rotatedKey = rotate(a);
          throw Object.assign(new Error('429 rate limit exceeded for this model'), { code: 'RATE_LIMITED' });
        }
        assert.equal(apiKey, b.apiKey, 'the retry presents the peer, not the retired credential');
        peerServed = true;
        return streamSuccess(opts);
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, stream: true, messages: [{ role: 'user', content: unique('st-rl') }] },
      ctx,
    );
    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);

    assert.ok(rotatedKey && peerServed, 'precondition: rotation and failover both happened');
    assert.equal(live(a).apiKey, rotatedKey, 'precondition: A now carries the new key');
    assert.ok(modelCooldowns(a).length > 0,
      'the stream 429 cooldown must land on A through its immutable id');
    assert.deepEqual(modelCooldowns(b), [], 'the peer was never rate-limited');
    assert.ok(res.body.includes('[DONE]'), 'the peer completed the stream');
  });

  it('stream: a success that races the rotation records the capability on the account', async () => {
    const a = seed('st-ok-a');
    const b = seed('st-ok-b');
    const acquireKey = a.apiKey;
    let rotatedKey = '';

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-st-ok',
      served: [a, b],
      onAttempt(apiKey, opts) {
        assert.equal(apiKey, acquireKey);
        rotatedKey = rotate(a);
        return streamSuccess(opts);
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, stream: true, messages: [{ role: 'user', content: unique('st-ok') }] },
      ctx,
    );
    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);

    assert.equal(live(a).apiKey, rotatedKey, 'precondition: the rotation landed');
    assert.equal(successCapabilities(a).length, 1,
      'updateCapability must resolve A by id; the stale snapshot misses and the capability write is lost');
    assert.deepEqual(Object.keys(live(b).capabilities || {}), [], 'the peer gained no capability from A\'s turn');
    assert.ok(res.body.includes('[DONE]'));
  });
});

describe('P2-1 — credential-epoch split is preserved on the Cascade arms', () => {
  it('an auth failure on the CURRENT credential still charges the account', async () => {
    const a = seed('epoch-current');
    const b = seed('epoch-current-peer');

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-epoch-current',
      served: [a, b],
      onAttempt() {
        throw new Error('unauthenticated: invalid api key');
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, stream: true, messages: [{ role: 'user', content: unique('epoch-current') }] },
      ctx,
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(live(a).errorCount || 0, 1,
      'a genuine auth failure on the live credential must still charge the error budget');
    assert.equal(healthCounts(a).dead, 0, 'this is not a dead-token event');
  });

  it('non-stream: an auth failure on the CURRENT credential still charges the account', async () => {
    const a = seed('epoch-ns-current');
    const b = seed('epoch-ns-current-peer');

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-epoch-ns-current',
      served: [a, b],
      onAttempt() {
        throw new Error('unauthenticated: invalid api key');
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: unique('epoch-ns-current') }] },
      ctx,
    );

    assert.ok(result.status >= 400, 'the auth failure surfaces to the client');
    assert.equal(live(a).errorCount || 0, 1,
      'the non-stream arm must charge a live credential\'s auth failure too');
  });

  it('non-stream: an old-key auth failure does not charge the new credential', async () => {
    const a = seed('epoch-ns-stale');
    const b = seed('epoch-ns-stale-peer');
    const acquireKey = a.apiKey;

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-epoch-ns-stale',
      served: [a, b],
      onAttempt(apiKey) {
        assert.equal(apiKey, acquireKey);
        rotate(a);
        throw new Error('unauthenticated: invalid api key');
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: unique('epoch-ns-stale') }] },
      ctx,
    );

    assert.ok(result.status >= 400);
    assert.equal(live(a).errorCount || 0, 0,
      'the retired credential\'s 401 must not charge the fresh key (non-stream twin of 2802)');
  });

  it('an old-key auth failure does not charge the new credential', async () => {
    const a = seed('epoch-stale');
    const b = seed('epoch-stale-peer');
    const acquireKey = a.apiKey;

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-epoch-stale',
      served: [a, b],
      onAttempt(apiKey) {
        assert.equal(apiKey, acquireKey);
        rotate(a);
        throw new Error('unauthenticated: invalid api key');
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, stream: true, messages: [{ role: 'user', content: unique('epoch-stale') }] },
      ctx,
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(live(a).errorCount || 0, 0,
      'the retired credential\'s 401 must not charge the fresh key (finalizeConnectAccount 2802 discipline)');
  });

  it('an old-key success does not clear the new credential\'s error budget', async () => {
    const a = seed('epoch-stale-ok');
    const b = seed('epoch-stale-ok-peer');
    const acquireKey = a.apiKey;
    live(a).errorCount = 2; // demoted by earlier failures on the account

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-epoch-stale-ok',
      served: [a, b],
      onAttempt(apiKey, opts) {
        assert.equal(apiKey, acquireKey);
        rotate(a);
        return streamSuccess(opts);
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, stream: true, messages: [{ role: 'user', content: unique('epoch-stale-ok') }] },
      ctx,
    );
    const res = fakeRes();
    await result.handler(res);

    assert.equal(live(a).errorCount, 2,
      'a success from a retired credential does not prove the new key works — the budget must stay (finalizeConnectAccount 2803 discipline)');
  });

  it('non-stream: an old-key success does not clear the new credential\'s error budget', async () => {
    const a = seed('epoch-ns-stale-ok');
    const b = seed('epoch-ns-stale-ok-peer');
    const acquireKey = a.apiKey;
    live(a).errorCount = 2;

    const ctx = cascadeCtx({
      callerKey: 'session:p2id-epoch-ns-stale-ok',
      served: [a, b],
      onAttempt(apiKey) {
        assert.equal(apiKey, acquireKey);
        rotate(a);
        return nonStreamSuccess();
      },
    });

    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: unique('epoch-ns-stale-ok') }] },
      ctx,
    );

    assert.equal(result.status, 200);
    assert.equal(live(a).errorCount, 2,
      'the non-stream success verdict must stay on the epoch that produced it');
  });
});

describe('P2-2 — connect dead-token verdict follows the account id across a rotation', () => {
  function unauthorized() {
    return Object.assign(new Error('retired session token'), { code: 'UNAUTHORIZED' });
  }

  beforeEach(() => {
    process.env.DEVIN_CONNECT = '1';
    // The dead arm fires the free liveness probe fire-and-forget; stub it so the
    // test never reaches the network and the verdict it records is deterministic.
    __setReloginDeps({ checkSessionLiveness: async () => ({ alive: true }) });
  });

  it('stream: the \'d\' health event lands on the rotated account, not the snapshot', async () => {
    const a = seed('dead-stream-a');
    const b = seed('dead-stream-b');
    const acquireKey = a.apiKey;
    let rotatedKey = '';
    let attempts = 0;

    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        attempts++;
        if (params.token === acquireKey) {
          rotatedKey = rotate(a);
          throw unauthorized();
        }
        // Whatever live credential the failover hands out completes the turn.
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        send({ id: 's', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        return { usage: { total_tokens: 3 } };
      },
    });

    const result = await handleChatCompletions(
      { model: CONNECT_MODEL, stream: true, messages: [{ role: 'user', content: unique('dead-stream') }] },
      { callerKey: '' },
    );
    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);

    assert.ok(rotatedKey, 'precondition: the rotation happened while the attempt was in flight');
    assert.ok(attempts >= 2, 'precondition: the dead verdict triggered a failover hop');
    assert.equal(healthCounts(a).dead, 1,
      'reportDeadToken must resolve A by id; the snapshot misses and the only record that the token came back dead is lost');
    assert.equal(healthCounts(b).dead, 0, 'the peer is not blamed for A\'s dead token');
  });

  it('non-stream: the \'d\' health event lands on the rotated account, not the snapshot', async () => {
    const a = seed('dead-ns-a');
    const b = seed('dead-ns-b');
    const acquireKey = a.apiKey;
    let rotatedKey = '';
    let attempts = 0;

    __setConnectDeps({
      toChatCompletion: async (params) => {
        attempts++;
        if (params.token === acquireKey) {
          rotatedKey = rotate(a);
          throw unauthorized();
        }
        return {
          status: 200,
          body: {
            id: 'x', object: 'chat.completion', created: 0, model: CONNECT_MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          },
        };
      },
    });

    const result = await handleChatCompletions(
      { model: CONNECT_MODEL, messages: [{ role: 'user', content: unique('dead-ns') }] },
      { callerKey: '' },
    );

    assert.equal(result.status, 200, 'the failover hop completed the turn');
    assert.ok(rotatedKey, 'precondition: the rotation happened while the attempt was in flight');
    assert.ok(attempts >= 2, 'precondition: the dead verdict triggered a failover hop');
    assert.equal(healthCounts(a).dead, 1,
      'reportDeadToken must resolve A by id; the snapshot misses and the dead-token health event is dropped');
    assert.equal(healthCounts(b).dead, 0, 'the peer is not blamed for A\'s dead token');
  });
});

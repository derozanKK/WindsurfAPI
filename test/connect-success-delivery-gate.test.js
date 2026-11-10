// P2-5 — the DEVIN_CONNECT stream success arm writes turn state with no delivery
// check. `attemptStream` resolves normally when the upstream turn completed even
// if the client vanished inside the final-write window: `send()` no-ops on a
// closed socket, and the upstream signal abort races the completed turn. The ok
// arm then commits the session-continuity pair, binds prompt-cache affinity, and
// stores the response cache — all for a turn the client never received.
//
// The Cascade stream path already re-checks the abort before every irreversible
// side effect (its cache write is gated on !abortController.signal.aborted). This
// suite pins the same contract for the connect path:
//
//   control:  a delivered turn still commits, caches and binds;
//   gate:     a disconnect inside the final window writes none of them.
//
// Billing/stat success in finalizeConnectAccount is NOT part of the gate — the
// upstream turn really ran and cost quota; only the delivery-dependent state is.

process.env.DEVIN_CONNECT = '1';
process.env.STICKY_SESSION_ENABLED = '1';
process.env.DEVIN_CONNECT_SESSION_REUSE = '1';
process.env.RESPONSE_CACHE_ENABLED = '1';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { handleChatCompletions, __setConnectDeps, __resetConnectDeps } =
  await import('../src/handlers/chat.js');
const auth = await import('../src/auth.js');
const cache = await import('../src/cache.js');
const sticky = await import('../src/account/sticky-session.js');
const continuity = await import('../src/session-continuity.js');

const CALLER = 'session:connect-delivery-gate';
const MODEL = 'swe-1-6-slow';
const created = [];

function seedAccount(label) {
  const a = auth.addAccountByKey(
    `devin-session-token$dg-${label}-${Math.random().toString(36).slice(2)}`, label,
  );
  created.push(a.id);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

function fakeRes() {
  const listeners = new Map();
  const state = { body: '', writableEnded: false };
  const res = {
    get writableEnded() { return state.writableEnded; },
    get body() { return state.body; },
    write(chunk) { state.body += String(chunk); return true; },
    end(chunk) { if (chunk) res.write(chunk); state.writableEnded = true; },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return res; },
    once(event, cb) {
      const wrap = (...args) => { res.removeListener(event, wrap); cb(...args); };
      res.on(event, wrap);
    },
    removeListener(event, cb) {
      const list = listeners.get(event) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(event, ...args) {
      for (const cb of [...(listeners.get(event) || [])]) cb(...args);
    },
    // A real client hang-up fires 'close' WITHOUT marking writableEnded; the
    // handler's close listener then aborts the handler-local controller.
    disconnect() { res.emit('close'); }
  };
  return res;
}

function streamBody() {
  return {
    model: MODEL,
    stream: true,
    messages: [{ role: 'user', content: 'deliver this turn' }],
  };
}

function okResult() {
  return {
    content: 'the answer',
    delivered: 'the answer',
    reasoning: '',
    toolCalls: [],
    finish_reason: 'stop',
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    billing: null,
  };
}

beforeEach(() => {
  __resetConnectDeps();
  cache.cacheClear();
  sticky.resetAllBindings();
  continuity._resetForTests();
});

afterEach(() => {
  __resetConnectDeps();
  while (created.length) {
    try { auth.removeAccount(created.pop()); } catch {}
  }
});

describe('DEVIN_CONNECT stream success writes only for a delivered turn', () => {
  it('control: a delivered turn commits the pair, caches, and binds affinity', async () => {
    seedAccount('control');
    let res;
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        send({ id: 'x', object: 'chat.completion.chunk', created: 1, model: MODEL,
          choices: [{ index: 0, delta: { content: 'the answer' }, finish_reason: null }] });
        return okResult();
      },
    });

    const result = await handleChatCompletions(streamBody(), { callerKey: CALLER });
    assert.equal(result.status, 200);
    res = fakeRes();
    await result.handler(res);

    assert.equal(continuity._getIndexStats().commitKeys, 1,
      'control: a delivered turn must commit its session-continuity pair');
    assert.equal(cache.cacheStats().stores, 1,
      'control: a delivered turn must populate the response cache');
    assert.ok(sticky.getStickyStats().size >= 1,
      'control: a delivered turn must bind prompt-cache affinity');
  });

  it('a disconnect inside the final window writes no session/cache/affinity state', async () => {
    seedAccount('gate');
    let res;
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        send({ id: 'x', object: 'chat.completion.chunk', created: 1, model: MODEL,
          choices: [{ index: 0, delta: { content: 'the answer' }, finish_reason: null }] });
        // The upstream turn completes, but the client is already gone by the
        // time the handler's ok arm runs (send() above raced the close).
        res.disconnect();
        return okResult();
      },
    });

    const result = await handleChatCompletions(streamBody(), { callerKey: CALLER });
    assert.equal(result.status, 200);
    res = fakeRes();
    await result.handler(res);

    assert.equal(continuity._getIndexStats().commitKeys, 0,
      'an undelivered turn must not commit the pair-chain — the next turn would assume the answer was delivered');
    assert.equal(cache.cacheStats().stores, 0,
      'an undelivered turn must not seed the response cache');
    assert.equal(sticky.getStickyStats().size, 0,
      'an undelivered turn must not move prompt-cache affinity to the account');
  });
});

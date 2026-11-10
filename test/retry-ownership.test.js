// Q5-P1 (ownership): the same transport-error class was retried by two owners.
//   - toChatCompletion retried 5xx twice (maxRetries = 2), and
//   - the handler replayed a pre-emit transient error once on the same token.
// Combined with account failover that is three independent retry layers for one
// fault. Ownership after the fix:
//   - the adapter (wrapper) owns transport retries: exactly ONE retry;
//   - the handler owns ACCOUNT failover only (dead token / quota / rate limit),
//     never a same-token transport replay.
//
// The tests below pin both halves, plus the end-to-end arithmetic: a persistent
// 5xx reaches upstream exactly twice (initial + one wrapper retry), not more.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toChatCompletion, streamChatCompletion, __setStreamChatForTest,
} from '../src/devin-connect-openai.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { addAccountByKey, removeAccount } from '../src/auth.js';

const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
const createdIds = [];
const originalDevinConnect = process.env.DEVIN_CONNECT;
const originalDevinOnly = process.env.DEVIN_ONLY;

function fiveHundred() {
  return Object.assign(new Error('upstream 500'), { status: 500 });
}

function seed(label) {
  const acct = addAccountByKey(`devin-session-token$own-${label}-${Math.random().toString(36).slice(2)}`, label);
  acct.status = 'active';
  createdIds.push(acct.id);
  return acct;
}

function fakeResponse() {
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk = '') { this.body += String(chunk); this.writableEnded = true; },
    on() {},
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  delete process.env.DEVIN_ONLY;
});

afterEach(() => {
  __resetConnectDeps();
  __setStreamChatForTest(null);
  while (createdIds.length) removeAccount(createdIds.pop());
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  if (originalDevinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = originalDevinConnect;
  if (originalDevinOnly === undefined) delete process.env.DEVIN_ONLY;
  else process.env.DEVIN_ONLY = originalDevinOnly;
});

describe('wrapper owns transport retries', () => {
  it('toChatCompletion retries a 5xx exactly once (two failing attempts then give up)', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      throw fiveHundred();
    });

    await assert.rejects(
      () => toChatCompletion({ model: 'm', messages: [] }, { retryBaseMs: 1 }),
      /upstream 500/,
    );
    assert.equal(calls, 2, 'initial attempt + exactly one retry, then surface');
  });

  it('streamChatCompletion retries a pre-emit 5xx exactly once, then gives up', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      if (calls <= 2) throw fiveHundred();
      yield { type: 'content', text: 'ok' };
      yield { type: 'finish', reason: 'stop', usage: null };
    });

    const frames = [];
    await assert.rejects(
      () => streamChatCompletion({ model: 'm', messages: [] }, (f) => frames.push(f), { retryBaseMs: 1 }),
      /upstream 500/,
    );
    assert.equal(calls, 2, 'initial attempt + exactly one retry');
    const primes = frames.filter((f) => f.choices?.[0]?.delta?.role === 'assistant');
    assert.equal(primes.length, 0, 'the failed attempts emitted no role-prime chunk');
  });

  it('streamChatCompletion recovers after exactly one retry (same token, no failover)', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      if (calls === 1) throw fiveHundred();
      yield { type: 'content', text: 'RECOVERED' };
      yield { type: 'finish', reason: 'stop', usage: null };
    });

    const frames = [];
    const out = await streamChatCompletion({ model: 'm', messages: [] }, (f) => frames.push(f), { retryBaseMs: 1 });
    assert.equal(out.content, 'RECOVERED');
    assert.equal(calls, 2, 'one in-place replay');
    const primes = frames.filter((f) => f.choices?.[0]?.delta?.role === 'assistant');
    assert.equal(primes.length, 1, 'exactly one role-prime chunk across both attempts');
  });

  it('streamChatCompletion retries a pre-emit CAPACITY blip once and recovers (P0 #56/#57)', async () => {
    // Capacity ("high demand") is classified retryable in devin-connect.js.
    // The adapter — not the handler — owns the one in-place replay, so a busy
    // blip still streams without a re-login or an account hop.
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("We're currently facing high demand for this model."), { code: 'CAPACITY', status: 401 });
      }
      yield { type: 'content', text: 'AFTERBUSY' };
      yield { type: 'finish', reason: 'stop', usage: null };
    });

    const out = await streamChatCompletion({ model: 'm', messages: [] }, () => {}, { retryBaseMs: 1 });
    assert.equal(out.content, 'AFTERBUSY');
    assert.equal(calls, 2, 'one in-place replay');
  });

  it('streamChatCompletion does NOT retry once a delta reached the client', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      yield { type: 'content', text: 'PARTIAL' };
      throw fiveHundred();
    });

    const frames = [];
    await assert.rejects(
      () => streamChatCompletion({ model: 'm', messages: [] }, (f) => frames.push(f), { retryBaseMs: 1 }),
      /upstream 500/,
    );
    assert.equal(calls, 1, 'a retry would duplicate the emitted PARTIAL');
    assert.ok(frames.some((f) => f.choices?.[0]?.delta?.content === 'PARTIAL'));
  });
});

describe('handler owns account failover, not transport replay', () => {
  it('non-stream: a 5xx is NOT replayed by the handler', async () => {
    seed('non-stream');
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => { calls++; throw fiveHundred(); },
    });

    const res = await handleChatCompletions(
      { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'hi' }], stream: false },
      { reqId: 'own-ns', callerKey: 'own-caller', specialAgent: {} },
    );

    assert.notEqual(res.status, 200);
    assert.equal(calls, 1, 'the handler did not add a second transport retry');
  });

  it('stream: a pre-emit 5xx is NOT replayed by the handler', async () => {
    seed('stream');
    let calls = 0;
    __setConnectDeps({
      streamChatCompletion: async () => { calls++; throw fiveHundred(); },
    });

    const out = await handleChatCompletions(
      { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { reqId: 'own-stream', callerKey: 'own-caller', specialAgent: {} },
    );
    const res = fakeResponse();
    await out.handler(res);

    assert.equal(calls, 1, 'the handler did not replay the same token after a transport fault');
    assert.match(res.body, /upstream 500/, 'the error still reaches the client');
  });

  it('end-to-end: a persistent 5xx reaches upstream exactly twice, not three times', async () => {
    seed('e2e');
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      throw fiveHundred();
    });
    // Use the REAL adapter so its internal retry budget participates; the
    // handler must not add its own.
    __setConnectDeps({
      toChatCompletion: (params, opts) => toChatCompletion(params, { ...opts, retryBaseMs: 1 }),
    });

    const res = await handleChatCompletions(
      { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'hi' }], stream: false },
      { reqId: 'own-e2e', callerKey: 'own-caller', specialAgent: {} },
    );

    assert.notEqual(res.status, 200);
    assert.equal(calls, 2, 'wrapper: initial + one retry; handler: no extra attempt');
  });
});

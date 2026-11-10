// RATE-GAP2 — red→green pins for the two "missing boundary" fixes from the
// RATE-RETRY audit (RR-SUMMARY GAP-2 / GAP-3):
//
//   GAP-2  cancellation signal propagation. A client disconnect must stop the
//          upstream burn on every outbound call of the cascade/legacy flows:
//          chat.js threads context.signal into nonStreamResponse → cascadeChat /
//          rawGetChatMessage opts, into the non-stream queue wait, and into the
//          stream path's rawGetChatMessage; client.rawGetChatMessage accepts
//          opts.signal; grpc.js grpcStream supports abort (NGHTTP2_CANCEL +
//          AbortError).
//
//   GAP-3  LS gRPC timeout classification. `gRPC unary timeout` / `gRPC stream
//          timeout` from the local language server must classify as cascade
//          transport errors so the non-stream loop rotates to the next account
//          instead of surfacing a hard 502.
//
// The chat.js end-to-end cases drive handleChatCompletions through the same
// fake-client seam other handler tests use; the grpc cases patch http2.connect
// with an EventEmitter session/request pair (the s2-b harness shape) so no
// socket is ever opened.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import { addAccountByKey, getAccountInternal, getApiKey, removeAccount } from '../src/auth.js';
import { handleChatCompletions, isUpstreamTransientError } from '../src/handlers/chat.js';
import { isCascadeTransportError, WindsurfClient } from '../src/client.js';
import { closeSessionForPort, grpcStream } from '../src/grpc.js';
import { MODELS } from '../src/models.js';

// Legacy-shaped probe model (no modelUid / no enum) so the flow routes through
// the RawGetChatMessage branch — injected into MODELS per test and removed in
// afterEach. Every catalogued legacy model is deprecated and returns 410 before
// the flow, so this is the only way to drive the branch end to end.
const LEGACY_TEST_MODEL = 'rate-gap2-legacy-probe';

const createdIds = [];

function seed(label) {
  const a = addAccountByKey(`test-key-${label}-${Math.random().toString(36).slice(2)}`, label);
  createdIds.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

afterEach(() => {
  while (createdIds.length) { try { removeAccount(createdIds.pop()); } catch {} }
  delete MODELS[LEGACY_TEST_MODEL];
});

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs = 1500) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) return false;
    await delay(5);
  }
  return true;
}

let portSeq = 44710;
const nextPort = () => ++portSeq;

/** EventEmitter stand-ins for a real http2 session + request pair. */
function fakeGrpcTransport() {
  const req = new EventEmitter();
  const session = new EventEmitter();
  const state = { requests: 0, closeCodes: [] };
  req.write = () => true;
  req.end = () => {};
  req.close = (code) => state.closeCodes.push(code);
  session.request = () => { state.requests++; return req; };
  session.unref = () => {};
  session.close = () => { session.closed = true; };
  return { req, session, state };
}

/** Fake SSE response object with real 'close' event support. */
function streamRes() {
  const listeners = new Map();
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.statusCode = status; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true; },
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return this; },
    once(ev, fn) { return this.on(ev, fn); },
    removeListener() {},
    emit(ev, ...args) { for (const fn of listeners.get(ev) || []) fn(...args); },
  };
}

const handlerContext = (overrides = {}) => ({
  waitForAccount(tried, _signal, _maxWait, modelKey) { return getApiKey(tried, modelKey); },
  ensureLs: async () => {},
  getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
  ...overrides,
});

describe('GAP-3: LS gRPC timeouts classify as transient and rotate accounts', () => {
  it('isCascadeTransportError matches the LS timeout messages without over-matching', () => {
    assert.equal(isCascadeTransportError(new Error('gRPC unary timeout')), true);
    assert.equal(isCascadeTransportError(new Error('gRPC stream timeout')), true);
    assert.equal(isCascadeTransportError(new Error('permission_denied: model unavailable')), false);
    assert.equal(isCascadeTransportError(new Error('untrusted workspace')), false);
  });

  it('isUpstreamTransientError treats an LS timeout as transient', () => {
    assert.equal(isUpstreamTransientError(new Error('gRPC unary timeout')), true);
    assert.equal(isUpstreamTransientError(new Error('gRPC stream timeout')), true);
  });

  it('a simulated LS timeout retries on the next account instead of failing hard', async () => {
    seed('gap3-a');
    seed('gap3-b');
    const used = [];
    class TimeoutClient {
      constructor(apiKey) { used.push(apiKey); }
      async cascadeChat() { throw new Error('gRPC stream timeout'); }
    }
    const result = await handleChatCompletions(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] },
      handlerContext({ WindsurfClient: TimeoutClient }),
    );
    assert.equal(used.length, 2, 'the LS timeout must be retried on the next account (GAP-3)');
    assert.notEqual(used[0], used[1], 'the retry must land on a different account');
    assert.equal(result.status, 503);
    assert.equal(
      result.body.error.type,
      'upstream_transient_error',
      'the timeout must classify as transient, not a hard upstream_error',
    );
  });
});

describe('GAP-2: cancellation signals reach every outbound call', () => {
  it('grpcStream: abort cancels the HTTP/2 stream with NGHTTP2_CANCEL and reports AbortError', async () => {
    const port = nextPort();
    const { req, session, state } = fakeGrpcTransport();
    const events = [];
    const ac = new AbortController();
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const savedConnect = http2.connect;
    http2.connect = () => session;
    try {
      grpcStream(port, 'csrf', '/x/test', Buffer.alloc(0), {
        timeout: 3000,
        signal: ac.signal,
        onData: (p) => events.push(['data', p.length]),
        onError: (e) => { events.push(['error', e.name, e.code]); settle(e); },
        onEnd: () => { events.push(['end']); settle(null); },
      });
    } finally {
      http2.connect = savedConnect;
    }
    ac.abort();
    const outcome = await Promise.race([
      done.then(e => (e ? `error:${e.name}:${e.code}` : 'end')),
      delay(400).then(() => 'pending'),
    ]);
    try {
      assert.equal(outcome, 'error:AbortError:ABORT_ERR', 'abort must settle with a real AbortError');
      assert.deepEqual(
        state.closeCodes,
        [http2.constants.NGHTTP2_CANCEL],
        'abort must close the stream with NGHTTP2_CANCEL',
      );
      req.emit('end');
      req.emit('error', new Error('late event after abort'));
      assert.deepEqual(events, [['error', 'AbortError', 'ABORT_ERR']], 'the stream must settle exactly once');
    } finally {
      req.emit('error', new Error('test cleanup'));
      await done;
      closeSessionForPort(port);
    }
  });

  it('grpcStream: an already-aborted signal settles with AbortError without opening a stream', async () => {
    const port = nextPort();
    const { req, session, state } = fakeGrpcTransport();
    const events = [];
    const ac = new AbortController();
    ac.abort();
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const savedConnect = http2.connect;
    http2.connect = () => session;
    try {
      grpcStream(port, 'csrf', '/x/test', Buffer.alloc(0), {
        timeout: 250,
        signal: ac.signal,
        onError: (e) => { events.push(['error', e.name, e.code]); settle(e); },
        onEnd: () => { events.push(['end']); settle(null); },
      });
    } finally {
      http2.connect = savedConnect;
    }
    const outcome = await Promise.race([
      done.then(e => (e ? `error:${e.name}:${e.code}` : 'end')),
      delay(400).then(() => 'pending'),
    ]);
    try {
      assert.equal(outcome, 'error:AbortError:ABORT_ERR');
      assert.equal(state.requests, 0, 'no HTTP/2 stream may be opened for a pre-aborted signal');
      assert.deepEqual(state.closeCodes, []);
    } finally {
      // A pre-aborted signal never opens a request, so there may be no 'error'
      // listener to absorb the cleanup emit (EventEmitter 'error' throws bare).
      if (req.listenerCount('error') > 0) req.emit('error', new Error('test cleanup'));
      await done;
      closeSessionForPort(port);
    }
  });

  it('grpcStream: an abort after the stream settled is ignored', async () => {
    const port = nextPort();
    const { req, session, state } = fakeGrpcTransport();
    const events = [];
    const ac = new AbortController();
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const savedConnect = http2.connect;
    http2.connect = () => session;
    try {
      grpcStream(port, 'csrf', '/x/test', Buffer.alloc(0), {
        timeout: 3000,
        signal: ac.signal,
        onError: (e) => { events.push(['error', e.name, e.code]); settle(e); },
        onEnd: () => { events.push(['end']); settle(null); },
      });
    } finally {
      http2.connect = savedConnect;
    }
    // A real gRPC stream ends with a terminal status; without one the client
    // now (correctly) reports a truncated response instead of a clean end.
    req.emit('response', { ':status': 200 });
    req.emit('trailers', { 'grpc-status': '0' });
    req.emit('end');
    await done;
    ac.abort();
    assert.deepEqual(events, [['end']], 'a late abort must not re-settle the stream');
    assert.deepEqual(state.closeCodes, []);
    closeSessionForPort(port);
  });

  it('rawGetChatMessage: opts.signal aborts the LS stream with AbortError', async () => {
    const port = nextPort();
    const { req, session, state } = fakeGrpcTransport();
    const ac = new AbortController();
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const client = new WindsurfClient('test-key', port, 'csrf');
    const savedConnect = http2.connect;
    http2.connect = () => session;
    try {
      client.rawGetChatMessage([{ role: 'user', content: 'hi' }], 166, null, { signal: ac.signal })
        .then(() => settle('resolved'), (e) => settle(`rejected:${e.name}:${e.code}`));
      await waitUntil(() => state.requests > 0, 1000);
      ac.abort();
      const outcome = await Promise.race([done, delay(400).then(() => 'pending')]);
      assert.equal(outcome, 'rejected:AbortError:ABORT_ERR');
      assert.deepEqual(state.closeCodes, [http2.constants.NGHTTP2_CANCEL]);
    } finally {
      http2.connect = savedConnect;
      req.emit('error', new Error('test cleanup'));
      await done;
      closeSessionForPort(port);
    }
  });

  it('non-stream cascade: context.signal reaches cascadeChat opts', async () => {
    seed('gap2-cascade');
    const seen = [];
    class FakeClient {
      async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
        seen.push(opts.signal);
        return Object.assign([{ text: 'ok' }], { toolCalls: [], usage: null });
      }
    }
    const ac = new AbortController();
    const result = await handleChatCompletions(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] },
      handlerContext({ signal: ac.signal, WindsurfClient: FakeClient }),
    );
    assert.equal(result.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], ac.signal, 'cascadeChat must receive the request signal (GAP-2)');
  });

  it('non-stream queue wait: waitForAccount receives the request signal', async () => {
    seed('gap2-wait');
    let seen = 'NOT_CALLED';
    const ac = new AbortController();
    class FakeClient {
      async cascadeChat() { throw new Error('must not run — the mock queue wait returns null'); }
    }
    const result = await handleChatCompletions(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] },
      handlerContext({
        signal: ac.signal,
        waitForAccount(tried, signal) { seen = signal; return null; },
        WindsurfClient: FakeClient,
      }),
    );
    assert.ok(result && result.status >= 400, 'the request must terminate with a pool error');
    assert.equal(seen, ac.signal, 'the queue wait must observe the request signal (GAP-2)');
  });

  it('non-stream legacy: context.signal reaches rawGetChatMessage opts', async () => {
    seed('gap2-legacy');
    MODELS[LEGACY_TEST_MODEL] = { name: LEGACY_TEST_MODEL, provider: 'windsurf', enumValue: 0 };
    const seen = [];
    class FakeClient {
      async rawGetChatMessage(_messages, _modelEnum, _modelUid, opts = {}) {
        seen.push(opts.signal);
        return [{ text: 'hi' }];
      }
    }
    const ac = new AbortController();
    const result = await handleChatCompletions(
      { model: LEGACY_TEST_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      handlerContext({ signal: ac.signal, WindsurfClient: FakeClient }),
    );
    assert.equal(result.status, 200);
    assert.equal(seen[0], ac.signal, 'rawGetChatMessage must receive the request signal (GAP-2)');
  });

  it('stream legacy: a client disconnect aborts the signal handed to rawGetChatMessage', async () => {
    seed('gap2-stream-legacy');
    MODELS[LEGACY_TEST_MODEL] = { name: LEGACY_TEST_MODEL, provider: 'windsurf', enumValue: 0 };
    let seen = 'NOT_CALLED';
    class FakeClient {
      async rawGetChatMessage(_messages, _modelEnum, _modelUid, opts = {}) {
        seen = opts.signal ?? 'NO_SIGNAL';
        await new Promise((resolve, reject) => {
          const abortErr = () => Object.assign(
            new Error('The operation was aborted'),
            { name: 'AbortError', code: 'ABORT_ERR' },
          );
          if (opts.signal?.aborted) return reject(abortErr());
          opts.signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
          setTimeout(resolve, 600); // red-path fallback so the stream can still finish
        });
        return [];
      }
    }
    const result = await handleChatCompletions(
      { model: LEGACY_TEST_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      handlerContext({ WindsurfClient: FakeClient }),
    );
    assert.equal(result.status, 200);
    const res = streamRes();
    const done = result.handler(res);
    try {
      await waitUntil(() => seen !== 'NOT_CALLED', 1500);
      assert.notEqual(seen, 'NOT_CALLED', 'rawGetChatMessage was never called');
      assert.notEqual(seen, 'NO_SIGNAL', 'rawGetChatMessage must receive opts.signal (GAP-2)');
      assert.equal(seen.aborted, false);
      res.emit('close');
      await done;
      assert.equal(seen.aborted, true, 'the client disconnect must abort the signal (GAP-2)');
    } finally {
      res.emit('close');
      await Promise.race([done, delay(1500)]);
    }
  });

  it('non-stream NLU correction retry: the retry cascadeChat receives the signal', async () => {
    seed('gap2-nlu');
    const saved = process.env.WINDSURFAPI_NLU_RETRY;
    process.env.WINDSURFAPI_NLU_RETRY = '1';
    try {
      const signals = [];
      class FakeClient {
        async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
          signals.push(opts.signal);
          const text = signals.length === 1
            ? 'Let me list the workspace files to find the config.'
            : 'Still not emitting a call.';
          return Object.assign([{ text }], { toolCalls: [], usage: null });
        }
      }
      const shellTool = {
        type: 'function',
        function: {
          name: 'shell_exec',
          description: 'run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      };
      const ac = new AbortController();
      const result = await handleChatCompletions(
        {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'list the files in the workspace' }],
          tools: [shellTool],
        },
        handlerContext({ signal: ac.signal, WindsurfClient: FakeClient }),
      );
      assert.equal(result.status, 200);
      assert.equal(signals.length, 2, 'the narrate-only first pass must trigger the correction retry');
      assert.equal(signals[0], ac.signal, 'first-pass cascadeChat must receive the request signal');
      assert.equal(signals[1], ac.signal, 'the NLU correction retry cascadeChat must receive the request signal (GAP-2)');
    } finally {
      if (saved === undefined) delete process.env.WINDSURFAPI_NLU_RETRY;
      else process.env.WINDSURFAPI_NLU_RETRY = saved;
    }
  });
});

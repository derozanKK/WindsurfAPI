// An aborted Cascade turn must not be committed as a completed one.
//
// Measured on 769d6ee (evidence/GFReliability.md §1): the polling loop in
// `cascadeChat` treated a client disconnect as a normal return with whatever
// chunks it had, so `streamResponse` ran its success block against a dead
// socket — pool check-in, spend record, finish_reason:"stop", `[DONE]`, cache
// set. A later identical request was then served from cache with the partial
// answer and zero upstream calls.
//
// This suite drives the real `cascadeChat` against a scripted loopback LS and
// the real `streamResponse` (via handleChatCompletions) against a response that
// goes away on the first content byte. It pins the abort contract:
//
//   client:  cascadeChat rejects with AbortError and skips the post-turn
//            metadata RPC instead of resolving with partial chunks;
//   handler: no write after close, no pool check-in, no spend, no cache entry
//            (the next identical request must reach upstream again).
//
// Non-abort paths are untouched; the regression suites named in the brief
// (startserver-cancel, startserver-cascade-1m, client-panel-retry, rate-risk,
// client-invariants) are the guard for that.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { terminateRpcWithStatus, isConnectContentType } from './helpers/fake-grpc-trailers.mjs';
import { endOfStreamEnvelope, wrapEnvelope } from '../src/connect.js';
import { writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';

// src/client.js snapshots CASCADE_TIMEOUTS at module evaluation and src/grpc.js
// snapshots GRPC_PROTOCOL, so both must be set before the dynamic imports below.
process.env.GRPC_PROTOCOL = 'connect';
process.env.CASCADE_POLL_INTERVAL_MS = '5';
process.env.CASCADE_IDLE_GRACE_MS = '1';
process.env.CASCADE_MAX_WAIT_MS = '2000';
process.env.CASCADE_COLD_STALL_BASE_MS = '2000';
process.env.CASCADE_WARM_STALL_MS = '2000';
process.env.RESPONSE_CACHE_ENABLED = '1';

const PARTIAL = 'PARTIAL-ANSWER-FROM-UPSTREAM';

let WindsurfClient;
let handleChatCompletions;
let resolveModel;
let auth;
let cache;
let pool;

function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

function responseBody(payload, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function startCascadeResponse(cascadeId) {
  return writeStringField(1, cascadeId);
}

function trajectoryStatusResponse(status) {
  return writeVarintField(2, status);
}

function trajectoryStepsResponse(text) {
  if (!text) return Buffer.alloc(0);
  const planner = writeStringField(1, text);
  const step = Buffer.concat([
    writeVarintField(1, 15),
    writeVarintField(4, 3),
    writeMessageField(20, planner),
  ]);
  return writeMessageField(1, step);
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', session => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => { terminateRpcWithStatus(stream); handler(stream, headers); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise(resolve => server.close(resolve));
  }
}

/**
 * Scripted Cascade upstream. Answers the handshake, streams one planner step
 * with PARTIAL text on every steps poll, reports the trajectory ACTIVE, and
 * counts StartCascade / metadata calls so the test can tell a cache replay
 * (zero new upstream turns) from a fresh attempt.
 */
function cascadeUpstream({ onSteps } = {}) {
  const state = { startCalls: 0, stepsCalls: 0, metadataCalls: 0, statusCalls: 0 };
  const handler = (stream, headers) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const method = String(headers[':path'] || '').split('/').pop();
      const contentType = headers['content-type'] || 'application/grpc';
      if (method === 'StartCascade') {
        state.startCalls += 1;
        stream.respond({ ':status': 200, 'content-type': contentType });
        stream.end(responseBody(startCascadeResponse('abort-cascade'), headers));
        return;
      }
      if (method === 'SendUserCascadeMessage') {
        stream.respond({ ':status': 200, 'content-type': contentType });
        stream.end(responseBody(Buffer.alloc(0), headers));
        return;
      }
      if (method === 'GetCascadeTrajectorySteps') {
        state.stepsCalls += 1;
        onSteps?.(state.stepsCalls);
        stream.respond({ ':status': 200, 'content-type': contentType });
        stream.end(responseBody(trajectoryStepsResponse(PARTIAL), headers));
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        state.statusCalls += 1;
        stream.respond({ ':status': 200, 'content-type': contentType });
        // 2 = ACTIVE, so the only exit is the abort check, not idle_done.
        stream.end(responseBody(trajectoryStatusResponse(2), headers));
        return;
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        state.metadataCalls += 1;
        stream.respond({ ':status': 200, 'content-type': contentType });
        stream.end(responseBody(Buffer.alloc(0), headers));
        return;
      }
      stream.respond({ ':status': 200, 'content-type': contentType });
      stream.end(responseBody(Buffer.alloc(0), headers));
    });
  };
  return { state, handler };
}

/**
 * Response double with the same liveness facts Node gives a destroyed peer:
 * `close` fires, `writableEnded` stays false, writes after close are accepted
 * silently. `onFirstContent` runs AFTER the first PARTIAL bytes are recorded,
 * so the test can distinguish pre-close bytes from post-close ones.
 */
function responseThatDisconnectsOnFirstContent() {
  const listeners = new Map();
  const writes = [];
  const state = { closed: false, writableEnded: false, statusCode: 0, body: '' };
  const res = {
    statusCode: 0,
    get writableEnded() { return state.writableEnded; },
    writeHead(status) { state.statusCode = status; res.statusCode = status; },
    write(chunk) {
      const text = String(chunk);
      state.body += text;
      writes.push({ text, afterClose: state.closed });
      if (!state.closed && text.includes(PARTIAL)) res.emit('close');
      return true;
    },
    end(chunk) {
      if (chunk) res.write(chunk);
      state.writableEnded = true;
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
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
      if (event === 'close') state.closed = true;
      for (const cb of [...(listeners.get(event) || [])]) cb(...args);
    },
  };
  return { res, writes, state };
}

function seedAccount(label) {
  const a = auth.addAccountByKey(`devin-session-token$xk-abort-${label}-${Math.random().toString(36).slice(2)}`, label);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

function handlerContext(port, acct = null) {
  return {
    callerKey: 'session:cascade-abort-side-effects',
    // Pin the account under test: the store keeps accounts from earlier tests
    // alive until `after`, and an unpinned selection could bill a different
    // row than the one this test measures.
    waitForAccount: (tried, _signal, _maxWait, modelKey) => (acct
      ? { id: acct.id, email: acct.email, apiKey: acct.apiKey, proxy: null }
      : auth.getApiKey(tried, modelKey)),
    ensureLs: async () => {},
    getLsFor: () => ({ port, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient,
  };
}

function abortBody() {
  return {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'abort this turn' }],
    stream: true,
  };
}

const createdIds = [];

before(async () => {
  ({ WindsurfClient } = await import('../src/client.js'));
  ({ handleChatCompletions } = await import('../src/handlers/chat.js'));
  ({ resolveModel } = await import('../src/models.js'));
  auth = await import('../src/auth.js');
  cache = await import('../src/cache.js');
  pool = await import('../src/conversation-pool.js');
});

beforeEach(() => {
  cache.cacheClear();
  pool.poolClear();
});

after(() => {
  while (createdIds.length) {
    try { auth.removeAccount(createdIds.pop()); } catch {}
  }
  cache.cacheClear();
  pool.poolClear();
});

async function runAbortedTurn(port, acct) {
  const result = await handleChatCompletions(abortBody(), handlerContext(port, acct));
  assert.equal(result.status, 200);
  assert.equal(result.stream, true);
  const { res, writes, state } = responseThatDisconnectsOnFirstContent();
  await result.handler(res);
  return { writes, state };
}

describe('Cascade abort is not a completed turn', () => {
  it('cascadeChat rejects with AbortError instead of returning partial chunks', async () => {
    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const ac = new AbortController();
      let sawText = false;
      let resolved = null;
      let rejected = null;
      try {
        resolved = await client.cascadeChat(
          [{ role: 'user', content: 'abort mid-stream' }], 0, 'claude-sonnet-4-6',
          {
            signal: ac.signal,
            onChunk: (chunk) => {
              if (chunk.text) { sawText = true; ac.abort(); }
            },
          },
        );
      } catch (err) {
        rejected = err;
      }

      assert.equal(sawText, true, 'precondition: the upstream text must have been streamed');
      assert.equal(resolved, null,
        `cascadeChat resolved with partial chunks after the client aborted: ${JSON.stringify(
          (resolved || []).map(c => c.text || '').join(''))}`);
      assert.equal(rejected?.name, 'AbortError',
        `cascadeChat must reject with AbortError on client abort, got ${rejected?.name || 'none'}: ${rejected?.message || ''}`);
      assert.equal(state.metadataCalls, 0,
        'the post-turn generator-metadata RPC must not run for an aborted turn');
      assert.equal(state.startCalls, 1, 'abort must not start a second cascade');
    });
  });

  it('writes no frame after the client is gone', async () => {
    const acct = seedAccount('write-gate');
    createdIds.push(acct.id);
    const { handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const { writes, state } = await runAbortedTurn(port, acct);

      assert.equal(state.closed, true, 'precondition: the response must have closed mid-stream');
      assert.ok(writes.some(w => w.text.includes(PARTIAL)),
        'precondition: the partial answer must have reached the client before the close');
      const afterClose = writes.filter(w => w.afterClose);
      assert.deepEqual(afterClose, [],
        `wrote ${afterClose.length} frame(s) to a closed response: ${afterClose.map(w => w.text.slice(0, 120)).join(' | ')}`);
      assert.equal(
        writes.some(w => w.afterClose && w.text.includes('"finish_reason":"stop"')), false,
        'a success terminal (finish_reason:"stop") must not be emitted for an aborted turn');
    });
  });

  it('does not pool an aborted cascade', async () => {
    const acct = seedAccount('pool');
    createdIds.push(acct.id);

    const { handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      await runAbortedTurn(port, acct);
      assert.equal(pool.poolStats().size, 0,
        'an aborted cascade must not be checked into the reuse pool');
    });
  });

  it('does not bill an aborted turn', async () => {
    const acct = seedAccount('spend');
    createdIds.push(acct.id);
    const spendBefore = auth.getAccountPublic(acct.id)?.totalSpend?.totalTokens ?? 0;

    const { handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      await runAbortedTurn(port, acct);
      const spendAfter = auth.getAccountPublic(acct.id)?.totalSpend?.totalTokens ?? 0;
      assert.equal(spendAfter, spendBefore,
        `an aborted turn must not be billed (${spendBefore} -> ${spendAfter})`);
    });
  });

  it('does not cache an aborted turn', async () => {
    const acct = seedAccount('cache-store');
    createdIds.push(acct.id);

    const { handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      await runAbortedTurn(port, acct);
      assert.equal(cache.cacheStats().stores, 0,
        'an aborted turn must not populate the response cache');
    });
  });

  it('an identical follow-up request is not served from cache with the partial answer', async () => {
    const acct = seedAccount('cache-replay');
    createdIds.push(acct.id);

    const { state, handler } = cascadeUpstream();
    await withFakeLanguageServer(handler, async (port) => {
      const ctx = handlerContext(port, acct);

      const first = await handleChatCompletions(abortBody(), ctx);
      const firstRes = responseThatDisconnectsOnFirstContent();
      await first.handler(firstRes.res);
      assert.equal(state.startCalls, 1, 'precondition: the first turn reached upstream once');

      const second = await handleChatCompletions(abortBody(), ctx);
      const secondRes = responseThatDisconnectsOnFirstContent();
      await second.handler(secondRes.res);

      assert.equal(state.startCalls, 2,
        'the follow-up identical request was served locally (cache hit) instead of reaching upstream — '
        + 'the aborted partial answer was cached as a completed turn');
    });
  });
});

function nonStreamAbortBody() {
  return {
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'abort this turn' },
    ],
    stream: false,
  };
}

async function withNonStreamAbort(fn) {
  const ac = new AbortController();
  const { state, handler } = cascadeUpstream({ onSteps: () => ac.abort() });
  return withFakeLanguageServer(handler, (port) => fn({ port, ac, state }));
}

/**
 * Runs one non-stream request that aborts on its first trajectory poll. The
 * reuse pool is seeded under the handler's own pre-turn fingerprint so the
 * test also covers the restore-on-failure path, not just the success check-in.
 */
async function runNonStreamAbortedTurn(port, acct, ac) {
  const ctx = { ...handlerContext(port, acct), signal: ac.signal };
  const body = nonStreamAbortBody();
  const modelKey = resolveModel(body.model);
  // buildReuseOpts() for a tool-less chat request is exactly this bag.
  const fpBefore = pool.fingerprintBefore(body.messages, modelKey, ctx.callerKey, {
    tools: [], toolChoice: null, toolPreamble: '', preambleTier: null,
    emulateTools: false, route: 'chat',
  });
  pool.checkin(fpBefore, {
    cascadeId: 'seeded-cascade',
    sessionId: 'seeded-session',
    lsPort: port,
    lsGeneration: 1,
    apiKey: acct.apiKey,
    modelKey,
    stepOffset: 1,
    generatorOffset: 1,
  }, ctx.callerKey, 0);
  assert.equal(pool.poolStats().size, 1, 'precondition: seeded reuse entry');
  const hitsBefore = pool.poolStats().hits;
  const spendBefore = auth.getAccountPublic(acct.id)?.totalSpend?.totalTokens ?? 0;

  const result = await handleChatCompletions(body, ctx);

  assert.equal(pool.poolStats().hits, hitsBefore + 1,
    'precondition: the handler must have checked out the seeded cascade');
  return { result, spendBefore };
}

describe('Cascade non-stream abort is not a completed turn', () => {
  it('returns 499 instead of a success body', async () => {
    const acct = seedAccount('nonstream-body');
    createdIds.push(acct.id);
    await withNonStreamAbort(async ({ port, ac }) => {
      const { result } = await runNonStreamAbortedTurn(port, acct, ac);
      assert.equal(result.status, 499,
        `an aborted non-stream turn must not return a success body (got ${result.status})`);
      assert.equal(result.body?.error?.type, 'client_disconnect');
      assert.equal(result.body?.choices, undefined, 'no completion choices may be returned');
    });
  });

  it('does not restore or check in the cascade', async () => {
    const acct = seedAccount('nonstream-pool');
    createdIds.push(acct.id);
    await withNonStreamAbort(async ({ port, ac }) => {
      await runNonStreamAbortedTurn(port, acct, ac);
      assert.equal(pool.poolStats().size, 0,
        'an aborted non-stream turn must not restore or check in the cascade');
    });
  });

  it('does not cache the partial answer', async () => {
    const acct = seedAccount('nonstream-cache');
    createdIds.push(acct.id);
    await withNonStreamAbort(async ({ port, ac }) => {
      await runNonStreamAbortedTurn(port, acct, ac);
      assert.equal(cache.cacheStats().stores, 0,
        'an aborted non-stream turn must not populate the response cache');
    });
  });

  it('does not bill the turn', async () => {
    const acct = seedAccount('nonstream-spend');
    createdIds.push(acct.id);
    await withNonStreamAbort(async ({ port, ac }) => {
      const { spendBefore } = await runNonStreamAbortedTurn(port, acct, ac);
      const spendAfter = auth.getAccountPublic(acct.id)?.totalSpend?.totalTokens ?? 0;
      assert.equal(spendAfter, spendBefore,
        `an aborted non-stream turn must not be billed (${spendBefore} -> ${spendAfter})`);
    });
  });

  it('stops polling without retry or a post-turn metadata RPC', async () => {
    const acct = seedAccount('nonstream-poll');
    createdIds.push(acct.id);
    await withNonStreamAbort(async ({ port, ac, state }) => {
      await runNonStreamAbortedTurn(port, acct, ac);
      assert.equal(state.stepsCalls, 1,
        'the abort must stop the polling loop without a retry/failover');
      assert.equal(state.metadataCalls, 0,
        'the post-turn metadata RPC must not run for an aborted turn');
    });
  });
});

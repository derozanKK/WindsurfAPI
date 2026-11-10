// SEED-C2 — transparent drain propagation on the direct OpenAI Cascade SSE path.
//
// Measured on the audited baseline: the real handler made four writes / 835 bytes
// into a writable that had already returned false, because `res.write`'s verdict
// was ignored and the Cascade poll loop was never awaited. A slow reader therefore
// bought unbounded producer work (more trajectory polls, more frames, more memory)
// with no backpressure at all.
//
// Two levels of proof are required and both are here:
//   * the WRITER contract, driven through the real handler with a writable whose
//     `write()` verdicts and `drain` event the test owns; and
//   * the PRODUCER contract, driven through the real `WindsurfClient.cascadeChat`
//     against a scripted local language server — an injected fake producer that
//     merely happens to await proves nothing about the shipped poll loop.
//
// Only transport/resource boundaries are faked: the fake LS answers the real
// protobuf RPCs over loopback HTTP/2 (the same fixture style
// test/client-panel-retry.test.js uses), and the handler's Cascade client seam is
// the one test/cascade-stream-account-spend.test.js uses.

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { terminateRpcWithStatus, isConnectContentType } from './helpers/fake-grpc-trailers.mjs';
import { EventEmitter } from 'node:events';

import { addAccountByKey, getAccountInternal, getApiKey, removeAccount } from '../src/auth.js';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleGemini } from '../src/handlers/gemini.js';
import { endOfStreamEnvelope, wrapEnvelope } from '../src/connect.js';
import { writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';

const HEARTBEAT_MS = 15_000; // mirrors the constant in chat.js
const MODEL = 'gemini-2.5-flash';

const createdIds = [];
let savedEnv = {};

function seed(label) {
  const a = addAccountByKey(`devin-session-token$c2-${label}-${Math.random().toString(36).slice(2)}`, label);
  createdIds.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.tierManual = true;
  acct.status = 'active';
  return acct;
}

/**
 * A writable the test fully controls: it records every frame, reports `false` at
 * one chosen write, and exposes listener counts so a leaked drain/close/error
 * waiter is visible.
 */
function controlledRes({ falseAt = 2 } = {}) {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headersSent = false;
  res.writableEnded = false;
  res.writes = [];
  res.falseSignals = 0;
  res.listenerPeak = { drain: 0, close: 0, error: 0 };
  const track = (event) => {
    const count = res.listenerCount(event);
    if (count > res.listenerPeak[event]) res.listenerPeak[event] = count;
  };
  const origOn = res.on.bind(res);
  res.on = (event, handler) => { const out = origOn(event, handler); track(event); return out; };
  res.writeHead = (status) => { res.statusCode = status; return res; };
  res.write = (chunk) => {
    res.writes.push(String(chunk));
    const verdict = res.writes.length !== falseAt;
    if (!verdict) res.falseSignals += 1;
    return verdict;
  };
  res.end = (chunk) => { if (chunk) res.write(chunk); res.writableEnded = true; return res; };
  return res;
}

function framesOf(res) {
  return res.writes
    .join('')
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice(6));
}

function contentOf(res) {
  return framesOf(res)
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload))
    .map((frame) => frame.choices?.[0]?.delta?.content)
    .filter((c) => typeof c === 'string')
    .join('');
}

/** Let pending microtasks/macrotasks run without a wall-clock sleep. */
async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Wait for a condition that needs real I/O turns (loopback HTTP/2 RPCs). */
async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Cascade context whose fake client AWAITS its callback, exactly like the real
 * poll loop now does, and records how far it got.
 */
function cascadeContextFor({ text = 'alpha' } = {}) {
  const progress = { chunksProduced: 0, completed: 0, upstreamCalls: 0 };
  class FakeClient {
    async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
      progress.upstreamCalls += 1;
      if (opts.onChunk) {
        progress.chunksProduced += 1;
        await opts.onChunk({ text });
        // A second frame only after the first one settled: this is what makes the
        // producer's stop observable to the test.
        progress.chunksProduced += 1;
        await opts.onChunk({ text: '' });
        progress.completed += 1;
        return { text: '', toolCalls: [], usage: { inputTokens: 11, outputTokens: 5 } };
      }
      return Object.assign([{ text }], { toolCalls: [], usage: { inputTokens: 11, outputTokens: 5 } });
    }
  }
  const ctx = {
    waitForAccount(tried, _signal, _maxWait, modelKey) { return getApiKey(tried, modelKey); },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
  };
  Object.defineProperty(ctx, 'progress', { get: () => progress });
  return ctx;
}

beforeEach(() => {
  savedEnv = { devinConnect: process.env.DEVIN_CONNECT, devinOnly: process.env.DEVIN_ONLY };
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_ONLY;
  // Cascade poll timings: small enough to keep the test fast, large enough that no
  // warm-stall ceiling can fire mid-run.
  savedEnv.poll = process.env.CASCADE_POLL_INTERVAL_MS;
  savedEnv.grace = process.env.CASCADE_IDLE_GRACE_MS;
  savedEnv.maxWait = process.env.CASCADE_MAX_WAIT_MS;
  savedEnv.warmStall = process.env.CASCADE_WARM_STALL_MS;
  savedEnv.coldStall = process.env.CASCADE_COLD_STALL_BASE_MS;
  savedEnv.maxDrain = process.env.WINDSURFAPI_MAX_DRAIN_MS;
  process.env.CASCADE_POLL_INTERVAL_MS = '10';
  process.env.CASCADE_IDLE_GRACE_MS = '1';
  process.env.CASCADE_MAX_WAIT_MS = '3000';
  process.env.CASCADE_WARM_STALL_MS = '60000';
  process.env.CASCADE_COLD_STALL_BASE_MS = '60000';
});

afterEach(() => {
  while (createdIds.length) { try { removeAccount(createdIds.pop()); } catch {} }
  for (const [key, value] of Object.entries({
    DEVIN_CONNECT: savedEnv.devinConnect,
    DEVIN_ONLY: savedEnv.devinOnly,
    CASCADE_POLL_INTERVAL_MS: savedEnv.poll,
    CASCADE_IDLE_GRACE_MS: savedEnv.grace,
    CASCADE_MAX_WAIT_MS: savedEnv.maxWait,
    CASCADE_WARM_STALL_MS: savedEnv.warmStall,
    CASCADE_COLD_STALL_BASE_MS: savedEnv.coldStall,
    WINDSURFAPI_MAX_DRAIN_MS: savedEnv.maxDrain,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('SEED-C2: the Cascade stream honours writer backpressure', () => {
  it('stops at the already-accepted false frame and finishes once the drain fires', async () => {
    seed('c2-drain');
    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      ctx,
    );
    const res = controlledRes({ falseAt: 2 });   // role ok, first content frame false
    const done = result.handler(res);
    await settle();

    assert.equal(res.writes.length, 2, 'exactly the frames written before the false verdict');
    assert.equal(res.falseSignals, 1);
    assert.equal(ctx.progress.chunksProduced, 1, 'the producer is held at the frame it could not confirm');
    assert.equal(ctx.progress.completed, 0);
    assert.ok(!framesOf(res).includes('[DONE]'), 'no DONE while the socket is blocked');

    res.emit('drain');
    await done;

    const payloads = framesOf(res);
    assert.equal(payloads.filter((p) => p === '[DONE]').length, 1, 'exactly one DONE');
    assert.equal(
      payloads.filter((p) => p !== '[DONE]' && JSON.parse(p).choices?.[0]?.finish_reason).length,
      1,
      'exactly one terminal frame',
    );
    assert.equal(contentOf(res), 'alpha', 'the accepted frame is never resent and the tail still arrives');
    assert.equal(ctx.progress.completed, 1, 'the producer ran to completion after the drain');
    assert.equal(res.listenerPeak.drain, 1, 'at most one drain waiter');
    assert.equal(res.listenerCount('drain'), 0, 'the drain listener is detached after settling');
    assert.equal(res.listenerCount('close'), 1, 'only the lifecycle close listener remains');
  });

  it('holds the producer when the role frame itself reports backpressure', async () => {
    seed('c2-drain-role');
    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      ctx,
    );
    const res = controlledRes({ falseAt: 1 });
    const done = result.handler(res);
    await settle();

    assert.equal(res.writes.length, 1, 'nothing is produced behind the unconfirmed role frame');
    assert.equal(ctx.progress.chunksProduced, 1, 'the producer is held inside its first chunk, before the second');
    assert.equal(ctx.progress.completed, 0, 'the turn has not completed');

    res.emit('drain');
    await done;
    assert.equal(contentOf(res), 'alpha');
    assert.equal(framesOf(res).filter((p) => p === '[DONE]').length, 1);
  });

  it('holds the terminal/usage frames behind a drain', async () => {
    seed('c2-drain-terminal');
    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } },
      ctx,
    );
    const res = controlledRes({ falseAt: 2 });
    const done = result.handler(res);
    await settle();
    assert.equal(res.writes.length, 2);

    res.emit('drain');
    await done;

    const payloads = framesOf(res);
    const usageFrames = payloads.filter((p) => p !== '[DONE]' && Array.isArray(JSON.parse(p).choices) && JSON.parse(p).choices.length === 0);
    assert.equal(usageFrames.length, 1, 'the usage-only frame is emitted exactly once');
    assert.equal(payloads.at(-1), '[DONE]', 'DONE is the last byte on the wire');
    assert.equal(contentOf(res), 'alpha');
  });

  it('applies the same writer contract to the cache-replay frames', async () => {
    seed('c2-drain-cache');
    const callerKey = 'c2-key:user:replay';
    const ctx = cascadeContextFor();
    const body = { model: MODEL, messages: [{ role: 'user', content: 'replay me' }], stream: true };
    const first = await handleChatCompletions(body, { ...ctx, callerKey });
    const resFirst = controlledRes({ falseAt: 0 });
    await first.handler(resFirst);
    assert.equal(contentOf(resFirst), 'alpha');

    const second = await handleChatCompletions(body, { ...ctx, callerKey });
    const res = controlledRes({ falseAt: 2 });
    const done = second.handler(res);
    await settle();
    assert.equal(res.writes.length, 2, 'the replay stops at its false frame too');
    assert.equal(ctx.progress.upstreamCalls, 1, 'the replay never reached the producer');

    res.emit('drain');
    await done;
    assert.equal(contentOf(res), 'alpha');
    assert.equal(framesOf(res).filter((p) => p === '[DONE]').length, 1);
  });

  it('adds neither writes nor waiters while a drain is pending, however many heartbeat ticks pass', async () => {
    seed('c2-heartbeat');
    mock.timers.enable({ apis: ['setInterval'] });
    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      ctx,
    );
    const res = controlledRes({ falseAt: 2 });
    const done = result.handler(res);
    await settle();
    const writesWhilePending = res.writes.length;
    assert.equal(writesWhilePending, 2);

    for (let i = 0; i < 5; i += 1) mock.timers.tick(HEARTBEAT_MS);
    assert.equal(res.writes.length, writesWhilePending, 'a pending drain suppresses every heartbeat tick');
    assert.equal(res.listenerPeak.drain, 1, 'no waiter accumulates per tick');

    res.emit('drain');
    await done;
    assert.equal(res.listenerCount('drain'), 0);
  });

  it('holds the DONE sentinel behind a false write on the terminal frame', async () => {
    seed('c2-drain-finish');
    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      ctx,
    );
    // role(1) + content(2) + terminal(3) → the terminal frame is the first false.
    const res = controlledRes({ falseAt: 3 });
    const done = result.handler(res);
    await settle();

    assert.equal(res.writes.length, 3, 'the terminal frame is written once and not resent');
    assert.equal(res.falseSignals, 1);
    assert.ok(!framesOf(res).includes('[DONE]'), 'DONE waits for the terminal frame it closes');

    res.emit('drain');
    await done;
    assert.equal(framesOf(res).at(-1), '[DONE]');
    assert.equal(framesOf(res).filter((p) => p === '[DONE]').length, 1);
  });

  it('the failure-path error frame cannot overtake a blocked terminal frame', async () => {
    seed('c2-failure-finish');
    let calls = 0;
    class ThrowingClient {
      async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
        calls += 1;
        await opts.onChunk({ text: 'alpha' });
        const err = new Error('upstream stalled mid-answer');
        err.isModelError = true;
        err.kind = 'transient_stall';
        throw err;
      }
    }
    const ctx = {
      waitForAccount(tried, _signal, _maxWait, modelKey) { return getApiKey(tried, modelKey); },
      ensureLs: async () => {},
      getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
      WindsurfClient: ThrowingClient,
    };
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      ctx,
    );
    // role(1) + content(2) + error frame(3).
    const res = controlledRes({ falseAt: 3 });
    const done = result.handler(res);
    await settle();

    assert.equal(calls, 1, 'no retry once bytes are on the wire');
    assert.equal(res.writes.length, 3, 'the error frame is the last byte written');
    assert.ok(!framesOf(res).includes('[DONE]'), 'a failed stream never gets the clean-end sentinel');

    res.emit('drain');
    await done;
    assert.match(framesOf(res).at(-1), /"error"/, 'the stream terminates with the honest error frame');
  });

  it('aborts a half-open client at the max drain wait and returns the account', async () => {
    // A client that stops reading but keeps TCP open never emits 'drain'. The
    // bounded wait is what stops that from pinning the poll loop and the
    // account checkout for the life of the connection.
    const acct = seed('c2-half-open');
    process.env.WINDSURFAPI_MAX_DRAIN_MS = '40';
    const ctx = cascadeContextFor();
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
      ctx,
    );
    const res = controlledRes({ falseAt: 2 });   // never drains
    const done = result.handler(res);
    await settle();

    assert.equal(res.writes.length, 2, 'held at the refused frame');
    assert.equal(ctx.progress.chunksProduced, 1);
    assert.equal(ctx.progress.completed, 0);
    assert.equal(getAccountInternal(acct.id)._inflight, 1, 'the account is checked out while the turn is pinned');

    // No drain is ever emitted: the bounded wait has to end the turn.
    await done;

    assert.equal(ctx.progress.upstreamCalls, 1, 'no retry after a pinned stream');
    assert.equal(ctx.progress.chunksProduced, 1, 'the producer is not driven past the refused frame');
    assert.equal(ctx.progress.completed, 0, 'the turn never completes upstream');
    const payloads = framesOf(res);
    assert.ok(
      payloads.some((p) => p !== '[DONE]' && JSON.parse(p).error?.code === 'DRAIN_TIMEOUT'),
      'a terminal error is written while the socket still accepts bytes',
    );
    assert.ok(!payloads.includes('[DONE]'), 'no clean finish for a timed-out turn');
    assert.equal(res.listenerCount('drain'), 0, 'the drain listener is detached on timeout');
    assert.equal(getAccountInternal(acct.id)._inflight, 0, 'the account lease is returned');
  });

  it('a client close while waiting settles the stream without more bytes, retries or cache writes', async () => {
    seed('c2-close');
    const callerKey = 'c2-key:user:close';
    const ctx = cascadeContextFor();
    const body = { model: MODEL, messages: [{ role: 'user', content: 'close me' }], stream: true };
    const result = await handleChatCompletions(body, { ...ctx, callerKey });
    const res = controlledRes({ falseAt: 2 });
    const done = result.handler(res);
    await settle();
    assert.equal(res.writes.length, 2);

    // The client vanishes while the writer is blocked.
    res.emit('close');
    await done;

    assert.equal(res.writes.length, 2, 'no frame is written to a closed response');
    assert.ok(!framesOf(res).includes('[DONE]'), 'no DONE for a turn whose client is gone');
    assert.equal(ctx.progress.completed, 0, 'the producer is not driven to completion');

    // A closed turn must not seed the response cache: an identical follow-up must
    // still reach the producer rather than replay a turn nobody received.
    const after = cascadeContextFor();
    const follow = await handleChatCompletions(body, { ...after, callerKey });
    const resFollow = controlledRes({ falseAt: 0 });
    await follow.handler(resFollow);
    assert.equal(after.progress.upstreamCalls, 1, 'the aborted turn was not cached');
  });
});

// ── Producer side: the real poll loop against a scripted local LS ─────────────

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

function trajectoryInfoResponse(status) {
  const trajectory = Buffer.concat([
    writeStringField(1, 'trajectory-c2'),
    writeStringField(6, 'c2-cascade'),
  ]);
  return Buffer.concat([writeMessageField(1, trajectory), writeVarintField(2, status)]);
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

function runCommandStepResponse(command = 'printf HELLO') {
  const runCommandBody = writeStringField(23, command);
  const step = Buffer.concat([
    writeVarintField(1, 28),
    writeVarintField(4, 1),
    writeMessageField(28, runCommandBody),
  ]);
  return writeMessageField(1, step);
}

function readUrlContentDoneStepResponse() {
  const doc = Buffer.concat([
    writeStringField(2, 'Example Domain fetched body'),
    writeStringField(3, 'https://example.com/'),
    writeStringField(7, 'Example Domain summary'),
  ]);
  const body = Buffer.concat([
    writeStringField(1, 'https://example.com/'),
    writeMessageField(2, doc),
    writeStringField(3, 'https://example.com/'),
    writeVarintField(4, 123),
  ]);
  const step = Buffer.concat([
    writeVarintField(1, 40),
    writeVarintField(4, 3),
    writeMessageField(40, body),
  ]);
  return writeMessageField(1, step);
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => { terminateRpcWithStatus(stream); handler(stream, headers); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('SEED-C2: the real cascadeChat poll loop awaits its consumer', () => {
  it('consumes no second callback and issues no further RPC until the held callback settles', async () => {
    const rpcCounts = {};
    const callbacks = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let stepsServed = 0;
    let sawNativeCall = false;
    let sawNativeResult = false;

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        const method = String(headers[':path'] || '').split('/').pop();
        rpcCounts[method] = (rpcCounts[method] || 0) + 1;
        const respond = (payload) => {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(payload, headers));
        };
        if (method === 'StartCascade') return respond(startCascadeResponse('c2-cascade'));
        if (method === 'SendUserCascadeMessage') return respond(Buffer.alloc(0));
        if (method === 'GetCascadeTrajectorySteps') {
          stepsServed += 1;
          // First read: the text step. Later reads (the end-of-turn sweep): a
          // LONGER text so the sweep has a real top-up to emit, plus the native
          // tool call/result steps for the two native callback sites.
          if (stepsServed === 1) return respond(trajectoryStepsResponse('alpha'));
          return respond(Buffer.concat([
            trajectoryStepsResponse('alphabeta'),
            runCommandStepResponse(),
            readUrlContentDoneStepResponse(),
          ]));
        }
        if (method === 'GetCascadeTrajectory') return respond(trajectoryInfoResponse(1)); // IDLE
        return respond(Buffer.alloc(0));
      });
    }, async (port) => {
      const { WindsurfClient } = await import('../src/client.js');
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const pending = client.cascadeChat([{ role: 'user', content: 'go' }], 0, 'swe-1-6-slow', {
        nativeMode: true,
        nativeAllowlist: ['run_command', 'read_url_content'],
        onChunk: (chunk) => {
          callbacks.push(chunk);
          if (chunk.nativeToolCall) sawNativeCall = true;
          if (chunk.nativeToolResult) sawNativeResult = true;
          // Hold ONLY the first callback: everything after it must not happen
          // until the promise settles.
          if (callbacks.length === 1) return gate;
          return undefined;
        },
      });

      // Real transport turns: the fake LS answers actual HTTP/2 RPCs, so this
      // waits for the first callback instead of counting setImmediate turns.
      await waitFor(() => callbacks.length >= 1, { label: 'the first streamed callback' });
      await settle(12);
      const rpcsWhileHeld = { ...rpcCounts };
      assert.equal(callbacks.length, 1, 'the loop stops at the first callback it has not confirmed');
      assert.equal(rpcsWhileHeld.GetCascadeTrajectory || 0, 0, 'the status RPC is not issued while held');
      assert.equal(rpcsWhileHeld.GetCascadeTrajectorySteps, 1, 'no second steps poll while held');

      release();
      const result = await pending;

      assert.ok(callbacks.length >= 2, 'the loop resumes once the callback settles');
      assert.equal(rpcCounts.GetCascadeTrajectory >= 1, true, 'the status RPC follows the settled callback');
      // The real method returns the chunk array (with cascade metadata attached),
      // not an object with a `text` field.
      assert.ok(Array.isArray(result), 'the turn is returned as the chunk array');
      assert.equal(result.map((c) => c.text || '').join(''), 'alphabeta');
      // The turn is assembled from the same callbacks the test counted: the text
      // top-up from the final sweep plus whatever the native steps carried.
      assert.ok(
        callbacks.some((c) => c.text === 'alpha'),
        'the streamed text step was delivered through the callback',
      );
      assert.ok(
        callbacks.some((c) => c.text === 'beta'),
        'the end-of-turn top-up was delivered through the awaited callback',
      );
      assert.ok(sawNativeCall || sawNativeResult, 'a native cascade step reached the callback path');
    });
  });
});

// ── D8: the same contract through the two capture-response translators ────────
//
// The Cascade poll loop (src/client.js) awaits `onChunk`, and chat.js holds the
// chunk boundary on the bounded writer — but the Anthropic and Gemini translators
// wrote to the real socket themselves and their `createCaptureRes` returned a
// constant `true`, so the verdict never reached that writer. These arms drive the
// shipped translator seam with a producer that awaits exactly like the poll loop
// (the real loop's await is pinned by the describe above), so a regression here is
// the seam and not the fake.
describe('D8: the translated routes hold the Cascade producer on the real socket', () => {
  it('Messages: the chunk boundary is held at the refused frame and resumes on drain', async () => {
    seed('d8-messages');
    const ctx = cascadeContextFor();
    const result = await handleMessages(
      { model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    );
    assert.equal(result.stream, true);

    // message_start(1) + typed ping(2) + content_block_start(3) + the alpha
    // delta(4). The producer is held at the chunk boundary after this chunk.
    const res = controlledRes({ falseAt: 4 });
    const done = result.handler(res);
    await settle();

    assert.equal(res.writes.length, 4, `the translated stream stops at the false frame, got ${res.writes.length}`);
    assert.equal(res.falseSignals, 1);
    assert.equal(ctx.progress.chunksProduced, 1, 'the poll loop is held inside its first chunk');
    assert.equal(ctx.progress.completed, 0, 'the turn has not completed upstream');

    res.emit('drain');
    await done;

    const body = res.writes.join('');
    assert.equal(body.split('"text":"alpha"').length - 1, 1, 'the delta is delivered exactly once');
    assert.equal(body.split('event: message_stop').length - 1, 1, 'exactly one terminal event');
    assert.equal(ctx.progress.completed, 1, 'the producer ran to completion after the drain');
  });

  it('Gemini: the chunk boundary is held at the refused frame and resumes on drain', async () => {
    seed('d8-gemini');
    const ctx = cascadeContextFor();
    const result = await handleGemini(
      MODEL,
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      ctx,
      { stream: true, alt: null },
    );
    assert.equal(result.stream, true);

    // Frame 1 is the opening `[{...alpha...}` of the streamed JSON array.
    const res = controlledRes({ falseAt: 1 });
    const done = result.handler(res);
    await settle();

    assert.equal(res.writes.length, 1, `the translated stream stops at the false frame, got ${res.writes.length}`);
    assert.equal(res.falseSignals, 1);
    assert.equal(ctx.progress.chunksProduced, 1, 'the poll loop is held inside its first chunk');
    assert.equal(ctx.progress.completed, 0);

    res.emit('drain');
    await done;

    const frames = JSON.parse(res.writes.join(''));
    const text = frames
      .flatMap((f) => f.candidates || [])
      .flatMap((c) => c.content?.parts || [])
      .map((p) => p.text || '')
      .join('');
    assert.equal(text, 'alpha', 'the delta is delivered exactly once');
    assert.equal(frames.filter((f) => f.candidates?.[0]?.finishReason).length, 1, 'exactly one terminal frame');
    assert.equal(ctx.progress.completed, 1, 'the producer ran to completion after the drain');
  });

  it('a client close settles the translated wait without more bytes', async () => {
    seed('d8-close');
    const ctx = cascadeContextFor();
    const result = await handleMessages(
      { model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    );
    const res = controlledRes({ falseAt: 4 });
    const done = result.handler(res);
    await settle();
    assert.equal(res.writes.length, 4);

    res.emit('close');
    await done;

    assert.equal(res.writes.length, 4, 'no frame is written after the client is gone');
    assert.equal(ctx.progress.completed, 0, 'the producer is not driven to completion');
  });
});

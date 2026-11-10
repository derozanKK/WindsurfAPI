// D3 / V-13 follow-up — a reused cascade sends only the newest mapped tool
// round, and a fresh one sends all of them. The two rules are decided from the
// SAME live fact: whether the send continues an existing trajectory.
//
// MEASURED on the audited baseline (evidence/audit2/Cascade.md F1, reproduced):
// three observed Bash rounds produced 3 field-9 steps on a fresh cascade, 1 on
// an ordinary reuse — and still 1 after the pooled resume was rejected and the
// client restarted fresh, because chat.js had already sliced the list to the
// delta before calling cascadeChat. The rebuilt prompt carried the full text
// history but the replacement trajectory was blind to every earlier
// observation: the model was asked to continue work whose tool results it could
// no longer see.
//
// The contract pinned here:
//   * fresh cascade            → all observed mapped rounds (3);
//   * ordinary reuse           → the newest pending round only (1);
//   * expired resume → fresh   → the retry carries all three again.
//
// The seam is the real `cascadeChat` against a fake language server: the numbers
// are read from the actual SendUserCascadeMessage payload (field 9).

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { endOfStreamEnvelope, unwrapRequest, wrapEnvelope } from '../src/connect.js';
import { getAllFields, parseFields, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';
import { buildNativeToolHistory } from '../src/cascade-native-bridge.js';
import { isConnectContentType, terminateRpcWithStatus } from './helpers/fake-grpc-trailers.mjs';

const MODEL_UID = 'claude-sonnet-4-6';

function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

function stripGrpcFrame(buf) {
  if (buf.length >= 5 && buf[0] === 0) {
    const msgLen = buf.readUInt32BE(1);
    if (buf.length >= 5 + msgLen) return buf.subarray(5, 5 + msgLen);
  }
  return buf;
}

function extractGrpcFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const compressed = buf[offset];
    const msgLen = buf.readUInt32BE(offset + 1);
    if (compressed !== 0 || offset + 5 + msgLen > buf.length) break;
    frames.push(buf.subarray(offset + 5, offset + 5 + msgLen));
    offset += 5 + msgLen;
  }
  return frames;
}

function responseBody(payload, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function errorBody(message, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) {
    const body = Buffer.from(JSON.stringify({ error: { message } }));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 0x02;
    frame.writeUInt32BE(body.length, 1);
    body.copy(frame, 5);
    return { body: frame, trailers: null };
  }
  return { body: Buffer.alloc(0), trailers: { 'grpc-status': '5', 'grpc-message': encodeURIComponent(message) } };
}

function requestPayload(body, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) return unwrapRequest(body, headers);
  const frames = extractGrpcFrames(body);
  return frames.length ? Buffer.concat(frames) : stripGrpcFrame(body);
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

/** Count the additional_steps (field 9) the client put on the wire. */
function additionalStepCount(payload) {
  return getAllFields(parseFields(payload), 9).filter(f => f.wireType === 2).length;
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
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

const ENV = {
  CASCADE_POLL_INTERVAL_MS: '10',
  CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '500',
  CASCADE_COLD_STALL_BASE_MS: '500',
  CASCADE_WARM_STALL_MS: '500',
  GRPC_PROTOCOL: 'connect',
};

// The fake LS answers instantly; these keep the real poll loop from waiting on
// production-scale intervals. Applied per test (not restored between them) so
// every arm runs under the same timing.
const savedEnv = new Map();
beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Three observed Bash rounds; the newest one is the trailing pending round. */
const ROUNDS = [
  { role: 'user', content: 'run the three probes' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"printf one"}' } },
  ] },
  { role: 'tool', tool_call_id: 'call_1', content: 'one' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_2', type: 'function', function: { name: 'Bash', arguments: '{"command":"printf two"}' } },
  ] },
  { role: 'tool', tool_call_id: 'call_2', content: 'two' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_3', type: 'function', function: { name: 'Bash', arguments: '{"command":"printf three"}' } },
  ] },
  { role: 'tool', tool_call_id: 'call_3', content: 'three' },
];
// The history ends on the newest tool result (the shape a client sends when it
// hands back what the planner asked for), which is exactly when a reused
// trajectory only lacks that last round.

/** What chat.js threads to cascadeChat: the full list plus where the delta starts. */
function nativeHistory() {
  const { steps, deltaStart } = buildNativeToolHistory(ROUNDS, { reuse: false });
  return { additionalSteps: steps, additionalStepsFrom: deltaStart };
}

function liveServer({ expireFirstSend = false } = {}) {
  const sends = [];
  const state = { startCount: 0 };
  const handler = (stream, headers) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const payload = requestPayload(Buffer.concat(chunks), headers);
      const method = String(headers[':path'] || '').split('/').pop();
      const respond = (body) => {
        stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
        stream.end(responseBody(body, headers));
      };
      if (method === 'StartCascade') {
        state.startCount++;
        respond(startCascadeResponse('fresh-' + state.startCount));
        return;
      }
      if (method === 'SendUserCascadeMessage') {
        sends.push(additionalStepCount(payload));
        if (expireFirstSend && sends.length === 1) {
          const err = errorBody('not_found: cascade trajectory has been expired by ttl', headers);
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          if (err.trailers) stream.additionalHeaders(err.trailers);
          stream.end(err.body);
          return;
        }
        respond(Buffer.alloc(0));
        return;
      }
      if (method === 'GetCascadeTrajectorySteps') {
        respond(trajectoryStepsResponse(sends.length === 1 ? 'first-answer' : 'recovered-answer'));
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        respond(trajectoryStatusResponse(1));
        return;
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        respond(Buffer.alloc(0));
        return;
      }
      stream.respond({ ':status': 404 });
      stream.end();
    });
  };
  return { handler, sends, state };
}

async function runTurn({ reuseEntry = null, expireFirstSend = false } = {}) {
  const fixture = liveServer({ expireFirstSend });
  let result;
  await withFakeLanguageServer(fixture.handler, async (port) => {
    const { WindsurfClient } = await import('../src/client.js');
    const client = new WindsurfClient('test-api-key', port, 'csrf-token');
    const { additionalSteps, additionalStepsFrom } = nativeHistory();
    try {
      result = await client.cascadeChat(ROUNDS, 0, MODEL_UID, {
        nativeMode: true,
        nativeAllowlist: ['run_command'],
        additionalSteps,
        additionalStepsFrom,
        reuseEntry: reuseEntry
          ? { ...reuseEntry, lsPort: port, apiKey: 'test-api-key' }
          : null,
      });
    } catch (err) {
      result = err;
    }
  });
  return { ...fixture, result };
}

describe('D3: mapped tool history follows the live trajectory, not the caller-side delta', () => {
  it('the history itself carries three observed rounds and a delta start of two', () => {
    const { additionalSteps, additionalStepsFrom } = nativeHistory();
    assert.equal(additionalSteps.length, 3, 'three observed Bash rounds are encodable');
    assert.equal(additionalStepsFrom, 2, 'only the newest pending round is newer than a reused trajectory');
    assert.equal(buildNativeToolHistory(ROUNDS, { reuse: true }).steps.length, 1,
      'the reused-trajectory encoding is the delta');
  });

  it('control: a fresh cascade sends all three observed rounds', async () => {
    const { sends, result } = await runTurn();
    assert.ok(!(result instanceof Error), `turn failed: ${result?.message}`);
    assert.deepEqual(sends, [3], 'a fresh trajectory has no earlier observations');
  });

  it('control: an ordinary reuse sends only the newest round', async () => {
    const { sends, result } = await runTurn({
      reuseEntry: { cascadeId: 'live-cascade', sessionId: 'live-session', stepOffset: 3, generatorOffset: 1 },
    });
    assert.ok(!(result instanceof Error), `turn failed: ${result?.message}`);
    assert.deepEqual(sends, [1], 'the resumed trajectory already holds rounds 1 and 2');
  });

  it('a rejected resume re-sends the full history on the fresh restart', async () => {
    const { sends, state, result } = await runTurn({
      reuseEntry: { cascadeId: 'expired-cascade', sessionId: 'expired-session', stepOffset: 3, generatorOffset: 1 },
      expireFirstSend: true,
    });
    assert.ok(!(result instanceof Error), `turn failed: ${result?.message}`);
    assert.equal(sends.length, 2, 'the expired send is retried once');
    assert.equal(sends[0], 1, 'the first send is a continuation of the dead trajectory: delta only');
    assert.equal(sends[1], 3, 'the replacement trajectory has no history: every observed round must ride again');
    assert.equal(state.startCount, 1, 'recovery opened exactly one fresh cascade');
    assert.match(result.map(c => c.text || '').join(''), /recovered-answer/);
  });
});

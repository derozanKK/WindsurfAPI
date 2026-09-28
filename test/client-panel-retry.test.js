import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'http2';
import { endOfStreamEnvelope, unwrapRequest, wrapEnvelope } from '../src/connect.js';
import { getField, parseFields, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';

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
  if (contentType.includes('application/connect+proto')) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function errorBody(message, headers) {
  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('application/connect+proto')) {
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
  if (contentType.includes('application/connect+proto')) {
    return unwrapRequest(body, headers);
  }
  const frames = extractGrpcFrames(body);
  return frames.length ? Buffer.concat(frames) : stripGrpcFrame(body);
}

function readStepOffset(payload) {
  const fields = parseFields(payload);
  const field = getField(fields, 2, 0);
  return field ? Number(field.value) : 0;
}

function startCascadeResponse(cascadeId) {
  return writeStringField(1, cascadeId);
}

function trajectoryStatusResponse(status) {
  return writeVarintField(2, status);
}

function trajectoryInfoResponse(status, trajectoryId = 'trajectory-test', cascadeId = 'cascade-test') {
  const trajectory = Buffer.concat([
    writeStringField(1, trajectoryId),
    writeStringField(6, cascadeId),
  ]);
  return Buffer.concat([
    writeMessageField(1, trajectory),
    writeVarintField(2, status),
  ]);
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

function pendingReadUrlStepResponse() {
  const spec = Buffer.concat([
    writeStringField(1, 'https://example.com/'),
    writeStringField(2, 'https://example.com'),
  ]);
  const body = Buffer.concat([
    writeStringField(1, 'https://example.com/'),
    writeVarintField(7, 8),
  ]);
  const step = Buffer.concat([
    writeVarintField(1, 40),
    writeVarintField(4, 9),
    writeMessageField(56, writeMessageField(14, spec)),
    writeMessageField(40, body),
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

function readUrlContentDoneWithEchoStepResponse() {
  const spec = Buffer.concat([
    writeStringField(1, 'https://example.com/'),
    writeStringField(2, 'https://example.com'),
  ]);
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
    writeVarintField(7, 8),
  ]);
  const step = Buffer.concat([
    writeVarintField(1, 31),
    writeVarintField(4, 3),
    writeMessageField(56, writeMessageField(14, spec)),
    writeMessageField(40, body),
  ]);
  return writeMessageField(1, step);
}

function setEnvForTest(values) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', session => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', handler);
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

async function countPendingReadUrlApprovals({ nativeAllowlist = ['read_url_content'] } = {}) {
  let approvals = 0;
  await withFakeLanguageServer((stream, headers) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const method = String(headers[':path'] || '').split('/').pop();
      if (method === 'StartCascade') {
        stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
        stream.end(responseBody(startCascadeResponse('webfetch-cascade'), headers));
        return;
      }
      if (method === 'SendUserCascadeMessage') {
        stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
        stream.end(responseBody(Buffer.alloc(0), headers));
        return;
      }
      if (method === 'GetCascadeTrajectorySteps') {
        stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
        stream.end(responseBody(pendingReadUrlStepResponse(), headers));
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
        stream.end(responseBody(trajectoryInfoResponse(2, 'trajectory-webfetch', 'webfetch-cascade'), headers));
        return;
      }
      if (method === 'HandleCascadeUserInteraction') {
        approvals++;
        stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
        stream.end(responseBody(Buffer.alloc(0), headers));
        return;
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
        stream.end(responseBody(Buffer.alloc(0), headers));
        return;
      }
      stream.respond({ ':status': 404 });
      stream.end();
    });
  }, async (port) => {
    const { WindsurfClient } = await import('../src/client.js');
    const client = new WindsurfClient('test-api-key', port, 'csrf-token');
    try {
      await client.cascadeChat([{ role: 'user', content: 'fetch it' }], 0, 'claude-4.5-haiku', {
        nativeMode: true,
        nativeAllowlist,
      });
    } catch (err) {
      if (err?.kind !== 'transient_stall') throw err;
    }
  });
  return approvals;
}

describe('WindsurfClient cascade panel retry', () => {
  it('resets trajectory offsets after re-warming to a fresh cascade', async () => {
    process.env.CASCADE_POLL_INTERVAL_MS = '10';
    process.env.CASCADE_IDLE_GRACE_MS = '1';
    process.env.CASCADE_MAX_WAIT_MS = '500';
    process.env.CASCADE_COLD_STALL_BASE_MS = '500';
    process.env.CASCADE_WARM_STALL_MS = '500';
    process.env.GRPC_PROTOCOL = 'connect';

    const observedStepOffsets = [];
    let sendCount = 0;

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const path = String(headers[':path'] || '');
        const payload = requestPayload(Buffer.concat(chunks), headers);
        const method = path.split('/').pop();

        if (method === 'StartCascade') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(startCascadeResponse('fresh-cascade'), headers));
          return;
        }

        if (method === 'SendUserCascadeMessage') {
          sendCount++;
          if (sendCount === 1) {
            const err = errorBody('panel state not found', headers);
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            if (err.trailers) stream.additionalHeaders(err.trailers);
            stream.end(err.body);
            return;
          }
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        if (method === 'GetCascadeTrajectorySteps') {
          const offset = readStepOffset(payload);
          observedStepOffsets.push(offset);
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStepsResponse(offset === 0 ? 'fresh-output' : ''), headers));
          return;
        }

        if (method === 'GetCascadeTrajectory') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStatusResponse(1), headers));
          return;
        }

        if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        stream.respond({ ':status': 404 });
        stream.end();
      });
    }, async (port) => {
      const { WindsurfClient } = await import('../src/client.js');
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat([
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'continue' },
      ], 0, 'claude-sonnet-4-6', {
        reuseEntry: {
          cascadeId: 'expired-cascade',
          sessionId: 'expired-session',
          lsPort: port,
          apiKey: 'test-api-key',
          stepOffset: 5,
          generatorOffset: 5,
        },
      });

      const text = chunks.map(c => c.text || '').join('');
      assert.equal(sendCount, 2);
      assert.ok(observedStepOffsets.length > 0);
      assert.equal(observedStepOffsets[0], 0);
      assert.match(text, /fresh-output/);
    });
  });

  it('v2.0.25 HIGH-2: cascade not_found triggers fresh fallback and marks reuse entry invalidated', async () => {
    process.env.CASCADE_POLL_INTERVAL_MS = '10';
    process.env.CASCADE_IDLE_GRACE_MS = '1';
    process.env.CASCADE_MAX_WAIT_MS = '500';
    process.env.CASCADE_COLD_STALL_BASE_MS = '500';
    process.env.CASCADE_WARM_STALL_MS = '500';
    process.env.GRPC_PROTOCOL = 'connect';

    let startCount = 0;
    let sendCount = 0;
    let observedFreshCascadeId = null;

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const path = String(headers[':path'] || '');
        const payload = requestPayload(Buffer.concat(chunks), headers);
        const method = path.split('/').pop();

        if (method === 'StartCascade') {
          startCount++;
          observedFreshCascadeId = 'fresh-' + startCount;
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(startCascadeResponse(observedFreshCascadeId), headers));
          return;
        }

        if (method === 'SendUserCascadeMessage') {
          sendCount++;
          if (sendCount === 1) {
            // Simulate the upstream telling us the cascade we tried to
            // resume is gone — different message text from "panel state
            // not found" so we can prove isExpiredCascade triggers the
            // same recovery and not isPanelMissing.
            const err = errorBody('not_found: cascade trajectory has been expired by ttl', headers);
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            if (err.trailers) stream.additionalHeaders(err.trailers);
            stream.end(err.body);
            return;
          }
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        if (method === 'GetCascadeTrajectorySteps') {
          const offset = readStepOffset(payload);
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStepsResponse(offset === 0 ? 'recovered-output' : ''), headers));
          return;
        }

        if (method === 'GetCascadeTrajectory') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStatusResponse(1), headers));
          return;
        }

        if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        stream.respond({ ':status': 404 });
        stream.end();
      });
    }, async (port) => {
      const { WindsurfClient } = await import('../src/client.js');
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat([
        { role: 'user', content: 'turn1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'turn2' },
      ], 0, 'claude-sonnet-4-6', {
        reuseEntry: {
          cascadeId: 'long-dead-cascade',
          sessionId: 'long-dead-session',
          lsPort: port,
          apiKey: 'test-api-key',
          stepOffset: 5,
          generatorOffset: 5,
        },
      });

      // Recovery path actually fired: client called StartCascade after the
      // expired-send and got a fresh cascadeId on the trailing send.
      assert.equal(sendCount, 2, 'should retry send once after recovery');
      assert.equal(startCount, 1, 'recovery path should issue exactly one fresh StartCascade');
      assert.equal(chunks.cascadeId, observedFreshCascadeId, 'final cascadeId must be the fresh one, not the dead reuseEntry.cascadeId');
      assert.notEqual(chunks.cascadeId, 'long-dead-cascade');
      assert.equal(chunks.reuseEntryInvalidated, true, 'should signal the caller to skip restoring the dead entry');
      assert.match(chunks.map(c => c.text || '').join(''), /recovered-output/);
    });
  });

  it('GPT-08: a rebuilt history reports the coverage of what was actually sent', async () => {
    // An independent audit (2026-09-22) found the recovery path reporting full coverage
    // for a truncated history: the fresh branch updated historyCoverage, the resume
    // rebuild truncated the same history without updating it, and the stale value was
    // returned verbatim. In THIS fixture both paths open with zero bytes of system
    // prompt, so the same history and budget must give the same answer — that is a
    // property of this input, not a general rule: with a system prompt present the fresh
    // path counts its length and the rebuilt path does not, so the two coverage values
    // legitimately differ. See test/review-history-coverage.test.js, which pins each
    // path against the turns actually present in the encoded request.
    const budget = 1024;
    const prevBudget = process.env.CASCADE_MAX_HISTORY_BYTES;
    process.env.CASCADE_MAX_HISTORY_BYTES = String(budget);
    process.env.CASCADE_POLL_INTERVAL_MS = '10';
    process.env.CASCADE_IDLE_GRACE_MS = '1';
    process.env.CASCADE_MAX_WAIT_MS = '1500';
    process.env.CASCADE_COLD_STALL_BASE_MS = '500';
    process.env.CASCADE_WARM_STALL_MS = '500';
    process.env.GRPC_PROTOCOL = 'connect';

    // Five turns, the first three far larger than the whole budget: with 1024 bytes
    // only the newest assistant turn and the closing user message can fit, so the
    // oldest three are dropped no matter which path builds the prompt.
    const big = 'x'.repeat(2048);
    const history = [
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: big },
      { role: 'assistant', content: 'small-reply' },
      { role: 'user', content: 'final question' },
    ];

    const run = ({ resume }) => {
      let sendCount = 0;
      return withFakeLanguageServer((stream, headers) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const path = String(headers[':path'] || '');
          const method = path.split('/').pop();
          if (method === 'StartCascade') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(startCascadeResponse('cascade-' + (resume ? 'recovered' : 'fresh')), headers));
            return;
          }
          if (method === 'SendUserCascadeMessage') {
            sendCount++;
            if (resume && sendCount === 1) {
              const err = errorBody('not_found: cascade trajectory has been expired by ttl', headers);
              stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
              if (err.trailers) stream.additionalHeaders(err.trailers);
              stream.end(err.body);
              return;
            }
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }
          if (method === 'GetCascadeTrajectorySteps') {
            const offset = readStepOffset(requestPayload(Buffer.concat(chunks), headers));
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(trajectoryStepsResponse(offset === 0 ? 'final answer' : ''), headers));
            return;
          }
          if (method === 'GetCascadeTrajectory') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(trajectoryStatusResponse(1), headers));
            return;
          }
          if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }
          stream.respond({ ':status': 404 });
          stream.end();
        });
      }, async (port) => {
        const { WindsurfClient } = await import('../src/client.js');
        const client = new WindsurfClient('test-api-key', port, 'csrf-token');
        const chunks = await client.cascadeChat(history.map(m => ({ ...m })), 0, 'claude-sonnet-4-6', {
          reuseEntry: resume
            ? {
              cascadeId: 'expired-cascade', sessionId: 'expired-session', lsPort: port,
              apiKey: 'test-api-key', stepOffset: 5, generatorOffset: 5,
            }
            : null,
        });
        if (resume) assert.equal(sendCount, 2, 'the fixture must actually take the recovery path');
        return chunks;
      });
    };

    try {
      const fresh = await run({ resume: false });
      const recovered = await run({ resume: true });

      assert.equal(fresh.historyCoverage.totalTurns, 5);
      assert.equal(fresh.historyCoverage.droppedTurnCount, 3, 'the fixture must truncate the three oversized turns');
      assert.equal(fresh.historyCoverage.firstIncludedTurnIndex, 3);
      assert.deepEqual(
        recovered.historyCoverage,
        fresh.historyCoverage,
        'with no system prompt both paths send the same truncated history, so their coverage must agree',
      );
    } finally {
      if (prevBudget === undefined) delete process.env.CASCADE_MAX_HISTORY_BYTES;
      else process.env.CASCADE_MAX_HISTORY_BYTES = prevBudget;
    }
  });

  it('native bridge returns after first cascade-native tool call instead of waiting for remote execution', async () => {
    process.env.CASCADE_POLL_INTERVAL_MS = '10';
    process.env.CASCADE_IDLE_GRACE_MS = '1';
    process.env.CASCADE_MAX_WAIT_MS = '500';
    process.env.CASCADE_COLD_STALL_BASE_MS = '500';
    process.env.CASCADE_WARM_STALL_MS = '500';
    process.env.GRPC_PROTOCOL = 'connect';

    let statusPolls = 0;
    let stepPolls = 0;
    const streamed = [];

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const path = String(headers[':path'] || '');
        const method = path.split('/').pop();

        if (method === 'StartCascade') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(startCascadeResponse('native-cascade'), headers));
          return;
        }

        if (method === 'SendUserCascadeMessage') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        if (method === 'GetCascadeTrajectorySteps') {
          stepPolls++;
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(runCommandStepResponse('printf HELLO'), headers));
          return;
        }

        if (method === 'GetCascadeTrajectory') {
          statusPolls++;
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStatusResponse(2), headers));
          return;
        }

        if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        stream.respond({ ':status': 404 });
        stream.end();
      });
    }, async (port) => {
      const { WindsurfClient } = await import('../src/client.js');
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat([{ role: 'user', content: 'run it' }], 0, 'claude-4.5-haiku', {
        nativeMode: true,
        nativeAllowlist: ['run_command'],
        onChunk: c => streamed.push(c),
      });

      assert.equal(stepPolls, 1);
      assert.equal(statusPolls, 0, 'native tool call should end before status polling waits for remote execution');
      assert.equal(chunks.toolCalls.length, 1);
      assert.equal(chunks.toolCalls[0].name, 'run_command');
      assert.match(chunks.toolCalls[0].argumentsJson, /printf HELLO/);
      assert.equal(streamed.filter(c => c.nativeToolCall).length, 1);
    });
  });

  it('native bridge protocol lab can poll after a cascade-native tool call', async () => {
    const restoreEnv = setEnvForTest({
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL: '1',
      CASCADE_POLL_INTERVAL_MS: '10',
      CASCADE_IDLE_GRACE_MS: '1',
      CASCADE_MAX_WAIT_MS: '700',
      CASCADE_COLD_STALL_BASE_MS: '700',
      CASCADE_WARM_STALL_MS: '700',
      GRPC_PROTOCOL: 'connect',
    });

    let statusPolls = 0;
    let stepPolls = 0;
    const streamed = [];

    try {
      await withFakeLanguageServer((stream, headers) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const path = String(headers[':path'] || '');
          const method = path.split('/').pop();

          if (method === 'StartCascade') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(startCascadeResponse('native-cascade-lab'), headers));
            return;
          }

          if (method === 'SendUserCascadeMessage') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }

          if (method === 'GetCascadeTrajectorySteps') {
            stepPolls++;
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(runCommandStepResponse('printf LAB'), headers));
            return;
          }

          if (method === 'GetCascadeTrajectory') {
            statusPolls++;
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(trajectoryStatusResponse(1), headers));
            return;
          }

          if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }

          stream.respond({ ':status': 404 });
          stream.end();
        });
      }, async (port) => {
        const { WindsurfClient } = await import('../src/client.js');
        const client = new WindsurfClient('test-api-key', port, 'csrf-token');
        const chunks = await client.cascadeChat([{ role: 'user', content: 'run it' }], 0, 'claude-4.5-haiku', {
          nativeMode: true,
          nativeAllowlist: ['run_command'],
          onChunk: c => streamed.push(c),
        });

        assert.ok(stepPolls > 1, 'lab mode should keep polling trajectory steps after the native tool call');
        assert.ok(statusPolls > 0, 'lab mode should poll trajectory status instead of returning immediately');
        assert.equal(chunks.toolCalls.length, 1);
        assert.equal(chunks.toolCalls[0].name, 'run_command');
        assert.match(chunks.toolCalls[0].argumentsJson, /printf LAB/);
        assert.equal(streamed.filter(c => c.nativeToolCall).length, 1);
      });
    } finally {
      restoreEnv();
    }
  });

  it('does not auto-approve WebFetch requested interactions unless explicitly enabled', async () => {
    const restoreEnv = setEnvForTest({
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE: undefined,
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE_ORIGINS: undefined,
      CASCADE_POLL_INTERVAL_MS: '10',
      CASCADE_IDLE_GRACE_MS: '1',
      CASCADE_MAX_WAIT_MS: '80',
      CASCADE_COLD_STALL_BASE_MS: '80',
      GRPC_PROTOCOL: 'connect',
    });
    try {
      const approvals = await countPendingReadUrlApprovals();
      assert.equal(approvals, 0);
    } finally {
      restoreEnv();
    }
  });

  it('does not auto-approve WebFetch requested interactions when origin is not allowed', async () => {
    const restoreEnv = setEnvForTest({
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE: '1',
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE_ORIGINS: 'https://other.example',
      CASCADE_POLL_INTERVAL_MS: '10',
      CASCADE_IDLE_GRACE_MS: '1',
      CASCADE_MAX_WAIT_MS: '80',
      CASCADE_COLD_STALL_BASE_MS: '80',
      GRPC_PROTOCOL: 'connect',
    });
    try {
      const approvals = await countPendingReadUrlApprovals();
      assert.equal(approvals, 0);
    } finally {
      restoreEnv();
    }
  });

  it('does not auto-approve WebFetch requested interactions outside the read_url_content native allowlist', async () => {
    const restoreEnv = setEnvForTest({
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE: '1',
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE_ORIGINS: 'https://example.com',
      CASCADE_POLL_INTERVAL_MS: '10',
      CASCADE_IDLE_GRACE_MS: '1',
      CASCADE_MAX_WAIT_MS: '80',
      CASCADE_COLD_STALL_BASE_MS: '80',
      GRPC_PROTOCOL: 'connect',
    });
    try {
      const approvals = await countPendingReadUrlApprovals({ nativeAllowlist: ['run_command'] });
      assert.equal(approvals, 0);
    } finally {
      restoreEnv();
    }
  });

  it('lab auto-approves allowed WebFetch requested interaction and waits for completed content', async () => {
    const restoreEnv = setEnvForTest({
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE: '1',
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE_ORIGINS: 'https://example.com',
      CASCADE_POLL_INTERVAL_MS: '10',
      CASCADE_IDLE_GRACE_MS: '1',
      CASCADE_MAX_WAIT_MS: '500',
      CASCADE_COLD_STALL_BASE_MS: '500',
      GRPC_PROTOCOL: 'connect',
    });

    let approvals = 0;
    let approvedPayload = null;
    let approved = false;
    try {
      await withFakeLanguageServer((stream, headers) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const method = String(headers[':path'] || '').split('/').pop();
          const payload = requestPayload(Buffer.concat(chunks), headers);
          if (method === 'StartCascade') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(startCascadeResponse('webfetch-cascade'), headers));
            return;
          }
          if (method === 'SendUserCascadeMessage') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }
          if (method === 'GetCascadeTrajectorySteps') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(approved ? readUrlContentDoneStepResponse() : pendingReadUrlStepResponse(), headers));
            return;
          }
          if (method === 'GetCascadeTrajectory') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(trajectoryInfoResponse(approved ? 1 : 2, 'trajectory-webfetch', 'webfetch-cascade'), headers));
            return;
          }
          if (method === 'HandleCascadeUserInteraction') {
            approvals++;
            approved = true;
            approvedPayload = payload;
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }
          if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }
          stream.respond({ ':status': 404 });
          stream.end();
        });
      }, async (port) => {
        const { WindsurfClient } = await import('../src/client.js');
        const client = new WindsurfClient('test-api-key', port, 'csrf-token');
        const chunks = await client.cascadeChat([{ role: 'user', content: 'fetch it' }], 0, 'claude-4.5-haiku', {
          nativeMode: true,
          nativeAllowlist: ['read_url_content'],
        });
        assert.equal(chunks.toolCalls.length, 1);
        assert.equal(chunks.toolCalls[0].name, 'read_url_content');
        assert.match(chunks.toolCalls[0].argumentsJson, /https:\/\/example\.com\//);
        assert.equal(chunks.toolCalls[0].result, 'Example Domain fetched body');
      });
      assert.equal(approvals, 1);
      const top = parseFields(approvedPayload);
      assert.equal(getField(top, 1, 2).value.toString('utf8'), 'webfetch-cascade');
      const interaction = parseFields(getField(top, 2, 2).value);
      assert.equal(getField(interaction, 1, 2).value.toString('utf8'), 'trajectory-webfetch');
      assert.equal(getField(interaction, 2, 0).value, 0);
      const readUrl = parseFields(getField(interaction, 15, 2).value);
      assert.equal(getField(readUrl, 1, 0).value, 1);
      assert.equal(getField(readUrl, 2, 2).value.toString('utf8'), 'https://example.com/');
      assert.equal(getField(readUrl, 3, 2).value.toString('utf8'), 'https://example.com');
    } finally {
      restoreEnv();
    }
  });

  it('does not treat completed WebFetch with requested interaction echo as a proposal', async () => {
    const restoreEnv = setEnvForTest({
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE: '1',
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE_ORIGINS: 'https://example.com',
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL: '1',
      CASCADE_POLL_INTERVAL_MS: '10',
      CASCADE_IDLE_GRACE_MS: '1',
      CASCADE_MAX_WAIT_MS: '500',
      CASCADE_COLD_STALL_BASE_MS: '500',
      GRPC_PROTOCOL: 'connect',
    });

    let approvals = 0;
    const streamed = [];
    try {
      await withFakeLanguageServer((stream, headers) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const method = String(headers[':path'] || '').split('/').pop();
          if (method === 'StartCascade') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(startCascadeResponse('webfetch-completed-cascade'), headers));
            return;
          }
          if (method === 'SendUserCascadeMessage') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }
          if (method === 'GetCascadeTrajectorySteps') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.concat([
              readUrlContentDoneWithEchoStepResponse(),
              trajectoryStepsResponse('Natural answer using Example Domain.'),
            ]), headers));
            return;
          }
          if (method === 'HandleCascadeUserInteraction') {
            approvals++;
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }
          if (method === 'GetCascadeTrajectory') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(trajectoryInfoResponse(1, 'trajectory-webfetch', 'webfetch-completed-cascade'), headers));
            return;
          }
          if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }
          stream.respond({ ':status': 404 });
          stream.end();
        });
      }, async (port) => {
        const { WindsurfClient } = await import('../src/client.js');
        const client = new WindsurfClient('test-api-key', port, 'csrf-token');
        const chunks = await client.cascadeChat([{ role: 'user', content: 'fetch it' }], 0, 'claude-4.5-haiku', {
          nativeMode: true,
          nativeAllowlist: ['read_url_content'],
          onChunk: c => streamed.push(c),
        });
        assert.equal(approvals, 0);
        assert.equal(chunks.toolCalls.length, 1);
        assert.equal(chunks.toolCalls[0].name, 'read_url_content');
        assert.equal(chunks.toolCalls[0].result, 'Example Domain fetched body');
        assert.equal(chunks.toolCalls[0].hasWebDocument, true);
        assert.equal(streamed.filter(c => c.nativeToolCall).length, 0);
        assert.equal(streamed.filter(c => c.nativeToolResult).length, 1);
        assert.match(chunks.map(c => c.text || '').join(''), /Natural answer using Example Domain/);
      });
    } finally {
      restoreEnv();
    }
  });
});

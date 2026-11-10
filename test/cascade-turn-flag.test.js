// The CascadeTurn extraction must be invisible when its flag is off.
//
// This drives the real cascadeChat against a scripted loopback LS whose
// planner step grows in place ("A" → "AB") and whose second step arrives
// later. Both flag positions must produce the same text, the same absolute
// stepOffset, and the same number of upstream step reads. The flag-on result
// additionally carries the producer snapshot (per-step cursors + window).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';

Object.assign(process.env, {
  GRPC_PROTOCOL: 'connect',
  CASCADE_POLL_INTERVAL_MS: '10',
  CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '2000',
  CASCADE_COLD_STALL_BASE_MS: '2000',
  CASCADE_WARM_STALL_MS: '2000',
  WINDSURFAPI_USER_JWT: '0',
});
delete process.env.DEVIN_CONNECT;
delete process.env.DEVIN_ONLY;
delete process.env.WINDSURFAPI_CASCADE_TURN;

const { WindsurfClient } = await import('../src/client.js');
const { unwrapRequest, wrapEnvelope, endOfStreamEnvelope } = await import('../src/connect.js');
const {
  getField, parseFields, writeMessageField, writeStringField, writeVarintField,
} = await import('../src/proto.js');

function plannerStep(text, status = 3) {
  return Buffer.concat([
    writeVarintField(1, 15), // CORTEX_STEP_TYPE_PLANNER_RESPONSE
    writeVarintField(4, status),
    writeMessageField(20, writeStringField(1, text)),
  ]);
}

function rawStepsResponse(steps) {
  return Buffer.concat(steps.map(step => writeMessageField(1, step)));
}

function readStepOffset(payload) {
  const field = getField(parseFields(payload), 2, 0);
  return field ? Number(field.value) : 0;
}

function respond(stream, headers, body) {
  stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/connect+proto' });
  stream.end(Buffer.concat([wrapEnvelope(body, { compress: false }), endOfStreamEnvelope()]));
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', handler);
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

/**
 * One scripted turn: step 0 is "A" then "AB"; step 1 is "CD". The trajectory
 * is ACTIVE until the third steps poll, then IDLE. Returns the observed
 * request offsets so the test can compare the two flag positions.
 */
async function runScriptedTurn({ turnFlag }) {
  if (turnFlag) process.env.WINDSURFAPI_CASCADE_TURN = '1';
  else delete process.env.WINDSURFAPI_CASCADE_TURN;

  const state = { stepsCalls: 0, offsets: [] };
  try {
    return await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const method = String(headers[':path']).split('/').pop();
        const payload = unwrapRequest(Buffer.concat(chunks), headers);
        let body = Buffer.alloc(0);

        if (method === 'StartCascade') body = writeStringField(1, 'flag-cascade');
        if (method === 'GetCascadeTrajectorySteps') {
          state.stepsCalls += 1;
          const offset = readStepOffset(payload);
          state.offsets.push(offset);
          let trajectory;
          if (state.stepsCalls === 1) trajectory = [plannerStep('A', 1)];
          else if (state.stepsCalls === 2) trajectory = [plannerStep('AB', 1)];
          else trajectory = [plannerStep('AB', 3), plannerStep('CD', 3)];
          body = rawStepsResponse(trajectory.slice(offset));
        }
        if (method === 'GetCascadeTrajectory') {
          body = writeVarintField(2, state.stepsCalls >= 3 ? 1 : 2); // IDLE / ACTIVE
        }
        respond(stream, headers, body);
      });
    }, async (port) => {
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat(
        [{ role: 'user', content: 'grow inside a step' }], 0, 'claude-sonnet-4-6',
      );
      return {
        text: chunks.map(chunk => chunk.text || '').join(''),
        stepOffset: chunks.stepOffset,
        turnSnapshot: chunks.turnSnapshot,
        offsets: state.offsets,
        stepsCalls: state.stepsCalls,
      };
    });
  } finally {
    delete process.env.WINDSURFAPI_CASCADE_TURN;
  }
}

describe('CascadeTurn flag-off compatibility', () => {
  it('produces identical chunks and poll offsets with the flag on and off', async () => {
    const off = await runScriptedTurn({ turnFlag: false });
    const on = await runScriptedTurn({ turnFlag: true });

    assert.equal(off.text, 'ABCD', 'the default path still re-reads partial-step growth');
    assert.equal(on.text, off.text, 'the turn path emits exactly the same text');
    assert.equal(on.stepOffset, off.stepOffset, 'both report the same absolute next step');
    assert.equal(off.stepOffset, 2);
    // Poll COUNT is scheduler-dependent (10ms poll, IDLE needs a settled
    // growth window). Compare the common prefix instead of demanding the two
    // runs land on the same final tick; the flag must not change the windows.
    const common = Math.min(on.offsets.length, off.offsets.length);
    assert.ok(common >= 3, 'both runs must poll at least the three scripted windows');
    assert.deepEqual(on.offsets.slice(0, common), off.offsets.slice(0, common), 'both poll the same bounded windows');
    assert.ok(Math.abs(on.stepsCalls - off.stepsCalls) <= 1, 'the turn path does not add more than a final settling read');
    assert.equal(off.turnSnapshot, undefined, 'the default return shape has no producer state');
  });

  it('exposes the per-step cursors and overlap window on the flag-on snapshot', async () => {
    const on = await runScriptedTurn({ turnFlag: true });
    const snapshot = on.turnSnapshot;

    assert.ok(snapshot, 'flag-on turns attach the producer snapshot');
    assert.equal(snapshot.cascadeId, 'flag-cascade');
    assert.equal(snapshot.stepOffset, 2);
    assert.equal(snapshot.pollFloor, 0);
    assert.equal(snapshot.windowStart, 0, 'the next window reaches behind the unread offset');
    assert.deepEqual(snapshot.yieldedByStep, [[0, 2], [1, 2]]);
    assert.deepEqual(snapshot.thinkingByStep, []);
    assert.equal(snapshot.totalYielded, 4);
    assert.equal(snapshot.chunks.map(chunk => chunk.text || '').join(''), 'ABCD');
  });
});

/**
 * A resumed cascade (reuseEntry.stepOffset=5) starts its turn at 5. The turn
 * must clamp the overlap window to that floor, never replay steps 0-4, and
 * still report the absolute next step.
 */
async function runResumedTurn({ turnFlag }) {
  if (turnFlag) process.env.WINDSURFAPI_CASCADE_TURN = '1';
  else delete process.env.WINDSURFAPI_CASCADE_TURN;

  const offsets = [];
  try {
    return await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const method = String(headers[':path']).split('/').pop();
        const payload = unwrapRequest(Buffer.concat(chunks), headers);
        let body = Buffer.alloc(0);

        if (method === 'GetCascadeTrajectorySteps') {
          const offset = readStepOffset(payload);
          offsets.push(offset);
          if (offset === 5) body = rawStepsResponse([plannerStep('R5'), plannerStep('R6')]);
        }
        if (method === 'GetCascadeTrajectory') body = writeVarintField(2, 1); // IDLE
        respond(stream, headers, body);
      });
    }, async (port) => {
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat(
        [{ role: 'user', content: 'continue' }], 0, 'claude-sonnet-4-6',
        {
          reuseEntry: {
            cascadeId: 'resume-cascade',
            sessionId: 'resume-session',
            lsPort: port,
            apiKey: 'test-api-key',
            stepOffset: 5,
            generatorOffset: 5,
          },
        },
      );
      return {
        text: chunks.map(chunk => chunk.text || '').join(''),
        stepOffset: chunks.stepOffset,
        turnSnapshot: chunks.turnSnapshot,
        offsets,
      };
    });
  } finally {
    delete process.env.WINDSURFAPI_CASCADE_TURN;
  }
}

describe('CascadeTurn flag-on resume floor', () => {
  it('starts a resumed turn at reuseEntry.stepOffset and never polls behind it', async () => {
    const off = await runResumedTurn({ turnFlag: false });
    const on = await runResumedTurn({ turnFlag: true });

    assert.equal(off.text, 'R5R6');
    assert.equal(on.text, off.text);
    assert.equal(on.stepOffset, off.stepOffset);
    assert.equal(on.stepOffset, 7);
    const common = Math.min(on.offsets.length, off.offsets.length);
    assert.ok(common >= 3, 'both runs must poll at least the scripted windows');
    assert.deepEqual(on.offsets.slice(0, common), off.offsets.slice(0, common));
    assert.ok(on.offsets.every(offset => offset === 5), `polled behind the floor: ${on.offsets.join(',')}`);

    assert.equal(on.turnSnapshot.pollFloor, 5);
    assert.equal(on.turnSnapshot.stepOffset, 7);
    assert.equal(on.turnSnapshot.windowStart, 5, 'the overlap is clamped to the resume floor');
    assert.deepEqual(on.turnSnapshot.yieldedByStep, [[5, 2], [6, 2]]);
  });
});

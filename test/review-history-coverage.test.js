import { it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { wrapEnvelope, unwrapRequest, endOfStreamEnvelope } from '../src/connect.js';
import { parseFields, getField, writeStringField, writeVarintField, writeMessageField } from '../src/proto.js';

Object.assign(process.env, { CASCADE_POLL_INTERVAL_MS: '5', CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '1500', CASCADE_COLD_STALL_BASE_MS: '1500', CASCADE_WARM_STALL_MS: '1500',
  GRPC_PROTOCOL: 'connect', WINDSURFAPI_USER_JWT: '0', CASCADE_MAX_HISTORY_BYTES: '1024' });
const { WindsurfClient } = await import('../src/client.js');

async function exercise({ recovered, system = '', size = 170, intact = false, turns = 5, model = 'audit-neutral-model' }) {
  const history = Array.from({ length: turns }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
    content: `TURN_${i}_MARKER` + (i < turns - 1 ? 'x'.repeat(size) : '') }));
  const messages = system ? [{ role: 'system', content: system }, ...history] : history;
  const before = JSON.stringify(messages), prompts = [], sessions = new Set();
  const server = http2.createServer();
  server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
  server.on('stream', (stream, headers) => {
    const chunks = []; stream.on('data', b => chunks.push(b));
    stream.on('end', () => {
      const payload = unwrapRequest(Buffer.concat(chunks), headers);
      const method = String(headers[':path']).split('/').pop();
      let body = Buffer.alloc(0);
      if (method === 'StartCascade') body = writeStringField(1, 'synthetic-fresh');
      if (method === 'SendUserCascadeMessage') {
        const scope = getField(parseFields(payload), 2, 2);
        prompts.push(getField(parseFields(scope.value), 1, 2).value.toString('utf8'));
        if (recovered && !intact && prompts.length === 1) {
          const bytes = Buffer.from(JSON.stringify({ error: { message: 'not_found: cascade trajectory has expired' } }));
          const frame = Buffer.alloc(5 + bytes.length); frame[0] = 2; frame.writeUInt32BE(bytes.length, 1); bytes.copy(frame, 5);
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] }); stream.end(frame); return;
        }
      }
      if (method === 'GetCascadeTrajectorySteps') {
        const stepOffset = getField(parseFields(payload), 2, 0);
        if (!stepOffset) {
          body = writeMessageField(1, Buffer.concat([
            writeVarintField(1, 15), writeVarintField(4, 3), writeMessageField(20, writeStringField(1, 'answer')),
          ]));
        }
      }
      if (method === 'GetCascadeTrajectory') body = writeVarintField(2, 1);
      stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/connect+proto' });
      stream.end(Buffer.concat([wrapEnvelope(body, { compress: false }), endOfStreamEnvelope()]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const client = new WindsurfClient('fixture-only-api-key', port, 'fixture-csrf');
    const chunks = await client.cascadeChat(messages, 0, model, {
      reuseEntry: recovered ? { cascadeId: 'synthetic-existing', sessionId: 'fixture-session', stepOffset: 5, generatorOffset: 5 } : null,
    });
    assert.equal(JSON.stringify(messages), before, 'caller history is not mutated');
    assert.equal(prompts.length, recovered && !intact ? 2 : 1, 'exercise the intended path');
    const wire = prompts.at(-1);
    if (!intact) {
      const included = history.map((m, i) => wire.includes(`TURN_${i}_MARKER`) ? i : -1).filter(i => i >= 0);
      assert.ok(included.length > 0);
      const first = included[0];
      assert.deepEqual(included, Array.from({ length: turns - first }, (_, i) => first + i), 'wire carries a contiguous history suffix');
      // Order, not just presence: the wire must carry the history oldest-first. Turning
      // the builder's `lines.unshift(...)` into a push reverses it while every
      // presence/contiguity assertion above still passes, and turn order is
      // semantically load-bearing for the model.
      const positions = included.map(i => wire.indexOf(`TURN_${i}_MARKER`));
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'history turns appear in chronological order on the wire');
      assert.deepEqual(chunks.historyCoverage, { droppedTurnCount: first, firstIncludedTurnIndex: first, totalTurns: turns }, 'metadata equals decoded prompt contents, not another return value');
    }
    return { coverage: chunks.historyCoverage, wire };
  } finally {
    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
it('fresh and recovered large histories each report their actual decoded wire suffix', async () => {
  for (const recovered of [false, true]) {
    const r = await exercise({ recovered, size: 2048 });
    assert.equal(r.coverage.droppedTurnCount, 3);
    assert.ok(r.wire.includes('TURN_4_MARKER'));
  }
});
it('system prompt overhead legitimately gives fresh and rebuild different coverage', async () => {
  const system = 'Context facts: ' + 's'.repeat(550);
  const fresh = await exercise({ recovered: false, system });
  const recovered = await exercise({ recovered: true, system });
  assert.equal(fresh.coverage.droppedTurnCount, 2);
  assert.equal(recovered.coverage.droppedTurnCount, 0);
  assert.notDeepEqual(fresh.coverage, recovered.coverage, 'common code is not identical effective budgets');
  assert.ok(fresh.wire.includes(system)); assert.ok(recovered.wire.includes(system));
});
it('an intact resume retains upstream coverage while sending only the new turn', async () => {
  const r = await exercise({ recovered: true, intact: true });
  assert.deepEqual(r.coverage, { droppedTurnCount: 0, firstIncludedTurnIndex: 0, totalTurns: 5 });
  assert.ok(r.wire.includes('TURN_4_MARKER')); assert.ok(!r.wire.includes('TURN_0_MARKER'));
});

it('uses the 900 KB branch for a 1M model and the 600 KB branch otherwise', async () => {
  const oneM = await exercise({ recovered: false, size: 140000, turns: 6, model: 'claude-sonnet-4-6-1m' });
  assert.equal(oneM.coverage.totalTurns, 6);
  assert.equal(oneM.coverage.droppedTurnCount, 0, '840 KB history fits the 900 KB 1M branch');
  const normal = await exercise({ recovered: false, size: 140000, turns: 6, model: 'claude-sonnet-4-6' });
  assert.equal(normal.coverage.totalTurns, 6);
  assert.ok(normal.coverage.droppedTurnCount > 0, '840 KB history exceeds the 600 KB normal branch');
  assert.ok(normal.wire.includes('TURN_5_MARKER'));
});

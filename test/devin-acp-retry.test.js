// Q5-P1 (ownership): the ACP runner had zero retry/failover. A single
// transport hiccup (child died / RPC 5xx) surfaced as a hard client error even
// though a fresh `devin acp` process would have served the turn. The fix adds
// exactly ONE bounded retry for transport/5xx faults, gated so it never:
//   - replays after any chunk reached the client (would duplicate output),
//   - retries deterministic tool-mapping failures,
//   - retries aborts.
//
// All tests use a FAKE stdio child; no Devin CLI, account or network.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDevinAcpProcess } from '../src/devin-acp.js';

const ENV_KEYS = [
  'DEVIN_CLI_PATH', 'DEVIN_CLI_ACP_ARGS_JSON', 'DEVIN_TIMEOUT_MS',
  'DEVIN_OUTPUT_LIMIT_BYTES', 'DEVIN_CLI_WORKDIR', 'FAKE_ACP_COUNTER', 'FAKE_ACP_MODE',
  'DEVIN_ACP_RETRY_BASE_MS',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const tmpDirs = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Each spawn increments a shared counter file, so the fake can behave
// differently on attempt 1 vs attempt 2 (attempts are separate processes).
function installFakeAcp(body) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-retry-'));
  tmpDirs.push(dir);
  const script = join(dir, 'fake-acp.mjs');
  const counter = join(dir, 'counter');
  writeFileSync(counter, '0', 'utf8');
  writeFileSync(script, body, 'utf8');
  process.env.DEVIN_CLI_PATH = process.execPath;
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
  process.env.DEVIN_TIMEOUT_MS = '5000';
  process.env.FAKE_ACP_COUNTER = counter;
  process.env.DEVIN_ACP_RETRY_BASE_MS = '1';
  return { dir, counter };
}

function attempts(counter) {
  return Number(readFileSync(counter, 'utf8'));
}

const PRELUDE = `
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const counterPath = process.env.FAKE_ACP_COUNTER;
let attempt = 0;
try { attempt = Number(readFileSync(counterPath, 'utf8')) || 0; } catch {}
attempt += 1;
writeFileSync(counterPath, String(attempt));
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } }); }
`;

describe('runDevinAcpProcess — one bounded transport retry', () => {
  it('retries a 5xx transport fault once and returns the second attempt', async () => {
    const { counter } = installFakeAcp(`${PRELUDE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    if (attempt === 1) {
      // Transport-shaped fault: the child dies mid-RPC (5xx backend_error).
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'socket hang up' } });
      return;
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RECOVERED' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
});
`);

    const out = await runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' });
    assert.equal(out.text, 'RECOVERED', 'the retried attempt served the turn');
    assert.equal(attempts(counter), 2, 'exactly one retry (two child processes)');
  });

  it('does NOT retry a tool-mapping failure', async () => {
    const { counter } = installFakeAcp(`${PRELUDE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    // Tool-ish stop with no captured call -> backend_tool_call_unmapped.
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'tool_use' } });
    return;
  }
});
`);

    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k' }),
      (err) => {
        assert.equal(err.type, 'backend_tool_call_unmapped');
        return true;
      },
    );
    assert.equal(attempts(counter), 1, 'deterministic tool errors are not replayed');
  });

  it('does NOT retry after a chunk already reached the client', async () => {
    const { counter } = installFakeAcp(`${PRELUDE}
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL' } });
    // Then a transport-shaped failure. A retry would duplicate PARTIAL.
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'socket hang up' } });
    return;
  }
});
`);

    const chunks = [];
    await assert.rejects(
      () => runDevinAcpProcess('hi', { modelKey: 'swe-1.6', apiKey: 'k', onChunk: (c) => chunks.push(c) }),
      /socket hang up/,
    );
    assert.equal(attempts(counter), 1, 'no replay once output crossed the wire');
    assert.ok(chunks.some((c) => /PARTIAL/.test(c.text || '')), 'the partial chunk was delivered once');
  });
});

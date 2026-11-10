import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDevinAcpProcess } from '../src/devin-acp.js';

const FAKE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
let cfg = null;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1', configOptions: [{ id: 'model', name: 'Model', options: [{ value: 'devin-swe-2-lightning-high' }] }] } }); return; }
  if (msg.method === 'session/set_config_option') { cfg = msg.params; send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/prompt') { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'CFG=' + JSON.stringify(cfg) } } } }); send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }); return; }
});
`;

const dirs = [];
const saved = {};
for (const k of ['DEVIN_CLI_PATH', 'DEVIN_CLI_ACP_ARGS_JSON', 'DEVIN_ACP_CONFIG_OPTIONS', 'DEVIN_TIMEOUT_MS']) saved[k] = process.env[k];

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} }
});

function install() {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-cfg-'));
  dirs.push(dir);
  const script = join(dir, 'fake-acp.mjs');
  writeFileSync(script, FAKE, 'utf8');
  process.env.DEVIN_CLI_PATH = process.execPath;
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
  process.env.DEVIN_TIMEOUT_MS = '5000';
}

describe('Devin ACP config options', () => {
  it('sets the advertised model option when the flag is on', async () => {
    install();
    process.env.DEVIN_ACP_CONFIG_OPTIONS = '1';
    const out = await runDevinAcpProcess('hi', { modelKey: 'devin-swe-2-lightning-high', apiKey: 'tok' });
    assert.match(out.text, /"configId":"model"/);
    assert.match(out.text, /"value":"devin-swe-2-lightning-high"/);
  });

  it('does not call set_config_option when the flag is off', async () => {
    install();
    delete process.env.DEVIN_ACP_CONFIG_OPTIONS;
    const out = await runDevinAcpProcess('hi', { modelKey: 'devin-swe-2-lightning-high', apiKey: 'tok' });
    assert.match(out.text, /CFG=null/);
  });
});

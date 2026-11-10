import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { toClientToolCallId } from '../src/tool-ids.js';

// The ACP runner's toolCallId is its own dialect (`tc1` here). The client-visible
// id must still be the OpenAI `call_<opaque>` shape; the raw id is only used
// internally to key the tool_call/tool_call_update notifications.
const CLIENT_TC1 = toClientToolCallId('tc1');

// GFHarness gap: ACP `tool_call` / `tool_call_update` notifications were dropped
// and `stopReason:"tool_use"` silently degraded to finish_reason:"stop". These
// tests drive a REAL fake `devin acp` child (no mocked runner seam) through the
// real ACP pump and both protocol fronts, so the notification parser, the
// stop-reason mapping and the egress translators are all exercised together.

const ENV_KEYS = [
  'WINDSURFAPI_SPECIAL_AGENT_BACKEND',
  'DEVIN_CLI_ENABLED',
  'DEVIN_CLI_PATH',
  'DEVIN_CLI_ACP_ARGS_JSON',
  'DEVIN_CLI_ARGS_JSON',
  'DEVIN_CLI_USE_ACCOUNT_POOL',
  'DEVIN_CLI_MODE',
  'DEVIN_ACP_PROBE',
  'DEVIN_TIMEOUT_MS',
  'DEVIN_CLI_WORKDIR',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const tmpDirs = [];

beforeEach(() => {
  // No real `devin --version` probe: the fake CLI is node running a script.
  process.env.DEVIN_ACP_PROBE = '0';
  process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
  process.env.DEVIN_CLI_MODE = 'acp';
  process.env.DEVIN_CLI_USE_ACCOUNT_POOL = '1';
  process.env.DEVIN_TIMEOUT_MS = '5000';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const HANDSHAKE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function update(u) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: u } }); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'windsurf-api-key' }] } }); return; }
  if (msg.method === 'authenticate') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-1' } }); return; }
  if (msg.method === 'session/prompt') {
    PROMPT_BODY
    return;
  }
});
`;

// The captured shape from the Q3 probe: the tool call is announced with
// rawInput, its result arrives as a tool_call_update (which must NOT be turned
// into a fabricated tool result), and the turn ends with stopReason tool_use.
const TOOL_PROMPT = `${HANDSHAKE.replace('PROMPT_BODY', `
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Bash', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file.txt' } }] });
    update({ sessionUpdate: 'agent_message_chunk', content: { text: 'listed' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'tool_use' } });`)}`;

const BARE_TOOL_STOP_PROMPT = `${HANDSHAKE.replace('PROMPT_BODY', `
    update({ sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'tool_use' } });`)}`;

// The real ACP runner needs an upstream key. Inject a checkout so the test
// exercises the production runner (not a mocked one) without an account pool.
function acpDeps() {
  return {
    specialAgent: {
      checkoutAccount: async () => ({ apiKey: 'test-key', id: 'acct-1', apiServerUrl: '' }),
      releaseAccount: () => {},
      reportSuccess: () => {},
      refundReservation: () => {},
      reportError: () => {},
      reportInternalError: () => {},
      reportBanSignal: () => {},
      markRateLimited: () => {},
    },
  };
}

function installFakeAcp(source) {
  const dir = mkdtempSync(join(tmpdir(), 'windsurfapi-acp-tools-'));
  tmpDirs.push(dir);
  const script = join(dir, 'fake-acp.mjs');
  writeFileSync(script, source, 'utf8');
  process.env.DEVIN_CLI_PATH = process.execPath;
  process.env.DEVIN_CLI_ACP_ARGS_JSON = JSON.stringify([script]);
}

function streamRes() {
  const writes = [];
  return {
    writes,
    writableEnded: false,
    write(c) { writes.push(String(c)); return true; },
    end() { this.writableEnded = true; },
    on() {},
    joined() { return writes.join(''); },
  };
}

function sseChunks(res) {
  return res.writes
    .map(w => String(w).replace(/^data: /, '').trim())
    .filter(s => s && s !== '[DONE]')
    .map(s => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}

describe('ACP tool updates → OpenAI tool_calls', () => {
  it('forwards tool_call/tool_call_update and maps stopReason tool_use to finish_reason tool_calls (no fake result)', async () => {
    installFakeAcp(TOOL_PROMPT);

    // Non-streaming.
    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [{ role: 'user', content: 'list files' }],
    }, acpDeps());
    assert.equal(result.status, 200);
    const choice = result.body.choices[0];
    assert.deepEqual(choice.message.tool_calls, [{
      id: CLIENT_TC1,
      type: 'function',
      function: { name: 'Bash', arguments: '{"command":"ls"}' },
    }]);
    assert.equal(choice.finish_reason, 'tool_calls');
    // The update carried the tool's output; it must not be fabricated into a
    // tool result message (the client never produced one).
    assert.equal(choice.message.role, 'assistant');
    assert.doesNotMatch(JSON.stringify(result.body), /file\.txt/);

    // Streaming: the same session state must surface as delta.tool_calls before
    // the terminal finish_reason chunk.
    const streamed = await handleChatCompletions({
      model: 'swe-1.6',
      stream: true,
      messages: [{ role: 'user', content: 'list files' }],
    }, acpDeps());
    assert.equal(streamed.status, 200);
    const res = streamRes();
    await streamed.handler(res);
    const chunks = sseChunks(res);
    const deltas = chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls || []);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].index, 0);
    assert.equal(deltas[0].id, CLIENT_TC1);
    assert.match(deltas[0].id, /^call_[A-Za-z0-9_-]+$/);
    assert.equal(deltas[0].type, 'function');
    assert.equal(deltas[0].function.name, 'Bash');
    assert.equal(deltas[0].function.arguments, '{"command":"ls"}');
    const finish = chunks.find(c => c.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
    assert.ok(
      chunks.indexOf(chunks.find(c => c.choices?.[0]?.delta?.tool_calls)) < chunks.indexOf(finish),
      'tool_calls delta must precede the terminal finish chunk',
    );
    assert.doesNotMatch(res.joined(), /file\.txt/);
    assert.doesNotMatch(res.joined(), /"role":"tool"/);
  });
});

describe('ACP tool updates → Anthropic tool_use', () => {
  it('maps stopReason tool_use to stop_reason tool_use with a tool_use block and no tool_result', async () => {
    installFakeAcp(TOOL_PROMPT);

    // Non-streaming.
    const result = await handleMessages({
      model: 'swe-1.6',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'list files' }],
    }, acpDeps());
    assert.equal(result.status, 200);
    assert.equal(result.body.stop_reason, 'tool_use');
    const toolUse = result.body.content.find(b => b.type === 'tool_use');
    assert.deepEqual(toolUse, {
      type: 'tool_use',
      id: CLIENT_TC1,
      name: 'Bash',
      input: { command: 'ls' },
    });
    assert.equal(result.body.content.some(b => b.type === 'tool_result'), false);
    assert.doesNotMatch(JSON.stringify(result.body), /file\.txt/);

    // Streaming.
    const streamed = await handleMessages({
      model: 'swe-1.6',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'list files' }],
    }, acpDeps());
    assert.equal(streamed.status, 200);
    const res = streamRes();
    await streamed.handler(res);
    const joined = res.joined();
    assert.match(joined, /"type":"tool_use"/);
    assert.match(joined, new RegExp(`"id":"${CLIENT_TC1}"`));
    assert.match(joined, /"name":"Bash"/);
    assert.match(joined, /"partial_json":"\{\\"command\\":\\"ls\\"\}"/);
    assert.match(joined, /"stop_reason":"tool_use"/);
    assert.ok(
      joined.indexOf('"type":"tool_use"') < joined.indexOf('"stop_reason":"tool_use"'),
      'tool_use block must be opened before message_delta',
    );
    assert.doesNotMatch(joined, /"type":"tool_result"/);
    assert.doesNotMatch(joined, /file\.txt/);
  });
});

describe('ACP unmappable tool stop', () => {
  it('surfaces an explicit error when tool_use arrives without any tool call', async () => {
    installFakeAcp(BARE_TOOL_STOP_PROMPT);

    const result = await handleChatCompletions({
      model: 'swe-1.6',
      messages: [{ role: 'user', content: 'call a tool' }],
    }, acpDeps());
    assert.equal(result.status, 502);
    assert.equal(result.body.error.type, 'backend_tool_call_unmapped');
    assert.match(result.body.error.message, /tool_use/);

    // The Anthropic front maps the same explicit failure through its error
    // vocabulary (502 → 529 overloaded_error) instead of returning end_turn.
    const anthropic = await handleMessages({
      model: 'swe-1.6',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'call a tool' }],
    }, acpDeps());
    assert.equal(anthropic.status, 529);
    assert.equal(anthropic.body.error.type, 'overloaded_error');
    assert.match(anthropic.body.error.message, /tool_use/);

    // Streaming must surface the same explicit failure, not a clean finish.
    const streamed = await handleChatCompletions({
      model: 'swe-1.6',
      stream: true,
      messages: [{ role: 'user', content: 'call a tool' }],
    }, acpDeps());
    assert.equal(streamed.status, 200);
    const res = streamRes();
    await streamed.handler(res);
    const joined = res.joined();
    assert.match(joined, /backend_tool_call_unmapped/);
    assert.match(joined, /"finish_reason":"error"/);
    assert.doesNotMatch(joined, /"finish_reason":"stop"/);
  });
});

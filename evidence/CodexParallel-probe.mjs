// P1 (evidence/ClientSandboxes.md §3.3 C1): Codex CLI 0.164 sends
// `parallel_tool_calls:false` on 29/29 requests and the responses surface used to
// drop the field. After wave 2 forwarded it, the chat route's gate answered 400
// `unsupported_parameter` with DEVIN_CONNECT_TOOL_CHOICE unset — the shipped
// default — so Codex failed on its very first turn.
//
// This probe drives the REAL responses handler and the REAL chat gate; only the
// connect transport is stubbed, so a model call is observable and no bytes leave
// the box. It is the reproduction recorded in evidence/CodexParallelFix.md.
//
// Run with: node --import ./test/setup-env.mjs evidence/CodexParallel-probe.mjs

import { handleResponses } from '../src/handlers/responses.js';
import { __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { getConnectMetrics } from '../src/devin-connect-metrics.js';

process.env.DEVIN_CONNECT = '1';
process.env.DEVIN_CONNECT_TOKEN = 'env-token-shape-only';
delete process.env.WINDSURF_API_KEY;
delete process.env.WINDSURFAPI_STRICT_MODEL;

const state = { hits: 0, lastParams: null };

__setConnectDeps({
  toChatCompletion: async (params) => {
    state.hits++;
    state.lastParams = params;
    return {
      status: 200,
      body: {
        id: 'chatcmpl-probe',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-6-luna-max',
        choices: [{ index: 0, message: { role: 'assistant', content: 'SERVED' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
  },
});

// Codex 0.164 shape, flattened the way the capture shows it reaching the proxy:
// one function tool set + the hint on every request.
function codexRequest(extra = {}) {
  return {
    model: 'gpt-6-luna-max',
    stream: false,
    store: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say ok' }] },
    ],
    tools: [{
      type: 'function',
      name: 'functions__exec',
      description: 'run a command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
    tool_choice: 'auto',
    ...extra,
  };
}

async function run(label, body) {
  state.hits = 0;
  state.lastParams = null;
  const before = getConnectMetrics().parallel_tool_calls_hint_ignored;
  const r = await handleResponses(body);
  const err = r?.body?.error;
  console.log(JSON.stringify({
    label,
    status: r.status,
    modelCalls: state.hits,
    error: err ? { code: err.code, param: err.param, message: String(err.message).slice(0, 120) } : null,
    forwardedParallelToolCalls: state.lastParams ? state.lastParams.parallelToolCalls : undefined,
    hintIgnoredDelta: getConnectMetrics().parallel_tool_calls_hint_ignored - before,
  }));
  return r;
}

console.log('--- passthrough OFF (shipped default: DEVIN_CONNECT_TOOL_CHOICE unset) ---');
delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
await run('codex-shape with parallel_tool_calls:false', codexRequest({ parallel_tool_calls: false }));
await run('same request WITHOUT the field', codexRequest());
await run('parallel_tool_calls:true', codexRequest({ parallel_tool_calls: true }));

console.log('--- passthrough ON (DEVIN_CONNECT_TOOL_CHOICE=1) ---');
process.env.DEVIN_CONNECT_TOOL_CHOICE = '1';
await run('codex-shape with parallel_tool_calls:false', codexRequest({ parallel_tool_calls: false }));

__resetConnectDeps();

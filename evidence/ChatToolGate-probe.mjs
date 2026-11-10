// F3 (evidence/DataAuditTools/findings.md): does /v1/chat/completions refuse
// hosted / server-executed tool types, or run the model with the tool gone?
//
// Real handleChatCompletions, DEVIN_CONNECT route, single env token (no pool),
// connect deps stubbed so a model call is observable and no bytes leave the box.
// Run with: node --import ./test/setup-env.mjs evidence/ChatToolGate-probe.mjs

import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { log } from '../src/config.js';

process.env.DEVIN_CONNECT = '1';
process.env.DEVIN_CONNECT_TOKEN = 'env-token-shape-only';
delete process.env.WINDSURF_API_KEY;
delete process.env.WINDSURFAPI_STRICT_MODEL;

const SERVER_SIDE = [
  'file_search',
  'computer_use_preview',
  'mcp',
  'code_interpreter',
  'image_generation',
  'local_shell',
  'shell',
  'apply_patch',
];
const HOSTED = ['web_search', 'web_search_preview', 'web_search_preview_2025_03_11', 'web_search_2025_08_26'];
const VERSIONED = SERVER_SIDE.map((type) => `${type}_2025_03_11`);

const state = { hits: 0, lastParams: null };

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    removeListener() {},
  };
}

__setConnectDeps({
  toChatCompletion: async (params) => {
    state.hits++;
    state.lastParams = params;
    return {
      status: 200,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'swe-1-6-slow',
        choices: [{ index: 0, message: { role: 'assistant', content: 'SERVED' }, finish_reason: 'stop' }],
      },
    };
  },
  streamChatCompletion: async (params, send) => {
    state.hits++;
    state.lastParams = params;
    send({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'swe-1-6-slow', choices: [{ index: 0, delta: { role: 'assistant', content: 'SERVED' } }] });
    send({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'swe-1-6-slow', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    return { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  },
});

async function row(label, { tools, stream = false, typeName = null }) {
  state.hits = 0;
  state.lastParams = null;
  const logs = [];
  const origWarn = log.warn;
  const origInfo = log.info;
  log.warn = (...args) => { logs.push(args.join(' ')); };
  log.info = (...args) => { logs.push(args.join(' ')); };
  let result;
  try {
    result = await handleChatCompletions({
      model: 'swe-1-6-slow',
      stream,
      messages: [{ role: 'user', content: 'hi' }],
      ...(tools ? { tools } : {}),
    }, { callerKey: '' });
    if (result?.stream && typeof result.handler === 'function') {
      await result.handler(fakeRes());
    }
  } finally {
    log.warn = origWarn;
    log.info = origInfo;
  }
  const status = result?.stream ? 'STREAM-200' : (result?.status ?? 200);
  const error = result?.body?.error || {};
  const toolLogs = logs.filter((line) => /tool/i.test(line) && !/Probe\[/.test(line));
  const typeLogs = typeName ? logs.filter((line) => line.includes(typeName)) : [];
  const forwarded = state.lastParams ? JSON.stringify(state.lastParams.messages || []).includes('code_interpreter') : false;
  console.log([
    'ROW',
    label,
    `status=${status}`,
    `code=${error.code || '-'}`,
    `param=${error.param || '-'}`,
    `hits=${state.hits}`,
    `toolLogLines=${toolLogs.length}`,
    `typeNamedLogs=${typeLogs.length}`,
    `toolTextUpstream=${forwarded}`,
    `msg=${JSON.stringify(error.message || '').slice(0, 90)}`,
  ].join('\t'));
}

for (const type of [...SERVER_SIDE, ...VERSIONED, ...HOSTED]) {
  await row(`tools ${type}`, { tools: [{ type }], typeName: type });
  await row(`tools ${type} stream`, { tools: [{ type }], stream: true, typeName: type });
}

await row('namespace tools child code_interpreter', {
  tools: [{ type: 'namespace', name: 'ns', tools: [{ type: 'code_interpreter' }] }],
  typeName: 'code_interpreter',
});
await row('namespace children child mcp', {
  tools: [{ type: 'namespace', name: 'ns', tools: [], children: [{ type: 'mcp' }] }],
  typeName: 'mcp',
});
await row('function apply_patch (control)', {
  tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object', properties: {} } } }],
});
await row('custom apply_patch (control)', {
  tools: [{ type: 'custom', name: 'apply_patch' }],
  typeName: 'custom',
});
await row('unknown banana', { tools: [{ type: 'banana' }], typeName: 'banana' });
await row('unknown banana stream', { tools: [{ type: 'banana' }], stream: true, typeName: 'banana' });

__resetConnectDeps();

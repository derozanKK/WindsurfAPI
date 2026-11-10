// F3 (evidence/DataAuditTools/findings.md): /v1/chat/completions had no tool-type
// gate at all. Every consumer filters on `type === 'function'` (the text preamble
// in tool-emulation.js and the native #10 ToolDef encoder in devin-connect.js),
// so a hosted (`web_search*`) or server-executed (`file_search`, `code_interpreter`,
// `mcp`, …) tool was dropped in silence: the turn ran, the model answered without
// the tool, and the caller got a normal 200 with no log line naming the type.
//
// /v1/responses refuses the same payload with a 400 before the model call. These
// tests pin the same admission on the chat surface, using the shared type
// predicates (src/server-side-tools.js) rather than a second copy of the set.
//
// The assertion that matters is the pair: a client-visible 400 AND zero upstream
// calls. A gate that runs after the model (or after account acquisition) would
// still spend the turn.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { log } from '../src/config.js';

const FREE_SELECTOR = 'swe-1-6-slow';

const SERVER_SIDE_TYPES = [
  'file_search',
  'computer_use_preview',
  'mcp',
  'code_interpreter',
  'image_generation',
  'local_shell',
  'shell',
  'apply_patch',
];
const DATED_SERVER_SIDE_TYPES = SERVER_SIDE_TYPES.map((type) => `${type}_2025_03_11`);
const HOSTED_TYPES = [
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
  'web_search_2025_08_26',
];

const ENV_KEYS = [
  'DEVIN_CONNECT',
  'DEVIN_CONNECT_TOKEN',
  'WINDSURF_API_KEY',
  'WINDSURFAPI_STRICT_MODEL',
];
const SAVED_ENV = {};
for (const key of ENV_KEYS) SAVED_ENV[key] = process.env[key];

const upstream = { hits: 0, lastParams: null };

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
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

function ask({ tools, stream = false } = {}) {
  return handleChatCompletions({
    model: FREE_SELECTOR,
    stream,
    messages: [{ role: 'user', content: 'hi' }],
    ...(tools ? { tools } : {}),
  }, { callerKey: '' });
}

/** Run `fn` while capturing every log line, restoring the sinks afterwards. */
async function captureLogs(fn) {
  const lines = [];
  const origInfo = log.info;
  const origWarn = log.warn;
  log.info = (...args) => { lines.push(args.join(' ')); };
  log.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    log.info = origInfo;
    log.warn = origWarn;
  }
}

before(() => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'env-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  delete process.env.WINDSURFAPI_STRICT_MODEL;
  __setConnectDeps({
    toChatCompletion: async (params) => {
      upstream.hits++;
      upstream.lastParams = params;
      return {
        status: 200,
        body: {
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: FREE_SELECTOR,
          choices: [{ index: 0, message: { role: 'assistant', content: 'SERVED' }, finish_reason: 'stop' }],
        },
      };
    },
    streamChatCompletion: async (params, send) => {
      upstream.hits++;
      upstream.lastParams = params;
      send({ id: 'x', object: 'chat.completion.chunk', created: 0, model: FREE_SELECTOR, choices: [{ index: 0, delta: { role: 'assistant', content: 'SERVED' } }] });
      send({ id: 'x', object: 'chat.completion.chunk', created: 0, model: FREE_SELECTOR, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    },
  });
});

beforeEach(() => {
  upstream.hits = 0;
  upstream.lastParams = null;
});

after(() => {
  __resetConnectDeps();
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

function assertRefused(result, { type, stream }) {
  assert.equal(result.status, 400, `${type} stream=${stream} must be refused before the model call`);
  assert.equal(result.stream, undefined, 'a rejected request never opens an SSE stream');
  assert.equal(result.body.error.type, 'invalid_request_error');
  assert.equal(result.body.error.code, 'unsupported_server_side_tool', `${type} stream=${stream}`);
  assert.equal(result.body.error.param, 'tools', `${type} stream=${stream}`);
  assert.ok(result.body.error.message.includes(type), `the message names the rejected type ${type}`);
  assert.match(result.body.error.message, /function tool/, 'the message tells the caller what to do instead');
}

describe('chat tool-type admission', () => {
  it('rejects every server-executed tool type with 400 and zero model calls, non-stream and stream', async () => {
    for (const type of SERVER_SIDE_TYPES) {
      for (const stream of [false, true]) {
        const result = await ask({ tools: [{ type }], stream });
        assertRefused(result, { type, stream });
        for (const listed of SERVER_SIDE_TYPES) {
          assert.ok(
            result.body.error.message.includes(listed),
            `the message lists every rejected type, missing ${listed} (${type})`,
          );
        }
        assert.equal(upstream.hits, 0, `${type} stream=${stream} must not reach the upstream`);
      }
    }
  });

  it('rejects dated snapshots of every server-executed type', async () => {
    for (const type of DATED_SERVER_SIDE_TYPES) {
      for (const stream of [false, true]) {
        const result = await ask({ tools: [{ type }], stream });
        assertRefused(result, { type, stream });
        assert.equal(upstream.hits, 0, `${type} stream=${stream} must not reach the upstream`);
      }
    }
  });

  it('rejects hosted web_search types, including dated snapshots, with the chat gate code', async () => {
    for (const type of HOSTED_TYPES) {
      for (const stream of [false, true]) {
        const result = await ask({ tools: [{ type }], stream });
        assertRefused(result, { type, stream });
        assert.match(
          result.body.error.message,
          /web_search/,
          'the hosted-search message names the workaround tool',
        );
        assert.equal(upstream.hits, 0, `${type} stream=${stream} must not reach the upstream`);
      }
    }
  });

  it('walks namespace children under every child key chat clients use', async () => {
    for (const childKey of ['tools', 'children', 'functions', 'items']) {
      for (const stream of [false, true]) {
        const result = await ask({
          tools: [{ type: 'namespace', name: 'ns', [childKey]: [{ type: 'code_interpreter' }] }],
          stream,
        });
        assert.equal(result.status, 400, `namespace ${childKey} stream=${stream}`);
        assert.equal(result.body.error.code, 'unsupported_server_side_tool');
        assert.equal(result.body.error.param, 'tools');
        assert.equal(upstream.hits, 0);
      }
    }
  });

  it('rejects a request where one tool is server-executed and another is a normal function', async () => {
    const result = await ask({
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } },
        { type: 'code_interpreter' },
      ],
    });
    assertRefused(result, { type: 'code_interpreter', stream: false });
    assert.equal(upstream.hits, 0);
  });

  it('keeps a client-declared function tool named apply_patch (and forwards it)', async () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'Apply a patch',
        parameters: { type: 'object', properties: { patch: { type: 'string' } } },
      },
    }];
    const result = await ask({ tools });
    assert.equal(result.status, 200, 'only tool.type decides; a function named apply_patch is client-run');
    assert.equal(upstream.hits, 1);
    assert.match(
      JSON.stringify(upstream.lastParams?.messages || []),
      /apply_patch/,
      'the declared function reaches the upstream tool preamble',
    );
  });

  it('keeps a custom tool named apply_patch and a bare function name on the lenient path', async () => {
    for (const tools of [
      [{ type: 'custom', name: 'apply_patch' }],
      [{ type: 'function', name: 'apply_patch' }],
    ]) {
      upstream.hits = 0;
      const result = await ask({ tools });
      assert.equal(result.status, 200, `not a server-executed type: ${JSON.stringify(tools)}`);
      assert.equal(upstream.hits, 1);
    }
  });

  it('keeps unknown tool types on the lenient path but logs the drop instead of staying silent', async () => {
    const { value: result, lines } = await captureLogs(() => ask({ tools: [{ type: 'banana' }] }));
    assert.equal(result.status, 200, 'unknown junk types are not newly refused');
    assert.equal(upstream.hits, 1);
    assert.ok(
      lines.some((line) => line.includes('banana') && /drop/i.test(line)),
      'the silently dropped type is now named in the logs',
    );
  });

  it('keeps the unknown-type drop observable on the stream path too', async () => {
    const { value: result, lines } = await captureLogs(async () => {
      const pending = await ask({ tools: [{ type: 'banana' }], stream: true });
      assert.equal(pending.status, 200);
      assert.equal(pending.stream, true, 'an unknown type is not a gate refusal');
      await pending.handler(fakeRes());
      return pending;
    });
    assert.equal(result.status, 200);
    assert.equal(upstream.hits, 1);
    assert.ok(lines.some((line) => line.includes('banana') && /drop/i.test(line)));
  });
});

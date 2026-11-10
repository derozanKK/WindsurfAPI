import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleResponses, responsesToChat, chatToResponse, handleGetResponse } from '../src/handlers/responses.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { resetResponseStore } from '../src/response-store.js';

function chatChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function parseEvents(raw) {
  return raw
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    // The trailing `data: [DONE]` sentinel carries no `event:` line and is not JSON, so
    // it is dropped here rather than parsed. Dropped by exact match, not by swallowing
    // parse errors: a genuinely malformed frame must still fail this helper loudly.
    // What the sentinel itself guarantees is pinned in responses-stream-done-sentinel.test.js.
    .filter(frame => frame !== 'data: [DONE]')
    .map(frame => {
      const lines = frame.split('\n');
      const event = lines.find(line => line.startsWith('event: '))?.slice(7);
      const data = JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}');
      return { event, data };
    });
}

function assertSequenceNumbers(events) {
  events.forEach((event, index) => {
    assert.equal(event.data.sequence_number, index);
  });
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      const cbs = listeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

describe('responsesToChat', () => {
  it('maps string input and instructions to chat messages', () => {
    const out = responsesToChat({
      model: 'claude-sonnet-4.6',
      instructions: 'Be concise.',
      input: 'Hello',
      max_output_tokens: 123,
      reasoning: { effort: 'medium' },
    });
    assert.deepEqual(out.messages, [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ]);
    assert.equal(out.max_tokens, 123);
    assert.equal(out.reasoning_effort, 'medium');
  });

  it('maps Responses text.format json_schema to chat response_format', () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    };
    const out = responsesToChat({
      input: 'extract title',
      text: { format: { type: 'json_schema', name: 'title_response', schema, strict: false } },
    });
    assert.deepEqual(out.response_format, {
      type: 'json_schema',
      json_schema: {
        name: 'title_response',
        schema,
        strict: false,
      },
    });
  });

  it('maps Responses text.format json_object to chat response_format', () => {
    const out = responsesToChat({
      input: 'return JSON',
      text: { format: { type: 'json_object' } },
    });
    assert.deepEqual(out.response_format, { type: 'json_object' });
  });

  it('defaults json_schema strict to false (OpenAI Responses spec) when omitted', () => {
    const out = responsesToChat({
      input: 'extract title',
      text: { format: { type: 'json_schema', name: 'title_response', schema: { type: 'object' } } },
    });
    assert.equal(out.response_format.json_schema.strict, false);
  });

  it('maps message item arrays and function tools', () => {
    const out = responsesToChat({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run it' }] },
      ],
      tools: [
        { type: 'function', name: 'Bash', description: 'Run shell', parameters: { type: 'object' } },
      ],
    });
    assert.equal(out.messages.length, 1);
    assert.deepEqual(out.messages[0], { role: 'user', content: [{ type: 'text', text: 'Run it' }] });
    assert.deepEqual(out.tools, [
      { type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } }, __response_tool: { type: 'function', namespace: '', originalName: 'Bash' } },
    ]);
  });

  it('flattens namespace tools with a separator-safe encoded name', () => {
    const out = responsesToChat({
      tools: [
        {
          type: 'namespace',
          name: 'mcp__desktop_commander',
          tools: [
            { type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object' } },
          ],
        },
      ],
    });
    assert.equal(out.tools[0].function.name, 'mcp__desktop_commander__read_file');
    assert.deepEqual(out.tools[0].__response_tool, {
      type: 'namespace',
      namespace: 'mcp__desktop_commander',
      originalName: 'read_file',
    });
  });

  it('collects Responses Lite additional_tools without creating a message', () => {
    const out = responsesToChat({
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            { type: 'custom', name: 'exec', description: 'Run code.' },
            { type: 'function', name: 'wait', parameters: { type: 'object', properties: { id: { type: 'string' } } } },
            { type: 'tool_search', description: 'Deferred tool discovery is not bridged by this adapter.' },
            {
              type: 'namespace',
              name: 'mcp__amazon_ads',
              tools: [
                { type: 'function', name: 'query_campaigns', parameters: { type: 'object', properties: { days: { type: 'integer' } } } },
              ],
            },
          ],
        },
        { type: 'message', role: 'user', content: 'Run it' },
      ],
      tools: [
        { type: 'function', name: 'top_level', parameters: { type: 'object', properties: {} } },
      ],
    });
    assert.deepEqual(out.messages, [{ role: 'user', content: 'Run it' }]);
    assert.deepEqual(out.tools.map(tool => tool.function.name), [
      'top_level',
      'exec',
      'wait',
      'mcp__amazon_ads__query_campaigns',
    ]);
    assert.deepEqual(out.tools[1].__response_tool, { type: 'custom', namespace: '', originalName: 'exec' });
    assert.deepEqual(out.tools[3].__response_tool, { type: 'namespace', namespace: 'mcp__amazon_ads', originalName: 'query_campaigns' });
  });

  it('deduplicates the same tool mirrored across top-level and additional_tools', () => {
    const tool = { type: 'function', name: 'wait', parameters: { type: 'object', properties: { id: { type: 'string' } } } };
    const out = responsesToChat({
      tools: [tool],
      input: [{ type: 'additional_tools', tools: [{ ...tool }] }],
    });
    assert.deepEqual(out.tools.map(entry => entry.function.name), ['wait']);
  });

  it('deduplicates a mirrored tool even when its parameters key order differs (no false 400)', () => {
    // Regression for the key-order false-positive: the SAME tool mirrored across
    // top-level and additional_tools, but with parameters object keys emitted in
    // a different order by each side, is semantically identical and must dedup —
    // NOT be rejected as an ambiguous name conflict (400). Canonical comparison.
    const topLevel = {
      type: 'function', name: 'wait',
      parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } } },
    };
    const mirrored = {
      type: 'function', name: 'wait',
      // same schema, keys in a DIFFERENT order (properties b before a; type last)
      parameters: { properties: { b: { type: 'integer' }, a: { type: 'string' } }, type: 'object' },
    };
    let out;
    assert.doesNotThrow(() => {
      out = responsesToChat({ tools: [topLevel], input: [{ type: 'additional_tools', tools: [mirrored] }] });
    }, 'key-order-only difference must not be treated as a conflict');
    assert.deepEqual(out.tools.map(entry => entry.function.name), ['wait']);
  });

  it('deduplicates a mirrored tool when required/enum array order differs (no false 400)', () => {
    // The array-order residue of the #217 key-order fix: required/enum are
    // semantically unordered in JSON Schema, so a tool mirrored with the same
    // required entries in a different order is the same tool and must dedup.
    const topLevel = {
      type: 'function', name: 'q',
      parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
    };
    const mirrored = {
      type: 'function', name: 'q',
      parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['b', 'a'] },
    };
    let out;
    assert.doesNotThrow(() => {
      out = responsesToChat({ tools: [topLevel], input: [{ type: 'additional_tools', tools: [mirrored] }] });
    }, 'required array-order difference must not be treated as a conflict');
    assert.deepEqual(out.tools.map(entry => entry.function.name), ['q']);
  });

  it('fails closed when flattened Responses tool names collide', () => {
    assert.throws(() => responsesToChat({
      tools: [{ type: 'function', name: 'mcp__ads__query', parameters: { type: 'object', properties: {} } }],
      input: [{
        type: 'additional_tools',
        tools: [{
          type: 'namespace',
          name: 'mcp__ads',
          tools: [{ type: 'function', name: 'query', parameters: { type: 'object', properties: { days: { type: 'integer' } } } }],
        }],
      }],
    }), /ambiguous Responses tool name/i);
  });

  it('normalizes a flat namespaced function tool_choice from Responses Lite', () => {
    const out = responsesToChat({
      input: [{
        type: 'additional_tools',
        tools: [{
          type: 'namespace',
          name: 'mcp__amazon_ads',
          tools: [{ type: 'function', name: 'query_campaigns', parameters: { type: 'object', properties: {} } }],
        }],
      }],
      tool_choice: { type: 'function', name: 'query_campaigns', namespace: 'mcp__amazon_ads' },
    });
    assert.deepEqual(out.tool_choice, {
      type: 'function',
      function: { name: 'mcp__amazon_ads__query_campaigns' },
    });
  });

  it('encodes namespace metadata on function and custom history items', () => {
    const out = responsesToChat({
      input: [
        { type: 'function_call', call_id: 'call_function', name: 'query_campaigns', namespace: 'mcp__amazon_ads', arguments: '{"days":7}' },
        { type: 'function_call_output', call_id: 'call_function', output: 'ok' },
        { type: 'custom_tool_call', call_id: 'call_custom', name: 'raw_query', namespace: 'mcp__amazon_ads', input: 'SELECT 1' },
        { type: 'custom_tool_call_output', call_id: 'call_custom', output: 'done' },
      ],
    });
    assert.equal(out.messages[0].tool_calls[0].function.name, 'mcp__amazon_ads__query_campaigns');
    assert.equal(out.messages[2].tool_calls[0].function.name, 'mcp__amazon_ads__raw_query');
    assert.deepEqual(out.messages[1], { role: 'tool', tool_call_id: 'call_function', content: 'ok' });
    assert.deepEqual(out.messages[3], { role: 'tool', tool_call_id: 'call_custom', content: 'done' });
  });

  it('maps a developer-role message to system (Codex/o-series instruction channel)', () => {
    // developer is OpenAI's system-replacement role. It must become role:system so
    // it keeps system priority AND is seen by neutralizeClientIdentity downstream
    // (which only inspects role:system). Otherwise a developer message with
    // competitor-identity wording would bypass the upstream 529 fingerprint gate.
    const out = responsesToChat({
      input: [
        { type: 'message', role: 'developer', content: 'You are a coding agent. Follow AGENTS.md.' },
        { type: 'message', role: 'user', content: 'go' },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: 'system', content: 'You are a coding agent. Follow AGENTS.md.' },
      { role: 'user', content: 'go' },
    ]);
  });

  it('treats a bare {role, content} input item (no explicit type) as a message (Codex, #219)', () => {
    // OpenAI Responses input items may omit `type: "message"` — Codex sends bare
    // {role, content}. They must NOT be dropped (that produced an empty messages
    // array upstream → UPSTREAM_INTERNAL). Tool-oriented items (no `role`) still
    // route to their own handlers, so this only rescues real messages.
    const out = responsesToChat({
      input: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('maps function_call and function_call_output items to chat tool turns', () => {
    const out = responsesToChat({
      input: [
        { type: 'message', role: 'user', content: 'List files' },
        { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'README.md' },
      ],
    });
    assert.equal(out.messages[1].role, 'assistant');
    assert.deepEqual(out.messages[1].tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
    ]);
    assert.deepEqual(out.messages[2], { role: 'tool', tool_call_id: 'call_1', content: 'README.md' });
  });

  it('preserves falsy Responses tool arguments and outputs', () => {
    const out = responsesToChat({
      input: [
        { type: 'function_call', call_id: 'call_empty', name: 'noop', arguments: '' },
        { type: 'function_call_output', call_id: 'call_empty', output: false },
        { type: 'function_call', call_id: 'call_zero', name: 'count', function: { arguments: 0 } },
        { type: 'function_call_output', call_id: 'call_zero', output: 0 },
      ],
    });
    assert.deepEqual(out.messages[0].tool_calls, [
      { id: 'call_empty', type: 'function', function: { name: 'noop', arguments: '' } },
    ]);
    assert.deepEqual(out.messages[1], { role: 'tool', tool_call_id: 'call_empty', content: 'false' });
    assert.deepEqual(out.messages[2].tool_calls, [
      { id: 'call_zero', type: 'function', function: { name: 'count', arguments: '0' } },
    ]);
    assert.deepEqual(out.messages[3], { role: 'tool', tool_call_id: 'call_zero', content: '0' });
  });
});

describe('chatToResponse', () => {
  it('maps a non-stream text chat completion to a Response object', () => {
    const response = chatToResponse({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.equal(response.id, 'resp_test');
    assert.equal(response.object, 'response');
    assert.equal(response.status, 'completed');
    assert.deepEqual(response.output[0], {
      type: 'message',
      id: 'msg_test',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hi', annotations: [] }],
    });
    assert.deepEqual(response.usage, {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { text_tokens: 10, audio_tokens: 0, image_tokens: 0, cached_tokens: 0 },
      output_tokens_details: { text_tokens: 2, audio_tokens: 0, reasoning_tokens: 0 },
    });
  });

  it('derives text_tokens by subtracting cached/reasoning from the totals', () => {
    const response = chatToResponse({
      id: 'chatcmpl_2',
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
        prompt_tokens_details: { cached_tokens: 30, image_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    // input text_tokens = 100 - 30 cached; output text_tokens = 40 - 12 reasoning.
    assert.deepEqual(response.usage, {
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
      input_tokens_details: { text_tokens: 70, audio_tokens: 0, image_tokens: 5, cached_tokens: 30 },
      output_tokens_details: { text_tokens: 28, audio_tokens: 0, reasoning_tokens: 12 },
    });
  });

  it('prefers an explicit upstream text_tokens over the derived subtraction', () => {
    const response = chatToResponse({
      id: 'chatcmpl_3',
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 30, text_tokens: 65 },
        completion_tokens_details: { reasoning_tokens: 12, text_tokens: 25 },
      },
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.equal(response.usage.input_tokens_details.text_tokens, 65, 'explicit input text_tokens wins over 100-30');
    assert.equal(response.usage.output_tokens_details.text_tokens, 25, 'explicit output text_tokens wins over 40-12');
  });

  it('maps chat tool_calls to function_call output items', () => {
    const response = chatToResponse({
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    // A tool-call turn is `completed`, not `incomplete` — `incomplete` is
    // reserved for truncation (length/content_filter), matching the stream path.
    assert.equal(response.status, 'completed');
    assert.equal(response.incomplete_details, undefined);
    assert.equal(response.output[0].type, 'function_call');
    assert.equal(response.output[0].call_id, 'call_1');
    assert.equal(response.output[0].name, 'Bash');
    assert.equal(response.output[0].arguments, '{"command":"pwd"}');
  });

  it('maps a truncated (length) completion to status incomplete with details', () => {
    const response = chatToResponse({
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
      usage: { input_tokens: 5, output_tokens: 100, total_tokens: 105 },
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.equal(response.status, 'incomplete');
    assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
  });

  it('preserves flattened metadata for custom and namespace tools', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Use native tools',
      tools: [
        { type: 'custom', name: 'runner', description: 'Run shell' },
        {
          type: 'namespace',
          name: 'mcp__desktop_commander',
          tools: [
            { type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object' } },
          ],
        },
      ],
    }, {
      async handleChatCompletions(body) {
        assert.equal(body.tools[0].function.name, 'runner');
        assert.equal(body.tools[1].function.name, 'mcp__desktop_commander__read_file');
        return {
          status: 200,
          body: {
            created: 123,
            model: body.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_custom', type: 'function', function: { name: 'runner', arguments: '{"input":"echo hi"}' } },
                  { id: 'call_ns', type: 'function', function: { name: 'mcp__desktop_commander__read_file', arguments: '{"path":"README.md"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          },
        };
      },
    });
    assert.equal(result.status, 200);
    const response = result.body;
    assert.equal(response.output[0].type, 'custom_tool_call');
    assert.equal(response.output[0].name, 'runner');
    assert.equal(response.output[0].input, 'echo hi');
    assert.equal(response.output[1].type, 'function_call');
    assert.equal(response.output[1].name, 'read_file');
    assert.equal(response.output[1].namespace, 'mcp__desktop_commander');
  });

  it('rejects hosted web_search (both stream modes) instead of reporting an unexecuted search as completed', async () => {
    // The reviewer's counterexample: no executor runs, yet the response used to
    // carry web_search_call.status=completed (and a completed terminal). There is
    // no dispatch loop on this route, so the request must fail up front with an
    // actionable error — never reach the model at all.
    for (const type of ['web_search', 'web_search_preview']) {
      for (const stream of [false, true]) {
        let modelCalled = false;
        const result = await handleResponses({
          model: 'claude-sonnet-4.6',
          input: 'search',
          stream,
          tools: [{ type, description: 'Search the web' }],
        }, {
          async handleChatCompletions() {
            modelCalled = true;
            throw new Error('must not call the model for an unsupported hosted tool');
          },
        });
        assert.equal(result.status, 400, `${type} stream=${stream}`);
        assert.equal(result.stream, undefined, 'a rejected request never opens an SSE stream');
        assert.equal(result.body.error.type, 'invalid_request_error');
        assert.equal(result.body.error.param, 'tools');
        assert.equal(result.body.error.code, 'unsupported_hosted_tool');
        assert.match(result.body.error.message, /does not execute server-side searches/);
        assert.equal(modelCalled, false, 'no credits are spent on a turn the proxy cannot serve truthfully');
      }
    }
  });

  it('rejects a hosted-search tool_choice even when no tool declaration is present', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'search',
      tool_choice: { type: 'web_search' },
    }, {
      async handleChatCompletions() {
        throw new Error('must not call the model');
      },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.param, 'tool_choice');
    assert.equal(result.body.error.code, 'unsupported_hosted_tool');
  });

  it('rejects hosted search hidden in additional_tools or a namespace', async () => {
    const cases = [
      {
        body: {
          input: [
            { type: 'additional_tools', tools: [{ type: 'web_search_preview' }] },
            { type: 'message', role: 'user', content: 'search' },
          ],
        },
        param: 'input',
      },
      {
        body: {
          input: 'search',
          tools: [{ type: 'namespace', name: 'web', tools: [{ type: 'web_search' }] }],
        },
        param: 'tools',
      },
    ];
    for (const { body, param } of cases) {
      let modelCalled = false;
      const result = await handleResponses({ model: 'claude-sonnet-4.6', ...body }, {
        async handleChatCompletions() {
          modelCalled = true;
          throw new Error('must not call the model');
        },
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'unsupported_hosted_tool');
      assert.equal(result.body.error.param, param);
      assert.equal(modelCalled, false);
    }
  });

  it('rejects_versioned_hosted_search_before_model_dispatch', async () => {
    // OpenAI ships dated snapshots of the same hosted tool next to the
    // unversioned aliases. They ask THIS SERVER to execute the search just the
    // same, so every position that can carry a tool declaration must refuse
    // them before the model runs — an exact-match set used to let them through
    // and flattenResponseTool then dropped them silently.
    const versionedTypes = ['web_search_preview_2025_03_11', 'web_search_2025_08_26'];
    for (const type of versionedTypes) {
      const cases = [
        {
          position: 'top-level tools',
          body: { tools: [{ type, description: 'Search the web' }] },
          param: 'tools',
        },
        {
          position: 'additional_tools',
          body: {
            input: [
              { type: 'additional_tools', tools: [{ type }] },
              { type: 'message', role: 'user', content: 'search' },
            ],
          },
          param: 'input',
        },
        {
          position: 'namespace child',
          body: { tools: [{ type: 'namespace', name: 'web', tools: [{ type }] }] },
          param: 'tools',
        },
        {
          position: 'tool_choice',
          body: { tool_choice: { type } },
          param: 'tool_choice',
        },
      ];
      for (const stream of [false, true]) {
        for (const { position, body, param } of cases) {
          let modelCalled = false;
          const result = await handleResponses({ model: 'claude-sonnet-4.6', input: 'search', stream, ...body }, {
            async handleChatCompletions() {
              modelCalled = true;
              throw new Error('must not call the model for a versioned hosted tool');
            },
          });
          assert.equal(result.status, 400, `${type} in ${position} stream=${stream}`);
          assert.equal(result.stream, undefined, 'a rejected request never opens an SSE stream');
          assert.equal(result.body.error.type, 'invalid_request_error');
          assert.equal(result.body.error.code, 'unsupported_hosted_tool');
          assert.equal(result.body.error.param, param, `${type} in ${position}`);
          assert.match(result.body.error.message, /does not execute server-side searches/);
          assert.equal(modelCalled, false, 'no model turn runs for a hosted search this proxy cannot execute');
        }
      }
    }
  });

  it('keeps a client-declared function tool named web_search as a normal function_call', async () => {
    // The reviewer's control: an ordinary client function keeps the original
    // semantics. Only the HOSTED tool type is rejected.
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'search',
      tools: [{
        type: 'function',
        name: 'web_search',
        description: 'Client-run search',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
    }, {
      async handleChatCompletions(body) {
        assert.equal(body.tools[0].function.name, 'web_search');
        return {
          status: 200,
          body: {
            created: 123,
            model: body.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"codex"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          },
        };
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.output[0].type, 'function_call');
    assert.equal(result.body.output[0].name, 'web_search');
    assert.equal(result.body.output[0].call_id, 'call_search');
    assert.equal(result.body.output[0].arguments, '{"query":"codex"}');
    assert.ok(result.body.output.every(item => item.type !== 'web_search_call'));
  });

  it('rejects every server-executed tool type instead of dropping it silently', async () => {
    // ReviewConnectRouter P2-1: a client that declared a server-executed tool got
    // a perfectly normal answer with the tool gone. `file_search` /
    // `computer_use_preview` / `mcp` were dropped without a trace and every other
    // hosted type fell through the catch-all (`log.warn` + `return []`). This is
    // the same silent non-execution the hosted-search gate removes, minus the
    // fake receipt: the request must fail before dispatch, in every position a
    // tool declaration can hide in.
    const serverSideTypes = [
      'file_search',
      'computer_use_preview',
      'mcp',
      'code_interpreter',
      'image_generation',
      'local_shell',
      'shell',
      'apply_patch',
    ];
    const cases = [
      {
        position: 'top-level tools',
        param: 'tools',
        bodyFor: type => ({ tools: [{ type }] }),
      },
      {
        position: 'additional_tools',
        param: 'input',
        bodyFor: type => ({
          input: [
            { type: 'additional_tools', tools: [{ type }] },
            { type: 'message', role: 'user', content: 'run it' },
          ],
        }),
      },
      {
        position: 'namespace child',
        param: 'tools',
        bodyFor: type => ({ tools: [{ type: 'namespace', name: 'hosted', tools: [{ type }] }] }),
      },
      {
        position: 'tool_choice',
        param: 'tool_choice',
        bodyFor: type => ({ tool_choice: { type } }),
      },
    ];
    for (const type of serverSideTypes) {
      for (const stream of [false, true]) {
        for (const { position, param, bodyFor } of cases) {
          let modelCalled = false;
          const result = await handleResponses({
            model: 'claude-sonnet-4.6',
            input: 'run it',
            stream,
            ...bodyFor(type),
          }, {
            async handleChatCompletions() {
              modelCalled = true;
              throw new Error('must not call the model for a server-executed tool');
            },
          });
          assert.equal(result.status, 400, `${type} in ${position} stream=${stream}`);
          assert.equal(result.stream, undefined, 'a rejected request never opens an SSE stream');
          assert.equal(result.body.error.type, 'invalid_request_error');
          assert.equal(result.body.error.code, 'unsupported_server_side_tool', `${type} in ${position}`);
          assert.equal(result.body.error.param, param, `${type} in ${position}`);
          assert.match(result.body.error.message, /executor/i);
          assert.ok(
            result.body.error.message.includes(type),
            `the message names the rejected type ${type}`,
          );
          for (const listed of serverSideTypes) {
            assert.ok(
              result.body.error.message.includes(listed),
              `the message lists every rejected type, missing ${listed}`,
            );
          }
          assert.equal(modelCalled, false, 'no credits are spent on a turn whose tool this proxy cannot execute');
        }
      }
    }
  });

  it('keeps a client-declared function tool named apply_patch as an ordinary function tool', async () => {
    // The control for the ambiguous spelling: `{type:'apply_patch'}` is the
    // server-executed hosted tool, but `{type:'function', name:'apply_patch'}` is
    // how codex clients declare their own patch tool. Only `tool.type` decides.
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'patch it',
      tools: [{
        type: 'function',
        name: 'apply_patch',
        description: 'Client-run patch',
        parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] },
      }],
      tool_choice: { type: 'function', name: 'apply_patch' },
    }, {
      async handleChatCompletions(body) {
        assert.equal(body.tools[0].function.name, 'apply_patch');
        assert.equal(body.tool_choice.type, 'function');
        assert.equal(body.tool_choice.function.name, 'apply_patch');
        return {
          status: 200,
          body: {
            created: 123,
            model: body.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: '{"patch":"*** Begin Patch"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          },
        };
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.output[0].type, 'function_call');
    assert.equal(result.body.output[0].name, 'apply_patch');
    assert.equal(result.body.output[0].call_id, 'call_patch');
  });

  it('leaves a request without tools untouched by the server-side gate', async () => {
    let forwarded = null;
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Hello',
    }, {
      async handleChatCompletions(body) {
        forwarded = body;
        return {
          status: 200,
          body: {
            created: 123,
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          },
        };
      },
    });
    assert.equal(result.status, 200);
    assert.equal(forwarded.tools, undefined);
    assert.equal(forwarded.tool_choice, undefined);
  });

  it('still drops a genuinely unknown tool type with a warning', async () => {
    // The catch-all stays lenient for types this bridge has never heard of —
    // but it must still emit the warning, not swallow the tool in silence.
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    let forwarded = null;
    let result;
    try {
      result = await handleResponses({
        model: 'claude-sonnet-4.6',
        input: 'Hello',
        tools: [
          { type: 'quantum_flux' },
          { type: 'function', name: 'do_thing', parameters: { type: 'object' } },
        ],
      }, {
        async handleChatCompletions(body) {
          forwarded = body;
          return {
            status: 200,
            body: {
              created: 123,
              model: body.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          };
        },
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.status, 200);
    assert.equal(forwarded.tools.length, 1);
    assert.equal(forwarded.tools[0].function.name, 'do_thing');
    assert.ok(
      warnings.some(line => line.includes('quantum_flux') && line.includes('unknown tool type')),
      `expected a warning naming the dropped type, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('rejects dated snapshots of server-executed tools instead of dropping them', async () => {
    // OpenAI ships dated snapshots next to the unversioned aliases
    // (`code_interpreter_2025_03_11`, `web_search_2025_08_26`). A snapshot of a
    // server-executed tool asks THIS SERVER to execute it just the same, but the
    // exact-match set sent it to the catch-all, which warned and dropped it — a
    // 200 with the tool gone. Stripping the trailing `_YYYY_MM_DD` and re-testing
    // the set covers every current and future snapshot of a member without
    // touching unrelated types.
    const serverSideTypes = [
      'file_search',
      'computer_use_preview',
      'mcp',
      'code_interpreter',
      'image_generation',
      'local_shell',
      'shell',
      'apply_patch',
    ];
    const cases = [
      {
        position: 'top-level tools',
        param: 'tools',
        bodyFor: type => ({ tools: [{ type }] }),
      },
      {
        position: 'additional_tools',
        param: 'input',
        bodyFor: type => ({
          input: [
            { type: 'additional_tools', tools: [{ type }] },
            { type: 'message', role: 'user', content: 'run it' },
          ],
        }),
      },
      {
        position: 'namespace child',
        param: 'tools',
        bodyFor: type => ({ tools: [{ type: 'namespace', name: 'hosted', tools: [{ type }] }] }),
      },
      {
        position: 'tool_choice',
        param: 'tool_choice',
        bodyFor: type => ({ tool_choice: { type } }),
      },
    ];
    for (const type of serverSideTypes) {
      const versioned = `${type}_2025_03_11`;
      for (const stream of [false, true]) {
        for (const { position, param, bodyFor } of cases) {
          let modelCalled = false;
          const result = await handleResponses({
            model: 'claude-sonnet-4.6',
            input: 'run it',
            stream,
            ...bodyFor(versioned),
          }, {
            async handleChatCompletions() {
              modelCalled = true;
              throw new Error('must not call the model for a dated server-executed tool');
            },
          });
          assert.equal(result.status, 400, `${versioned} in ${position} stream=${stream}`);
          assert.equal(result.body.error.code, 'unsupported_server_side_tool', `${versioned} in ${position}`);
          assert.equal(result.body.error.param, param, `${versioned} in ${position}`);
          assert.ok(
            result.body.error.message.includes(versioned),
            `the message names the rejected snapshot ${versioned}`,
          );
          assert.equal(modelCalled, false, 'no model turn runs for a snapshot this proxy cannot execute');
        }
      }
    }

    // A versioned HOSTED search keeps its own gate and error code.
    let hostedModelCalled = false;
    const hosted = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'search',
      tools: [{ type: 'web_search_2025_03_11' }],
    }, {
      async handleChatCompletions() {
        hostedModelCalled = true;
        throw new Error('must not call the model for a hosted search');
      },
    });
    assert.equal(hosted.status, 400);
    assert.equal(hosted.body.error.code, 'unsupported_hosted_tool');
    assert.equal(hosted.body.error.param, 'tools');
    assert.equal(hostedModelCalled, false);

    // A dated type that is not a member stays unknown: warn + drop, not 400.
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    let forwarded = null;
    let junk;
    try {
      junk = await handleResponses({
        model: 'claude-sonnet-4.6',
        input: 'Hello',
        tools: [{ type: 'foobar_2025_03_11' }],
      }, {
        async handleChatCompletions(body) {
          forwarded = body;
          return {
            status: 200,
            body: {
              created: 123,
              model: body.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            },
          };
        },
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(junk.status, 200);
    assert.equal(forwarded.tools, undefined);
    assert.ok(
      warnings.some(line => line.includes('foobar_2025_03_11') && line.includes('unknown tool type')),
      `expected a warning naming the dropped type, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('rejects a server-executed tool hidden behind a second namespace child key', async () => {
    // The walker used to recurse into the FIRST array-valued child key only,
    // while flattenResponseTool picks the first truthy one. A namespace carrying
    // both `tools: []` and `children: [{type:'mcp'}]` therefore walked the empty
    // array, missed the server-executed child, and the request returned 200 with
    // that tool gone and not even a warning. Walk every child key the schema
    // allows so a hidden server-side tool cannot slip past the gate.
    const namespaces = [
      { name: 'a', tools: [], children: [{ type: 'mcp' }] },
      {
        name: 'b',
        tools: [{ type: 'function', name: 'ok', parameters: { type: 'object' } }],
        children: [{ type: 'file_search' }],
      },
      { name: 'c', functions: [], items: [{ type: 'code_interpreter' }] },
    ];
    for (const namespace of namespaces) {
      let modelCalled = false;
      const result = await handleResponses({
        model: 'claude-sonnet-4.6',
        input: 'run it',
        tools: [{ type: 'namespace', ...namespace }],
      }, {
        async handleChatCompletions() {
          modelCalled = true;
          throw new Error('must not call the model for a hidden server-executed tool');
        },
      });
      assert.equal(result.status, 400, `namespace ${namespace.name}`);
      assert.equal(result.body.error.code, 'unsupported_server_side_tool', `namespace ${namespace.name}`);
      assert.equal(result.body.error.param, 'tools', `namespace ${namespace.name}`);
      assert.equal(modelCalled, false, `namespace ${namespace.name}: no model turn runs`);
    }

    // The same shape inside `additional_tools` is scanned by the same walker.
    let additionalModelCalled = false;
    const additional = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: [
        {
          type: 'additional_tools',
          tools: [{ type: 'namespace', name: 'd', tools: [], children: [{ type: 'mcp' }] }],
        },
        { type: 'message', role: 'user', content: 'run it' },
      ],
    }, {
      async handleChatCompletions() {
        additionalModelCalled = true;
        throw new Error('must not call the model for a hidden server-executed tool');
      },
    });
    assert.equal(additional.status, 400);
    assert.equal(additional.body.error.code, 'unsupported_server_side_tool');
    assert.equal(additional.body.error.param, 'input');
    assert.equal(additionalModelCalled, false);
  });

  it('round-trips Responses Lite additional_tools metadata', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: [
        {
          type: 'additional_tools',
          tools: [
            { type: 'custom', name: 'exec', description: 'Run code.' },
            {
              type: 'namespace',
              name: 'mcp__amazon_ads',
              tools: [{ type: 'function', name: 'query_campaigns', parameters: { type: 'object', properties: {} } }],
            },
          ],
        },
        { type: 'message', role: 'user', content: 'Run it' },
      ],
      tool_choice: { type: 'function', name: 'query_campaigns', namespace: 'mcp__amazon_ads' },
    }, {
      async handleChatCompletions(body) {
        assert.deepEqual(body.messages, [{ role: 'user', content: 'Run it' }]);
        assert.deepEqual(body.tools.map(tool => tool.function.name), ['exec', 'mcp__amazon_ads__query_campaigns']);
        assert.deepEqual(body.tool_choice, {
          type: 'function',
          function: { name: 'mcp__amazon_ads__query_campaigns' },
        });
        return {
          status: 200,
          body: {
            created: 123,
            model: body.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_exec', type: 'function', function: { name: 'exec', arguments: '{"input":"echo hi"}' } },
                  { id: 'call_query', type: 'function', function: { name: 'mcp__amazon_ads__query_campaigns', arguments: '{"days":7}' } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          },
        };
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.output[0].type, 'custom_tool_call');
    assert.equal(result.body.output[0].name, 'exec');
    assert.equal(result.body.output[0].input, 'echo hi');
    assert.equal(result.body.output[1].type, 'function_call');
    assert.equal(result.body.output[1].name, 'query_campaigns');
    assert.equal(result.body.output[1].namespace, 'mcp__amazon_ads');
  });

  it('maps non-stream reasoning_content to a reasoning output item', () => {
    const response = chatToResponse({
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'thinking', content: 'answer' }, finish_reason: 'stop' }],
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.equal(response.output[0].type, 'reasoning');
    assert.equal(response.output[0].summary[0].text, 'thinking');
    assert.equal(response.output[1].type, 'message');
  });

  it('omits empty assistant message items for function-call-only responses', () => {
    const response = chatToResponse({
      created: 123,
      model: 'claude-sonnet-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    }, 'claude-sonnet-4.6', 'resp_test', 'msg_test');
    assert.deepEqual(response.output.map(item => item.type), ['function_call']);
  });
});

describe('handleResponses streaming', () => {
  it('rejects unbridged server-side tools (file_search, computer_use_preview, mcp) instead of failing the model turn silently', async () => {
    // Dropping these used to keep the request alive at the cost of the tool:
    // the client declared a server-executed tool, got a normal answer, and had
    // no way to learn the tool never existed. Refuse before dispatch instead —
    // the client still has real function tools and can retry without them.
    for (const type of ['file_search', 'computer_use_preview', 'mcp']) {
      let modelCalled = false;
      const result = await handleResponses({
        model: 'claude-sonnet-4.6',
        input: 'Hello',
        stream: false,
        tools: [
          { type, ...(type === 'mcp' ? { server_label: 'foo' } : {}) },
          { type: 'function', name: 'do_thing', parameters: { type: 'object' } },
        ],
      }, {
        async handleChatCompletions() {
          modelCalled = true;
          throw new Error('must not call the model for an unbridged server-side tool');
        },
      });
      assert.equal(result.status, 400, type);
      assert.equal(result.body.error.code, 'unsupported_server_side_tool', type);
      assert.equal(result.body.error.param, 'tools', type);
      assert.equal(modelCalled, false, `${type}: no model turn runs`);
    }
  });

  it('rejects a forced tool_choice naming a server-side tool instead of dropping the choice', async () => {
    // Dropping the forced choice left the model free to answer normally, so the
    // caller could not tell its forced tool had been discarded. `tool_choice`
    // naming a type this proxy cannot execute is now the same 400 as declaring
    // it — here with no declaration at all, mirroring the hosted-search gate.
    let modelCalled = false;
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Hello',
      stream: false,
      tools: [
        { type: 'function', name: 'do_thing', parameters: { type: 'object' } },
      ],
      tool_choice: { type: 'file_search' },
    }, {
      async handleChatCompletions() {
        modelCalled = true;
        throw new Error('must not call the model');
      },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.equal(result.body.error.code, 'unsupported_server_side_tool');
    assert.equal(result.body.error.param, 'tool_choice');
    assert.equal(modelCalled, false);
  });

  it('rejects a forced function tool_choice absent from tools instead of pruning it', async () => {
    // A07/KH-003: a forced function that is not declared used to be dropped,
    // leaving the model free to answer as if nothing was forced. It must be a
    // 400 before any model turn.
    let modelCalled = false;
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Hello',
      stream: false,
      tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'Bash' },
    }, {
      async handleChatCompletions() {
        modelCalled = true;
        throw new Error('must not call the model');
      },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.equal(result.body.error.param, 'tool_choice');
    assert.equal(result.body.error.code, 'tool_choice_tool_not_declared');
    assert.equal(modelCalled, false);
  });

  it('emits the Responses text event sequence and response.completed', async () => {
    const result = await handleResponses({ model: 'claude-sonnet-4.6', input: 'Hello', stream: true }, {
      async handleChatCompletions(body) {
        assert.equal(body.stream, true);
        assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.write(chatChunk({ id: 'chat_1', object: 'chat.completion.chunk', created: 123, model: body.model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
            res.write('data: [DONE]\n\n');
            res.end();
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assertSequenceNumbers(events);
    assert.equal(events[0].data.response.status, 'in_progress');
    assert.equal(events[1].data.response.status, 'in_progress');
    assert.equal(events[4].data.delta, 'Hel');
    assert.equal(events[5].data.delta, 'lo');
    assert.equal(events[6].data.text, 'Hello');
    assert.equal(events.at(-1).data.response.status, 'completed');
    assert.deepEqual(events.at(-1).data.response.usage, {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      input_tokens_details: { text_tokens: 3, audio_tokens: 0, image_tokens: 0, cached_tokens: 0 },
      output_tokens_details: { text_tokens: 2, audio_tokens: 0, reasoning_tokens: 0 },
    });
  });

  it('emits function_call events before the message and still completes on tool_calls finish', async () => {
    const result = await handleResponses({ model: 'claude-sonnet-4.6', input: 'Use a tool', stream: true }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [], usage: { input_tokens: 4, completion_tokens: 1, total_tokens: 5 } }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assertSequenceNumbers(events);
    assert.equal(events[2].data.item.type, 'function_call');
    assert.equal(events[5].data.arguments, '{"command":"pwd"}');
    assert.equal(events[6].data.item.call_id, 'call_1');
    assert.equal(events.at(-1).data.response.status, 'completed');
    assert.equal(events.at(-1).data.response.output[0].type, 'function_call');
    assert.equal(events.at(-1).data.response.output.length, 1);
  });

  it('preserves Responses-native tool metadata in streaming output items', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Use native tools',
      stream: true,
      tools: [
        { type: 'custom', name: 'runner', description: 'Run shell' },
        {
          type: 'namespace',
          name: 'mcp__desktop_commander',
          tools: [
            { type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object' } },
          ],
        },
      ],
    }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_custom', type: 'function', function: { name: 'runner', arguments: '{"input":"echo hi"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_ns', type: 'function', function: { name: 'mcp__desktop_commander__read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    const doneItems = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item);
    assert.equal(doneItems[0].type, 'custom_tool_call');
    assert.equal(doneItems[0].name, 'runner');
    assert.equal(doneItems[0].input, 'echo hi');
    assert.equal(doneItems[1].type, 'function_call');
    assert.equal(doneItems[1].name, 'read_file');
    assert.equal(doneItems[1].namespace, 'mcp__desktop_commander');
  });

  it('streams a client-declared function named web_search as a normal function_call', async () => {
    // Control for the rejection above: the HOSTED tool type is refused, but an
    // ordinary client function called web_search keeps the normal wire shape.
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'search',
      stream: true,
      tools: [{
        type: 'function',
        name: 'web_search',
        description: 'Client-run search',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
    }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"codex"}' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    const added = events.find(e => e.event === 'response.output_item.added').data.item;
    assert.equal(added.type, 'function_call');
    assert.equal(added.call_id, 'call_search');
    const done = events.find(e => e.event === 'response.output_item.done').data.item;
    assert.equal(done.type, 'function_call');
    assert.equal(done.name, 'web_search');
    assert.equal(done.arguments, '{"query":"codex"}');
    const deltas = events
      .filter(e => e.event === 'response.function_call_arguments.delta')
      .map(e => e.data.delta)
      .join('');
    assert.equal(deltas, '{"query":"codex"}', 'arguments stream through the normal function-call channel');
    const allItems = events.flatMap(e => (e.data?.item
      ? [e.data.item]
      : (Array.isArray(e.data?.response?.output) ? e.data.response.output : [])));
    assert.ok(allItems.every(item => item.type !== 'web_search_call'), 'no hosted search is reported as executed');
    assert.equal(events.at(-1).data.response.status, 'completed');
  });

  it('recovers Responses-native metadata when the streaming tool name arrives later', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'Use native tools',
      stream: true,
      tools: [
        { type: 'custom', name: 'runner', description: 'Run shell' },
      ],
    }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_custom', type: 'function', function: { arguments: '{"input":"echo ' } }] }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'runner', arguments: 'hi"}' } }] }, finish_reason: null }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    const doneItem = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item)[0];
    assert.equal(doneItem.type, 'custom_tool_call');
    assert.equal(doneItem.name, 'runner');
    assert.equal(doneItem.input, 'echo hi');
  });

  it('does not crash when a streaming tool delta never includes a name', async () => {
    const result = await handleResponses({ model: 'claude-sonnet-4.6', input: 'Use a tool', stream: true }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_args_only', type: 'function', function: { arguments: '{"value":0}' } }] }, finish_reason: null }] }));
            // The terminal chunk every real upstream sends. Without it the stream
            // reads as one that died mid-answer (→ response.incomplete), which would
            // make this case about stream termination instead of the nameless delta
            // it is meant to cover.
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    assert.equal(events.at(-1).event, 'response.completed');
    const doneItem = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item)[0];
    assert.equal(doneItem.type, 'function_call');
    assert.equal(doneItem.call_id, 'call_args_only');
    assert.equal(doneItem.name, 'unknown');
    assert.equal(doneItem.arguments, '{"value":0}');
  });

  it('emits error event and closes when the upstream stream throws', async () => {
    const result = await handleResponses({ input: 'Hello', stream: true }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler() {
            throw new Error('boom');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), ['response.created', 'response.in_progress', 'response.failed']);
    assertSequenceNumbers(events);
    assert.equal(events[2].data.response.error.message, 'boom');
    assert.equal(res.writableEnded, true);
  });

  it('translates chat reasoning_content deltas to Responses reasoning events', async () => {
    const result = await handleResponses({ model: 'claude-sonnet-4.6', input: 'Hello', stream: true }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { reasoning_content: 'plan' }, finish_reason: null }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    assertSequenceNumbers(events);
    assert.ok(events.some(e => e.event === 'response.reasoning_summary_text.delta' && e.data.delta === 'plan'));
    assert.equal(events.at(-1).data.response.output[0].type, 'reasoning');
  });
});

describe('H-1 (audit 2026-07-13): input_image string image_url normalizes to object shape', () => {
  it('string image_url (data: URI) becomes { image_url: { url } } so downstream .url works', () => {
    const { messages } = responsesToChat({
      model: 'gpt-4o',
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: '描述这张图' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ] }],
    });
    const parts = messages.find(m => m.role === 'user').content;
    const img = parts.find(p => p.type === 'image_url');
    assert.ok(img, 'image part present');
    assert.equal(typeof img.image_url, 'object', 'image_url must be an object, not a bare string');
    assert.equal(img.image_url.url, 'data:image/png;base64,AAAA', 'downstream reads .url');
  });

  it('preserves detail and still handles object-form image_url defensively', () => {
    const { messages } = responsesToChat({
      model: 'gpt-4o',
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'https://x/y.png', detail: 'high' },
        { type: 'input_image', image_url: { url: 'https://z/w.png' } },
      ] }],
    });
    const parts = messages.find(m => m.role === 'user').content;
    const imgs = parts.filter(p => p.type === 'image_url');
    assert.equal(imgs.length, 2);
    assert.equal(imgs[0].image_url.url, 'https://x/y.png');
    assert.equal(imgs[0].image_url.detail, 'high');
    assert.equal(imgs[1].image_url.url, 'https://z/w.png');
  });

  it('normalizes multimodal function_call_output and custom_tool_call_output items', () => {
    const { messages } = responsesToChat({
      model: 'gpt-4o',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_img',
          output: [
            { type: 'input_text', text: 'Screenshot captured' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,12345' },
          ],
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_custom_img',
          output: [
            { type: 'input_image', image_url: 'https://example.com/test.png' },
          ],
        },
      ],
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'tool');
    assert.equal(messages[0].tool_call_id, 'call_img');
    assert.deepEqual(messages[0].content, [
      { type: 'text', text: 'Screenshot captured' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,12345' } },
    ]);
    assert.equal(messages[1].role, 'tool');
    assert.equal(messages[1].tool_call_id, 'call_custom_img');
    assert.deepEqual(messages[1].content, [
      { type: 'image_url', image_url: { url: 'https://example.com/test.png' } },
    ]);
  });

  it('preserves non-content array tool outputs as JSON string', () => {
    const { messages } = responsesToChat({
      model: 'gpt-4o',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_list',
          output: ['file1.txt', 'file2.txt'],
        },
        {
          type: 'function_call_output',
          call_id: 'call_objects',
          output: [{ name: 'alice' }, { name: 'bob' }],
        },
      ],
    });
    assert.equal(messages[0].content, JSON.stringify(['file1.txt', 'file2.txt']));
    assert.equal(messages[1].content, JSON.stringify([{ name: 'alice' }, { name: 'bob' }]));
  });
});

describe('parallel_tool_calls on /v1/responses (F1, DataAuditTools)', () => {
  // The Responses surface accepted `parallel_tool_calls` and never read it. Forwarding
  // the field is still the whole fix — the chat handler owns the decision: it honours
  // the hint when DEVIN_CONNECT_TOOL_CHOICE=1 and otherwise serves the request while
  // counting the drop. It never refuses it (Codex 0.164 sends the field on every
  // request; a 400 there made the CLI unusable — evidence/CodexParallelFix.md).
  it('forwards the field instead of dropping it', () => {
    assert.equal(responsesToChat({ input: 'hi', parallel_tool_calls: false }).parallel_tool_calls, false);
    assert.equal(responsesToChat({ input: 'hi', parallel_tool_calls: true }).parallel_tool_calls, true);
    assert.equal('parallel_tool_calls' in responsesToChat({ input: 'hi' }), false,
      'absent stays absent — the chat default is unchanged');
  });

  it('hands parallel_tool_calls:false to the chat handler', async () => {
    let captured = null;
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'hi',
      parallel_tool_calls: false,
    }, {
      async handleChatCompletions(body) {
        captured = body;
        return {
          status: 200,
          body: {
            created: 123,
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          },
        };
      },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(captured.parallel_tool_calls, false, 'the chat handler must be able to see the hint');
  });

  it('serves a Codex-shaped request with parallel_tool_calls:false when the passthrough is off', async () => {
    const prevConnect = process.env.DEVIN_CONNECT;
    const prevChoice = process.env.DEVIN_CONNECT_TOOL_CHOICE;
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = [];
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen.push(params);
        return {
          status: 200,
          body: {
            id: 'chatcmpl-test',
            model: 'claude-5-fable-medium',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          },
        };
      },
    });
    try {
      const result = await handleResponses({
        model: 'claude-5-fable-medium',
        input: 'hi',
        tools: [{
          type: 'function',
          name: 'functions__exec',
          description: 'run a command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        }],
        parallel_tool_calls: false,
      }, { handleChatCompletions });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(seen.length, 1, 'the request must reach the model');
      assert.equal(seen[0].parallelToolCalls, false);
    } finally {
      __resetConnectDeps();
      if (prevConnect === undefined) delete process.env.DEVIN_CONNECT;
      else process.env.DEVIN_CONNECT = prevConnect;
      if (prevChoice === undefined) delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
      else process.env.DEVIN_CONNECT_TOOL_CHOICE = prevChoice;
    }
  });
});

describe('parallel_tool_calls honoured path through /v1/responses (F1)', () => {
  const okChat = () => ({
    status: 200,
    body: {
      id: 'chatcmpl-test',
      model: 'claude-5-fable-medium',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    },
  });

  it('passes parallel_tool_calls:true through to the connect layer unchanged', async () => {
    const prevConnect = process.env.DEVIN_CONNECT;
    const prevChoice = process.env.DEVIN_CONNECT_TOOL_CHOICE;
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = [];
    __setConnectDeps({ toChatCompletion: async (params) => { seen.push(params); return okChat(); } });
    try {
      const result = await handleResponses({
        model: 'claude-5-fable-medium',
        input: 'hi',
        parallel_tool_calls: true,
      }, { handleChatCompletions });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(seen.length, 1, 'exactly one connect turn');
      assert.equal(seen[0].parallelToolCalls, true, 'the caller value survives the Responses translation');
    } finally {
      __resetConnectDeps();
      if (prevConnect === undefined) delete process.env.DEVIN_CONNECT;
      else process.env.DEVIN_CONNECT = prevConnect;
      if (prevChoice === undefined) delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
      else process.env.DEVIN_CONNECT_TOOL_CHOICE = prevChoice;
    }
  });

  it('honours parallel_tool_calls:false when DEVIN_CONNECT_TOOL_CHOICE=1', async () => {
    const prevConnect = process.env.DEVIN_CONNECT;
    const prevChoice = process.env.DEVIN_CONNECT_TOOL_CHOICE;
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOOL_CHOICE = '1';
    const seen = [];
    __setConnectDeps({ toChatCompletion: async (params) => { seen.push(params); return okChat(); } });
    try {
      const result = await handleResponses({
        model: 'claude-5-fable-medium',
        input: 'hi',
        parallel_tool_calls: false,
      }, { handleChatCompletions });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].parallelToolCalls, false,
        'the hint must reach buildGetChatMessageRequest, not stop at the Responses allow-list');
    } finally {
      __resetConnectDeps();
      if (prevConnect === undefined) delete process.env.DEVIN_CONNECT;
      else process.env.DEVIN_CONNECT = prevConnect;
      if (prevChoice === undefined) delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
      else process.env.DEVIN_CONNECT_TOOL_CHOICE = prevChoice;
    }
  });
});

// `metadata` (DataAuditTools F4) — the field exists to be ECHOED.
//
// A client tags a request (trace id, tenant) and reads the tag back off the
// response object for its own bookkeeping. Nothing on this route read the field,
// so it vanished behind a 200 with no signal, and a retrieved response could not
// report it either because the store had no slot for it. The contract is OpenAI's:
// a flat map of at most 16 string pairs, keys <= 64 chars, values <= 512 chars.
describe('responses metadata echo and persistence', () => {
  const CALLER = 'api:metadatametadatametadatametada:user:tagger';

  beforeEach(() => resetResponseStore());

  const reply = (content = 'ok') => ({
    status: 200,
    body: { id: 'chat_1', choices: [{ message: { role: 'assistant', content } }] },
  });

  it('echoes request metadata on the response object', async () => {
    const result = await handleResponses(
      { model: 'm', input: 'hi', metadata: { trace_id: 'abc', tenant: 'acme' } },
      { handleChatCompletions: async () => reply(), context: { callerKey: CALLER } },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.metadata, { trace_id: 'abc', tenant: 'acme' });
  });

  it('omits the field entirely when the request omits it — absence stays absent', async () => {
    const result = await handleResponses(
      { model: 'm', input: 'hi' },
      { handleChatCompletions: async () => reply(), context: { callerKey: CALLER } },
    );
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.body, 'metadata'), false);
  });

  it('does not leak the tag into the upstream chat body as an unknown field', async () => {
    const seen = [];
    const result = await handleResponses(
      { model: 'm', input: 'hi', metadata: { tag: 'x' } },
      {
        handleChatCompletions: async (body) => { seen.push(body); return reply(); },
        context: { callerKey: CALLER },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(seen[0], 'metadata'), false,
      'the chat surface drops metadata; forwarding it would be a second silent drop');
    assert.equal(Object.hasOwn(seen[0], '__responseMetadata'), false,
      'the internal carrier must be stripped before the upstream call');
  });

  it('echoes metadata on the streaming response object', async () => {
    const result = await handleResponses({
      model: 'claude-sonnet-4.6',
      input: 'hi',
      stream: true,
      metadata: { trace_id: 'abc' },
    }, {
      async handleChatCompletions(body) {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: { content: 'hi' } }] }));
            res.write(chatChunk({ id: 'chat_1', created: 123, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseEvents(res.body);
    const created = events.find(e => e.event === 'response.created');
    const completed = events.find(e => e.event === 'response.completed');
    assert.ok(created && completed, `terminal events missing: ${events.map(e => e.event).join(',')}`);
    assert.deepEqual(created.data.response.metadata, { trace_id: 'abc' });
    assert.deepEqual(completed.data.response.metadata, { trace_id: 'abc' });
  });

  it('preserves metadata through previous_response_id and GET /v1/responses/{id}', async () => {
    const deps = { handleChatCompletions: async () => reply(), context: { callerKey: CALLER } };
    const first = await handleResponses(
      { model: 'm', input: 'turn 1', metadata: { trace_id: 'abc', tenant: 'acme' } }, deps);
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const second = await handleResponses(
      { model: 'm', previous_response_id: first.body.id, input: 'turn 2' }, deps);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(Object.hasOwn(second.body, 'metadata'), false,
      'metadata belongs to the response that carried it; it is not inherited');

    const retrieved = handleGetResponse(first.body.id, { context: { callerKey: CALLER } });
    assert.equal(retrieved.status, 200, JSON.stringify(retrieved.body));
    assert.deepEqual(retrieved.body.metadata, { trace_id: 'abc', tenant: 'acme' },
      'the chained lookup must not drop the stored tag');
  });

  it('treats an empty map and an explicit null as absent, so POST and GET agree', async () => {
    const deps = { handleChatCompletions: async () => reply(), context: { callerKey: CALLER } };
    for (const metadata of [{}, null]) {
      const result = await handleResponses({ model: 'm', input: 'hi', metadata }, deps);
      assert.equal(result.status, 200, JSON.stringify(metadata));
      assert.equal(Object.hasOwn(result.body, 'metadata'), false, JSON.stringify(metadata));
      const retrieved = handleGetResponse(result.body.id, { context: { callerKey: CALLER } });
      assert.equal(retrieved.status, 200);
      assert.equal(Object.hasOwn(retrieved.body, 'metadata'), false, JSON.stringify(metadata));
    }
  });

  it('rejects metadata that violates the OpenAI contract with a 400 naming the field', async () => {
    const cases = [
      ['not an object', 'abc'],
      ['an array', ['a']],
      ['a non-string value', { a: 1 }],
      ['a key longer than 64 characters', { ['k'.repeat(65)]: 'v' }],
      ['a value longer than 512 characters', { a: 'v'.repeat(513) }],
      ['more than 16 pairs', Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))],
    ];
    for (const [label, metadata] of cases) {
      const result = await handleResponses({ model: 'm', input: 'hi', metadata }, {
        handleChatCompletions: async () => { throw new Error('must not reach the model'); },
        context: { callerKey: CALLER },
      });
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error?.param, 'metadata', label);
    }
  });

  it('accepts the contract maximum and echoes it unchanged', async () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'.repeat(512)]));
    const result = await handleResponses({ model: 'm', input: 'hi', metadata }, {
      handleChatCompletions: async () => reply(), context: { callerKey: CALLER },
    });
    assert.equal(result.status, 200);
    assert.equal(Object.keys(result.body.metadata).length, 16);
    assert.equal(result.body.metadata.k15.length, 512);
  });
});

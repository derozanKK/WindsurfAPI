/**
 * Claude Code 2.1.306 compatibility gaps (evidence/ClientSandboxes.md CL1–CL3).
 *
 * CL1 — thinking blocks: the `signature` key is ALWAYS present ("" when the
 *       upstream supplied none). This is the intended #278 / PR b60ec3d
 *       behaviour, not an accident: strict clients deserialize it as a required
 *       string, so a missing key fails the whole event while "" parses.
 *       Captured 2.1.306 traffic: 7/7 thinking starts carried `signature:""`,
 *       0 signature_delta frames, 11/11 requests HTTP 200 — the real client
 *       accepts the empty string.
 * CL2 — `context_management` (new in 2.1.306, beta context-management-2025-06-27)
 *       must not be dropped in silence: the edit types this bridge can satisfy
 *       are accepted, everything else is a 400 `unsupported_parameter` with an
 *       actionable message.
 * CL3 — `defer_loading` (new in 2.1.306): a schema-less deferred placeholder is
 *       dropped (nothing to load, "never call this tool"), a schema-bearing
 *       deferred tool is forwarded and COUNTED as `tool_defer_loading_ignored`
 *       because the upstream has no tool-loading protocol — never silent.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleMessages,
  openAIToAnthropic,
  validateMessagesRequest,
} from '../src/handlers/messages.js';
import { getCcCompatStats, resetCcCompatStats } from '../src/handlers/cc-compat.js';

function chatChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
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
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseAnthropicEvents(raw) {
  return raw
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const lines = frame.split('\n');
      return {
        event: lines.find(line => line.startsWith('event: '))?.slice(7),
        data: JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'),
      };
    });
}

// The tool list captured from Claude Code 2.1.306 (capture id 37). Schemas are
// trimmed to their shape; the deferred placeholder is byte-for-byte the real
// one (empty object schema + "never call this tool" description).
function capturedTools() {
  return [
    {
      name: 'Bash',
      description: 'Executes a bash command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
    {
      name: 'ToolSearch',
      description: 'Fetches full schema definitions for deferred tools so they can be called.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' }, max_results: { type: 'number' } },
        required: ['query', 'max_results'],
      },
    },
    {
      name: 'DeferredToolPlaceholder',
      description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.',
      input_schema: { type: 'object', properties: {} },
      defer_loading: true,
    },
    {
      name: 'Write',
      description: 'Writes a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  ];
}

// The exact request keys Claude Code 2.1.306 sends on every turn (capture id 37).
function capturedBody(overrides = {}) {
  return {
    model: 'claude-haiku-5-5-medium',
    max_tokens: 128000,
    stream: false,
    thinking: { type: 'adaptive', display: 'updates' },
    output_config: { effort: 'medium' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    tools: capturedTools(),
    messages: [{ role: 'user', content: 'go' }],
    ...overrides,
  };
}

function captureForwarded() {
  const captured = {};
  const handler = async (body) => {
    captured.body = body;
    return {
      status: 200,
      body: {
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    };
  };
  return { captured, handler };
}

beforeEach(() => {
  resetCcCompatStats();
});

// ─── CL1 ────────────────────────────────────────────────────────────────────

describe('CL1 thinking signature wire shape (Claude Code 2.1.306)', () => {
  it('stream: content_block_start thinking is exactly {type, thinking, signature:""} and no signature_delta is emitted', async () => {
    const result = await handleMessages(capturedBody({ stream: true }), {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'pondering' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const start = events.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking');
    assert.ok(start, 'a thinking content_block_start must be emitted');
    // Exact key set: the signature key must be present (Grok Build/serde treat
    // it as required) and must be the empty string when upstream has none.
    assert.deepEqual(
      Object.keys(start.data.content_block).sort(),
      ['signature', 'thinking', 'type'],
      'thinking content_block_start must carry exactly type/thinking/signature',
    );
    assert.equal(start.data.content_block.signature, '');
    assert.equal(start.data.content_block.thinking, '');
    const sigDeltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'signature_delta');
    assert.equal(sigDeltas.length, 0, 'no signature_delta without a real upstream signature');
  });

  it('non-stream: thinking block carries signature:"" when upstream has none', () => {
    const message = openAIToAnthropic({
      model: 'claude-haiku-5-5-medium',
      choices: [{
        index: 0,
        message: { role: 'assistant', reasoning_content: 'thought', content: 'answer' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, 'claude-haiku-5-5-medium', 'msg_test');
    const thinking = message.content.find(c => c.type === 'thinking');
    assert.deepEqual(thinking, { type: 'thinking', thinking: 'thought', signature: '' });
  });

  it('stream: a real upstream reasoning_signature still rides signature_delta before content_block_stop', async () => {
    const result = await handleMessages(capturedBody({ stream: true }), {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'r', reasoning_signature: 'sig_abc' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const startIdx = events.findIndex(e => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking');
    const stopIdx = events.findIndex((e, i) => i > startIdx && e.event === 'content_block_stop' && e.data.index === events[startIdx].data.index);
    assert.ok(startIdx !== -1 && stopIdx !== -1, 'thinking block must open and close');
    const beforeStop = events[stopIdx - 1];
    assert.equal(beforeStop.event, 'content_block_delta');
    assert.deepEqual(beforeStop.data.delta, { type: 'signature_delta', signature: 'sig_abc' });
  });
});

// ─── CL2 ────────────────────────────────────────────────────────────────────

describe('CL2 context_management (Claude Code 2.1.306)', () => {
  it('accepts the exact captured edit: clear_thinking_20251015 keep:"all"', () => {
    const err = validateMessagesRequest(capturedBody());
    assert.equal(err, null, 'the real 2.1.306 request must not be rejected');
  });

  it('accepts keep:"none" and keep:{type:"thinking_turns", value:N}', () => {
    assert.equal(validateMessagesRequest(capturedBody({
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'none' }] },
    })), null);
    assert.equal(validateMessagesRequest(capturedBody({
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 3 } }] },
    })), null);
  });

  it('rejects clear_tool_uses_20250919 with 400 unsupported_parameter and an actionable message', () => {
    const err = validateMessagesRequest(capturedBody({
      context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    }));
    assert.equal(err.status, 400);
    assert.equal(err.body.error.type, 'invalid_request_error');
    assert.equal(err.body.error.code, 'unsupported_parameter');
    assert.equal(err.body.error.param, 'context_management.edits[0].type');
    assert.match(err.body.error.message, /clear_tool_uses_20250919/);
    assert.match(err.body.error.message, /clear_thinking_20251015/, 'message must name what IS supported');
    assert.match(err.body.error.message, /Remove|disable/i, 'message must tell the caller what to do');
  });

  it('rejects an unknown edit type with 400 unsupported_parameter', () => {
    const err = validateMessagesRequest(capturedBody({
      context_management: { edits: [{ type: 'clear_everything_20300101' }] },
    }));
    assert.equal(err.status, 400);
    assert.equal(err.body.error.code, 'unsupported_parameter');
    assert.equal(err.body.error.param, 'context_management.edits[0].type');
  });

  it('rejects malformed context_management shapes with 400 invalid_request_error', () => {
    for (const bad of [
      [],
      { edits: 'nope' },
      { edits: [null] },
      { edits: [{}] },
      { edits: [{ type: 'clear_thinking_20251015', keep: 'sometimes' }] },
      { edits: [{ type: 'clear_thinking_20251015', keep: { type: 'turns', value: 1 } }] },
      { edits: [{ type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 0 } }] },
    ]) {
      const err = validateMessagesRequest(capturedBody({ context_management: bad }));
      assert.ok(err, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(err.status, 400);
      assert.equal(err.body.error.type, 'invalid_request_error');
    }
  });

  it('does not forward context_management upstream, and history thinking stays dropped (the edit is satisfied by that drop)', async () => {
    const { captured, handler } = captureForwarded();
    await handleMessages(capturedBody({
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET-THOUGHT', signature: '' }, { type: 'text', text: 'hi' }] },
        { role: 'user', content: 'go' },
      ],
    }), { handleChatCompletions: handler });
    assert.equal(captured.body.context_management, undefined, 'context_management is an Anthropic-side directive');
    assert.equal(captured.body.__contextManagement, undefined, 'no internal carrier leaks to the upstream handler');
    assert.ok(!JSON.stringify(captured.body.messages).includes('SECRET-THOUGHT'), 'thinking history is never forwarded');
  });
});

// ─── CL3 ────────────────────────────────────────────────────────────────────

describe('CL3 defer_loading (Claude Code 2.1.306)', () => {
  it('drops the schema-less deferred placeholder, counts it honored, and never forwards defer_loading', async () => {
    const { captured, handler } = captureForwarded();
    await handleMessages(capturedBody(), { handleChatCompletions: handler });
    const names = captured.body.tools.map(t => t.function.name);
    assert.deepEqual(names, ['Bash', 'ToolSearch', 'Write'], 'DeferredToolPlaceholder has no schema and must never be callable');
    assert.ok(!JSON.stringify(captured.body.tools).includes('defer_loading'), 'defer_loading is an Anthropic-only key');
    const stats = getCcCompatStats();
    assert.equal(stats.toolDeferLoadingHonored, 1);
    assert.equal(stats.toolDeferLoadingIgnored, 0);
  });

  it('forwards a schema-bearing deferred tool in full and counts it ignored (tool_defer_loading_ignored, never silent)', async () => {
    const { captured, handler } = captureForwarded();
    await handleMessages(capturedBody({
      tools: [
        {
          name: 'Lookup',
          description: 'deferred but schema-bearing',
          input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
          defer_loading: true,
        },
      ],
    }), { handleChatCompletions: handler });
    const forwarded = captured.body.tools.find(t => t.function.name === 'Lookup');
    assert.ok(forwarded, 'a schema-bearing deferred tool must stay callable');
    assert.deepEqual(forwarded.function.parameters.properties, { q: { type: 'string' } });
    assert.ok(!('defer_loading' in forwarded.function));
    const stats = getCcCompatStats();
    assert.equal(stats.toolDeferLoadingIgnored, 1, 'ignored deferrals are counted, not silent');
    assert.equal(stats.toolDeferLoadingHonored, 0);
  });

  it('defer_loading:false is an ordinary tool and is not counted', async () => {
    const { captured, handler } = captureForwarded();
    await handleMessages(capturedBody({
      tools: [{
        name: 'Plain',
        description: 'plain',
        input_schema: { type: 'object', properties: { x: { type: 'string' } } },
        defer_loading: false,
      }],
    }), { handleChatCompletions: handler });
    assert.deepEqual(captured.body.tools.map(t => t.function.name), ['Plain']);
    const stats = getCcCompatStats();
    assert.equal(stats.toolDeferLoadingHonored, 0);
    assert.equal(stats.toolDeferLoadingIgnored, 0);
  });
});

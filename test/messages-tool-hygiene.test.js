import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages, openAIToAnthropic } from '../src/handlers/messages.js';

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

// Two DISTINCT calls, one reused upstream id: this is the shape that made the
// client see two tool_use blocks with the same id, so it could not key the
// results (GFProtocol Q1-04).
function duplicateIdUpstream() {
  return {
    status: 200,
    stream: true,
    async handler(res) {
      res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'call_dup', type: 'function', function: { name: 'alpha', arguments: '{"n":1}' } },
        { index: 1, id: 'call_dup', type: 'function', function: { name: 'beta', arguments: '{"n":2}' } },
      ] }, finish_reason: null }] }));
      res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      res.end('data: [DONE]\n\n');
    },
  };
}

async function runMessagesStream() {
  const result = await handleMessages({
    model: 'claude-sonnet-4.6',
    stream: true,
    messages: [{ role: 'user', content: 'go' }],
  }, {
    async handleChatCompletions() { return duplicateIdUpstream(); },
  });
  const res = fakeRes();
  await result.handler(res);
  const events = parseAnthropicEvents(res.body);
  const blocks = events
    .filter(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')
    .map(e => ({ index: e.data.index, ...e.data.content_block }));
  const args = new Map();
  for (const e of events) {
    if (e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta') {
      args.set(e.data.index, (args.get(e.data.index) || '') + e.data.delta.partial_json);
    }
  }
  return { blocks, args };
}

describe('Anthropic tool-id hygiene', () => {
  it('emits distinct tool_use ids when the upstream reuses one call id', async () => {
    const first = await runMessagesStream();
    assert.deepEqual(first.blocks.map(b => b.id), ['call_dup', 'call_dup_2']);
    assert.deepEqual(first.blocks.map(b => b.name), ['alpha', 'beta']);
    assert.equal(first.args.get(first.blocks[0].index), '{"n":1}');
    assert.equal(first.args.get(first.blocks[1].index), '{"n":2}');
    // Deterministic: the same upstream turn maps to the same wire ids.
    const second = await runMessagesStream();
    assert.deepEqual(second.blocks.map(b => b.id), first.blocks.map(b => b.id));
    // The emitted ids survive the next turn's request leg unchanged, so the
    // client's tool_result still binds to the call it saw.
    let forwarded = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'assistant', content: first.blocks.map(b => ({ type: 'tool_use', id: b.id, name: b.name, input: {} })) },
        { role: 'user', content: first.blocks.map((b, i) => ({ type: 'tool_result', tool_use_id: b.id, content: `r${i}` })) },
      ],
    }, {
      async handleChatCompletions(body) {
        forwarded = body;
        return { status: 200, body: { model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } };
      },
    });
    assert.deepEqual(forwarded.messages[0].tool_calls.map(c => c.id), first.blocks.map(b => b.id));
  });

  it('dedupes non-stream tool_use ids too', () => {
    const body = openAIToAnthropic({
      choices: [{
        message: { tool_calls: [
          { id: 'call_dup', function: { name: 'alpha', arguments: '{"n":1}' } },
          { id: 'call_dup', function: { name: 'beta', arguments: '{"n":2}' } },
        ] },
        finish_reason: 'tool_calls',
      }],
      usage: {},
    }, 'claude-sonnet-4.6', 'msg_1');
    const ids = body.content.filter(b => b.type === 'tool_use').map(b => b.id);
    assert.deepEqual(ids, ['call_dup', 'call_dup_2']);
  });

  it('normalizes a 70-char tool id and keeps the result paired', async () => {
    const raw = 'x'.repeat(70);
    let captured = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: raw, name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: raw, content: 'ok' }] },
      ],
    }, { handleChatCompletions: async (body) => {
      captured = body;
      return {
        status: 200,
        body: { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: {} },
      };
    } });
    assert.equal(result.status, 200);
    const call = captured.messages[0].tool_calls[0];
    assert.equal(call.id.length, 64);
    assert.equal(captured.messages[1].tool_call_id, call.id);
  });

  it('the kill switch leaves ids raw', async () => {
    const raw = 'x'.repeat(70);
    const previous = process.env.WINDSURFAPI_TOOL_HYGIENE;
    process.env.WINDSURFAPI_TOOL_HYGIENE = '0';
    try {
      let captured = null;
      await handleMessages({
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: raw, name: 'f', input: {} }] }],
      }, { handleChatCompletions: async (body) => {
        captured = body;
        return { status: 200, body: { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: {} } };
      } });
      assert.equal(captured.messages[0].tool_calls[0].id, raw);
    } finally {
      if (previous === undefined) delete process.env.WINDSURFAPI_TOOL_HYGIENE;
      else process.env.WINDSURFAPI_TOOL_HYGIENE = previous;
    }
  });

  it('folds an orphan tool result instead of forwarding an unpaired role:tool', async () => {
    let captured = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan body' }] },
      ],
    }, { handleChatCompletions: async (body) => {
      captured = body;
      return {
        status: 200,
        body: { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: {} },
      };
    } });
    assert.equal(result.status, 200);
    assert.equal(captured.messages.some((m) => m.role === 'tool'), false);
    assert.match(JSON.stringify(captured.messages), /orphan body/);
  });
});

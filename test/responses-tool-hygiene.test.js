import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { responsesToChat, chatToResponse, handleResponses } from '../src/handlers/responses.js';
import { isValidToolId } from '../src/tool-ids.js';

const longName = 'n'.repeat(70);

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

function parseEvents(raw) {
  return raw
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .filter(frame => frame !== 'data: [DONE]')
    .map(frame => {
      const lines = frame.split('\n');
      return {
        event: lines.find(line => line.startsWith('event: '))?.slice(7),
        data: JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'),
      };
    });
}

// Two DISTINCT calls, one reused upstream id (GFProtocol Q1-04): the client
// received two function_call items with the same call_id.
function duplicateIdUpstream() {
  return {
    status: 200,
    stream: true,
    async handler(res) {
      res.write(chatChunk({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'call_dup', type: 'function', function: { name: 'alpha', arguments: '{"n":1}' } },
        { index: 1, id: 'call_dup', type: 'function', function: { name: 'beta', arguments: '{"n":2}' } },
      ] } }] }));
      res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      res.end('data: [DONE]\n\n');
    },
  };
}

async function runResponsesStream() {
  const result = await handleResponses({
    model: 'claude-sonnet-4.6',
    input: 'go',
    stream: true,
  }, {
    async handleChatCompletions() { return duplicateIdUpstream(); },
  });
  const res = fakeRes();
  await result.handler(res);
  const events = parseEvents(res.body);
  const added = events.filter(e => e.event === 'response.output_item.added').map(e => e.data.item);
  const done = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item);
  const completed = events.find(e => e.event === 'response.completed')?.data.response;
  return { added, done, completed };
}

describe('Responses tool boundary', () => {
  it('emits distinct call_ids when the upstream reuses one call id', async () => {
    const first = await runResponsesStream();
    assert.deepEqual(first.added.map(i => i.call_id), ['call_dup', 'call_dup_2']);
    assert.deepEqual(first.done.map(i => i.call_id), ['call_dup', 'call_dup_2']);
    assert.deepEqual(first.done.map(i => i.name), ['alpha', 'beta']);
    assert.deepEqual(first.completed.output.filter(i => i.type === 'function_call').map(i => i.call_id), ['call_dup', 'call_dup_2']);
    // Deterministic: the same upstream turn maps to the same wire ids.
    const second = await runResponsesStream();
    assert.deepEqual(second.added.map(i => i.call_id), first.added.map(i => i.call_id));
    // The emitted call_ids survive the next turn's request leg unchanged, so
    // each function_call_output still binds to the call it answered.
    const chat = responsesToChat({
      model: 'gpt-4o',
      input: [
        { role: 'user', content: 'go' },
        ...first.added.map(i => ({ type: 'function_call', call_id: i.call_id, name: i.name, arguments: i.arguments || '{}' })),
        ...first.added.map(i => ({ type: 'function_call_output', call_id: i.call_id, output: 'ok' })),
      ],
    });
    assert.deepEqual(chat.messages.find(m => m.tool_calls).tool_calls.map(c => c.id), first.added.map(i => i.call_id));
    assert.deepEqual(chat.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), first.added.map(i => i.call_id));
  });

  it('dedupes non-stream call_ids too', () => {
    const response = chatToResponse({
      choices: [{
        message: { tool_calls: [
          { id: 'call_dup', function: { name: 'alpha', arguments: '{"n":1}' } },
          { id: 'call_dup', function: { name: 'beta', arguments: '{"n":2}' } },
        ] },
        finish_reason: 'tool_calls',
      }],
      usage: {},
    }, 'gpt-4o', 'resp_1', 'msg_1');
    const ids = response.output.filter(o => o.type === 'function_call').map(o => o.call_id);
    assert.deepEqual(ids, ['call_dup', 'call_dup_2']);
  });

  it('bounds a long tool name upstream and restores it on egress', () => {
    const chat = responsesToChat({
      model: 'gpt-4o',
      input: 'hi',
      tools: [{ type: 'function', name: longName, parameters: { type: 'object' } }],
    });
    const wire = chat.tools[0].function.name;
    assert.equal(wire.length, 64);
    assert.equal(chat.__toolNameMap.toUpstream.get(longName), wire);
    const response = chatToResponse({
      choices: [{ message: { tool_calls: [{ id: 'call_1', function: { name: wire, arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    }, 'gpt-4o', 'resp_1', 'msg_1', chat.tools, chat.__toolNameMap);
    assert.equal(response.output.find((o) => o.type === 'function_call').name, longName);
  });

  it('sanitizes invalid call ids on the route ingress and egress', async () => {
    let captured = null;
    const result = await handleResponses({
      model: 'gpt-4o',
      input: [
        { type: 'function_call', call_id: 'call.with:dots/slash', name: 'f', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call.with:dots/slash', output: 'ok' },
      ],
    }, {
      handleChatCompletions: async (body) => {
        captured = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'call.with:dots/slash', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
            usage: {},
          },
        };
      },
      context: { callerKey: 'api:test:user:t' },
    });
    const call = captured.messages.find((m) => m.tool_calls).tool_calls[0];
    assert.equal(call.id, 'call_with_dots_slash');
    assert.equal(captured.messages.find((m) => m.role === 'tool').tool_call_id, call.id);
    const item = result.body.output.find((o) => o.type === 'function_call');
    assert.equal(isValidToolId(item.call_id), true);
  });

  it('keeps a valid 64-char name unchanged', () => {
    const name = 'a'.repeat(64);
    const chat = responsesToChat({ model: 'gpt-4o', input: 'hi', tools: [{ type: 'function', name }] });
    assert.equal(chat.tools[0].function.name, name);
    assert.equal(chat.__toolNameMap, undefined);
  });
});

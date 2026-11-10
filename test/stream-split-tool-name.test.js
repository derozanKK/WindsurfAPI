import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleGemini } from '../src/handlers/gemini.js';
import { handleResponses } from '../src/handlers/responses.js';

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; },
    setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const sseJson = (body) => body.split(/\r?\n\r?\n/).filter(Boolean)
  .map((f) => f.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
  .filter((data) => data && data.trim() !== '[DONE]')
  .map((data) => JSON.parse(data));

const SPLIT = [
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'foo' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: '_bar', arguments: '{}' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
];

function streamDeps(frames) {
  return {
    async handleChatCompletions() {
      return {
        status: 200, stream: true,
        async handler(res) { for (const f of frames) res.write(f); res.end(); },
      };
    },
  };
}

describe('streaming split function.name is settled before egress', () => {
  it('Gemini functionCall carries the restored full name', async () => {
    const result = await handleGemini('m', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
      tools: [{ functionDeclarations: [{ name: 'foo.bar' }] }],
    }, streamDeps(SPLIT), { stream: true, alt: 'sse' });
    const res = fakeRes();
    await result.handler(res);
    const calls = sseJson(res.body)
      .flatMap((f) => f.candidates?.[0]?.content?.parts || [])
      .map((p) => p.functionCall)
      .filter(Boolean);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'foo.bar');
  });

  it('Responses output_item.added carries the restored full name', async () => {
    const result = await handleResponses({
      model: 'gpt-5.2', stream: true, input: 'hi',
      tools: [{ type: 'function', name: 'foo.bar', parameters: { type: 'object', properties: {} } }],
    }, { ...streamDeps(SPLIT), context: { callerKey: 'api:split:user:t' } });
    const res = fakeRes();
    await result.handler(res);
    const events = sseJson(res.body);
    const added = events.find((e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
    const done = events.find((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
    assert.equal(added?.item?.name, 'foo.bar');
    assert.equal(done?.item?.name, 'foo.bar');
  });


  it('keeps text after a split-name tool call in a later message item', async () => {
    const frames = [
      chunk({ choices: [{ index: 0, delta: { content: 'BEFORE ' } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'foo' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: '_bar', arguments: '{}' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { content: 'AFTER' } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const result = await handleResponses({
      model: 'gpt-5.2', stream: true, input: 'hi',
      tools: [{ type: 'function', name: 'foo.bar', parameters: { type: 'object', properties: {} } }],
    }, { ...streamDeps(frames), context: { callerKey: 'api:split-text:user:t' } });
    const res = fakeRes();
    await result.handler(res);
    const events = sseJson(res.body);
    const added = events.filter((e) => e.type === 'response.output_item.added').map((e) => e.item.type);
    assert.deepEqual(added, ['message', 'function_call', 'message']);
    const tool = events.find((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    assert.equal(tool.item.name, 'foo.bar');
    const done = events.filter((e) => e.type === 'response.output_item.done');
    assert.deepEqual(done.map((e) => e.output_index), [0, 1, 2]);
  });


  it('keeps a split custom tool name on a custom_tool_call item', async () => {
    const frames = [
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_custom', type: 'function', function: { name: 'run' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'ner', arguments: '{"input":"echo hi"}' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const result = await handleResponses({
      model: 'gpt-5.2', stream: true, input: 'hi',
      tools: [{ type: 'custom', name: 'runner', description: 'Run shell' }],
    }, { ...streamDeps(frames), context: { callerKey: 'api:split-custom:user:t' } });
    const res = fakeRes();
    await result.handler(res);
    const events = sseJson(res.body);
    const added = events.find((e) => e.type === 'response.output_item.added');
    const done = events.find((e) => e.type === 'response.output_item.done');
    assert.equal(added.item.type, 'custom_tool_call');
    assert.equal(added.item.name, 'runner');
    assert.equal(done.item.type, 'custom_tool_call');
    assert.equal(done.item.name, 'runner');
    assert.equal(done.item.input, 'echo hi');
  });

});

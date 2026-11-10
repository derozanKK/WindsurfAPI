import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { geminiToOpenAI, openAIToGemini, handleGemini } from '../src/handlers/gemini.js';
import { isValidToolId } from '../src/tool-ids.js';

const longName = 'a'.repeat(64);

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

function parseSseFrames(raw) {
  return raw
    .split('\r\n\r\n')
    .filter(Boolean)
    .filter(frame => frame.startsWith('data: '))
    .map(frame => JSON.parse(frame.slice(6)));
}

// Two DISTINCT calls, one reused upstream id (GFProtocol Q1-04).
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

async function runGeminiStream() {
  const result = await handleGemini('gemini-2.5-pro', {
    contents: [{ role: 'user', parts: [{ text: 'go' }] }],
  }, {
    async handleChatCompletions() { return duplicateIdUpstream(); },
  }, { stream: true, alt: 'sse' });
  const res = fakeRes();
  await result.handler(res);
  return parseSseFrames(res.body)
    .flatMap(f => f.candidates?.[0]?.content?.parts || [])
    .filter(p => p.functionCall)
    .map(p => p.functionCall);
}

describe('Gemini tool boundary', () => {
  it('emits distinct functionCall ids when the upstream reuses one call id', async () => {
    const first = await runGeminiStream();
    assert.deepEqual(first.map(c => c.id), ['call_dup', 'call_dup_2']);
    assert.deepEqual(first.map(c => c.name), ['alpha', 'beta']);
    assert.deepEqual(first.map(c => c.args), [{ n: 1 }, { n: 2 }]);
    // Deterministic: the same upstream turn maps to the same wire ids.
    const second = await runGeminiStream();
    assert.deepEqual(second.map(c => c.id), first.map(c => c.id));
    // The emitted ids survive the next turn's request leg unchanged, so each
    // functionResponse still binds to the call it answered.
    const out = geminiToOpenAI({
      contents: [
        { role: 'model', parts: first.map(c => ({ functionCall: { id: c.id, name: c.name, args: c.args } })) },
        { role: 'user', parts: first.map(c => ({ functionResponse: { id: c.id, name: c.name, response: {} } })) },
      ],
    });
    assert.deepEqual(out.messages.find(m => m.tool_calls).tool_calls.map(c => c.id), first.map(c => c.id));
    assert.deepEqual(out.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), first.map(c => c.id));
  });

  it('dedupes non-stream functionCall ids too', () => {
    const out = openAIToGemini({
      choices: [{
        message: { tool_calls: [
          { id: 'call_dup', function: { name: 'alpha', arguments: '{"n":1}' } },
          { id: 'call_dup', function: { name: 'beta', arguments: '{"n":2}' } },
        ] },
        finish_reason: 'tool_calls',
      }],
    }, 'gemini-2.5-pro');
    const ids = out.candidates[0].content.parts.filter(p => p.functionCall).map(p => p.functionCall.id);
    assert.deepEqual(ids, ['call_dup', 'call_dup_2']);
  });

  it('bounds a 64-char function name to a 64-char id and pairs the response', () => {
    const out = geminiToOpenAI({
      contents: [
        { role: 'model', parts: [{ functionCall: { name: longName, args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: longName, response: {} } }] },
      ],
    });
    const call = out.messages.find((m) => m.tool_calls).tool_calls[0];
    const result = out.messages.find((m) => m.role === 'tool');
    assert.equal(call.id.length, 64);
    assert.equal(isValidToolId(call.id), true);
    assert.equal(result.tool_call_id, call.id);
  });

  it('maps a dotted declaration and restores it on egress', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      tools: [{ functionDeclarations: [{ name: 'foo.bar' }] }],
    });
    assert.equal(out.tools[0].function.name, 'foo_bar');
    assert.equal(out.__toolNameMap.toUpstream instanceof Map, true);
    const egress = openAIToGemini({
      choices: [{ message: { tool_calls: [{ id: 'call_1', function: { name: 'foo_bar', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    }, 'm', out.__toolNameMap);
    assert.deepEqual(egress.candidates[0].content.parts[0].functionCall, { name: 'foo.bar', args: {}, id: 'call_1' });
  });

  it('sanitizes an invalid explicit id on both legs', () => {
    const out = geminiToOpenAI({
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'native.1:bad/x', name: 'f', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'native.1:bad/x', name: 'f', response: {} } }] },
      ],
    });
    const call = out.messages.find((m) => m.tool_calls).tool_calls[0];
    const result = out.messages.find((m) => m.role === 'tool');
    assert.equal(call.id, 'native_1_bad_x');
    assert.equal(result.tool_call_id, call.id);
  });

  it('pairs an explicit-id call with an id-less response', () => {
    const out = geminiToOpenAI({
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'g_native_1', name: 'f', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'f', response: {} } }] },
      ],
    });
    const call = out.messages.find((m) => m.tool_calls).tool_calls[0];
    const result = out.messages.find((m) => m.role === 'tool');
    assert.equal(call.id, 'g_native_1');
    assert.equal(result.tool_call_id, 'g_native_1');
  });

  it('gives two orphan responses distinct ids', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [
        { functionResponse: { name: 'ghost', response: {} } },
        { functionResponse: { name: 'ghost', response: {} } },
      ] }],
    });
    const ids = out.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    assert.equal(new Set(ids).size, 2);
  });

  it('restores the client name and id on the stream route', async () => {
    let forwarded = null;
    const result = await handleGemini('m', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
      tools: [{ functionDeclarations: [{ name: 'foo.bar' }] }],
    }, {
      async handleChatCompletions(body) {
        forwarded = body.tools[0].function.name;
        return {
          stream: true, status: 200,
          async handler(res) {
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'foo_bar', arguments: '{}' } }] } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
          },
        };
      },
    }, { stream: true, alt: 'sse' });
    const res = {
      body: '', writableEnded: false,
      write(c) { this.body += String(c); return true; },
      end(c) { if (c) this.write(c); this.writableEnded = true; },
      on() { return this; }, once() { return this; },
    };
    await result.handler(res);
    assert.equal(forwarded, 'foo_bar');
    const frames = res.body.split('\r\n\r\n').filter(Boolean).filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
    const call = frames.flatMap((f) => f.candidates?.[0]?.content?.parts || []).find((p) => p.functionCall)?.functionCall;
    assert.equal(call.name, 'foo.bar');
    assert.equal(call.id, 'call_1');
  });

  it('maps tool_choice to the wire name', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      tools: [{ functionDeclarations: [{ name: 'foo.bar' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['foo.bar'] } },
    });
    assert.equal(out.tool_choice.function.name, 'foo_bar');
  });
});

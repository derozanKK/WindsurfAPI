// A1 (protocol absorption, 2026-10-18): a tool call whose `arguments` arrive in
// several stream deltas must assemble byte-exactly at the client. Split
// boundaries of 1, 128 and 4096 bytes are the ones an upstream buffer can
// produce, and every one of them lands inside the JSON rather than at its
// edges. The payload carries multi-byte characters, so the same fragments also
// drive the shared SSE framer's UTF-8 decoding across wire-chunk boundaries.
//
// Fake upstream: `handleChatCompletions` is replaced by a handler that writes
// the internal OpenAI SSE frames chat.js would write (same pattern as
// test/stream-split-tool-name.test.js). The three front-end translators are the
// delta-accumulation path under test.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleGemini } from '../src/handlers/gemini.js';
import { ToolCallStreamParser } from '../src/handlers/tool-emulation.js';

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; }, off() { return this; },
    setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;

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

// Split on CODE POINT boundaries, not UTF-16 units: a byte-level splitter can
// never emit half a surrogate pair, and a lone surrogate would make the
// expectation itself malformed. The proxy receives decoded characters, so the
// fragments below are exactly what it can be handed.
function splitByCodePoint(str, size) {
  const cps = Array.from(str);
  const out = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

// A payload whose first three fragments end exactly on the boundary for each
// split size, so every boundary cuts inside the JSON rather than at its edges.
function payloadFor(size) {
  const tail = '尾巴-🙂-end';
  const fill = 'a'.repeat(Math.max(1, size * 3 + 7 - tail.length));
  return JSON.stringify({ command: `echo ${fill}`, note: tail });
}

function framesFor(args, size, { nameLast = false } = {}) {
  const parts = splitByCodePoint(args, size);
  const tc = (obj) => chunk({ choices: [{ index: 0, delta: { tool_calls: [obj] } }] });
  if (nameLast) {
    // The name only settles on the LAST fragment. Until then neither front end
    // may open the tool block, so every fragment has to survive in an internal
    // accumulator and be released in order — this is the case that makes the
    // accumulation itself load-bearing (a plain overwrite would keep only the
    // final fragment).
    const frames = [tc({ index: 0, id: 'call_split', type: 'function', function: { arguments: parts[0] } })];
    for (const p of parts.slice(1, -1)) frames.push(tc({ index: 0, function: { arguments: p } }));
    frames.push(tc({ index: 0, function: { name: 'run', arguments: parts[parts.length - 1] } }));
    frames.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    frames.push('data: [DONE]\n\n');
    return frames;
  }
  const frames = [tc({ index: 0, id: 'call_split', type: 'function', function: { name: 'run', arguments: parts[0] } })];
  for (const p of parts.slice(1)) frames.push(tc({ index: 0, function: { arguments: p } }));
  frames.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  frames.push('data: [DONE]\n\n');
  return frames;
}

const TOOLS_MESSAGES = [{
  name: 'run',
  description: 'run a command',
  input_schema: { type: 'object', properties: { command: { type: 'string' }, note: { type: 'string' } }, required: ['command'] },
}];
const TOOLS_RESPONSES = [{
  type: 'function', name: 'run',
  parameters: { type: 'object', properties: { command: { type: 'string' }, note: { type: 'string' } }, required: ['command'] },
}];
const TOOLS_GEMINI = [{
  functionDeclarations: [{ name: 'run', parameters: { type: 'object', properties: { command: { type: 'string' }, note: { type: 'string' } } } }],
}];

function eventsOf(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const event = frame.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
    const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || data.trim() === '[DONE]') return { event, data: null };
    return { event, data: JSON.parse(data) };
  });
}

async function messagesToolCall(args, size, opts = {}) {
  const result = await handleMessages({
    model: 'claude-haiku-5-5-low', max_tokens: 256, stream: true,
    tools: TOOLS_MESSAGES,
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: 'run it' }],
  }, streamDeps(framesFor(args, size, opts)));
  const res = fakeRes();
  await result.handler(res);
  const events = eventsOf(res.body);
  return {
    start: events.find((e) => e.data?.content_block?.type === 'tool_use'),
    partial: events.filter((e) => e.data?.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join(''),
    stopReason: events.find((e) => e.data?.type === 'message_delta')?.data?.delta?.stop_reason,
  };
}

async function responsesToolCall(args, size, opts = {}) {
  const result = await handleResponses({
    model: 'gpt-5.2', stream: true, store: false, input: 'run it',
    tools: TOOLS_RESPONSES,
  }, { ...streamDeps(framesFor(args, size, opts)), context: { callerKey: 'api:split-args:user:t' } });
  const res = fakeRes();
  await result.handler(res);
  const events = res.body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || data.trim() === '[DONE]') return null;
    return JSON.parse(data);
  }).filter(Boolean);
  return {
    deltas: events.filter((e) => e.type === 'response.function_call_arguments.delta').map((e) => e.delta).join(''),
    done: events.find((e) => e.type === 'response.output_item.done')?.item,
    added: events.find((e) => e.type === 'response.output_item.added')?.item,
  };
}

async function geminiToolCall(args, size, opts = {}) {
  const result = await handleGemini('gemini-3-pro', {
    contents: [{ role: 'user', parts: [{ text: 'run it' }] }],
    tools: TOOLS_GEMINI,
  }, streamDeps(framesFor(args, size, opts)), { stream: true, alt: 'sse' });
  const res = fakeRes();
  await result.handler(res);
  const events = res.body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || data.trim() === '[DONE]') return null;
    return JSON.parse(data);
  }).filter(Boolean);
  const parts = events.flatMap((e) => e.candidates?.[0]?.content?.parts || []);
  return {
    call: parts.find((p) => p.functionCall)?.functionCall,
    finishReason: events.map((e) => e.candidates?.[0]?.finishReason).filter(Boolean).pop(),
  };
}

describe('A1 — split tool-call arguments assemble byte-exactly', () => {
  for (const size of [1, 128, 4096]) {
    const args = payloadFor(size);

    it(`Anthropic Messages: ${size}-byte fragments, one tool_use block`, async () => {
      const got = await messagesToolCall(args, size);
      assert.ok(splitByCodePoint(args, size).length >= 4, 'the fixture really splits at this boundary');
      assert.ok(got.start, 'the tool_use block was opened');
      assert.equal(got.start.data.content_block.name, 'run');
      assert.equal(got.start.data.content_block.id, 'call_split');
      assert.equal(got.partial, args, 'input_json_delta fragments join to the exact upstream arguments');
      assert.equal(got.stopReason, 'tool_use');
    });

    it(`Responses: ${size}-byte fragments, exact deltas and exact output_item.done`, async () => {
      const got = await responsesToolCall(args, size);
      assert.ok(got.added, 'the function_call item was announced');
      assert.equal(got.added.name, 'run');
      assert.equal(got.deltas, args, 'function_call_arguments.delta fragments join to the exact arguments');
      assert.ok(got.done, 'the item was completed');
      assert.equal(got.done.arguments, args, 'output_item.done carries the exact arguments');
      assert.equal(got.done.status, 'completed');
    });

    it(`Gemini: ${size}-byte fragments, one parsed functionCall`, async () => {
      const got = await geminiToolCall(args, size);
      assert.ok(got.call, 'a functionCall part was emitted');
      assert.equal(got.call.name, 'run');
      assert.equal(JSON.stringify(got.call.args), args, 'the buffered fragments parse to the exact arguments');
      assert.equal(got.finishReason, 'STOP');
    });
  }

  // The name only settles on the LAST fragment here, so neither front end can
  // open the tool block early: every fragment must survive in the internal
  // accumulator and come out in order. This is what makes the accumulation
  // itself load-bearing — an overwrite instead of an append keeps only the last
  // fragment and this case fails while the plain split above still passes.
  for (const size of [1, 128, 4096]) {
    const args = payloadFor(size);

    it(`Anthropic Messages: ${size}-byte fragments with the name settling last`, async () => {
      const got = await messagesToolCall(args, size, { nameLast: true });
      assert.ok(got.start, 'the tool_use block was opened once the name settled');
      assert.equal(got.start.data.content_block.name, 'run');
      assert.equal(got.partial, args, 'every buffered fragment reached the client, in order');
      assert.equal(got.stopReason, 'tool_use');
    });

    it(`Responses: ${size}-byte fragments with the name settling last`, async () => {
      const got = await responsesToolCall(args, size, { nameLast: true });
      assert.equal(got.deltas, args, 'every buffered fragment reached the client, in order');
      assert.equal(got.done?.arguments, args, 'output_item.done carries the exact arguments');
      assert.equal(got.done?.name, 'run');
    });
  }

  it('text-emulated tool calls survive the same split boundaries', () => {
    // The emulation path (models that emit <tool_call> markup instead of native
    // tool_calls) accumulates across CONTENT deltas. Same boundaries, same
    // byte-exactness requirement — the markup and its JSON body are cut apart.
    const args = payloadFor(128);
    const markup = `<tool_call>\n${JSON.stringify({ name: 'run', arguments: JSON.parse(args) })}\n</tool_call>`;
    for (const size of [1, 128, 4096]) {
      const parser = new ToolCallStreamParser({ modelKey: 'claude-sonnet-4.6', provider: null, route: 'cascade' });
      const calls = [];
      let text = '';
      for (const piece of splitByCodePoint(`pre ${markup} post`, size)) {
        const out = parser.feed(piece);
        text += out.text;
        calls.push(...out.toolCalls);
      }
      const tail = parser.flush();
      text += tail.text;
      calls.push(...tail.toolCalls);
      assert.equal(calls.length, 1, `size ${size}: exactly one tool call`);
      assert.equal(calls[0].name, 'run', `size ${size}: name`);
      assert.deepEqual(JSON.parse(calls[0].argumentsJson), JSON.parse(args), `size ${size}: arguments`);
      assert.equal(text.trim(), 'pre  post', `size ${size}: markup never leaks into the text channel`);
    }
  });
});

// End-to-end on the DEFAULT route: /v1/chat/completions through the real
// router. The proxy must not merge, reorder, or re-quote the fragments — an
// OpenAI client concatenates `delta.tool_calls[].function.arguments` itself, so
// byte-exactness there is the client's whole contract.
describe('A1 — the chat route forwards split argument deltas verbatim', () => {
  const SAVED = {};
  const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
  let server;
  let port;
  let pendingArgs = '';

  before(async () => {
    for (const key of ENV_KEYS) SAVED[key] = process.env[key];
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-shape-only';
    delete process.env.WINDSURF_API_KEY;
    config.apiKey = 'test-split-args-key';
    config.host = '127.0.0.1';
    config.port = 0;
    __setConnectDeps({
      toChatCompletion: async () => ({ status: 200, body: { choices: [] } }),
      streamChatCompletion: async (_params, send) => {
        const tc = (obj) => send({
          id: 'chatcmpl-split', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low',
          choices: [{ index: 0, delta: { tool_calls: [obj] }, finish_reason: null }],
        });
        const parts = splitByCodePoint(pendingArgs, 128);
        tc({ index: 0, id: 'call_wire', type: 'function', function: { name: 'run', arguments: parts[0] } });
        for (const p of parts.slice(1)) tc({ index: 0, function: { arguments: p } });
        send({
          id: 'chatcmpl-split', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
        return {
          content: '', reasoning: '', finish_reason: 'tool_calls',
          toolCalls: [{ id: 'call_wire', name: 'run', argumentsJson: pendingArgs }],
          usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
        };
      },
    });
    server = startServer();
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    port = server.address().port;
  });

  after(async () => {
    __resetConnectDeps();
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const key of ENV_KEYS) {
      if (SAVED[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED[key];
    }
  });

  it('reassembles a 128-byte-split tool call byte-exactly on the wire', async () => {
    pendingArgs = payloadFor(128);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-split-args-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5-low',
        stream: true,
        messages: [{ role: 'user', content: 'run it' }],
        tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
      }),
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    const frames = body.split(/\r?\n\r?\n/).filter(Boolean)
      .map((frame) => frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
      .filter((data) => data && data.trim() !== '[DONE]')
      .map((data) => JSON.parse(data));
    const calls = frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls || []);
    assert.ok(calls.length >= 4, `expected several argument fragments, saw ${calls.length}`);
    const joined = calls.map((c) => c.function?.arguments || '').join('');
    assert.equal(joined, pendingArgs, 'the client-side join is byte-identical to the upstream arguments');
    assert.equal(calls[0].id, 'call_wire');
    assert.equal(calls[0].function.name, 'run');
    assert.equal(frames.some((f) => f.choices?.[0]?.finish_reason === 'tool_calls'), true, 'terminal finish_reason reached the client');
    assert.equal(body.includes('data: [DONE]'), true, 'the stream is terminated');
  });
});

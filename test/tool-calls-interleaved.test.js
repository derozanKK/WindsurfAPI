// A3(b) — two parallel tool calls whose argument deltas interleave in one
// upstream stream. The wire order is A0, B0, A1, B1, …; each call's arguments
// must still assemble byte-exactly and each id/name pair must stay bound.
//
// The second scenario also makes one call's function.name settle only on its
// LAST delta, so the translator cannot open that block early.
//
// Front ends differ in how they can represent this:
//   • Responses streams per-item deltas and buffers a call until its name is
//     known, so interleaving is natural.
//   • Gemini transmits a functionCall as one complete object, so it buffers
//     per index and emits at finish.
//   • Anthropic can only have ONE open content block and a tool_use block is
//     never reopened. Opening B while A is current would close A and strand
//     every later A fragment, so Messages holds B until finish and lets A
//     stream to the end. This is the case that failed on e3e39d9.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleGemini } from '../src/handlers/gemini.js';

const CALL_A = '{"command":"aaaa","note":"AAA"}';
const CALL_B = '{"path":"bbbb","note":"BBB"}';
const PARTS_A = ['{"comm', 'and":"aa', 'aa","note":"A', 'AA"}'];
const PARTS_B = ['{"path"', ':"bbbb","no', 'te":"BBB"', '}'];

function assertFixture() {
  assert.equal(PARTS_A.join(''), CALL_A, 'fixture A fragments join to the exact payload');
  assert.equal(PARTS_B.join(''), CALL_B, 'fixture B fragments join to the exact payload');
}

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const tc = (obj) => chunk({ choices: [{ index: 0, delta: { tool_calls: [obj] } }] });

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; }, off() { return this; },
    setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}

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

// nameLast: 'a' | 'b' | null. The named call carries no function.name until its
// last fragment; every other fragment is name-less, as a spec-legal split name
// may be.
function interleavedFrames(nameLast = null) {
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const aName = i === 0 && nameLast !== 'a' ? { name: 'run_a' } : (i === 3 && nameLast === 'a' ? { name: 'run_a' } : {});
    const bName = i === 0 && nameLast !== 'b' ? { name: 'run_b' } : (i === 3 && nameLast === 'b' ? { name: 'run_b' } : {});
    frames.push(tc({
      index: 0,
      ...(i === 0 ? { id: 'call_a', type: 'function' } : {}),
      function: { ...aName, arguments: PARTS_A[i] },
    }));
    frames.push(tc({
      index: 1,
      ...(i === 0 ? { id: 'call_b', type: 'function' } : {}),
      function: { ...bName, arguments: PARTS_B[i] },
    }));
  }
  frames.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  frames.push('data: [DONE]\n\n');
  return frames;
}

const TOOLS_MESSAGES = [
  { name: 'run_a', description: 'a', input_schema: { type: 'object', properties: { command: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'run_b', description: 'b', input_schema: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string' } } } },
];
const TOOLS_RESPONSES = TOOLS_MESSAGES.map((t) => ({ type: 'function', name: t.name, parameters: t.input_schema }));
const TOOLS_GEMINI = [{ functionDeclarations: TOOLS_MESSAGES.map((t) => ({ name: t.name, parameters: t.input_schema })) }];

function parseSse(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const event = frame.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
    const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || data.trim() === '[DONE]') return { event, data: null };
    return { event, data: JSON.parse(data) };
  });
}

async function messagesCalls(frames) {
  const result = await handleMessages({
    model: 'claude-haiku-5-5-low', max_tokens: 256, stream: true,
    tools: TOOLS_MESSAGES, tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: 'run both' }],
  }, streamDeps(frames));
  const res = fakeRes();
  await result.handler(res);
  const events = parseSse(res.body);

  const starts = events
    .filter((e) => e.data?.type === 'content_block_start' && e.data.content_block?.type === 'tool_use')
    .map((e) => ({ index: e.data.index, id: e.data.content_block.id, name: e.data.content_block.name }));
  const argsByIndex = new Map();
  const closed = new Set();
  let deltaToClosed = null;
  for (const e of events) {
    if (e.data?.type === 'content_block_stop') closed.add(e.data.index);
    if (e.data?.type === 'content_block_delta' && e.data.delta?.type === 'input_json_delta') {
      if (closed.has(e.data.index)) deltaToClosed = e.data.index;
      argsByIndex.set(e.data.index, (argsByIndex.get(e.data.index) || '') + e.data.delta.partial_json);
    }
  }
  const stopped = new Set(events.filter((e) => e.data?.type === 'content_block_stop').map((e) => e.data.index));
  return {
    starts,
    argsByIndex,
    deltaToClosed,
    stopped,
    stopReason: events.find((e) => e.data?.type === 'message_delta')?.data?.delta?.stop_reason,
  };
}

async function responsesCalls(frames) {
  const result = await handleResponses({
    model: 'gpt-5.2', stream: true, store: false, input: 'run both',
    tools: TOOLS_RESPONSES,
  }, { ...streamDeps(frames), context: { callerKey: 'api:a3-interleave:user:t' } });
  const res = fakeRes();
  await result.handler(res);
  const events = parseSse(res.body).map((e) => e.data).filter(Boolean);
  const added = events.filter((e) => e.type === 'response.output_item.added').map((e) => e.item);
  const done = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  const argsByItem = new Map();
  for (const e of events) {
    if (e.type === 'response.function_call_arguments.delta') {
      argsByItem.set(e.item_id, (argsByItem.get(e.item_id) || '') + e.delta);
    }
  }
  return { added, done, argsByItem };
}

async function geminiCalls(frames) {
  const result = await handleGemini('gemini-3-pro', {
    contents: [{ role: 'user', parts: [{ text: 'run both' }] }],
    tools: TOOLS_GEMINI,
  }, streamDeps(frames), { stream: true, alt: 'sse' });
  const res = fakeRes();
  await result.handler(res);
  const events = parseSse(res.body).map((e) => e.data).filter(Boolean);
  const calls = events
    .flatMap((e) => e.candidates?.[0]?.content?.parts || [])
    .filter((p) => p.functionCall)
    .map((p) => p.functionCall);
  return {
    calls,
    finishReason: events.map((e) => e.candidates?.[0]?.finishReason).filter(Boolean).pop(),
  };
}

describe('A3(b) — interleaved tool-call argument deltas', () => {
  assertFixture();

  for (const nameLast of [null, 'a', 'b']) {
    const label = nameLast ? ` (call ${nameLast.toUpperCase()}'s name settles last)` : ' (both names on the first delta)';
    const frames = interleavedFrames(nameLast);

    it(`Messages: each call assembles byte-exactly${label}`, async () => {
      const got = await messagesCalls(frames);
      assert.equal(got.starts.length, 2, `exactly two tool_use blocks, saw ${JSON.stringify(got.starts)}`);
      const byId = new Map(got.starts.map((s) => [s.id, s]));
      assert.equal(byId.get('call_a')?.name, 'run_a', 'call_a keeps its name');
      assert.equal(byId.get('call_b')?.name, 'run_b', 'call_b keeps its name');
      assert.equal(got.argsByIndex.get(byId.get('call_a').index), CALL_A, 'call_a arguments are byte-exact');
      assert.equal(got.argsByIndex.get(byId.get('call_b').index), CALL_B, 'call_b arguments are byte-exact');
      assert.equal(got.deltaToClosed, null, 'no input_json_delta targets a closed block');
      for (const s of got.starts) assert.ok(got.stopped.has(s.index), `block ${s.index} was stopped`);
      assert.equal(got.stopReason, 'tool_use');
    });

    it(`Responses: each call assembles byte-exactly${label}`, async () => {
      const got = await responsesCalls(frames);
      assert.equal(got.added.length, 2, 'two function_call items were announced');
      const byCallId = new Map(got.added.map((item) => [item.call_id, item]));
      assert.equal(byCallId.get('call_a')?.name, 'run_a');
      assert.equal(byCallId.get('call_b')?.name, 'run_b');
      assert.equal(got.argsByItem.get(byCallId.get('call_a').id), CALL_A, 'call_a deltas join to the exact payload');
      assert.equal(got.argsByItem.get(byCallId.get('call_b').id), CALL_B, 'call_b deltas join to the exact payload');
      const doneByCallId = new Map(got.done.map((item) => [item.call_id, item]));
      assert.equal(doneByCallId.get('call_a')?.arguments, CALL_A);
      assert.equal(doneByCallId.get('call_b')?.arguments, CALL_B);
      assert.equal(doneByCallId.get('call_a')?.name, 'run_a');
      assert.equal(doneByCallId.get('call_b')?.name, 'run_b');
    });

    it(`Gemini: each call assembles byte-exactly${label}`, async () => {
      const got = await geminiCalls(frames);
      assert.equal(got.calls.length, 2, `two functionCall parts, saw ${JSON.stringify(got.calls)}`);
      const byId = new Map(got.calls.map((c) => [c.id, c]));
      assert.equal(byId.get('call_a')?.name, 'run_a');
      assert.equal(byId.get('call_b')?.name, 'run_b');
      assert.equal(JSON.stringify(byId.get('call_a').args), CALL_A);
      assert.equal(JSON.stringify(byId.get('call_b').args), CALL_B);
      assert.equal(got.finishReason, 'STOP');
    });
  }
});

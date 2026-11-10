// V-12 (KH-009 / KH-020 / KH-045) — the Responses commit was lossy.
//
// MEASURED on the audited baseline: `committedToolCalls` kept ONLY
// `function_call` items, so a streamed `custom_tool_call` was never stored at
// all; it stored the CLIENT-facing name instead of the wire name, so a
// namespaced call (`ns__do_it`) was replayed as `do_it` against a `tools[]` that
// declared `ns__do_it`; and it flattened the whole turn into one assistant
// message whose `content` ran every text segment together with the calls last,
// losing text→call→text order. GET then rebuilt items from that flat message,
// re-typed custom calls as `function_call`, dropped namespaces and minted fresh
// item ids on every read.
//
// The contract this file pins, for a streamed turn carrying a namespaced
// function call AND a custom call:
//   * GET replays the exact ordered items, with the ids/call_ids/types/names the
//     stream published;
//   * the chained history keeps the order, and every call is sent upstream under
//     its WIRE name;
//   * the store's item sidecar never leaks into the upstream request body;
//   * a legacy flat entry (written before this change) still reconstructs.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleResponses, handleGetResponse } from '../src/handlers/responses.js';
import { resetResponseStore, putResponse } from '../src/response-store.js';

const KEY = 'api:v12:user:t';
const MODEL = 'gpt-5.2';

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

// text -> namespaced function call + custom call -> text -> terminal.
const FRAMES = [
  chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking.' } }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ns', type: 'function', function: { name: 'ns__do_it', arguments: '{"x":1}' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_sql', type: 'function', function: { name: 'run_sql', arguments: '{"input":"select 1"}' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: { content: 'Done.' } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
];

const TOOLS = [
  { type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'do_it', parameters: { type: 'object', properties: { x: { type: 'number' } } } }] },
  { type: 'custom', name: 'run_sql' },
];

function depsFor(frames, captured = {}) {
  return {
    async handleChatCompletions(body) {
      captured.body = body;
      return {
        status: 200, stream: true,
        async handler(res) { for (const f of frames) res.write(f); res.end(); },
      };
    },
  };
}

function parseSse(body) {
  return body.trim().split('\n\n').filter(Boolean).map((frame) => {
    const ev = frame.split('\n').find(x => x.startsWith('event: '))?.slice(7);
    const d = frame.split('\n').find(x => x.startsWith('data: '))?.slice(6);
    let data = null;
    try { data = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
    return { ev, data };
  }).filter(x => x.ev);
}

async function runStream(body = {}, frames = FRAMES) {
  const captured = {};
  const r = await handleResponses(
    { model: MODEL, stream: true, input: 'go', tools: TOOLS, ...body },
    { ...depsFor(frames, captured), context: { callerKey: KEY } },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = fakeRes();
  await r.handler(res);
  const evs = parseSse(res.body);
  const id = evs.find(e => e.data?.response?.id)?.data.response.id;
  assert.ok(id, 'the stream must report a response id');
  return { evs, id, captured };
}

beforeEach(() => resetResponseStore());
afterEach(() => resetResponseStore());

describe('V-12: streamed custom and namespaced calls survive GET', () => {
  it('replays the exact ordered items with their ids, types, names and call_ids', async () => {
    const { evs, id } = await runStream();
    const got = handleGetResponse(id, { context: { callerKey: KEY } });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const output = got.body.output;
    assert.deepEqual(output.map(i => i.type), ['message', 'function_call', 'custom_tool_call', 'message']);

    const fn = output[1];
    assert.equal(fn.name, 'do_it', 'GET reports the client-facing name');
    assert.equal(fn.namespace, 'ns', 'the namespace must survive retrieval');
    assert.equal(fn.call_id, 'call_ns');
    assert.equal(fn.arguments, '{"x":1}');

    const custom = output[2];
    assert.equal(custom.type, 'custom_tool_call', 'a custom call must never be re-typed as function_call');
    assert.equal(custom.name, 'run_sql');
    assert.equal(custom.call_id, 'call_sql');
    assert.equal(custom.input, 'select 1');

    // Same ids the stream published: a GET must retrieve what the POST reported.
    const added = evs.filter(e => e.ev === 'response.output_item.added').map(e => e.data.item);
    assert.deepEqual(output.map(i => i.id), added.map(i => i.id));
    assert.equal(got.body.output_text, 'Checking.Done.');
  });
});

describe('V-12: the chained turn keeps order and wire identity', () => {
  it('sends every call under its WIRE name, in the order the client saw, and leaks no bookkeeping', async () => {
    const { id } = await runStream();
    const { captured } = await runStream({
      input: [
        { type: 'function_call_output', call_id: 'call_ns', output: '42' },
        { type: 'function_call_output', call_id: 'call_sql', output: 'one row' },
      ],
      previous_response_id: id,
    });

    const messages = captured.body.messages;
    assert.ok(Array.isArray(messages) && messages.length, 'the chained request must carry a history');
    for (const m of messages) {
      assert.equal('__responses_items' in (m || {}), false, 'store bookkeeping must never reach the upstream body');
    }

    const assistantTurns = messages.filter(m => m?.role === 'assistant');
    const calls = assistantTurns.flatMap(m => m.tool_calls || []);
    assert.deepEqual(calls.map(c => c.id), ['call_ns', 'call_sql'], 'call ids are preserved and ordered');
    assert.deepEqual(calls.map(c => c.function.name), ['ns__do_it', 'run_sql'],
      'the wire names are what tools[] declared — not the client-facing names');
    assert.equal(calls[1].function.arguments, '{"input":"select 1"}', 'custom input keeps the wire encoding');

    // Order: narration, then the calls, then the post-call text, then the results.
    const kinds = messages.map((m) => {
      if (m.role === 'assistant' && m.tool_calls?.length) return `call:${m.tool_calls.map(c => c.function.name).join('+')}`;
      if (m.role === 'assistant') return `text:${m.content}`;
      if (m.role === 'tool') return `tool:${m.tool_call_id}`;
      return m.role;
    });
    assert.deepEqual(kinds, [
      'user',
      'text:Checking.',
      'call:ns__do_it+run_sql',
      'text:Done.',
      'tool:call_ns',
      'tool:call_sql',
    ]);
  });
});

describe('V-12: legacy entries still reconstruct', () => {
  it('an entry written before ordered items existed is rebuilt from its flat message', () => {
    resetResponseStore();
    const ok = putResponse('resp_legacy_v12', [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'old answer',
        tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
    ], KEY, { model: MODEL, status: 'completed' });
    assert.equal(ok, true);

    const got = handleGetResponse('resp_legacy_v12', { context: { callerKey: KEY } });
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.output.map(i => i.type), ['message', 'function_call']);
    assert.equal(got.body.output[1].call_id, 'call_old');
    assert.equal(got.body.output[1].name, 'lookup');
    assert.equal(got.body.output_text, 'old answer');
  });
});

// Item 16 — text arriving AFTER a tool call was merged back into the FIRST
// message item, so a client reassembling the turn placed all text before the call
// it actually followed.
//
// The message item was a singleton: `msgId` was minted once in the constructor and
// `messageStarted` latched true for the life of the stream. MEASURED pre-fix on
// frames "BEFORE " -> tool_call -> "AFTER":
//     output_item.added oi=0 message
//     output_item.added oi=1 function_call
//     output_item.done  oi=1 function_call
//     output_item.done  oi=0 message  text="BEFORE AFTER"
// Two defects in one trace: both texts in one item, and done emitted [1,0].
// Anthropic on identical frames opens content_block index=0 text / 1 tool_use /
// 2 text, which is the shape asserted here as a cross-protocol control.
//
// THE STORE IS DELIBERATELY NOT SEGMENTED. handleResponses persists one
// OpenAI-shaped assistant message whose `content` is a single string, which cannot
// express text-tool-text ordering. Storing only the last segment would silently
// drop the pre-tool text from the next chained turn's history, so the store keeps
// the whole turn's text while the WIRE is segmented. Losing text is worse than
// losing order; the last test in this file pins that decision.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleResponses, handleGetResponse } from '../src/handlers/responses.js';
import { handleMessages } from '../src/handlers/messages.js';
import { resetResponseStore, getResponse } from '../src/response-store.js';

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

// text -> tool call -> text -> clean terminal. The shape a model produces when it
// narrates, calls a tool, then comments on having called it.
const TEXT_TOOL_TEXT = [
  chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'BEFORE ' } }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: { content: 'AFTER' } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
];
// Control: no tool call at all. One message item must remain one message item.
const TEXT_ONLY = [
  chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'BEFORE ' } }] }),
  chunk({ choices: [{ index: 0, delta: { content: 'AFTER' } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
];

/** GET /v1/responses/{id} through the real handler. */
async function getResponseBody(id, callerKey) {
  const r = handleGetResponse(id, { context: { callerKey } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const depsFor = (frames) => ({
  async handleChatCompletions() {
    return {
      status: 200, stream: true,
      async handler(res) { for (const f of frames) res.write(f); res.end(); },
    };
  },
});

function parseSse(body) {
  return body.trim().split('\n\n').filter(Boolean).map(frame => {
    const ev = frame.split('\n').find(x => x.startsWith('event: '))?.slice(7);
    const d = frame.split('\n').find(x => x.startsWith('data: '))?.slice(6);
    let data = null;
    try { data = d ? JSON.parse(d) : null; } catch { /* non-JSON frame */ }
    return { ev, data };
  }).filter(x => x.ev);
}

async function runResponses(frames, body = {}) {
  const r = await handleResponses(
    {
      model: 'gpt-5.2', stream: true, input: 'hi',
      tools: [{ type: 'function', name: 'get_time', parameters: { type: 'object', properties: {} } }],
      ...body,
    },
    { ...depsFor(frames), context: { callerKey: 'api:posttool:user:t' } },
  );
  const res = fakeRes();
  await r.handler(res);
  return parseSse(res.body);
}

const itemEvents = (evs, kind) => evs
  .filter(e => e.ev === `response.output_item.${kind}`)
  .map(e => ({ oi: e.data?.output_index, type: e.data?.item?.type, id: e.data?.item?.id, item: e.data?.item }));

const itemText = (item) => (item?.content || []).map(c => c?.text || '').join('');

describe('item 16 — post-tool text gets its own output item', () => {
  it('emits two message items, each carrying only its own text', async () => {
    const done = itemEvents(await runResponses(TEXT_TOOL_TEXT), 'done');
    const messages = done.filter(d => d.type === 'message');
    assert.equal(messages.length, 2, 'post-tool text must open a second message item');
    assert.equal(itemText(messages[0].item), 'BEFORE ');
    assert.equal(itemText(messages[1].item), 'AFTER');
  });

  it('gives the second message item a distinct id', async () => {
    // Reusing msgId would make two items indistinguishable to a client keying by
    // item_id — it would see one item "updated" rather than two items.
    const done = itemEvents(await runResponses(TEXT_TOOL_TEXT), 'done');
    const ids = done.filter(d => d.type === 'message').map(d => d.id);
    assert.equal(new Set(ids).size, 2, `ids must differ, got ${JSON.stringify(ids)}`);
  });

  it('orders the tool call between the two text items', async () => {
    const added = itemEvents(await runResponses(TEXT_TOOL_TEXT), 'added');
    assert.deepEqual(added.map(a => a.type), ['message', 'function_call', 'message']);
    assert.deepEqual(added.map(a => a.oi), [0, 1, 2]);
  });

  it('emits output_item.done in ascending output_index', async () => {
    // Pre-fix measured [1, 0]: finish() called finishToolCalls() before
    // finishMessage(), so the tool item closed before the message that opened
    // first. Sealing at tool-item creation makes emission order match index order
    // without reordering finish().
    const order = itemEvents(await runResponses(TEXT_TOOL_TEXT), 'done').map(d => d.oi);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `done order was ${JSON.stringify(order)}`);
  });

  it('scopes output_text.done to the item it closes', async () => {
    // The event that republished pre-tool text inside the post-tool item.
    const texts = (await runResponses(TEXT_TOOL_TEXT))
      .filter(e => e.ev === 'response.output_text.done')
      .map(e => e.data?.text);
    assert.deepEqual(texts, ['BEFORE ', 'AFTER']);
  });

  it('leaves a text-only turn as a single item', async () => {
    // OVER-REACH CONTROL: sealing must be triggered by a tool call, not by any
    // second delta. If this splits, every ordinary multi-delta answer fragments.
    const done = itemEvents(await runResponses(TEXT_ONLY), 'done');
    const messages = done.filter(d => d.type === 'message');
    assert.equal(messages.length, 1);
    assert.equal(itemText(messages[0].item), 'BEFORE AFTER');
  });

  it('round-trips the ordered items: text, call, text — not one merged string', async () => {
    // V-12/KH-009: the store used to keep ONE assistant message whose `content`
    // was "BEFORE AFTER" with the call appended last, so a chained turn saw an
    // order the client never received. The turn's ordered items are persisted
    // now, and GET replays them with the ids the client already has.
    resetResponseStore();
    const KEY = 'api:posttool:user:t';
    const evs = await runResponses(TEXT_TOOL_TEXT);
    const id = evs.find(e => e.data?.response?.id)?.data.response.id;
    assert.ok(id, 'the stream must report a response id');

    // The chained history keeps the order too: text run, then the call.
    const stored = getResponse(id, KEY);
    assert.equal(stored.ok, true, `expected a stored entry, got ${stored.reason}`);
    const assistant = [...stored.messages].reverse().find(m => m?.role === 'assistant');
    assert.deepEqual(assistant.__responses_items.map(i => i.type), ['message', 'function_call', 'message']);
    assert.equal(assistant.__responses_items[0].content[0].text, 'BEFORE ');
    assert.equal(assistant.__responses_items[2].content[0].text, 'AFTER');

    const got = await getResponseBody(id, KEY);
    assert.deepEqual(got.output.map(i => i.type), ['message', 'function_call', 'message']);
    assert.equal(got.output[0].content[0].text, 'BEFORE ');
    assert.equal(got.output[2].content[0].text, 'AFTER');
    // Stable identity: the items GET returns are the ones the stream published.
    const added = itemEvents(evs, 'added').map(a => a.item);
    assert.deepEqual(got.output.map(i => i.id), added.map(i => i.id));
    assert.equal(got.output[1].call_id, 'call_1');
  });
});

describe('item 16 — Anthropic already had the right shape (control)', () => {
  it('opens a third content block for post-tool text on identical frames', async () => {
    // Not an assertion about our fix — it is the reference the fix aligns to. If
    // this ever changes, the cross-protocol comparison above stops meaning anything.
    const r = await handleMessages(
      {
        model: 'claude-sonnet-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_time', input_schema: { type: 'object', properties: {} } }],
      },
      depsFor(TEXT_TOOL_TEXT),
    );
    const res = fakeRes();
    await r.handler(res);
    const blocks = parseSse(res.body)
      .filter(e => e.ev === 'content_block_start')
      .map(e => ({ index: e.data?.index, type: e.data?.content_block?.type }));
    assert.deepEqual(blocks, [
      { index: 0, type: 'text' },
      { index: 1, type: 'tool_use' },
      { index: 2, type: 'text' },
    ]);
  });
});

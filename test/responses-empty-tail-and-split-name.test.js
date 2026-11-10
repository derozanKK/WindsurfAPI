// D4 — an EMPTY assistant message closed every turn that narrated, then called a
// tool. `finish()` gated the closing message on `this.text` (the whole-turn
// accumulator) while `finishMessage()` published `this.segmentText` (the current
// item's text). After a tool call sealed the pre-tool item, `segmentText` was ''
// but `text` still held the narration, so a third, empty message item was added
// and completed:
//     output [message "BEFORE ", function_call, message ""]
// The gate must ask about the CURRENT item, not the turn.
//
// GFProtocol Q1 — a `function.name` split across deltas froze the stream. The
// first fragment set `deferred`, and the `!this.deferred && knownToolName(...)`
// guard meant the item could never open once the name settled; every later event
// was buffered until `finish()` replayed them, events-before-text. MEASURED on
// text A -> tool(name "get_"+"time") -> text B -> tool2 -> text C:
//   bytes constant from the first fragment through finish,
//   output_item.done oi=3 emitted before oi=2,
//   text B and C merged into ONE message item (the seal never ran between them).
// Both defects are in the same translator state machine, so they are pinned here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleResponses } from '../src/handlers/responses.js';

function fakeRes(log = null) {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); if (log) log.push({ wire: String(c).length }); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; },
    setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}
const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;

const TOOLS = [
  { type: 'function', name: 'get_time', parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'other_tool', parameters: { type: 'object', properties: {} } },
];

const text = (t) => chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: t } }] });
const tool = (fields) => chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', ...fields }] } }] });
const finish = (reason = 'tool_calls') => chunk({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const DONE = 'data: [DONE]\n\n';

// Narration, a tool call, then the turn ends: nothing follows the call.
const TEXT_TOOL_END = [
  text('BEFORE '),
  tool({ id: 'call_1', function: { name: 'get_time', arguments: '{}' } }),
  finish(),
  DONE,
];

// The same turn with the tool name split across two deltas, then post-tool text.
const TEXT_SPLIT_TOOL_TEXT = [
  text('BEFORE '),
  tool({ id: 'call_1', function: { name: 'get_' } }),
  tool({ function: { name: 'time' } }),
  tool({ function: { arguments: '{}' } }),
  text('AFTER'),
  finish(),
  DONE,
];

// GFProtocol's measured shape: two calls, the first name split, text between them.
const TEXT_SPLIT_TOOL_TEXT_TOOL_TEXT = [
  text('A'),
  tool({ id: 'call_1', function: { name: 'get_' } }),
  tool({ function: { name: 'time' } }),
  tool({ function: { arguments: '{}' } }),
  text('B'),
  tool({ id: 'call_2', index: 1, function: { name: 'other_tool', arguments: '{}' } }),
  text('C'),
  finish(),
  DONE,
];

const depsFor = (frames, log = null) => ({
  async handleChatCompletions() {
    return {
      status: 200, stream: true,
      async handler(res) {
        for (const f of frames) {
          // Marker BEFORE the upstream frame: everything the translator wrote so
          // far is already in the log, so the next entry's byte count is exactly
          // what the client had seen when this frame arrived.
          if (log) log.push({ frame: true });
          res.write(f);
        }
        res.end();
      },
    };
  },
});

/** Bytes written to the client before each upstream frame was processed. */
function bytesPerFrame(log) {
  let bytes = 0;
  const out = [];
  for (const entry of log) {
    if (entry.frame) out.push(bytes);
    else bytes += entry.wire;
  }
  return out;
}

function parseSse(body) {
  return body.trim().split('\n\n').filter(Boolean).map(frame => {
    const ev = frame.split('\n').find(x => x.startsWith('event: '))?.slice(7);
    const d = frame.split('\n').find(x => x.startsWith('data: '))?.slice(6);
    let data = null;
    try { data = d ? JSON.parse(d) : null; } catch { /* non-JSON frame */ }
    return { ev, data };
  }).filter(x => x.ev);
}

async function runResponses(frames, { log = null, body = {} } = {}) {
  const r = await handleResponses(
    { model: 'gpt-5.2', stream: true, input: 'hi', tools: TOOLS, ...body },
    { ...depsFor(frames, log), context: { callerKey: 'api:responsesfix:user:t' } },
  );
  const res = fakeRes(log);
  await r.handler(res);
  return parseSse(res.body);
}

const completed = (evs) => evs.find(e => e.ev === 'response.completed')?.data?.response;
const itemText = (item) => (item?.content || []).map(c => c?.text || '').join('');
const itemsOfType = (output, type) => (output || []).filter(i => i?.type === type);
const added = (evs) => evs.filter(e => e.ev === 'response.output_item.added')
  .map(e => ({ oi: e.data?.output_index, type: e.data?.item?.type }));
const done = (evs) => evs.filter(e => e.ev === 'response.output_item.done')
  .map(e => ({ oi: e.data?.output_index, type: e.data?.item?.type, item: e.data?.item }));
const textDone = (evs) => evs.filter(e => e.ev === 'response.output_text.done').map(e => e.data?.text);
const textDeltas = (evs) => evs.filter(e => e.ev === 'response.output_text.delta').map(e => e.data?.delta).join('');

describe('D4 — a turn that ends after a tool call has no empty trailing message', () => {
  it('completes with exactly the message and the call', async () => {
    const output = completed(await runResponses(TEXT_TOOL_END)).output;
    assert.deepEqual(output.map(i => i.type), ['message', 'function_call'],
      `output was ${JSON.stringify(output.map(i => [i.type, itemText(i)]))}`);
    assert.deepEqual(itemsOfType(output, 'message').map(itemText), ['BEFORE ']);
  });

  it('never emits an empty output_text.done or an empty completed item', async () => {
    const evs = await runResponses(TEXT_TOOL_END);
    assert.deepEqual(textDone(evs), ['BEFORE '], 'a second, empty output_text.done means a phantom item closed');
    const empty = done(evs).filter(d => d.type === 'message' && itemText(d.item) === '');
    assert.deepEqual(empty, []);
  });

  it('does not add a third item when the tool name is split', async () => {
    // Same empty-tail defect, reached through the deferral path: `text` is set,
    // `segmentText` is '' after the seal.
    const evs = await runResponses([
      text('BEFORE '),
      tool({ id: 'call_1', function: { name: 'get_' } }),
      tool({ function: { name: 'time' } }),
      finish(),
      DONE,
    ]);
    const output = completed(evs).output;
    assert.deepEqual(output.map(i => i.type), ['message', 'function_call']);
    assert.deepEqual(textDone(evs), ['BEFORE ']);
  });
});

describe('GFProtocol Q1 — a split function.name must not freeze the stream', () => {
  it('publishes the call as soon as the name settles', async () => {
    const log = [];
    const evs = await runResponses(TEXT_SPLIT_TOOL_TEXT, { log });
    // Frames: 0 text A, 1 "get_", 2 "time", 3 args, 4 text AFTER, 5 finish.
    const b = bytesPerFrame(log);
    assert.ok(b[3] > b[2],
      `stream stayed frozen after the name settled: before "time" ${b[2]} bytes, before args ${b[3]}`);
    assert.ok(b[4] > b[3],
      `the call's arguments were withheld until finish: before args ${b[3]} bytes, before post-tool text ${b[4]}`);
    assert.ok(b[5] > b[4],
      `post-tool text was withheld until finish: before text ${b[4]} bytes, before finish ${b[5]}`);
    // The item is announced before any event that follows it.
    const addedEv = evs.findIndex(e => e.ev === 'response.output_item.added' && e.data?.item?.type === 'function_call');
    const afterDelta = evs.findIndex(e => e.ev === 'response.output_text.delta' && e.data?.delta === 'AFTER');
    assert.ok(addedEv !== -1 && addedEv < afterDelta,
      `function_call added at ${addedEv}, post-tool text at ${afterDelta}`);
    // Same shape on the wire: the split name is whole and each text segment has
    // its own item. (Pre-fix these array assertions also held — the observable
    // defect for this shape is the freeze above, which is why the byte probe is
    // the red assertion.)
    const output = completed(evs).output;
    assert.deepEqual(output.map(i => i.type), ['message', 'function_call', 'message']);
    assert.deepEqual(itemsOfType(output, 'message').map(itemText), ['BEFORE ', 'AFTER']);
    const [call] = itemsOfType(output, 'function_call');
    assert.equal(call.name, 'get_time');
    assert.equal(call.arguments, '{}');
    assert.deepEqual(added(evs).map(a => a.oi), [0, 1, 2]);
  });

  it('holds text that arrives between name fragments until the name settles', async () => {
    // Upstream can interleave name:"get_" -> text -> name:"time". Text does not
    // prove the name is final, so publishing it here would put "get_" on the wire
    // — uncorrectable. The text is held and emitted after the call it followed.
    const log = [];
    const evs = await runResponses([
      text('A'),
      tool({ id: 'call_1', function: { name: 'get_' } }),
      text('B'),
      tool({ function: { name: 'time' } }),
      tool({ function: { arguments: '{}' } }),
      text('C'),
      finish(),
      DONE,
    ], { log });
    // Frames: 0 A, 1 "get_", 2 B, 3 "time", 4 args, 5 C, 6 finish.
    const b = bytesPerFrame(log);
    assert.equal(b[3], b[2], `held text was written before the name settled: ${b[2]} -> ${b[3]}`);
    assert.ok(b[4] > b[3], `call not published when its name settled: ${b[3]} -> ${b[4]}`);
    assert.ok(b[6] > b[5], `post-name text was withheld until finish: ${b[5]} -> ${b[6]}`);

    const output = completed(evs).output;
    assert.deepEqual(output.map(i => i.type), ['message', 'function_call', 'message']);
    assert.deepEqual(itemsOfType(output, 'message').map(itemText), ['A', 'BC']);
    assert.deepEqual(itemsOfType(output, 'function_call').map(i => i.name), ['get_time']);
    assert.ok(!output.some(i => i.name === 'get_'), 'a partial function name was published');
    assert.equal(textDeltas(evs), 'ABC');
  });

  it('does not resolve on an args-only delta for a different call', async () => {
    // The args of call 2 say nothing about call 1's still-fragmenting name.
    // Resolving here published "get_" (measured pre-review).
    const log = [];
    const evs = await runResponses([
      text('A'),
      tool({ id: 'call_1', function: { name: 'get_' } }),
      tool({ id: 'call_2', index: 1, function: { name: 'other_tool' } }),
      tool({ index: 1, function: { arguments: '{}' } }),
      tool({ function: { name: 'time' } }),
      tool({ function: { arguments: '{}' } }),
      finish(),
      DONE,
    ], { log });
    // Frames: 0 A, 1 "get_", 2 call 2, 3 call 2 args, 4 "time", 5 call 1 args, 6 finish.
    const b = bytesPerFrame(log);
    assert.ok(b[5] > b[4], `deferred call not published when its name settled: ${b[4]} -> ${b[5]}`);
    const output = completed(evs).output;
    assert.deepEqual(itemsOfType(output, 'function_call').map(i => i.name), ['get_time', 'other_tool']);
    assert.ok(!output.some(i => i.name === 'get_'), 'a partial function name was published');
    assert.equal(itemsOfType(output, 'function_call')[1].arguments, '{}');
  });

  it('does not merge text that a second call separates', async () => {
    const evs = await runResponses(TEXT_SPLIT_TOOL_TEXT_TOOL_TEXT);
    const output = completed(evs).output;
    assert.deepEqual(output.map(i => i.type),
      ['message', 'function_call', 'message', 'function_call', 'message']);
    assert.deepEqual(itemsOfType(output, 'message').map(itemText), ['A', 'B', 'C']);
    assert.deepEqual(itemsOfType(output, 'function_call').map(i => i.name), ['get_time', 'other_tool']);
    assert.deepEqual(added(evs).map(a => a.oi), [0, 1, 2, 3, 4],
      `added order was ${JSON.stringify(added(evs).map(a => a.oi))}`);
    // Every item is announced before it closes. The pre-fix flush emitted the
    // second call's done (oi=3) before the text item that opened before it (oi=2)
    // was ever announced.
    const announced = new Set();
    for (const e of evs) {
      if (e.ev === 'response.output_item.added') announced.add(e.data?.output_index);
      if (e.ev === 'response.output_item.done') {
        assert.ok(announced.has(e.data?.output_index),
          `done for oi=${e.data?.output_index} arrived before its added`);
      }
    }
    // Interleaving, not just the final array: B's item opens before call 2, and
    // C's item opens after it.
    const bDelta = evs.findIndex(e => e.ev === 'response.output_text.delta' && e.data?.delta === 'B');
    const call2 = evs.findIndex(e => e.ev === 'response.output_item.added' && e.data?.item?.name === 'other_tool');
    const cDelta = evs.findIndex(e => e.ev === 'response.output_text.delta' && e.data?.delta === 'C');
    assert.ok(bDelta !== -1 && bDelta < call2, `B at ${bDelta}, call 2 at ${call2}`);
    assert.ok(cDelta > call2, `C at ${cDelta}, call 2 at ${call2}`);
  });

  it('neither duplicates nor loses text across the split', async () => {
    const evs = await runResponses(TEXT_SPLIT_TOOL_TEXT_TOOL_TEXT);
    assert.equal(textDeltas(evs), 'ABC', 'deltas must carry each character exactly once');
    assert.deepEqual(textDone(evs), ['A', 'B', 'C'], 'each segment closes with only its own text');
    const output = completed(evs).output;
    assert.equal(itemsOfType(output, 'message').map(itemText).join(''), 'ABC');
  });

  it('never publishes the pending call\'s fragment when another call settles', async () => {
    // Deferral is per CALL, not global: a second call whose name is already known
    // may be published while the first is still fragmenting, but the first must
    // keep waiting. Opening it here would put "get_" on the wire, which the event
    // contract cannot correct.
    const log = [];
    const evs = await runResponses([
      text('A'),
      tool({ id: 'call_1', function: { name: 'get_' } }),
      tool({ id: 'call_2', index: 1, function: { name: 'other_tool', arguments: '{}' } }),
      tool({ function: { name: 'time' } }),
      tool({ function: { arguments: '{}' } }),
      finish(),
      DONE,
    ], { log });
    // Frames: 0 A, 1 "get_", 2 call 2, 3 "time", 4 args, 5 finish.
    const b = bytesPerFrame(log);
    assert.ok(b[4] > b[3], `deferred call not published when its name settled: ${b[3]} -> ${b[4]}`);
    const output = completed(evs).output;
    assert.deepEqual(itemsOfType(output, 'function_call').map(i => i.name), ['get_time', 'other_tool']);
    assert.ok(!output.some(i => i.name === 'get_'), 'a partial function name was published');
    assert.deepEqual(added(evs).map(a => a.oi), [0, 1, 2],
      `added order was ${JSON.stringify(added(evs).map(a => a.oi))}`);
    assert.equal(textDeltas(evs), 'A');
  });
});

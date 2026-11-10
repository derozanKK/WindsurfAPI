// The per-entry byte ceiling could not see ARRAY content — which is the default
// shape for the Responses API.
//
// trimContentToFit is the last resort in capEntryBytes: when a conversation cannot
// be shrunk by dropping whole messages, it cuts the text itself. It found the
// biggest field with
//
//     const c = out[i]?.content;
//     const len = typeof c === 'string' ? c.length : 0;
//
// so for array content no candidate was ever found, `biggest` stayed -1 and the
// loop broke on its first iteration. MAX_ENTRY_BYTES was a no-op for the common
// case. responsesToChat normalizes every Responses input item into typed blocks, so
// array content is what this store actually holds most of the time.
//
// What made it invisible: approxBytes/strBytes DO walk arrays correctly (that was
// fixed after the vision-payload undercount). The metering was right and the
// enforcement was not, so every byte-budget assertion passed while the cap did
// nothing.
//
// MEASURED at RESPONSE_STORE_MAX_BYTES=400k (=> MAX_ENTRY_BYTES 102400):
//   content as string, 200000 chars -> stored  50124 chars, marker present
//   content as array,  200000 chars -> stored 200000 chars, NO marker, 400104 bytes
// i.e. ~3.9x the per-entry ceiling. Consequence: one tenant can LRU-evict the whole
// store, which is the cross-tenant DoS the ceiling exists to prevent.

process.env.RESPONSE_STORE_MAX_BYTES = '400k';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../src/response-store.js');

const A = 'api:arrayarrayarrayarrayarrayarray:user:alice';
// MAX_ENTRY_BYTES = max(64k, floor(400k/4)) = 102400 at this budget.
const MAX_ENTRY_BYTES = Math.max(64 * 1024, Math.floor(400 * 1024 / 4));
const BIG = 200000;
const marked = (v) => /truncated by the response store/.test(JSON.stringify(v));

beforeEach(() => store.resetResponseStore());

describe('per-entry ceiling: array content is capped like string content', () => {
  it('a single oversized text BLOCK is cut, with a visible marker', () => {
    store.putResponse('a', [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(BIG) }] },
    ], A);
    const got = store.getResponse('a', A);
    assert.equal(got.ok, true, 'it must still be readable — trimmed, not rejected');
    const text = got.messages[0].content[0].text;
    assert.ok(text.length < BIG,
      `the block must actually shrink; stored ${text.length} of ${BIG} chars — a stored `
      + 'length equal to the input is the defect (array content was invisible to the cap)');
    assert.match(text, /truncated by the response store/,
      'the truncation must be visible, not silent');
    assert.ok(store.getResponseStoreStats().bytes <= MAX_ENTRY_BYTES,
      `the entry must fit the ceiling (${store.getResponseStoreStats().bytes} vs ${MAX_ENTRY_BYTES})`);
  });

  it('the array BLOCK STRUCTURE survives the cut', () => {
    // A Responses content array holds typed blocks and the next turn is replayed
    // from it: a cut that flattened the array to a string, dropped the block, or lost
    // `type` would break the replay just as surely as over-retention breaks memory.
    store.putResponse('b', [
      { role: 'user', content: [
        { type: 'text', text: 'keep me' },
        { type: 'text', text: 'y'.repeat(BIG) },
      ] },
    ], A);
    const msg = store.getResponse('b', A).messages[0];
    assert.ok(Array.isArray(msg.content), 'content must still be an array');
    assert.equal(msg.content.length, 2, 'no block may be dropped');
    assert.deepEqual(msg.content.map(p => p.type), ['text', 'text'],
      'every block must keep its discriminator');
    assert.equal(msg.content[0].text, 'keep me',
      'the small block must be untouched — only the biggest field is cut');
    assert.ok(msg.content[1].text.length < BIG, 'the big block is the one that shrinks');
    assert.equal(msg.role, 'user', 'the role must survive');
  });

  it('an oversized base64 image URL is capped too', () => {
    // The vision shape: {type:'image_url', image_url:{url:'data:...;base64,...'}}.
    // It has no `.text` at all, so it was doubly invisible — the ceiling never saw
    // it, and this is the exact payload that made the byte accounting get fixed.
    store.putResponse('img', [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(BIG)}` } },
      ] },
    ], A);
    const got = store.getResponse('img', A);
    assert.equal(got.ok, true);
    const block = got.messages[0].content[0];
    assert.equal(block.type, 'image_url', 'the block type must survive');
    assert.ok(block.image_url && typeof block.image_url.url === 'string',
      'the nested image_url object must survive');
    assert.ok(block.image_url.url.length < BIG,
      `the data URI must shrink; stored ${block.image_url.url.length} of ${BIG}`);
    assert.ok(store.getResponseStoreStats().bytes <= MAX_ENTRY_BYTES,
      'and the entry must fit the ceiling');
  });

  it('oversized tool_call arguments are capped', () => {
    // approxBytes charges tool_call arguments, so a huge arguments string counts
    // against the budget — and before the fix nothing could shrink it either.
    store.putResponse('tc', [{
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: 'q'.repeat(BIG) } }],
    }], A);
    const got = store.getResponse('tc', A);
    assert.equal(got.ok, true);
    const tc = got.messages[0].tool_calls[0];
    assert.equal(tc.id, 'call_1',
      'the call id pairs this call with its tool result — it must never be cut');
    assert.equal(tc.function.name, 'write_file', 'the function name must never be cut');
    assert.ok(tc.function.arguments.length < BIG, 'the arguments payload is what shrinks');
    assert.ok(store.getResponseStoreStats().bytes <= MAX_ENTRY_BYTES,
      'and the entry must fit the ceiling');
  });

  it('a tool_call_id is never cut, so the call/result pairing survives', () => {
    // A tool result whose tool_call_id no longer matches makes the upstream reject
    // the whole conversation with an opaque internal error (the same failure
    // response-store-dedup.test.js documents).
    //
    // The leading system message is load-bearing for the SHAPE of this test, not
    // decoration: capEntryBytes drops whole messages first and only the head plus
    // the final oversized turn reach trimContentToFit, so this is what a
    // multi-message input to the content trim actually looks like.
    const longId = `call_${'d'.repeat(300)}`;
    store.putResponse('pair', [
      { role: 'system', content: 'INSTRUCTIONS' },
      { role: 'tool', tool_call_id: longId, content: 'z'.repeat(BIG) },
    ], A);
    const msgs = store.getResponse('pair', A).messages;
    assert.equal(msgs.length, 2, 'precondition: both messages reached the content trim');
    assert.equal(msgs[0].content, 'INSTRUCTIONS', 'the small system message is untouched');
    assert.equal(msgs[1].tool_call_id, longId,
      'the tool_call_id must be byte-identical — cutting it orphans the result');
    assert.equal(msgs[1].role, 'tool', 'and the role must survive');
    assert.ok(msgs[1].content.length < BIG, 'while the payload shrinks');
    assert.ok(store.getResponseStoreStats().bytes <= MAX_ENTRY_BYTES);
  });

  // EVERY key on the unshrinkable list, each made the LARGEST string in turn.
  //
  // Three mutations in a row survived here — `tool_call_id`, then `type` — and the
  // cause was the same each time and was NOT a missing assertion about that key:
  // there WAS one. The fixtures simply always paired the key with a much larger
  // payload, so the shrink loop had a bigger candidate and never had to consult the
  // list. Every such assertion was really testing "the loop picked the payload".
  //
  // Fixing them one at a time is whack-a-mole, because the gap belongs to the list
  // as a whole: any entry that is never the biggest string in any fixture is
  // unguarded, and the list will grow. So drive the whole list from one table, with
  // that key inflated past everything else. `role` is excluded deliberately — it is
  // a protocol enum ('user'/'assistant'/'tool'), an oversized one is not a shape
  // this store can receive, and inventing one would test the harness rather than
  // the store.
  for (const key of ['tool_call_id', 'type', 'id', 'name']) {
    it(`${key} is spared even when it IS the largest field`, () => {
      // The key carries the bulk, the payload is tiny: whatever pushes this entry
      // over the ceiling, the only string worth cutting is the identity key itself.
      const huge = 'e'.repeat(MAX_ENTRY_BYTES);
      // A tool result is the shape that carries all four of these keys at once
      // (tool_call_id on the message, type/id/name inside a content block), so one
      // fixture shape covers the whole table without inventing per-key messages.
      const block = { type: 'input_text', id: 'blk_1', name: 'attachment', text: 'small payload' };
      block[key] = key === 'tool_call_id' ? block[key] : huge;
      const msg = { role: 'tool', tool_call_id: key === 'tool_call_id' ? huge : 'call_1', content: [block] };
      const stored = store.putResponse(`biggest_${key}`, [{ role: 'system', content: 'INSTRUCTIONS' }, msg], A);
      const got = store.getResponse(`biggest_${key}`, A);
      if (!stored) {
        // A20: the whole write is rejected when an unshrinkable field alone
        // exceeds the ceiling. That is the correct outcome — the alternative is
        // storing an over-cap entry or silently changing the field's meaning.
        assert.equal(got.ok, false,
          `${key} must never be stored truncated: an impossible entry must be rejected whole`);
        return;
      }
      const messages = got.messages;
      const last = messages[messages.length - 1];
      const actual = key === 'tool_call_id' ? last.tool_call_id : last.content[0][key];
      const expected = key === 'tool_call_id' ? huge : huge;
      assert.equal(actual, expected,
        `${key} is the largest string in this entry and must still be byte-identical — `
        + 'truncating it changes what the field MEANS, not merely how much of it is kept');
    });
  }

  it('the biggest field is chosen across DIFFERENT messages and shapes', () => {
    // Mixed shapes in one conversation: the loop must compare a plain string against
    // a block's text, not just look at one message or one shape.
    store.putResponse('mix', [
      { role: 'system', content: [{ type: 'text', text: 'INSTRUCTIONS' }] },
      { role: 'system', content: 'small string' },
      { role: 'user', content: [{ type: 'text', text: 'w'.repeat(BIG) }] },
    ], A);
    const msgs = store.getResponse('mix', A).messages;
    assert.equal(msgs.length, 3, 'nothing needed dropping — only the big field is cut');
    assert.equal(msgs[0].content[0].text, 'INSTRUCTIONS',
      'a small array block is untouched');
    assert.equal(msgs[1].content, 'small string', 'a small plain string is untouched');
    assert.ok(msgs[2].content[0].text.length < BIG, 'the big block is the one that shrank');
    assert.ok(store.getResponseStoreStats().bytes <= MAX_ENTRY_BYTES);
  });

  it('the string shape behaves exactly as before (no regression)', () => {
    store.putResponse('s', [{ role: 'user', content: 'x'.repeat(BIG) }], A);
    const content = store.getResponse('s', A).messages[0].content;
    assert.equal(typeof content, 'string', 'a plain string must stay a plain string');
    assert.match(content, /truncated by the response store/);
    assert.ok(store.getResponseStoreStats().bytes <= MAX_ENTRY_BYTES);
  });
});

describe('per-entry ceiling: NEGATIVE CONTROL — an under-cap entry is untouched', () => {
  it('a small array conversation round-trips byte-identically', () => {
    // The fix must not shrink anything that already fits. Deep equality against the
    // input is the assertion: any stray truncation, marker or restructuring fails it.
    const conv = [
      { role: 'system', content: [{ type: 'text', text: 'INSTRUCTIONS' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'result' }] },
    ];
    store.putResponse('ok', conv, A);
    const got = store.getResponse('ok', A);
    assert.equal(got.ok, true);
    assert.deepEqual(got.messages, conv,
      'an entry that already fits must be stored exactly as given');
    assert.equal(marked(got.messages), false, 'and carry no truncation marker');
  });

  it('an entry just under the ceiling is not cut', () => {
    // A 40000-char block is ~80KB accounted, under the 102400 ceiling.
    const text = 'u'.repeat(40000);
    store.putResponse('near', [{ role: 'user', content: [{ type: 'text', text }] }], A);
    const got = store.getResponse('near', A);
    assert.equal(got.messages[0].content[0].text, text,
      'a conversation under the ceiling must be byte-identical');
    assert.equal(marked(got.messages), false);
  });

  it('the caller\'s own message objects are never mutated', () => {
    // The trim works on copies. A shallow `{...m}` still shares the content ARRAY
    // with the live request body, so writing through it would rewrite the very
    // messages the upstream is about to be sent — a corruption with no marker
    // anywhere, in the request rather than the store.
    const block = { type: 'text', text: 'v'.repeat(BIG) };
    const original = { role: 'user', content: [block] };
    store.putResponse('nomutate', [original], A);
    assert.equal(block.text.length, BIG,
      'the caller\'s block must be untouched — the store trims a copy');
    assert.equal(original.content[0], block, 'and the array must still hold it');
    assert.ok(store.getResponse('nomutate', A).messages[0].content[0].text.length < BIG,
      'while the STORED copy is trimmed');
  });
});

describe('per-entry ceiling: one tenant cannot evict the store through array content', () => {
  it('array-shaped hogs do not flush other tenants', () => {
    // This is the consequence that made D2 worth fixing rather than just untidy.
    // The ceiling is what lets the byte-denominated fair share converge; with array
    // content invisible to it, a hog's entry stayed ~4x over the ceiling and the
    // eviction loop reclaimed from whoever was oldest — strangers.
    for (let t = 0; t < 4; t++) {
      store.putResponse(`n${t}`, [
        { role: 'user', content: [{ type: 'text', text: 'n'.repeat(10000) }] },
      ], `api:neigh${t}:user:1`);
    }
    const seeded = [0, 1, 2, 3].map(t => store.getResponse(`n${t}`, `api:neigh${t}:user:1`).ok);
    assert.deepEqual(seeded, [true, true, true, true], 'precondition: neighbours seeded');

    for (let i = 0; i < 5; i++) {
      store.putResponse(`hog${i}`, [
        { role: 'user', content: [{ type: 'text', text: 'h'.repeat(BIG) }] },
      ], 'api:hog:user:1');
    }

    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= st.maxBytes,
      `the budget must hold with array-shaped hogs (${st.bytes} vs ${st.maxBytes})`);
    const survivors = [0, 1, 2, 3].filter(t => store.getResponse(`n${t}`, `api:neigh${t}:user:1`).ok).length;
    assert.ok(survivors >= 3,
      `the hog must pay for its own growth; ${survivors}/4 neighbours survived`);
  });
});

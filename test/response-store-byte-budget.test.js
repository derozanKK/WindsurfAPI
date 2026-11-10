// Response store: the byte budget.
//
// MAX_ENTRIES and MAX_MESSAGES bound COUNTS, not memory. Measured on realistic
// agent-loop conversations (8KB system prompt + 200 tool_call/tool_result pairs
// with 4KB outputs, already truncated to MAX_MESSAGES): ~167KB of heap per stored
// entry. At the default 2000 entries that is ~327MB, and a text-heavy shape
// measured ~518MB — enough to matter on its own on the 2GB VPSes this project
// explicitly targets (the README tells such hosts to lower LS_MAX_INSTANCES).
//
// So the store carries a byte budget too and evicts on whichever limit binds
// first. The one thing it must never do is evict the entry just written: that is
// the caller's live conversation, and dropping it would make the response id they
// were just handed unusable.

process.env.RESPONSE_STORE_MAX_BYTES = '2m';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../src/response-store.js');
const { parseByteSize } = store;

const CALLER = (n) => `api:budgetbudgetbudgetbudgetbudget:user:u${n}`;

// ~408KB per conversation: a big system prompt plus 100 tool results.
function bigConversation(seed) {
  return [
    { role: 'system', content: 'S'.repeat(8000) },
    ...Array.from({ length: 100 }, (_, i) => ({
      role: 'tool',
      tool_call_id: `c${seed}_${i}`,
      content: `${seed}:${i}:${'z'.repeat(4000)}`,
    })),
  ];
}

beforeEach(() => store.resetResponseStore());

describe('byte budget is enforced', () => {
  it('keeps the running total within the configured budget', () => {
    for (let i = 0; i < 60; i++) store.putResponse(`r${i}`, bigConversation(i), CALLER(i));
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= st.maxBytes,
      `total ${st.bytes} must stay within budget ${st.maxBytes}`);
    assert.ok(st.evictions > 0, 'the budget must actually have evicted something');
  });

  it('reports the budget and the running total for operators', () => {
    store.putResponse('r1', bigConversation(1), CALLER(1));
    const st = store.getResponseStoreStats();
    assert.equal(typeof st.bytes, 'number');
    assert.equal(st.maxBytes, 2 * 1024 * 1024, 'the env override must be honoured');
    assert.ok(st.bytes > 0, 'a stored conversation must contribute bytes');
  });

  it('never evicts the entry just written — a single oversized conversation still yields a usable id', () => {
    // The mechanism: set() puts the new entry at the Map TAIL (most-recently-used),
    // so oldestId() cannot select it while other entries exist, and the loop's
    // `size > 1` condition covers the sole-entry case. Mutation-checked: removing
    // the size guard is what breaks this, not any per-id special case.

    // A single conversation larger than the whole budget: the store must still
    // hand back a usable id rather than silently dropping what it just accepted.
    const huge = Array.from({ length: 400 }, (_, i) => ({
      role: 'tool', tool_call_id: `h${i}`, content: 'q'.repeat(9000),
    }));
    assert.equal(store.putResponse('huge', huge, CALLER('h')), true);
    const got = store.getResponse('huge', CALLER('h'));
    assert.equal(got.ok, true, 'the just-written conversation must be readable');
  });

  it('the newest entry survives a long series of oversized writes', () => {
    for (let i = 0; i < 60; i++) store.putResponse(`k${i}`, bigConversation(i), CALLER(i));
    assert.equal(store.getResponse('k59', CALLER(59)).ok, true,
      'the most recent write must always be chainable');
  });

  it('the byte total returns to zero when everything is dropped', () => {
    for (let i = 0; i < 5; i++) store.putResponse(`z${i}`, bigConversation(i), CALLER(i));
    assert.ok(store.getResponseStoreStats().bytes > 0);
    store.resetResponseStore();
    assert.equal(store.getResponseStoreStats().bytes, 0, 'reset must clear the byte counter');
  });

  it('overwriting an id does not double-count its bytes', () => {
    store.putResponse('same', bigConversation(1), CALLER(1));
    const first = store.getResponseStoreStats().bytes;
    store.putResponse('same', bigConversation(1), CALLER(1));
    const second = store.getResponseStoreStats().bytes;
    assert.equal(second, first,
      'a refresh replaces the entry — its bytes must not accumulate');
    assert.equal(store.getResponseStoreStats().size, 1);
  });

  it('explicit deletion releases the bytes', () => {
    store.putResponse('d1', bigConversation(1), CALLER(1));
    const withEntry = store.getResponseStoreStats().bytes;
    assert.ok(withEntry > 0);
    store.deleteResponse('d1', CALLER(1));
    assert.equal(store.getResponseStoreStats().bytes, 0, 'delete must release the accounting');
  });

  it('dropping messages to fit is never SILENT — a marker survives in the stored turn', () => {
    // Found by adversarial review. The backward walk stops as soon as one message is
    // kept and the next does not fit, so an over-cap message with any smaller message
    // AFTER it was excluded entirely — and since the survivors then fit, the
    // content-level fallback never ran and no marker was written. Reproduced: a 2MB
    // user turn followed by a short assistant reply stored as `["assistant"]`, the
    // user's question gone with no marker and no log line. The next chained turn then
    // asked the model about content it was never shown and answered 200 with a
    // confident context-free reply — the silent-wrong-answer mode this module exists
    // to remove. Operators are explicitly told to lower this budget on small VPSes,
    // so the shape is ordinary, not adversarial.
    const overCap = 'x'.repeat(Math.floor(1.6 * 1024 * 1024)); // > MAX_ENTRY_BYTES at 2m budget
    store.putResponse('silent', [
      { role: 'user', content: overCap },
      { role: 'assistant', content: 'Got it.' },
    ], 'api:silent:user:1');
    const got = store.getResponse('silent', 'api:silent:user:1');
    assert.equal(got.ok, true, 'the turn must still be readable');
    const all = JSON.stringify(got.messages);
    const lostTheUserTurn = !got.messages.some(m => m.role === 'user');
    if (lostTheUserTurn) {
      assert.match(all, /dropped by the response store|truncated by the response store/,
        'if a message is dropped, the loss MUST be visible in the stored conversation');
    }
  });

  it('a small conversation is unaffected by the budget', () => {
    store.putResponse('small', [{ role: 'user', content: 'hi' }], CALLER(1));
    const st = store.getResponseStoreStats();
    assert.equal(st.size, 1);
    assert.equal(st.evictions, 0, 'nothing to evict for a tiny conversation');
    assert.equal(store.getResponse('small', CALLER(1)).ok, true);
  });
});

describe('byte budget: size suffix parsing', () => {
  it('accepts the documented suffixes — via the production parser', () => {
    // Uses parseByteSize itself. An earlier version re-derived the regex inside the
    // test and asserted against its own copy, so a broken production parser stayed
    // green — a mirror test is not a test.
    assert.equal(parseByteSize('128m'), 128 * 1048576);
    assert.equal(parseByteSize('64MB'), 64 * 1048576);
    assert.equal(parseByteSize('512k'), 512 * 1024);
    assert.equal(parseByteSize('512kb'), 512 * 1024);
    assert.equal(parseByteSize('1g'), 1073741824);
    assert.equal(parseByteSize('1024'), 1024, 'a bare number is bytes');
    assert.equal(parseByteSize(' 8m '), 8 * 1048576, 'surrounding whitespace is tolerated');
  });

  it('returns null for anything unusable so the caller can apply its default', () => {
    for (const bad of ['0', '0m', 'abc', '-5m', '', null, undefined, '5tb', '1.5m', '5 m b']) {
      assert.equal(parseByteSize(bad), null, `must reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('byte eviction is tenant-fair (found by adversarial review of the first cut)', () => {
  // The first cut reused the COUNT-based fair-share test inside a BYTE-driven
  // loop. Under any byte-bound workload the writer's entry count stays far below
  // its entry share, so `overShare` was always false, the loop fell through to the
  // untenanted scan, and one caller storing a large conversation flushed every
  // other tenant's sessions. Reproduced before the fix: 5 tenants x 5
  // conversations all readable, then a single large write evicted 25/25.
  const tenantCaller = (t, u) => `api:key${t}:user:u${u}`;
  const conv = (kb) => [{ role: 'user', content: 'x'.repeat(kb * 512) }]; // *512 → ~kb KB at 2B/char

  it('a tenant flooding MANY entries evicts its OWN, never other tenants', () => {
    // This is the path the count-based fair-share test broke: the byte loop is
    // byte-driven, so comparing the writer's entry COUNT against
    // MAX_ENTRIES/tenants left it looking under-share forever, and the loop fell
    // through to the untenanted scan. Reproduced before the fix: 5 tenants x 5
    // conversations all readable, then one large write evicted 25/25.
    //
    // The flood has to be MANY entries, not one huge one — a single oversized
    // conversation is trimmed by capEntryBytes and never reaches this branch.
    for (let t = 0; t < 3; t++) {
      for (let i = 0; i < 2; i++) store.putResponse(`v${t}_${i}`, conv(100), `api:vic${t}:user:${i}`);
    }
    const before = [0, 1, 2].map(t => store.getResponse(`v${t}_0`, `api:vic${t}:user:0`).ok);
    assert.deepEqual(before, [true, true, true], 'precondition: victims seeded');

    for (let i = 0; i < 30; i++) store.putResponse(`atk${i}`, conv(100), `api:atk:user:${i}`);

    const after = [0, 1, 2].map(t => store.getResponse(`v${t}_0`, `api:vic${t}:user:0`).ok);
    assert.deepEqual(after, [true, true, true],
      'the flooding tenant must pay for its own growth — other tenants must survive');
    const st = store.getResponseStoreStats();
    assert.ok(st.evictions > 0, 'the flood must have triggered eviction');
    assert.ok(st.bytes <= st.maxBytes, 'and the budget must hold');
  });

  it('the entry just written is never the eviction victim, even via the tenant scan', () => {
    // `_entries.size > 1` only protects the UNtenanted scan (the new entry sits at
    // the Map tail, so it is never the global LRU head). oldestId(tenant) CAN return
    // it — when the writer's tenant is over its byte share AND the new entry is that
    // tenant's only survivor. putResponse then returned true while the id 404'd
    // immediately, handing the caller an unusable response id.
    //
    // Reaching that branch needs the byte share to be SMALLER than the per-entry
    // ceiling, i.e. more than four tenants: with MAX_BYTES=2m the ceiling is 512KB
    // while eight tenants get 256KB each, so one near-ceiling entry is over share.
    // An earlier version of this guard used a single-tenant flood and could not
    // reach the branch at all — it passed with the fix reverted.
    for (let t = 0; t < 7; t++) store.putResponse(`o${t}`, conv(250), `api:t${t}:user:1`);
    assert.equal(store.getResponseStoreStats().tenants, 7, 'precondition: many tenants');

    const ok = store.putResponse('mine', conv(500), 'api:t7:user:1');
    assert.equal(ok, true);
    assert.equal(store.getResponse('mine', 'api:t7:user:1').ok, true,
      'a write that returns true must be readable — otherwise the caller holds an id that 404s');
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= st.maxBytes,
      `the no-own-victim path must fall back to another victim, not exit over budget (${st.bytes} vs ${st.maxBytes})`);
    assert.ok(st.evictions > 0, 'and it must actually have evicted someone');
  });

  it('the budget still holds with HUNDREDS of tenants (the fair share has a floor)', () => {
    // The fair share `MAX_BYTES / tenants` self-destructs at scale. Past a few
    // hundred tenants the share falls below one ordinary conversation, so EVERY
    // tenant reads as over-share, each only ever evicts its own oldest, and a tenant
    // holding a single entry has nothing of its own to evict — the loop breaks with
    // the budget still blown. Reproduced before the fix: 600 tenants x one 20KB
    // conversation → 5.88x the budget and ZERO evictions, i.e. the byte bound
    // stopped existing at exactly the scale it was written to protect.
    //
    // A shared deployment behind one relay reaches hundreds of distinct API-key
    // prefixes as a matter of course, so this is the ordinary case, not an attack.
    for (let t = 0; t < 600; t++) {
      store.putResponse(`s${t}`, [{ role: 'user', content: 'x'.repeat(10 * 1024) }], `api:key${t}:user:1`);
    }
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= st.maxBytes,
      `the byte budget must hold at 600 tenants (${st.bytes} vs ${st.maxBytes})`);
    assert.ok(st.evictions > 0, 'and eviction must actually have run');
  });

  it('the newest write is still readable at that scale', () => {
    // The floor lets the global LRU scan reclaim from other tenants again, so the
    // guard that the writer is never its own victim has to keep holding.
    for (let t = 0; t < 600; t++) {
      store.putResponse(`n${t}`, [{ role: 'user', content: 'x'.repeat(10 * 1024) }], `api:key${t}:user:1`);
    }
    assert.equal(store.getResponse('n599', 'api:key599:user:1').ok, true,
      'a write that returned true must be readable');
  });

  it('fair-share protection still holds when tenants are few (no regression)', () => {
    // The floor only takes effect once the computed share is small. With a handful of
    // tenants the byte-denominated fair share is what prevents the cross-tenant DoS,
    // and it must be untouched.
    for (let t = 0; t < 3; t++) {
      for (let i = 0; i < 2; i++) store.putResponse(`f${t}_${i}`, conv(100), `api:fvic${t}:user:${i}`);
    }
    for (let i = 0; i < 30; i++) store.putResponse(`fatk${i}`, conv(100), `api:fatk:user:${i}`);
    assert.deepEqual(
      [0, 1, 2].map(t => store.getResponse(`f${t}_0`, `api:fvic${t}:user:0`).ok),
      [true, true, true],
      'a flooding tenant must still pay for its own growth');
  });

  it('no single conversation can claim the whole budget', () => {
    // Without a per-entry ceiling the eviction loop cannot converge fairly: a tenant
    // whose one entry alone exceeds the budget has nothing of its OWN to evict, so it
    // falls through to the global scan and flushes strangers. The ceiling is what
    // makes the byte-denominated fair share able to hold.
    const huge = [{ role: 'user', content: 'y'.repeat(50 * 1024 * 1024) }];
    store.putResponse('huge', huge, 'api:solo:user:1');
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= st.maxBytes,
      `one conversation must be trimmed to fit the budget (${st.bytes} vs ${st.maxBytes})`);
    assert.equal(store.getResponse('huge', 'api:solo:user:1').ok, true,
      'and it must still be readable — trimmed, not rejected');
  });

  it('a hog cannot blow the budget when other tenants already hold entries', () => {
    // The case above writes into an EMPTY store, where the global LRU scan has nothing
    // to reclaim — so `bytes <= maxBytes` holds for reasons unrelated to the per-entry
    // ceiling, and the comment's claim ("stops a hog from flushing strangers") is not
    // actually exercised. Seed other tenants first so the scan HAS victims available;
    // that is the state the ceiling exists for.
    //
    // Measured with the ceiling removed (MAX_ENTRY_BYTES = MAX_SAFE_INTEGER): 5 tenants
    // holding ~125KB each plus one 2MB write reached 5,444,688 bytes against a
    // 2,097,152 budget — 2.6x over.
    for (let t = 0; t < 5; t++) {
      store.putResponse(`neighbour${t}`, [{ role: 'user', content: 'n'.repeat(62_500) }],
        `api:neigh${t}:user:1`);
    }
    store.putResponse('hog', [{ role: 'user', content: 'h'.repeat(2 * 1024 * 1024) }],
      'api:hog:user:1');
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= st.maxBytes,
      `the per-entry ceiling must hold with neighbours present (${st.bytes} vs ${st.maxBytes})`);
  });

  it('a single oversized MESSAGE is truncated in place, with a visible marker', () => {
    // Dropping messages cannot shrink a conversation that is one giant message, so
    // the content itself is cut. The marker keeps that visible to whoever reads the
    // chained context instead of silently changing what the model saw.
    store.putResponse('one', [{ role: 'user', content: 'z'.repeat(20 * 1024 * 1024) }], 'api:solo:user:2');
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= st.maxBytes);
    const got = store.getResponse('one', 'api:solo:user:2');
    assert.equal(got.ok, true);
    assert.match(got.messages[0].content, /truncated by the response store/,
      'the truncation must be visible, not silent');
  });

  it('trimming a conversation to fit keeps the system block and the newest turns', () => {
    const msgs = [
      { role: 'system', content: 'INSTRUCTIONS' },
      ...Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `m${i}:${'z'.repeat(20000)}` })),
    ];
    store.putResponse('trim', msgs, 'api:solo:user:2');
    const got = store.getResponse('trim', 'api:solo:user:2');
    assert.equal(got.ok, true);
    // The system block survives, now carrying the drop notice: messages dropped to
    // fit the budget must never vanish silently (a chained turn would otherwise ask
    // the model about content it was never shown). Assert containment, not equality.
    assert.match(got.messages[0].content, /INSTRUCTIONS$/, 'the system block must survive');
    assert.match(got.messages.at(-1).content, /^m199:/, 'the newest turn must survive');
  });
});

describe('byte accounting covers every string, not just .text', () => {
  it('a base64 image part is charged its real size', () => {
    // normalizeMessageContent turns a Responses input_image into
    // {type:'image_url', image_url:{url:'data:...'}} — no `.text` field at all, so
    // the first cut charged a multi-megabyte data URI a flat 32 bytes and the
    // budget never fired on vision payloads (measured ~15000x under).
    const img = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(200000)}` } }],
    };
    store.putResponse('img', [img], 'api:vision:user:1');
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes > 200000,
      `a 200KB data URI must be accounted for, got ${st.bytes}`);
  });

  it('charges tool_call arguments and ids', () => {
    const m = [{
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: 'q'.repeat(50000) } }],
    }];
    store.putResponse('tc', m, 'api:tools:user:1');
    assert.ok(store.getResponseStoreStats().bytes > 50000, 'tool arguments count toward the budget');
  });

  it('never UNDERcounts non-Latin1 text (V8 stores it 2 bytes/char)', () => {
    store.resetResponseStore();
    store.putResponse('cjkxx', [{ role: 'user', content: '中'.repeat(100000) }], 'api:cjkxx:user:1');
    const cjk = store.getResponseStoreStats().bytes;
    store.resetResponseStore();
    store.putResponse('ascii', [{ role: 'user', content: 'a'.repeat(100000) }], 'api:ascii:user:1');
    const ascii = store.getResponseStoreStats().bytes;
    assert.ok(cjk >= ascii,
      'CJK must not be charged less than the same number of ASCII chars — undercounting '
      + 'is what lets real memory exceed the budget');
    assert.ok(cjk >= 200000, `100k CJK chars occupy ~200KB in V8, accounted ${cjk}`);
  });
});

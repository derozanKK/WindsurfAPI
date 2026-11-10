// V-23 — history trimming must never rewrite structured tool arguments into
// invalid JSON, and must never drop turns silently.
//
// Two defects in the same trimming path:
//
//  1. trimContentToFit walks EVERY shrinkable string, including
//     `tool_calls[i].function.arguments` (and the Responses-shaped
//     `function_call.arguments`). It replaced the tail with the plain-text marker,
//     so an arguments string that WAS valid JSON became
//     `{"path":"/tmp/a","content":"xxxx[... truncated ...]"` — unparseable. The next
//     turn then replayed a tool call whose arguments no upstream can accept, and
//     nothing in the stored conversation said so.
//  2. truncateMessages dropped every turn past RESPONSE_STORE_MAX_MESSAGES with no
//     marker at all. The model saw a conversation that began mid-stream and had no
//     way to know earlier turns existed — the same silent-wrong-answer mode the
//     store was built to remove, one layer up.
//
// MEASURED before the fix at RESPONSE_STORE_MAX_BYTES=400k (MAX_ENTRY_BYTES
// 102400): a 200KB JSON arguments string was stored as ~50KB of JSON prefix plus
// the marker (JSON.parse threw), and a 501-message conversation was stored as 400
// messages with no notice anywhere.
//
// The invariant the tests below pin:
//   * an `arguments` string that is JSON is either untouched or replaced WHOLE by
//     a valid-JSON marker — never spliced;
//   * a conversation that lost turns carries exactly one explicit notice at the
//     seam, and the newest turn is never rewritten to make room for it;
//   * both limiters (count and bytes) report their drops.

process.env.RESPONSE_STORE_MAX_BYTES = '400k';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../src/response-store.js');

const A = 'api:argumentsargumentsarguments:user:alice';
// MAX_ENTRY_BYTES = max(64KiB, floor(400KiB/4)) = 102400 at this budget.
const MAX_ENTRY_BYTES = Math.max(64 * 1024, Math.floor(400 * 1024 / 4));
const MAX_MESSAGES = 400;
const BIG = 200000;

// The notice format handlers/responses.js strips before serving an answer
// (`^\[\.\.\. \d+ earlier message\(s\) dropped by the response store[^\]]*\]`).
// Matching it here keeps the two modules from drifting: a notice that does not
// match would be served back to the client as if the model had written it.
const NOTICE_RE = /^\[\.\.\. \d+ earlier message\(s\) dropped by the response store[^\]]*\]\n\n/;

const textOf = (m) => (typeof m?.content === 'string'
  ? m.content
  : Array.isArray(m?.content)
    ? m.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('')
    : '');
const notices = (messages) => messages.filter(m => NOTICE_RE.test(textOf(m)));

function conversation(lead, turns, content = (i) => `u${i}`) {
  return [
    ...Array.from({ length: lead }, (_, i) => ({ role: 'system', content: `s${i}` })),
    ...Array.from({ length: turns }, (_, i) => ({ role: 'user', content: content(i) })),
  ];
}

function storeAndRead(id, messages) {
  assert.equal(store.putResponse(id, messages, A), true, 'the write must be accepted');
  const got = store.getResponse(id, A);
  assert.equal(got.ok, true);
  return got.messages;
}

beforeEach(() => store.resetResponseStore());

describe('V-23 structured tool arguments are never spliced', () => {
  it('byte trimming replaces the whole arguments value with valid JSON, never a prefix', () => {
    const args = JSON.stringify({ path: '/tmp/report.txt', content: 'x'.repeat(BIG) });
    const messages = storeAndRead('tc', [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'write_file', arguments: args },
      }],
    }]);

    const tc = messages[0].tool_calls[0];
    assert.equal(tc.id, 'call_1', 'the call id pairs this call with its result — never cut');
    assert.equal(tc.function.name, 'write_file', 'the function name is structural — never cut');

    const stored = tc.function.arguments;
    assert.ok(stored.length < args.length, 'the arguments payload is what has to shrink');
    assert.doesNotThrow(
      () => JSON.parse(stored),
      `stored tool arguments must stay parseable JSON; got ${JSON.stringify(stored.slice(0, 90))}…`,
    );
    const parsed = JSON.parse(stored);
    assert.match(stored, /truncated by the response store/, 'the loss must be visible');
    assert.equal('content' in parsed, false,
      'the payload is gone as a WHOLE — a surviving JSON prefix would be a spliced document');
    assert.equal(typeof parsed.__truncated__, 'string', 'the marker is machine-readable, not prose');
    assert.ok(store.getResponseStoreStats().bytes <= MAX_ENTRY_BYTES,
      `the entry must fit the ceiling (${store.getResponseStoreStats().bytes} vs ${MAX_ENTRY_BYTES})`);
  });

  it('a Responses-shaped function_call item is compacted the same way', () => {
    // The store is Chat-shaped in the common path, but the walker is generic and
    // the Responses wire item puts `arguments` at the TOP level. Both shapes must
    // leave valid JSON behind.
    const args = JSON.stringify({ q: 'y'.repeat(BIG) });
    const messages = storeAndRead('fc', [{
      type: 'function_call',
      call_id: 'call_2',
      name: 'search',
      arguments: args,
    }]);

    const item = messages[0];
    assert.equal(item.call_id, 'call_2');
    assert.equal(item.name, 'search');
    assert.doesNotThrow(() => JSON.parse(item.arguments),
      `stored arguments must parse; got ${JSON.stringify(String(item.arguments).slice(0, 90))}…`);
    assert.match(item.arguments, /truncated by the response store/);
  });

  it('small valid JSON arguments are stored byte-identical', () => {
    // Control: the fix must not rewrite arguments it does not need to shrink.
    const args = '{"path":"a.txt","mode":"r"}';
    const messages = storeAndRead('small', [{
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'read_file', arguments: args } }],
    }]);
    assert.equal(messages[0].tool_calls[0].function.arguments, args);
  });

  it('a non-JSON arguments payload is still prefix-truncated with the marker', () => {
    // Control: an arguments string that never was JSON has no parseability to
    // preserve, and truncating it is the documented behaviour (and is what the
    // pre-existing cap test asserts). The whole-value replacement is reserved for
    // documents, so plain text keeps the cheaper prefix cut.
    const raw = 'q'.repeat(BIG);
    const messages = storeAndRead('raw', [{
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_4', type: 'function', function: { name: 'write_file', arguments: raw } }],
    }]);
    const stored = messages[0].tool_calls[0].function.arguments;
    assert.ok(stored.length < raw.length, 'it still has to shrink');
    assert.match(stored, /truncated by the response store/, 'and the cut is still visible');
    assert.equal(messages[0].tool_calls[0].id, 'call_4');
  });
});

describe('V-23 dropped turns carry a visible notice', () => {
  it('a conversation over RESPONSE_STORE_MAX_MESSAGES records what was dropped', () => {
    const out = storeAndRead('cap', conversation(1, 500));

    assert.equal(out.length, MAX_MESSAGES);
    assert.equal(out[0].content, 's0', 'the leading system block is preserved verbatim');
    assert.equal(out.at(-1).content, 'u499', 'the newest turn survives');

    const found = notices(out);
    assert.equal(found.length, 1, 'exactly one notice, and it must exist at all');
    assert.match(textOf(found[0]),
      /^\[\.\.\. 101 earlier message\(s\) dropped by the response store to stay within RESPONSE_STORE_MAX_MESSAGES \.\.\.\]\n\n/,
      'the notice names the count and the setting that bound');
    assert.equal(found[0], out[1],
      'the notice sits at the seam: on the first surviving turn after the gap');
    assert.ok(textOf(out[1]).endsWith('u101'), 'and that turn keeps its own content after the notice');
  });

  it('never rewrites the newest turn to make room for the notice', () => {
    // lead=500 leaves a single turn of tail budget. Prepending the notice to the
    // only recent turn would rewrite the very message the store exists to keep
    // byte-identical, so the notice goes on the other side of the seam.
    const out = storeAndRead('hugehead', conversation(500, 50));

    assert.equal(out.length, MAX_MESSAGES);
    assert.equal(out.at(-1).content, 'u49', 'the newest turn must survive untouched');
    assert.equal(out[0].content, 's0', 'and the head still starts at the first system message');
    assert.equal(notices(out).length, 1, 'the drop is still visible somewhere');
  });

  it('joins parts-array content as a text block instead of flattening it', () => {
    // Responses input items normalize to typed blocks; the notice must be a block
    // of the same array, not a replacement for the array (which would lose the
    // turn's structure on replay).
    const out = storeAndRead('parts', conversation(1, 500, (i) => [{ type: 'text', text: `u${i}` }]));

    const first = out[1];
    assert.ok(Array.isArray(first.content), 'content stays an array');
    assert.equal(first.content[0].type, 'text', 'the notice is a text block');
    assert.match(first.content[0].text, NOTICE_RE);
    assert.equal(first.content[1].text, 'u101', 'the original block follows it');
  });

  it('does not mutate the caller\'s conversation', () => {
    const input = conversation(1, 500);
    const before = structuredClone(input);
    storeAndRead('nomut', input);
    assert.deepEqual(input, before,
      'the notice is copy-on-write; the caller\'s request body is shared with the live turn');
  });

  it('a conversation at the cap is stored without a notice', () => {
    const input = conversation(1, MAX_MESSAGES - 1);
    const out = storeAndRead('atcap', input);
    assert.equal(out.length, MAX_MESSAGES);
    assert.equal(notices(out).length, 0, 'nothing was dropped, so nothing is claimed to be');
    assert.deepEqual(out, input);
  });

  it('when the byte ceiling also binds, the stored conversation still carries a notice', () => {
    // The count limiter runs first and the byte limiter second; whichever message
    // each notice lands on, the surviving conversation must still tell the model
    // that history was dropped.
    const input = conversation(1, 500, (i) => `${i}:${'z'.repeat(4000)}`);
    const out = storeAndRead('both', input);

    assert.ok(out.length < MAX_MESSAGES, `the byte ceiling must have dropped turns (kept ${out.length})`);
    assert.ok(notices(out).length >= 1, 'the surviving conversation must still carry a notice');
    assert.ok(store.getResponseStoreStats().bytes <= MAX_ENTRY_BYTES,
      `the entry must fit the ceiling (${store.getResponseStoreStats().bytes} vs ${MAX_ENTRY_BYTES})`);
  });
});

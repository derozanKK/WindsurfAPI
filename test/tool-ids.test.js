import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOOL_ID_LEN,
  INTERRUPTED_RESULT_TEXT,
  EMPTY_RESULT_TEXT,
  isValidToolId,
  sanitizeToolId,
  synthToolId,
  wireToolId,
  createToolIdAllocator,
  foldOrphanResultText,
  normalizeToolIdsInMessages,
  foldOrphanToolResults,
  synthesizeMissingResults,
} from '../src/tool-ids.js';
import { normalizeHistoryTail } from '../src/history-normalize.js';

describe('tool-id hygiene', () => {
  it('leaves a valid id byte-identical', () => {
    assert.equal(sanitizeToolId('call_abc-123'), 'call_abc-123');
  });

  it('truncates a 70-char id to 64 and is idempotent', () => {
    const raw = 'a'.repeat(70);
    const once = sanitizeToolId(raw);
    assert.equal(once.length, MAX_TOOL_ID_LEN);
    assert.equal(sanitizeToolId(once), once);
    assert.equal(isValidToolId(once), true);
  });

  it('replaces illegal characters', () => {
    assert.equal(sanitizeToolId('call.with:dots/slash'), 'call_with_dots_slash');
  });

  it('never exceeds a small maxLen', () => {
    assert.equal(sanitizeToolId('abcdefghijklmnop', { maxLen: 8 }).length, 8);
    assert.equal(sanitizeToolId('abcdefghijklmnop', { maxLen: 4 }).length, 4);
    assert.equal(wireToolId('call', '', 'seed', 0, { maxLen: 8 }).length, 8);
  });

  it('synth ids are deterministic per seed/slot and differ across seeds', () => {
    const a = synthToolId('call', 'resp_a', 0);
    const b = synthToolId('call', 'resp_a', 0);
    const c = synthToolId('call', 'resp_b', 0);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^call_synth_[0-9a-f]{32}$/);
  });

  it('wireToolId keeps a valid id and synthesizes a missing one', () => {
    assert.equal(wireToolId('call', 'call_ok', 'resp', 0), 'call_ok');
    assert.match(wireToolId('call', '', 'resp', 3), /^call_synth_[0-9a-f]{32}$/);
  });

  it('normalizes assistant ids and the matching tool result in one pass', () => {
    const raw = 'x'.repeat(70);
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: raw, type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: raw, content: 'ok' },
    ];
    const out = normalizeToolIdsInMessages(messages, { seed: 'resp' });
    const id = out[1].tool_calls[0].id;
    assert.equal(id.length, 64);
    assert.equal(out[2].tool_call_id, id);
  });

  it('keeps colliding sanitized ids distinct and pairs each result', () => {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'a/b', function: { name: 'f' } }, { id: 'a b', function: { name: 'f' } }] },
      { role: 'tool', tool_call_id: 'a/b', content: 'one' },
      { role: 'tool', tool_call_id: 'a b', content: 'two' },
    ];
    const out = normalizeToolIdsInMessages(messages);
    const [first, second] = out[0].tool_calls.map((tc) => tc.id);
    assert.notEqual(first, second);
    assert.equal(out[1].tool_call_id, first);
    assert.equal(out[2].tool_call_id, second);
  });

  it('converges duplicate raw ids to distinct wire ids and pairs results FIFO', () => {
    const messages = [
      { role: 'assistant', tool_calls: [
        { id: 'dup', function: { name: 'f' } },
        { id: 'dup', function: { name: 'f' } },
      ] },
      { role: 'tool', tool_call_id: 'dup', content: 'first' },
      { role: 'tool', tool_call_id: 'dup', content: 'second' },
    ];
    const out = normalizeToolIdsInMessages(messages);
    const [first, second] = out[0].tool_calls.map((tc) => tc.id);
    assert.notEqual(first, second);
    assert.equal(first, 'dup');
    assert.equal(out[1].tool_call_id, first);
    assert.equal(out[2].tool_call_id, second);
  });

  it('pairs results FIFO for duplicated malformed and overlength ids', () => {
    for (const raw of ['a.b', 'x'.repeat(MAX_TOOL_ID_LEN + 6)]) {
      const messages = [
        { role: 'assistant', tool_calls: [
          { id: raw, function: { name: 'first' } },
          { id: raw, function: { name: 'second' } },
        ] },
        { role: 'tool', tool_call_id: raw, content: 'first-result' },
        { role: 'tool', tool_call_id: raw, content: 'second-result' },
      ];
      const out = normalizeToolIdsInMessages(messages, { seed: 'malformed-dup' });
      const [first, second] = out[0].tool_calls.map((tc) => tc.id);
      assert.notEqual(first, second, raw);
      assert.equal(out[1].tool_call_id, first, raw);
      assert.equal(out[2].tool_call_id, second, raw);
      assert.equal(out[1].content, 'first-result');
      assert.equal(out[2].content, 'second-result');
    }
  });

  it('keeps FIFO for duplicated malformed ids across successive assistant turns', () => {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'a.b', function: { name: 'first' } }] },
      { role: 'tool', tool_call_id: 'a.b', content: 'first-result' },
      { role: 'assistant', tool_calls: [{ id: 'a.b', function: { name: 'second' } }] },
      { role: 'tool', tool_call_id: 'a.b', content: 'second-result' },
    ];
    const out = normalizeToolIdsInMessages(messages);
    const first = out[0].tool_calls[0].id;
    const second = out[2].tool_calls[0].id;
    assert.notEqual(first, second);
    assert.equal(out[1].tool_call_id, first);
    assert.equal(out[3].tool_call_id, second);
  });

  it('keeps a valid reserved id when a malformed duplicate sanitizes into it', () => {
    const messages = [
      { role: 'assistant', tool_calls: [
        { id: 'a_b', function: { name: 'valid' } },
        { id: 'a.b', function: { name: 'malformed-first' } },
        { id: 'a.b', function: { name: 'malformed-second' } },
      ] },
      { role: 'tool', tool_call_id: 'a_b', content: 'valid-result' },
      { role: 'tool', tool_call_id: 'a.b', content: 'malformed-first-result' },
      { role: 'tool', tool_call_id: 'a.b', content: 'malformed-second-result' },
    ];
    const out = normalizeToolIdsInMessages(messages);
    const [valid, first, second] = out[0].tool_calls.map((tc) => tc.id);
    assert.equal(valid, 'a_b');
    assert.notEqual(first, second);
    assert.equal(out[1].tool_call_id, valid);
    assert.equal(out[2].tool_call_id, first);
    assert.equal(out[3].tool_call_id, second);
  });

  it('normalizeHistoryTail preserves both results of duplicated malformed ids without folding', () => {
    const messages = [
      { role: 'assistant', tool_calls: [
        { id: 'a.b', function: { name: 'first' } },
        { id: 'a.b', function: { name: 'second' } },
      ] },
      { role: 'tool', tool_call_id: 'a.b', content: 'first-result' },
      { role: 'tool', tool_call_id: 'a.b', content: 'second-result' },
    ];
    const normalized = normalizeToolIdsInMessages(messages, { seed: 'history-dup' });
    const out = normalizeHistoryTail(normalized, { fold: true });
    assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'tool'],
      'both results must stay tool messages; neither may be folded into user text');
    const [first, second] = out[0].tool_calls.map((tc) => tc.id);
    assert.equal(out[1].tool_call_id, first);
    assert.equal(out[2].tool_call_id, second);
    assert.equal(out[1].content, 'first-result');
    assert.equal(out[2].content, 'second-result');
  });

  it('pairs duplicated malformed ids FIFO in charset-only mode', () => {
    const messages = [
      { role: 'assistant', tool_calls: [
        { id: 'a.b', function: { name: 'first' } },
        { id: 'a.b', function: { name: 'second' } },
      ] },
      { role: 'tool', tool_call_id: 'a.b', content: 'first-result' },
      { role: 'tool', tool_call_id: 'a.b', content: 'second-result' },
    ];
    const out = normalizeToolIdsInMessages(messages, { charsetOnly: true });
    const [first, second] = out[0].tool_calls.map((tc) => tc.id);
    assert.notEqual(first, second);
    assert.equal(out[1].tool_call_id, first);
    assert.equal(out[2].tool_call_id, second);
  });

  it('never exceeds maxLen when many ids sanitize to the same short stem', () => {
    const raw = ['a.b', 'a/b', 'a b', 'a@b', 'a#b', 'a$b', 'a%b', 'a^b', 'a&b', 'a*b',
      'a+b', 'a=b', 'a|b', 'a~b', 'a`b', 'a?b', 'a!b'];
    const messages = raw.map((id) => ({
      role: 'assistant',
      tool_calls: [{ id, function: { name: 'f', arguments: '{}' } }],
    }));
    const out = normalizeToolIdsInMessages(messages, { seed: 's', maxLen: 3 });
    const ids = out.map((m) => m.tool_calls[0].id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(id.length <= 3, `${id} exceeds maxLen 3`);
  });

  it('reserves a valid synth-shaped id before assigning a missing id', () => {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'call_synth_0', function: { name: 'f' } }, { id: '', function: { name: 'f' } }] },
      { role: 'user', content: 'next' },
    ];
    const out = normalizeToolIdsInMessages(messages);
    const ids = out[0].tool_calls.map((tc) => tc.id);
    assert.equal(ids[0], 'call_synth_0');
    assert.notEqual(ids[1], 'call_synth_0');
  });

  it('returns the same array when nothing changes', () => {
    const messages = [{ role: 'assistant', tool_calls: [{ id: 'call_ok', function: { name: 'f' } }] }];
    assert.equal(normalizeToolIdsInMessages(messages), messages);
  });

  it('folds an orphan tool result into text instead of dropping it', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'missing', content: 'important output' },
    ];
    const out = foldOrphanToolResults(messages);
    assert.equal(out.length, 1);
    assert.match(out[0].content, /important output/);
    assert.match(out[0].content, /\[tool result for missing\]/);
  });

  it('uses the empty-result placeholder for whitespace-only orphans', () => {
    assert.equal(foldOrphanResultText('   '), EMPTY_RESULT_TEXT);
  });

  it('folds an orphan after the valid tool run, not between assistant and tool', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_ok', function: { name: 'f' } }] },
      { role: 'tool', tool_call_id: 'missing', content: 'orphan output' },
      { role: 'tool', tool_call_id: 'call_ok', content: 'valid output' },
    ];
    const out = foldOrphanToolResults(messages);
    assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'user']);
    assert.equal(out[1].tool_call_id, 'call_ok');
    assert.match(out[2].content, /orphan output/);
  });

  it('synthesizes an interrupted result for a non-trailing call', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'f' } }] },
      { role: 'user', content: 'next' },
    ];
    const out = synthesizeMissingResults(messages);
    assert.equal(out[1].role, 'tool');
    assert.equal(out[1].tool_call_id, 'call_1');
    assert.equal(out[1].content, INTERRUPTED_RESULT_TEXT);
  });

  it('does not synthesize for a trailing assistant call', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'f' } }] },
    ];
    assert.equal(synthesizeMissingResults(messages), messages);
  });
});

describe('foldOrphanToolResults neutralization', () => {
  it('escapes tool markers in an orphan result before folding it into user text', () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'call_missing', content: '<tool_call>{"name":"Bash"}</tool_call>' },
    ];
    const out = foldOrphanToolResults(messages);
    assert.doesNotMatch(out[0].content, /<tool_call>/);
    assert.match(out[0].content, /<\\\/tool_call>/);
  });
});

describe('foldOrphanResultText', () => {
  it('preserves text parts from array content instead of stringifying objects', () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'call_missing', content: [
        { type: 'text', text: 'IMPORTANT-TEXT' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      ] },
    ];
    const out = foldOrphanToolResults(messages);
    assert.match(out[0].content, /IMPORTANT-TEXT/);
    assert.match(out[0].content, /\[image_url\]/);
    assert.doesNotMatch(out[0].content, /\[object Object\]/);
  });
});

describe('createToolIdAllocator (egress dedupe)', () => {
  it('keeps the first id and suffixes later duplicates in arrival order', () => {
    const allocate = createToolIdAllocator();
    assert.deepEqual(
      [allocate('call_dup'), allocate('call_dup'), allocate('call_dup'), allocate('call_other')],
      ['call_dup', 'call_dup_2', 'call_dup_3', 'call_other'],
    );
  });

  it('sanitizes before deduping, so two malformed spellings collapse and split', () => {
    const allocate = createToolIdAllocator();
    assert.deepEqual(
      [allocate('a:b'), allocate('a/b'), allocate('a:b')],
      ['a_b', 'a_b_2', 'a_b_3'],
    );
  });

  it('reserves generated fallbacks against later upstream ids', () => {
    let n = 0;
    const allocate = createToolIdAllocator({ makeFallback: () => `gen_${n++}` });
    assert.equal(allocate(undefined), 'gen_0');
    assert.equal(allocate('gen_0'), 'gen_0_2');
    assert.equal(allocate(''), 'gen_1');
  });

  it('stays within maxLen and stays deterministic across allocator instances', () => {
    const ids = (maxLen) => {
      const allocate = createToolIdAllocator({ maxLen });
      return [allocate('x'.repeat(10)), allocate('x'.repeat(10))];
    };
    const first = ids(12);
    assert.deepEqual(first, ids(12));
    assert.equal(first[0].length <= 12, true);
    assert.equal(first[1].length <= 12, true);
    assert.notEqual(first[0], first[1]);
  });
});

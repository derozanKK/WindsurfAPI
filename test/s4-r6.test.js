import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function load(limit = value => value) {
  const source = readFileSync(new URL('../src/response-store.js', import.meta.url), 'utf8');
  function extract(name) {
    const start = source.indexOf(`export function ${name}(`), end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end).replace('export ', '');
  }
  const _entries = new Map(), _tenantCounts = new Map(), _tenantBytes = new Map();
  const deps = {
    ENABLED: true, MAX_ENTRIES: 500, MAX_BYTES: 10000000, MAX_ENTRY_BYTES: 10000000,
    MIN_TENANT_BYTES: 1000,
    // The metadata slot's caps are module constants, like the other limits above:
    // the extracted body reads them from this scope, so they must be supplied.
    MAX_METADATA_KEYS: 16, MAX_METADATA_KEY_CHARS: 64, MAX_METADATA_VALUE_CHARS: 512,
    _entries, _tenantCounts, _tenantBytes, _stats: { stored: 0, hits: 0, misses: 0, expires: 0, rejected: 0, evictions: 0 },
    wantsPersistence: x => x !== false, ensureSweepTimer() {},
    tenantOf: x => x, oldestId: () => _entries.keys().next().value,
    dropEntry: id => _entries.delete(id), trackInsert() {},
    // Under-cap limiters retain the input; over-cap limiters are copy-on-write.
    // Existing limiter-mutation tests must keep guarding that separate contract.
    truncateMessages: limit, capEntryBytes: value => value,
    approxBytes: value => Buffer.byteLength(JSON.stringify(value)),
    retainedBytes: value => Buffer.byteLength(JSON.stringify(value)),
    ENTRY_OVERHEAD_BYTES: 32,
    enforceByteBudget: () => true,
    isPastIdle: () => false, isPastMaxAge: () => false, log: { warn() {} },
  };
  // The copy helper is a module-level plain function (not exported), and both
  // exported entry points call it; without pulling its text in, the harness would
  // evaluate bodies that reference an undefined name. `entryFixedBytes` is the
  // same kind of helper used by the prepare phase.
  function extractPlain(name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, `plain function ${name} must be present`);
    return source.slice(start, end);
  }
  return new Function(...Object.keys(deps), `let _bytes = 0;\n${extractPlain('copyStoredValue')}\n${extractPlain('boundMetadata')}\n${extractPlain('entryFixedBytes')}\n${extract('putResponse')}\n${extract('getResponse')}\nreturn {putResponse,getResponse};`)(...Object.values(deps));
}
function history() {
  return [{ role: 'user', content: [{ type: 'text', text: 'original' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call', function: { name: 'tool', arguments: '{}' } }] }];
}

test('R6 two already-read histories and subsequent reads have independent object graphs', () => {
  const s = load(), original = history(), expected = structuredClone(original);
  assert.equal(s.putResponse('id', original, 'owner'), true);
  const first = s.getResponse('id', 'owner'), second = s.getResponse('id', 'owner');
  first.messages[0].content[0].text = 'changed';
  first.messages[0].content[1].image_url.url = 'changed';
  first.messages[1].tool_calls[0].function.name = 'changed';
  first.messages.push({ role: 'user', content: 'extra' });
  assert.deepEqual(second.messages, expected, 'the second prior reader must not see the first reader mutate');
  assert.deepEqual(s.getResponse('id', 'owner').messages, expected);
});

test('R6 caller-side mutation after put cannot alter the stored snapshot', () => {
  const s = load(), input = history(), expected = structuredClone(input);
  s.putResponse('id', input, 'owner');
  input[0].content[0].text = 'changed'; input[1].tool_calls.length = 0; input.pop();
  assert.deepEqual(s.getResponse('id', 'owner').messages, expected);
});

test('R6 the limiter result is copied before becoming a stored snapshot', () => {
  const input = history(), expectedInput = structuredClone(input);
  const kept = history(); kept[0].content[0].text = 'trimmed';
  const expectedStored = structuredClone(kept);
  const s = load(() => kept);
  s.putResponse('id', input, 'owner');
  assert.deepEqual(input, expectedInput, 'copy-on-write limiters preserve their input');
  kept[0].content[0].text = 'mutated after storage';
  assert.deepEqual(s.getResponse('id', 'owner').messages, expectedStored,
    'the store must detach even when the limiter returns shared retained objects');
});

test('R6 ownership, store:false and non-message response metadata are unchanged', () => {
  const s = load();
  assert.equal(s.putResponse('no', history(), 'owner', { store: false }), false);
  assert.equal(s.getResponse('no', 'owner').ok, false);
  s.putResponse('yes', history(), 'owner', { model: 'm', status: 'incomplete', incompleteReason: 'max_output_tokens' });
  assert.equal(s.getResponse('yes', 'foreign').reason, 'forbidden');
  const r = s.getResponse('yes', 'owner');
  assert.equal(r.model, 'm'); assert.equal(r.status, 'incomplete');
  assert.equal(r.incompleteReason, 'max_output_tokens'); assert.ok(r.createdAt > 0);
});

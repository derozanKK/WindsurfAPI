import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripOrphanedToolResults,
  normalizeMessagesForCascade,
  interleaveParallelToolMessages,
} from '../src/handlers/tool-emulation.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const user = { role: 'user', content: 'continue' };
const assistant = (id) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'f', arguments: '{}' } }],
});
const result = (id) => ({ role: 'tool', tool_call_id: id, content: 'output' });
const options = {
  modelKey: 'swe-1-7', route: 'devin_connect',
  nativeStructured: true, injectUserPreamble: false,
};
const normalize = (messages, extra = {}) => normalizeMessagesForCascade(messages, [], {
  ...options, ...extra,
});
const frames = (messages) => getAllFields(parseFields(buildGetChatMessageRequest({
  token: 'wire-test', model: 'swe-1-7', messages, nativeToolCall: true, env: {},
})), 3).map((f) => parseFields(f.value));
const roles = (items) => items.map((f) => getField(f, 2, 0).value);
const strings = (fields, tag) => getAllFields(fields, tag)
  .filter((f) => f.wireType === 2).map((f) => f.value.toString('utf8'));

test('H2-T1: a future call prevents whole-history orphanhood; the native normalizer restores call-then-result order', () => {
  const input = [result('a'), assistant('a'), user];
  // The strip itself still uses the whole history and never reorders: the call
  // exists, so the result is not an orphan.
  assert.strictEqual(stripOrphanedToolResults(input), input);
  // The native normalization repairs the chronology (#273.1, measured 2026-10-25:
  // the upstream rejects [4,2] with invalid_argument and accepts [2,4]).
  const normalized = normalize(input, { stripOrphans: true });
  assert.deepEqual(normalized.map((m) => m.role), ['assistant', 'tool', 'user']);
  const items = frames(normalized);
  assert.deepEqual(roles(items), [2, 4, 1]);
  assert.deepEqual(strings(items[1], 7), ['a']);
  assert.deepEqual(strings(items[1], 3), ['output']);
  const calls = getAllFields(items[0], 6);
  assert.equal(calls.length, 1);
  assert.deepEqual(strings(parseFields(calls[0].value), 1), ['a']);
  // interleave alone still cannot see a result above the call; it is the
  // explicit order repair that fixes this shape, not a side effect of interleave.
  assert.deepEqual(interleaveParallelToolMessages(input), input);
});

test('H2-T2: opted-in stripping removes results with no call anywhere', () => {
  for (const id of ['missing', '', null]) {
    const input = [result(id), user];
    assert.deepEqual(stripOrphanedToolResults(input), [user]);
    const normalized = normalize(input, { stripOrphans: true });
    assert.deepEqual(normalized, [user]);
    assert.deepEqual(roles(frames(normalized)), [1]);
  }
});

test('H2-T3: omitted and false stripOrphans preserve a truncated continuation', () => {
  const input = [result('from-an-earlier-request'), user];
  for (const history of [
    normalize(input),
    normalize(input, { stripOrphans: false }),
    interleaveParallelToolMessages(input),
  ]) {
    assert.deepEqual(history, input);
    const items = frames(history);
    assert.deepEqual(roles(items), [4, 1]);
    assert.deepEqual(strings(items[0], 7), ['from-an-earlier-request']);
  }
});

test('H2-T4: an outstanding assistant call is not a result orphan', () => {
  const input = [assistant('pending'), user];
  assert.strictEqual(stripOrphanedToolResults(input), input);
  const normalized = normalize(input, { stripOrphans: true });
  assert.deepEqual(normalized, input);
  assert.deepEqual(roles(frames(normalized)), [2, 1]);
});

// WHY THIS FILE EXISTS. Gating the cache key on an actual consumer changes one
// edge case on purpose: a body that JSON.parse accepts but cacheKey cannot walk
// (a ~5000-deep nesting blows the clone's stack) used to die inside the key
// computation for every caller. For callers whose key is never consumed — a
// plain API key, the default — the key is no longer computed, so that body now
// reaches the handler instead of failing early. For per-user-scoped callers the
// key is still consumed and the throw still happens, unchanged.
//
// Pinned here so the change stays deliberate: if someone later makes the
// computation unconditional again, this test fails and the trade-off gets
// re-argued rather than silently reverted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions } from '../src/handlers/chat.js';

const deepBody = () => {
  const depth = 6000;
  return JSON.parse('{"model":"swe-1-7","messages":[{"role":"user","content":' + '['.repeat(depth) + ']'.repeat(depth) + '}]}');
};

test('a non-shareable caller no longer dies in the cache key on a deeply nested body', async () => {
  let error = null;
  try { await handleChatCompletions(deepBody(), { callerKey: 'api:abcdef:client:1.2.3.4' }); }
  catch (e) { error = e; }
  assert.equal(String(error && error.stack || '').includes('cache.js'), false,
    `the failure must not come from the cache key any more, got: ${error && error.message}`);
});

test('a per-user-scoped caller still computes the key and still surfaces its failure', async () => {
  let error = null;
  try { await handleChatCompletions(deepBody(), { callerKey: 'api:abcdef:user:someone' }); }
  catch (e) { error = e; }
  assert.equal(error instanceof RangeError, true, 'the shareable path keeps the pre-existing failure');
});

// Response store: the WRITE path must be caller-scoped too.
//
// getResponse and deleteResponse have always rejected a foreign caller, but
// putResponse keyed replacement on responseId alone: `existing = _entries.get()`
// inherited metadata/model/status/createdAt from whatever entry held the id, then
// dropEntry() deleted the owner's entry and stored the writer's. Reproduced with A
// owning `shared` and B putting the same id: B's put returned true, A's next read
// returned 'forbidden', and B read A's metadata back.
//
// These tests pin the fix: a mismatched callerKey is rejected before inheritance,
// eviction, replacement or accounting changes. Same-caller refresh still works.

process.env.RESPONSE_STORE_MAX = '2';
process.env.RESPONSE_STORE_MAX_BYTES = '64k';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../src/response-store.js');

const A = 'api:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:user:alice';
const B = 'api:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:user:bob';
const A_CONV = [
  { role: 'user', content: 'alice turn 1' },
  { role: 'assistant', content: 'alice reply 1' },
];
const B_CONV = [
  { role: 'user', content: 'bob turn 1' },
  { role: 'assistant', content: 'bob reply 1' },
];
const ACCOUNTING = (stats) => ({
  size: stats.size,
  bytes: stats.bytes,
  stored: stats.stored,
  evictions: stats.evictions,
  tenants: stats.tenants,
});

beforeEach(() => store.resetResponseStore());

describe('response store — write-path ownership', () => {
  it('rejects a foreign caller replacing an existing id, leaving the owner entry and metadata untouched', () => {
    assert.equal(store.putResponse('shared', A_CONV, A, {
      model: 'owner-model',
      metadata: { secret: 'owner-tag' },
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
    }), true);
    const beforeEntry = store.getResponse('shared', A);
    const beforeStats = store.getResponseStoreStats();

    assert.equal(store.putResponse('shared', B_CONV, B, {
      model: 'intruder-model',
      metadata: { secret: 'intruder-tag' },
    }), false, 'B must not replace A\'s response');

    const afterStats = store.getResponseStoreStats();
    assert.deepEqual(ACCOUNTING(afterStats), ACCOUNTING(beforeStats),
      'size, bytes, stored, evictions and tenant count must be unchanged');
    assert.equal(afterStats.rejected, beforeStats.rejected + 1,
      'the rejected write is counted as rejected');

    const afterEntry = store.getResponse('shared', A);
    assert.equal(afterEntry.ok, true, 'A must still own and read its entry');
    assert.deepEqual(afterEntry.messages, A_CONV, 'A\'s conversation must be untouched');
    assert.equal(afterEntry.model, 'owner-model', 'model must not be inherited/replaced');
    assert.equal(afterEntry.status, 'incomplete', 'status must not be inherited/replaced');
    assert.equal(afterEntry.incompleteReason, 'max_output_tokens', 'reason must survive');
    assert.deepEqual(afterEntry.metadata, { secret: 'owner-tag' },
      'A\'s metadata must not be replaced or disclosed');
    assert.equal(afterEntry.createdAt, beforeEntry.createdAt,
      'createdAt must not be reset by a rejected write');

    assert.equal(store.getResponse('shared', B).ok, false,
      'B must not gain read access by attempting the write');
  });

  it('rejects a foreign write that supplies no metadata — it must not inherit the owner\'s', () => {
    store.putResponse('shared', A_CONV, A, { metadata: { secret: 'owner-tag' } });
    assert.equal(store.putResponse('shared', B_CONV, B), false);
    assert.deepEqual(store.getResponse('shared', A).metadata, { secret: 'owner-tag' });
    assert.equal(store.getResponse('shared', B).ok, false);
  });

  it('does not evict anything for a rejected foreign write, even when the payload would blow the byte budget', () => {
    // At MAX_ENTRIES=2 the store is full; the foreign payload is ~400KB of
    // accounted text and would force byte-budget eviction if it were accepted.
    store.putResponse('shared', A_CONV, A, { metadata: { secret: 'owner-tag' } });
    store.putResponse('other', A_CONV, A);
    const beforeStats = store.getResponseStoreStats();
    assert.equal(beforeStats.size, 2);
    assert.equal(beforeStats.evictions, 0);

    const huge = [{ role: 'user', content: 'x'.repeat(200000) }];
    assert.equal(store.putResponse('shared', huge, B), false);

    const afterStats = store.getResponseStoreStats();
    assert.equal(afterStats.size, 2, 'no entry may be evicted for a rejected write');
    assert.equal(afterStats.evictions, 0, 'eviction accounting must not move');
    assert.equal(afterStats.bytes, beforeStats.bytes, 'byte accounting must not move');
    assert.equal(afterStats.stored, beforeStats.stored);
    assert.deepEqual(store.getResponse('shared', A).messages, A_CONV);
    assert.deepEqual(store.getResponse('other', A).messages, A_CONV);
  });

  it('allows a foreign caller to create its OWN new id', () => {
    assert.equal(store.putResponse('b-own', B_CONV, B), true);
    assert.deepEqual(store.getResponse('b-own', B).messages, B_CONV);
    assert.equal(store.getResponse('b-own', A).ok, false);
  });
});

describe('response store — same-caller replacement stays a control', () => {
  it('replaces the messages and keeps inherited metadata/model when the refresh omits them', () => {
    store.putResponse('same', A_CONV, A, { model: 'model-1', metadata: { tag: 'kept' } });
    const grown = [...A_CONV, { role: 'user', content: 'turn 2' }];
    assert.equal(store.putResponse('same', grown, A, {}), true);
    const got = store.getResponse('same', A);
    assert.deepEqual(got.messages, grown);
    assert.equal(got.model, 'model-1');
    assert.deepEqual(got.metadata, { tag: 'kept' });
    assert.equal(store.getResponseStoreStats().size, 1, 'refresh is not a second entry');
    assert.equal(store.getResponseStoreStats().stored, 2, 'the successful refresh is counted');
  });

  it('lets an explicit metadata/model/status win on a same-caller refresh', () => {
    store.putResponse('same', A_CONV, A, {
      model: 'model-1', metadata: { tag: 'old' }, status: 'completed',
    });
    assert.equal(store.putResponse('same', B_CONV, A, {
      model: 'model-2',
      metadata: { tag: 'new' },
      status: 'incomplete',
      incompleteReason: 'content_filter',
    }), true);
    const got = store.getResponse('same', A);
    assert.deepEqual(got.messages, B_CONV);
    assert.equal(got.model, 'model-2');
    assert.deepEqual(got.metadata, { tag: 'new' });
    assert.equal(got.status, 'incomplete');
    assert.equal(got.incompleteReason, 'content_filter');
  });
});

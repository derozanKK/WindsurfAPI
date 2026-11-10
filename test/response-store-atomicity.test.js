// A19 — response writes must be failure-atomic.
//
// The old putResponse evicted the entry-count victim BEFORE the fallible
// structuredClone/copy ran. At RESPONSE_STORE_MAX=1 a new put carrying an
// uncloneable value (a function) threw DataCloneError and still left the store
// empty: the caller's existing conversation had been deleted by a write that
// never happened. Same for an entry rejected by the final byte limits.
//
// These tests pin the contract: a put either commits completely or changes
// nothing at all — no entry, byte, tenant or counter movement on failure.

process.env.RESPONSE_STORE_MAX = '1';
process.env.RESPONSE_STORE_MAX_BYTES = '256k';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../src/response-store.js');

const A = 'api:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:user:alice';
const B = 'api:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:user:bob';
const OLD = [
  { role: 'user', content: 'old turn' },
  { role: 'assistant', content: 'old reply' },
];

function accounting() {
  const s = store.getResponseStoreStats();
  return {
    size: s.size,
    bytes: s.bytes,
    stored: s.stored,
    evictions: s.evictions,
    rejected: s.rejected,
    tenants: s.tenants,
  };
}

beforeEach(() => store.resetResponseStore());

describe('A19 — failed new put preserves the existing entry', () => {
  it('an uncloneable payload does not evict the count victim', () => {
    assert.equal(store.putResponse('old', OLD, A, { model: 'owner-model', metadata: { tag: 'kept' } }), true);
    const beforeStats = accounting();
    const beforeEntry = store.getResponse('old', A);
    assert.equal(beforeEntry.ok, true);

    assert.throws(
      () => store.putResponse('new', [{ role: 'user', content: 'x', fn: () => 1 }], B),
      (error) => error.name === 'DataCloneError',
      'the clone failure must stay loud',
    );

    assert.deepEqual(accounting(), beforeStats,
      'a failed new put must not move size/bytes/stored/evictions/tenants');
    const afterEntry = store.getResponse('old', A);
    assert.equal(afterEntry.ok, true, 'the old entry must still exist');
    assert.deepEqual(afterEntry.messages, OLD);
    assert.equal(afterEntry.model, 'owner-model');
    assert.deepEqual(afterEntry.metadata, { tag: 'kept' });
  });

  it('an entry rejected by the final per-entry byte limit does not evict the count victim', () => {
    assert.equal(store.putResponse('old', OLD, A), true);
    const beforeStats = accounting();

    // 40k chars = 80KB accounted: the tool_call_id is unshrinkable and the
    // per-entry ceiling at this budget is 65,536 bytes, so preparation cannot
    // produce an admissible entry.
    const tooBig = [{
      role: 'tool',
      tool_call_id: 'c'.repeat(40_000),
      content: 'ok',
    }];
    assert.equal(store.putResponse('new', tooBig, B), false,
      'an entry that cannot satisfy the per-entry limit must be rejected');

    assert.deepEqual(accounting(), { ...beforeStats, rejected: beforeStats.rejected + 1 },
      'a rejected new put may only increment `rejected` — no eviction or re-accounting');
    assert.equal(store.getResponse('old', A).ok, true);
  });

  it('a failed same-id replacement leaves the old entry byte-for-byte readable', () => {
    assert.equal(store.putResponse('same', OLD, A, { model: 'm1', metadata: { tag: 'old' } }), true);
    const beforeStats = accounting();
    const beforeEntry = store.getResponse('same', A);

    assert.throws(
      () => store.putResponse('same', [{ role: 'user', content: 'y', fn: () => 2 }], A),
      (error) => error.name === 'DataCloneError',
    );

    assert.deepEqual(accounting(), beforeStats);
    assert.deepEqual(store.getResponse('same', A), beforeEntry);
  });

  it('a same-id replacement rejected by the final byte limit also leaves the old entry intact', () => {
    assert.equal(store.putResponse('same', OLD, A, { model: 'm1' }), true);
    const beforeStats = accounting();
    const beforeEntry = store.getResponse('same', A);

    const tooBig = [{ role: 'tool', tool_call_id: 'c'.repeat(40_000), content: 'ok' }];
    assert.equal(store.putResponse('same', tooBig, A), false);

    assert.deepEqual(accounting(), { ...beforeStats, rejected: beforeStats.rejected + 1 });
    assert.deepEqual(store.getResponse('same', A), beforeEntry);
  });

  it('a successful new put still evicts the count victim (control)', () => {
    assert.equal(store.putResponse('old', OLD, A), true);
    assert.equal(store.putResponse('new', [{ role: 'user', content: 'new turn' }], B), true);
    assert.equal(store.getResponse('old', A).ok, false, 'the count cap must still evict');
    assert.equal(store.getResponse('new', B).ok, true);
    assert.equal(store.getResponseStoreStats().evictions, 1);
  });
});

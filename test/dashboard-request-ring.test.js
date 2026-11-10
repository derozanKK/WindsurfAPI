import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordRequest, updateRequest, listRequests, requestRingStats, __resetRequestRingForTest,
} from '../src/dashboard/request-ring.js';

beforeEach(() => __resetRequestRingForTest());

describe('dashboard request ring', () => {
  it('returns newest first with a bounded page', () => {
    recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200, durationMs: 1, caller: 'secret-1' });
    recordRequest({ id: 'r2', ts: 200, model: 'b', status: 500, durationMs: 2, caller: 'secret-2' });
    recordRequest({ id: 'r3', ts: 300, model: 'a', status: 200, durationMs: 3, caller: 'secret-3' });

    const page = listRequests({ limit: 2 });
    assert.deepEqual(page.items.map((r) => r.id), ['r3', 'r2']);
    assert.equal(page.total, 3);
    assert.ok(page.nextCursor);
  });

  it('filters by model, status and class without leaking the caller', () => {
    recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200, class: 'ok', caller: 'raw-key-1' });
    recordRequest({ id: 'r2', ts: 200, model: 'b', status: 429, class: 'rate_limit', caller: 'raw-key-2' });

    const a = listRequests({ filter: { model: 'a' } });
    assert.deepEqual(a.items.map((r) => r.id), ['r1']);
    const rl = listRequests({ filter: { status: '429' } });
    assert.deepEqual(rl.items.map((r) => r.id), ['r2']);
    assert.equal(rl.items[0].caller.length, 8);
    assert.notEqual(rl.items[0].caller, 'raw-key-2');
  });

  it('paginates with an opaque cursor and reports ring stats', () => {
    recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200 });
    recordRequest({ id: 'r2', ts: 200, model: 'a', status: 200 });
    recordRequest({ id: 'r3', ts: 300, model: 'a', status: 200 });

    const first = listRequests({ limit: 2 });
    const second = listRequests({ limit: 2, cursor: first.nextCursor });
    assert.deepEqual(first.items.map((r) => r.id), ['r3', 'r2']);
    assert.deepEqual(second.items.map((r) => r.id), ['r1']);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(requestRingStats(), { total: 3, capacity: 2000 });
  });

  it('patches a streaming row in place without adding a second row', () => {
    const row = recordRequest({ id: 'r1', ts: 100, model: 'a', status: 200, durationMs: 45, stream: true });
    const updated = updateRequest(row.id, { durationMs: 1956, class: 'ok' });
    assert.equal(updated.durationMs, 1956);
    assert.equal(updated.class, 'ok');
    assert.equal(listRequests({}).total, 1);
    assert.equal(updateRequest('missing', { durationMs: 1 }), null);
  });

  it('drops unknown fields and coerces invalid values', () => {
    const row = recordRequest({ id: 'r1', ts: 'nope', model: 42, status: '200', durationMs: -5, body: 'secret' });
    assert.equal(row.model, null);
    assert.equal(row.status, null);
    assert.equal(row.durationMs, 0);
    assert.equal('body' in row, false);
  });
});

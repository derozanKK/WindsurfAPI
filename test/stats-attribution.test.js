// Known-open O3 (audit of 3.9.60): the per-account table summed to 352 requests
// while the page total read 393. The 41-row delta is structural, not lost data:
// requests recorded without an account id (global / unauthenticated paths)
// increment totalRequests but have no account row to land in. These tests pin
// that split on both the lifetime state (`getStats().accountCounts`) and the
// request-log window (`getRequestLog().byAccount`) so the UI can state the
// unattributed remainder instead of leaving the totals silently short.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRequestLog,
  getStats,
  importStats,
  recordRequest,
  resetStats,
} from '../src/dashboard/stats.js';

// Fixture reproduces the live numbers exactly: 393 total requests, 352 of them
// attributed across three accounts, 41 with no account at all.
const ATTRIBUTED = [
  { account: 'acct0001', requests: 200, errors: 20 },
  { account: 'acct0002', requests: 100, errors: 0 },
  { account: 'acct0003', requests: 52, errors: 2 },
];
const ATTRIBUTED_TOTAL = 352;
const UNATTRIBUTED = 41;
const TOTAL = 393;
const TOTAL_ERRORS = 27;

function seedGap() {
  for (const { account, requests, errors } of ATTRIBUTED) {
    for (let i = 0; i < requests; i++) recordRequest('model-a', i >= errors, 10, account);
  }
  // 36 successes + 5 errors without an account: the rows the account table
  // cannot show because there is no account dimension to key them by.
  for (let i = 0; i < UNATTRIBUTED; i++) recordRequest('model-a', i >= 5, 10, null);
}

describe('account attribution — the 352 vs 393 gap', () => {
  beforeEach(seedGap);
  afterEach(() => resetStats());

  it('derives the unattributed remainder from lifetime counters', () => {
    const stats = getStats();
    const attributed = Object.values(stats.accountCounts)
      .reduce((n, s) => n + s.requests, 0);

    assert.equal(stats.totalRequests, TOTAL);
    assert.equal(attributed, ATTRIBUTED_TOTAL);
    assert.deepEqual(stats.accountAttribution, {
      total: TOTAL,
      attributed: ATTRIBUTED_TOTAL,
      unattributed: UNATTRIBUTED,
    });
    assert.equal(
      stats.accountAttribution.attributed + stats.accountAttribution.unattributed,
      stats.totalRequests,
      'attributed + unattributed must equal the page total',
    );
  });

  it('reports the same remainder for the request-log window', () => {
    const page = getRequestLog({ limit: 10 });
    const attributed = page.byAccount.reduce((n, row) => n + row.requests, 0);

    assert.equal(page.summary.requests, TOTAL);
    assert.equal(attributed, ATTRIBUTED_TOTAL);
    assert.equal(page.unattributed.account, null);
    assert.equal(page.unattributed.requests, UNATTRIBUTED);
    assert.equal(
      attributed + page.unattributed.requests,
      page.summary.requests,
      'account rows + unattributed row must equal the log total',
    );
    // Failures are not the gap: they are counted wherever they were attributed.
    assert.equal(page.summary.errors, TOTAL_ERRORS);
    assert.equal(page.byAccount.reduce((n, row) => n + row.errors, 0), 22);
    assert.equal(page.unattributed.errors, 5);
  });

  it('derives the remainder for pre-fix persisted snapshots too', () => {
    resetStats();
    const result = importStats({
      totalRequests: TOTAL,
      successCount: 366,
      errorCount: TOTAL_ERRORS,
      accountCounts: { acct0001: { requests: ATTRIBUTED_TOTAL, success: 330, errors: 22 } },
    }, { mode: 'replace' });
    assert.equal(result.ok, true, 'snapshot must import');
    assert.deepEqual(getStats().accountAttribution, {
      total: TOTAL,
      attributed: ATTRIBUTED_TOTAL,
      unattributed: UNATTRIBUTED,
    });
  });

  it('reports zero unattributed when every request carries an account', () => {
    resetStats();
    recordRequest('model-a', true, 5, 'acct0001');
    recordRequest('model-a', false, 5, 'acct0002');

    assert.deepEqual(getStats().accountAttribution, {
      total: 2,
      attributed: 2,
      unattributed: 0,
    });
    const page = getRequestLog();
    assert.equal(page.unattributed.account, null);
    assert.equal(page.unattributed.requests, 0);
  });
});

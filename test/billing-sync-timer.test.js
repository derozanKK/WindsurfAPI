// The billing refresh timer must be OFF at BILLING_SYNC_INTERVAL_MS=0.
//
// "Disabled" is an absence, and an absence needs a seam to be provable: the timer
// was inline in initAuth, where a test can only boot a server to observe it. It
// lives in armBillingSyncTimer now, so this asserts both directions — nothing is
// scheduled at 0, and exactly one interval (plus one immediate refresh) otherwise.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { armBillingSyncTimer, billingSyncIntervalMs } from '../src/auth.js';

describe('billingSyncIntervalMs', () => {
  it('is 30 minutes by default', () => {
    assert.equal(billingSyncIntervalMs({}), 30 * 60 * 1000);
  });

  it('accepts an explicit cadence, including 0 (disabled)', () => {
    assert.equal(billingSyncIntervalMs({ BILLING_SYNC_INTERVAL_MS: '60000' }), 60_000);
    assert.equal(billingSyncIntervalMs({ BILLING_SYNC_INTERVAL_MS: '0' }), 0);
  });

  it('falls back to the default for garbage instead of silently disabling', () => {
    assert.equal(billingSyncIntervalMs({ BILLING_SYNC_INTERVAL_MS: 'soon' }), 30 * 60 * 1000);
    assert.equal(billingSyncIntervalMs({ BILLING_SYNC_INTERVAL_MS: '-5' }), 30 * 60 * 1000);
  });
});

describe('armBillingSyncTimer', () => {
  it('schedules NOTHING at interval 0', () => {
    let intervals = 0;
    let refreshes = 0;
    const handle = armBillingSyncTimer({
      intervalMs: billingSyncIntervalMs({ BILLING_SYNC_INTERVAL_MS: '0' }),
      setIntervalImpl: () => { intervals++; return 1; },
      refresh: async () => { refreshes++; },
    });
    assert.equal(handle, null, 'no handle means no timer to clear later');
    assert.equal(intervals, 0, 'no interval is armed');
    assert.equal(refreshes, 0, 'and no immediate refresh fires either');
  });

  it('arms exactly one interval and refreshes immediately', () => {
    const armed = [];
    let refreshes = 0;
    const handle = armBillingSyncTimer({
      intervalMs: 60_000,
      setIntervalImpl: (fn, ms) => { armed.push({ fn, ms }); return 'handle'; },
      refresh: async () => { refreshes++; },
    });
    assert.equal(handle, 'handle');
    assert.equal(refreshes, 1, 'the first sync runs at startup, not one interval later');
    assert.deepEqual(armed.map((a) => a.ms), [60_000]);
    // The callback refreshes again when it fires.
    armed[0].fn();
    assert.equal(refreshes, 2);
  });
});

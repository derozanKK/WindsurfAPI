// F4 — transient rate-limit latch persistence.
//
// markRateLimited wrote account.rateLimitedUntil / account._modelRateLimits only
// in memory, and _serializeAccounts persisted neither. A restart mid-cooldown
// therefore re-selected a dry account on the very first request. These tests
// drive the pure serialize→deserialize seams (no disk, no network) and the
// selection gate to pin the round-trip, the stale/garbage guards, the bound,
// and the behaviour a restart actually depends on.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, markRateLimited, releaseAccount,
  getApiKey, __serializeAccounts, __deserializeAccount, __isRateLimitedForModel,
  RATE_LIMIT_PERSIST_MAX_MS,
} from '../src/auth.js';
import { setBreakerTunables } from '../src/runtime-config.js';

const created = [];
function add(label) {
  const account = addAccountByKey(
    `f4-key-${Date.now()}-${created.length}-${Math.random().toString(36).slice(2)}`,
    label,
  );
  created.push(account.id);
  return account;
}

function persisted(account) {
  const record = __serializeAccounts().find(a => a.apiKey === account.apiKey);
  assert.ok(record, 'account is serialized');
  return record;
}

afterEach(() => {
  // getApiKey's fully-throttled fallback is ON by default; these tests assert
  // hard exclusion, so restore the default rather than leaving the override.
  setBreakerTunables({ degradedServe: null });
  while (created.length) removeAccount(created.pop());
});

describe('auth — transient rate-limit latch persistence', () => {
  it('future account-wide and model-scoped deadlines survive serialize→deserialize', () => {
    const account = add('future');
    markRateLimited(account.apiKey, 60_000);
    markRateLimited(account.apiKey, 120_000, 'claude-sonnet-4');

    const record = persisted(account);
    assert.equal(record.rateLimitedUntil, account.rateLimitedUntil,
      'account-wide deadline is written to the persisted record');
    assert.equal(record._modelRateLimits['claude-sonnet-4'], account._modelRateLimits['claude-sonnet-4'],
      'model-scoped deadline is written to the persisted record');

    const restored = __deserializeAccount(record);
    assert.equal(restored.rateLimitedUntil, record.rateLimitedUntil,
      'account-wide deadline survives the round-trip');
    assert.deepEqual(restored._modelRateLimits, record._modelRateLimits,
      'model-scoped deadlines survive the round-trip');
    assert.equal(restored.quotaResetAt, 0,
      'the quota dimension is untouched by the transient latch');
  });

  it('expired deadlines are dropped at save and at load', () => {
    const now = Date.now();
    const account = add('expired');
    account.rateLimitedUntil = now - 1_000;
    account._modelRateLimits = { expired: now - 1, live: now + 60_000 };

    const record = persisted(account);
    assert.equal(Object.hasOwn(record, 'rateLimitedUntil'), false,
      'a past account-wide deadline is not persisted');
    assert.deepEqual(record._modelRateLimits, { live: now + 60_000 },
      'only live model-scoped entries are persisted');

    const restored = __deserializeAccount({
      apiKey: 'expired-record',
      rateLimitedUntil: now - 1,
      _modelRateLimits: { expired: now - 1 },
    }, now);
    assert.equal(restored.rateLimitedUntil, 0, 'past deadline loads as no cooldown');
    assert.deepEqual(restored._modelRateLimits, {}, 'past model entries are dropped at load');
  });

  it('garbage and negative values are ignored, valid entries in the same map survive', () => {
    const now = Date.now();
    const restored = __deserializeAccount({
      apiKey: 'garbage-record',
      rateLimitedUntil: 'tomorrow',
      _modelRateLimits: {
        nan: NaN,
        negative: -1,
        infinity: Infinity,
        numericString: String(now + 60_000),
        nulled: null,
        object: { until: now + 60_000 },
        valid: now + 60_000,
      },
    }, now);
    assert.equal(restored.rateLimitedUntil, 0, 'non-numeric deadline is ignored');
    assert.deepEqual(restored._modelRateLimits, { valid: now + 60_000 },
      'only the finite future numeric entry survives');
  });

  it('an older accounts.json without the fields loads clean (no cooldown, no throw)', () => {
    const restored = __deserializeAccount({ apiKey: 'legacy-record' });
    assert.equal(restored.rateLimitedUntil, 0);
    assert.deepEqual(restored._modelRateLimits, {});
  });

  it('per-model keys are preserved verbatim across the round-trip', () => {
    const now = Date.now();
    const map = {
      'claude-sonnet-4': now + 60_000,
      'gpt-5.5': now + 120_000,
      'swe-1-6-slow': now + 180_000,
    };
    const account = add('model-keys');
    account._modelRateLimits = { ...map };

    const record = persisted(account);
    assert.deepEqual(record._modelRateLimits, map, 'every live key is persisted unchanged');
    const restored = __deserializeAccount(record, now);
    assert.deepEqual(restored._modelRateLimits, map, 'every key survives the round-trip');
  });

  it('a far-future deadline is clamped to the documented maximum at save and load', () => {
    const now = Date.now();
    const account = add('capped');
    account.rateLimitedUntil = now + RATE_LIMIT_PERSIST_MAX_MS * 3;
    account._modelRateLimits = { capped: now + RATE_LIMIT_PERSIST_MAX_MS * 2 };

    const record = persisted(account);
    assert.ok(record.rateLimitedUntil <= Date.now() + RATE_LIMIT_PERSIST_MAX_MS,
      'save clamps the account-wide deadline');
    assert.ok(record._modelRateLimits.capped <= Date.now() + RATE_LIMIT_PERSIST_MAX_MS,
      'save clamps model-scoped deadlines');

    const restored = __deserializeAccount({
      apiKey: 'capped-record',
      rateLimitedUntil: now + RATE_LIMIT_PERSIST_MAX_MS * 3,
      _modelRateLimits: { capped: now + RATE_LIMIT_PERSIST_MAX_MS * 2 },
    }, now);
    assert.equal(restored.rateLimitedUntil, now + RATE_LIMIT_PERSIST_MAX_MS,
      'load clamps a hostile/corrupt far-future value to now + cap');
    assert.equal(restored._modelRateLimits.capped, now + RATE_LIMIT_PERSIST_MAX_MS,
      'load clamps every model-scoped value to now + cap');
  });

  it('a restored account-wide cooldown still prevents selection after a "restart"', () => {
    setBreakerTunables({ degradedServe: false });
    const healthy = add('healthy-peer');
    const cooled = add('cooled');

    cooled.rateLimitedUntil = Date.now() + 60_000;
    const record = persisted(cooled);

    // Simulate the restart: the live object's in-memory latch is gone; only the
    // persisted record remains. loadAccounts reconstructs the account from it.
    cooled.rateLimitedUntil = 0;
    const restored = __deserializeAccount(record);
    assert.ok(restored.rateLimitedUntil > Date.now(), 'restored cooldown is still live');
    assert.equal(__isRateLimitedForModel(restored, null, Date.now()), true,
      'the selection gate rejects the restored account');

    // Apply the restored latch to the live pool object the way loadAccounts
    // would and prove the pool-level acquisition skips it for the healthy peer.
    cooled.rateLimitedUntil = restored.rateLimitedUntil;
    cooled._modelRateLimits = restored._modelRateLimits;
    const picked = getApiKey([], null, '');
    assert.ok(picked, 'the healthy peer must still be selectable');
    assert.equal(picked.apiKey, healthy.apiKey, 'acquisition must not re-pick the cooled account');
    releaseAccount(picked.apiKey);
  });

  it('a restored model/selector-scoped cooldown still prevents selection for that key', () => {
    setBreakerTunables({ degradedServe: false });
    const healthy = add('healthy-peer-model');
    const cooled = add('cooled-model');
    // The connect path selects with modelKey=null + a selector and stores the
    // cooldown under that selector in the same _modelRateLimits map, so this
    // exercises the exact shape a restart has to restore.
    const SELECTOR = 'swe-1-6-slow';

    markRateLimited(cooled.apiKey, 60_000, SELECTOR, 'c');
    const record = persisted(cooled);

    // Restart: memory latch gone, record remains.
    cooled._modelRateLimits = {};
    const restored = __deserializeAccount(record);
    assert.equal(__isRateLimitedForModel(restored, SELECTOR, Date.now()), true,
      'the restored scoped cooldown gates that key');
    assert.equal(__isRateLimitedForModel(restored, 'some-other-selector', Date.now()), false,
      'other keys stay routable on the same account');

    cooled._modelRateLimits = restored._modelRateLimits;
    const picked = getApiKey([], null, '', SELECTOR);
    assert.ok(picked, 'the healthy peer must still be selectable');
    assert.equal(picked.apiKey, healthy.apiKey, 'acquisition must not re-pick the cooled key');
    releaseAccount(picked.apiKey);
  });
});

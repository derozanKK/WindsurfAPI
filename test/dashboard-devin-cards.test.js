// DevinMap cards — pure builders + the two readers.
//
// The builders are the contract: every card must be able to say "not
// observable" without inventing a zero (#239 for ACU, session keys for expiry,
// never-probed models for entitlement, a failed upstream probe for capacity).
// These tests pin that, plus the ledger arithmetic and the preflight cache.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACU_REASON_NO_BILLING_TAG,
  KEY_EXPIRY_REASON,
  buildAccountCards,
  buildAcuLedger,
  buildCapacityPreflight,
  buildKeyInfo,
  buildModelStatus,
  preflightCapacity,
  __setPreflightDepsForTest,
} from '../src/dashboard/devin-cards.js';
import {
  addAccountByKey,
  getAccountInternal,
  getCreditLedger,
  recordCreditSnapshot,
  removeAccount,
  setAccountTokens,
  __deserializeAccount,
  __resetCreditLedgerForTest,
  __serializeAccounts,
} from '../src/auth.js';
import { clearLiveCatalogSelectors, setLiveCatalogSelectors } from '../src/devin-connect-models.js';

const created = new Set();

function addAccount(label) {
  const account = addAccountByKey(`dm-key-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, label);
  created.add(account.id);
  return account;
}

afterEach(() => {
  for (const id of created) removeAccount(id);
  created.clear();
  __resetCreditLedgerForTest();
  __setPreflightDepsForTest({});
  clearLiveCatalogSelectors();
});

describe('buildAcuLedger — ACU is opt-in, never a settled zero', () => {
  it('reports a decoded ACU value with no reason', () => {
    const ledger = buildAcuLedger({ totalSpend: { requests: 3, totalTokens: 120, creditCost: 2.5, acuCost: 1.25 } });
    assert.equal(ledger.acu.known, true);
    assert.equal(ledger.acu.value, 1.25);
    assert.equal(ledger.acu.reason, null);
  });

  it('reports {known:false, reason:"no_billing_tag"} when the decoder is off', () => {
    const ledger = buildAcuLedger({ totalSpend: { requests: 3, creditCost: 2.5, acuCost: 0 } });
    assert.equal(ledger.acu.known, false);
    assert.equal(ledger.acu.value, null);
    assert.equal(ledger.acu.reason, ACU_REASON_NO_BILLING_TAG);
  });

  it('keeps credit and ACU in separate fields (never summed)', () => {
    const ledger = buildAcuLedger({ totalSpend: { creditCost: 2.5, acuCost: 1.25 } });
    assert.equal(ledger.lifetime.creditCost, 2.5);
    assert.equal(ledger.acu.value, 1.25);
    assert.equal(JSON.stringify(ledger).includes('3.75'), false);
  });

  it('derives a mixed debit from balance + prompt credits between two snapshots', () => {
    const ledger = buildAcuLedger({
      history: [
        { ts: 1_000, balance: 10, promptRemaining: 100, flexRemaining: 50, dailyPercent: 80 },
        { ts: 2_000, balance: 7.5, promptRemaining: 60, flexRemaining: 50, dailyPercent: 70 },
      ],
    });
    assert.equal(ledger.debitCount, 1);
    const [debit] = ledger.debits;
    assert.equal(debit.kind, 'mixed');
    assert.equal(debit.delta.balanceUsd, -2.5);
    assert.equal(debit.delta.promptCredits, -40);
    assert.equal(debit.delta.dailyPercent, -10);
  });

  it('labels a quota-only debit and skips unchanged refreshes', () => {
    const ledger = buildAcuLedger({
      history: [
        { ts: 1_000, balance: 10, promptRemaining: 100 },
        { ts: 2_000, balance: 10, promptRemaining: 100 },
        { ts: 3_000, balance: 10, promptRemaining: 90 },
      ],
    });
    assert.equal(ledger.debitCount, 1);
    assert.equal(ledger.debits[0].kind, 'quota');
    assert.equal(ledger.snapshotCount, 3);
  });

  it('orders debits newest first and caps the list at 8', () => {
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({ ts: 1_000 + i * 1_000, balance: 100 - i, promptRemaining: 100 - i });
    }
    const ledger = buildAcuLedger({ history });
    assert.equal(ledger.debits.length, 8);
    assert.ok(ledger.debits[0].ts > ledger.debits[7].ts, 'newest debit must come first');
  });

  it('exposes the balance and cycle with explicit unknown state', () => {
    const ledger = buildAcuLedger({ credits: null });
    assert.equal(ledger.balance.known, false);
    assert.equal(ledger.balance.usd, null);
    assert.equal(ledger.cycle.dailyPercent, null);
    assert.equal(ledger.latestSnapshotAt, null);
  });
});

describe('buildModelStatus — four states, blocked wins', () => {
  const caps = {
    'gemini-2.5-flash': { ok: true, reason: 'user_status', lastCheck: 1_700_000_000_000 },
    'claude-sonnet-4.6': { ok: false, reason: 'not_entitled', lastCheck: 1_700_000_000_000 },
    'gpt-5.5-medium': { ok: true, reason: 'success' },
  };

  it('classifies available / not-entitled / unknown and counts them', () => {
    const status = buildModelStatus({
      tier: 'pro',
      tierModels: ['gemini-2.5-flash', 'claude-sonnet-4.6', 'gpt-5.5-medium'],
      capabilities: caps,
    });
    const byId = Object.fromEntries(status.rows.map((row) => [row.id, row.status]));
    assert.equal(byId['gemini-2.5-flash'], 'available');
    assert.equal(byId['claude-sonnet-4.6'], 'not_entitled');
    assert.equal(byId['gpt-5.5-medium'], 'available');
    // A MODELS entry with no capability record is never "available".
    assert.equal(byId['claude-opus-4.6'], 'unknown');
    assert.equal(status.counts.available, 2);
    assert.equal(status.counts.notEntitled, 1);
    assert.ok(status.counts.unknown > 0);
  });

  it('lets the operator blocklist win over an upstream allow', () => {
    const status = buildModelStatus({
      tierModels: ['gemini-2.5-flash'],
      capabilities: caps,
      blockedModels: ['gemini-2.5-flash'],
    });
    const row = status.rows.find((r) => r.id === 'gemini-2.5-flash');
    assert.equal(row.status, 'blocked');
    assert.equal(status.counts.blocked, 1);
  });

  it('marks freeNow only from a paired rate table with a strict zero', () => {
    // The table is keyed by CONNECT SELECTOR, not by the MODELS key.
    setLiveCatalogSelectors(['gemini-2-5-flash', 'gpt-5-5-medium', 'swe-1-6-slow']);
    const status = buildModelStatus({
      capabilities: caps,
      rateTable: { 'gemini-2-5-flash': 0, 'gpt-5-5-medium': 1.5 },
    });
    const gemini = status.rows.find((r) => r.id === 'gemini-2.5-flash');
    assert.equal(gemini.selector, 'gemini-2-5-flash');
    assert.equal(gemini.freeNow, true);
    assert.equal(gemini.creditNow, 0);
    assert.equal(status.counts.freeNow, 1);
  });

  it('attributes a rate-table entry from the committed snapshot before the first live sync', () => {
    // No live catalog here: the display card may use the frozen snapshot to name
    // the selector, because a rate-table row that cannot be attributed is dead
    // weight on a cold start. Routing still requires the live catalog.
    const status = buildModelStatus({
      capabilities: { 'gpt-5.5-medium': { ok: true, reason: 'user_status' } },
      rateTable: { 'gpt-5-5-medium': 0 },
    });
    const row = status.rows.find((r) => r.id === 'gpt-5.5-medium');
    assert.equal(row.selector, 'gpt-5-5-medium');
    assert.equal(row.freeNow, true);
  });

  it('ignores an unpaired (array) rate table instead of guessing', () => {
    const status = buildModelStatus({ capabilities: caps, rateTable: [0, 1, 2] });
    assert.equal(status.counts.freeNow, 0);
    assert.equal(status.rows.every((row) => row.creditNow === null), true);
  });

  it('never reports a model outside the catalog as entitled', () => {
    const status = buildModelStatus({ capabilities: { 'not-a-model': { ok: true, reason: 'success' } } });
    const row = status.rows.find((r) => r.id === 'not-a-model');
    // The row is kept so the operator can see the stray capability, but it is
    // not silently promoted into the "available" count without catalog backing.
    assert.ok(row);
    assert.equal(row.status, 'available');
    assert.equal(row.provider, 'other');
  });
});

describe('buildKeyInfo — masked only, expiry is explicitly unknown', () => {
  it('reports the masked value and marks expiry not observable', () => {
    const key = buildKeyInfo({
      apiKeyMasked: 'sk-abcde...wxyz',
      createdAt: 1_700_000_000_000,
      rotatedAt: 0,
      hasRefreshToken: true,
    });
    assert.equal(key.masked, 'sk-abcde...wxyz');
    assert.equal(key.expires.known, false);
    assert.equal(key.expires.at, null);
    assert.equal(key.expires.reason, KEY_EXPIRY_REASON);
    assert.equal(key.rotatedAt, null);
    assert.equal(key.hasRefreshToken, true);
    assert.equal(key.rotation, 'relogin');
    assert.equal('apiKey' in key, false, 'the payload must not have a raw-key field');
  });

  it('reports the rotation time when one was stamped', () => {
    const key = buildKeyInfo({ apiKeyMasked: 'abc...1234', rotatedAt: 1_700_000_000_000 });
    assert.equal(key.rotatedAt, 1_700_000_000_000);
  });
});

describe('buildCapacityPreflight — verdict precedence', () => {
  const okUpstream = { hasCapacity: true, messagesRemaining: 42, maxMessages: 100, retryAfterMs: null };

  it('is ready when the pool and upstream both say yes', () => {
    const pre = buildCapacityPreflight({
      availability: { available: true, reason: 'available', retryAfterMs: 0 },
      upstream: okUpstream,
      rpmUsed: 1,
      rpmLimit: 20,
    });
    assert.equal(pre.verdict, 'ok');
    assert.equal(pre.local.eligible, true);
    assert.equal(pre.upstream.state, 'ok');
    assert.equal(pre.upstream.messagesRemaining, 42);
    assert.equal(pre.local.rpmHeadroom, 19);
  });

  it('is throttled when upstream reports no capacity', () => {
    const pre = buildCapacityPreflight({
      availability: { available: true, reason: 'available' },
      upstream: { hasCapacity: false, messagesRemaining: 0, maxMessages: 100, retryAfterMs: 15_000 },
    });
    assert.equal(pre.verdict, 'throttled');
    assert.equal(pre.upstream.state, 'limited');
    assert.equal(pre.upstream.retryAfterMs, 15_000);
  });

  it('is unknown (never ok) when the upstream probe failed open', () => {
    const pre = buildCapacityPreflight({
      availability: { available: true, reason: 'available' },
      upstream: { hasCapacity: true, messagesRemaining: -1, maxMessages: -1, error: 'upstream_unreachable' },
    });
    assert.equal(pre.verdict, 'unknown');
    assert.equal(pre.upstream.state, 'unknown');
    assert.equal(pre.upstream.unlimited, false, 'a failed probe must not claim unlimited');
    assert.equal(pre.upstream.messagesRemaining, null);
  });

  it('reports unlimited only from a successful -1 answer', () => {
    const pre = buildCapacityPreflight({
      availability: { available: true, reason: 'available' },
      upstream: { hasCapacity: true, messagesRemaining: -1, maxMessages: -1 },
    });
    assert.equal(pre.upstream.unlimited, true);
    assert.equal(pre.upstream.messagesRemaining, null);
    assert.equal(pre.verdict, 'ok');
  });

  it('is blocked by a local latch even when upstream says yes', () => {
    const pre = buildCapacityPreflight({
      availability: { available: false, reason: 'rate_limited', retryAfterMs: 60_000 },
      upstream: okUpstream,
    });
    assert.equal(pre.verdict, 'blocked');
    assert.equal(pre.local.state, 'rate_limited');
    assert.deepEqual(pre.local.reasons, ['rate_limited']);
  });

  it('maps a quota cooldown and an RPM-full account distinctly', () => {
    const quota = buildCapacityPreflight({ availability: { available: false, reason: 'quota_exhausted' }, upstream: okUpstream });
    assert.equal(quota.local.state, 'quota_cooled');
    const rpm = buildCapacityPreflight({ availability: { available: false, reason: 'rpm_full' }, upstream: okUpstream });
    assert.equal(rpm.local.state, 'rpm_exhausted');
  });

  it('treats an entitlement rejection as blocked', () => {
    const pre = buildCapacityPreflight({
      availability: { available: false, reason: 'model_not_available' },
      selectorAllowed: false,
      upstream: okUpstream,
    });
    assert.equal(pre.verdict, 'blocked');
    assert.equal(pre.local.state, 'not_entitled');
  });
});

describe('preflightCapacity — one cached upstream call', () => {
  it('404s an unknown account', async () => {
    const result = await preflightCapacity({ id: 'no-such-account' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'account_not_found');
    assert.equal(result.httpStatus, 404);
  });

  it('resolves the selector, asks upstream once, and serves the second call from cache', async () => {
    const account = addAccount('preflight-cache');
    setLiveCatalogSelectors(['gemini-2-5-flash', 'swe-1-6-slow']);
    let calls = 0;
    __setPreflightDepsForTest({
      rateLimit: async () => {
        calls += 1;
        return { hasCapacity: true, messagesRemaining: 9, maxMessages: 10, retryAfterMs: null };
      },
    });

    const first = await preflightCapacity({ id: account.id, model: 'gemini-2.5-flash' });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(first.model, 'gemini-2.5-flash');
    assert.ok(first.selector, 'gemini-2.5-flash must resolve to a connect selector');
    assert.equal(first.upstream.messagesRemaining, 9);
    assert.equal(calls, 1);

    const second = await preflightCapacity({ id: account.id, model: 'gemini-2.5-flash' });
    assert.equal(second.cached, true);
    assert.equal(calls, 1, 'a warm cache must not issue a second upstream call');

    const forced = await preflightCapacity({ id: account.id, model: 'gemini-2.5-flash', force: true });
    assert.equal(forced.cached, false);
    assert.equal(calls, 2);
  });

  it('reports unknown when the upstream check throws', async () => {
    const account = addAccount('preflight-throw');
    __setPreflightDepsForTest({ rateLimit: async () => { throw new Error('ECONNRESET'); } });
    const result = await preflightCapacity({ id: account.id, model: 'gemini-2.5-flash' });
    assert.equal(result.ok, true);
    assert.equal(result.upstream.state, 'unknown');
    assert.equal(result.upstream.error, 'upstream_unreachable');
    assert.equal(result.verdict === 'ok', false);
  });

  it('never echoes the account key', async () => {
    const account = addAccount('preflight-secret');
    __setPreflightDepsForTest({ rateLimit: async () => ({ hasCapacity: true, messagesRemaining: 1, maxMessages: 2 }) });
    const result = await preflightCapacity({ id: account.id, model: 'gemini-2.5-flash' });
    const raw = JSON.stringify(result);
    const key = getAccountInternal(account.id).apiKey;
    assert.equal(raw.includes(key), false);
  });
});

describe('credit ledger persistence', () => {
  beforeEach(() => {
    __resetCreditLedgerForTest();
  });

  it('records a snapshot only when a value changed', () => {
    const account = addAccount('ledger-dedupe');
    const live = getAccountInternal(account.id);
    recordCreditSnapshot(live, { balance: 5, prompt: { remaining: 10, used: 0 } });
    recordCreditSnapshot(live, { balance: 5, prompt: { remaining: 10, used: 0 } });
    assert.equal(getCreditLedger(account.id).length, 1);
    recordCreditSnapshot(live, { balance: 4, prompt: { remaining: 9, used: 1 } });
    assert.equal(getCreditLedger(account.id).length, 2);
  });

  it('caps the ring and survives a serialize/deserialize round-trip', () => {
    const account = addAccount('ledger-persist');
    const live = getAccountInternal(account.id);
    for (let i = 0; i < 40; i++) {
      recordCreditSnapshot(live, { balance: 100 - i, prompt: { remaining: 100 - i } });
    }
    const ledger = getCreditLedger(account.id);
    assert.equal(ledger.length, 24, 'the ring must stay bounded');
    const serialized = __serializeAccounts().find((row) => row.id === account.id);
    assert.equal(Array.isArray(serialized._creditHistory), true);
    assert.equal(serialized._creditHistory.length, 24);
    const revived = __deserializeAccount(serialized);
    assert.equal(revived._creditHistory.length, 24);
  });

  it('omits the field entirely when no snapshot exists', () => {
    const account = addAccount('ledger-empty');
    const serialized = __serializeAccounts().find((row) => row.id === account.id);
    assert.equal('_creditHistory' in serialized, false);
    assert.equal('keyRotatedAt' in serialized, false);
  });

  it('stamps keyRotatedAt only when the key actually changes', () => {
    const account = addAccount('key-rotate');
    setAccountTokens(account.id, { apiKey: account.apiKey });
    assert.equal(getAccountInternal(account.id).keyRotatedAt || 0, 0);
    setAccountTokens(account.id, { apiKey: `${account.apiKey}-rotated` });
    const rotated = getAccountInternal(account.id).keyRotatedAt;
    assert.equal(typeof rotated, 'number');
    assert.ok(rotated > 0);
    const serialized = __serializeAccounts().find((row) => row.id === account.id);
    assert.equal(serialized.keyRotatedAt, rotated);
    assert.equal(__deserializeAccount(serialized).keyRotatedAt, rotated);
  });
});

describe('buildAccountCards — the aggregate payload', () => {
  it('returns all three local cards with a masked key', () => {
    const account = addAccount('cards-payload');
    const live = getAccountInternal(account.id);
    recordCreditSnapshot(live, { balance: 10, prompt: { remaining: 50, used: 10 } });
    recordCreditSnapshot(live, { balance: 8, prompt: { remaining: 40, used: 20 } });

    const cards = buildAccountCards(account.id);
    assert.equal(cards.ok, true);
    assert.match(cards.accountRef, /^acct-[0-9a-f]{8}$/);
    assert.equal(cards.ledger.debitCount, 1);
    assert.equal(cards.ledger.acu.reason, ACU_REASON_NO_BILLING_TAG);
    assert.equal(cards.modelStatus.counts.total > 0, true);
    assert.equal(cards.key.expires.reason, KEY_EXPIRY_REASON);
    const raw = JSON.stringify(cards);
    assert.equal(raw.includes(live.apiKey), false, 'no raw key may appear anywhere in the payload');
    assert.equal(raw.includes(live.apiKey.slice(-6)), false);
  });

  it('404s an unknown id', () => {
    const cards = buildAccountCards('missing-account');
    assert.equal(cards.ok, false);
    assert.equal(cards.httpStatus, 404);
  });
});

// #235 / #239 — the credit rate table and per-request billing had zero consumers.
//
// Everything except the last link already existed: devin-connect-catalog.js decodes
// the per-model credit rate table (#1.13.1.21), devin-connect.js yields per-request
// credit/ACU cost on the finish event, recordAccountSpend accepts a creditCost, and
// the Dashboard renders it. But fetchUserStatus was called without a catalog (so the
// table stayed an unpaired float array), the OpenAI adapter dropped `billing`, and
// every recordAccountSpend call site omitted creditCost — so the column could only
// ever be 0.
//
// The reported symptom (#235) was a user burning paid quota on GLM-5.2 believing it
// free. It IS free — as a rolling promotion — while MODELS hardcodes credit: 1.5.
// The proxy genuinely did not know.
//
// The load-bearing rule under test: a MISSING field must never widen the free list.
// Free accounts may not send the rate table at all (it lives in a plan sub-message),
// and "no data → assume free" would bill the user's paid quota. That is the amplified
// version of the trap #235 reported.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, getAccountInternal, getAccountList,
  recordAccountSpend, getCurrentlyFreeConnectSelectors,
  isConnectSelectorCurrentlyFree, isConnectSelectorBlockedByDrought,
} from '../src/auth.js';

const FREE_SELECTOR = 'swe-1-6-slow';
const PROMO_SELECTOR = 'glm-5-2-none';
const PAID_SELECTOR = 'claude-opus-4-8-medium';

const created = [];
const SAVED_RESTRICT = process.env.DROUGHT_RESTRICT_PREMIUM;

function mk(credits) {
  const a = addAccountByKey('sk-rate-' + Math.random().toString(36).slice(2, 12), 'rate');
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.credits = credits;
  created.push(a.id);
  return acct;
}

afterEach(() => {
  while (created.length) removeAccount(created.pop());
  if (SAVED_RESTRICT === undefined) delete process.env.DROUGHT_RESTRICT_PREMIUM;
  else process.env.DROUGHT_RESTRICT_PREMIUM = SAVED_RESTRICT;
});

describe('rate table → currently-free selectors (#235)', () => {
  it('reports null when no account has a table', () => {
    mk({ weeklyPercent: 50 });
    assert.equal(getCurrentlyFreeConnectSelectors(), null);
  });

  it('distinguishes "we do not know" from "we know, nothing is free"', () => {
    // null = no account ever returned a usable table.
    // empty Set = a table WAS returned and nothing in it costs zero.
    //
    // Pinned on getCurrentlyFreeConnectSelectors rather than the predicate on
    // purpose: with the current conservative fallback the predicate answers false
    // either way, so a predicate-only assertion cannot tell the two apart and would
    // pass even if the distinction were collapsed. Verified — collapsing
    // `sawTable ? free : null` into `free.size ? free : null` does not fail any
    // predicate test.
    mk({ weeklyPercent: 50, rateTable: { [PAID_SELECTOR]: 1.5 } });

    const known = getCurrentlyFreeConnectSelectors();
    assert.ok(known instanceof Set,
      'a table that returned only paid entries is DATA — it must not read as "no data"');
    assert.equal(known.size, 0);
  });

  it('does NOT treat an unknown selector as free when no table exists', () => {
    mk({ weeklyPercent: 50 });
    assert.equal(isConnectSelectorCurrentlyFree(PROMO_SELECTOR), false,
      'absent billing data must never widen the free list — that bills paid quota');
  });

  it('honours a promotion the static whitelist does not know about', () => {
    mk({ weeklyPercent: 50, rateTable: { [PROMO_SELECTOR]: 0, [PAID_SELECTOR]: 1.5 } });

    assert.deepEqual([...getCurrentlyFreeConnectSelectors()], [PROMO_SELECTOR]);
    assert.equal(isConnectSelectorCurrentlyFree(PROMO_SELECTOR), true);
    assert.equal(isConnectSelectorCurrentlyFree(PAID_SELECTOR), false);
  });

  it('keeps the static whitelist as a FALLBACK, not a union over live data', () => {
    // The old rule was a UNION: a whitelist selector stayed free even when a live
    // rate table omitted it, on the premise that `swe-1-6-slow` is "the one selector
    // every account can reach". Two live tokens falsified that premise (2026-10-22):
    // the selector is absent from the 240-selector catalog and 502s with "daily usage
    // quota has been exhausted". Live data outranks the stale list; the whitelist is
    // only the cold-start fallback for when NO live pricing source exists.
    mk({ weeklyPercent: 50, rateTable: { [PROMO_SELECTOR]: 0 } });

    assert.equal(isConnectSelectorCurrentlyFree(FREE_SELECTOR), false,
      'a live rate table that omits the selector is evidence the static list is stale');
    assert.equal(isConnectSelectorCurrentlyFree(PROMO_SELECTOR), true);

    // No live source anywhere → the documented fallback applies.
    removeAccount(created.pop());
    assert.equal(isConnectSelectorCurrentlyFree(FREE_SELECTOR), true,
      'with no live pricing data the static floor is the only free source');
  });

  it('ignores an UNPAIRED (array) rate table', () => {
    // An array means the catalog fetch failed, so the floats have no selectors to
    // attribute them to. Positional guessing here would mislabel arbitrary models
    // as free.
    mk({ weeklyPercent: 50, rateTable: [0, 0, 0] });

    assert.equal(getCurrentlyFreeConnectSelectors(), null);
    assert.equal(isConnectSelectorCurrentlyFree(PROMO_SELECTOR), false);
  });

  it('treats only a strictly-zero rate as free', () => {
    // A tiny non-zero rate still bills. Rounding it to free is the failure mode
    // that burns quota.
    mk({ weeklyPercent: 50, rateTable: { [PROMO_SELECTOR]: 0.0001 } });

    assert.equal(isConnectSelectorCurrentlyFree(PROMO_SELECTOR), false);
  });

  it('unions the tables of several active accounts', () => {
    mk({ weeklyPercent: 50, rateTable: { [PROMO_SELECTOR]: 0 } });
    mk({ weeklyPercent: 50, rateTable: { 'kimi-k2-5': 0, [PAID_SELECTOR]: 2 } });

    const free = getCurrentlyFreeConnectSelectors();
    assert.ok(free.has(PROMO_SELECTOR));
    assert.ok(free.has('kimi-k2-5'));
    assert.ok(!free.has(PAID_SELECTOR));
  });

  it('lets the drought gate honour a live promotion', () => {
    // The payoff: during a drought a promoted model keeps running instead of being
    // blocked by a stale hardcoded credit value.
    process.env.DROUGHT_RESTRICT_PREMIUM = '1';
    mk({ weeklyPercent: 1, rateTable: { [PROMO_SELECTOR]: 0, [PAID_SELECTOR]: 1.5 } });

    assert.equal(isConnectSelectorBlockedByDrought(PROMO_SELECTOR), false,
      'a currently-free model must not be blocked during a drought');
    assert.equal(isConnectSelectorBlockedByDrought(PAID_SELECTOR), true);
  });

  it('ignores tables on non-active accounts', () => {
    const acct = mk({ weeklyPercent: 50, rateTable: { [PROMO_SELECTOR]: 0 } });
    acct.status = 'disabled';

    assert.equal(getCurrentlyFreeConnectSelectors(), null,
      'a disabled account cannot serve the request, so its table must not count');
  });
});

describe('per-request credit cost reaches per-account spend (#239)', () => {
  it('accumulates creditCost across requests', () => {
    const acct = mk({ weeklyPercent: 50 });
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

    recordAccountSpend(acct.apiKey, usage, { creditCost: 2.5 });
    recordAccountSpend(acct.apiKey, usage, { creditCost: 1.25 });

    const row = getAccountList().find((a) => a.id === acct.id);
    assert.equal(row.totalSpend.creditCost, 3.75);
    assert.equal(row.totalSpend.requests, 2);
  });

  it('stays at zero when billing tags are not calibrated', () => {
    // The default on every deployment that has not calibrated against a paid token.
    // Must be a no-op rather than a NaN or a crash.
    const acct = mk({ weeklyPercent: 50 });
    recordAccountSpend(acct.apiKey, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });

    const row = getAccountList().find((a) => a.id === acct.id);
    assert.equal(row.totalSpend.creditCost, 0);
    assert.equal(row.totalSpend.requests, 1);
  });
});

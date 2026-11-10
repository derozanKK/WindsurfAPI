// Tier inference must never be a demotion engine.
//
// `updateCapability` runs on every chat outcome and, when no authoritative
// GetUserStatus has landed, rewrites account.tier from the Cascade canaries. Two
// measured defects on a Pro account whose only working selectors were swe-2:
//
//   1. one successful `gemini-2.5-flash` canary flipped tier 'pro' → 'free'
//      (refreshCredits sets tier from planName but does NOT set
//      userStatusLastFetched, so the guard did not fire). `isConnectSelectorAllowedForAccount`
//      then blocks every paid selector — i.e. the canary removed the account's only
//      working route.
//   2. every canary failing (a daily-dry account: all paid selectors return
//      QUOTA_EXHAUSTED) flipped tier → 'expired', which blocks everything.
//
// The rules pinned here: a plan name is positive evidence and a FLOOR; a
// non-premium success is not evidence of a downgrade; all-canaries-failed is
// "unknown", never "expired"; and unknown is never treated as free.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __deserializeAccount,
  __resetModelCatalogState,
  __serializeAccounts,
  __setModelCatalogDeps,
  addAccountByKey,
  getAccountInternal,
  isConnectSelectorAllowedForAccount,
  removeAccount,
  tierFromPlanName,
  updateCapability,
} from '../src/auth.js';

const created = [];

function seed({ tier = 'unknown', planTier = null } = {}) {
  const a = addAccountByKey(`sk-tier-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'tier');
  created.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.status = 'active';
  acct.tier = tier;
  acct.planTier = planTier;
  return acct;
}

beforeEach(() => {
  __setModelCatalogDeps({
    disableConnectSync: true,
    getCascadeModelConfigs: async () => ({ configs: [] }),
  });
});

afterEach(() => {
  for (const id of created.splice(0)) {
    try { removeAccount(id); } catch {}
  }
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
});

describe('tierFromPlanName — plan name is evidence, silence is not', () => {
  it('maps paid plans and trials to pro', () => {
    for (const name of ['Pro', 'PRO', 'Teams', 'Enterprise', 'TRIAL', 'Individual', 'Premium', 'paid']) {
      assert.equal(tierFromPlanName(name), 'pro', name);
    }
  });

  it('maps an explicit free plan to free', () => {
    assert.equal(tierFromPlanName('Free'), 'free');
    assert.equal(tierFromPlanName('free plan'), 'free');
  });

  it('returns null for a missing or unrecognised plan name (never free)', () => {
    for (const name of ['', null, undefined, 'Mystery Plan']) {
      assert.equal(tierFromPlanName(name), null, String(name));
    }
  });
});

describe('inferTier via updateCapability — conservative demotion', () => {
  it('does NOT demote a plan-pro account on a gemini canary success', () => {
    const acct = seed({ tier: 'pro', planTier: 'pro' });
    updateCapability(acct.apiKey, 'gemini-2.5-flash', true, 'success');

    assert.equal(acct.tier, 'pro',
      'a non-premium model succeeding is not evidence the PLAN changed');
    assert.equal(isConnectSelectorAllowedForAccount(acct, 'swe-2-medium'), true,
      'the account must keep its only working paid selectors');
  });

  it('does NOT mark a plan-pro account expired when every canary fails', () => {
    const acct = seed({ tier: 'pro', planTier: 'pro' });
    updateCapability(acct.apiKey, 'claude-opus-4.6', false, 'model_error');
    updateCapability(acct.apiKey, 'gemini-2.5-flash', false, 'model_error');
    updateCapability(acct.apiKey, 'gpt-4o-mini', false, 'model_error');

    assert.equal(acct.tier, 'pro',
      'a daily-dry account fails every paid canary with QUOTA_EXHAUSTED; that is not expiry');
  });

  it('reports unknown — not expired, not free — when canaries fail with no plan floor', () => {
    const acct = seed({ tier: 'unknown', planTier: null });
    updateCapability(acct.apiKey, 'gemini-2.5-flash', false, 'model_error');

    assert.equal(acct.tier, 'unknown');
    assert.equal(isConnectSelectorAllowedForAccount(acct, 'claude-opus-4-8-medium'), true,
      'unknown stays optimistic for paid selectors (self-healing), which "free" would not');
  });

  it('still infers free from a free canary when no plan says otherwise', () => {
    const acct = seed({ tier: 'unknown', planTier: null });
    updateCapability(acct.apiKey, 'gemini-2.5-flash', true, 'success');

    assert.equal(acct.tier, 'free');
    assert.equal(isConnectSelectorAllowedForAccount(acct, 'claude-opus-4-8-medium'), false);
  });

  it('lets a paid canary promote above a free plan floor', () => {
    const acct = seed({ tier: 'free', planTier: 'free' });
    updateCapability(acct.apiKey, 'claude-opus-4.6', true, 'success');

    assert.equal(acct.tier, 'pro',
      'positive evidence of a paid model outranks a stale free plan name');
  });

  it('a free plan floor does not block the free inference', () => {
    const acct = seed({ tier: 'free', planTier: 'free' });
    updateCapability(acct.apiKey, 'gemini-2.5-flash', true, 'success');

    assert.equal(acct.tier, 'free');
  });
});

describe('planTier persistence — the floor survives a restart', () => {
  it('round-trips a plan-derived floor', () => {
    const acct = seed({ tier: 'pro', planTier: 'pro' });
    const record = __serializeAccounts().find((row) => row.id === acct.id);
    assert.equal(record.planTier, 'pro');

    const restored = __deserializeAccount(record);
    assert.equal(restored.planTier, 'pro');
    assert.equal(restored.tier, 'pro');
  });

  it('loads an older accounts.json without a floor as null, not free', () => {
    const restored = __deserializeAccount({ apiKey: 'legacy-tier-record', email: 'x@y.com' });
    assert.equal(restored.planTier, null,
      'unknown is not free — a missing floor must not become a downgrade');
    assert.equal(restored.tier, 'unknown');
  });
});

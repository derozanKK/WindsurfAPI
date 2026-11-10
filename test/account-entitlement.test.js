import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isModelAllowedForAccount, getAvailableModelsForAccount } from '../src/auth.js';

// Free Windsurf accounts entitled by `cascade_allowed_models_config` to
// GLM/SWE/Kimi were getting routed away from the proxy because
// `MODEL_TIER_ACCESS.free` is a static `['gemini-2.5-flash', ...]` list
// that ignored per-account capabilities populated authoritatively by
// GetUserStatus. The fix is to trust `capabilities[key].reason ===
// 'user_status'` over the tier list once GetUserStatus has run.

describe('isModelAllowedForAccount — capabilities-first routing', () => {
  it('honours user_status capability for free accounts entitled to GLM', () => {
    const account = {
      tier: 'free',
      userStatusLastFetched: Date.now(),
      capabilities: {
        'glm-4.7': { ok: true, reason: 'user_status', lastCheck: 1 },
        'gemini-2.5-flash': { ok: true, reason: 'user_status', lastCheck: 1 },
        'claude-opus-4.6': { ok: false, reason: 'not_entitled', lastCheck: 1 },
      },
    };
    assert.equal(isModelAllowedForAccount(account, 'glm-4.7'), true);
    assert.equal(isModelAllowedForAccount(account, 'gemini-2.5-flash'), true);
    assert.equal(isModelAllowedForAccount(account, 'claude-opus-4.6'), false);
  });

  it('blocks pro-only models even on a Pro account when not_entitled', () => {
    const account = {
      tier: 'pro',
      userStatusLastFetched: Date.now(),
      capabilities: {
        'claude-opus-4.6': { ok: true, reason: 'user_status', lastCheck: 1 },
        'glm-4.7': { ok: false, reason: 'not_entitled', lastCheck: 1 },
      },
    };
    assert.equal(isModelAllowedForAccount(account, 'glm-4.7'), false);
  });

  it('respects blocklist regardless of upstream entitlement', () => {
    const account = {
      tier: 'free',
      blockedModels: ['glm-4.7'],
      userStatusLastFetched: Date.now(),
      capabilities: {
        'glm-4.7': { ok: true, reason: 'user_status', lastCheck: 1 },
      },
    };
    assert.equal(isModelAllowedForAccount(account, 'glm-4.7'), false);
  });

  it('falls back to tier list when GetUserStatus has not run', () => {
    const account = { tier: 'free', capabilities: {} };
    assert.equal(isModelAllowedForAccount(account, 'gemini-2.5-flash'), true);
    assert.equal(isModelAllowedForAccount(account, 'glm-4.7'), false);
  });

  it('falls back to tier list for capabilities filled by canary success', () => {
    const account = {
      tier: 'free',
      capabilities: {
        'gemini-2.5-flash': { ok: true, reason: 'success', lastCheck: 1 },
      },
    };
    assert.equal(isModelAllowedForAccount(account, 'gemini-2.5-flash'), true);
  });

  it('manual tier=pro override unlocks all models even with not_entitled caps', () => {
    // Operator escape hatch: probe misclassified a Pro trial as free,
    // GetUserStatus then wrote not_entitled into every premium model's
    // capability slot. Operator manually sets tier=pro; that should
    // restore Pro entitlement until GetUserStatus reruns and corrects
    // capabilities itself.
    const account = {
      tier: 'pro',
      tierManual: true,
      userStatusLastFetched: Date.now(),
      capabilities: {
        'claude-opus-4.6': { ok: false, reason: 'not_entitled', lastCheck: 1 },
        'glm-4.7': { ok: false, reason: 'not_entitled', lastCheck: 1 },
      },
    };
    assert.equal(isModelAllowedForAccount(account, 'claude-opus-4.6'), true);
    assert.equal(isModelAllowedForAccount(account, 'glm-4.7'), true);
  });

  it('every automatic tier writer is gated by tierManual (no clobber of #8 override)', () => {
    // isModelAllowedForAccount trusts account.tier under tierManual, so a
    // background writer that overwrites account.tier would silently defeat the
    // operator escape hatch. Pin that all automatic `account.tier = ...` writes
    // (refreshCredits planName inference, fetchUserStatus, probe restore,
    // updateCapability/inferTier) consult tierManual first.
    const AUTH = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
    // The only unconditional `account.tier =` writes allowed are the manual
    // setter (setAccountTier) itself. Count guarded vs total automatic writes.
    assert.match(AUTH, /if \(!account\.tierManual\) account\.tier = status\.tierName/,
      'fetchUserStatus must skip the tier write under tierManual');
    assert.match(AUTH, /if \(status && !account\.tierManual\) account\.tier = status\.tierName/,
      'probe tier restore must skip under tierManual');
    assert.match(AUTH, /if \(!account\.tierManual\) \{[\s\S]*?account\.tier = 'pro'/,
      'refreshCredits planName inference must be wrapped in a tierManual guard');
    assert.match(AUTH, /if \(!account\.tierManual && !account\.userStatusLastFetched\) \{\s*\n\s*account\.tier = inferTier/,
      'inferTier write must stay gated by tierManual');
  });
});

describe('getAvailableModelsForAccount — uses authoritative allowlist post-status', () => {
  it('returns only user_status-allowed enum-keyed models after GetUserStatus', () => {
    const account = {
      tier: 'free',
      userStatusLastFetched: Date.now(),
      capabilities: {
        'gemini-2.5-flash': { ok: true, reason: 'user_status', lastCheck: 1 },
        'glm-4.7': { ok: true, reason: 'user_status', lastCheck: 1 },
        'kimi-k2': { ok: true, reason: 'user_status', lastCheck: 1 },
        'swe-1.5': { ok: true, reason: 'user_status', lastCheck: 1 },
        'claude-opus-4.6': { ok: false, reason: 'not_entitled', lastCheck: 1 },
        'gpt-4.1-mini': { ok: false, reason: 'not_entitled', lastCheck: 1 },
      },
    };
    const got = getAvailableModelsForAccount(account);
    assert.ok(got.includes('gemini-2.5-flash'));
    assert.ok(got.includes('glm-4.7'));
    assert.ok(got.includes('kimi-k2'));
    assert.ok(got.includes('swe-1.5'));
    assert.ok(!got.includes('claude-opus-4.6'));
    assert.ok(!got.includes('gpt-4.1-mini'));
  });

  it('falls back to tier list before GetUserStatus runs', () => {
    const account = { tier: 'free' };
    const got = getAvailableModelsForAccount(account);
    assert.ok(got.includes('gemini-2.5-flash'));
    assert.ok(!got.includes('glm-4.7'));
  });
});

// #159 (audit C1-02). `updateCapability(..., true, 'success')` is the only
// writer for UID-only models (no enum, so GetUserStatus cannot classify them)
// and for models reached outside the cascade allowlist. Both gates used to
// ignore that reason: `availableModels` — which chat.js gates routing on —
// dropped the model, and the routing gate fell back to the static free table.
// Measured on the audited tree for a free account holding
// `glm-5.1: {ok:true, reason:'success'}`: available=false, allowed=false.
describe('#159 — a measured success is an available signal', () => {
  // A success is live evidence: it must be at least as new as the entitlement
  // snapshot it competes with (see the P2 block below). The fixture snapshot is
  // one minute old, the measurement is now.
  const successAccount = () => ({
    tier: 'free',
    userStatusLastFetched: Date.now() - 60_000,
    capabilities: { 'glm-5.1': { ok: true, reason: 'success', lastCheck: Date.now() } },
  });

  it('lists a success-reason model in availableModels', () => {
    assert.ok(getAvailableModelsForAccount(successAccount()).includes('glm-5.1'));
  });

  it('routes a success-reason model', () => {
    assert.equal(isModelAllowedForAccount(successAccount(), 'glm-5.1'), true);
  });

  it('lists a UID-only user_status model instead of only routing it', () => {
    // glm-5.1 is enumValue:0, so the post-status branch used to consult only
    // the tier table for it while isModelAllowedForAccount trusted the
    // capability — the list said no, routing said yes.
    const account = {
      tier: 'free',
      userStatusLastFetched: Date.now(),
      capabilities: { 'glm-5.1': { ok: true, reason: 'user_status', lastCheck: 1 } },
    };
    assert.equal(isModelAllowedForAccount(account, 'glm-5.1'), true);
    assert.ok(getAvailableModelsForAccount(account).includes('glm-5.1'));
  });

  it('keeps the list and the routing gate in agreement across capability reasons', () => {
    const account = {
      tier: 'free',
      userStatusLastFetched: Date.now() - 60_000,
      capabilities: {
        'gemini-2.5-flash': { ok: true, reason: 'user_status', lastCheck: 1 },
        'glm-4.7': { ok: true, reason: 'success', lastCheck: Date.now() },
        'kimi-k2': { ok: false, reason: 'not_entitled', lastCheck: 1 },
        'claude-opus-4.6': { ok: false, reason: 'user_status', lastCheck: 1 },
        'glm-5.1': { ok: true, reason: 'user_status', lastCheck: 1 },
        'kimi-k2-6': { ok: false, reason: 'model_error', lastCheck: 1 },
      },
    };
    const listed = new Set(getAvailableModelsForAccount(account));
    for (const key of Object.keys(account.capabilities)) {
      assert.equal(listed.has(key), isModelAllowedForAccount(account, key),
        `${key}: availableModels and isModelAllowedForAccount must agree`);
    }
  });

  it('does not let an authoritative negative leak in through the tier table', () => {
    // not_entitled must outrank the static tier list in both directions.
    const account = {
      tier: 'free',
      userStatusLastFetched: Date.now(),
      capabilities: {
        'gemini-2.5-flash': { ok: false, reason: 'not_entitled', lastCheck: 1 },
      },
    };
    assert.equal(isModelAllowedForAccount(account, 'gemini-2.5-flash'), false);
    assert.ok(!getAvailableModelsForAccount(account).includes('gemini-2.5-flash'));
  });
});

// P2 (wave-7 review): a measured success is live evidence, not a permanent
// grant. GetUserStatus reports the account's CURRENT plan and allowlist; a
// success recorded before that snapshot was measured under a possibly
// different entitlement (Pro/trial → free, paid → downgrade). Without a
// freshness boundary the old success outlived the downgrade indefinitely, so a
// free account kept listing and routing a premium model the upstream had
// already stopped entitling. The snapshot therefore bounds every success that
// predates it.
describe('P2 — a historical success cannot outrank a newer entitlement snapshot', () => {
  it('does not list or route a success older than the latest GetUserStatus snapshot', () => {
    // Exact shape reproduced by the review: fresh snapshot on a free account,
    // epoch-1 success for claude-opus-4.6 (UID-only, so GetUserStatus cannot
    // classify it directly).
    const account = {
      tier: 'free',
      userStatusLastFetched: Date.now(),
      capabilities: { 'claude-opus-4.6': { ok: true, reason: 'success', lastCheck: 1 } },
    };
    assert.equal(isModelAllowedForAccount(account, 'claude-opus-4.6'), false,
      'a pre-snapshot success must not admit a premium model on a free account');
    assert.ok(!getAvailableModelsForAccount(account).includes('claude-opus-4.6'),
      'nor may the stale success keep the model listed');
  });

  it('still lists and routes a success measured after the snapshot', () => {
    const snapshotAt = Date.now() - 60_000;
    const account = {
      tier: 'free',
      userStatusLastFetched: snapshotAt,
      capabilities: { 'glm-5.1': { ok: true, reason: 'success', lastCheck: snapshotAt + 1 } },
    };
    assert.equal(isModelAllowedForAccount(account, 'glm-5.1'), true);
    assert.ok(getAvailableModelsForAccount(account).includes('glm-5.1'));
  });

  it('trusts a success on an account that has never had a snapshot', () => {
    // Nothing newer exists to outrank the measurement; this is the pre-probe
    // account the #159 fix was written for.
    const account = {
      tier: 'free',
      capabilities: { 'glm-5.1': { ok: true, reason: 'success', lastCheck: 1 } },
    };
    assert.equal(isModelAllowedForAccount(account, 'glm-5.1'), true);
  });

  it('lets a refreshed not_entitled supersede an older success even on a Pro tier', () => {
    const account = {
      tier: 'pro',
      userStatusLastFetched: Date.now(),
      capabilities: { 'claude-opus-4.6': { ok: false, reason: 'not_entitled', lastCheck: Date.now() } },
    };
    assert.equal(isModelAllowedForAccount(account, 'claude-opus-4.6'), false,
      'the tier table must not resurrect a model the refreshed allowlist denied');
    assert.ok(!getAvailableModelsForAccount(account).includes('claude-opus-4.6'));
  });
});

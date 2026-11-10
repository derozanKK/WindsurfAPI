import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBillingHealth, deriveBillingState } from '../src/dashboard/billing-health.js';

const OK_SOURCES = {
  status: { ok: true, stale: false, fetchedAt: 1 },
  quota: { ok: true, stale: false, fetchedAt: 1 },
  suspended: { ok: true, stale: false, fetchedAt: 1 },
  unpaid: { ok: true, stale: false, fetchedAt: 1 },
  autorecharge: { ok: true, stale: false, fetchedAt: 1 },
  spending: { ok: true, stale: false, fetchedAt: 1 },
};

function base(over = {}) {
  return {
    status: {
      plan_slug: 'pro',
      is_subscription_valid: true,
      uses_quota: true,
      has_subscription_or_credits: true,
      has_failed_auto_recharge: false,
      billing_error: null,
      billing_method: 'stripe',
      is_enterprise: false,
      plan_uses_credits: true,
      show_consumption_dashboard: false,
      billing_waived_agent_versions: [],
    },
    quota: {
      is_quota_plan: true,
      has_quota_allocation: true,
      daily_percentage: 3,
      weekly_percentage: 1,
    },
    suspended: { sessions: [], can_restart_now: false },
    unpaid: { has_unpaid_invoices: false },
    autorecharge: { account_migrated_to_auto_recharge: true, auto_recharge_enabled: false },
    spending: { state: 'active' },
    sources: OK_SOURCES,
    ...over,
  };
}

describe('deriveBillingState', () => {
  it('maps each state exactly', () => {
    const cases = [
      ['ok', base()],
      ['quota_exhausted', base({ quota: { is_quota_plan: true, has_quota_allocation: true, daily_percentage: 100, weekly_percentage: 0 } })],
      ['paused', base({ suspended: { sessions: [{ id: 's1' }], can_restart_now: false } })],
      ['unpaid', base({ unpaid: { has_unpaid_invoices: true } })],
      ['recharge_failed', base({ status: { ...base().status, has_failed_auto_recharge: true } })],
      ['no_subscription', base({ status: { ...base().status, has_subscription_or_credits: false } })],
    ];
    for (const [expected, input] of cases) {
      assert.equal(deriveBillingState(input), expected, `state ${expected}`);
    }
  });

  it('applies the documented precedence', () => {
    const all = base({
      suspended: { sessions: [{ id: 's1' }], can_restart_now: false },
      unpaid: { has_unpaid_invoices: true },
      status: { ...base().status, has_failed_auto_recharge: true },
      quota: { is_quota_plan: true, has_quota_allocation: true, daily_percentage: 100, weekly_percentage: 100 },
    });
    assert.equal(deriveBillingState(all), 'paused');

    const unpaidPlusRecharge = base({
      unpaid: { has_unpaid_invoices: true },
      status: { ...base().status, has_failed_auto_recharge: true },
    });
    assert.equal(deriveBillingState(unpaidPlusRecharge), 'unpaid');

    const rechargePlusQuota = base({
      status: { ...base().status, has_failed_auto_recharge: true },
      quota: { is_quota_plan: true, has_quota_allocation: true, daily_percentage: 100, weekly_percentage: 0 },
    });
    assert.equal(deriveBillingState(rechargePlusQuota), 'recharge_failed');

    const quotaPlusNoSub = base({
      quota: { is_quota_plan: true, has_quota_allocation: true, daily_percentage: 100, weekly_percentage: 0 },
      status: { ...base().status, has_subscription_or_credits: false },
    });
    assert.equal(deriveBillingState(quotaPlusNoSub), 'quota_exhausted');
  });

  it('never reports quota_exhausted for a non-quota plan', () => {
    const creditsPlan = base({
      quota: { is_quota_plan: false, has_quota_allocation: true, daily_percentage: 100, weekly_percentage: 100 },
    });
    assert.equal(deriveBillingState(creditsPlan), 'ok');
  });

  it('reports unknown when a blocking source is unavailable and nothing blocks', () => {
    assert.equal(deriveBillingState(base({ sources: { ...OK_SOURCES, unpaid: { ok: false, error: 'forbidden' } } })), 'unknown');
    assert.equal(deriveBillingState(base({ sources: { ...OK_SOURCES, status: { ok: false, error: 'timeout' } } })), 'unknown');
  });

  it('does not require the quota source for a credits-only plan', () => {
    const creditsOnly = base({
      status: { ...base().status, uses_quota: false },
      sources: { ...OK_SOURCES, quota: { ok: false, error: 'forbidden' } },
    });
    assert.equal(deriveBillingState(creditsOnly), 'ok');
  });
});

describe('buildBillingHealth', () => {
  it('returns the ok banner with details and an informational auto-recharge warning', () => {
    const out = buildBillingHealth({ ...base(), accountId: 'acct-test', accountRef: 'acct-1a2b3c4d', now: 42 });
    assert.equal(out.ok, true);
    assert.equal(out.state, 'ok');
    assert.equal(out.severity, 'ok');
    assert.equal(out.bannerKey, 'billing.banner.ok');
    assert.deepEqual(out.warnings, ['auto_recharge_disabled']);
    assert.equal(out.details.plan, 'pro');
    assert.equal(out.details.availableCredits, undefined, 'credits are not part of the health card');
    assert.equal(out.details.suspendedSessionCount, 0);
    assert.equal(out.details.spendingState, 'active');
    assert.deepEqual(out.details.autoRecharge, {
      migrated: true, enabled: false, threshold: null, amount: null, maxMonthlyTotalSpend: null,
    });
    assert.equal(out.details.waivedAgentVersionsCount, 0);
    assert.equal(out.fetchedAt, 42);
  });

  it('maps each state to its severity and banner key', () => {
    const expected = {
      ok: ['ok', 'billing.banner.ok'],
      quota_exhausted: ['warn', 'billing.banner.quotaExhausted'],
      paused: ['error', 'billing.banner.paused'],
      unpaid: ['error', 'billing.banner.unpaid'],
      recharge_failed: ['error', 'billing.banner.rechargeFailed'],
      no_subscription: ['muted', 'billing.banner.noSubscription'],
      unknown: ['muted', 'billing.banner.unknown'],
    };
    const inputs = {
      ok: base(),
      quota_exhausted: base({ quota: { is_quota_plan: true, has_quota_allocation: true, daily_percentage: 100, weekly_percentage: 0 } }),
      paused: base({ suspended: { sessions: [{ id: 's1' }], can_restart_now: false } }),
      unpaid: base({ unpaid: { has_unpaid_invoices: true } }),
      recharge_failed: base({ status: { ...base().status, has_failed_auto_recharge: true } }),
      no_subscription: base({ status: { ...base().status, has_subscription_or_credits: false } }),
      unknown: base({ sources: { ...OK_SOURCES, unpaid: { ok: false, error: 'forbidden' } } }),
    };
    for (const [state, input] of Object.entries(inputs)) {
      const out = buildBillingHealth(input);
      assert.equal(out.state, state);
      assert.equal(out.severity, expected[state][0], `severity ${state}`);
      assert.equal(out.bannerKey, expected[state][1], `banner ${state}`);
    }
  });

  it('keeps billing_error out of the state and redacts its text', () => {
    const out = buildBillingHealth(base({
      status: {
        ...base().status,
        billing_error: 'contact org-test123 / user-test456 / user@example.test auth1_abcdefgh',
      },
    }));
    assert.equal(out.state, 'ok');
    assert.ok(out.warnings.includes('billing_error'));
    const text = out.details.billingError;
    for (const secret of ['org-test123', 'user-test456', 'user@example.test', 'auth1_abcdefgh']) {
      assert.equal(text.includes(secret), false, `must redact ${secret}`);
    }
    assert.ok(text.length <= 200);
  });

  it('marks restartable suspended sessions as a warning, not a pause', () => {
    const out = buildBillingHealth(base({ suspended: { sessions: [{ id: 's1' }, { id: 's2' }], can_restart_now: true } }));
    assert.equal(out.state, 'ok');
    assert.ok(out.warnings.includes('sessions_restartable'));
  });

  it('never serializes session ids or titles', () => {
    const out = buildBillingHealth(base({
      suspended: { sessions: [{ id: 'session-secret-id', title: 'private title' }], can_restart_now: false },
    }));
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('session-secret-id'), false);
    assert.equal(serialized.includes('private title'), false);
    assert.equal(out.details.suspendedSessionCount, 1);
  });

  it('reports partial and stale overlays without inventing a blocking state', () => {
    const out = buildBillingHealth(base({
      sources: {
        ...OK_SOURCES,
        status: { ok: true, stale: true, fetchedAt: 1 },
        unpaid: { ok: false, error: 'timeout' },
      },
    }));
    assert.equal(out.partial, true);
    assert.equal(out.stale, true);
    assert.equal(out.state, 'unknown');
  });
});

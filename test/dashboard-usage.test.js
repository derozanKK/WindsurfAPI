import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPercent,
  formatAcuLimit,
  normalizeUsage,
  resetCountdown,
} from '../src/dashboard/usage.js';

describe('dashboard usage normalizer', () => {
  it('maps quota, plan, cycle and daily rows', () => {
    const out = normalizeUsage({
      quota: {
        is_quota_plan: true,
        has_quota_allocation: true,
        daily_percentage: 3,
        weekly_percentage: 1,
        daily_reset_at: '2026-10-18T00:00:00-08:00',
        weekly_reset_at: '2026-10-18T00:00:00-08:00',
        overage_balance: 0,
        hide_daily_quota: false,
      },
      status: {
        plan_slug: 'pro',
        is_subscription_valid: true,
        billing_method: 'stripe',
        available_credits: 0,
        overage_credits: 0,
      },
      dailyUsage: {
        cycle_start: '2026-10-16T20:11:50+00:00',
        cycle_end: '2026-11-16T20:11:50+00:00',
        previous_cycle_available: false,
        total: 0,
        days: [
          { date: '2026-10-16', amount: 0, cumulative: 0 },
          { date: '2026-10-17', amount: 1.5, cumulative: 1.5 },
        ],
      },
    });
    assert.equal(out.plan, 'pro');
    assert.equal(out.billingValid, true);
    assert.equal(out.quota.dailyPercentage, 3);
    assert.equal(out.quota.weeklyPercentage, 1);
    assert.equal(out.cycle.total, 0);
    assert.deepEqual(out.days, [
      { date: '2026-10-16', amount: 0, cumulative: 0 },
      { date: '2026-10-17', amount: 1.5, cumulative: 1.5 },
    ]);
  });

  it('degrades malformed/missing fields to null instead of NaN', () => {
    const out = normalizeUsage({
      quota: { daily_percentage: '3', overage_balance: NaN },
      status: null,
      dailyUsage: { days: [{ amount: 'x' }, null, { date: '2026-10-18', amount: 2 }] },
    });
    assert.equal(out.plan, null);
    assert.equal(out.availableCredits, null);
    assert.equal(out.cycle.total, null);
    assert.equal(out.quota.dailyPercentage, null);
    assert.equal(out.quota.overageBalance, null);
    assert.deepEqual(out.days, [{ date: '2026-10-18', amount: 2, cumulative: null }]);
  });

  it('passes a signed overage balance through instead of clamping it', () => {
    // `overage_credits` is a USD balance: negative means overdrawn. Clamping it
    // to zero here would make the panel assert a zero balance the upstream
    // never reported; the renderer owns the sign/overdrawn presentation.
    assert.equal(normalizeUsage({ status: { overage_credits: -0.1 } }).overageCredits, -0.1);
    assert.equal(normalizeUsage({ status: { overage_credits: 12.34 } }).overageCredits, 12.34);
    assert.equal(normalizeUsage({ status: { overage_credits: 0 } }).overageCredits, 0);
    assert.equal(normalizeUsage({ status: { overage_credits: '-0.1' } }).overageCredits, null);
  });

  it('caps daily rows at 366', () => {
    const days = Array.from({ length: 400 }, (_, i) => ({ date: `d${i}`, amount: 1, cumulative: 1 }));
    const out = normalizeUsage({ dailyUsage: { days } });
    assert.equal(out.days.length, 366);
  });

  it('maps ACU limits and product burn-down rows', () => {
    const products = Array.from({ length: 9 }, (_, i) => ({
      view: `product-${i}`,
      total: i,
      days: [{ date: '2026-10-16', amount: i, cumulative: i }],
    }));
    const out = normalizeUsage({
      quota: { daily_percentage: 150, weekly_percentage: -1 },
      limits: { max_acu_limit: 20, max_total_session_acu_limit: null },
      dailyUsage: { total: 36, products },
      now: 1000,
    });
    assert.equal(out.limits.maxAcuLimit, 20);
    assert.equal(out.limits.maxTotalSessionAcuLimit, null);
    assert.equal(out.quota.dailyPercentage, 100, 'percentages clamp to 100');
    assert.equal(out.quota.weeklyPercentage, 0, 'percentages clamp to 0');
    assert.equal(out.products.length, 9);
    assert.deepEqual(out.products[2], {
      view: 'product-2',
      total: 2,
      days: [{ date: '2026-10-16', amount: 2, cumulative: 2 }],
    });
    assert.equal(out.serverNow, 1000);
  });

  it('caps products at 12 and each product day list at 366', () => {
    const days = Array.from({ length: 400 }, (_, i) => ({ date: `d${i}`, amount: 1, cumulative: 1 }));
    const products = Array.from({ length: 13 }, (_, i) => ({ view: `v${i}`, total: 1, days }));
    const out = normalizeUsage({ dailyUsage: { products } });
    assert.equal(out.products.length, 12);
    assert.equal(out.products[0].days.length, 366);
  });

  it('derives reset countdowns from the server clock and preserves offsets', () => {
    const now = Date.parse('2026-10-17T23:00:00-08:00');
    assert.equal(resetCountdown('2026-10-18T00:00:00-08:00', now), 3_600_000);
    assert.equal(resetCountdown('2026-10-17T22:00:00-08:00', now), 0, 'past resets clamp to zero');
    assert.equal(resetCountdown('not-a-date', now), null);
    assert.equal(resetCountdown(null, now), null);

    const out = normalizeUsage({
      quota: {
        daily_reset_at: '2026-10-18T00:00:00-08:00',
        weekly_reset_at: '2026-10-17T22:00:00-08:00',
      },
      now,
    });
    assert.deepEqual(out.reset, { dailyInMs: 3_600_000, weeklyInMs: 0 });
  });
});

describe('quota burn-down helpers', () => {
  it('clamps percentages without coercing strings', () => {
    assert.equal(clampPercent(150), 100);
    assert.equal(clampPercent(-1), 0);
    assert.equal(clampPercent(0), 0);
    assert.equal(clampPercent(3.5), 3.5);
    assert.equal(clampPercent(null), null);
    assert.equal(clampPercent('3'), null);
    assert.equal(clampPercent(NaN), null);
  });

  it('renders ACU limits, keeping null as unlimited rather than zero', () => {
    assert.equal(formatAcuLimit(null), '∞');
    assert.equal(formatAcuLimit(20), '20');
    assert.equal(formatAcuLimit(0), '0');
    assert.equal(formatAcuLimit('20'), null);
  });
});

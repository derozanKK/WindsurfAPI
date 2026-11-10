/**
 * P0-2 billing health — pure state machine + aggregate reader.
 *
 * The state is derived from six independent billing reads; one failed secondary
 * source must not blank the banner. `billing_error` is free text and therefore a
 * warning, never a state. A 403 is "no permission" (gray), never a stale state
 * and never zeros.
 */

import {
  TTL_MS,
  cacheKey,
  httpStatusForKind,
  readCached,
  readDevinJson,
  redactUpstreamText,
  resolveAccount,
  resolveOrgId,
  sourceSummary,
  worstError,
  ReadError,
} from './devin-read.js';

export const BILLING_BANNERS = {
  ok: { severity: 'ok', bannerKey: 'billing.banner.ok' },
  quota_exhausted: { severity: 'warn', bannerKey: 'billing.banner.quotaExhausted' },
  paused: { severity: 'error', bannerKey: 'billing.banner.paused' },
  unpaid: { severity: 'error', bannerKey: 'billing.banner.unpaid' },
  recharge_failed: { severity: 'error', bannerKey: 'billing.banner.rechargeFailed' },
  no_subscription: { severity: 'muted', bannerKey: 'billing.banner.noSubscription' },
  unknown: { severity: 'muted', bannerKey: 'billing.banner.unknown' },
};

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' ? value : {};
}

/**
 * Exact precedence:
 *   paused > unpaid > recharge_failed > quota_exhausted > no_subscription > ok
 * `unknown` only when a blocking source is unavailable and no blocking state is
 * known. `billing_error` never changes the state.
 */
export function deriveBillingState({ status, quota, suspended, unpaid, sources = {} } = {}) {
  const s = objectOrEmpty(status);
  const q = objectOrEmpty(quota);
  const sus = objectOrEmpty(suspended);
  const up = objectOrEmpty(unpaid);

  const sessionCount = Array.isArray(sus.sessions) ? sus.sessions.length : null;
  const canRestartNow = bool(sus.can_restart_now);

  if (sessionCount !== null && sessionCount > 0 && canRestartNow === false) return 'paused';
  if (up.has_unpaid_invoices === true) return 'unpaid';
  if (s.has_failed_auto_recharge === true) return 'recharge_failed';
  if (q.is_quota_plan === true && q.has_quota_allocation === true) {
    const daily = num(q.daily_percentage);
    const weekly = num(q.weekly_percentage);
    if ((daily !== null && daily >= 100) || (weekly !== null && weekly >= 100)) return 'quota_exhausted';
  }
  if (s.has_subscription_or_credits === false || s.is_subscription_valid === false) return 'no_subscription';

  const unavailable = (name) => sources?.[name]?.ok === false;
  const blocking = ['status', 'suspended', 'unpaid'];
  // A credits-only plan does not need quota/usage to decide ok/unknown.
  if (s.uses_quota !== false) blocking.push('quota');
  if (blocking.some(unavailable)) return 'unknown';

  return 'ok';
}

export function buildBillingHealth({
  accountId = null,
  accountRef = null,
  status,
  quota,
  suspended,
  unpaid,
  autorecharge,
  spending,
  sources = {},
  now = Date.now(),
} = {}) {
  const state = deriveBillingState({ status, quota, suspended, unpaid, sources });
  const banner = BILLING_BANNERS[state] || BILLING_BANNERS.unknown;

  const s = objectOrEmpty(status);
  const sus = objectOrEmpty(suspended);
  const up = objectOrEmpty(unpaid);
  const auto = objectOrEmpty(autorecharge);
  const spend = objectOrEmpty(spending);

  const sessionCount = Array.isArray(sus.sessions) ? sus.sessions.length : null;
  const canRestartNow = bool(sus.can_restart_now);
  const billingError = typeof s.billing_error === 'string' && s.billing_error
    ? redactUpstreamText(s.billing_error)
    : null;
  const waived = Array.isArray(s.billing_waived_agent_versions)
    ? s.billing_waived_agent_versions.length
    : null;

  const warnings = [];
  if (billingError) warnings.push('billing_error');
  if (sessionCount !== null && sessionCount > 0 && canRestartNow === true) warnings.push('sessions_restartable');
  if (auto.account_migrated_to_auto_recharge === true && auto.auto_recharge_enabled === false) {
    warnings.push('auto_recharge_disabled');
  }

  const summaries = Object.values(sources || {});
  return {
    ok: true,
    accountId,
    accountRef,
    fetchedAt: now,
    stale: summaries.some((source) => source?.stale === true),
    partial: summaries.some((source) => source?.ok === false),
    state,
    severity: banner.severity,
    bannerKey: banner.bannerKey,
    details: {
      plan: typeof s.plan_slug === 'string' ? s.plan_slug : null,
      billingValid: bool(s.is_subscription_valid),
      billingMethod: typeof s.billing_method === 'string' ? s.billing_method : null,
      isEnterprise: bool(s.is_enterprise),
      usesQuota: bool(s.uses_quota),
      planUsesCredits: bool(s.plan_uses_credits),
      showConsumptionDashboard: bool(s.show_consumption_dashboard),
      hasSubscriptionOrCredits: bool(s.has_subscription_or_credits),
      billingError,
      hasFailedAutoRecharge: bool(s.has_failed_auto_recharge),
      hasUnpaidInvoices: bool(up.has_unpaid_invoices),
      suspendedSessionCount: sessionCount,
      canRestartNow,
      spendingState: typeof spend.state === 'string' ? spend.state : null,
      autoRecharge: {
        migrated: bool(auto.account_migrated_to_auto_recharge),
        enabled: bool(auto.auto_recharge_enabled),
        threshold: num(auto.threshold),
        amount: num(auto.amount),
        maxMonthlyTotalSpend: num(auto.max_monthly_total_spend),
      },
      waivedAgentVersionsCount: waived,
    },
    warnings,
    sources,
  };
}

export async function readBillingHealth({ id, force = false, fetchImpl = null, now = Date.now() } = {}) {
  const account = resolveAccount(id);
  if (!account.ok) return { ok: false, error: account.error, httpStatus: account.status };

  let orgId;
  try {
    orgId = await resolveOrgId({ token: account.token, fetchImpl, force });
  } catch (err) {
    const kind = err instanceof ReadError ? err.kind : 'upstream';
    return {
      ok: false,
      accountId: account.accountId,
      accountRef: account.accountRef,
      error: kind,
      httpStatus: err?.status || httpStatusForKind(kind),
    };
  }

  const read = (name, path, ttl, orgScoped = true) => readCached(
    cacheKey({ accountId: account.accountId, token: account.token, name }),
    ttl,
    () => readDevinJson({
      token: account.token,
      orgId: orgScoped ? orgId : '',
      path,
      fetchImpl,
    }),
    { force },
  );

  const [status, quota, spending, suspended, unpaid, autorecharge] = await Promise.all([
    read('status', `/${orgId}/billing/status`, TTL_MS.status),
    read('quota', `/${orgId}/billing/quota/usage`, TTL_MS.quota),
    read('spending', '/users/spending-state', TTL_MS.spending, false),
    read('suspended', `/${orgId}/limit-suspended-sessions`, TTL_MS.suspended),
    read('unpaid', '/billing/subscription/unpaid-invoices', TTL_MS.unpaid, false),
    read('autorecharge', `/${orgId}/billing/auto-recharge/params`, TTL_MS.autorecharge),
  ]);

  const results = { status, quota, spending, suspended, unpaid, autorecharge };
  const sources = Object.fromEntries(
    Object.entries(results).map(([name, result]) => [name, sourceSummary(result)]),
  );

  // A 403 on billing/status is "no permission": no state, no stale fallback.
  if (status.error === 'forbidden') {
    return {
      ok: false,
      accountId: account.accountId,
      accountRef: account.accountRef,
      error: 'forbidden',
      httpStatus: 403,
      sources,
    };
  }

  if (Object.values(results).every((result) => !result.ok)) {
    const kind = worstError(Object.values(results).map((result) => result.error));
    return {
      ok: false,
      accountId: account.accountId,
      accountRef: account.accountRef,
      error: kind,
      httpStatus: httpStatusForKind(kind),
      sources,
    };
  }

  return buildBillingHealth({
    accountId: account.accountId,
    accountRef: account.accountRef,
    status: status.value,
    quota: quota.value,
    suspended: suspended.value,
    unpaid: unpaid.value,
    autorecharge: autorecharge.value,
    spending: spending.value,
    sources,
    now,
  });
}

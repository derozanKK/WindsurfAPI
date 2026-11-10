/**
 * P0-1 quota burn-down aggregate reader.
 *
 * Four GET-only billing sources are read through the shared cache
 * (`quota`, `status`, `limits`, `daily`) and normalized into the card payload.
 * `status` and `quota` use the same cache keys as the billing-health card, so a
 * cold dashboard open fetches each upstream document once.
 */

import {
  TTL_MS,
  cacheKey,
  httpStatusForKind,
  readCached,
  readDevinJson,
  resolveAccount,
  resolveOrgId,
  sourceSummary,
  worstError,
  ReadError,
} from './devin-read.js';
import { normalizeUsage } from './usage.js';

export async function readQuotaBurnDown({
  id,
  // Org-scoped aggregators already resolved the org and hold the exact token
  // that must be used (e.g. a synthetic env-token candidate). Passing both
  // avoids a second membership read and keeps the cache key on that account.
  account: providedAccount = null,
  orgId: providedOrgId = '',
  force = false,
  fetchImpl = null,
  now = Date.now(),
} = {}) {
  const account = providedAccount || resolveAccount(id);
  if (!account.ok) return { ok: false, error: account.error, httpStatus: account.status };

  let orgId = providedOrgId;
  try {
    if (!orgId) orgId = await resolveOrgId({ token: account.token, fetchImpl, force });
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

  const read = (name, path, ttl) => readCached(
    cacheKey({ accountId: account.accountId, token: account.token, name }),
    ttl,
    () => readDevinJson({ token: account.token, orgId, path, fetchImpl }),
    { force },
  );

  const [quota, status, limits, daily] = await Promise.all([
    read('quota', `/${orgId}/billing/quota/usage`, TTL_MS.quota),
    read('status', `/${orgId}/billing/status`, TTL_MS.status),
    read('limits', `/${orgId}/billing/usage/limits`, TTL_MS.limits),
    read('daily-all', `/${orgId}/billing/usage/daily-usage?cycle=current&view=all`, TTL_MS.daily),
  ]);

  const results = { quota, status, limits, daily };
  const sources = Object.fromEntries(
    Object.entries(results).map(([name, result]) => [name, sourceSummary(result)]),
  );
  const failures = Object.values(results).filter((result) => !result.ok);

  if (failures.length === Object.keys(results).length) {
    const kind = worstError(failures.map((result) => result.error));
    return {
      ok: false,
      accountId: account.accountId,
      accountRef: account.accountRef,
      error: kind,
      httpStatus: httpStatusForKind(kind),
      sources,
    };
  }

  const value = normalizeUsage({
    quota: quota.value,
    status: status.value,
    limits: limits.value,
    dailyUsage: daily.value,
    now,
  });

  return {
    ok: true,
    accountId: account.accountId,
    accountRef: account.accountRef,
    cached: Object.values(results).every((result) => result.ok && result.cached && !result.stale),
    stale: Object.values(results).some((result) => result.stale),
    partial: failures.length > 0,
    ...value,
    sources,
  };
}

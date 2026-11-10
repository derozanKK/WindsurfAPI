/**
 * DevinMap cards — the four account-scoped cards that sit on the dashboard's
 * account drawer:
 *
 *   1. ACU / credit ledger     — lifetime spend + balance + observed debits
 *   2. Model entitlement       — available / blocked / not-entitled / unknown
 *   3. API key & rotation      — masked key, created, rotated, expiry state
 *   4. Capacity preflight      — selector + upstream capacity before a run
 *
 * Every builder is PURE and takes plain data, so the card payload can be
 * asserted without a server. The readers are thin: they select one account by
 * id, hand the stored account state to the builder, and (for the preflight
 * only) make ONE upstream call that is cached for a minute.
 *
 * Two honesty rules drive the shapes below, both from #239 / DevinMap:
 *
 *   - The chat wire carries no per-turn billing tag. `acuCost` is decoded only
 *     when DEVIN_CONNECT_BILLING_TAGS names its coordinate, so an absent ACU is
 *     `{known:false, reason:'no_billing_tag'}` — never a settled-looking 0.
 *   - "Not observable" is its own state on every card (ACU, key expiry,
 *     unprobed entitlement, unknown upstream capacity). Zeros are only ever
 *     reported for counters the proxy actually owns.
 *
 * No raw credential is read by a builder: the key card takes an already-masked
 * value, and the preflight never echoes the account's key.
 */

import {
  getAccountInternal,
  getCreditLedger,
  getRpmStats,
  getAccountAvailability,
  maskApiKey,
  isModelAllowedForAccount,
  isConnectSelectorAllowedForAccount,
  isAllTemporarilyUnavailable,
  isConnectSelectorCurrentlyFree,
  hasConnectEntitledAccount,
  getConnectPricingMap,
} from '../auth.js';
import { MODELS, getTierModels } from '../models.js';
import {
  getLiveCatalog,
  hasLiveCatalog,
  resolveConnectSelector,
} from '../devin-connect-models.js';
import { checkMessageRateLimit } from '../windsurf-api.js';
import { accountRef as accountRefOf } from '../log-safety.js';
import { getEffectiveProxy } from './proxy-config.js';
import { cacheKey } from './devin-read.js';

/** Upstream capacity answers are cached for one minute (DevinMap §6.4). */
export const PREFLIGHT_TTL_MS = 60_000;

/** Why an ACU figure is absent. Not an error: the coordinate is opt-in. */
export const ACU_REASON_NO_BILLING_TAG = 'no_billing_tag';

/** Why a key expiry is absent. Session keys carry no expiry field on the wire. */
export const KEY_EXPIRY_REASON = 'not_observable';

export const MODEL_STATUS_VALUES = Object.freeze(['available', 'blocked', 'not_entitled', 'unknown']);

/** Local preflight states, most severe first. */
export const LOCAL_STATE_VALUES = Object.freeze([
  'disabled',
  'error',
  'quota_cooled',
  'rate_limited',
  'model_limited',
  'rpm_exhausted',
  'tier_expired',
  'not_entitled',
  'ok',
]);

const DEBIT_ROW_CAP = 8;
const ATTENTION_ROW_CAP = 12;
const HISTORY_ROW_CAP = 40;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value, max = 120) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** `cur - prev`, or null when either side is not a finite number. */
function delta(cur, prev) {
  const a = num(cur);
  const b = num(prev);
  if (a == null || b == null) return null;
  return Math.round((a - b) * 1e6) / 1e6;
}

// ─── 1. ACU / credit ledger ────────────────────────────────────────────────

/**
 * Build the ACU ledger payload.
 *
 * @param {object} opts
 * @param {string|null} [opts.accountRef] hashed account reference
 * @param {object|null} [opts.totalSpend] lifetime accumulator from the account
 * @param {object|null} [opts.credits] last credit snapshot (`refreshCredits`)
 * @param {Array} [opts.history] raw credit snapshots, oldest first
 * @param {number} [opts.now]
 */
export function buildAcuLedger({
  accountRef = null,
  totalSpend = null,
  credits = null,
  history = [],
  now = Date.now(),
} = {}) {
  const spend = obj(totalSpend) || {};
  const cr = obj(credits) || {};

  const acuValue = num(spend.acuCost);
  const acuKnown = acuValue != null && acuValue > 0;

  const snapshots = (Array.isArray(history) ? history : [])
    .filter((row) => obj(row) && num(row.ts) != null)
    .map((row) => ({
      ts: num(row.ts),
      balance: num(row.balance),
      overageBalance: num(row.overageBalance),
      promptRemaining: num(row.promptRemaining),
      promptUsed: num(row.promptUsed),
      flexRemaining: num(row.flexRemaining),
      flexUsed: num(row.flexUsed),
      dailyPercent: num(row.dailyPercent),
      weeklyPercent: num(row.weeklyPercent),
    }))
    .sort((a, b) => a.ts - b.ts)
    .slice(-HISTORY_ROW_CAP);

  const debits = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    const balanceUsd = delta(cur.balance, prev.balance);
    const promptCredits = delta(cur.promptRemaining, prev.promptRemaining);
    const flexCredits = delta(cur.flexRemaining, prev.flexRemaining);
    const dailyPercent = delta(cur.dailyPercent, prev.dailyPercent);
    const weeklyPercent = delta(cur.weeklyPercent, prev.weeklyPercent);
    const quotaDebit = (promptCredits != null && promptCredits < 0)
      || (flexCredits != null && flexCredits < 0)
      || (dailyPercent != null && dailyPercent < 0)
      || (weeklyPercent != null && weeklyPercent < 0);
    const balanceDebit = balanceUsd != null && balanceUsd < 0;
    const kind = quotaDebit && balanceDebit ? 'mixed' : balanceDebit ? 'balance' : quotaDebit ? 'quota' : 'none';
    if (kind === 'none') continue;
    debits.push({
      ts: cur.ts,
      kind,
      delta: { balanceUsd, promptCredits, flexCredits, dailyPercent, weeklyPercent },
      after: {
        balance: cur.balance,
        promptRemaining: cur.promptRemaining,
        flexRemaining: cur.flexRemaining,
        dailyPercent: cur.dailyPercent,
        weeklyPercent: cur.weeklyPercent,
      },
    });
  }
  debits.reverse(); // newest first

  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const prompt = obj(cr.prompt) || {};
  const flex = obj(cr.flex) || {};
  const balanceUsd = num(cr.balance);

  return {
    accountRef,
    fetchedAt: now,
    acu: {
      value: acuKnown ? acuValue : null,
      known: acuKnown,
      reason: acuKnown ? null : ACU_REASON_NO_BILLING_TAG,
    },
    lifetime: {
      requests: num(spend.requests) ?? 0,
      totalTokens: num(spend.totalTokens) ?? 0,
      creditCost: num(spend.creditCost) ?? 0,
    },
    balance: {
      usd: balanceUsd,
      overageUsd: num(cr.overageBalance),
      known: balanceUsd != null,
    },
    cycle: {
      planName: str(cr.planName),
      dailyPercent: num(cr.dailyPercent),
      weeklyPercent: num(cr.weeklyPercent),
      dailyResetAt: num(cr.dailyResetAt),
      weeklyResetAt: num(cr.weeklyResetAt),
      prompt: {
        limit: num(prompt.limit),
        used: num(prompt.used),
        remaining: num(prompt.remaining),
      },
      flex: {
        limit: num(flex.limit),
        used: num(flex.used),
        remaining: num(flex.remaining),
      },
      fetchedAt: num(cr.fetchedAt),
      lastError: str(cr.lastError, 160),
    },
    debits: debits.slice(0, DEBIT_ROW_CAP),
    debitCount: debits.length,
    snapshotCount: snapshots.length,
    latestSnapshotAt: latest ? latest.ts : null,
  };
}

// ─── 2. Model entitlement ──────────────────────────────────────────────────

function entitlementOf(key, cap, blocked) {
  if (blocked.has(key)) return 'blocked';
  if (cap) {
    // GetUserStatus writes both arms: `user_status` (allowed) and `not_entitled`
    // (denied). A denied capability is upstream truth, not a transient failure.
    if (cap.reason === 'not_entitled') return 'not_entitled';
    if (cap.ok === false && cap.reason === 'user_status') return 'not_entitled';
    if (cap.ok === true) return 'available';
  }
  return 'unknown';
}

/**
 * Selectors the model-status card can price.
 *
 * Every MODELS row it renders, resolved the same display-only way buildModelStatus
 * resolves it, plus whatever the account's own rate table names (a selector can be
 * priced without having a MODELS row).
 */
function modelStatusSelectors(rateTable = null) {
  const out = new Set();
  for (const key of Object.keys(MODELS)) {
    const resolution = resolveConnectSelector(key, { warnOnFallback: false, allowSnapshotFallback: true });
    if (resolution?.mapped) out.add(resolution.selector);
  }
  for (const selector of Object.keys(obj(rateTable) || {})) out.add(selector);
  return [...out];
}

/**
 * Build the per-account model entitlement matrix.
 *
 * Sources, all account-local (no network):
 *   - `capabilities`        — last GetUserStatus allowlist / canary probes
 *   - `tierModels`          — the local tier table (labelled `tierListed`)
 *   - `blockedModels`       — operator blocklist (always wins)
 *   - `credits.rateTable`   — selector → credit multiplier, when paired
 *   - `pricing`             — live free/promo verdicts, when the caller has them
 *
 * `unknown` is the honest state for a model that was never probed; it is never
 * folded into `available`.
 */
export function buildModelStatus({
  accountRef = null,
  tier = 'unknown',
  tierManual = false,
  tierModels = [],
  blockedModels = [],
  capabilities = null,
  rateTable = null,
  pricing = null,
  userStatus = null,
  userStatusLastFetched = 0,
  now = Date.now(),
} = {}) {
  const blocked = new Set((Array.isArray(blockedModels) ? blockedModels : []).filter((k) => typeof k === 'string' && k));
  const caps = obj(capabilities) || {};
  const table = obj(rateTable);
  // selector → live pricing (auth.getConnectPricingMap). Optional so the builder
  // stays pure and a test can assert the rate-table-only path; when present it
  // is the authority, because a promo can be free with no zero in the table.
  const live = obj(pricing) || {};
  const tierList = new Set((Array.isArray(tierModels) ? tierModels : []).filter((k) => typeof k === 'string' && k));
  const us = obj(userStatus) || {};

  const keys = new Set([
    ...Object.keys(MODELS),
    ...Object.keys(caps),
    ...blocked,
  ]);

  const rows = [];
  for (const key of keys) {
    const info = MODELS[key] || null;
    const cap = obj(caps[key]);
    if (!info && !cap && !blocked.has(key)) continue;
    // Display-only resolution: the committed snapshot is a legitimate fallback
    // for ATTRIBUTING a rate-table entry on a cold start. It is never used to
    // route a request — the chat path keeps its live-catalog-only resolver.
    const resolution = info
      ? resolveConnectSelector(key, { warnOnFallback: false, allowSnapshotFallback: true })
      : null;
    const selector = resolution && resolution.mapped ? resolution.selector : null;
    const creditNow = table && selector && num(table[selector]) != null ? num(table[selector]) : null;
    const priced = selector ? obj(live[selector]) : null;
    // `freeNow` stays boolean here (the card's counts and the chip copy read it
    // that way): a strict zero in the account's own table OR the live sync's own
    // free verdict. `pricingKnown` carries the tri-state separately, so an
    // unpriced model is not silently promoted to "paid" in the reason fields.
    const freeNow = priced?.freeNow === true || creditNow === 0;
    rows.push({
      id: key,
      provider: str(info?.provider, 32) || 'other',
      status: entitlementOf(key, cap, blocked),
      tierListed: tierList.has(key),
      selector,
      creditNow,
      freeNow,
      freeReason: priced?.freeReason || null,
      promoEndsAt: priced?.promoEndsAt || null,
      promoLabel: priced?.promoLabel || null,
      pricingKnown: priced ? priced.freeNow !== null : null,
      pricingStale: priced ? priced.pricingStale === true : false,
      reason: str(cap?.reason, 32),
      probedAt: num(cap?.lastCheck),
    });
  }

  const order = { blocked: 0, not_entitled: 1, unknown: 2, available: 3 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || a.id.localeCompare(b.id));

  const count = (status) => rows.filter((row) => row.status === status).length;
  const attention = rows.filter((row) => row.status !== 'available').slice(0, ATTENTION_ROW_CAP);

  return {
    accountRef,
    fetchedAt: now,
    tier: str(tier, 32) || 'unknown',
    tierManual: !!tierManual,
    entitlementFetchedAt: num(userStatusLastFetched) || 0,
    allowedModelCount: Array.isArray(us.allowedModels) ? us.allowedModels.length : null,
    planName: str(us.planName, 64),
    counts: {
      total: rows.length,
      available: count('available'),
      blocked: count('blocked'),
      notEntitled: count('not_entitled'),
      unknown: count('unknown'),
      freeNow: rows.filter((row) => row.freeNow).length,
      tierListed: rows.filter((row) => row.tierListed).length,
    },
    attention,
    rows,
    source: {
      kind: 'capabilities',
      probed: num(userStatusLastFetched) > 0 || Object.keys(caps).length > 0,
      rateTable: !!table,
    },
  };
}

// ─── 3. API key & rotation ─────────────────────────────────────────────────

/**
 * Build the key card. The caller passes `apiKeyMasked`; this builder never sees
 * the raw key and the payload has no field that could carry one.
 */
export function buildKeyInfo({
  accountRef = null,
  apiKeyMasked = null,
  createdAt = null,
  rotatedAt = null,
  lastProbed = null,
  entitlementFetchedAt = null,
  hasRefreshToken = false,
  method = null,
  state = 'ok',
  reauth = null,
  now = Date.now(),
} = {}) {
  const created = num(createdAt);
  const rotated = num(rotatedAt);
  const reauthRequired = state === 'reauth';
  return {
    accountRef,
    fetchedAt: now,
    masked: str(apiKeyMasked, 64),
    createdAt: created,
    rotatedAt: rotated && rotated > 0 ? rotated : null,
    expires: {
      known: false,
      at: null,
      reason: KEY_EXPIRY_REASON,
    },
    // SessionReauth: whether upstream still accepts the token. This is NOT an
    // expiry — a session token has no readable lifetime — so `expires` stays
    // exactly as it was and this block answers the only question the operator
    // can act on: does this key work, and if not, when was that confirmed?
    state: reauthRequired ? 'reauth' : (state === 'unknown' ? 'unknown' : 'ok'),
    reauth: {
      required: reauthRequired,
      at: reauthRequired ? (num(reauth?.at) || null) : null,
      source: reauthRequired ? str(reauth?.source, 24) : null,
      code: reauthRequired ? str(reauth?.code, 64) : null,
    },
    lastProbed: num(lastProbed) || null,
    entitlementFetchedAt: num(entitlementFetchedAt) || null,
    hasRefreshToken: !!hasRefreshToken,
    method: str(method, 32),
    // The login flow is the only path that mints a new session key; there is no
    // separate "rotate key" RPC in this build.
    rotation: 'relogin',
  };
}

// ─── 4. Capacity preflight ─────────────────────────────────────────────────

const AVAILABILITY_STATE = {
  disabled: 'disabled',
  'status:disabled': 'disabled',
  'status:error': 'error',
  quota_exhausted: 'quota_cooled',
  rate_limited: 'rate_limited',
  model_rate_limited: 'model_limited',
  rpm_full: 'rpm_exhausted',
  tier_expired: 'tier_expired',
  model_not_available: 'not_entitled',
};

function localStateOf(reasons) {
  for (const state of LOCAL_STATE_VALUES) if (reasons.includes(state)) return state;
  return 'ok';
}

/**
 * Build the preflight payload from already-collected facts.
 *
 * `upstream` is the raw `checkMessageRateLimit` result. It fails OPEN on a
 * network error (`hasCapacity:true`), so the `error` field is what separates
 * "upstream said yes" from "we could not ask" — the latter is `unknown`, never
 * `ok`.
 */
export function buildCapacityPreflight({
  accountRef = null,
  model = null,
  selector = null,
  selectorMapped = false,
  selectorInCatalog = null,
  selectorFreeNow = null,
  poolEntitled = null,
  poolAllUnavailable = false,
  poolRetryAfterMs = null,
  availability = null,
  selectorAllowed = null,
  modelAllowed = null,
  rpmUsed = null,
  rpmLimit = null,
  rateLimitedUntil = 0,
  quotaResetAt = 0,
  modelRateLimitUntil = 0,
  upstream = null,
  cached = false,
  now = Date.now(),
} = {}) {
  const reasons = [];
  const availabilityReason = typeof availability?.reason === 'string' ? availability.reason : '';
  const mapped = AVAILABILITY_STATE[availabilityReason];
  if (mapped && mapped !== 'ok') reasons.push(mapped);
  if (availability && availability.available === false && !mapped && availabilityReason) {
    reasons.push(availabilityReason.startsWith('status:') ? 'error' : 'not_entitled');
  }
  if (modelAllowed === false && !reasons.includes('not_entitled')) reasons.push('not_entitled');
  if (selectorAllowed === false && !reasons.includes('not_entitled')) reasons.push('not_entitled');

  const localState = localStateOf(reasons);
  const localRetryAfterMs = num(availability?.retryAfterMs);

  const up = obj(upstream);
  let upstreamState = 'unknown';
  if (up && !up.error) {
    if (up.hasCapacity === false) upstreamState = 'limited';
    else if (up.hasCapacity === true) upstreamState = 'ok';
  }

  const verdict = localState !== 'ok'
    ? 'blocked'
    : upstreamState === 'limited'
      ? 'throttled'
      : upstreamState === 'ok'
        ? 'ok'
        : 'unknown';

  const messagesRemaining = num(up?.messagesRemaining);
  const maxMessages = num(up?.maxMessages);

  return {
    ok: true,
    accountRef,
    fetchedAt: now,
    cached: !!cached,
    verdict,
    model: str(model, 200),
    selector: selectorMapped ? str(selector, 200) : null,
    selectorMapped: !!selectorMapped,
    local: {
      state: localState,
      eligible: localState === 'ok',
      reasons,
      reason: availabilityReason || null,
      retryAfterMs: localRetryAfterMs,
      rpmUsed: num(rpmUsed),
      rpmLimit: num(rpmLimit),
      rpmHeadroom: num(rpmLimit) != null && num(rpmUsed) != null ? Math.max(0, rpmLimit - rpmUsed) : null,
      rateLimitedUntil: num(rateLimitedUntil) || 0,
      quotaResetAt: num(quotaResetAt) || 0,
      modelRateLimitUntil: num(modelRateLimitUntil) || 0,
      modelAllowed,
      selectorAllowed,
    },
    upstream: {
      state: upstreamState,
      hasCapacity: up ? (typeof up.hasCapacity === 'boolean' ? up.hasCapacity : null) : null,
      messagesRemaining: messagesRemaining != null && messagesRemaining >= 0 ? messagesRemaining : null,
      maxMessages: maxMessages != null && maxMessages >= 0 ? maxMessages : null,
      // -1 is the wire's "unlimited". A fail-open probe also returns -1, so it
      // must not claim unlimited — the error flag above is the discriminator.
      unlimited: !up?.error && messagesRemaining === -1,
      retryAfterMs: num(up?.retryAfterMs),
      error: str(up?.error, 64),
    },
    pool: {
      selectorInCatalog,
      catalogSynced: hasLiveCatalog(),
      freeNow: selectorFreeNow,
      entitled: poolEntitled,
      allUnavailable: !!poolAllUnavailable,
      retryAfterMs: num(poolRetryAfterMs),
    },
  };
}

const _preflightCache = new Map();

/** Test seam: inject the upstream capacity check and drop cached answers. */
export function __setPreflightDepsForTest(deps = {}) {
  _preflightDeps = deps && typeof deps === 'object' ? deps : {};
  _preflightCache.clear();
}

let _preflightDeps = {};

function liveSelectorSet() {
  const set = new Set();
  for (const row of getLiveCatalog()) {
    const selector = typeof row === 'string' ? row : row?.selector;
    if (typeof selector === 'string' && selector) set.add(selector);
  }
  return set;
}

/**
 * Run one on-demand preflight for an account (optionally for a model).
 *
 * The upstream probe is the existing `checkMessageRateLimit` — the same call
 * the per-row button has always made — memoized for PREFLIGHT_TTL_MS so a
 * double-click cannot burn two upstream requests.
 */
export async function preflightCapacity({ id, model = '', force = false, now = Date.now() } = {}) {
  const account = getAccountInternal(id);
  if (!account) return { ok: false, error: 'account_not_found', httpStatus: 404 };

  const requested = String(model || '').trim();
  const resolution = requested ? resolveConnectSelector(requested, { warnOnFallback: false }) : null;
  const selectorMapped = !!resolution?.mapped;
  const selector = selectorMapped ? resolution.selector : null;

  // `isModelAllowedForAccount` / `getAccountAvailability` speak the MODELS
  // namespace (enum keys), while the preflight accepts either a MODELS key or a
  // raw connect selector. Only ask the MODELS gate when the caller named a key it
  // understands; otherwise the selector gate below is the authority.
  const modelKey = requested && MODELS[requested] ? requested : null;
  const modelAllowed = modelKey ? isModelAllowedForAccount(account, modelKey) : null;
  const selectorAllowed = selectorMapped && selector
    ? isConnectSelectorAllowedForAccount(account, selector)
    : null;
  const pool = selector ? isAllTemporarilyUnavailable(null, selector) : { allUnavailable: false, retryAfterMs: null };
  const rpm = getRpmStats()[account.id] || {};
  const availability = getAccountAvailability(account.apiKey, modelKey);

  const cacheId = cacheKey({ accountId: account.id, token: account.apiKey, name: `preflight:${selector || '*'}` });
  const hit = _preflightCache.get(cacheId);
  let cached = false;
  let upstream;
  if (!force && hit && now - hit.at < PREFLIGHT_TTL_MS) {
    cached = true;
    upstream = hit.value;
  } else {
    const check = typeof _preflightDeps.rateLimit === 'function' ? _preflightDeps.rateLimit : checkMessageRateLimit;
    try {
      upstream = await check(account.apiKey, getEffectiveProxy(account.id) || null);
    } catch {
      // checkMessageRateLimit is documented to fail open; if a replacement
      // throws anyway the honest answer is "could not ask", not "ok".
      upstream = { hasCapacity: true, messagesRemaining: -1, maxMessages: -1, retryAfterMs: null, error: 'upstream_unreachable' };
    }
    if (!obj(upstream)) {
      upstream = { hasCapacity: true, messagesRemaining: -1, maxMessages: -1, retryAfterMs: null, error: 'upstream_unreachable' };
    }
    _preflightCache.set(cacheId, { at: now, value: upstream });
  }

  const catalog = liveSelectorSet();
  const selectorInCatalog = selector
    ? (hasLiveCatalog() ? catalog.has(selector) : null)
    : null;

  return buildCapacityPreflight({
    accountRef: accountRefOf(account.id),
    model: requested || null,
    selector,
    selectorMapped,
    selectorInCatalog,
    selectorFreeNow: selector ? isConnectSelectorCurrentlyFree(selector) : null,
    poolEntitled: selector ? hasConnectEntitledAccount(selector) : null,
    poolAllUnavailable: pool.allUnavailable,
    poolRetryAfterMs: pool.retryAfterMs,
    availability,
    selectorAllowed,
    modelAllowed,
    rpmUsed: rpm.used,
    rpmLimit: rpm.limit,
    rateLimitedUntil: account.rateLimitedUntil || 0,
    quotaResetAt: account.quotaResetAt || 0,
    modelRateLimitUntil: selector ? (account._modelRateLimits?.[selector] || 0) : 0,
    upstream,
    cached,
    now,
  });
}

// ─── Aggregate reader ──────────────────────────────────────────────────────

/**
 * Build all three local cards for one account. No network: every field comes
 * from the stored account record plus the in-process credit ledger.
 *
 * Returns `{ok:false, error:'account_not_found'}` for an unknown id; a card whose
 * source is missing still returns its explicit "not observable" state.
 */
export function buildAccountCards(id, { now = Date.now() } = {}) {
  const account = getAccountInternal(id);
  if (!account) return { ok: false, error: 'account_not_found', httpStatus: 404 };

  const credits = obj(account.credits);
  const tierModels = getTierModels(account.tier || 'unknown', account.id);
  const ref = accountRefOf(account.id);

  return {
    ok: true,
    accountRef: ref,
    fetchedAt: now,
    ledger: buildAcuLedger({
      accountRef: ref,
      totalSpend: account._totalSpend || null,
      credits,
      history: getCreditLedger(account.id),
      now,
    }),
    modelStatus: buildModelStatus({
      accountRef: ref,
      tier: account.tier,
      tierManual: !!account.tierManual,
      tierModels,
      blockedModels: account.blockedModels || [],
      capabilities: account.capabilities || {},
      rateTable: credits?.rateTable || null,
      // One bulk lookup, not one per row: same snapshot of the pool-wide free
      // set for every row, so a promo cannot render as free on one line and
      // paid on the next.
      pricing: getConnectPricingMap(modelStatusSelectors(credits?.rateTable)),
      userStatus: account.userStatus || null,
      userStatusLastFetched: account.userStatusLastFetched || 0,
      now,
    }),
    key: buildKeyInfo({
      accountRef: ref,
      apiKeyMasked: maskApiKey(account.apiKey),
      createdAt: account.addedAt || null,
      rotatedAt: account.keyRotatedAt || null,
      lastProbed: account.lastProbed || null,
      entitlementFetchedAt: account.userStatusLastFetched || null,
      hasRefreshToken: !!account.refreshToken,
      method: account.method,
      state: account.status === 'reauth' ? 'reauth' : 'ok',
      reauth: account.reauth || null,
      now,
    }),
  };
}

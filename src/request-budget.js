// Route-owned request budget.
//
// WHY THIS EXISTS. Every retry layer (account failover, same-token replay,
// empty/rescue retries, queue waits) used to own its own bound, and the bounds
// composed multiplicatively: a request could spend ~90 upstream turns and hours
// of wall clock, and no layer could tell that the client's request had already
// been in flight too long. This module gives the route ONE absolute deadline and
// ONE upstream-turn counter. Layers receive the budget, may only shorten their
// own waits by the remaining time, and consume a turn before issuing upstream
// work. Nothing here removes a per-layer retry: it makes each one observe the
// request-level bound.
//
// The default is deliberately generous (10 min, +5 min for streams) because it
// is a safety ceiling, not a latency target: a normal Cascade turn finishes in
// well under a minute, while the pre-budget worst case was hours. Operators can
// tighten it with WINDSURFAPI_REQUEST_BUDGET_MS (base, non-stream) and
// WINDSURFAPI_REQUEST_BUDGET_STREAM_MS (extra allowed for streams).
//
// Turn cap: 6 per request. The documented per-invocation ceiling in the connect
// adapter is 1 + empty(2) + rescue(2) = 5, and one transient replay already fits
// inside that; the handler's account failover shares the same 6. This is the
// hard stop against the measured 45/90-turn products.

export const DEFAULT_REQUEST_BUDGET_MS = 600_000;
export const DEFAULT_STREAM_BUDGET_EXTRA_MS = 300_000;
export const DEFAULT_UPSTREAM_TURN_CAP = 6;

// Deliberately NOT a 5xx `status`: devin-connect.js isRetryable() treats any
// numeric 5xx (except 501) as transient, and a budget stop must never trigger
// another retry. DEADLINE_EXCEEDED maps to 504 at the egress boundary
// (connectErrorToHttp) and is absent from RETRYABLE_CODES.
export const BUDGET_EXCEEDED_CODE = 'DEADLINE_EXCEEDED';

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Absolute budget for one request: base (+ stream extra). */
export function resolveRequestBudgetMs({ stream = false, env = process.env } = {}) {
  const base = positiveNumber(env?.WINDSURFAPI_REQUEST_BUDGET_MS) ?? DEFAULT_REQUEST_BUDGET_MS;
  if (!stream) return base;
  const extra = nonNegativeNumber(env?.WINDSURFAPI_REQUEST_BUDGET_STREAM_MS) ?? DEFAULT_STREAM_BUDGET_EXTRA_MS;
  return base + extra;
}

/**
 * Error surfaced when the request budget (deadline or turn cap) is spent.
 * Carries the same classification the deadline paths already use, so the
 * existing egress code maps it to 504 + `upstream_deadline_exceeded` without a
 * new branch, and `isRetryable()` refuses to re-issue it.
 */
export function budgetExceededError(reason = 'request budget exhausted', { cause = null } = {}) {
  const err = new Error(reason);
  err.name = 'RequestBudgetExceededError';
  err.code = BUDGET_EXCEEDED_CODE;
  err.type = 'upstream_deadline_exceeded';
  err.budgetExceeded = true;
  if (cause) err.cause = cause;
  return err;
}

export function isBudgetExceededError(err) {
  return !!err && (err.budgetExceeded === true || err.code === BUDGET_EXCEEDED_CODE);
}

/**
 * Create the route's budget. `now` is injectable so tests can drive the
 * deadline deterministically without sleeping.
 *
 * Contract for consumers:
 *   - `waitMs(cap)` clamps any queue/backoff wait to what is left;
 *   - `takeTurn()` is called immediately BEFORE an upstream call and returns
 *     false when the cap is reached or the deadline passed;
 *   - `canStartAttempt()` is the read-only pre-check for a failover hop;
 *   - `remainingMs()` is what gets passed as `deadlineMs`/`maxWaitMs` to a
 *     layer that owns its own internal timeout.
 */
export function createRequestBudget({
  deadlineMs,
  stream = false,
  upstreamTurnCap = DEFAULT_UPSTREAM_TURN_CAP,
  env = process.env,
  now = Date.now,
} = {}) {
  const totalMs = positiveNumber(deadlineMs) ?? resolveRequestBudgetMs({ stream, env });
  const startedAt = now();
  const deadline = startedAt + totalMs;
  const turnCap = Math.max(0, Math.floor(Number(upstreamTurnCap) || 0));
  let turnsUsed = 0;

  const remainingMs = () => Math.max(0, deadline - now());
  const expired = () => remainingMs() <= 0;
  const canStartAttempt = () => !expired() && turnsUsed < turnCap;
  const takeTurn = () => {
    if (!canStartAttempt()) return false;
    turnsUsed += 1;
    return true;
  };

  return {
    totalMs,
    startedAt,
    deadline,
    turnCap,
    get turnsUsed() { return turnsUsed; },
    get turnsRemaining() { return Math.max(0, turnCap - turnsUsed); },
    remainingMs,
    expired,
    waitMs(capMs) {
      const cap = positiveNumber(capMs) ?? 0;
      return Math.min(cap, remainingMs());
    },
    canStartAttempt,
    takeTurn,
    takeTurnOrThrow(label = 'upstream') {
      if (takeTurn()) return true;
      throw budgetExceededError(
        expired()
          ? `request budget exhausted after ${totalMs}ms (no ${label} attempt started)`
          : `request upstream-turn cap reached (${turnsUsed}/${turnCap})`,
      );
    },
    describe() {
      return `budget ${totalMs}ms remaining=${remainingMs()}ms turns=${turnsUsed}/${turnCap}`;
    },
  };
}

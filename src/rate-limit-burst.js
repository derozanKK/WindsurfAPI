/**
 * Process-scoped "IP-level" rate-limit burst detector.
 *
 * WHY this is not per-request state: Windsurf applies some cooldowns to the
 * CLIENT IP, not to a single account. When several pooled accounts hit a 429 on
 * the same model inside a few seconds, burning through the rest of the pool just
 * marks every account dead for the cooldown window and tells the caller nothing.
 * The signal is only visible ACROSS requests, so the event window must live for
 * the process lifetime (like the metrics counters), never on a request context.
 *
 * Scope: events are grouped by `model` (the routing model key). Accounts are
 * recorded for diagnostics only; a repeated 429 from the SAME account still
 * counts, matching the original per-request implementation.
 *
 * This module is deliberately dependency-free: both the non-stream and the
 * stream Cascade paths import it, and tests reset it through the seam below.
 */

export const RATE_LIMIT_BURST_WINDOW_MS = 8_000;
export const RATE_LIMIT_BURST_THRESHOLD = 3;

// A burst window is 8s; a handful of events per model is all that can survive
// pruning. The cap is a belt-and-braces bound for pathological callers.
const MAX_EVENTS = 256;

/** @type {{time:number, model:string|null, account:string|null, cooldownMs:number}[]} */
const _events = [];

/**
 * Record one upstream rate-limit observation and report whether the window for
 * this model has now crossed the burst threshold.
 *
 * @param {object} [event]
 * @param {string|null} [event.model] routing model key the 429 applied to
 * @param {string|null} [event.account] account id (diagnostics only)
 * @param {number} [event.cooldownMs] cooldown the caller intends to apply
 * @param {number} [event.now] injectable clock for tests
 * @returns {{tripped:boolean, count:number, maxCooldownMs:number}}
 */
export function recordRateLimitBurstEvent({ model = null, account = null, cooldownMs = 0, now = Date.now() } = {}) {
  const cooldown = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 0;
  _events.push({ time: now, model, account, cooldownMs: cooldown });

  const cutoff = now - RATE_LIMIT_BURST_WINDOW_MS;
  while (_events.length && _events[0].time < cutoff) _events.shift();
  if (_events.length > MAX_EVENTS) _events.splice(0, _events.length - MAX_EVENTS);

  const sameModel = _events.filter((e) => e.model === model);
  const maxCooldownMs = sameModel.reduce((max, e) => Math.max(max, e.cooldownMs), 0);
  return {
    tripped: sameModel.length >= RATE_LIMIT_BURST_THRESHOLD,
    count: sameModel.length,
    maxCooldownMs,
  };
}

/** Test seam: forget every recorded event. */
export function __resetRateLimitBurstForTest() {
  _events.length = 0;
}

/** Test seam: snapshot of the live window (oldest first). */
export function __rateLimitBurstStateForTest() {
  return _events.map((e) => ({ ...e }));
}

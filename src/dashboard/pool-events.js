/**
 * Pool-event detection — pure functions (testable, no DOM).
 *
 * The dashboard polls a lightweight pool snapshot; this module turns a stream of
 * snapshots into DEDUPED, TRANSITION-ONLY notification events, so the operator
 * sees when the self-healing account pool flaps between healthy ↔ cooling ↔
 * capacity ↔ quota ↔ disabled — the one thing this project exists to manage —
 * without a wall of repeated toasts.
 *
 * IMPORTANT: this file is the CANONICAL logic. index.html inlines an equivalent
 * copy (single-file "just open it" constraint); src/dashboard/check-inline-sync.js
 * asserts the two stay in sync. Edit both, or the sync gate fails.
 *
 * Design notes (learned from KiroStudio's implementation bugs):
 *  - Collapse threshold is GLOBAL, not per-category. KiroStudio used a per-class
 *    threshold + a global MAX_VISIBLE cap, so a cross-category storm silently
 *    dropped a real fault. We summarize per category but never cap-drop.
 *  - Per-fingerprint backoff: a flapping account is not re-reported every poll.
 *  - `primed`: the first snapshot establishes a baseline and emits NOTHING, so
 *    opening the panel doesn't spew the whole current pool state as "events".
 */

// Derive the coarse pool-state of one account from its snapshot flags. Order
// matters: disabled > banned > reauth > quota > rate-limit(account) > capacity > active.
// This is the state we diff transitions against.
export function accountState(a) {
  if (!a) return 'unknown';
  if (a.status === 'disabled') return 'disabled';
  if (a.status === 'banned') return 'banned';
  if (a.status === 'reauth') return 'reauth';
  if (a.status === 'error') return 'error';
  if (a.quotaCooled) return 'quota';
  if (a.rateLimited) return 'rate_limited';
  if (a.capacityThrottled) return 'capacity';
  return 'active';
}

/**
 * Project the raw pool deadlines into the dashboard's cooldown card fields.
 *
 * A deadline is active only when `until > now` (strict): a timestamp exactly at
 * `now` is already over. `cooldownUntil` is null — not 0 — when no account-wide
 * deadline is in the future, so the UI can distinguish "cooling" from "expired".
 * Reason precedence: quota > rate_limit > capacity > null.
 */
export function cooldownState({ rateLimitedUntil = 0, quotaResetAt = 0, capacityThrottled = false, now = Date.now() } = {}) {
  const rateUntil = Number.isFinite(rateLimitedUntil) ? rateLimitedUntil : 0;
  const quotaUntil = Number.isFinite(quotaResetAt) ? quotaResetAt : 0;
  const rateLimited = rateUntil > now;
  const quotaCooled = quotaUntil > now;
  const cooldownUntil = Math.max(rateLimited ? rateUntil : 0, quotaCooled ? quotaUntil : 0) || null;
  return {
    rateLimited,
    quotaCooled,
    capacityThrottled: !!capacityThrottled,
    cooldownUntil,
    cooldownReason: quotaCooled ? 'quota'
      : rateLimited ? 'rate_limit'
        : capacityThrottled ? 'capacity'
          : null,
    cooldownRemainingMs: cooldownUntil ? cooldownUntil - now : 0,
  };
}

// A state transition worth notifying about, with a severity for styling.
// 'recovered' (→active from a bad state) is informational; the rest warn.
// `reauth` is error severity, like `banned`: it never self-heals, so a warn
// toast would promise a recovery that only a new token can deliver.
export function classifyTransition(from, to) {
  if (from === to) return null;
  if (to === 'active') return { kind: 'recovered', severity: 'success' };
  const sev = (to === 'disabled' || to === 'quota' || to === 'banned' || to === 'reauth') ? 'error' : 'warn';
  return { kind: to, severity: sev };
}

/**
 * Stateful detector. Feed it snapshots; it returns the events to surface.
 *
 * @param {object} [opts]
 * @param {number} [opts.backoffMs=60000] per-account re-report cooldown
 * @param {number} [opts.collapseAt=3]     ≥N same-kind events in one tick collapse to a summary
 */
export function createPoolEventDetector({ backoffMs = 60000, collapseAt = 3 } = {}) {
  let primed = false;
  const lastState = new Map();   // id → state string
  const lastEmitAt = new Map();  // id → ms timestamp of last emitted transition

  return {
    get primed() { return primed; },

    /**
     * @param {Array} snapshot  [{ id, ref, status, rateLimited, capacityThrottled, quotaCooled }]
     * @param {number} now      ms (injectable for tests)
     * @returns {Array} events  [{ type:'account', id, ref, kind, severity, from, to }] or
     *                          [{ type:'summary', kind, severity, count }] for collapsed groups
     */
    push(snapshot, now = Date.now()) {
      const list = Array.isArray(snapshot) ? snapshot : [];
      // First snapshot: establish baseline silently (no storm on panel open).
      if (!primed) {
        for (const a of list) lastState.set(a.id, accountState(a));
        primed = true;
        return [];
      }

      const raw = [];
      const seen = new Set();
      for (const a of list) {
        if (!a || a.id == null) continue;
        seen.add(a.id);
        const to = accountState(a);
        const from = lastState.get(a.id) ?? 'active';
        lastState.set(a.id, to);
        const t = classifyTransition(from, to);
        if (!t) continue;
        // Per-fingerprint backoff: don't re-report the same account within the
        // window (a flapping account would otherwise spam every poll). Only
        // applies once an account HAS emitted — its very first transition is
        // always allowed (a never-emitted account has no backoff floor).
        if (lastEmitAt.has(a.id) && now - lastEmitAt.get(a.id) < backoffMs) continue;
        lastEmitAt.set(a.id, now);
        raw.push({ type: 'account', id: a.id, ref: a.ref || a.id, kind: t.kind, severity: t.severity, from, to });
      }
      // Accounts that vanished from the snapshot (removed) — forget their state
      // so a re-add re-baselines rather than firing a bogus transition.
      for (const id of [...lastState.keys()]) {
        if (!seen.has(id)) { lastState.delete(id); lastEmitAt.delete(id); }
      }

      return collapse(raw, collapseAt);
    },

    // Test/debug aid: reset baseline (e.g. after auth switch).
    reset() { primed = false; lastState.clear(); lastEmitAt.clear(); },
  };
}

// Collapse ≥collapseAt same-kind account events into one summary. GLOBAL rule:
// we never drop events beyond a cap — a large storm becomes a summary, never
// silence (KiroStudio's per-class + cap bug dropped real faults).
export function collapse(events, collapseAt = 3) {
  const byKind = new Map();
  for (const e of events) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push(e);
  }
  const out = [];
  for (const [kind, group] of byKind) {
    if (group.length >= collapseAt) {
      out.push({ type: 'summary', kind, severity: group[0].severity, count: group.length });
    } else {
      out.push(...group);
    }
  }
  return out;
}

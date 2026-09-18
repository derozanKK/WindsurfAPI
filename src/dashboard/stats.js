/**
 * Request statistics collector with debounced JSON persistence.
 */

import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic } from '../fs-atomic.js';
import { join } from 'path';
import { config } from '../config.js';
import { getModelInfo } from '../models.js';

const STATS_FILE = join(config.dataDir, 'stats.json');

// v2.0.9x — cardinality bound for per-model stats. modelCounts is keyed by
// the client-controlled model string; without a cap, case-permuted names or
// free-tier passthrough names grow RAM + stats.json + the per-poll sort
// unbounded. Cap the number of *real* model keys (LRU-evict the
// least-recently-updated one into a shared '(other)' bucket so totals still
// reconcile). Secure default is bounded; set STATS_MAX_MODELS=0 to opt back
// into the old unbounded behavior.
const OTHER_MODEL_KEY = '(other)';
const MAX_MODELS = (() => {
  const raw = parseInt(process.env.STATS_MAX_MODELS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
})();

// Account-ref translator. Callers historically passed an apiKey where an
// account id was intended, and every `devin-session-token$<JWT>` shares the
// same "devin-se" 8-char prefix — so per-account stats collapsed the whole
// pool into one bucket. chat.js registers an apiKey→account.id resolver here
// (same injection pattern as auth.js setDroughtRestrictResolver) so
// accountCounts keys are real account ids. No resolver → raw ref, pre-fix
// behaviour preserved for tests that import this module directly.
let _accountRefResolver = null;
export function setAccountRefResolver(fn) {
  _accountRefResolver = typeof fn === 'function' ? fn : null;
}

function accountStatKey(accountId) {
  if (!accountId) return null;
  const resolved = (_accountRefResolver && _accountRefResolver(accountId)) || accountId;
  return typeof resolved === 'string' ? resolved.slice(0, 8) : String(resolved);
}

// Monotonic recency counter for LRU eviction. Wall-clock time ties within a
// single millisecond (many requests can land there), which would make
// eviction fall back to insertion order and starve hot-but-old keys; a
// strictly-increasing seq gives an unambiguous least-recently-updated pick.
let _touchSeq = 0;

// audit S8: cache of the current-hour hourlyBuckets entry so recordRequest
// avoids an O(n) .find per request. Reset (null) means "re-resolve on next
// record" — safe after restart or hour rollover.
let _curBucket = null;

/** Count of tracked model keys excluding the shared overflow bucket. */
function realModelKeyCount() {
  let n = 0;
  for (const k of Object.keys(_state.modelCounts)) {
    if (k !== OTHER_MODEL_KEY) n++;
  }
  return n;
}

/** Fold an evicted model's counts into the shared '(other)' bucket. */
function foldIntoOther(src) {
  let dst = _state.modelCounts[OTHER_MODEL_KEY];
  if (!dst) {
    dst = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [], lastTs: 0 };
    _state.modelCounts[OTHER_MODEL_KEY] = dst;
  }
  dst.requests += src.requests || 0;
  dst.success += src.success || 0;
  dst.errors += src.errors || 0;
  dst.totalMs += src.totalMs || 0;
  if (!dst.recentMs) dst.recentMs = [];
  if (Array.isArray(src.recentMs) && src.recentMs.length) {
    for (const v of src.recentMs) dst.recentMs.push(v);
    if (dst.recentMs.length > 200) dst.recentMs = dst.recentMs.slice(-200);
  }
  dst.lastTs = ++_touchSeq;
}

/**
 * Ensure there is room for one more real model key, LRU-evicting the
 * least-recently-updated real model into '(other)' while over the cap.
 * No-op when MAX_MODELS is 0 (unbounded).
 */
function enforceModelCap() {
  if (MAX_MODELS <= 0) return;
  while (realModelKeyCount() >= MAX_MODELS) {
    let coldestKey = null;
    let coldestTs = Infinity;
    for (const [k, s] of Object.entries(_state.modelCounts)) {
      if (k === OTHER_MODEL_KEY) continue;
      const ts = s.lastTs || 0;
      if (ts < coldestTs) { coldestTs = ts; coldestKey = k; }
    }
    if (coldestKey == null) break;
    foldIntoOther(_state.modelCounts[coldestKey]);
    delete _state.modelCounts[coldestKey];
  }
}

const _state = {
  startedAt: Date.now(),
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  modelCounts: {},    // { "gpt-4o-mini": { requests, success, errors, totalMs } }
  accountCounts: {},  // { "abc123": { requests, success, errors } }
  hourlyBuckets: [],  // [{ hour: "2026-04-09T07:00:00Z", requests, errors }]
  // v2.0.69 (#118 wnfilm) — bucket-level token totals so the dashboard
  // can show fresh_input / cache_read / cache_write / output without
  // having to recompute from the per-request usage stream. Keyed by
  // bucket so summing across the proxy lifetime is just `totals[k]`.
  tokenTotals: {
    fresh_input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    total: 0,
    requests_with_usage: 0,
  },
  // v2.0.91 — track upstream rejection/cooldown events
  policyBlockedCount: 0,
  // v3.4.x — content-policy-block observability ring. The upstream content
  // policy is non-deterministic (same prompt blocks then passes), so we
  // capture a small system-prompt-only sample at block time for later A/B.
  // Bounded ring, newest last; cap via POLICY_BLOCK_RING (default 50).
  recentPolicyBlocks: [],
  rateLimitedCount: 0,
  // v2.0.148 — Credits spend dimension. creditsByHour/Day are keyed maps
  // { "<iso-hour|day>": creditsFloat } so the dashboard can chart spend over
  // time. Cost per request = MODELS[model].credit (rate card), summed here so we
  // never have to thread cost through the 10 recordRequest call sites.
  creditsTotal: 0,
  creditsByHour: {},   // { "2026-07-09T01:00:00Z": 12.5 }
  creditsByDay: {},    // { "2026-07-09": 340.0 }
  creditsByModel: {},  // { "claude-opus-4-8-medium": 88.0 }
  // v2.0.148 — per-request detail ring buffer (bounded, persisted) so long runs
  // keep a rolling window of recent calls for audit/export instead of losing them.
  recentRequests: [],  // [{ ts, model, success, ms, account, credit }]  newest last, cap 500
};

const RECENT_REQ_CAP = 500;

// Load persisted stats
try {
  if (existsSync(STATS_FILE)) {
    const saved = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    Object.assign(_state, saved);
    // Reseed the recency counter above any persisted lastTs so LRU ordering
    // survives a restart without an early wrap-collision.
    for (const s of Object.values(_state.modelCounts || {})) {
      if (s && s.lastTs > _touchSeq) _touchSeq = s.lastTs;
    }
  }
} catch {}

// Debounced save
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      writeJsonAtomic(STATS_FILE, _state);
    } catch {}
  }, 5000);
}

function getHourKey() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * Record a completed request.
 */
export function recordRequest(model, success, durationMs, accountId) {
  _state.totalRequests++;
  if (success) _state.successCount++;
  else _state.errorCount++;

  // Per-model stats (includes a small ring buffer for p50/p95 latency).
  // Cap real-model cardinality: a brand-new key that would exceed the limit
  // gets folded into the shared '(other)' bucket instead (LRU eviction of the
  // coldest existing key). Known keys and '(other)' itself always update.
  let key = model;
  if (!_state.modelCounts[key] && key !== OTHER_MODEL_KEY) {
    enforceModelCap();
    if (MAX_MODELS > 0 && realModelKeyCount() >= MAX_MODELS) key = OTHER_MODEL_KEY;
  }
  if (!_state.modelCounts[key]) {
    _state.modelCounts[key] = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [], lastTs: 0 };
  }
  const mc = _state.modelCounts[key];
  mc.requests++;
  if (success) mc.success++;
  else mc.errors++;
  mc.totalMs += durationMs;
  mc.lastTs = ++_touchSeq;
  if (!mc.recentMs) mc.recentMs = [];
  if (durationMs > 0) {
    mc.recentMs.push(durationMs);
    if (mc.recentMs.length > 200) mc.recentMs.shift();
  }

  // Per-account stats
  const aid = accountStatKey(accountId);
  if (aid) {
    if (!_state.accountCounts[aid]) {
      _state.accountCounts[aid] = { requests: 0, success: 0, errors: 0 };
    }
    const ac = _state.accountCounts[aid];
    ac.requests++;
    if (success) ac.success++;
    else ac.errors++;
  }

  // Hourly bucket. audit S8: the current-hour bucket is (almost) always the
  // last element, so a per-request O(n) linear .find over up to 720 buckets was
  // wasted work. Cache the current hour's bucket ref and only re-resolve when
  // the hour rolls over (or after a restart, where _curBucket starts null and
  // we fall back to the tail/find once).
  const hourKey = getHourKey();
  let bucket = _curBucket && _curBucket.hour === hourKey ? _curBucket : null;
  if (!bucket) {
    const tail = _state.hourlyBuckets[_state.hourlyBuckets.length - 1];
    bucket = tail && tail.hour === hourKey ? tail : _state.hourlyBuckets.find(b => b.hour === hourKey);
  }
  if (!bucket) {
    bucket = { hour: hourKey, requests: 0, errors: 0 };
    _state.hourlyBuckets.push(bucket);
    // Keep last 30 days of hourly data (720 buckets)
    if (_state.hourlyBuckets.length > 720) _state.hourlyBuckets.shift();
  }
  _curBucket = bucket;
  bucket.requests++;
  if (!success) bucket.errors++;

  // v2.0.148 — Credits spend + per-request detail. Cost = model's rate-card
  // credit (getModelInfo), 0 if unknown. Persisted maps stay JSON-safe.
  let credit = 0;
  try { credit = Number(getModelInfo(model)?.credit) || 0; } catch { credit = 0; }
  if (credit > 0 && success) {
    const dayKey = hourKey.slice(0, 10);
    _state.creditsTotal = (_state.creditsTotal || 0) + credit;
    _state.creditsByHour[hourKey] = (_state.creditsByHour[hourKey] || 0) + credit;
    _state.creditsByDay[dayKey] = (_state.creditsByDay[dayKey] || 0) + credit;
    _state.creditsByModel[model] = (_state.creditsByModel[model] || 0) + credit;
    // Prune credit hour map to ~30 days (720 keys), day map to ~90 days.
    pruneKeyed(_state.creditsByHour, 720);
    pruneKeyed(_state.creditsByDay, 90);
  }
  if (!Array.isArray(_state.recentRequests)) _state.recentRequests = [];
  _state.recentRequests.push({
    ts: Date.now(), model, success: !!success, ms: durationMs || 0,
    account: aid,
    credit,
  });
  if (_state.recentRequests.length > RECENT_REQ_CAP) {
    _state.recentRequests.splice(0, _state.recentRequests.length - RECENT_REQ_CAP);
  }

  scheduleSave();
}

// Keep a keyed map bounded to the most recent `max` keys (lexicographic ISO
// order == chronological). Drops the oldest keys when over cap.
function pruneKeyed(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort();
  for (const k of keys.slice(0, keys.length - max)) delete map[k];
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

/** Get all stats, with computed latency percentiles per model. */
export function getStats() {
  const out = { ..._state };
  out.modelCounts = {};
  for (const [m, s] of Object.entries(_state.modelCounts)) {
    const sorted = (s.recentMs || []).slice().sort((a, b) => a - b);
    out.modelCounts[m] = {
      requests: s.requests,
      success: s.success,
      errors: s.errors,
      totalMs: s.totalMs,
      avgMs: s.requests > 0 ? Math.round(s.totalMs / s.requests) : 0,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
    };
  }
  return out;
}

// v2.0.148 — Export the full stats state as a JSON-serializable snapshot (for
// backup / migration / offline analysis). Includes credits + recentRequests.
export function exportStats() {
  return {
    _exportedAt: new Date().toISOString(),
    _schema: 'windsurfapi-stats-v2',
    ..._state,
  };
}

// v2.0.148 — Import a previously exported snapshot. MERGE mode (default) adds
// counts onto current; REPLACE overwrites. Numeric fields are summed, keyed
// maps merged, recentRequests concatenated + de-duped by ts+model then capped.
export function importStats(snap, { mode = 'merge' } = {}) {
  if (!snap || typeof snap !== 'object') return { ok: false, error: 'invalid snapshot' };
  // Match runtime-config.js:182-190: ignore prototype keys at every depth.
  // Complete the clone before clearing state so a failed clone is non-mutating.
  const src = JSON.parse(JSON.stringify(snap), (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    return value;
  });
  if (mode === 'replace') {
    for (const k of Object.keys(_state)) delete _state[k];
    Object.assign(_state, src);
    delete _state._exportedAt; delete _state._schema;
    _curBucket = null; // S8: state wholesale-replaced, cached bucket ref is stale
    scheduleSave();
    return { ok: true, mode: 'replace' };
  }
  // merge
  const numKeys = ['totalRequests', 'successCount', 'errorCount', 'creditsTotal', 'policyBlockedCount', 'rateLimitedCount'];
  for (const k of numKeys) if (typeof src[k] === 'number') _state[k] = (_state[k] || 0) + src[k];
  for (const mapKey of ['creditsByHour', 'creditsByDay', 'creditsByModel']) {
    const m = src[mapKey]; if (m && typeof m === 'object') {
      _state[mapKey] = _state[mapKey] || {};
      for (const [k, v] of Object.entries(m)) _state[mapKey][k] = (_state[mapKey][k] || 0) + (Number(v) || 0);
    }
  }
  if (Array.isArray(src.recentRequests)) {
    const seen = new Set((_state.recentRequests || []).map(r => `${r.ts}|${r.model}`));
    for (const r of src.recentRequests) {
      const id = `${r.ts}|${r.model}`;
      if (!seen.has(id)) { _state.recentRequests.push(r); seen.add(id); }
    }
    _state.recentRequests.sort((a, b) => a.ts - b.ts);
    if (_state.recentRequests.length > RECENT_REQ_CAP) {
      _state.recentRequests.splice(0, _state.recentRequests.length - RECENT_REQ_CAP);
    }
  }
  if (Array.isArray(src.recentPolicyBlocks)) {
    if (!Array.isArray(_state.recentPolicyBlocks)) _state.recentPolicyBlocks = [];
    const seen = new Set((_state.recentPolicyBlocks || []).map(r => `${r.ts}|${r.promptHash}`));
    for (const r of src.recentPolicyBlocks) {
      const id = `${r.ts}|${r.promptHash}`;
      if (!seen.has(id)) { _state.recentPolicyBlocks.push(r); seen.add(id); }
    }
    _state.recentPolicyBlocks.sort((a, b) => a.ts - b.ts);
    const CAP = Number(process.env.POLICY_BLOCK_RING) || 50;
    if (_state.recentPolicyBlocks.length > CAP) {
      _state.recentPolicyBlocks.splice(0, _state.recentPolicyBlocks.length - CAP);
    }
  }
  scheduleSave();
  return { ok: true, mode: 'merge' };
}

/** Reset all stats. */
export function resetStats() {
  _state.totalRequests = 0;
  _state.successCount = 0;
  _state.errorCount = 0;
  _state.modelCounts = {};
  _state.accountCounts = {};
  _state.hourlyBuckets = [];
  _curBucket = null; // invalidate cached bucket ref (S8) — buckets array replaced
  _state.tokenTotals = {
    fresh_input: 0, cache_read: 0, cache_write: 0,
    output: 0, total: 0, requests_with_usage: 0,
  };
  _state.creditsTotal = 0;
  _state.creditsByHour = {};
  _state.creditsByDay = {};
  _state.creditsByModel = {};
  _state.recentRequests = [];
  _state.recentPolicyBlocks = [];
  _state.startedAt = Date.now();
  scheduleSave();
}

/**
 * v2.0.69 (#118): record per-request token bucket totals so the dashboard
 * can show real fresh-input vs cache-read vs cache-write breakdown
 * instead of the conflated prompt_tokens number.
 *
 * Accepts the OpenAI-shaped usage object that buildUsageBody returns —
 * cascade_breakdown is the authoritative source when present, otherwise
 * fall back to standard fields.
 */
export function recordTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  const bd = usage.cascade_breakdown || null;
  const fresh = bd?.fresh_input_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - (usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || 0));
  const cacheR = bd?.cache_read_tokens ?? (usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || 0);
  const cacheW = bd?.cache_write_tokens ?? (usage.cache_creation_input_tokens || 0);
  const output = bd?.output_tokens ?? (usage.completion_tokens || usage.output_tokens || 0);
  if (!fresh && !cacheR && !cacheW && !output) return;
  if (!_state.tokenTotals) {
    _state.tokenTotals = { fresh_input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0, requests_with_usage: 0 };
  }
  _state.tokenTotals.fresh_input += fresh;
  _state.tokenTotals.cache_read += cacheR;
  _state.tokenTotals.cache_write += cacheW;
  _state.tokenTotals.output += output;
  _state.tokenTotals.total += fresh + cacheR + cacheW + output;
  _state.tokenTotals.requests_with_usage += 1;
  scheduleSave();
}

export function recordPolicyBlocked(sample = null) {
  _state.policyBlockedCount = (_state.policyBlockedCount || 0) + 1;
  if (sample) {
    if (!Array.isArray(_state.recentPolicyBlocks)) _state.recentPolicyBlocks = [];
    _state.recentPolicyBlocks.push(sample);
    const CAP = Number(process.env.POLICY_BLOCK_RING) || 50;
    if (_state.recentPolicyBlocks.length > CAP) {
      _state.recentPolicyBlocks.splice(0, _state.recentPolicyBlocks.length - CAP);
    }
  }
  scheduleSave();
}

export function recordRateLimited() {
  _state.rateLimitedCount = (_state.rateLimitedCount || 0) + 1;
  scheduleSave();
}

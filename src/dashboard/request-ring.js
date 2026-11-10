/**
 * Bounded request ring for dashboard troubleshooting.
 *
 * One row per completed /v1/chat/completions call. The ring is deliberately
 * metadata-only: no headers, no prompt text, no upstream body. Callers are
 * identified by a short hash so an operator can correlate repeated requests
 * without the dashboard retaining an API key.
 *
 * The cursor is an opaque base64url of `${ts}:${id}`; rows are returned
 * newest-first. This is a process-local snapshot and resets on restart.
 */

import { createHash } from 'node:crypto';

const CAP = 2000;
const rows = [];
let next = 0;
let count = 0;
let seq = 0;

function callerRef(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function encodeCursor(row) {
  return Buffer.from(`${row.ts}:${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx <= 0) return null;
    const ts = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(ts) || !id) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

/** Record one completed request. `row` is copied; unknown fields are dropped. */
export function recordRequest(row = {}) {
  const id = String(row.id || `ring_${++seq}`);
  const entry = {
    id,
    ts: Number.isFinite(row.ts) ? row.ts : Date.now(),
    model: typeof row.model === 'string' ? row.model.slice(0, 200) : null,
    selector: typeof row.selector === 'string' ? row.selector.slice(0, 200) : null,
    status: Number.isFinite(row.status) ? row.status : null,
    stream: !!row.stream,
    durationMs: Number.isFinite(row.durationMs) ? Math.max(0, Math.round(row.durationMs)) : null,
    class: typeof row.class === 'string' ? row.class.slice(0, 80) : null,
    protocol: typeof row.protocol === 'string' ? row.protocol.slice(0, 32) : null,
    caller: callerRef(row.caller),
  };
  rows[next] = entry;
  next = (next + 1) % CAP;
  count = Math.min(count + 1, CAP);
  return entry;
}

/**
 * Patch an existing row in place (used by streaming routes after the handler
 * finishes). Only the fields the ring owns are copied; unknown fields are
 * ignored. Returns the row or null when the id is no longer in the ring.
 */
export function updateRequest(id, patch = {}) {
  const key = String(id || '');
  if (!key) return null;
  const row = rows.find((r) => r && r.id === key);
  if (!row) return null;
  if (Number.isFinite(patch.durationMs)) row.durationMs = Math.max(0, Math.round(patch.durationMs));
  if (Number.isFinite(patch.status)) row.status = patch.status;
  if (typeof patch.class === 'string') row.class = patch.class.slice(0, 80);
  if (typeof patch.stream === 'boolean') row.stream = patch.stream;
  return row;
}

/** Newest-first page. `filter` supports model/status/class exact matches. */
export function listRequests({ cursor = null, limit = 50, filter = {} } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const anchor = decodeCursor(cursor);
  const out = [];
  const start = count < CAP ? 0 : next;
  for (let i = 0; i < count; i++) {
    const idx = (start + count - 1 - i) % CAP;
    const row = rows[idx];
    if (!row) continue;
    if (anchor && !(row.ts < anchor.ts || (row.ts === anchor.ts && row.id < anchor.id))) continue;
    if (filter.model && row.model !== filter.model) continue;
    if (filter.status != null && row.status !== Number(filter.status)) continue;
    if (filter.class && row.class !== filter.class) continue;
    out.push(row);
    if (out.length >= n) break;
  }
  return {
    items: out,
    nextCursor: out.length === n ? encodeCursor(out[out.length - 1]) : null,
    total: count,
    capacity: CAP,
  };
}

export function requestRingStats() {
  return { total: count, capacity: CAP };
}

/** Test seam: empty the ring without touching production state. */
export function __resetRequestRingForTest() {
  rows.length = 0;
  next = 0;
  count = 0;
  seq = 0;
}

/**
 * Optional Langfuse export of per-request accounting (default OFF).
 *
 * Enabled when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both set (and
 * LANGFUSE_ENABLED is not "0"). Each HTTP request that recorded at least one
 * upstream attempt becomes one trace: a root span for the request plus one
 * `generation` observation per attempt row (failover attempts included), with
 * model, account, latency, status and token usage.
 *
 * Transport is OTLP/HTTP JSON to `<base>/api/public/otel/v1/traces` — the
 * legacy /api/public/ingestion API is sunset on Langfuse Cloud — so this needs
 * no SDK and keeps the project at zero runtime dependencies. Only metadata and
 * token counts are exported; prompt and completion text never leave the proxy.
 * Delivery is best-effort: a bounded in-memory queue flushed on a timer, and a
 * failed batch is dropped with a throttled warning rather than retried forever.
 */

import { randomBytes } from 'node:crypto';
import { log } from './config.js';
import { accountRef } from './log-safety.js';
import { getAccountList } from './auth.js';

const env = process.env;
const QUEUE_CAP = 2000;
const FLUSH_BATCH = 200;
const LABEL_TTL_MS = 30_000;
const WARN_EVERY_MS = 60_000;

export function langfuseConfig(source = env) {
  const publicKey = String(source.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = String(source.LANGFUSE_SECRET_KEY || '').trim();
  const baseUrl = String(source.LANGFUSE_BASE_URL || source.LANGFUSE_HOST || 'https://cloud.langfuse.com')
    .trim().replace(/\/+$/, '');
  const flushMs = Math.max(1000, parseInt(source.LANGFUSE_FLUSH_MS || '', 10) || 5000);
  const enabled = source.LANGFUSE_ENABLED !== '0' && !!publicKey && !!secretKey;
  return { enabled, publicKey, secretKey, baseUrl, flushMs };
}

const cfg = langfuseConfig();
let _queue = [];
let _timer = null;
let _lastWarn = 0;
let _labels = null;
let _labelsAt = 0;

export function isLangfuseEnabled() { return cfg.enabled; }

const hex = (bytes) => randomBytes(bytes).toString('hex');
const nanos = (ms) => `${BigInt(Math.max(0, Math.round(ms))) * 1_000_000n}`;

function attr(key, value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) {
    return { key, value: { arrayValue: { values: value.map(v => ({ stringValue: String(v) })) } } };
  }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: String(value) } };
}

const attrs = (list) => list.filter(Boolean);

function defaultLabelFor(ref) {
  const now = Date.now();
  if (!_labels || now - _labelsAt > LABEL_TTL_MS) {
    _labels = new Map();
    try {
      for (const a of getAccountList({ view: 'summary' })) {
        if (a?.id) _labels.set(accountRef(a.id), a.label || a.email || a.displayName || a.id);
      }
    } catch { /* pool not ready — fall back to refs */ }
    _labelsAt = now;
  }
  return _labels.get(ref) || null;
}

/**
 * Build OTLP spans for one finished request. Pure (ids/label lookup injected)
 * so it can be tested without network or a live account pool.
 */
export function buildRequestSpans(rows, { method = 'POST', path = '', status = null, labelFor = defaultLabelFor, ids = hex } = {}) {
  const attempts = (rows || []).filter(r => r && typeof r === 'object');
  if (!attempts.length) return [];
  const traceId = ids(16);
  const rootId = ids(8);
  const last = attempts[attempts.length - 1];
  const finalStatus = Number.isFinite(status) ? status : Number(last.status) || (last.success ? 200 : 500);
  const ok = finalStatus < 400;
  const accountLabel = (ref) => (ref ? labelFor(ref) || ref : null);
  const user = accountLabel(last.account);
  const traceName = `${method} ${path}`.trim();
  const tags = ['windsurfapi', ...new Set(attempts.map(r => r.model).filter(Boolean))];
  // Trace-level attributes go on every span so Langfuse can filter observations.
  const shared = attrs([
    attr('langfuse.trace.name', traceName),
    attr('langfuse.user.id', user),
    attr('langfuse.trace.tags', tags),
    attr('langfuse.trace.metadata.account_ref', last.account),
    attr('langfuse.trace.metadata.http_status', finalStatus),
  ]);
  const start = Math.min(...attempts.map(r => (Number(r.ts) || 0) - (Number(r.ms) || 0)));
  const end = Math.max(...attempts.map(r => Number(r.ts) || 0));
  const spans = [{
    traceId, spanId: rootId, name: traceName || 'request', kind: 2,
    startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
    attributes: attrs([
      ...shared,
      attr('langfuse.observation.type', 'span'),
      attr('langfuse.observation.level', ok ? 'DEFAULT' : 'ERROR'),
      attr('langfuse.observation.status_message', `HTTP ${finalStatus}`),
      attr('langfuse.observation.metadata.attempts', attempts.length),
    ]),
    status: { code: ok ? 1 : 2, message: ok ? '' : `HTTP ${finalStatus}` },
  }];
  attempts.forEach((r, i) => {
    const rowStatus = Number(r.status) || (r.success ? 200 : 500);
    const tokensIn = Number(r.tokensIn) || 0;
    const cacheRead = Number(r.cacheRead) || 0;
    const cacheWrite = Number(r.cacheWrite) || 0;
    const usage = {
      input: Math.max(0, tokensIn - cacheRead - cacheWrite),
      input_cache_read: cacheRead,
      input_cache_creation: cacheWrite,
      output: Number(r.tokensOut) || 0,
    };
    spans.push({
      traceId, spanId: ids(8), parentSpanId: rootId, name: r.model || 'upstream', kind: 3,
      startTimeUnixNano: nanos((Number(r.ts) || 0) - (Number(r.ms) || 0)),
      endTimeUnixNano: nanos(Number(r.ts) || 0),
      attributes: attrs([
        ...shared,
        attr('langfuse.observation.type', 'generation'),
        attr('gen_ai.request.model', r.model),
        attr('langfuse.observation.usage_details', JSON.stringify(usage)),
        attr('langfuse.observation.level', r.success ? 'DEFAULT' : 'ERROR'),
        attr('langfuse.observation.status_message', `HTTP ${rowStatus}`),
        attr('langfuse.observation.metadata.account', accountLabel(r.account)),
        attr('langfuse.observation.metadata.account_ref', r.account),
        attr('langfuse.observation.metadata.http_status', rowStatus),
        attr('langfuse.observation.metadata.attempt', i + 1),
        attr('langfuse.observation.metadata.credits', Number(r.credit) || 0),
        r.cacheServed ? attr('langfuse.observation.metadata.cache_served', true) : null,
      ]),
      status: { code: r.success ? 1 : 2, message: r.success ? '' : `HTTP ${rowStatus}` },
    });
  });
  return spans;
}

export function buildOtlpPayload(spans) {
  return {
    resourceSpans: [{
      resource: { attributes: attrs([attr('service.name', 'windsurfapi')]) },
      scopeSpans: [{ scope: { name: 'windsurfapi.stats' }, spans }],
    }],
  };
}

/** Queue one finished request (called once per HTTP request scope). */
export function exportRequestToLangfuse(scope, meta = {}) {
  if (!cfg.enabled || !scope?.rows?.length) return;
  try {
    const spans = buildRequestSpans(scope.rows, { ...meta, status: scope.status });
    _queue.push(...spans);
    if (_queue.length > QUEUE_CAP) _queue.splice(0, _queue.length - QUEUE_CAP);
    if (!_timer) {
      _timer = setInterval(() => { void flushLangfuse(); }, cfg.flushMs);
      _timer.unref?.();
    }
  } catch (err) {
    warn(`build failed: ${err?.message || err}`);
  }
}

function warn(msg) {
  const now = Date.now();
  if (now - _lastWarn < WARN_EVERY_MS) return;
  _lastWarn = now;
  log.warn(`Langfuse export: ${msg}`);
}

/** Send queued spans. Safe to call concurrently and on shutdown. */
export async function flushLangfuse() {
  if (!cfg.enabled || !_queue.length) return;
  const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64');
  while (_queue.length) {
    const batch = _queue.splice(0, FLUSH_BATCH);
    try {
      const res = await fetch(`${cfg.baseUrl}/api/public/otel/v1/traces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
          'x-langfuse-ingestion-version': '4',
        },
        body: JSON.stringify(buildOtlpPayload(batch)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        warn(`HTTP ${res.status} — dropped ${batch.length} span(s)`);
        return;
      }
    } catch (err) {
      warn(`${err?.name || 'error'} — dropped ${batch.length} span(s)`);
      return;
    }
  }
}

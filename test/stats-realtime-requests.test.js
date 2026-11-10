// Fine-grained chart buckets, the request-records panel feed (outcome filter +
// account labels) and the optional Langfuse OTLP export.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  exportStats, getRequestLog, getStats, importStats, recordRequest, resetStats, RECENT_REQ_CAP,
} from '../src/dashboard/stats.js';
import { buildAccountLabelIndex, handleDashboardApi } from '../src/dashboard/api.js';
import { accountRef } from '../src/log-safety.js';
import { buildOtlpPayload, buildRequestSpans, langfuseConfig } from '../src/langfuse.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return JSON.parse(this.body); },
  };
}

const authed = (path) => ({
  url: `/dashboard/api${path}`,
  headers: { 'x-dashboard-password': 'dash-secret' },
  socket: { remoteAddress: '127.0.0.1' },
});

beforeEach(() => resetStats());
afterEach(() => {
  resetStats();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
});

describe('15-minute buckets', () => {
  it('records the current quarter-hour, including the slot still in progress', () => {
    recordRequest('m', true, 10, 'a1');
    recordRequest('m', false, 10, 'a1');
    const { quarterBuckets } = getStats();
    assert.equal(quarterBuckets.length, 1);
    const start = Date.parse(quarterBuckets[0].hour);
    assert.equal(start % (15 * 60 * 1000), 0, 'bucket key is quarter-hour aligned');
    assert.ok(Date.now() - start < 15 * 60 * 1000, 'the live slot is the newest bucket');
    assert.equal(quarterBuckets[0].requests, 2);
    assert.equal(quarterBuckets[0].errors, 1);
  });

  it('survives export → replace import and validates bucket keys', () => {
    recordRequest('m', true, 10, 'a1');
    const snap = exportStats();
    resetStats();
    assert.equal(importStats(snap, { mode: 'replace' }).ok, true);
    assert.equal(getStats().quarterBuckets[0].requests, 1);
    assert.equal(importStats({ quarterBuckets: [{ hour: 'nope', requests: 1 }] }).ok, false);
  });
});

describe('request ring', () => {
  it('ships a bounded window from getStats while exportStats keeps the full ring', () => {
    assert.ok(RECENT_REQ_CAP >= 5000);
    const rows = Array.from({ length: 900 }, (_, i) => ({ ts: 1000 + i, model: 'm', success: true }));
    assert.equal(importStats({ recentRequests: rows }, { mode: 'replace' }).ok, true);
    assert.equal(exportStats().recentRequests.length, 900);
    const view = getStats().recentRequests;
    assert.equal(view.length, 500);
    assert.equal(view[view.length - 1].ts, 1899, 'the newest rows are the ones kept');
  });

  it('filters the log by outcome', () => {
    importStats({ recentRequests: [
      { ts: 1, model: 'a', success: true, account: 'x' },
      { ts: 2, model: 'b', success: false, account: 'x' },
      { ts: 3, model: 'c', success: true, account: 'y' },
    ] }, { mode: 'replace' });
    assert.deepEqual(getRequestLog({ outcome: 'success' }).items.map(r => r.model), ['c', 'a']);
    assert.deepEqual(getRequestLog({ outcome: 'error' }).items.map(r => r.model), ['b']);
    assert.equal(getRequestLog({}).total, 3);
  });
});

describe('cache hit accounting', () => {
  it('derives fresh input and hit rate per row, null when no cache usage was reported', () => {
    importStats({ recentRequests: [
      { ts: 1, model: 'm', success: true, account: 'a', tokensIn: 1000, cacheRead: 900, cacheWrite: 50 },
      { ts: 2, model: 'm', success: true, account: 'a', tokensIn: 400, cacheRead: 0, cacheWrite: 400 },
      { ts: 3, model: 'm', success: true, account: 'a', tokensIn: 700, cacheRead: 0, cacheWrite: 0 },
    ] }, { mode: 'replace' });
    const byTs = Object.fromEntries(getRequestLog({}).items.map(r => [r.ts, r]));
    assert.equal(byTs[1].freshIn, 50);
    assert.equal(byTs[1].cacheHitRate, 0.9);
    assert.equal(byTs[2].freshIn, 0);
    assert.equal(byTs[2].cacheHitRate, 0, 'a reported full miss is a real 0%');
    assert.equal(byTs[3].freshIn, 700);
    assert.equal(byTs[3].cacheHitRate, null, 'no cache fields means unknown, not 0%');
  });

  it('aggregates the hit rate over reporting rows only', () => {
    importStats({ recentRequests: [
      { ts: 1, model: 'm', success: true, account: 'a', tokensIn: 1000, cacheRead: 800, cacheWrite: 0 },
      { ts: 2, model: 'm', success: true, account: 'a', tokensIn: 9000, cacheRead: 0, cacheWrite: 0 },
      { ts: 3, model: 'm', success: true, account: 'b', tokensIn: 500, cacheRead: 0, cacheWrite: 0 },
    ] }, { mode: 'replace' });
    const log = getRequestLog({});
    const a = log.byAccount.find(r => r.account === accountRef('a'));
    const b = log.byAccount.find(r => r.account === accountRef('b'));
    assert.equal(a.cacheHitRate, 0.8, 'the unreported 9000 must not dilute the rate');
    assert.equal(b.cacheHitRate, null);
    assert.equal(a.freshIn, 9200);
    assert.equal(log.summary.cacheHitRate, 0.8);
    assert.ok(!('_cacheReportedIn' in log.summary), 'internal accumulator is not exposed');
  });
});

describe('account labels', () => {
  it('maps the opaque ref to the operator label, falling back to email then id', () => {
    const labels = buildAccountLabelIndex([
      { id: 'id-1', label: 'Team Max', email: 'a@x.dev' },
      { id: 'id-2', email: 'b@x.dev' },
      { id: 'id-3' },
    ]);
    assert.equal(labels[accountRef('id-1')], 'Team Max');
    assert.equal(labels[accountRef('id-2')], 'b@x.dev');
    assert.equal(labels[accountRef('id-3')], 'id-3');
  });

  it('is attached to /stats and /stats/log responses', async () => {
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    for (const path of ['/stats', '/stats/log?outcome=error']) {
      const res = fakeRes();
      await handleDashboardApi('GET', path.split('?')[0], {}, authed(path), res);
      assert.equal(res.statusCode, 200);
      assert.equal(typeof res.json().accountLabels, 'object');
    }
  });
});

describe('Langfuse export', () => {
  it('is off unless both keys are present', () => {
    assert.equal(langfuseConfig({}).enabled, false);
    assert.equal(langfuseConfig({ LANGFUSE_PUBLIC_KEY: 'pk' }).enabled, false);
    const on = langfuseConfig({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_HOST: 'http://lf:3000/' });
    assert.equal(on.enabled, true);
    assert.equal(on.baseUrl, 'http://lf:3000');
    assert.equal(langfuseConfig({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_ENABLED: '0' }).enabled, false);
  });

  it('turns one request scope into a root span plus one generation per attempt', () => {
    let n = 0;
    const ids = (bytes) => String(++n).padStart(bytes * 2, '0');
    const rows = [
      { ts: 2000, ms: 500, model: 'swe-2-high', success: false, status: 429, account: 'acct-aaaaaaaa', tokensIn: 0, tokensOut: 0 },
      { ts: 5000, ms: 2000, model: 'swe-2-high', success: true, status: 200, account: 'acct-bbbbbbbb',
        tokensIn: 120, cacheRead: 20, cacheWrite: 0, tokensOut: 30, credit: 9 },
    ];
    const spans = buildRequestSpans(rows, {
      method: 'POST', path: '/v1/chat/completions', status: 200, ids,
      labelFor: (ref) => (ref === 'acct-bbbbbbbb' ? 'max-account' : null),
    });
    assert.equal(spans.length, 3);
    const [root, failed, served] = spans;
    const get = (span, key) => span.attributes.find(a => a.key === key)?.value;
    assert.equal(root.name, 'POST /v1/chat/completions');
    assert.equal(root.startTimeUnixNano, String(1500n * 1_000_000n));
    assert.equal(root.endTimeUnixNano, String(5000n * 1_000_000n));
    assert.ok(spans.every(s => s.traceId === root.traceId));
    assert.ok(failed.parentSpanId === root.spanId && served.parentSpanId === root.spanId);
    assert.equal(get(root, 'langfuse.user.id').stringValue, 'max-account', 'user = account that served');
    assert.equal(get(failed, 'langfuse.observation.level').stringValue, 'ERROR');
    assert.equal(get(failed, 'langfuse.observation.metadata.account').stringValue, 'acct-aaaaaaaa', 'unknown ref falls back');
    assert.equal(get(served, 'langfuse.observation.type').stringValue, 'generation');
    assert.equal(get(served, 'gen_ai.request.model').stringValue, 'swe-2-high');
    assert.deepEqual(JSON.parse(get(served, 'langfuse.observation.usage_details').stringValue),
      { input: 100, input_cache_read: 20, input_cache_creation: 0, output: 30 });
    const payload = buildOtlpPayload(spans);
    assert.equal(payload.resourceSpans[0].scopeSpans[0].spans.length, 3);
    assert.ok(!JSON.stringify(payload).includes('prompt'), 'no prompt text is exported');
  });

  it('exports nothing for a request without attempt rows', () => {
    assert.deepEqual(buildRequestSpans([]), []);
  });
});

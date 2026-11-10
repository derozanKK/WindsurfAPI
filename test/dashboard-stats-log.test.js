// Request log for the stats panel: per-request rows that join the attempt
// (model/account/status/latency/credit) with its usage block (tokens in/out).
//
// The join is the risky part: recordRequest and recordTokenUsage are called at
// different depths and in either order, and the server is concurrent. These
// tests pin the async-scope join, the query filters/pagination, and the
// aggregate arithmetic (table and aggregates must share one denominator).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  finalizeStatsScope,
  getRequestLog,
  importStats,
  recordRequest,
  recordTokenUsage,
  resetStats,
  withStatsScope,
} from '../src/dashboard/stats.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { accountRef } from '../src/log-safety.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function req(path, headers = {}) {
  return { url: `/dashboard/api${path}`, headers, socket: { remoteAddress: '127.0.0.1' } };
}

function authed(path, extra = {}) {
  return req(path, { 'x-dashboard-password': 'dash-secret', ...extra });
}

function seed(rows) {
  const result = importStats({ recentRequests: rows }, { mode: 'replace' });
  assert.equal(result.ok, true, 'seed snapshot must import');
}

function row(i, overrides = {}) {
  return {
    ts: 1_700_000_000_000 + i * 1000,
    model: 'm',
    success: true,
    ms: 100 + i,
    account: 'acct0001',
    credit: 0,
    ...overrides,
  };
}

beforeEach(() => {
  resetStats();
  _resetRuntimeConfigForTests();
});

afterEach(() => {
  resetStats();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  _resetRuntimeConfigForTests();
});

describe('request log scope join', () => {
  it('attaches usage recorded after the attempt row', () => {
    withStatsScope(() => {
      recordRequest('m-after', true, 25, 'acct-after');
      recordTokenUsage({ prompt_tokens: 10, completion_tokens: 4 }, 'm-after');
    });
    const page = getRequestLog({ model: 'm-after' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].tokensIn, 10);
    assert.equal(page.items[0].tokensOut, 4);
  });

  it('holds usage that arrives before the attempt row', () => {
    withStatsScope(() => {
      recordTokenUsage({ prompt_tokens: 7, completion_tokens: 3 }, 'm-before');
      recordRequest('m-before', true, 30, 'acct-before');
    });
    const page = getRequestLog({ model: 'm-before' });
    assert.equal(page.items[0].tokensIn, 7);
    assert.equal(page.items[0].tokensOut, 3);
  });

  it('never crosses concurrent scopes, even for the same model', async () => {
    await Promise.all([
      withStatsScope(async () => {
        recordRequest('same-model', true, 10, 'acct-a');
        await new Promise(resolve => setTimeout(resolve, 15));
        recordTokenUsage({ prompt_tokens: 11, completion_tokens: 1 }, 'same-model');
      }),
      withStatsScope(async () => {
        recordRequest('same-model', true, 20, 'acct-b');
        recordTokenUsage({ prompt_tokens: 22, completion_tokens: 2 }, 'same-model');
      }),
    ]);
    const page = getRequestLog({ model: 'same-model' });
    const byAccount = Object.fromEntries(page.items.map(r => [r.account, r]));
    assert.equal(byAccount[accountRef('acct-a')].tokensIn, 11);
    assert.equal(byAccount[accountRef('acct-a')].tokensOut, 1);
    assert.equal(byAccount[accountRef('acct-b')].tokensIn, 22);
    assert.equal(byAccount[accountRef('acct-b')].tokensOut, 2);
  });

  it('counts cache read/write as billable input and keeps the breakdown', () => {
    withStatsScope(() => {
      recordRequest('cache-model', true, 40, null);
      recordTokenUsage({
        prompt_tokens: 100,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 40 },
        cache_creation_input_tokens: 5,
      }, 'cache-model');
    });
    const item = getRequestLog({ model: 'cache-model' }).items[0];
    assert.equal(item.cacheRead, 40);
    assert.equal(item.cacheWrite, 5);
    assert.equal(item.tokensIn, 105, 'fresh 60 + cache read 40 + cache write 5');
    assert.equal(item.tokensOut, 9);
  });

  it('stamps the final HTTP status on the last attempt only', () => {
    const scope = { rows: [], pendingUsage: null, status: 451 };
    withStatsScope((s) => {
      Object.assign(scope, s, { status: 451 });
      recordRequest('attempt-model', false, 5, null);
      recordRequest('attempt-model', true, 6, null);
    });
    finalizeStatsScope(scope);
    // withStatsScope reused the object passed in only for assertions; the rows
    // live on that same scope object.
    const page = getRequestLog({ model: 'attempt-model' });
    assert.deepEqual(page.items.map(r => r.status), [451, 500]);
  });

  it('keeps the success-derived status without a scope', () => {
    recordRequest('no-scope-ok', true, 1, null);
    recordRequest('no-scope-err', false, 1, null);
    const page = getRequestLog();
    const byModel = Object.fromEntries(page.items.map(r => [r.model, r.status]));
    assert.equal(byModel['no-scope-ok'], 200);
    assert.equal(byModel['no-scope-err'], 500);
  });
});

describe('GET /stats/log query', () => {
  beforeEach(() => {
    seed([
      row(0, { model: 'alpha', account: 'acct0001', status: 200, tokensIn: 10, tokensOut: 2, credit: 1 }),
      row(1, { model: 'beta', account: 'acct0002', status: 500, success: false, tokensIn: 0, tokensOut: 0, credit: 0 }),
      row(2, { model: 'alpha', account: 'acct0002', status: 200, tokensIn: 30, tokensOut: 6, credit: 3 }),
      row(3, { model: 'gamma', account: 'acct0001', status: 429, success: false, tokensIn: 0, tokensOut: 0, credit: 0 }),
    ]);
  });

  it('returns newest first with total and retention, not a page-sized total', () => {
    const page = getRequestLog({ limit: 2 });
    assert.deepEqual(page.items.map(r => r.model), ['gamma', 'alpha']);
    assert.equal(page.total, 4);
    assert.equal(page.hasMore, true);
    assert.equal(page.retention.stored, 4);
    assert.equal(page.retention.capacity, 500);
  });

  it('pages by offset and stops claiming more at the end', () => {
    const page = getRequestLog({ limit: 3, offset: 3 });
    assert.deepEqual(page.items.map(r => r.model), ['alpha']);
    assert.equal(page.hasMore, false);
  });

  it('filters by model, account, status and time window', () => {
    assert.deepEqual(getRequestLog({ model: 'alpha' }).items.map(r => r.model), ['alpha', 'alpha']);
    assert.deepEqual(getRequestLog({ account: accountRef('acct0002') }).items.map(r => r.account),
      [accountRef('acct0002'), accountRef('acct0002')]);
    assert.deepEqual(getRequestLog({ status: 200 }).items.map(r => r.status), [200, 200]);
    const from = 1_700_000_000_000 + 2 * 1000;
    const to = 1_700_000_000_000 + 3 * 1000;
    assert.deepEqual(getRequestLog({ from, to }).items.map(r => r.model), ['gamma', 'alpha']);
  });

  it('derives status for legacy rows that predate the status field', () => {
    seed([{ ts: 1_700_000_000_000, model: 'legacy-ok', success: true, ms: 1, account: null, credit: 0 },
      { ts: 1_700_000_001_000, model: 'legacy-err', success: false, ms: 1, account: null, credit: 0 }]);
    const page = getRequestLog();
    assert.deepEqual(page.items.map(r => [r.model, r.status]), [['legacy-err', 500], ['legacy-ok', 200]]);
    assert.equal(page.filters.statuses.includes(500), true);
  });

  it('aggregates over the whole filtered window, not the page', () => {
    const page = getRequestLog({ limit: 1 });
    assert.equal(page.summary.requests, 4);
    assert.equal(page.summary.success, 2);
    assert.equal(page.summary.errors, 2);
    assert.equal(page.summary.tokensIn, 40);
    assert.equal(page.summary.tokensOut, 8);
    assert.equal(page.summary.credits, 4);
    assert.equal(page.summary.avgMs, Math.round((100 + 101 + 102 + 103) / 4));

    const alpha = page.byModel.find(m => m.model === 'alpha');
    assert.equal(alpha.requests, 2);
    assert.equal(alpha.tokensIn, 40);
    assert.equal(alpha.tokensOut, 8);
    assert.equal(alpha.credits, 4);
    assert.equal(alpha.errors, 0);

    const acct2 = page.byAccount.find(a => a.account === accountRef('acct0002'));
    assert.equal(acct2.requests, 2);
    assert.equal(acct2.errors, 1);

    assert.equal(page.byDay.length, 1);
    assert.equal(page.byDay[0].requests, 4);
    assert.equal(page.byDay[0].errors, 2);
  });

  it('keeps filter options stable while a filter is active', () => {
    const page = getRequestLog({ model: 'alpha' });
    assert.deepEqual(page.filters.models, ['alpha', 'beta', 'gamma']);
    assert.deepEqual(page.filters.accounts, [accountRef('acct0001'), accountRef('acct0002')].sort());
    assert.deepEqual(page.filters.statuses, [200, 429, 500]);
  });
});

describe('GET /dashboard/api/stats/log', () => {
  beforeEach(() => {
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    seed([
      row(0, { model: 'alpha', account: 'acct0001', status: 200, tokensIn: 5, tokensOut: 1, credit: 2 }),
      row(1, { model: 'beta', account: 'acct0002', status: 502, success: false }),
    ]);
  });

  it('fails closed without dashboard auth', async () => {
    const res = fakeRes();
    await handleDashboardApi('GET', '/stats/log', {}, req('/stats/log'), res);
    assert.equal(res.statusCode, 401);
  });

  it('parses filters and pagination from the query string', async () => {
    const res = fakeRes();
    await handleDashboardApi('GET', '/stats/log', {}, authed('/stats/log?model=alpha&status=200&limit=10&offset=0'), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].model, 'alpha');
    assert.equal(body.items[0].tokensIn, 5);
    assert.equal(body.total, 1);
    assert.equal(body.summary.requests, 1);
  });

  it('clamps a hostile limit and keeps /stats compatible', async () => {
    const logRes = fakeRes();
    await handleDashboardApi('GET', '/stats/log', {}, authed('/stats/log?limit=99999'), logRes);
    assert.equal(logRes.statusCode, 200);
    assert.equal(logRes.json().limit, 200);

    const statsRes = fakeRes();
    await handleDashboardApi('GET', '/stats', {}, authed('/stats'), statsRes);
    assert.equal(statsRes.statusCode, 200);
    const stats = statsRes.json();
    assert.equal(typeof stats.totalRequests, 'number');
    assert.equal(typeof stats.modelCounts, 'object');
    assert.equal(typeof stats.tokenTotals, 'object');
    assert.equal(typeof stats.modelBilling, 'object');
    assert.equal(stats.accountAttribution.total, stats.totalRequests);
    assert.equal(stats.accountAttribution.attributed + stats.accountAttribution.unattributed, stats.totalRequests);
  });
});

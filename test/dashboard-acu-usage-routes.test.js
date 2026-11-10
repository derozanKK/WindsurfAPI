// Route guards for GET /dashboard/api/usage/orgs (Q3).
//
// The route is auth-gated, org-deduped, no-store, and never serializes the raw
// org id, the session token, or an account label/email.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addAccountByKey, configureBindHost, removeAccount, _resetLockoutForTests } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { __resetReadCache, __setFetchImplForTest, __setNowForTest } from '../src/dashboard/devin-read.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const createdAccounts = new Set();

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

function req(path, { password = 'acu-secret' } = {}) {
  const headers = password ? { 'x-dashboard-password': password } : {};
  return { url: `/dashboard/api${path}`, headers, socket: { remoteAddress: '127.0.0.1' } };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return JSON.stringify(body); },
  };
}

function addDevinAccount(token, label) {
  const account = addAccountByKey(token, label);
  createdAccounts.add(account.id);
  return account;
}

function installFetch() {
  const calls = [];
  __setFetchImplForTest(async (url, init) => {
    const parsed = new URL(url);
    const token = String(init?.headers?.Authorization || '').replace(/^Bearer\s+/, '');
    calls.push({ path: parsed.pathname + parsed.search, token, method: init?.method });
    if (parsed.pathname === '/api/users/current-membership') {
      return jsonResponse({ org: { org_id: 'org-route-test' } });
    }
    if (parsed.pathname.endsWith('/billing/quota/usage')) {
      return jsonResponse({ daily_percentage: 60, weekly_percentage: 70 });
    }
    if (parsed.pathname.endsWith('/billing/status')) {
      return jsonResponse({ plan_slug: 'pro', is_subscription_valid: true });
    }
    if (parsed.pathname.endsWith('/billing/usage/limits')) {
      return jsonResponse({ max_acu_limit: 30, max_total_session_acu_limit: null });
    }
    if (parsed.pathname.endsWith('/billing/usage/daily-usage')) {
      return jsonResponse({
        cycle_start: '2026-10-16T20:11:50+00:00',
        cycle_end: '2026-11-16T20:11:50+00:00',
        total: 9,
        days: [{ date: '2026-10-21', amount: 4, cumulative: 9 }],
        products: [{ view: 'sessions', total: 9, days: [] }],
      });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  });
  return calls;
}

afterEach(() => {
  __setFetchImplForTest(null);
  __setNowForTest(null);
  __resetReadCache();
  for (const id of createdAccounts) removeAccount(id);
  createdAccounts.clear();
  _resetLockoutForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
});

describe('GET /dashboard/api/usage/orgs', () => {
  it('requires dashboard auth', async () => {
    config.dashboardPassword = 'acu-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    addDevinAccount('devin-session-token$route-auth', 'route-auth');

    const res = fakeRes();
    await handleDashboardApi('GET', '/usage/orgs', {}, req('/usage/orgs', { password: '' }), res);
    assert.equal(res.statusCode, 401);
  });

  it('serves one deduped org with no-store and no raw identifiers', async () => {
    config.dashboardPassword = 'acu-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    addDevinAccount('devin-session-token$route-a1', 'route-alpha-one');
    addDevinAccount('devin-session-token$route-a2', 'route-alpha-two');
    const calls = installFetch();

    const res = fakeRes();
    await handleDashboardApi('GET', '/usage/orgs', {}, req('/usage/orgs'), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.orgs.length, 1, 'two accounts in one org collapse to one entry');
    assert.equal(body.orgs[0].accounts.length, 2);
    assert.equal(body.orgs[0].derived.acuLimit.value, 30);
    assert.equal(body.orgs[0].derived.used.value, 9);
    assert.equal(body.orgs[0].derived.remaining.value, 21);
    assert.equal(body.orgs[0].cycle.start, '2026-10-16T20:11:50+00:00');
    assert.equal(body.orgs[0].products.length, 1);
    assert.match(body.orgs[0].orgRef, /^orgref-[0-9a-f]{12}$/);

    assert.equal(calls.filter((call) => call.path.includes('/billing/usage/daily-usage')).length, 1);
    assert.ok(calls.every((call) => call.method === 'GET'));

    assert.equal(res.body.includes('org-route-test'), false);
    assert.equal(res.body.includes('devin-session-token$'), false);
    assert.equal(res.body.includes('route-alpha-one'), false);
    assert.equal(res.body.includes('route-alpha-two'), false);
  });

  it('serves the second load from cache and honours ?refresh=1', async () => {
    config.dashboardPassword = 'acu-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    addDevinAccount('devin-session-token$route-cache', 'route-cache');
    const calls = installFetch();

    const first = fakeRes();
    await handleDashboardApi('GET', '/usage/orgs', {}, req('/usage/orgs'), first);
    assert.equal(first.statusCode, 200);
    const afterFirst = calls.length;

    const second = fakeRes();
    await handleDashboardApi('GET', '/usage/orgs', {}, req('/usage/orgs'), second);
    assert.equal(second.json().orgs[0].cached, true);
    assert.equal(calls.length, afterFirst, 'fresh TTL cache absorbs the second load');

    const forced = fakeRes();
    await handleDashboardApi('GET', '/usage/orgs', {}, req('/usage/orgs?refresh=1'), forced);
    assert.equal(forced.statusCode, 200);
    assert.ok(calls.length > afterFirst, 'refresh=1 bypasses freshness');
  });

  it('returns 503 no_account when the pool has no Devin session token', async () => {
    config.dashboardPassword = 'acu-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/usage/orgs', {}, req('/usage/orgs'), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().ok, false);
    assert.equal(res.json().error, 'no_account');
    assert.deepEqual(res.json().orgs, []);
  });
});

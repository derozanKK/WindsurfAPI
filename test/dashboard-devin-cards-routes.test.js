// Route contract for the DevinMap cards:
//   GET  /accounts/:id/devin-cards
//   POST /accounts/:id/capacity-preflight
//
// Both inherit the dashboard auth gate (no new exemption), both 404 an unknown
// account, and neither may put a raw upstream key in the response.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addAccountByKey, configureBindHost, getAccountInternal, removeAccount, _resetLockoutForTests } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { __setPreflightDepsForTest } from '../src/dashboard/devin-cards.js';
import { clearLiveCatalogSelectors, setLiveCatalogSelectors } from '../src/devin-connect-models.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const created = new Set();

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

function addAccount(label) {
  const account = addAccountByKey(`route-key-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, label);
  created.add(account.id);
  return account;
}

afterEach(() => {
  for (const id of created) removeAccount(id);
  created.clear();
  __setPreflightDepsForTest({});
  clearLiveCatalogSelectors();
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  configureBindHost('0.0.0.0');
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
});

describe('GET /accounts/:id/devin-cards', () => {
  it('fails closed without dashboard auth', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/accounts/any/devin-cards', {}, req('/accounts/any/devin-cards'), res);
    assert.equal(res.statusCode, 401);
  });

  it('404s an unknown account', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/accounts/missing/devin-cards', {}, authed('/accounts/missing/devin-cards'), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'account_not_found');
  });

  it('returns the three local cards with a masked key and no raw credential', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const account = addAccount('cards-route');
    const live = getAccountInternal(account.id);

    const res = fakeRes();
    await handleDashboardApi('GET', `/accounts/${account.id}/devin-cards`, {}, authed(`/accounts/${account.id}/devin-cards`), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.match(body.accountRef, /^acct-[0-9a-f]{8}$/);
    assert.equal(body.ledger.acu.reason, 'no_billing_tag');
    assert.equal(typeof body.modelStatus.counts.total, 'number');
    assert.equal(body.key.expires.reason, 'not_observable');
    assert.ok(body.key.masked.includes('...'), 'the key must be masked');
    const raw = JSON.stringify(body);
    assert.equal(raw.includes(live.apiKey), false);
    assert.equal(raw.includes(live.apiKey.slice(0, 12)), false);
  });
});

describe('POST /accounts/:id/capacity-preflight', () => {
  it('fails closed without dashboard auth', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('POST', '/accounts/any/capacity-preflight', {}, req('/accounts/any/capacity-preflight'), res);
    assert.equal(res.statusCode, 401);
  });

  it('404s an unknown account', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('POST', '/accounts/missing/capacity-preflight', {}, authed('/accounts/missing/capacity-preflight'), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'account_not_found');
  });

  it('returns the local + upstream halves and reuses the 60 s cache', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const account = addAccount('preflight-route');
    setLiveCatalogSelectors(['gemini-2-5-flash', 'swe-1-6-slow']);
    let calls = 0;
    __setPreflightDepsForTest({
      rateLimit: async () => {
        calls += 1;
        return { hasCapacity: false, messagesRemaining: 0, maxMessages: 40, retryAfterMs: 30_000 };
      },
    });

    const first = fakeRes();
    await handleDashboardApi('POST', `/accounts/${account.id}/capacity-preflight`, { model: 'gemini-2.5-flash' }, authed(`/accounts/${account.id}/capacity-preflight`), first);
    assert.equal(first.statusCode, 200);
    const body = first.json();
    assert.equal(body.ok, true);
    assert.equal(body.selector, 'gemini-2-5-flash');
    assert.equal(body.upstream.state, 'limited');
    assert.equal(body.upstream.retryAfterMs, 30_000);
    assert.equal(body.cached, false);
    assert.equal(body.verdict, 'throttled');
    assert.equal(calls, 1);

    const second = fakeRes();
    await handleDashboardApi('POST', `/accounts/${account.id}/capacity-preflight`, { model: 'gemini-2.5-flash' }, authed(`/accounts/${account.id}/capacity-preflight`), second);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().cached, true);
    assert.equal(calls, 1);
  });

  it('shows unknown rather than ok when the upstream probe fails', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const account = addAccount('preflight-route-throw');
    __setPreflightDepsForTest({ rateLimit: async () => { throw new Error('boom'); } });

    const res = fakeRes();
    await handleDashboardApi('POST', `/accounts/${account.id}/capacity-preflight`, {}, authed(`/accounts/${account.id}/capacity-preflight`), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.upstream.state, 'unknown');
    assert.equal(body.upstream.error, 'upstream_unreachable');
    assert.notEqual(body.verdict, 'ok');
  });
});

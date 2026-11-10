// Per-account request history: the ring in auth.js and its dashboard route.
//
// The feature exists because neither existing request log can attribute a call
// to an account: stats.recentRequests stores the upstream KEY at most chat call
// sites, and request-ring rows are keyed by a caller hash. These tests pin the
// ring's honesty rules — newest-first, bounded, per-account, billed-only — and
// the route contract (auth gate inherited, 404 unknown, no key material).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  ACCOUNT_REQUEST_CAP,
  __resetAccountRequestsForTest,
  addAccountByKey,
  configureBindHost,
  forgetAccountRequests,
  getAccountRequests,
  recordAccountAttempt,
  recordAccountRequest,
  recordAccountSpend,
  removeAccount,
  _resetLockoutForTests,
} from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

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
  const account = addAccountByKey(`req-key-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, label);
  created.add(account.id);
  return account;
}

beforeEach(() => {
  __resetAccountRequestsForTest();
});

afterEach(() => {
  for (const id of created) removeAccount(id);
  created.clear();
  __resetAccountRequestsForTest();
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  configureBindHost('0.0.0.0');
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
});

describe('account request ring', () => {
  it('returns newest first and keeps the whole-window totals', () => {
    const acct = { id: 'ring-acct-1' };
    recordAccountRequest(acct, { model: 'a', usage: { prompt_tokens: 1, completion_tokens: 2 }, creditCost: 0.5, acuCost: 0.1, now: 100 });
    recordAccountRequest(acct, { model: 'b', usage: { prompt_tokens: 3, completion_tokens: 4 }, creditCost: 1, acuCost: 0.2, now: 200 });

    const page = getAccountRequests('ring-acct-1', { limit: 1 });
    assert.deepEqual(page.items.map((r) => r.model), ['b']);
    assert.equal(page.total, 2, 'total is the ring size, not the page size');
    assert.equal(page.billed, 2);
    assert.equal(page.failed, 0);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].billed, true, 'recordAccountRequest is billed by default');
    assert.deepEqual(page.summary, {
      requests: 2,
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
      credit: 1.5,
      acu: 0.30000000000000004,
      lastTs: 200,
    });
  });

  it('is bounded and drops the oldest row past the cap', () => {
    for (let i = 0; i < ACCOUNT_REQUEST_CAP + 3; i++) {
      recordAccountRequest({ id: 'ring-cap' }, { model: `m${i}`, now: i });
    }
    const page = getAccountRequests('ring-cap', { limit: ACCOUNT_REQUEST_CAP });
    assert.equal(page.total, ACCOUNT_REQUEST_CAP);
    assert.equal(page.items[0].model, `m${ACCOUNT_REQUEST_CAP + 2}`, 'newest row survives');
    assert.equal(page.items.at(-1).model, 'm3', 'the three oldest rows were evicted');
  });

  // P2 (wave-7 review): failed attempts and billed rows used to compete for the
  // same 100 slots, so a failure burst could evict every billed row and the
  // summary — recomputed from survivors — read as "this account served
  // nothing". Billed rows are the money truth: they are never evicted by a
  // failure.
  it('a failure burst cannot evict the billed window or zero its summary', () => {
    const acct = { id: 'ring-billed-reserve' };
    recordAccountRequest(acct, {
      model: 'claude-sonnet-4',
      usage: { prompt_tokens: 5, completion_tokens: 3 },
      creditCost: 2,
      acuCost: 1,
      now: 1,
    });
    const before = getAccountRequests(acct.id).summary;

    for (let i = 0; i < ACCOUNT_REQUEST_CAP; i++) {
      recordAccountAttempt(acct, { model: 'claude-sonnet-4', outcome: 'rate_limited', status: 429, now: 10 + i });
    }

    const page = getAccountRequests(acct.id, { limit: ACCOUNT_REQUEST_CAP });
    assert.equal(page.billed, 1, 'the billed row survives a full failure burst');
    assert.equal(page.failed, ACCOUNT_REQUEST_CAP - 1, 'failures share the window but stay bounded');
    assert.equal(page.total, ACCOUNT_REQUEST_CAP);
    assert.deepEqual(page.summary, before, 'the billed summary is byte-for-byte unchanged');
    assert.equal(page.items.filter((r) => r.billed === true).length, 1);
  });

  it('drops an incoming failure rather than evicting a billed row from a full billed window', () => {
    const acct = { id: 'ring-billed-full' };
    for (let i = 0; i < ACCOUNT_REQUEST_CAP; i++) {
      recordAccountRequest(acct, { model: `m${i}`, usage: { prompt_tokens: 1 }, now: i });
    }

    recordAccountAttempt(acct, { model: 'm0', outcome: 'rate_limited', status: 429, now: 1000 });

    const page = getAccountRequests(acct.id, { limit: ACCOUNT_REQUEST_CAP });
    assert.equal(page.billed, ACCOUNT_REQUEST_CAP);
    assert.equal(page.failed, 0, 'the failure had no slot it could take without evicting a billed row');
    assert.equal(page.total, ACCOUNT_REQUEST_CAP);
    assert.equal(page.items[0].model, `m${ACCOUNT_REQUEST_CAP - 1}`, 'the newest billed row is still newest');
    assert.equal(page.items.at(-1).model, 'm0', 'no billed row was evicted');
    assert.equal(page.summary.requests, ACCOUNT_REQUEST_CAP);
  });

  it('a newer billed row evicts the oldest failure before any billed row', () => {
    const acct = { id: 'ring-failure-first' };
    for (let i = 0; i < ACCOUNT_REQUEST_CAP - 1; i++) {
      recordAccountRequest(acct, { model: `m${i}`, now: i });
    }
    recordAccountAttempt(acct, { model: 'fail', outcome: 'upstream_error', status: 502, now: 500 });

    recordAccountRequest(acct, { model: 'newest', now: 600 });

    const page = getAccountRequests(acct.id, { limit: ACCOUNT_REQUEST_CAP });
    assert.equal(page.billed, ACCOUNT_REQUEST_CAP);
    assert.equal(page.failed, 0);
    assert.equal(page.items[0].model, 'newest');
    assert.ok(!page.items.some((r) => r.model === 'fail'), 'the failure was the row evicted');
    assert.equal(page.items.at(-1).model, 'm0', 'the oldest billed row was not displaced');
  });

  it('keeps accounts isolated and forgets a removed account', () => {
    recordAccountRequest({ id: 'iso-a' }, { model: 'a' });
    recordAccountRequest({ id: 'iso-b' }, { model: 'b' });
    assert.deepEqual(getAccountRequests('iso-a').items.map((r) => r.model), ['a']);
    assert.deepEqual(getAccountRequests('iso-b').items.map((r) => r.model), ['b']);
    forgetAccountRequests('iso-a');
    assert.equal(getAccountRequests('iso-a').total, 0);
    assert.equal(getAccountRequests('iso-b').total, 1);
  });

  it('clamps hostile usage instead of storing negatives', () => {
    recordAccountRequest({ id: 'clamp' }, {
      model: 42,
      usage: { prompt_tokens: -5, completion_tokens: 'x', total_tokens: -1 },
      creditCost: -3,
      acuCost: -1,
    });
    const row = getAccountRequests('clamp').items[0];
    assert.equal(row.model, '', 'a non-string model is not coerced into copy');
    assert.equal(row.promptTokens, 0);
    assert.equal(row.completionTokens, 0);
    assert.equal(row.totalTokens, 0);
    assert.equal(row.credit, 0);
    assert.equal(row.acu, 0);
  });

  it('only billed rows enter the billed summary; failures are counted separately', () => {
    const acct = addAccount('spend-attribution');
    recordAccountSpend(acct.apiKey, { prompt_tokens: 10, completion_tokens: 5 }, { creditCost: 2, acuCost: 0.25, model: 'claude-sonnet-4' });
    const before = getAccountRequests(acct.id);
    recordAccountAttempt({ id: acct.id }, { model: 'claude-sonnet-4', outcome: 'rate_limited', status: 429, attemptId: 'attempt-7' });
    // A request against a key that belongs to no account must not create a row,
    // and a failure with no account id belongs to nobody.
    recordAccountSpend('not-an-account-key', { prompt_tokens: 1 }, { model: 'x' });
    recordAccountAttempt(null, { model: 'x', outcome: 'upstream_error', status: 502 });

    const page = getAccountRequests(acct.id);
    assert.equal(page.total, 2, 'the failed attempt occupies a retained slot');
    assert.equal(page.billed, 1);
    assert.equal(page.failed, 1);
    // The billed summary is byte-for-byte what the success alone produced: the
    // failed row must not move a single counter or lastTs.
    assert.deepEqual(page.summary, before.summary, 'a failed row must not move the billed summary');
    assert.deepEqual(page.summary, {
      requests: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      credit: 2,
      acu: 0.25,
      lastTs: before.summary.lastTs,
    });
    const [failedRow, billedRow] = page.items;
    assert.equal(billedRow.model, 'claude-sonnet-4');
    assert.equal(billedRow.billed, true);
    assert.equal(failedRow.billed, false);
    assert.equal(failedRow.outcome, 'rate_limited');
    assert.equal(failedRow.status, 429);
    assert.equal(failedRow.attemptId, 'attempt-7');
    assert.equal(failedRow.totalTokens, 0);
    assert.equal(failedRow.promptTokens, 0);
    assert.equal(failedRow.completionTokens, 0);
    assert.equal(failedRow.credit, 0);
    assert.equal(failedRow.acu, 0);
  });

  it('refuses an unattributed failure instead of inventing an owner', () => {
    assert.equal(recordAccountAttempt(null, { model: 'x' }), null);
    assert.equal(recordAccountAttempt({}, { model: 'x' }), null);
    assert.equal(recordAccountAttempt({ id: '' }, { model: 'x' }), null);
    assert.equal(getAccountRequests('x').total, 0);
  });

  it('records CONNECT failure exits against the account that was attempted', () => {
    const acct = addAccount('connect-failures');
    acct.reservationTimestamp = 4242;
    const base = { model: 'swe-2', startTime: Date.now() };

    finalizeConnectAccount(acct, { ...base, err: Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' }) });
    finalizeConnectAccount(acct, { ...base, err: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
    finalizeConnectAccount(acct, { ...base, err: Object.assign(new Error('client gone'), { name: 'AbortError' }), aborted: true });

    const page = getAccountRequests(acct.id);
    assert.equal(page.billed, 0);
    assert.equal(page.failed, 3);
    assert.deepEqual(page.items.map((r) => [r.outcome, r.status]), [
      ['client_abort', 499],
      ['connection_error', 502],
      ['rate_limited', 429],
    ]);
    assert.equal(page.items[0].attemptId, '4242');
    assert.equal(page.items.every((r) => r.billed === false && r.credit === 0 && r.totalTokens === 0), true);
    assert.equal(page.summary.requests, 0);
    assert.equal(page.summary.totalTokens, 0);
    assert.equal(page.summary.credit, 0);
  });

  it('drops the ring when the account is removed', () => {
    const acct = addAccount('ring-removal');
    recordAccountSpend(acct.apiKey, { prompt_tokens: 1 }, { model: 'm' });
    assert.equal(getAccountRequests(acct.id).total, 1);
    removeAccount(acct.id);
    created.delete(acct.id);
    assert.equal(getAccountRequests(acct.id).total, 0);
  });
});

describe('GET /accounts/:id/requests', () => {
  it('fails closed without dashboard auth', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/accounts/any/requests', {}, req('/accounts/any/requests'), res);
    assert.equal(res.statusCode, 401);
  });

  it('404s an unknown account', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/accounts/missing/requests', {}, authed('/accounts/missing/requests'), res);
    assert.equal(res.statusCode, 404);
  });

  it('returns rows, totals and a hashed account ref — never the key', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const acct = addAccount('route-history');
    recordAccountSpend(acct.apiKey, { prompt_tokens: 4, completion_tokens: 6 }, { creditCost: 1, model: 'gemini-2.5-flash' });
    recordAccountAttempt({ id: acct.id }, { model: 'gemini-2.5-flash', outcome: 'rate_limited', status: 429 });

    const res = fakeRes();
    await handleDashboardApi('GET', `/accounts/${acct.id}/requests`, {}, authed(`/accounts/${acct.id}/requests?limit=10`), res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.total, 2, 'the window counts billed rows and failed attempts');
    assert.equal(body.billed, 1);
    assert.equal(body.failed, 1);
    assert.equal(body.capacity, ACCOUNT_REQUEST_CAP);
    assert.equal(body.items[0].billed, false, 'the failed attempt is the newest row');
    assert.equal(body.items[1].model, 'gemini-2.5-flash');
    assert.equal(body.items[1].totalTokens, 10);
    assert.equal(body.summary.requests, 1, 'the billed summary ignores the failed row');
    assert.equal(body.summary.totalTokens, 10);
    assert.equal(typeof body.accountRef, 'string');
    assert.ok(body.accountRef.length <= 16, 'the ref is a short hash, not an identifier');
    assert.equal(res.body.includes(acct.apiKey), false, 'the upstream key must never reach the response');
  });

  it('clamps a hostile limit instead of honouring it', async () => {
    _resetRuntimeConfigForTests();
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');
    const acct = addAccount('route-limit');
    for (let i = 0; i < 5; i++) recordAccountSpend(acct.apiKey, { prompt_tokens: 1 }, { model: `m${i}` });

    const res = fakeRes();
    await handleDashboardApi('GET', `/accounts/${acct.id}/requests`, {}, authed(`/accounts/${acct.id}/requests?limit=9999`), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().items.length <= ACCOUNT_REQUEST_CAP);
    assert.equal(res.json().total, 5);
  });
});

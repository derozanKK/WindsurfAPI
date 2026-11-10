// Dashboard account list query + batch routes (2026-10-22 account-UI merge).
//
// The merged 账号管理 page is server-paginated: search, tier, status and 仅异常
// are all query params, and "select all N results" is an id fetch, not a DOM
// walk. These tests pin the contract the page relies on:
//   - q matches email/id/label literally (no SQL LIKE wildcards)
//   - status resolves through the same precedence ladder the row badge uses
//   - total is counted with the SAME predicate as the rows (D10)
//   - /accounts/ids returns exactly the filtered set
//   - /accounts/batch reports per-item results and never hides partial failure
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  addAccountByKey,
  configureBindHost,
  getAccountInternal,
  markNeedsReauth,
  publicBanReason,
  removeAccount,
  resolveAccountState,
  setAccountStatus,
  _resetLockoutForTests,
} from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { probeOutcomeEntry, summarizeProbeResults } from '../src/dashboard/fleet-jobs.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const originalAllowNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
const createdAccounts = new Set();

afterEach(() => {
  for (const id of createdAccounts) removeAccount(id);
  createdAccounts.clear();
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  if (originalAllowNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = originalAllowNoAuth;
  configureBindHost('0.0.0.0');
});

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

function localReq(path) {
  return { url: `/dashboard/api${path}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

function enableOpenLocal() {
  _resetRuntimeConfigForTests();
  config.dashboardPassword = '';
  config.apiKey = '';
  configureBindHost('127.0.0.1');
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
}

async function get(path) {
  const res = fakeRes();
  await handleDashboardApi('GET', path.split('?')[0], {}, localReq(path), res);
  return { status: res.statusCode, body: res.json() };
}

async function post(path, body) {
  const res = fakeRes();
  await handleDashboardApi('POST', path, body, localReq(path), res);
  return { status: res.statusCode, body: res.json() };
}

function addTestAccount(label, patch = {}) {
  const account = addAccountByKey(`test-key-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, label);
  Object.assign(account, patch);
  createdAccounts.add(account.id);
  return account;
}

describe('GET /accounts query params', () => {
  it('searches email, id and label case-insensitively and treats %/_ literally', async () => {
    enableOpenLocal();
    const alpha = addTestAccount('alpha@example.invalid');
    const beta = addTestAccount('beta@example.invalid');
    Object.assign(getAccountInternal(beta.id), { label: 'Night Shift 100%_done' });

    const byEmail = await get('/accounts?view=summary&q=ALPHA');
    assert.equal(byEmail.status, 200);
    assert.deepEqual(byEmail.body.accounts.map((a) => a.id), [alpha.id]);

    const byId = await get(`/accounts?view=summary&q=${encodeURIComponent(alpha.id)}`);
    assert.deepEqual(byId.body.accounts.map((a) => a.id), [alpha.id]);

    const byLabel = await get(`/accounts?view=summary&q=${encodeURIComponent('100%_done')}`);
    assert.deepEqual(byLabel.body.accounts.map((a) => a.id), [beta.id],
      'q must be a literal substring: % and _ are not wildcards');

    const noWildcard = await get(`/accounts?view=summary&q=${encodeURIComponent('100%_d')}`);
    assert.equal(noWildcard.body.total, 1);
    const wildcardWouldMatch = await get(`/accounts?view=summary&q=${encodeURIComponent('100Xdone')}`);
    assert.equal(wildcardWouldMatch.body.total, 0);
  });

  it('filters by the precedence-resolved state and ignores unknown values', async () => {
    enableOpenLocal();
    const now = Date.now();
    const active = addTestAccount('state-active');
    const cooled = addTestAccount('state-cooled', { quotaResetAt: now + 3600_000 });
    const limited = addTestAccount('state-limited', { rateLimitedUntil: now + 3600_000 });
    const error = addTestAccount('state-error', { status: 'error' });
    const disabled = addTestAccount('state-disabled', { status: 'disabled' });
    const watch = addTestAccount('state-watch', { errorCount: 2 });

    for (const [state, expected] of [
      ['active', active.id],
      ['quota_cooled', cooled.id],
      ['rate_limited', limited.id],
      ['error', error.id],
      ['disabled', disabled.id],
      ['watch', watch.id],
    ]) {
      const r = await get(`/accounts?view=summary&status=${state}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.accounts.map((a) => a.id), [expected], `status=${state}`);
      assert.equal(r.body.total, 1);
      assert.equal(r.body.accounts[0].state, state, 'the payload carries the resolved state');
    }

    const ignored = await get('/accounts?view=summary&status=not-a-real-state');
    assert.equal(ignored.status, 200);
    assert.ok(ignored.body.total >= 6, 'unknown status is ignored, not a 400 or an empty pool');
  });

  it('counts total with the same predicate as the rows (D10: flagged + tier)', async () => {
    enableOpenLocal();
    const now = Date.now();
    // Flagged via errorCount, and pro; flagged via rate limit, and free.
    addTestAccount('d10-pro-flagged', { tier: 'pro', errorCount: 3 });
    addTestAccount('d10-pro-clean', { tier: 'pro' });
    addTestAccount('d10-free-flagged', { tier: 'free', rateLimitedUntil: now + 60_000 });
    addTestAccount('d10-free-clean', { tier: 'free' });

    const r = await get('/accounts?view=summary&filter=flagged&tier=pro&page=1&pageSize=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.accounts.length, 1);
    assert.equal(r.body.total, 1, 'total must honour filter AND tier, not byTier[tier] alone');
    assert.equal(r.body.hasMore, false);

    const both = await get('/accounts?view=summary&filter=flagged&tier=free');
    assert.equal(both.body.total, 1);
    assert.equal(both.body.accounts[0].tier, 'free');
  });

  it('sorts by the declared keys with unknown values last', async () => {
    enableOpenLocal();
    const low = addTestAccount('sort-low', { credits: { weeklyPercent: 5, balance: 1 } });
    const high = addTestAccount('sort-high', { credits: { weeklyPercent: 90, balance: 50 } });
    const unknown = addTestAccount('sort-unknown', { credits: null });

    const asc = await get('/accounts?view=summary&sort=quota_weekly&order=asc');
    assert.deepEqual(asc.body.accounts.map((a) => a.id), [low.id, high.id, unknown.id],
      'null quota sorts last in both directions');

    const desc = await get('/accounts?view=summary&sort=quota_weekly&order=desc');
    assert.deepEqual(desc.body.accounts.map((a) => a.id), [high.id, low.id, unknown.id]);

    const bal = await get('/accounts?view=summary&sort=balance&order=desc');
    assert.deepEqual(bal.body.accounts.map((a) => a.id), [high.id, low.id, unknown.id]);
  });

  it('returns the same filtered ids from /accounts/ids', async () => {
    enableOpenLocal();
    const pro = addTestAccount('ids-pro', { tier: 'pro' });
    addTestAccount('ids-free', { tier: 'free' });

    const r = await get('/accounts/ids?tier=pro');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ids, [pro.id]);
    assert.equal(r.body.total, 1);

    const all = await get('/accounts/ids');
    assert.equal(all.body.ids.length, 2);
    assert.equal(all.body.total, 2);
  });
});

describe('resolveAccountState precedence', () => {
  it('resolves disabled > banned > reauth > error > quota > rate > capacity > near-limit > watch > active', () => {
    const now = 1_000_000;
    assert.equal(resolveAccountState({ status: 'disabled', errorCount: 9 }, now), 'disabled');
    assert.equal(resolveAccountState({ status: 'banned', errorCount: 9 }, now), 'banned',
      'banned must outrank error/cooldowns: the credential itself was rejected');
    assert.equal(resolveAccountState({ status: 'banned', quotaResetAt: now + 1, rateLimitedUntil: now + 1 }, now), 'banned');
    assert.equal(resolveAccountState({ status: 'reauth', errorCount: 9 }, now), 'reauth',
      'a retired session token outranks every self-healing state: it never recovers on its own');
    assert.equal(resolveAccountState({ status: 'reauth', quotaResetAt: now + 1, rateLimitedUntil: now + 1 }, now), 'reauth');
    assert.equal(resolveAccountState({ status: 'reauth' }, now), 'reauth');
    assert.equal(resolveAccountState({ status: 'error', quotaResetAt: now + 1 }, now), 'error');
    assert.equal(resolveAccountState({ status: 'active', quotaResetAt: now + 1, rateLimitedUntil: now + 1 }, now), 'quota_cooled');
    assert.equal(resolveAccountState({ status: 'active', rateLimitedUntil: now + 1 }, now), 'rate_limited');
    assert.equal(resolveAccountState({ status: 'active', _modelRateLimits: { m: now + 1 } }, now), 'capacity');
    assert.equal(resolveAccountState({ status: 'active' }, now, { rpmUsed: 9, rpmLimit: 10 }), 'near_limit');
    assert.equal(resolveAccountState({ status: 'active', errorCount: 1 }, now), 'watch');
    assert.equal(resolveAccountState({ status: 'active' }, now), 'active');
    assert.equal(resolveAccountState({ status: 'active', quotaResetAt: now - 1, rateLimitedUntil: now - 1 }, now), 'active',
      'expired cooldowns do not keep an account in a warning state');
  });
});

describe('reauth accounts are visible and counted separately', () => {
  it('exposes state + evidence, matches status=reauth and filter=flagged, and counts once', async () => {
    enableOpenLocal();
    const benched = addTestAccount('reauth@example.invalid');
    markNeedsReauth(benched.id, { source: 'request', code: 'UNAUTHORIZED' });
    const healthy = addTestAccount('reauth-healthy@example.invalid');

    const byState = await get('/accounts?view=summary&status=reauth');
    assert.equal(byState.status, 200);
    assert.deepEqual(byState.body.accounts.map((a) => a.id), [benched.id]);
    const row = byState.body.accounts[0];
    assert.equal(row.state, 'reauth');
    assert.equal(row.status, 'reauth');
    assert.equal(row.reauth.source, 'request');
    assert.equal(row.reauth.code, 'UNAUTHORIZED');
    assert.ok(row.reauth.at > 0);

    const flagged = await get('/accounts?view=summary&filter=flagged');
    assert.deepEqual(flagged.body.accounts.map((a) => a.id), [benched.id],
      '仅异常 must include reauth accounts');
    assert.equal(flagged.body.stats.reauth, 1);
    assert.equal(flagged.body.stats.banned, 0);
    assert.ok(!flagged.body.accounts.some((a) => a.id === healthy.id),
      'a healthy account must not be pulled in by 仅异常');
  });
});

describe('banned accounts are visible as banned', () => {
  it('exposes state, bannedAt and a sanitized reason, and matches status=banned and filter=flagged', async () => {
    enableOpenLocal();
    const now = Date.now();
    const banned = addTestAccount('banned@example.invalid', {
      status: 'banned',
      bannedAt: now - 60_000,
      bannedReason: 'Your account has been suspended. Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 key sk-live-abcdefghijklmnop',
      errorCount: 2,
    });
    const healthy = addTestAccount('healthy@example.invalid');

    const byState = await get('/accounts?view=summary&status=banned');
    assert.equal(byState.status, 200);
    assert.deepEqual(byState.body.accounts.map((a) => a.id), [banned.id]);
    const row = byState.body.accounts[0];
    assert.equal(row.state, 'banned');
    assert.equal(row.bannedAt, now - 60_000);
    assert.match(row.bannedReason, /suspended/);
    assert.doesNotMatch(row.bannedReason, /abcdefghijklmnopqrstuvwxyz|sk-live/,
      'the ban reason must never carry a credential-shaped token');

    const flagged = await get('/accounts?view=summary&filter=flagged');
    assert.deepEqual(flagged.body.accounts.map((a) => a.id), [banned.id],
      '仅异常 must include banned accounts');
    assert.ok(flagged.body.stats.flagged >= 1);
    assert.equal(flagged.body.stats.disabled, 0,
      'banned is 需处理, not 已停用 — the KPI no longer double-counts it');
    assert.ok(flagged.body.stats.attention >= 1);
    assert.equal(flagged.body.stats.banned, 1);
    assert.ok(!flagged.body.accounts.some((a) => a.id === healthy.id),
      'a healthy account must not be pulled in by 仅异常');
  });

  it('clears the ban metadata when an operator explicitly re-enables the account', () => {
    enableOpenLocal();
    const account = addTestAccount('banned-reset', {
      status: 'banned',
      bannedAt: Date.now(),
      bannedReason: 'account banned',
      _banSignalAt: Date.now(),
      _banSignalCount: 2,
      _banSignalLastMessage: 'account banned',
    });
    assert.equal(setAccountStatus(account.id, 'active'), true);
    const stored = getAccountInternal(account.id);
    assert.equal(stored.status, 'active');
    assert.equal(stored.bannedAt, 0);
    assert.equal(stored.bannedReason, '');
    assert.equal(stored._banSignalCount, 0);
    assert.equal(resolveAccountState(stored), 'active');
  });

  it('caps and redacts the public ban reason', () => {
    assert.equal(publicBanReason(null), '');
    assert.equal(publicBanReason('  account   banned  '), 'account banned');
    assert.match(publicBanReason(`x ${'a'.repeat(60)} y`), /\[redacted\]/);
    assert.ok(publicBanReason('z'.repeat(400)).length <= 240);
  });
});

describe('probe outcome accounting', () => {
  it('never counts a skipped probe as success', () => {
    assert.deepEqual(probeOutcomeEntry('a', { skipped: true, reason: 'ls_not_running' }), {
      id: 'a', ok: false, skipped: true, reason: 'ls_not_running', tier: 'unknown',
    });
    assert.deepEqual(probeOutcomeEntry('b', { tier: 'pro' }), { id: 'b', ok: true, tier: 'pro' });
    assert.deepEqual(probeOutcomeEntry('c', null), { id: 'c', ok: false, error: 'ERR_ACCOUNT_NOT_FOUND' });
  });

  it('splits attempted/succeeded/failed/skipped and excludes skips from the attempted total', () => {
    const results = [
      { id: 'ok', ok: true },
      { id: 'fail', ok: false, error: 'boom' },
      { id: 'skip', ok: false, skipped: true, reason: 'ls_not_running' },
    ];
    assert.deepEqual(summarizeProbeResults(results), { attempted: 2, okCount: 1, failCount: 1, skippedCount: 1 });
    assert.deepEqual(summarizeProbeResults([]), { attempted: 0, okCount: 0, failCount: 0, skippedCount: 0 });
  });
});

describe('POST /accounts/batch', () => {
  it('runs each item and reports partial failure instead of a 500', async () => {
    enableOpenLocal();
    const a = addTestAccount('batch-a');
    const b = addTestAccount('batch-b');

    const disabled = await post('/accounts/batch', { ids: [a.id, b.id, 'missing-id'], op: 'disable' });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.success, true);
    assert.equal(disabled.body.okCount, 2);
    assert.equal(disabled.body.failCount, 1);
    assert.deepEqual(disabled.body.failed, [{ id: 'missing-id', ok: false, error: 'ERR_ACCOUNT_NOT_FOUND' }]);
    assert.equal(getAccountInternal(a.id).status, 'disabled');

    const enabled = await post('/accounts/batch', { ids: [a.id, b.id], op: 'enable' });
    assert.equal(enabled.body.okCount, 2);
    assert.equal(getAccountInternal(a.id).status, 'active');

    Object.assign(getAccountInternal(a.id), { errorCount: 4, status: 'error' });
    const reset = await post('/accounts/batch', { ids: [a.id], op: 'reset' });
    assert.equal(reset.body.okCount, 1);
    assert.equal(getAccountInternal(a.id).errorCount, 0);
    assert.equal(getAccountInternal(a.id).status, 'active');

    const deleted = await post('/accounts/batch', { ids: [b.id], op: 'delete' });
    assert.equal(deleted.body.okCount, 1);
    assert.equal(getAccountInternal(b.id), null);
    createdAccounts.delete(b.id);
  });

  it('dedupes ids and rejects an empty list, an unknown op and an oversized batch', async () => {
    enableOpenLocal();
    const a = addTestAccount('batch-dedupe');

    const dup = await post('/accounts/batch', { ids: [a.id, a.id, a.id], op: 'enable' });
    assert.equal(dup.body.results.length, 1, 'one request per unique id');

    const empty = await post('/accounts/batch', { ids: [], op: 'enable' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'ERR_BATCH_IDS_EMPTY');

    const badOp = await post('/accounts/batch', { ids: [a.id], op: 'drop-database' });
    assert.equal(badOp.status, 400);
    assert.equal(badOp.body.error, 'ERR_BATCH_OP_INVALID');

    const tooMany = await post('/accounts/batch', { ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`), op: 'enable' });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, 'ERR_BATCH_TOO_LARGE');
  });
});

describe('fleet probe/refresh routes', () => {
  it('probe-all and refresh-credits return per-account results on an empty pool', async () => {
    enableOpenLocal();
    // No accounts exist in this file before this test, so neither route dials
    // upstream (probe-all filters to active accounts; refresh-all iterates none).
    const probe = await post('/accounts/probe-all', {});
    assert.equal(probe.status, 200);
    assert.equal(probe.body.success, true);
    assert.deepEqual(probe.body.results, []);
    assert.deepEqual(
      {
        total: probe.body.total,
        attempted: probe.body.attempted,
        okCount: probe.body.okCount,
        failCount: probe.body.failCount,
        skippedCount: probe.body.skippedCount,
      },
      { total: 0, attempted: 0, okCount: 0, failCount: 0, skippedCount: 0 },
      'an empty sweep reports zeroes, not a missing summary',
    );

    const refresh = await post('/accounts/refresh-credits', {});
    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.success, true);
    assert.deepEqual(refresh.body.results, []);
  });

  it('batch probe reports a missing account as failed, not skipped or succeeded', async () => {
    enableOpenLocal();
    const r = await post('/accounts/batch', { ids: ['missing-probe-id'], op: 'probe' });
    assert.equal(r.status, 200);
    assert.equal(r.body.okCount, 0);
    assert.equal(r.body.failCount, 1);
    assert.equal(r.body.skippedCount, 0);
    assert.equal(r.body.attempted, 1);
    assert.deepEqual(r.body.failed, [{ id: 'missing-probe-id', ok: false, error: 'ERR_ACCOUNT_NOT_FOUND' }]);
    assert.deepEqual(r.body.skipped, []);
  });
});

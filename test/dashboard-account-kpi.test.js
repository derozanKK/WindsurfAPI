// KPI truth (UISpec P0-1).
//
// 3.9.53's KPI strip was six overlapping counters that looked additive:
//   - `disabled` was `status !== 'active'`, so banned/reauth/error were
//     reported as "停用" (the operator's own switch) AND again as "需关注";
//   - `flagged` was a hand-written OR that missed quota-cooled/capacity
//     accounts while the "仅异常" filter counted a different set;
//   - `balanceTotal` summed the on-demand balance once per ACCOUNT, but Teams
//     members read the same team balance — the pool total was multiplied.
//
// These tests pin the partition, the shared predicate, and the dedupe.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  configureBindHost,
  getAccountInternal,
  getAccountListStats,
  markNeedsReauth,
  removeAccount,
  setAccountStatus,
  _resetLockoutForTests,
} from '../src/auth.js';
import { config } from '../src/config.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { __resetOrgIdentityForTest, rememberAccountOrg } from '../src/org-identity.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const originalAllowNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
const created = new Set();

afterEach(() => {
  for (const id of created) removeAccount(id);
  created.clear();
  __resetOrgIdentityForTest();
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  if (originalAllowNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = originalAllowNoAuth;
  configureBindHost('0.0.0.0');
});

function enableOpenLocal() {
  _resetRuntimeConfigForTests();
  config.dashboardPassword = '';
  config.apiKey = '';
  configureBindHost('127.0.0.1');
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
}

function add(label, patch = {}) {
  const account = addAccountByKey(`kpi-key-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, `${label}@fixture.invalid`);
  Object.assign(account, patch);
  created.add(account.id);
  return account;
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

async function get(path) {
  const res = fakeRes();
  await handleDashboardApi('GET', path.split('?')[0], {}, { url: `/dashboard/api${path}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return { status: res.statusCode, body: res.json() };
}

describe('KPI partition (AC-KPI-1)', () => {
  it('reports 已停用 = operator-disabled only, and 需处理 = everything else non-healthy', () => {
    enableOpenLocal();
    const before = getAccountListStats();
    const active = add('kpi-active');
    const disabled = add('kpi-disabled');
    const banned = add('kpi-banned');
    const reauth = add('kpi-reauth');
    const errored = add('kpi-error');
    setAccountStatus(disabled.id, 'disabled');
    setAccountStatus(banned.id, 'banned');
    markNeedsReauth(reauth.id, { source: 'request', code: 'UNAUTHORIZED' });
    setAccountStatus(errored.id, 'error');

    const stats = getAccountListStats();
    assert.equal(stats.total - before.total, 5);
    assert.equal(stats.stateCounts.active - before.stateCounts.active, 1, 'one healthy account');
    assert.equal(stats.stateCounts.disabled - before.stateCounts.disabled, 1, 'only the manual switch counts as 已停用');
    assert.equal(stats.attention - before.attention, 3, 'banned + reauth + error are 需处理');
    assert.equal(stats.disabled, stats.stateCounts.disabled);
    assert.equal(stats.flagged, stats.attention, 'KPI and filter share one predicate');

    // The partition is exact: no account is double-counted or dropped.
    assert.equal(
      stats.stateCounts.active + stats.stateCounts.disabled + stats.attention,
      stats.total,
      'healthy + switched-off + needs-attention must equal the pool size',
    );
    for (const account of [active, disabled, banned, reauth, errored]) {
      assert.ok(getAccountInternal(account.id), 'fixture account survives the assertion');
    }
  });

  it('makes filter=flagged return exactly the 需处理 set, including quota-cooled accounts', async () => {
    enableOpenLocal();
    const healthy = add('flag-healthy');
    const cooled = add('flag-cooled', { quotaResetAt: Date.now() + 3600_000 });
    const limited = add('flag-limited', { rateLimitedUntil: Date.now() + 3600_000 });
    const off = add('flag-disabled');
    setAccountStatus(off.id, 'disabled');

    const res = await get('/accounts?view=summary&filter=flagged');
    assert.equal(res.status, 200);
    const ids = res.body.accounts.map((a) => a.id);
    assert.ok(ids.includes(cooled.id), 'a quota-cooled account needs attention');
    assert.ok(ids.includes(limited.id), 'a rate-limited account needs attention');
    assert.ok(!ids.includes(healthy.id), 'a healthy account is not flagged');
    assert.ok(!ids.includes(off.id), 'a manually disabled account is not "flagged" — it has its own KPI');
    assert.equal(res.body.stats.flagged, res.body.total, 'KPI number and filtered rows agree');
  });
});

describe('pool balance dedupe (AC-KPI-2)', () => {
  it('counts a team-shared balance once and keeps per-account balances for the rest', () => {
    const before = getAccountListStats();
    const teamA = add('bal-team-a', {
      userStatus: { teamId: 'team-alpha' },
      credits: { balance: 25, fetchedAt: 1_000 },
    });
    const teamB = add('bal-team-b', {
      userStatus: { teamId: 'team-alpha' },
      credits: { balance: 25, fetchedAt: 2_000 },
    });
    const solo = add('bal-solo', { credits: { balance: 5, fetchedAt: 1_000 } });

    const stats = getAccountListStats();
    assert.equal(stats.balanceAccounts - before.balanceAccounts, 3, 'three accounts reported a balance');
    assert.equal(stats.balanceOwners - before.balanceOwners, 2, 'two billing owners: one team + one individual');
    assert.equal(stats.balanceSharedAccounts - before.balanceSharedAccounts, 1);
    assert.equal(stats.balanceTotal - before.balanceTotal, 30, '25 for the team (once) + 5 for the individual');
    assert.ok(getAccountInternal(teamA.id) && getAccountInternal(teamB.id) && getAccountInternal(solo.id));
  });

  it('prefers the freshest snapshot inside one team', () => {
    const before = getAccountListStats();
    add('bal-fresh', {
      userStatus: { teamId: 'team-fresh' },
      credits: { balance: 10, fetchedAt: 9_000 },
    });
    add('bal-stale', {
      userStatus: { teamId: 'team-fresh' },
      credits: { balance: 99, fetchedAt: 1_000 },
    });
    const stats = getAccountListStats();
    assert.equal(stats.balanceTotal - before.balanceTotal, 10, 'the newer read wins; the stale sibling cannot inflate it');
  });

  it('dedupes by the org the ACU reader resolved, even without a team id', () => {
    const before = getAccountListStats();
    const one = add('bal-org-1', { credits: { balance: 7, fetchedAt: 1_000 } });
    const two = add('bal-org-2', { credits: { balance: 7, fetchedAt: 2_000 } });
    rememberAccountOrg(one.id, 'org-abc');
    rememberAccountOrg(two.id, 'org-abc');

    const stats = getAccountListStats();
    assert.equal(stats.balanceTotal - before.balanceTotal, 7, 'one org, one balance');
    assert.equal(stats.balanceOwners - before.balanceOwners, 1);
  });

  it('never counts a sentinel or unknown balance', () => {
    const before = getAccountListStats();
    add('bal-sentinel', { credits: { balance: 18_446_744_073_709.43, fetchedAt: 1_000 } });
    add('bal-negative', { credits: { balance: -1, fetchedAt: 1_000 } });
    add('bal-null', { credits: { balance: null, fetchedAt: 1_000 } });
    const stats = getAccountListStats();
    assert.equal(stats.balanceAccounts, before.balanceAccounts);
    assert.equal(stats.balanceTotal, before.balanceTotal);
  });
});

#!/usr/bin/env node
/**
 * Dashboard operator-flow smoke suite.
 *
 * Boots the REAL server in this process with a throwaway DATA_DIR and an
 * ephemeral loopback port, then drives the dashboard HTTP surface end to end.
 * The upstream is scripted through the product's existing test seams (see
 * test/helpers/dashboard-smoke-upstream.mjs), so no request leaves the box:
 * scripts/mutation-network-deny.mjs is installed as an independent barrier,
 * and a missed seam fails the run with NETWORK_STUB_MISS instead of dialling a
 * real provider.
 *
 * Covered flows (also exported as SMOKE_FLOWS for the CI wrapper):
 *   dashboard HTML · en + zh-CN locale files · models auth · login-method probe
 *   (email-code and password accounts) · email code start/complete · add account
 *   by token · account list · account probe · credit refresh · catalog diff ·
 *   request ring · usage · account delete · secret scan.
 *
 * Usage: node scripts/dashboard-smoke.mjs
 * Exit 0 = every flow passed. Exit 1 = a flow failed (the failing line names it).
 * The last stdout line is always:
 *   DASHBOARD-SMOKE SUMMARY: <passed>/<total> flows passed, <failed> failed
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import {
  SMOKE,
  SMOKE_FLOWS,
  SMOKE_SECRETS,
  scriptedLoginTransport,
  scriptedPostJson,
  scriptedCatalogTransport,
  scriptedFetch,
} from '../test/helpers/dashboard-smoke-upstream.mjs';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'windsurfapi-dashboard-smoke-'));

// Everything the product reads at import time is set BEFORE the dynamic
// imports below. PORT=0 lets the OS pick a free loopback port.
Object.assign(process.env, {
  WINDSURFAPI_SKIP_DOTENV: '1',
  DATA_DIR,
  HOST: '127.0.0.1',
  PORT: '0',
  API_KEY: SMOKE.apiKey,
  DASHBOARD_PASSWORD: SMOKE.dashboardPassword,
  DEVIN_CONNECT: '1',
  DEVIN_CONNECT_AUTO_RELOGIN: '0',
  RELOGIN_LIVE: '0',
  WINDSURFAPI_NO_OPEN: '1',
  LOG_LEVEL: 'error',
  NO_COLOR: '1',
});

// Capture everything this process writes (including product logs) so the final
// secret scan covers the real stdout, not just our own PASS lines.
const captured = [];
for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    try {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    } catch { /* capture is best-effort; the CI wrapper scans again */ }
    return original(chunk, encoding, callback);
  };
}

const responseTexts = [];
let server = null;
let base = '';
let passed = 0;
let failed = 0;
let exitCode = 0;
const completed = new Set();

// Seam handles, assigned in main() and cleared in cleanup().
let __setLoginTransportForTests = null;
let __setWindsurfApiPostJsonForTest = null;
let __setCatalogRequestImpl = null;
let __setFetchImplForTest = null;

function out(line) {
  process.stdout.write(`${line}\n`);
}

// `process.exit()` does not wait for a piped stdout buffer. Resolve both write
// callbacks first so the summary line cannot be truncated under CI's pipe.
async function flushStdio() {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => {
    try { stream.write('', resolve); } catch { resolve(); }
  })));
}

function requireThat(condition, detail) {
  if (!condition) throw new Error(detail);
}

async function runFlow(name, fn) {
  try {
    const detail = await fn();
    passed++;
    completed.add(name);
    out(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    failed++;
    exitCode = 1;
    out(`FAIL  ${name} — ${err?.message || String(err)}`);
    return false;
  }
}

async function http(method, path, { body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) headers['x-dashboard-password'] = SMOKE.dashboardPassword;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responseTexts.push(text);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is checked by callers */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
}

function readPath(value, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), value);
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
}

function buildCatalogResponse(writeStringField, writeVarintField, writeMessageField) {
  const row = Buffer.concat([
    writeStringField(1, SMOKE.liveLabel),
    writeStringField(22, SMOKE.liveSelector),
    writeVarintField(10, 2), // provider: OpenAI
    writeMessageField(23, writeStringField(23, SMOKE.liveAlias)),
  ]);
  return writeMessageField(1, row);
}

function buildStatusResponse(writeStringField, writeVarintField, writeMessageField) {
  const plan = writeStringField(2, 'Pro');
  const billing = Buffer.concat([
    writeMessageField(1, plan),
    writeVarintField(16, 12_500_000), // balance, micro-USD → $12.50
    writeVarintField(17, 1_790_000_000), // daily quota reset, epoch seconds
    writeVarintField(18, 1_790_604_800), // weekly quota reset, epoch seconds
  ]);
  return writeMessageField(1, writeMessageField(13, billing));
}

const REST_STATUS = {
  userStatus: {
    planStatus: {
      planInfo: { planName: 'Pro' },
      dailyQuotaRemainingPercent: 42,
      weeklyQuotaRemainingPercent: 88,
      dailyQuotaResetAtUnix: 1_790_000_000,
      weeklyQuotaResetAtUnix: 1_790_604_800,
      usedPromptCredits: 1000,
      availablePromptCredits: 4000,
      usedFlexCredits: 0,
      availableFlexCredits: 0,
    },
  },
};

const USAGE_QUOTA = {
  is_quota_plan: true,
  has_quota_allocation: true,
  daily_percentage: 42.5,
  weekly_percentage: 17,
  daily_reset_at: '2026-10-23T00:00:00Z',
  weekly_reset_at: '2026-10-27T00:00:00Z',
  overage_balance: 0,
  hide_daily_quota: false,
};
const USAGE_STATUS = {
  plan_slug: 'pro',
  is_subscription_valid: true,
  available_credits: 1234,
  overage_credits: 0,
  billing_method: 'card',
};
const USAGE_LIMITS = { max_acu_limit: 100, max_total_session_acu_limit: 50 };
const USAGE_DAILY = {
  days: [{ date: '2026-10-22', amount: 5, cumulative: 5 }],
  products: [{ view: 'chat', total: 5, days: [{ date: '2026-10-22', amount: 5, cumulative: 5 }] }],
  total: 5,
  cycle_start: '2026-10-01',
  cycle_end: '2026-11-01',
  previous_cycle_available: true,
};

async function main() {
  // Independent egress barrier. Importing the same URL the CI wrapper preloads
  // is a module-cache no-op, so manual runs get the guard too.
  await import('../scripts/mutation-network-deny.mjs');

  const { startServer } = await import('../src/server.js');
  const { initAuth } = await import('../src/auth.js');
  const loginModule = await import('../src/dashboard/windsurf-login.js');
  const windsurfApiModule = await import('../src/windsurf-api.js');
  const catalogModule = await import('../src/devin-connect-catalog.js');
  const devinReadModule = await import('../src/dashboard/devin-read.js');
  const { getLiveCatalog } = await import('../src/devin-connect-models.js');
  const { recordRequest, __resetRequestRingForTest } = await import('../src/dashboard/request-ring.js');
  const { writeStringField, writeVarintField, writeMessageField } = await import('../src/proto.js');

  __setLoginTransportForTests = loginModule.__setLoginTransportForTests;
  __setWindsurfApiPostJsonForTest = windsurfApiModule.__setWindsurfApiPostJsonForTest;
  __setCatalogRequestImpl = catalogModule.__setCatalogRequestImpl;
  __setFetchImplForTest = devinReadModule.__setFetchImplForTest;
  const resetEmailFlows = loginModule._resetEmailFlowsForTests;
  const resetEmailLockout = loginModule._resetEmailLockoutForTests;
  const resetReadCache = devinReadModule.__resetReadCache;

  const catalogBytes = buildCatalogResponse(writeStringField, writeVarintField, writeMessageField);
  const statusBytes = buildStatusResponse(writeStringField, writeVarintField, writeMessageField);

  const loginTransport = scriptedLoginTransport([
    {
      match: (url) => url.includes('/_devin-auth/connections'),
      reply: (_url, body) => ({
        json: body?.email === SMOKE.emailHasPassword
          ? {
            connections: [{ id: 'password', type: 'password', enabled: true }],
            auth_method: { method: 'auth1', has_password: true },
          }
          : {
            connections: [{ id: 'email', type: 'email', enabled: true }],
            auth_method: { method: 'auth1', has_password: false },
          },
      }),
    },
    {
      match: (url) => url.includes('/_devin-auth/email/start'),
      reply: { json: { email_verification_token: SMOKE.verifyToken } },
    },
    {
      match: (url) => url.includes('/_devin-auth/email/complete'),
      reply: { json: { token: SMOKE.auth1Token } },
    },
    {
      match: (url) => url.includes('WindsurfPostAuth'),
      reply: {
        buffer: Buffer.from(JSON.stringify({
          sessionToken: SMOKE.sessionTokenEmail,
          accountId: 'account-smoke-email',
        })),
      },
    },
  ]);

  const postJson = scriptedPostJson([
    {
      match: (path) => path.includes('GetCascadeModelConfigs'),
      reply: { json: { clientModelConfigs: [], clientModelSorts: [] } },
    },
    { match: (path) => path.includes('GetUserStatus'), reply: { json: REST_STATUS } },
  ]);

  const catalogTransport = scriptedCatalogTransport([
    { match: (path) => path.includes('GetCliModelConfigs'), reply: { buffer: catalogBytes } },
    { match: (path) => path.includes('GetUserStatus'), reply: { buffer: statusBytes } },
  ]);

  const fetchImpl = scriptedFetch([
    {
      match: (url) => url.includes('/users/current-membership'),
      reply: { json: { org: { org_id: SMOKE.orgId } } },
    },
    { match: (url) => url.includes('/billing/quota/usage'), reply: { json: USAGE_QUOTA } },
    { match: (url) => url.includes('/billing/status'), reply: { json: USAGE_STATUS } },
    { match: (url) => url.includes('/billing/usage/limits'), reply: { json: USAGE_LIMITS } },
    { match: (url) => url.includes('/billing/usage/daily-usage'), reply: { json: USAGE_DAILY } },
  ]);

  __setLoginTransportForTests(loginTransport);
  __setWindsurfApiPostJsonForTest(postJson);
  __setCatalogRequestImpl(catalogTransport);
  __setFetchImplForTest(fetchImpl);
  resetReadCache();
  resetEmailFlows();
  resetEmailLockout();
  __resetRequestRingForTest();

  await initAuth();
  server = startServer();
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  let emailAccountId = '';
  let tokenAccountId = '';
  let flowId = '';

  const flows = [
    ['dashboard-html', async () => {
      const r = await http('GET', '/dashboard', { auth: false });
      requireThat(r.status === 200, `status ${r.status}`);
      requireThat(/text\/html/i.test(r.contentType), `content-type ${r.contentType}`);
      requireThat(r.text.includes('id="lang-toggle-btn"'), 'language toggle marker missing');
      requireThat(r.text.includes('data-i18n="nav.overview"'), 'i18n marker missing');
      return '200 text/html, i18n markers present';
    }],

    ['locale-en', async () => {
      const r = await http('GET', '/dashboard/i18n/en.json', { auth: false });
      requireThat(r.status === 200, `status ${r.status}`);
      requireThat(readPath(r.json, 'nav.overview') === 'Dashboard', 'nav.overview mismatch');
      requireThat(typeof readPath(r.json, 'emailLogin.methodEmailCode') === 'string', 'emailLogin.methodEmailCode missing');
      requireThat(typeof readPath(r.json, 'section.catalogDiff.title') === 'string', 'section.catalogDiff.title missing');
      return 'en.json 200, 3 keys';
    }],

    ['locale-zh-CN', async () => {
      const en = await http('GET', '/dashboard/i18n/en.json', { auth: false });
      const r = await http('GET', '/dashboard/i18n/zh-CN.json', { auth: false });
      requireThat(r.status === 200, `status ${r.status}`);
      requireThat(readPath(r.json, 'nav.overview') === '仪表盘', 'nav.overview mismatch');
      requireThat(typeof readPath(r.json, 'emailLogin.methodPassword') === 'string', 'emailLogin.methodPassword missing');
      requireThat(readPath(r.json, 'nav.overview') !== readPath(en.json, 'nav.overview'), 'zh-CN and en are identical');
      return 'zh-CN.json 200, distinct translation';
    }],

    ['models-auth', async () => {
      const unauth = await http('GET', '/dashboard/api/models', { auth: false });
      requireThat(unauth.status === 401, `unauthenticated status ${unauth.status}`);
      const authed = await http('GET', '/dashboard/api/models');
      requireThat(authed.status === 200, `authenticated status ${authed.status}`);
      requireThat(Array.isArray(authed.json?.models) && authed.json.models.length > 0, 'models array empty');
      return `401 without password, 200 with ${authed.json.models.length} models`;
    }],

    ['login-probe-no-password', async () => {
      const r = await http('POST', '/dashboard/api/windsurf-login/probe', {
        body: { email: SMOKE.emailNoPassword },
      });
      requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
      requireThat(r.json.hasPassword === false, `hasPassword=${r.json.hasPassword}`);
      requireThat(r.json.emailCode === true, `emailCode=${r.json.emailCode}`);
      requireThat(r.json.userExists === true, `userExists=${r.json.userExists}`);
      requireThat(!r.text.includes(SMOKE.verifyToken), 'verification token echoed by probe');
      requireThat(
        loginTransport.seen.some((url) => url.includes('/_devin-auth/connections')),
        'probe never reached the scripted connections endpoint',
      );
      return 'hasPassword:false → email_code';
    }],

    ['login-probe-has-password', async () => {
      const r = await http('POST', '/dashboard/api/windsurf-login/probe', {
        body: { email: SMOKE.emailHasPassword },
      });
      requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
      requireThat(r.json.hasPassword === true, `hasPassword=${r.json.hasPassword}`);
      requireThat(r.json.emailCode === false, `emailCode=${r.json.emailCode}`);
      requireThat(r.json.method === 'auth1', `method=${r.json.method}`);
      requireThat(
        loginTransport.seen.some((url) => url.includes('/_devin-auth/connections')),
        'probe never reached the scripted connections endpoint',
      );
      return 'hasPassword:true → password form';
    }],

    ['email-start', async () => {
      const r = await http('POST', '/dashboard/api/windsurf-login/email/start', {
        body: { email: SMOKE.emailNoPassword },
      });
      requireThat(r.status === 200 && r.json?.sent === true, `status ${r.status} error ${r.json?.error || '?'}`);
      requireThat(typeof r.json.flowId === 'string' && r.json.flowId.length >= 16, 'opaque flowId missing');
      requireThat(!r.text.includes(SMOKE.verifyToken), 'verification token echoed by start');
      requireThat(
        loginTransport.seen.some((url) => url.includes('/_devin-auth/email/start')),
        'start never reached the scripted email/start endpoint',
      );
      flowId = r.json.flowId;
      return 'flowId issued, verification token kept server-side';
    }],

    ['email-complete', async () => {
      const r = await http('POST', '/dashboard/api/windsurf-login/email/complete', {
        body: { flowId, code: SMOKE.emailCode },
      });
      requireThat(r.status === 200 && r.json?.success === true, `status ${r.status} error ${r.json?.error || '?'}`);
      requireThat(r.json.method === 'email_code', `method=${r.json.method}`);
      requireThat(r.json.email === SMOKE.emailNoPassword, `email=${r.json.email}`);
      requireThat(typeof r.json.account?.id === 'string' && r.json.account.id, 'account not auto-added');
      requireThat(!r.text.includes(SMOKE.sessionTokenEmail), 'raw session token echoed by complete');
      requireThat(!r.text.includes(SMOKE.auth1Token), 'Auth1 token echoed by complete');
      requireThat(
        loginTransport.seen.some((url) => url.includes('/_devin-auth/email/complete')),
        'complete never reached the scripted email/complete endpoint',
      );
      requireThat(
        loginTransport.seen.some((url) => url.includes('WindsurfPostAuth')),
        'complete never exchanged the Auth1 token through PostAuth',
      );
      emailAccountId = r.json.account.id;
      return `logged in + auto-added ${emailAccountId}, key masked`;
    }],

    ['account-add-token', async () => {
      const r = await http('POST', '/dashboard/api/accounts', {
        body: { token: SMOKE.sessionTokenAdded, label: 'smoke-token' },
      });
      requireThat(r.status === 200 && r.json?.success === true, `status ${r.status} error ${r.json?.error || '?'}`);
      requireThat(typeof r.json.account?.id === 'string' && r.json.account.id, 'account id missing');
      requireThat(!r.text.includes(SMOKE.sessionTokenAdded), 'pasted token echoed by add');
      tokenAccountId = r.json.account.id;
      return `added ${tokenAccountId} from a pasted session token`;
    }],

    ['account-list', async () => {
      const r = await http('GET', '/dashboard/api/accounts');
      requireThat(r.status === 200 && Array.isArray(r.json?.accounts), `status ${r.status}`);
      const ids = r.json.accounts.map((a) => a.id);
      requireThat(ids.includes(emailAccountId), 'email-code account missing from list');
      requireThat(ids.includes(tokenAccountId), 'token account missing from list');
      requireThat(!r.text.includes(SMOKE.sessionTokenEmail), 'email session token in account list');
      requireThat(!r.text.includes(SMOKE.sessionTokenAdded), 'pasted session token in account list');
      return `${r.json.accounts.length} accounts, credentials masked`;
    }],

    ['account-probe', async () => {
      const r = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(tokenAccountId)}/probe`, { body: {} });
      requireThat(r.status === 200 && r.json?.success === true, `status ${r.status} error ${r.json?.error || '?'}`);
      requireThat(r.json.skipped === true || typeof r.json.tier === 'string', 'probe returned neither a tier nor a skip reason');
      return r.json.skipped ? `skipped: ${r.json.reason}` : `tier: ${r.json.tier}`;
    }],

    ['refresh-credits', async () => {
      const r = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(tokenAccountId)}/refresh-credits`, { body: {} });
      requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
      requireThat(r.json.credits?.planName === 'Pro', `planName=${r.json.credits?.planName}`);
      requireThat(r.json.credits?.dailyPercent === 42, `dailyPercent=${r.json.credits?.dailyPercent}`);
      requireThat(r.json.credits?.balance === 12.5, `balance=${r.json.credits?.balance}`);
      requireThat(
        postJson.seen.some((entry) => entry.includes('GetUserStatus')),
        'credit refresh never called the scripted REST GetUserStatus',
      );
      requireThat(
        catalogTransport.seen.some((entry) => entry.includes('GetUserStatus')),
        'credit refresh never called the scripted Connect GetUserStatus',
      );
      return 'REST status + billing RPC merged (plan Pro, $12.50, 42% daily)';
    }],

    ['catalog-diff', async () => {
      const synced = await waitFor(() => getLiveCatalog().length > 0);
      requireThat(synced, 'live catalog did not sync through the scripted GetCliModelConfigs transport');
      const live = getLiveCatalog();
      requireThat(
        live.some((row) => (typeof row === 'string' ? row : row?.selector) === SMOKE.liveSelector),
        'scripted live selector missing from the synced catalog',
      );
      const r = await http('GET', '/dashboard/api/models/catalog');
      requireThat(r.status === 200, `status ${r.status}`);
      requireThat(r.json?.synced === true, 'catalog reported unsynced');
      requireThat(r.json.liveCount >= 1, `liveCount=${r.json.liveCount}`);
      requireThat(r.json.snapshotCount > 0, `snapshotCount=${r.json.snapshotCount}`);
      requireThat(r.json.added.includes(SMOKE.liveSelector), 'live-only selector missing from added[]');
      requireThat(
        catalogTransport.seen.some((entry) => entry.includes('GetCliModelConfigs')),
        'catalog diff did not ride a scripted GetCliModelConfigs sync',
      );
      return `live ${r.json.liveCount} vs snapshot ${r.json.snapshotCount}, added includes ${SMOKE.liveSelector}`;
    }],

    ['request-ring', async () => {
      recordRequest({
        model: 'smoke-ring-model',
        selector: SMOKE.liveSelector,
        status: 200,
        stream: false,
        durationMs: 12,
        class: 'success',
        protocol: 'openai',
        caller: SMOKE.apiKey,
      });
      const r = await http('GET', '/dashboard/api/requests?limit=10');
      requireThat(r.status === 200 && Array.isArray(r.json?.items), `status ${r.status}`);
      const row = r.json.items.find((item) => item.model === 'smoke-ring-model');
      requireThat(!!row, 'seeded ring row missing');
      requireThat(row.status === 200 && row.caller !== SMOKE.apiKey, 'ring row malformed or caller not hashed');
      requireThat(r.json.ring?.total >= 1, 'ring stats not reported');
      return `row served, caller hashed, ring total ${r.json.ring.total}`;
    }],

    ['devin-panel', async () => {
      const r = await http('GET', '/dashboard/api/devin/panel');
      requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
      const runtime = r.json.runtime || {};
      requireThat(Array.isArray(runtime.switches) && runtime.switches.length === 6, 'runtime switch rows missing');
      requireThat(runtime.credentials?.writable === false, 'credential-store switches must stay read-only');
      const sources = r.json.sessions?.sources || [];
      const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
      requireThat(byId.proxyTurns?.available === true, 'proxy turn source must be available');
      requireThat(byId.cascadeTrajectories?.reason === 'ls_only', 'cascade trajectory source must state ls_only');
      requireThat(byId.acpSessions?.reason === 'not_tracked', 'ACP source must state not_tracked');
      requireThat(Array.isArray(r.json.sessions?.turns?.items), 'turns.items missing');
      requireThat(Array.isArray(r.json.quota?.knobs) && r.json.quota.knobs.length === 5, 'quota knobs missing');
      requireThat(!r.text.includes(SMOKE.sessionTokenAdded), 'pasted session token in panel body');
      requireThat(!r.text.includes(SMOKE.sessionTokenEmail), 'email session token in panel body');
      return `4 sections, ${sources.length} sources, ${r.json.sessions.turns.retained} retained turns`;
    }],

    ['usage', async () => {
      const r = await http('GET', `/dashboard/api/usage?account=${encodeURIComponent(tokenAccountId)}&refresh=1`);
      requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
      requireThat(r.json.plan === 'pro', `plan=${r.json.plan}`);
      requireThat(r.json.availableCredits === 1234, `availableCredits=${r.json.availableCredits}`);
      requireThat(r.json.quota?.dailyPercentage === 42.5, `dailyPercentage=${r.json.quota?.dailyPercentage}`);
      requireThat(Object.values(r.json.sources || {}).every((s) => s.ok), 'a usage source failed');
      for (const path of [
        '/users/current-membership',
        '/billing/quota/usage',
        '/billing/status',
        '/billing/usage/limits',
        '/billing/usage/daily-usage',
      ]) {
        requireThat(fetchImpl.seen.some((url) => url.includes(path)), `usage never read ${path}`);
      }
      return 'quota/status/limits/daily normalized from app.devin.ai fake';
    }],

    ['account-delete', async () => {
      const del = await http('DELETE', `/dashboard/api/accounts/${encodeURIComponent(tokenAccountId)}`);
      requireThat(del.status === 200 && del.json?.success === true, `delete status ${del.status}`);
      const after = await http('GET', '/dashboard/api/accounts');
      requireThat(after.status === 200 && Array.isArray(after.json?.accounts), `list status ${after.status}`);
      const ids = after.json.accounts.map((a) => a.id);
      requireThat(!ids.includes(tokenAccountId), 'deleted account still listed');
      requireThat(ids.includes(emailAccountId), 'unrelated account disappeared');
      return 'deleted account gone, email-code account retained';
    }],
  ];

  for (const [name, fn] of flows) {
    if (!(await runFlow(name, fn))) break;
  }

  // Always scan, even after a failed flow: a leak is the one failure that must
  // never be hidden by an earlier red line.
  await runFlow('no-secret-leak', async () => {
    const haystack = [...captured, ...responseTexts].join('\n');
    for (const secret of SMOKE_SECRETS) {
      requireThat(!haystack.includes(secret.value), `${secret.label} appeared in stdout/stderr or an HTTP body`);
    }
    return `${SMOKE_SECRETS.length} synthetic secrets absent from output and API bodies`;
  });

  if (exitCode === 0) {
    const missing = SMOKE_FLOWS.filter((name) => !completed.has(name));
    if (missing.length) {
      failed++;
      exitCode = 1;
      out(`FAIL  flow-manifest — unrun: ${missing.join(', ')}`);
    }
  }
}

async function cleanup() {
  try { __setLoginTransportForTests?.(null); } catch { /* best-effort */ }
  try { __setWindsurfApiPostJsonForTest?.(null); } catch { /* best-effort */ }
  try { __setCatalogRequestImpl?.(null); } catch { /* best-effort */ }
  try { __setFetchImplForTest?.(null); } catch { /* best-effort */ }
  if (server) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      server.close(finish);
      server.closeAllConnections?.();
      const timer = setTimeout(finish, 2000);
      timer.unref?.();
    });
  }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

try {
  await main();
} catch (err) {
  failed++;
  exitCode = 1;
  out(`FAIL  boot — ${err?.message || String(err)}`);
}

await cleanup();
out(`DASHBOARD-SMOKE SUMMARY: ${passed}/${SMOKE_FLOWS.length} flows passed, ${failed} failed`);
await flushStdio();
process.exit(exitCode);

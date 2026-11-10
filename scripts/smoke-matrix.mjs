#!/usr/bin/env node
/**
 * Smoke matrix — every user-visible feature, success + failure/edge, one boot.
 *
 * Broad companion to scripts/dashboard-smoke.mjs. It REUSES that suite's fake
 * upstream (test/helpers/dashboard-smoke-upstream.mjs: same scripted
 * login/REST/catalog/fetch transports, same synthetic credentials) and adds the
 * two seams the dashboard suite never needed:
 *
 *   - a scripted DEVIN_CONNECT event stream (__setStreamChatForTest), so the
 *     REAL adapters in src/devin-connect-openai.js serve the four public
 *     protocol fronts (OpenAI chat/completions, Anthropic Messages, OpenAI
 *     Responses, Gemini) from deterministic bytes;
 *   - a fake `devin acp` stdio server, so the special-agent backend runs its
 *     REAL runner (handshake, credential injection, SSE re-framing, error
 *     mapping) without the real CLI or an account.
 *
 * Every flow is one user-visible behaviour with at least one success path and
 * one failure/edge path. Families are declared in MATRIX_FAMILIES and each
 * family must contribute at least one flow; the manifest flow enforces both
 * directions so a silently dropped registration cannot pass.
 *
 * Isolation: throwaway DATA_DIR, ephemeral loopback port, no dotenv, and
 * scripts/mutation-network-deny.mjs installed as an independent egress
 * barrier. A seam the suite forgot fails with NETWORK_STUB_MISS instead of
 * dialling a real provider.
 *
 * Usage: node scripts/smoke-matrix.mjs
 * Exit 0 = every flow passed. Exit 1 = at least one failed (the FAIL line names
 * the family and the flow).
 * Last stdout line:
 *   SMOKE-MATRIX SUMMARY: <passed>/<total> flows passed, <failed> failed, <f>/<F> families green
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import {
  SMOKE,
  MATRIX,
  MATRIX_SECRETS,
  MATRIX_FAMILIES,
  scriptedLoginTransport,
  scriptedPostJson,
  scriptedCatalogTransport,
  scriptedFetch,
  scriptedConnectEvents,
  FAKE_ACP_SOURCE,
} from '../test/helpers/smoke-matrix-upstream.mjs';

import { registerCoreFlows } from './smoke-matrix/flows-core.mjs';
import { registerLoginFlows } from './smoke-matrix/flows-login.mjs';
import { registerProtocolFlows } from './smoke-matrix/flows-protocol.mjs';
import { registerLiveFlows } from './smoke-matrix/flows-live.mjs';
import { registerReauthFlows } from './smoke-matrix/flows-reauth.mjs';
import { registerAcuFlows } from './smoke-matrix/flows-acu.mjs';
import { registerAccountDrawerFlows } from './smoke-matrix/flows-account-drawer.mjs';
import { registerRuntimeFlows } from './smoke-matrix/flows-runtime.mjs';
import { registerFleetFlows } from './smoke-matrix/flows-fleet.mjs';
import { registerDetachFlows } from './smoke-matrix/flows-detach.mjs';
import { registerDocsFlows } from './smoke-matrix/flows-docs.mjs';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'windsurfapi-smoke-matrix-'));
const ACP_DIR = mkdtempSync(join(tmpdir(), 'windsurfapi-smoke-matrix-acp-'));
const ACP_SCRIPT = join(ACP_DIR, 'fake-acp.mjs');
writeFileSync(ACP_SCRIPT, FAKE_ACP_SOURCE, 'utf8');

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
  DEVIN_CONNECT_TOKEN: MATRIX.connectToken,
  DEVIN_CONNECT_AUTO_RELOGIN: '0',
  RELOGIN_LIVE: '0',
  WINDSURFAPI_NO_OPEN: '1',
  LOG_LEVEL: 'error',
  NO_COLOR: '1',
  RESPONSE_STORE_ENABLED: '1',
  // Deterministic stream shape: no empty-turn retries, no rescue re-issues.
  DEVIN_CONNECT_RETRY_ON_EMPTY: '0',
  DEVIN_CONNECT_RESCUE_MAX: '0',
  // ACP backend is only armed during the acp family (see flows-live.mjs); the
  // path/args are inert until WINDSURFAPI_SPECIAL_AGENT_BACKEND=devin-cli.
  DEVIN_CLI_PATH: process.execPath,
  DEVIN_CLI_ACP_ARGS_JSON: JSON.stringify([ACP_SCRIPT]),
  DEVIN_CLI_ENABLED: '1',
});

// Capture everything this process writes (including product logs) so the final
// secret scan covers real stdout, not just our own PASS lines.
const captured = [];
for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    try {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    } catch { /* capture is best-effort */ }
    return original(chunk, encoding, callback);
  };
}

const responseTexts = [];
const flows = [];
const familyTotals = new Map(MATRIX_FAMILIES.map((f) => [f, { passed: 0, total: 0 }]));
const state = {};

let server = null;
let base = '';
let passed = 0;
let failed = 0;
let exitCode = 0;

// Seam handles, assigned in main() and cleared in cleanup().
let seams = {};

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

/**
 * One HTTP call against the real server.
 * `auth`: 'dashboard' (default) | 'api' | 'both' | 'none'.
 */
async function http(method, path, { body, rawBody, auth = 'dashboard', headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined || rawBody !== undefined) h['content-type'] = 'application/json';
  if (auth === 'dashboard' || auth === 'both') h['x-dashboard-password'] = SMOKE.dashboardPassword;
  if (auth === 'api' || auth === 'both') h.authorization = `Bearer ${SMOKE.apiKey}`;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  responseTexts.push(text);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is checked by callers */ }
  return {
    status: res.status,
    json,
    text,
    contentType: res.headers.get('content-type') || '',
    header: (name) => res.headers.get(name),
  };
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

/** Split an SSE body into `{event, data}` frames; `[DONE]` keeps data as-is. */
function sseEvents(text) {
  return text
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.trim())
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      return { event, data };
    })
    .filter((frame) => frame.event || frame.data);
}

function addFlow(family, name, fn) {
  requireThat(MATRIX_FAMILIES.includes(family), `unknown family ${family} for flow ${name}`);
  requireThat(!flows.some((f) => f.name === name), `duplicate flow name ${name}`);
  flows.push({ family, name, fn });
}

/**
 * Read the first chunk of a long-lived SSE endpoint, then abort. The dashboard
 * log view is a stream, so `http()` (which waits for the body to end) cannot
 * exercise it.
 */
async function streamHead(path, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      headers: { 'x-dashboard-password': SMOKE.dashboardPassword },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = value ? Buffer.from(value).toString('utf8') : '';
    responseTexts.push(text);
    return { status: res.status, contentType: res.headers.get('content-type') || '', text };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const ctx = {
  SMOKE,
  MATRIX,
  state,
  http,
  streamHead,
  sseEvents,
  readPath,
  waitFor,
  requireThat,
  addFlow,
  base: '',
  deps: {},
};

async function runFlow({ family, name, fn }) {
  const totals = familyTotals.get(family);
  totals.total++;
  try {
    const detail = await fn();
    passed++;
    totals.passed++;
    out(`PASS  [${family}] ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    failed++;
    exitCode = 1;
    out(`FAIL  [${family}] ${name} — ${err?.message || String(err)}`);
    return false;
  }
}

function buildCatalogResponse(writeStringField, writeVarintField, writeMessageField) {
  const row = Buffer.concat([
    writeStringField(1, SMOKE.liveLabel),
    writeStringField(22, SMOKE.liveSelector),
    writeVarintField(10, 2), // provider: OpenAI
    writeMessageField(23, writeStringField(23, SMOKE.liveAlias)),
  ]);
  // The pooled-account entitlement filter only admits a FREE_REACHABLE
  // selector when the account's own live catalog lists it. Without this row a
  // pooled chat for `swe-1-6-slow` queues for 30 s and falls back to the env
  // token, which would make the billed-request history permanently empty.
  const freeRow = Buffer.concat([
    writeStringField(1, 'Free Smoke'),
    writeStringField(22, MATRIX.models.chat),
    writeVarintField(10, 2),
    writeMessageField(23, writeStringField(23, 'free.smoke')),
  ]);
  return Buffer.concat([writeMessageField(1, row), writeMessageField(1, freeRow)]);
}

function buildStatusResponse(writeStringField, writeVarintField, writeMessageField) {
  const plan = writeStringField(2, 'Pro');
  const billing = Buffer.concat([
    writeMessageField(1, plan),
    writeVarintField(16, 12_500_000), // balance, micro-USD → $12.50
    writeVarintField(17, 1_790_000_000),
    writeVarintField(18, 1_790_604_800),
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
  // Independent egress barrier. Importing the same URL a CI wrapper preloads is
  // a module-cache no-op, so manual runs get the guard too.
  await import('../scripts/mutation-network-deny.mjs');

  const { startServer } = await import('../src/server.js');
  const { initAuth } = await import('../src/auth.js');
  const authModule = await import('../src/auth.js');
  const loginModule = await import('../src/dashboard/windsurf-login.js');
  const otpModule = await import('../src/dashboard/email-otp-login.js');
  const windsurfApiModule = await import('../src/windsurf-api.js');
  const catalogModule = await import('../src/devin-connect-catalog.js');
  const devinReadModule = await import('../src/dashboard/devin-read.js');
  const connectOpenAi = await import('../src/devin-connect-openai.js');
  const cardsModule = await import('../src/dashboard/devin-cards.js');
  const { getLiveCatalog } = await import('../src/devin-connect-models.js');
  const { __resetRequestRingForTest } = await import('../src/dashboard/request-ring.js');
  const { writeStringField, writeVarintField, writeMessageField } = await import('../src/proto.js');

  seams = {
    login: loginModule.__setLoginTransportForTests,
    otp: otpModule.__setOtpTransportForTests,
    postJson: windsurfApiModule.__setWindsurfApiPostJsonForTest,
    catalog: catalogModule.__setCatalogRequestImpl,
    fetch: devinReadModule.__setFetchImplForTest,
    streamChat: connectOpenAi.__setStreamChatForTest,
    preflight: cardsModule.__setPreflightDepsForTest,
    reloginDeps: authModule.__setReloginDeps,
    resetReauthChecks: authModule.__resetReauthChecks,
    resetEmailFlows: loginModule._resetEmailFlowsForTests,
    resetEmailLockout: loginModule._resetEmailLockoutForTests,
    resetReadCache: devinReadModule.__resetReadCache,
  };

  // SessionReauth's confirmation probe is a free GetUserStatus call. The
  // matrix needs to choose the verdict per token (dead / alive), so it injects
  // the same seam the unit suite uses. Unlisted tokens are alive.
  const liveness = new Map();
  const checkSessionLiveness = async ({ token }) => (
    liveness.get(String(token || '')) || { alive: true, code: 'OK' }
  );

  const catalogBytes = buildCatalogResponse(writeStringField, writeVarintField, writeMessageField);
  const statusBytes = buildStatusResponse(writeStringField, writeVarintField, writeMessageField);

  const loginTransport = scriptedLoginTransport([
    // app.devin.ai is the wave-3 fallback/explicit login host. It uses the
    // /api/auth1/* paths (not windsurf.com's /_devin-auth/*), so these routes
    // can only be reached when the product actually chose that host.
    {
      match: (url) => url.includes('app.devin.ai/api/auth1/connections'),
      reply: (_url, body) => {
        if (body?.email === MATRIX.emailDevinOnly) {
          return {
            json: {
              connections: [{ id: 'email', type: 'email', enabled: true }],
              auth_method: { method: 'auth1', has_password: true },
            },
          };
        }
        return { status: 500, json: { error: 'devin_host_unrouted' } };
      },
    },
    {
      match: (url) => url.includes('app.devin.ai/api/auth1/email/start'),
      reply: { json: { email_verification_token: MATRIX.verifyTokenDevin } },
    },
    {
      match: (url) => url.includes('app.devin.ai/api/auth1/email/complete'),
      reply: (_url, body) => (body?.code === SMOKE.emailCode
        ? { json: { token: MATRIX.auth1TokenDevin } }
        : { status: 400, json: { detail: 'invalid verification code' } }),
    },
    {
      match: (url) => url.includes('/_devin-auth/connections'),
      reply: (_url, body) => {
        const email = body?.email;
        if (email === MATRIX.emailBrokenProbe) return { status: 500, json: { error: 'probe_down' } };
        // Host-fallback fixture: windsurf.com cannot answer this address, so
        // only the app.devin.ai route above can.
        if (email === MATRIX.emailDevinOnly) return { status: 500, json: { error: 'probe_down' } };
        // Known non-auth1 method with NO has_password field: the only reason a
        // probe can return it is the wave-3 "honor a non-auth1 method" clause.
        if (email === MATRIX.emailFirebase) {
          return {
            json: {
              connections: [
                { id: 'email', type: 'email', enabled: true },
                { id: 'google', type: 'google', enabled: true },
              ],
              auth_method: { method: 'firebase' },
            },
          };
        }
        if (email === MATRIX.emailUnknown) {
          return { json: { auth_method: { method: 'not_found', has_password: false } } };
        }
        if (email === MATRIX.emailPassword || email === SMOKE.emailHasPassword) {
          return {
            json: {
              connections: [{ id: 'password', type: 'password', enabled: true }],
              auth_method: { method: 'auth1', has_password: true },
            },
          };
        }
        return {
          json: {
            connections: [{ id: 'email', type: 'email', enabled: true }],
            auth_method: { method: 'auth1', has_password: false },
          },
        };
      },
    },
    {
      // Secondary probe. Only the broken-probe identity reaches it, and it must
      // also fail so the route reports "unknown" rather than inventing a method.
      match: (url) => url.includes('CheckUserLoginMethod'),
      reply: (_url, body) => (body?.email === MATRIX.emailBrokenProbe
        ? { status: 503, json: { error: 'unavailable' } }
        : { json: { userExists: true, hasPassword: false } }),
    },
    {
      match: (url) => url.includes('/_devin-auth/email/start'),
      reply: { json: { email_verification_token: SMOKE.verifyToken } },
    },
    {
      match: (url) => url.includes('/_devin-auth/email/complete'),
      reply: (_url, body) => (body?.code === SMOKE.emailCode
        ? { json: { token: SMOKE.auth1Token } }
        : { status: 400, json: { detail: 'invalid verification code' } }),
    },
    {
      match: (url) => url.includes('/_devin-auth/password/login'),
      reply: (_url, body) => (body?.password === MATRIX.password
        ? { json: { token: MATRIX.auth1Password } }
        // Upstream's documented Auth1 rejection string; createFriendlyAuthError
        // maps it to ERR_INVALID_PASSWORD + isAuthFail.
        : { status: 401, json: { detail: 'INVALID_PASSWORD' } }),
    },
    {
      match: (url) => url.includes('WindsurfPostAuth'),
      reply: (_url, _body, _raw, opts) => {
        // PostAuth carries the Auth1 token in a header with an EMPTY body, so
        // the header is the only way to tell the password flow from the
        // email-code flow.
        const headers = opts?.headers || {};
        const auth1 = Object.entries(headers)
          .find(([key]) => key.toLowerCase() === 'x-devin-auth1-token')?.[1] || '';
        const passwordFlow = String(auth1).includes(MATRIX.auth1Password);
        const devinFlow = String(auth1).includes(MATRIX.auth1TokenDevin);
        return {
          buffer: Buffer.from(JSON.stringify({
            sessionToken: passwordFlow
              ? MATRIX.sessionTokenPassword
              : (devinFlow ? MATRIX.sessionTokenDevin : SMOKE.sessionTokenEmail),
            accountId: passwordFlow
              ? 'account-smoke-password'
              : (devinFlow ? 'account-smoke-devin' : 'account-smoke-email'),
          })),
        };
      },
    },
  ]);

  const postJson = scriptedPostJson([
    {
      match: (path) => path.includes('GetCascadeModelConfigs'),
      reply: { json: { clientModelConfigs: [], clientModelSorts: [] } },
    },
    { match: (path) => path.includes('GetUserStatus'), reply: { json: REST_STATUS } },
    {
      match: (path) => path.includes('CheckUserMessageRateLimit'),
      reply: { json: { hasCapacity: true, messagesRemaining: 42, maxMessages: 100, resetsInSeconds: 0 } },
    },
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
    {
      match: (url) => url.includes('/internal-model-catalog'),
      reply: { json: { models: [{ model_uid: 'swe-1-6-slow', disabled: false }] } },
    },
    { match: (url) => url.includes('/fed-models'), reply: { json: { models: [] } } },
    { match: (url) => url.includes('/toggleable-agent-versions'), reply: { json: { toggleable_versions: [] } } },
    { match: (url) => url.includes('/windsurf/org-configs'), reply: { json: { configs: [] } } },
  ]);

  const connectStream = scriptedConnectEvents();

  const otpTransport = async (url) => {
    if (url.includes('SendEmailVerification')) return { status: 200, data: {} };
    if (url.includes('RegisterUser')) {
      return {
        status: 200,
        data: { api_key: MATRIX.otpKey, name: 'OTP Smoke', api_server_url: '' },
      };
    }
    return { status: 404, data: { error: 'unrouted otp call' } };
  };

  seams.login(loginTransport);
  seams.otp(otpTransport);
  seams.postJson(postJson);
  seams.catalog(catalogTransport);
  seams.fetch(fetchImpl);
  seams.streamChat(connectStream);
  seams.preflight({
    rateLimit: async () => ({ hasCapacity: true, messagesRemaining: 42, maxMessages: 100, retryAfterMs: null }),
  });
  seams.reloginDeps({ checkSessionLiveness });
  seams.resetReauthChecks();
  seams.resetReadCache();
  seams.resetEmailFlows();
  seams.resetEmailLockout();
  __resetRequestRingForTest();

  await initAuth();
  server = startServer();
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.base = base;

  Object.assign(ctx.deps, {
    loginTransport,
    postJson,
    catalogTransport,
    fetchImpl,
    connectStream,
    otpTransport,
    getLiveCatalog,
    liveness,
    installFetch: seams.fetch,
    // The fleet cancel flow needs to stretch one upstream read so a cancel can
    // land while an item is genuinely in flight; re-installing is the same seam
    // the transport was armed with.
    installPostJson: seams.postJson,
    resetReadCache: seams.resetReadCache,
    resetEmailFlows: seams.resetEmailFlows,
    resetEmailLockout: seams.resetEmailLockout,
  });

  // Order matters: the protocol fronts run BEFORE any account is pooled, so
  // the connect client takes the documented env-token fallback instead of
  // queueing for a per-account entitlement that a fresh pool cannot satisfy.
  // The dashboard families that assert an empty pool/ring therefore also run
  // before login.
  registerCoreFlows(ctx);
  registerProtocolFlows(ctx);
  registerLoginFlows(ctx);
  // Pooled-account surfaces. The history flow drives one real chat through the
  // pool, so it must run before any family that parks an account (reauth).
  registerAccountDrawerFlows(ctx);
  registerAcuFlows(ctx);
  // Fleet + KPI need the pool the login family built and the org identities the
  // ACU reader learned, and they must run BEFORE reauth parks an account (a
  // parked account is excluded from a fleet run by design).
  registerFleetFlows(ctx);
  registerReauthFlows(ctx);
  registerLiveFlows(ctx);
  registerRuntimeFlows(ctx);
  // Detach flips its own switch per request and restores it; the docs family
  // runs the repo guard in a child process.
  registerDetachFlows(ctx);
  registerDocsFlows(ctx);

  // Hygiene flows are ordinary members of the flow list so the family census
  // sees them. The leak scan is last on purpose: it must run even when an
  // earlier family failed, because a leak must never be hidden by a red line.
  addFlow('hygiene', 'hygiene.flow-manifest', async () => {
    requireThat(flows.length >= 130, `only ${flows.length} flows registered`);
    const declared = new Set(MATRIX_FAMILIES);
    for (const flow of flows) requireThat(declared.has(flow.family), `flow ${flow.name} has an undeclared family`);
    for (const family of MATRIX_FAMILIES) {
      requireThat(familyTotals.get(family).total > 0, `family ${family} registered no flows`);
    }
    return `${flows.length} flows across ${MATRIX_FAMILIES.length} families`;
  });
  addFlow('hygiene', 'hygiene.no-secret-leak', async () => {
    const haystack = [...captured, ...responseTexts].join('\n');
    for (const secret of MATRIX_SECRETS) {
      requireThat(!haystack.includes(secret.value), `${secret.label} appeared in stdout/stderr or an HTTP body`);
    }
    return `${MATRIX_SECRETS.length} synthetic secrets absent from output and API bodies`;
  });

  for (const flow of flows) {
    await runFlow(flow);
  }

  // Per-family census. A family with zero flows is a hole in the matrix, not a
  // green result, so it fails the run.
  let familiesGreen = 0;
  for (const family of MATRIX_FAMILIES) {
    const totals = familyTotals.get(family);
    if (totals.total === 0) {
      failed++;
      exitCode = 1;
      out(`FAIL  [${family}] family-manifest — no flow registered for this family`);
      continue;
    }
    if (totals.passed === totals.total) familiesGreen++;
    out(`FAMILY ${family} ${totals.passed}/${totals.total}`);
  }

  out(`SMOKE-MATRIX SUMMARY: ${passed}/${flows.length} flows passed, ${failed} failed, ${familiesGreen}/${MATRIX_FAMILIES.length} families green`);
}

async function cleanup() {
  try { seams.login?.(null); } catch { /* best-effort */ }
  try { seams.otp?.(null); } catch { /* best-effort */ }
  try { seams.postJson?.(null); } catch { /* best-effort */ }
  try { seams.catalog?.(null); } catch { /* best-effort */ }
  try { seams.fetch?.(null); } catch { /* best-effort */ }
  try { seams.streamChat?.(null); } catch { /* best-effort */ }
  try { seams.preflight?.({}); } catch { /* best-effort */ }
  try { seams.reloginDeps?.(null); } catch { /* best-effort */ }
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
  for (const dir of [DATA_DIR, ACP_DIR]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

try {
  await main();
} catch (err) {
  failed++;
  exitCode = 1;
  out(`FAIL  [boot] boot — ${err?.message || String(err)}`);
}

await cleanup();
if (!/SMOKE-MATRIX SUMMARY:/.test(captured.join(''))) {
  out(`SMOKE-MATRIX SUMMARY: ${passed}/${flows.length} flows passed, ${failed} failed, 0/${MATRIX_FAMILIES.length} families green`);
}
await flushStdio();
process.exit(exitCode);

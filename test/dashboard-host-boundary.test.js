// D1 regression: `/auth/*` is an operator surface with the same DNS-rebinding
// exposure as `/dashboard/api/*`, and a client-supplied X-Forwarded-Host must
// not bypass DASHBOARD_ALLOWED_HOSTS when proxy trust is enabled.
//
// Before the fix (audit2/Server.md S01/S02):
//   - open-local `GET /auth/accounts` and account-adding `POST /auth/login`
//     answered 200 for `Host: attacker.example`, because verifyAdminRequest
//     authenticates from the loopback *socket* (a rebinding page is loopback);
//   - `X-Forwarded-Host: attacker.example` short-circuited the host allowlist
//     whenever TRUST_PROXY_X_FORWARDED_FOR=1, so the request fell through to
//     auth instead of being rejected at the host gate.
//
// This file drives a real `startServer()` over raw http.request so Host,
// Origin, X-Forwarded-For and X-Forwarded-Host are verbatim on the wire.
// Account rows are asserted against the real pool, so "403 with zero account
// delta" is measured, not inferred from the response shape. Proxy arms set a
// dashboard password and send it, so the Host check — not auth — is the only
// discriminator (the audit's recommended harness).

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import {
  configureBindHost, getAccountCount, getAccountList, removeAccount, _resetLockoutForTests,
} from '../src/auth.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { startServer } from '../src/server.js';

const DASHBOARD_PASSWORD = 'host-boundary-test-password';
const PROXY_HOST = 'dashboard.internal.example';

const saved = {
  host: config.host,
  port: config.port,
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
};
const savedEnv = {};
for (const key of [
  'WINDSURFAPI_ALLOW_UNAUTHENTICATED',
  'DASHBOARD_ALLOW_NO_AUTH',
  'DASHBOARD_ALLOWED_HOSTS',
  'DASHBOARD_CORS_ORIGINS',
  'TRUST_PROXY_X_FORWARDED_FOR',
]) {
  savedEnv[key] = process.env[key];
}

function restoreEnv(key) {
  const value = savedEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function resetHostEnv() {
  delete process.env.TRUST_PROXY_X_FORWARDED_FOR;
  delete process.env.DASHBOARD_ALLOWED_HOSTS;
  delete process.env.DASHBOARD_CORS_ORIGINS;
  process.env.WINDSURFAPI_ALLOW_UNAUTHENTICATED = '1';
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
}

let server = null;
let port = 0;

before(async () => {
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.host = '127.0.0.1';
  config.port = 0;
  config.apiKey = '';
  config.dashboardPassword = '';
  resetHostEnv();
  server = startServer();
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  config.host = saved.host;
  config.port = saved.port;
  config.apiKey = saved.apiKey;
  config.dashboardPassword = saved.dashboardPassword;
  configureBindHost('0.0.0.0');
  for (const key of Object.keys(savedEnv)) restoreEnv(key);
});

beforeEach(() => {
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  resetHostEnv();
  config.apiKey = '';
  config.dashboardPassword = '';
});

afterEach(() => {
  for (const account of getAccountList()) {
    if (String(account?.email || '').includes('host-boundary')) removeAccount(account.id);
  }
});

function request(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null
      ? null
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload == null ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Proxy arms use a real operator secret so the Host gate, not auth, decides.
function withPassword() {
  config.dashboardPassword = DASHBOARD_PASSWORD;
  return { 'x-dashboard-password': DASHBOARD_PASSWORD };
}

describe('D1: /auth/* Host boundary (open-local)', () => {
  it('rejects a rebinding Host on GET /auth/accounts without listing accounts', async () => {
    const before = getAccountCount().total;
    const r = await request('GET', '/auth/accounts', { headers: { Host: 'attacker.example' } });
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body?.error, 'ERR_DASHBOARD_HOST_REJECTED');
    assert.equal(r.body?.accounts, undefined, 'a rejected request must not leak the pool');
    assert.equal(getAccountCount().total, before);
  });

  it('accepts the loopback Host on GET /auth/accounts', async () => {
    const r = await request('GET', '/auth/accounts', { headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(r.status, 200, r.raw);
    assert.ok(Array.isArray(r.body?.accounts));
  });

  it('rejects an account-adding POST /auth/login with zero account delta', async () => {
    const before = getAccountCount().total;
    const r = await request('POST', '/auth/login', {
      headers: {
        Host: 'attacker.example',
        Origin: 'http://attacker.example',
        'Content-Type': 'text/plain',
      },
      body: { token: 'devin-session-token$host-boundary-probe' },
    });
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body?.error, 'ERR_DASHBOARD_HOST_REJECTED');
    assert.equal(getAccountCount().total, before, 'a rejected login must not add an account');
    assert.equal(
      getAccountList().some(account => String(account?.email || '').includes('host-boundary-probe')),
      false,
    );
  });

  it('still adds the account from the loopback Host (positive control)', async () => {
    const before = getAccountCount().total;
    const r = await request('POST', '/auth/login', {
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: { token: 'devin-session-token$host-boundary-control' },
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body?.success, true);
    assert.equal(getAccountCount().total, before + 1);
  });
});

describe('D1: trusted-proxy X-Forwarded-Host cannot bypass DASHBOARD_ALLOWED_HOSTS', () => {
  it('rejects an unallowlisted client-supplied X-Forwarded-Host on /dashboard/api/*', async () => {
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    process.env.DASHBOARD_ALLOWED_HOSTS = PROXY_HOST;
    const auth = withPassword();
    const r = await request('PUT', '/dashboard/api/settings/prefs', {
      headers: {
        ...auth,
        Host: 'attacker.example',
        Origin: 'http://attacker.example',
        'Sec-Fetch-Site': 'same-origin',
        'X-Forwarded-For': '1.2.3.4',
        'X-Forwarded-Host': 'attacker.example',
        'Content-Type': 'application/json',
      },
      body: { oauthSkipChooser: true },
    });
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body?.error, 'ERR_DASHBOARD_HOST_REJECTED');
  });

  it('accepts a correctly sanitized proxy Host that is allowlisted', async () => {
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    process.env.DASHBOARD_ALLOWED_HOSTS = PROXY_HOST;
    const auth = withPassword();
    const r = await request('PUT', '/dashboard/api/settings/prefs', {
      headers: {
        ...auth,
        Host: `127.0.0.1:${port}`,
        Origin: `http://${PROXY_HOST}`,
        'Sec-Fetch-Site': 'same-origin',
        'X-Forwarded-For': '1.2.3.4',
        'X-Forwarded-Host': PROXY_HOST,
        'Content-Type': 'application/json',
      },
      body: { oauthSkipChooser: true },
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body?.success, true);
  });

  it('rejects the same attack request when proxy trust is off', async () => {
    process.env.DASHBOARD_ALLOWED_HOSTS = PROXY_HOST;
    const auth = withPassword();
    const r = await request('PUT', '/dashboard/api/settings/prefs', {
      headers: {
        ...auth,
        Host: 'attacker.example',
        Origin: 'http://attacker.example',
        'Sec-Fetch-Site': 'same-origin',
        'X-Forwarded-Host': 'attacker.example',
        'Content-Type': 'application/json',
      },
      body: { oauthSkipChooser: true },
    });
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body?.error, 'ERR_DASHBOARD_HOST_REJECTED');
  });

  it('rejects /auth/* with an unallowlisted forwarded Host under proxy trust', async () => {
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    process.env.DASHBOARD_ALLOWED_HOSTS = PROXY_HOST;
    const auth = withPassword();
    const before = getAccountCount().total;
    const r = await request('POST', '/auth/login', {
      headers: {
        ...auth,
        Host: 'attacker.example',
        Origin: 'http://attacker.example',
        'Content-Type': 'text/plain',
        'X-Forwarded-For': '1.2.3.4',
        'X-Forwarded-Host': 'attacker.example',
      },
      body: { token: 'devin-session-token$host-boundary-probe-xfh' },
    });
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body?.error, 'ERR_DASHBOARD_HOST_REJECTED');
    assert.equal(getAccountCount().total, before);
  });

  it('accepts /auth/* through a correctly sanitized allowlisted proxy Host', async () => {
    process.env.TRUST_PROXY_X_FORWARDED_FOR = '1';
    process.env.DASHBOARD_ALLOWED_HOSTS = PROXY_HOST;
    const auth = withPassword();
    const r = await request('GET', '/auth/accounts', {
      headers: {
        ...auth,
        Host: `127.0.0.1:${port}`,
        'X-Forwarded-For': '1.2.3.4',
        'X-Forwarded-Host': PROXY_HOST,
      },
    });
    assert.equal(r.status, 200, r.raw);
    assert.ok(Array.isArray(r.body?.accounts));
  });
});

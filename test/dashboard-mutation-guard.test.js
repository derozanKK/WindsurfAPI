// A04 regression: open-local dashboard mutations must reject cross-site
// "simple" POST/PUT requests (text/plain, no preflight) while a same-origin
// JSON request from the real dashboard still works.
//
// Before the fix, DASHBOARD_ALLOW_NO_AUTH=1 on a loopback bind accepted
// `PUT /dashboard/api/experimental` with `Content-Type: text/plain` and an
// arbitrary Origin — a web page could mutate the victim's local service.
// The gate now runs before auth counters and before every route arm:
//   - Content-Type must be application/json for body-bearing mutations.
//   - Origin must agree with Host (or be an explicit CORS allowlist entry).
//   - Sec-Fetch-Site must be same-origin/none (not cross-site/same-site),
//     Sec-Fetch-Mode must not be no-cors/navigate.
//   - Host must be loopback on a loopback bind (DNS-rebinding defence).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import {
  configureBindHost, getAccountCount, getAccountList, removeAccount, _resetLockoutForTests,
} from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { startServer } from '../src/server.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const original = {
  dashboardPassword: config.dashboardPassword,
  apiKey: config.apiKey,
  allowNoAuth: process.env.DASHBOARD_ALLOW_NO_AUTH,
  allowedHosts: process.env.DASHBOARD_ALLOWED_HOSTS,
  corsOrigins: process.env.DASHBOARD_CORS_ORIGINS,
};

function restore(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = '';
  config.apiKey = '';
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
  delete process.env.DASHBOARD_ALLOWED_HOSTS;
  delete process.env.DASHBOARD_CORS_ORIGINS;
  configureBindHost('127.0.0.1');
});

afterEach(() => {
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = original.dashboardPassword;
  config.apiKey = original.apiKey;
  restore('DASHBOARD_ALLOW_NO_AUTH', original.allowNoAuth);
  restore('DASHBOARD_ALLOWED_HOSTS', original.allowedHosts);
  restore('DASHBOARD_CORS_ORIGINS', original.corsOrigins);
  configureBindHost('0.0.0.0');
});

function mkRes() {
  const captured = { status: null, body: null, headers: {} };
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      res.headersSent = true;
      return res;
    },
    end(payload) {
      try { captured.body = JSON.parse(payload); } catch { captured.body = payload; }
    },
    setHeader(k, v) { captured.headers[k] = v; },
    on() {},
    write() {},
  };
  return { res, captured };
}

function mutationReq(headers = {}) {
  return {
    method: 'PUT',
    url: '/dashboard/api/experimental',
    headers: {
      host: '127.0.0.1:3003',
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

async function mutate(headers, body = { clineCompat: true }) {
  const { res, captured } = mkRes();
  await handleDashboardApi('PUT', '/experimental', body, mutationReq(headers), res);
  return captured;
}

describe('A04: dashboard mutation request gate', () => {
  it('rejects a cross-site text/plain simple POST/PUT with 403 or 415 before side effects', async () => {
    const captured = await mutate({
      'content-type': 'text/plain;charset=UTF-8',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'empty',
    });
    assert.ok(
      captured.status === 403 || captured.status === 415,
      `cross-site text/plain mutation must be 403/415, got ${captured.status}`,
    );
  });

  it('still accepts the dashboard same-origin JSON request', async () => {
    const captured = await mutate({
      'content-type': 'application/json; charset=utf-8',
      origin: 'http://127.0.0.1:3003',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.equal(captured.body.success, true);
    assert.equal(captured.body.flags.clineCompat, true);
  });

  it('rejects a DNS-rebinding Host even when Origin agrees with it', async () => {
    const captured = await mutate({
      host: 'attacker.example:3003',
      'content-type': 'application/json',
      origin: 'http://attacker.example:3003',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(captured.status, 403);
    assert.equal(captured.body.error, 'ERR_DASHBOARD_HOST_REJECTED');
  });

  it('rejects Sec-Fetch-Site: same-site (strict same-origin only)', async () => {
    const captured = await mutate({
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3003',
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(captured.status, 403);
    assert.equal(captured.body.error, 'ERR_DASHBOARD_FETCH_METADATA_REJECTED');
  });

  it('rejects a body-bearing mutation with no Content-Type on a real HTTP request', async () => {
    const captured = await mutate({
      'content-length': '20',
      origin: 'http://127.0.0.1:3003',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(captured.status, 415);
    assert.equal(captured.body.error, 'ERR_UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects a cross-origin JSON request that would otherwise pass content-type', async () => {
    const captured = await mutate({
      'content-type': 'application/json',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(captured.status, 403);
    assert.equal(captured.body.error, 'ERR_DASHBOARD_ORIGIN_REJECTED');
  });

  it('rejects a cross-site simple POST to /accounts before creating an account', async () => {
    const label = `csrf-post-${Date.now()}`;
    const before = getAccountCount().total;
    try {
      const { res, captured } = mkRes();
      await handleDashboardApi('POST', '/accounts', {
        api_key: `sk-${label}`,
        label,
      }, {
        method: 'POST',
        url: '/dashboard/api/accounts',
        headers: {
          host: '127.0.0.1:3003',
          'content-type': 'text/plain;charset=UTF-8',
          'content-length': '80',
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-dest': 'empty',
        },
        socket: { remoteAddress: '127.0.0.1' },
      }, res);
      assert.ok(
        captured.status === 403 || captured.status === 415,
        `cross-site text/plain POST must be 403/415, got ${captured.status}`,
      );
      assert.equal(getAccountCount().total, before, 'the rejected POST must not create an account');
    } finally {
      for (const account of getAccountList()) {
        if (String(account.label || '').startsWith('csrf-post-')) removeAccount(account.id);
      }
    }
  });

  it('rejects a DNS-rebinding Host on GET reads (import-local leaks keys)', async () => {
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/accounts/import-local', {}, {
      method: 'GET',
      url: '/dashboard/api/accounts/import-local',
      headers: { host: 'attacker.example:3003' },
      socket: { remoteAddress: '127.0.0.1' },
    }, res);
    assert.equal(captured.status, 403);
    assert.equal(captured.body.error, 'ERR_DASHBOARD_HOST_REJECTED');
  });

  it('allows an operator-allowlisted cross-origin JSON dashboard', async () => {
    process.env.DASHBOARD_CORS_ORIGINS = 'https://ok.example';
    const captured = await mutate({
      'content-type': 'application/json',
      origin: 'https://ok.example',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.equal(captured.body.success, true);
  });

  it('keeps non-browser JSON clients (curl/scripts) usable', async () => {
    const captured = await mutate({ 'content-type': 'application/json' });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.equal(captured.body.success, true);
  });

  it('rejects the cross-site text/plain POST through the real HTTP server', async () => {
    const saved = { host: config.host, port: config.port };
    config.host = '127.0.0.1';
    config.port = 0;
    const server = startServer();
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    try {
      const port = server.address().port;
      const result = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ api_key: `sk-real-http-${Date.now()}`, label: 'csrf-real-http' });
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/dashboard/api/accounts',
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Content-Length': Buffer.byteLength(payload),
            Origin: 'https://evil.example',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Dest': 'empty',
          },
        }, res => {
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
        });
        req.on('error', reject);
        req.end(payload);
      });
      assert.ok(result.status === 403 || result.status === 415,
        `real-server cross-site text/plain POST must be 403/415, got ${result.status}`);
    } finally {
      await new Promise(resolve => server.close(resolve));
      config.host = saved.host;
      config.port = saved.port;
      configureBindHost('127.0.0.1');
    }
  });

  it('does not require a JSON content type on bodyless DELETE', async () => {
    const { res, captured } = mkRes();
    await handleDashboardApi('DELETE', '/experimental/conversation-pool', {}, mutationReq(), res);
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    assert.equal(captured.body.success, true);
  });
});

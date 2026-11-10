// SEC-01 regression (audit 2026-10-22): an unauthenticated empty
// `X-Dashboard-Password` header reached verifyPassword → scryptSync
// (N=2^14, ~20 ms of blocked event loop) on every request. Unlike a wrong
// NON-empty guess it also never advanced the brute-force lockout, so anyone
// who could reach the dashboard had a free CPU DoS (~46 req/s saturated the
// gateway). The fix rejects a blank proof before hashing; the real password
// path must stay byte-for-byte the same.
//
// The assertion is a real scrypt call count, not a wall-clock heuristic:
// `syncBuiltinESMExports()` makes the patched crypto.scryptSync visible to
// the named ESM import in src/runtime-config.js (verified against Node 24).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { config } from '../src/config.js';
import {
  addAccountByKey, configureBindHost, removeAccount, _resetLockoutForTests,
} from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';

const DASHBOARD_PW = 'sec01-dashboard-pw';
const original = {
  apiKey: config.apiKey,
  dashboardPassword: config.dashboardPassword,
};

let scryptCalls = 0;
let originalScrypt = null;
let accountId = null;

function installScryptCounter() {
  scryptCalls = 0;
  originalScrypt = crypto.scryptSync;
  crypto.scryptSync = (...args) => {
    scryptCalls += 1;
    return originalScrypt(...args);
  };
  syncBuiltinESMExports();
}

function restoreScrypt() {
  if (!originalScrypt) return;
  crypto.scryptSync = originalScrypt;
  syncBuiltinESMExports();
  originalScrypt = null;
}

function mkRes() {
  const captured = { status: null, body: null, headers: {} };
  const res = {
    headersSent: false,
    writeHead(status) { captured.status = status; res.headersSent = true; return res; },
    end(p) { try { captured.body = JSON.parse(p); } catch { captured.body = p; } },
    setHeader(k, v) { captured.headers[k] = v; },
    on() {},
  };
  return { res, captured };
}

function mkReq(headers = {}, ip = '203.0.113.7') {
  return { headers, socket: { remoteAddress: ip } };
}

beforeEach(() => {
  _resetLockoutForTests();
  config.apiKey = '';
  config.dashboardPassword = '';
  setRuntimeApiKey('');
  // Hash with the real scrypt BEFORE the counter is installed, so the counter
  // measures only verification work performed by the requests under test.
  setRuntimeDashboardPassword(DASHBOARD_PW);
  configureBindHost('0.0.0.0');
  installScryptCounter();
});

afterEach(() => {
  restoreScrypt();
  if (accountId) { removeAccount(accountId); accountId = null; }
  _resetLockoutForTests();
  setRuntimeApiKey('');
  setRuntimeDashboardPassword('');
  config.apiKey = original.apiKey;
  config.dashboardPassword = original.dashboardPassword;
  configureBindHost('0.0.0.0');
});

describe('SEC-01: blank dashboard proofs never reach scrypt', () => {
  it('25 requests with no header return 401 and call scrypt zero times', async () => {
    for (let i = 0; i < 25; i += 1) {
      const { res, captured } = mkRes();
      await handleDashboardApi('GET', '/config', {}, mkReq({}), res);
      assert.equal(captured.status, 401, `request ${i + 1} must stay unauthorized`);
    }
    assert.equal(scryptCalls, 0, 'an empty header must be rejected before verifyPassword/scrypt');
  });

  it('whitespace-only header (string and array form) is rejected before scrypt', async () => {
    for (const value of ['   ', '\t\n', ['  ']]) {
      const { res, captured } = mkRes();
      await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': value }), res);
      assert.equal(captured.status, 401);
    }
    assert.equal(scryptCalls, 0);
  });

  it('a wrong NON-empty guess still goes through verifyPassword/scrypt', async () => {
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': 'wrong-password' }), res);
    assert.equal(captured.status, 401);
    assert.equal(scryptCalls, 1, 'the real guessing path is unchanged');
  });

  it('the correct password still authenticates through the same scrypt path', async () => {
    const { res, captured } = mkRes();
    await handleDashboardApi('GET', '/config', {}, mkReq({ 'x-dashboard-password': DASHBOARD_PW }), res);
    assert.equal(captured.status, 200);
    assert.equal(scryptCalls, 1);
  });

  it('reveal-key re-auth: blank body/header proof is refused without a second scrypt', async () => {
    const account = addAccountByKey(`devin-session-token$sec01-${Date.now()}`, 'sec01');
    accountId = account.id;

    // Ambient dashboard auth still hashes once (checkAuth). The blank re-auth
    // proof must not add another scrypt call.
    for (const [body, headers] of [
      [{}, { 'x-dashboard-password': DASHBOARD_PW }],
      [{ password: '   ' }, { 'x-dashboard-password': DASHBOARD_PW }],
      [{}, { 'x-dashboard-password': DASHBOARD_PW, 'x-dashboard-password-confirm': '  ' }],
    ]) {
      scryptCalls = 0;
      const { res, captured } = mkRes();
      await handleDashboardApi('POST', `/account/${accountId}/reveal-key`, body, mkReq(headers), res);
      assert.equal(captured.status, 401);
      assert.equal(captured.body?.error, 'ERR_REVEAL_REAUTH_REQUIRED');
      assert.equal(scryptCalls, 1, 'only the ambient checkAuth may hash; confirmReauth must not');
    }
  });
});

// SEC-04 follow-up (3.10.0): PUT /settings/credentials accepted an
// all-whitespace dashboard password. The length gate ran on the raw string, so
// "        " (8 spaces) passed `pw.length < 8`, was scrypt-hashed, and became a
// password no operator can reproduce: the login header path trims and rejects
// blanks (SEC-01), so the account was left with a credential that can never
// authenticate and silently replaced the env fallback.
//
// The route now trims first, rejects a non-empty input that is blank after
// trimming, and stores the trimmed value. An empty string keeps its documented
// "clear the runtime override" meaning — that is how the dashboard offers
// "fall back to .env".

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import {
  __setRuntimeConfigPersistFailureForTests,
  _resetRuntimeConfigForTests,
  getCredentials,
  getEffectiveDashboardPasswordStored,
  setRuntimeApiKey,
  setRuntimeDashboardPassword,
  verifyPassword,
} from '../src/runtime-config.js';

const originalDashboardPassword = config.dashboardPassword;

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

function authedReq(password = 'operator-secret') {
  return {
    url: '/dashboard/api/settings/credentials',
    headers: { 'x-dashboard-password': password },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

afterEach(() => {
  _resetRuntimeConfigForTests();
  config.dashboardPassword = originalDashboardPassword;
});

describe('PUT /settings/credentials dashboardPassword validation', () => {
  it('rejects an 8-space password instead of hashing it', async () => {
    config.dashboardPassword = 'operator-secret';
    const res = fakeRes();
    await handleDashboardApi('PUT', '/settings/credentials', { dashboardPassword: '        ' }, authedReq(), res);

    assert.equal(res.statusCode, 400, JSON.stringify(res.json()));
    assert.match(res.json().error, /dashboardPassword/);
    assert.equal(
      getEffectiveDashboardPasswordStored(),
      'operator-secret',
      'the env fallback must remain in force after a rejected rotation'
    );
  });

  it('rejects a password shorter than 8 characters after trimming', async () => {
    config.dashboardPassword = 'operator-secret';
    const res = fakeRes();
    await handleDashboardApi('PUT', '/settings/credentials', { dashboardPassword: '   short   ' }, authedReq(), res);

    assert.equal(res.statusCode, 400, JSON.stringify(res.json()));
    assert.equal(getEffectiveDashboardPasswordStored(), 'operator-secret');
  });

  it('accepts a normal password, stores the trimmed value, and returns 200', async () => {
    config.dashboardPassword = 'operator-secret';
    const res = fakeRes();
    await handleDashboardApi('PUT', '/settings/credentials', { dashboardPassword: '  goodpassword  ' }, authedReq(), res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.equal(res.json().dashboardPasswordUpdated, true);
    const stored = getEffectiveDashboardPasswordStored();
    assert.ok(stored.startsWith('scrypt$'), `expected scrypt hash, got ${stored.slice(0, 16)}`);
    assert.equal(verifyPassword('goodpassword', stored), true);
    assert.equal(verifyPassword('  goodpassword  ', stored), false, 'the untrimmed form must not authenticate');
  });

  it('still treats an empty string as "clear the runtime override"', async () => {
    config.dashboardPassword = 'operator-secret';
    setRuntimeDashboardPassword('runtime-password');

    const res = fakeRes();
    // The runtime hash now overrides the env password, so authenticate with it.
    await handleDashboardApi('PUT', '/settings/credentials', { dashboardPassword: '' }, authedReq('runtime-password'), res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.equal(getEffectiveDashboardPasswordStored(), 'operator-secret');
  });
});

// V-21 (audit A22): the route validated and COMMITTED `apiKey` before it looked
// at `dashboardPassword`, so a request that ends in 400 had already rotated the
// chat key on disk. The two credentials now form one transaction: the complete
// request is validated first, then both setters commit together (or neither
// does). A rejected password must leave the chat key exactly as it was.
describe('PUT /settings/credentials commits both credentials atomically', () => {
  it('a rejected dashboardPassword does not rotate the runtime chat apiKey', async () => {
    config.dashboardPassword = 'operator-secret';
    setRuntimeApiKey('sk-existing-key');
    assert.equal(getCredentials().apiKey, 'sk-existing-key');

    const res = fakeRes();
    await handleDashboardApi('PUT', '/settings/credentials', {
      apiKey: 'sk-replace-key',
      dashboardPassword: 'short',
    }, authedReq(), res);

    assert.equal(res.statusCode, 400, JSON.stringify(res.json()));
    assert.match(res.json().error, /dashboardPassword/);
    assert.equal(
      getCredentials().apiKey,
      'sk-existing-key',
      'a request rejected for its password must not rotate the chat apiKey',
    );
    const onDisk = JSON.parse(readFileSync(join(config.dataDir, 'runtime-config.json'), 'utf-8'));
    assert.equal(onDisk.credentials.apiKey, 'sk-existing-key', 'the rejected key must not reach the file');
    assert.equal(res.json().apiKeyUpdated, undefined, 'a rejected request must not claim a rotation');
  });

  it('a rejected apiKey does not rotate the dashboard password', async () => {
    config.dashboardPassword = 'operator-secret';
    const before = getEffectiveDashboardPasswordStored();

    const res = fakeRes();
    await handleDashboardApi('PUT', '/settings/credentials', {
      apiKey: 'has whitespace',
      dashboardPassword: 'replacement-password',
    }, authedReq(), res);

    assert.equal(res.statusCode, 400, JSON.stringify(res.json()));
    assert.match(res.json().error, /apiKey/);
    assert.equal(getEffectiveDashboardPasswordStored(), before, 'the rejected request must not rotate the password');
  });

  it('a fully valid request commits both credentials in one write', async () => {
    config.dashboardPassword = 'operator-secret';
    setRuntimeApiKey('sk-existing-key');

    const res = fakeRes();
    await handleDashboardApi('PUT', '/settings/credentials', {
      apiKey: 'sk-both-key',
      dashboardPassword: 'both-applied-password',
    }, authedReq(), res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.equal(getCredentials().apiKey, 'sk-both-key');
    assert.equal(verifyPassword('both-applied-password', getEffectiveDashboardPasswordStored()), true);
    // Both fields in the SAME persisted document: a crash between two setters
    // could otherwise leave a rotated key next to the old password hash.
    const onDisk = JSON.parse(readFileSync(join(config.dataDir, 'runtime-config.json'), 'utf-8'));
    assert.equal(onDisk.credentials.apiKey, 'sk-both-key');
    assert.equal(onDisk.credentials.dashboardPasswordHash, getCredentials().dashboardPasswordHash);
  });

  it('a failed write rolls both fields back and reports 500', async () => {
    config.dashboardPassword = 'operator-secret';
    setRuntimeApiKey('sk-existing-key');
    const before = getCredentials();
    __setRuntimeConfigPersistFailureForTests(new Error('simulated ENOSPC'));
    try {
      const res = fakeRes();
      await handleDashboardApi('PUT', '/settings/credentials', {
        apiKey: 'sk-rollback-key',
        dashboardPassword: 'should-not-stick-either',
      }, authedReq(), res);

      assert.equal(res.statusCode, 500, JSON.stringify(res.json()));
      assert.equal(res.json().error, 'ERR_CREDENTIAL_PERSIST_FAILED');
      assert.deepEqual(getCredentials(), before, 'neither credential may remain applied after a failed write');
      assert.equal(verifyPassword('operator-secret', getEffectiveDashboardPasswordStored()), true);
      assert.equal(verifyPassword('should-not-stick-either', getEffectiveDashboardPasswordStored()), false);
    } finally {
      __setRuntimeConfigPersistFailureForTests(null);
    }
  });
});

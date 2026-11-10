import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccount } from '../src/dashboard/devin-read.js';

describe('dashboard account token selection', () => {
  it('prefers the Devin session token over the backend token', () => {
    const oldConnect = process.env.DEVIN_CONNECT_TOKEN;
    const oldBackend = process.env.DEVIN_BACKEND_TOKEN;
    process.env.DEVIN_CONNECT_TOKEN = 'session-token';
    process.env.DEVIN_BACKEND_TOKEN = 'backend-token';
    try {
      const account = resolveAccount();
      assert.equal(account.ok, true);
      assert.equal(account.token, 'session-token');
      assert.equal(account.accountId, 'env-token');
    } finally {
      if (oldConnect === undefined) delete process.env.DEVIN_CONNECT_TOKEN;
      else process.env.DEVIN_CONNECT_TOKEN = oldConnect;
      if (oldBackend === undefined) delete process.env.DEVIN_BACKEND_TOKEN;
      else process.env.DEVIN_BACKEND_TOKEN = oldBackend;
    }
  });
});

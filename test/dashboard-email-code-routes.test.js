// Dashboard HTTP surface for the email-code login flow.
//
// Routes (all POST, all behind the dashboard auth gate):
//   /windsurf-login/probe           → login-method classification, no credential
//   /windsurf-login/email/start     → {flowId, sent} — token stays server-side
//   /windsurf-login/email/complete  → same shape as /windsurf-login
//
// Zero network: the windsurf-login transport seam is injected, so the routes
// exercise the real handlers with fake upstream replies. No live email is sent.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost, removeAccount } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import {
  __setLoginTransportForTests,
  _resetEmailLockoutForTests,
  _resetEmailFlowsForTests,
} from '../src/dashboard/windsurf-login.js';

const PASSWORD_HEADER = { 'x-dashboard-password': 'dash-secret' };
const EMAIL = 'routes-email-code@example.test';
const CODE = '654321';
const VERIFY_TOKEN = 'route-verify-token-throwaway';
const SESSION_TOKEN = 'devin-session-token$ROUTEEMAILCODE';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
let createdAccountIds = [];

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function req(headers = PASSWORD_HEADER) {
  return { url: '/dashboard/api/windsurf-login', headers, socket: { remoteAddress: '127.0.0.1' } };
}

async function call(subpath, body, headers = PASSWORD_HEADER) {
  const res = fakeRes();
  await handleDashboardApi('POST', subpath, body, req(headers), res);
  return { status: res.statusCode, body: res.json() };
}

function makeTransport(routes) {
  const seen = [];
  const fn = async (url, opts) => {
    seen.push(url);
    for (const [matcher, reply] of routes) {
      if (url.includes(matcher)) {
        if (reply instanceof Error) throw reply;
        if (opts.raw) {
          const buf = Buffer.isBuffer(reply.data) ? reply.data : Buffer.from(JSON.stringify(reply.data));
          return { status: reply.status, data: buf };
        }
        return { status: reply.status, data: reply.data };
      }
    }
    throw new Error(`unexpected request to ${url}`);
  };
  fn.seen = seen;
  return fn;
}

const CONNECTIONS_OAUTH_ONLY = ['windsurf.com/_devin-auth/connections', {
  status: 200,
  data: {
    connections: [{ id: 'email', type: 'email', enabled: true }],
    auth_method: { method: 'auth1', has_password: false },
  },
}];
const EMAIL_START_OK = ['windsurf.com/_devin-auth/email/start', {
  status: 200, data: { email_verification_token: VERIFY_TOKEN },
}];
const EMAIL_COMPLETE_OK = ['windsurf.com/_devin-auth/email/complete', {
  status: 200, data: { token: 'auth1-route-throwaway' },
}];
const POSTAUTH_OK = ['WindsurfPostAuth', {
  status: 200, data: { sessionToken: SESSION_TOKEN, accountId: 'account-route' },
}];

beforeEach(() => {
  _resetRuntimeConfigForTests();
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  config.dashboardPassword = 'dash-secret';
  config.apiKey = '';
  configureBindHost('0.0.0.0');
});

afterEach(() => {
  __setLoginTransportForTests(null);
  for (const id of createdAccountIds) removeAccount(id);
  createdAccountIds = [];
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  _resetRuntimeConfigForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
});

describe('email-code routes require dashboard auth', () => {
  for (const subpath of ['/windsurf-login/probe', '/windsurf-login/email/start', '/windsurf-login/email/complete']) {
    it(`${subpath} is 401 without the dashboard password`, async () => {
      const t = makeTransport([]);
      __setLoginTransportForTests(t);
      const { status } = await call(subpath, { email: EMAIL, flowId: 'x', code: CODE }, {});
      assert.equal(status, 401);
      assert.deepEqual(t.seen, [], 'an unauthenticated call must not reach upstream');
    });
  }
});

describe('POST /windsurf-login/probe', () => {
  it('reports hasPassword:false + emailCode for the OAuth-only account', async () => {
    __setLoginTransportForTests(makeTransport([CONNECTIONS_OAUTH_ONLY]));
    const { status, body } = await call('/windsurf-login/probe', { email: EMAIL });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.hasPassword, false);
    assert.equal(body.emailCode, true);
    assert.equal(body.userExists, true);
    assert.equal(body.method, 'auth1');
    assert.equal(body.source, 'connections');
    assert.equal('email_verification_token' in body, false);
  });

  it('requires an email', async () => {
    const { status, body } = await call('/windsurf-login/probe', {});
    assert.equal(status, 400);
    assert.equal(body.error, 'ERR_EMAIL_REQUIRED');
  });

  it('refuses to probe an email that is under the login lockout', async () => {
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', { status: 200, data: { auth_method: { method: 'auth1', has_password: true } } }],
      ['windsurf.com/_devin-auth/password/login', { status: 401, data: { detail: 'Invalid email or password' } }],
    ]);
    __setLoginTransportForTests(t);
    // 3 credential failures trip the default threshold of 3.
    for (let i = 0; i < 3; i++) {
      const r = await call('/windsurf-login', { email: EMAIL, password: 'wrong-guess' });
      assert.equal(r.status, 400);
    }
    const { status, body } = await call('/windsurf-login/probe', { email: EMAIL });
    assert.equal(status, 400);
    assert.equal(body.error, 'ERR_EMAIL_LOCKED');
    assert.ok(body.retryAfterMs > 0);
  });
});

describe('POST /windsurf-login/email/start', () => {
  it('returns only the opaque flowId — never the verification token', async () => {
    __setLoginTransportForTests(makeTransport([EMAIL_START_OK]));
    const { status, body } = await call('/windsurf-login/email/start', { email: EMAIL });
    assert.equal(status, 200);
    assert.equal(body.sent, true);
    assert.match(body.flowId, /^[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(body).includes(VERIFY_TOKEN), false);
  });

  it('surfaces the per-email resend cooldown without tripping the IP ban overlay', async () => {
    __setLoginTransportForTests(makeTransport([EMAIL_START_OK]));
    await call('/windsurf-login/email/start', { email: EMAIL });
    const { status, body } = await call('/windsurf-login/email/start', { email: EMAIL });
    assert.equal(status, 400, '400 (not 429) keeps the UI from rendering an IP-wide ban');
    assert.equal(body.error, 'ERR_EMAIL_CODE_COOLDOWN');
    assert.ok(body.retryAfterMs > 0);
  });

  it('a failed send still arms the cooldown', async () => {
    const t = makeTransport([['windsurf.com/_devin-auth/email/start', { status: 400, data: { detail: 'sender unavailable' } }]]);
    __setLoginTransportForTests(t);
    const first = await call('/windsurf-login/email/start', { email: EMAIL });
    assert.equal(first.status, 400);
    assert.equal(first.body.error, 'ERR_EMAIL_START_FAILED');
    const second = await call('/windsurf-login/email/start', { email: EMAIL });
    assert.equal(second.status, 400);
    assert.equal(second.body.error, 'ERR_EMAIL_CODE_COOLDOWN');
    assert.equal(t.seen.length, 1, 'the failing upstream must not be called again inside the window');
  });
});

describe('POST /windsurf-login/email/complete', () => {
  it('logs in and returns the /windsurf-login response shape', async () => {
    __setLoginTransportForTests(makeTransport([EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]));
    const start = await call('/windsurf-login/email/start', { email: EMAIL });
    const { status, body } = await call('/windsurf-login/email/complete', {
      flowId: start.body.flowId, code: CODE, autoAdd: false,
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.apiKey, SESSION_TOKEN, 'autoAdd:false returns the raw key, like the password route');
    assert.equal(body.email, EMAIL);
    assert.equal(body.method, 'email_code');
    assert.equal(body.account, null);
  });

  it('auto-adds the account to the pool by default', async () => {
    __setLoginTransportForTests(makeTransport([EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]));
    const start = await call('/windsurf-login/email/start', { email: EMAIL });
    const { status, body } = await call('/windsurf-login/email/complete', {
      flowId: start.body.flowId, code: CODE,
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.account?.id, 'the account must be persisted');
    assert.notEqual(body.apiKey_masked, SESSION_TOKEN, 'the raw key must not be echoed when it was added to the pool');
    assert.match(body.apiKey_masked, /\.\.\./, 'the pool path returns a masked key, like the password route');
    createdAccountIds.push(body.account.id);
  });

  it('rejects a used flow with 409 and an expired flow with 410', async () => {
    __setLoginTransportForTests(makeTransport([EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]));
    const start = await call('/windsurf-login/email/start', { email: EMAIL });
    const first = await call('/windsurf-login/email/complete', {
      flowId: start.body.flowId, code: CODE, autoAdd: false,
    });
    assert.equal(first.status, 200);

    const replay = await call('/windsurf-login/email/complete', {
      flowId: start.body.flowId, code: CODE, autoAdd: false,
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, 'ERR_EMAIL_FLOW_USED');

    const unknown = await call('/windsurf-login/email/complete', {
      flowId: '0123456789abcdef0123456789abcdef', code: CODE, autoAdd: false,
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'ERR_EMAIL_FLOW_NOT_FOUND');
  });

  it('rejects a wrong code with the remaining attempts and no account added', async () => {
    __setLoginTransportForTests(makeTransport([
      EMAIL_START_OK,
      ['windsurf.com/_devin-auth/email/complete', { status: 400, data: { detail: 'Invalid verification code' } }],
    ]));
    const start = await call('/windsurf-login/email/start', { email: EMAIL });
    const { status, body } = await call('/windsurf-login/email/complete', {
      flowId: start.body.flowId, code: '000000',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'ERR_EMAIL_CODE_REJECTED');
    assert.equal(body.isAuthFail, true);
    assert.equal(body.attemptsRemaining, 4);
    assert.equal(body.account, undefined);
  });

  it('requires both flowId and code', async () => {
    const { status, body } = await call('/windsurf-login/email/complete', { flowId: 'x' });
    assert.equal(status, 400);
    assert.equal(body.error, 'ERR_EMAIL_FLOW_CODE_REQUIRED');
  });
});

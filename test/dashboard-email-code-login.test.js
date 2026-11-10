// Email-code login + OAuth-only account classification.
//
// Recon: .agent/loginrecon-20261022/LoginRecon.md §4.0/§4.1. The live account is
// OAuth/email-code-only: `POST /_devin-auth/connections` returns
// `auth_method.has_password:false` while `CheckUserLoginMethod` returns an EMPTY
// `{}`. The old code fell back to connections, read `connections[email].enabled`
// as "has a password", attempted `password/login`, and reported the upstream 401
// as ERR_INVALID_CREDENTIALS — a wrong-method signal disguised as a bad password.
//
// Zero network: httpsRequest is routed through __setLoginTransportForTests.
// Email addresses, codes and tokens here are throwaway literals; no live email
// is sent and no real credential is used.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/config.js';
import {
  windsurfLogin,
  probeLoginMethod,
  emailLoginStart,
  emailLoginComplete,
  checkEmailLocked,
  __setLoginTransportForTests,
  _resetEmailLockoutForTests,
  _resetEmailFlowsForTests,
} from '../src/dashboard/windsurf-login.js';

const EMAIL = 'oauth-only@example.test';
const PASSWORD = 'throwaway-not-real';
const CODE = '123456';
const VERIFY_TOKEN = 'verify-token-throwaway-value';
const AUTH1_TOKEN = 'auth1-throwaway-value';

function setFlag(on) {
  if (on) process.env.DEVIN_CONNECT_LOGIN_HOST_FALLBACK = '1';
  else delete process.env.DEVIN_CONNECT_LOGIN_HOST_FALLBACK;
}

// First-substring-match route table. Raw requests (PostAuth) get a Buffer.
// Avoid 5xx replies so the retry backoff never fires (keeps the suite fast).
function makeTransport(routes) {
  const seen = [];
  const requests = [];
  const fn = async (url, opts, postData) => {
    seen.push(url);
    requests.push({ url, opts, body: postData });
    for (const [matcher, reply] of routes) {
      if (url.includes(matcher)) {
        const r = typeof reply === 'function' ? reply(url, opts, postData) : reply;
        if (r instanceof Error) throw r;
        if (opts.raw) {
          const buf = Buffer.isBuffer(r.data) ? r.data
            : Buffer.from(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
          return { status: r.status, data: buf };
        }
        return { status: r.status, data: r.data };
      }
    }
    throw new Error(`unexpected request to ${url}`);
  };
  fn.seen = seen;
  fn.requests = requests;
  return fn;
}

// The live account's exact probe pair: CheckUserLoginMethod `{}` + connections
// with has_password:false and an ENABLED email connection (email *code*).
const CHECK_METHOD_EMPTY = ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: {} }];
const CONNECTIONS_OAUTH_ONLY = ['windsurf.com/_devin-auth/connections', {
  status: 200,
  data: {
    connections: [
      { id: 'email', type: 'email', enabled: true, client_id: null },
      { id: 'google-windsurf', type: 'google', enabled: true, client_id: 'google-client-id' },
      { id: 'github-windsurf', type: 'github', enabled: true, client_id: 'github-client-id' },
    ],
    sso_connections: [],
    auth_method: { method: 'auth1', has_password: false, enterprise_sso_domain: false },
  },
}];
const PASSWORD_LOGIN_REJECTED = ['windsurf.com/_devin-auth/password/login', { status: 401, data: { detail: 'Invalid email or password' } }];
const EMAIL_START_OK = ['windsurf.com/_devin-auth/email/start', {
  status: 200, data: { email_verification_token: VERIFY_TOKEN },
}];
const EMAIL_COMPLETE_OK = ['windsurf.com/_devin-auth/email/complete', {
  status: 200, data: { token: AUTH1_TOKEN },
}];
const POSTAUTH_OK = ['WindsurfPostAuth', {
  status: 200, data: { sessionToken: 'devin-session-token$EMAILCODE', accountId: 'account-email-code' },
}];

beforeEach(() => {
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  setFlag(false);
});
afterEach(() => {
  __setLoginTransportForTests(null);
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  setFlag(false);
});

describe('OAuth-only account classification', () => {
  it('has_password:false is terminal — no password attempt, no ERR_INVALID_CREDENTIALS', async () => {
    const t = makeTransport([CHECK_METHOD_EMPTY, CONNECTIONS_OAUTH_ONLY, PASSWORD_LOGIN_REJECTED]);
    __setLoginTransportForTests(t);

    await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null), (err) => {
      assert.equal(err.code, 'ERR_NO_PASSWORD_OAUTH_ACCOUNT',
        'an OAuth-only account must be classified by its login method, not by a password rejection');
      assert.equal(err.method, 'email_code', 'the caller must be told which method actually works');
      assert.equal(err.isAuthFail, false, 'a wrong-method signal is not a credential failure');
      assert.deepEqual(err.oauthProviders, ['google', 'github']);
      return true;
    });

    assert.deepEqual(
      t.seen.filter(u => u.includes('/password/login')), [],
      'an account that has no password must never be sent to password/login',
    );
  });

  it('a no-password answer does not feed the per-email lockout', async () => {
    const t = makeTransport([CHECK_METHOD_EMPTY, CONNECTIONS_OAUTH_ONLY, PASSWORD_LOGIN_REJECTED]);
    __setLoginTransportForTests(t);
    for (let i = 0; i < 4; i++) {
      await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD, null),
        (err) => err.code === 'ERR_NO_PASSWORD_OAUTH_ACCOUNT');
    }
    assert.equal(checkEmailLocked(EMAIL), null,
      'using the wrong login tab must never lock the email (3 strikes are for real credential guesses)');
  });

  it('probe reports the authoritative method and skips the secondary probe', async () => {
    const t = makeTransport([CHECK_METHOD_EMPTY, CONNECTIONS_OAUTH_ONLY]);
    __setLoginTransportForTests(t);
    const probe = await probeLoginMethod(EMAIL);
    assert.equal(probe.source, 'connections');
    assert.equal(probe.hasPassword, false);
    assert.equal(probe.userExists, true);
    assert.equal(probe.emailCode, true);
    assert.deepEqual(probe.oauth, ['google', 'github']);
    assert.deepEqual(t.seen.filter(u => u.includes('CheckUserLoginMethod')), [],
      'connections answered, so the unreliable Connect-RPC probe must not be consulted');
  });

  it('a password account probes as hasPassword:true with no email-code detour', async () => {
    const t = makeTransport([
      ['windsurf.com/_devin-auth/connections', {
        status: 200,
        data: { auth_method: { method: 'auth1', has_password: true } },
      }],
    ]);
    __setLoginTransportForTests(t);
    const probe = await probeLoginMethod(EMAIL);
    assert.equal(probe.hasPassword, true);
    assert.equal(probe.emailCode, false);
  });

  it('connections unreachable → CheckUserLoginMethod enriches, `{}` stays unknown', async () => {
    const unreachable = ['windsurf.com/_devin-auth/connections', { status: 404, data: { detail: 'not found' } }];
    const t1 = makeTransport([unreachable, ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: { userExists: true, hasPassword: false } }]]);
    __setLoginTransportForTests(t1);
    const fromCheck = await probeLoginMethod(EMAIL);
    assert.equal(fromCheck.source, 'check_user_login_method');
    assert.equal(fromCheck.hasPassword, false, 'a positive hasPassword:false from the secondary probe is usable');
    assert.equal(fromCheck.emailCode, true);

    const t2 = makeTransport([unreachable, CHECK_METHOD_EMPTY]);
    __setLoginTransportForTests(t2);
    const unknown = await probeLoginMethod(EMAIL);
    assert.equal(unknown.source, 'unknown');
    assert.equal(unknown.hasPassword, null,
      'an empty {} must be unknown — never password-capable and never "no password"');
    assert.equal(unknown.userExists, null);
  });
});

describe('emailLoginStart', () => {
  it('sends the documented payload and returns only an opaque flowId', async () => {
    const t = makeTransport([EMAIL_START_OK]);
    __setLoginTransportForTests(t);
    const out = await emailLoginStart(EMAIL);
    assert.equal(out.sent, true);
    assert.match(out.flowId, /^[0-9a-f]{32}$/, 'flowId must be an opaque 128-bit id');
    assert.equal(out.expiresInMs, 10 * 60 * 1000);
    assert.equal(JSON.stringify(out).includes(VERIFY_TOKEN), false,
      'the upstream verification token must never reach the browser');

    const req = t.requests.find(r => r.url.includes('/email/start'));
    assert.deepEqual(JSON.parse(req.body), { email: EMAIL, mode: 'login', product: 'Windsurf' });
    assert.match(req.opts.headers['Content-Type'], /application\/json/);
  });

  it('never logs the verification token', async () => {
    const t = makeTransport([EMAIL_START_OK]);
    __setLoginTransportForTests(t);
    const captured = [];
    const origInfo = log.info;
    const origWarn = log.warn;
    log.info = (...args) => captured.push(args.join(' '));
    log.warn = (...args) => captured.push(args.join(' '));
    try {
      await emailLoginStart(EMAIL);
    } finally {
      log.info = origInfo;
      log.warn = origWarn;
    }
    assert.ok(captured.length > 0, 'the start step must be logged');
    assert.equal(captured.some(line => line.includes(VERIFY_TOKEN)), false, 'token leaked into logs');
    assert.equal(captured.some(line => line.includes(EMAIL)), false, 'raw email leaked into logs');
  });

  it('rate-limits resends per email', async () => {
    const t = makeTransport([EMAIL_START_OK]);
    __setLoginTransportForTests(t);
    await emailLoginStart(EMAIL);
    await assert.rejects(() => emailLoginStart(EMAIL), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_CODE_COOLDOWN');
      assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 30_000);
      return true;
    });
    assert.equal(t.seen.filter(u => u.includes('/email/start')).length, 1,
      'the cooldown must stop the second upstream send');
  });

  it('surfaces an upstream send failure as ERR_EMAIL_START_FAILED', async () => {
    const t = makeTransport([['windsurf.com/_devin-auth/email/start', { status: 400, data: { detail: 'invalid email' } }]]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => emailLoginStart(EMAIL), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_START_FAILED');
      assert.equal(err.detail, 'invalid email');
      return true;
    });
  });

  it('a FAILED send still starts the cooldown (a failing upstream cannot be hammered)', async () => {
    const t = makeTransport([['windsurf.com/_devin-auth/email/start', { status: 400, data: { detail: 'sender unavailable' } }]]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => emailLoginStart(EMAIL),
      (err) => err.code === 'ERR_EMAIL_START_FAILED');

    // Second attempt inside the window: rejected locally, upstream not called
    // again. Without the pre-call stamp this retried immediately, forever.
    await assert.rejects(() => emailLoginStart(EMAIL), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_CODE_COOLDOWN');
      assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 30_000);
      return true;
    });
    assert.equal(t.seen.filter(u => u.includes('/email/start')).length, 1,
      'the failed send must not be retried upstream inside the cooldown');
  });
});

describe('emailLoginComplete', () => {
  it('verifies the code, exchanges PostAuth, and returns the windsurfLogin shape', async () => {
    const t = makeTransport([EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);
    const result = await emailLoginComplete(flowId, CODE);

    assert.equal(result.apiKey, 'devin-session-token$EMAILCODE');
    assert.equal(result.sessionToken, 'devin-session-token$EMAILCODE');
    assert.equal(result.email, EMAIL);
    assert.equal(result.name, EMAIL);
    assert.equal(result.viaEmailCode, true);
    assert.equal(result.apiServerUrl, '');

    const req = t.requests.find(r => r.url.includes('/email/complete'));
    assert.deepEqual(JSON.parse(req.body), {
      email_verification_token: VERIFY_TOKEN, code: CODE, mode: 'login',
    });
  });

  it('consumes the flow: a replayed flowId is rejected without a second upstream call', async () => {
    const t = makeTransport([EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);
    await emailLoginComplete(flowId, CODE);
    const callsAfterSuccess = t.requests.length;

    await assert.rejects(() => emailLoginComplete(flowId, CODE), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_FLOW_USED');
      return true;
    });
    assert.equal(t.requests.length, callsAfterSuccess, 'a used flow must not hit upstream again');
  });

  it('a wrong code is rejected, counted, and leaves the flow usable for a retry', async () => {
    let completeCalls = 0;
    const t = makeTransport([
      EMAIL_START_OK,
      ['windsurf.com/_devin-auth/email/complete', () => {
        completeCalls += 1;
        return completeCalls === 1
          ? { status: 400, data: { detail: 'Invalid verification code' } }
          : { status: 200, data: { token: AUTH1_TOKEN } };
      }],
      POSTAUTH_OK,
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);

    await assert.rejects(() => emailLoginComplete(flowId, '000000'), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_CODE_REJECTED');
      assert.equal(err.isAuthFail, true);
      assert.equal(err.attemptsRemaining, 4);
      return true;
    });

    const result = await emailLoginComplete(flowId, CODE);
    assert.equal(result.apiKey, 'devin-session-token$EMAILCODE', 'a typo must not burn the flow');
  });

  it('wrong codes feed the existing per-email lockout', async () => {
    const t = makeTransport([
      EMAIL_START_OK,
      ['windsurf.com/_devin-auth/email/complete', { status: 400, data: { detail: 'Invalid verification code' } }],
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => emailLoginComplete(flowId, '000000'),
        (err) => err.code === 'ERR_EMAIL_CODE_REJECTED');
    }
    assert.ok(checkEmailLocked(EMAIL) > 0, 'three rejected codes must trip the configured lockout');
    await assert.rejects(() => emailLoginComplete(flowId, '000000'),
      (err) => err.code === 'ERR_EMAIL_LOCKED');
  });

  it('rejects an expired flow', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const transport = makeTransport([EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]);
    __setLoginTransportForTests(transport);
    const { flowId } = await emailLoginStart(EMAIL);
    t.mock.timers.tick(10 * 60 * 1000 + 1);
    await assert.rejects(() => emailLoginComplete(flowId, CODE), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_FLOW_EXPIRED');
      assert.equal(err.statusCode, 410);
      return true;
    });
  });

  it('rejects an unknown flow and a malformed code without touching upstream', async () => {
    const t = makeTransport([EMAIL_START_OK, EMAIL_COMPLETE_OK]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => emailLoginComplete('deadbeef', CODE),
      (err) => err.code === 'ERR_EMAIL_FLOW_NOT_FOUND');
    const { flowId } = await emailLoginStart(EMAIL);
    await assert.rejects(() => emailLoginComplete(flowId, 'not-a-code'),
      (err) => err.code === 'ERR_EMAIL_CODE_INVALID');
    assert.deepEqual(t.seen.filter(u => u.includes('/email/complete')), [],
      'input validation must happen before any upstream call');
  });

  it('never logs the code or the upstream token', async () => {
    const t = makeTransport([EMAIL_START_OK, EMAIL_COMPLETE_OK, POSTAUTH_OK]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);
    const captured = [];
    const origInfo = log.info;
    const origWarn = log.warn;
    log.info = (...args) => captured.push(args.join(' '));
    log.warn = (...args) => captured.push(args.join(' '));
    try {
      await emailLoginComplete(flowId, CODE);
    } finally {
      log.info = origInfo;
      log.warn = origWarn;
    }
    assert.ok(captured.length > 0, 'the complete step must be logged');
    assert.equal(captured.some(line => line.includes(CODE)), false, 'verification code leaked into logs');
    assert.equal(captured.some(line => line.includes(AUTH1_TOKEN)), false, 'Auth1 token leaked into logs');
    assert.equal(captured.some(line => line.includes(VERIFY_TOKEN)), false, 'verification token leaked into logs');
    assert.equal(captured.some(line => line.includes('devin-session-token$EMAILCODE')), false,
      'session token leaked into logs');
  });
});

describe('email-code host fallback (app.devin.ai, flag-gated)', () => {
  const DEVIN_START_OK = ['app.devin.ai/api/auth1/email/start', {
    status: 200, data: { email_verification_token: 'devin-verify-token-throwaway' },
  }];
  const DEVIN_COMPLETE_OK = ['app.devin.ai/api/auth1/email/complete', {
    status: 200, data: { token: 'auth1-devin-throwaway', user_id: 'user-1' },
  }];

  it('falls back to app.devin.ai when the windsurf email endpoint is gone', async () => {
    setFlag(true);
    const t = makeTransport([
      ['windsurf.com/_devin-auth/email/start', { status: 404, data: { detail: 'not found' } }],
      DEVIN_START_OK,
      DEVIN_COMPLETE_OK,
      POSTAUTH_OK,
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);
    const result = await emailLoginComplete(flowId, CODE);

    assert.equal(result.apiKey, 'devin-session-token$EMAILCODE');
    assert.equal(result.viaHost, 'app.devin.ai');
    const devinStart = t.requests.find(r => r.url.includes('app.devin.ai/api/auth1/email/start'));
    assert.deepEqual(JSON.parse(devinStart.body), { email: EMAIL, mode: 'login' },
      'the Devin host payload has no product field');
    assert.ok(t.seen.some(u => u.includes('app.devin.ai/api/auth1/email/complete')),
      'the verification token must be completed on the host that issued it');
  });

  it('flag OFF: no second host is contacted', async () => {
    setFlag(false);
    const t = makeTransport([
      ['windsurf.com/_devin-auth/email/start', { status: 404, data: { detail: 'not found' } }],
      DEVIN_START_OK,
    ]);
    __setLoginTransportForTests(t);
    await assert.rejects(() => emailLoginStart(EMAIL), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_START_FAILED');
      return true;
    });
    assert.deepEqual(t.seen.filter(u => u.includes('app.devin.ai')), []);
  });

  it('a 4xx rejection is not retried on the second host (no double-spent attempt)', async () => {
    setFlag(true);
    const t = makeTransport([
      EMAIL_START_OK,
      ['windsurf.com/_devin-auth/email/complete', { status: 400, data: { detail: 'Invalid verification code' } }],
      DEVIN_COMPLETE_OK,
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);
    await assert.rejects(() => emailLoginComplete(flowId, '000000'),
      (err) => err.code === 'ERR_EMAIL_CODE_REJECTED');
    assert.deepEqual(t.seen.filter(u => u.includes('app.devin.ai')), [],
      'a credential rejection is upstream answering, not an availability failure');
  });
});

// Login hardening — the live defects measured by Q2 (MaxQ2Auth, 2026-10-22).
//
// F1 (P1) an unknown email is reported as an existing email-code account
// F5 (P2) an expired/invalid upstream verification token is counted as a wrong
//         code and feeds the 900 s email lockout (which also blocks password login)
// F6 (P2) a PostAuth failure after a valid code burns the code
// F8 (P2) email/start inherits the 5xx retry and can send three emails
// F3/F4/F9 (P2/P3) a show-auth-token token / `windsurf://…?access_token=` deep
//         link cannot be bulk-imported or batch-imported
//
// Zero network: the windsurf-login transport seam is injected, so every test
// below drives the real handlers with fake upstream replies. No email is sent
// and no real credential is used — addresses, codes and tokens are throwaway
// literals. The import routes take the real RegisterUser path, which the
// setup-env preload (scripts/mutation-network-deny.mjs) fails closed, so an
// attempted import is observable as a per-token failure, never a live call.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost, removeAccount } from '../src/auth.js';
import { handleDashboardApi, extractOAuthToken } from '../src/dashboard/api.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { classifyToken, parseAccountText, unwrapPastedSecret } from '../src/dashboard/account-text-parser.js';
import { parseBatchImportInput } from '../src/dashboard/import-parser.js';
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

const EMAIL = 'hardening-q2@example.test';
const PASSWORD = 'throwaway-not-real';
const CODE = '123456';
const VERIFY_TOKEN = 'verify-token-throwaway-value';
const AUTH1_TOKEN = 'auth1-throwaway-value';
const SESSION_TOKEN = 'devin-session-token$Q2HARDENING';

const DASHBOARD_PASSWORD = 'dash-secret';
const PASSWORD_HEADER = { 'x-dashboard-password': DASHBOARD_PASSWORD };
const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const createdAccounts = [];

// ── helpers ───────────────────────────────────────────────

function setFlag(on) {
  if (on) process.env.DEVIN_CONNECT_LOGIN_HOST_FALLBACK = '1';
  else delete process.env.DEVIN_CONNECT_LOGIN_HOST_FALLBACK;
}

// First-substring-match route table. A reply may be a value, a function
// (url, opts, body) → value, or an Error (thrown, i.e. a transport failure).
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
          const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(JSON.stringify(r.data));
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

async function call(subpath, body) {
  const res = fakeRes();
  const req = {
    url: `/dashboard/api${subpath}`,
    headers: PASSWORD_HEADER,
    socket: { remoteAddress: '127.0.0.1' },
  };
  await handleDashboardApi('POST', subpath, body, req, res);
  return { status: res.statusCode, body: res.json() };
}

// ── upstream fixtures ─────────────────────────────────────

// The EXACT live payload for an address that does not exist (Q2 S9/S17):
// `auth_method.method` is the string "not_found", NOT null. `has_password:false`
// is upstream answering about a method that has no account behind it.
const LIVE_CONNECTIONS_NOT_FOUND = ['windsurf.com/_devin-auth/connections', {
  status: 200,
  data: {
    connections: [
      { id: 'email', type: 'email', enabled: true, client_id: null },
      { id: 'google-windsurf', type: 'google', enabled: true, client_id: 'google-client-id' },
      { id: 'github-windsurf', type: 'github', enabled: true, client_id: 'github-client-id' },
    ],
    sso_connections: [],
    auth_method: { method: 'not_found', has_password: false, enterprise_sso_domain: false },
  },
}];

const CONNECTIONS_PASSWORD = ['windsurf.com/_devin-auth/connections', {
  status: 200,
  data: { auth_method: { method: 'auth1', has_password: true, enterprise_sso_domain: false } },
}];

const PASSWORD_LOGIN_OK = ['windsurf.com/_devin-auth/password/login', {
  status: 200, data: { token: AUTH1_TOKEN },
}];

const EMAIL_START_OK = ['windsurf.com/_devin-auth/email/start', {
  status: 200, data: { email_verification_token: VERIFY_TOKEN },
}];

const EMAIL_COMPLETE_OK = ['windsurf.com/_devin-auth/email/complete', {
  status: 200, data: { token: AUTH1_TOKEN },
}];

const POSTAUTH_OK = ['WindsurfPostAuth', {
  status: 200, data: { sessionToken: SESSION_TOKEN, accountId: 'account-q2' },
}];

beforeEach(() => {
  _resetRuntimeConfigForTests();
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  setFlag(false);
  config.dashboardPassword = DASHBOARD_PASSWORD;
  config.apiKey = '';
  configureBindHost('0.0.0.0');
});

afterEach(() => {
  __setLoginTransportForTests(null);
  for (const id of createdAccounts.splice(0)) removeAccount(id);
  _resetEmailLockoutForTests();
  _resetEmailFlowsForTests();
  _resetRuntimeConfigForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
  setFlag(false);
});

// ── F1 ────────────────────────────────────────────────────

describe('F1 — method:"not_found" is a missing account, not an email-code account', () => {
  it('probe reports userExists:false / method:null / emailCode:false for the live payload', async () => {
    const t = makeTransport([LIVE_CONNECTIONS_NOT_FOUND]);
    __setLoginTransportForTests(t);

    const probe = await probeLoginMethod(EMAIL);
    assert.equal(probe.source, 'connections');
    assert.equal(probe.userExists, false, 'not_found means the account does not exist');
    assert.equal(probe.method, null, 'the "not_found" sentinel must never leak out as a method');
    assert.equal(probe.emailCode, false, 'a missing account must not be offered an email code');
    assert.deepEqual(t.seen.filter(u => u.includes('/email/start')), [],
      'classification must not send mail');
  });

  it('the probe route returns userExists:false and offers no email code', async () => {
    __setLoginTransportForTests(makeTransport([LIVE_CONNECTIONS_NOT_FOUND]));
    const { status, body } = await call('/windsurf-login/probe', { email: EMAIL });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.userExists, false);
    assert.equal(body.method, null);
    assert.equal(body.emailCode, false);
  });

  it('password login returns ERR_EMAIL_NOT_FOUND and never tries password/login or email/start', async () => {
    const t = makeTransport([LIVE_CONNECTIONS_NOT_FOUND, PASSWORD_LOGIN_OK, EMAIL_START_OK]);
    __setLoginTransportForTests(t);

    await assert.rejects(() => windsurfLogin(EMAIL, PASSWORD), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_NOT_FOUND');
      assert.equal(err.isAuthFail, true);
      return true;
    });
    assert.deepEqual(t.seen.filter(u => u.includes('/password/login')), [],
      'a missing account must not be sent to password/login');
    assert.deepEqual(t.seen.filter(u => u.includes('/email/start')), [],
      'a missing account must not be sent an email code');
  });

  it('the login route returns the stable ERR_EMAIL_NOT_FOUND code', async () => {
    __setLoginTransportForTests(makeTransport([LIVE_CONNECTIONS_NOT_FOUND, PASSWORD_LOGIN_OK]));
    const { status, body } = await call('/windsurf-login', { email: EMAIL, password: PASSWORD });
    assert.equal(status, 400);
    assert.equal(body.error, 'ERR_EMAIL_NOT_FOUND');
  });
});

// ── F5 ────────────────────────────────────────────────────

describe('F5 — only a real code mismatch may count toward the email lockout', () => {
  it('401 "Invalid verification token" is ERR_EMAIL_FLOW_EXPIRED, not a wrong code', async () => {
    const t = makeTransport([
      EMAIL_START_OK,
      ['windsurf.com/_devin-auth/email/complete', { status: 401, data: { detail: 'Invalid verification token' } }],
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);

    await assert.rejects(() => emailLoginComplete(flowId, CODE), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_FLOW_EXPIRED');
      assert.equal(err.statusCode, 410);
      assert.equal(err.isAuthFail, false, 'a stale upstream token is not a credential guess');
      return true;
    });
    assert.equal(t.seen.filter(u => u.includes('/email/complete')).length, 1,
      'a 401 must not be retried upstream');
    assert.equal(checkEmailLocked(EMAIL), null, 'an expired token must not count as a wrong code');
  });

  it('three expired-token attempts do not lock password login', async () => {
    let startCalls = 0;
    const t = makeTransport([
      ['windsurf.com/_devin-auth/email/start', () => {
        startCalls += 1;
        return { status: 200, data: { email_verification_token: `${VERIFY_TOKEN}-${startCalls}` } };
      }],
      ['windsurf.com/_devin-auth/email/complete', { status: 401, data: { detail: 'Invalid verification token' } }],
      CONNECTIONS_PASSWORD,
      PASSWORD_LOGIN_OK,
      POSTAUTH_OK,
    ]);
    __setLoginTransportForTests(t);

    for (let i = 0; i < 3; i++) {
      // Each attempt needs its own flow; drop the 30 s resend cooldown between
      // them the same way a new page load would (new flow, same address).
      _resetEmailFlowsForTests();
      const { flowId } = await emailLoginStart(EMAIL);
      await assert.rejects(() => emailLoginComplete(flowId, CODE),
        (err) => err.code === 'ERR_EMAIL_FLOW_EXPIRED');
    }
    assert.equal(checkEmailLocked(EMAIL), null,
      'expired upstream tokens must never trip the 3-strike lockout');

    const ok = await windsurfLogin(EMAIL, PASSWORD);
    assert.equal(ok.apiKey, SESSION_TOKEN, 'password login must still work after those attempts');
  });

  it('a transport failure on complete is retryable and burns nothing', async () => {
    // The complete endpoint keeps its 5xx/transport retry (it sends no mail).
    // Fail every attempt of the first user call, then answer: the user-visible
    // result must be a coded, retryable error with the code still usable.
    let completeCalls = 0;
    const t = makeTransport([
      EMAIL_START_OK,
      ['windsurf.com/_devin-auth/email/complete', () => {
        completeCalls += 1;
        if (completeCalls <= 3) return new Error('Request error: socket hang up');
        return { status: 200, data: { token: AUTH1_TOKEN } };
      }],
      POSTAUTH_OK,
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);

    await assert.rejects(() => emailLoginComplete(flowId, CODE), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_VERIFY_UNAVAILABLE');
      assert.equal(err.statusCode, 502);
      assert.equal(err.retryable, true);
      return true;
    });
    assert.equal(checkEmailLocked(EMAIL), null, 'an upstream transport failure is not a wrong code');

    const result = await emailLoginComplete(flowId, CODE);
    assert.equal(result.apiKey, SESSION_TOKEN, 'the same code must still be usable after a transport blip');
  });

  it('a real wrong code still counts and still locks', async () => {
    const t = makeTransport([
      EMAIL_START_OK,
      ['windsurf.com/_devin-auth/email/complete', { status: 400, data: { detail: 'Invalid verification code' } }],
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => emailLoginComplete(flowId, '000000'),
        (err) => err.code === 'ERR_EMAIL_CODE_REJECTED' && err.isAuthFail === true);
    }
    assert.ok(checkEmailLocked(EMAIL) > 0, 'a genuine mismatch must still trip the lockout');
  });
});

// ── F6 ────────────────────────────────────────────────────

describe('F6 — a PostAuth failure does not burn the code', () => {
  it('retries the exchange without a second email/complete call', async () => {
    let postAuthCalls = 0;
    const t = makeTransport([
      EMAIL_START_OK,
      EMAIL_COMPLETE_OK,
      ['WindsurfPostAuth', () => {
        postAuthCalls += 1;
        return postAuthCalls === 1
          ? { status: 401, data: { detail: 'unauthenticated' } }
          : { status: 200, data: { sessionToken: SESSION_TOKEN, accountId: 'account-q2' } };
      }],
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);

    await assert.rejects(() => emailLoginComplete(flowId, CODE), (err) => {
      assert.equal(err.code, 'ERR_POSTAUTH_FAILED');
      assert.equal(err.statusCode, 502);
      assert.equal(err.retryable, true);
      return true;
    });
    assert.equal(t.seen.filter(u => u.includes('/email/complete')).length, 1);

    const result = await emailLoginComplete(flowId, CODE);
    assert.equal(result.apiKey, SESSION_TOKEN, 'the accepted code must survive a PostAuth blip');
    assert.equal(t.seen.filter(u => u.includes('/email/complete')).length, 1,
      'the retry must reuse the stored Auth1 token, not replay the spent verification token');

    await assert.rejects(() => emailLoginComplete(flowId, CODE),
      (err) => err.code === 'ERR_EMAIL_FLOW_USED');
  });

  it('a PostAuth transport failure is a coded, retryable error', async () => {
    const t = makeTransport([
      EMAIL_START_OK,
      EMAIL_COMPLETE_OK,
      ['WindsurfPostAuth', new Error('Request error: socket hang up')],
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);

    await assert.rejects(() => emailLoginComplete(flowId, CODE), (err) => {
      assert.equal(err.code, 'ERR_POSTAUTH_FAILED');
      assert.equal(err.retryable, true);
      return true;
    });
    assert.equal(checkEmailLocked(EMAIL), null);
  });

  it('the exchange retry window closes: a spent code is never replayed', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    let completeCalls = 0;
    const tr = makeTransport([
      EMAIL_START_OK,
      ['windsurf.com/_devin-auth/email/complete', () => {
        completeCalls += 1;
        return { status: 200, data: { token: AUTH1_TOKEN } };
      }],
      ['WindsurfPostAuth', { status: 401, data: { detail: 'unauthenticated' } }],
    ]);
    __setLoginTransportForTests(tr);
    const { flowId } = await emailLoginStart(EMAIL);

    await assert.rejects(() => emailLoginComplete(flowId, CODE),
      (err) => err.code === 'ERR_POSTAUTH_FAILED');

    // Past the 2-minute window the Auth1 token may no longer be replayed, and
    // the verification token is already spent upstream — the only honest answer
    // is "request a new code", without a second complete call.
    t.mock.timers.tick(2 * 60 * 1000 + 1);
    await assert.rejects(() => emailLoginComplete(flowId, CODE), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_FLOW_EXPIRED');
      assert.equal(err.statusCode, 410);
      return true;
    });
    assert.equal(completeCalls, 1, 'a spent verification token is never replayed');
  });

  it('bounds the retries: three exchange attempts, then the flow is spent', async () => {
    const t = makeTransport([
      EMAIL_START_OK,
      EMAIL_COMPLETE_OK,
      ['WindsurfPostAuth', { status: 401, data: { detail: 'unauthenticated' } }],
    ]);
    __setLoginTransportForTests(t);
    const { flowId } = await emailLoginStart(EMAIL);

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => emailLoginComplete(flowId, CODE), (err) => {
        assert.equal(err.code, 'ERR_POSTAUTH_FAILED');
        assert.equal(err.attemptsRemaining, 2 - i);
        return true;
      });
    }
    await assert.rejects(() => emailLoginComplete(flowId, CODE),
      (err) => err.code === 'ERR_EMAIL_FLOW_USED');
    assert.equal(t.seen.filter(u => u.includes('/email/complete')).length, 1,
      'the spent verification token is never replayed');
  });
});

// ── F8 ────────────────────────────────────────────────────

describe('F8 — email/start sends exactly once', () => {
  it('a 5xx upstream is not retried: one send, coded error', async () => {
    const t = makeTransport([
      ['windsurf.com/_devin-auth/email/start', { status: 504, data: { detail: 'FUNCTION_INVOCATION_TIMEOUT' } }],
    ]);
    __setLoginTransportForTests(t);

    await assert.rejects(() => emailLoginStart(EMAIL), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_START_FAILED');
      assert.equal(err.statusCode, 502);
      return true;
    });
    assert.equal(t.seen.filter(u => u.includes('/email/start')).length, 1,
      'three sends of the same code in 7 s was the live defect');
  });

  it('a transport failure escapes with a stable code, after one attempt', async () => {
    const t = makeTransport([
      ['windsurf.com/_devin-auth/email/start', new Error('Request error: socket hang up')],
    ]);
    __setLoginTransportForTests(t);

    await assert.rejects(() => emailLoginStart(EMAIL), (err) => {
      assert.equal(err.code, 'ERR_EMAIL_START_FAILED',
        'the raw transport Error used to escape with err.code === undefined');
      assert.equal(err.statusCode, 502);
      return true;
    });
    assert.equal(t.seen.filter(u => u.includes('/email/start')).length, 1,
      'an ambiguous send is never repeated');
  });

  it('the route returns a structured error body with the stable code', async () => {
    __setLoginTransportForTests(makeTransport([
      ['windsurf.com/_devin-auth/email/start', { status: 503, data: { detail: 'upstream overloaded' } }],
    ]));
    const { status, body } = await call('/windsurf-login/email/start', { email: EMAIL });
    assert.equal(status, 502);
    assert.equal(body.error, 'ERR_EMAIL_START_FAILED');
    assert.equal(typeof body.detail, 'string');
    assert.equal(body.sent, undefined);
  });
});

// ── F3 / F4 / F9 ──────────────────────────────────────────

describe('F3/F4/F9 — token-only imports', () => {
  // A show-auth-token / OneTimeAuthToken value: 47 chars of [A-Za-z0-9_-],
  // measured live (Q2 S14). classifyToken cannot name it — that is the point.
  const OTT = 'Ab3_x-9'.repeat(7).slice(0, 47);
  const DEEP_LINK = `windsurf://codeium.windsurf?access_token=${OTT}&state=xyz`;

  it('the fixture really is the unclassified 47-char shape', () => {
    assert.equal(OTT.length, 47);
    assert.equal(classifyToken(OTT), 'unknown');
  });

  it('extractOAuthToken pulls the token out of a windsurf:// deep link', () => {
    assert.equal(extractOAuthToken(DEEP_LINK), OTT);
    assert.equal(extractOAuthToken(`windsurf://codeium.windsurf#access_token=${OTT}`), OTT);
    assert.equal(extractOAuthToken(`vscode://windsurf.windsurf?token=${OTT}`), OTT);
  });

  it('unwrapPastedSecret pulls the token out of a windsurf:// deep link', () => {
    assert.equal(unwrapPastedSecret(DEEP_LINK), OTT);
    assert.equal(unwrapPastedSecret(`windsurf://codeium.windsurf#token=${OTT}`), OTT);
    assert.throws(() => unwrapPastedSecret('windsurf://codeium.windsurf?state=abc'),
      (err) => err.code === 'ERR_NO_TOKEN_IN_INPUT');
  });

  it('parseAccountText extracts a deep link instead of storing the whole URL', () => {
    const out = parseAccountText(`${DEEP_LINK}\n`);
    assert.deepEqual(out.tokens, [OTT]);
    assert.equal(JSON.stringify(out).includes('windsurf://'), false,
      'the URL itself must never become the credential');
  });

  it('parseAccountText keeps a bare 47-char token', () => {
    const out = parseAccountText(`${OTT}\n`);
    assert.deepEqual(out.tokens, [OTT]);
  });

  it('batch import accepts a token-only line and a deep-link line', () => {
    const parsed = parseBatchImportInput([
      OTT,
      DEEP_LINK,
      `${EMAIL} ${PASSWORD}`,
    ].join('\n'), () => null);
    assert.equal(parsed.mode, 'text');
    assert.deepEqual(parsed.items.map(i => i.kind), ['token', 'token', 'email_password']);
    assert.deepEqual(parsed.items.slice(0, 2).map(i => i.token), [OTT, OTT]);
    assert.equal(parsed.items[2].email, EMAIL);
    assert.equal(parsed.items[2].password, PASSWORD);
  });

  it('batch import of a session-token line adds the account without RegisterUser', async () => {
    const token = `devin-session-token$ws-q2-batch-${Date.now()}`;
    const { status, body } = await call('/batch-import', { text: token, autoAdd: true });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.successCount, 1, JSON.stringify(body));
    assert.equal(body.results[0].importKind, 'token');
    const id = body.results[0].account?.id;
    assert.ok(id);
    createdAccounts.push(id);
  });

  it('/accounts/import-text attempts a 47-char show-auth-token instead of skipping it', async () => {
    const { status, body } = await call('/accounts/import-text', { text: `${OTT}\n` });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.skipped.length, 0,
      `an opaque 47-char token must not be dropped as "unclassified": ${JSON.stringify(body)}`);
    assert.equal(body.failed.length, 1, JSON.stringify(body));
    assert.equal(body.failed[0].kind, 'unknown');
  });

  it('/accounts/import-text extracts a windsurf:// deep link before RegisterUser', async () => {
    const { status, body } = await call('/accounts/import-text', { text: `${DEEP_LINK}\n` });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.skipped.length, 0, JSON.stringify(body));
    assert.equal(body.failed.length, 1, JSON.stringify(body));
    assert.equal(JSON.stringify(body).includes('windsurf://'), false,
      'the whole URL must never reach RegisterUser');
  });

  it('/accounts/import-text still reports a token-less URL as failed', async () => {
    const { status, body } = await call('/accounts/import-text', {
      text: 'https://windsurf.com/show-auth-token?state=abc\n',
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.added.length, 0);
    assert.equal(body.failed.length, 1);
    assert.match(String(body.failed[0].error || ''), /ERR_NO_TOKEN_IN_INPUT/);
  });
});

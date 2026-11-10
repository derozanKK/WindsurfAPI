// Firebase API-key referrer-block error mapping (#FirebaseReferrerBlock).
//
// identitytoolkit.googleapis.com returns 403 `API_KEY_HTTP_REFERRER_BLOCKED`
// when the API key's referrer allowlist rejects the caller's Origin/Referer —
// the shape we hit when this proxy's egress (or a login proxy) is not on the
// key's allowlist. That code must resolve to a dedicated ERR_HTTP_REFERRER_BLOCKED
// (a deployment problem, NOT a credential failure: it must never read as
// "wrong password", and must never count toward the email lockout).
//
// The mapper is internal (createFriendlyAuthError); the two observable
// surfaces are (a) the errorCodeMap source line and (b) the real login flow
// via the injected transport seam (__setLoginTransportForTests), which is how
// this test drives windsurfLogin to the Firebase path deterministically with
// zero real network. Also pins the referrer-identity headers that keep that
// same egress from being blocked in the first place: every request now carries
// x-client-version (mirrors the official client version src/windsurf.js sends)
// plus the desktop Origin/Referer/User-Agent set.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  windsurfLogin,
  __setLoginTransportForTests,
  _resetEmailLockoutForTests,
} from '../src/dashboard/windsurf-login.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGIN_SRC = readFileSync(join(__dirname, '..', 'src', 'dashboard', 'windsurf-login.js'), 'utf8');

// Mirrors the module's own resolution (windsurf-login.js:199). The env override is a
// documented supported knob, so the test must compare against the resolved value, not
// a literal — a hardcoded '2.0.67' fails for any operator who set WINDSURF_CLIENT_VERSION.
const EXPECTED_CLIENT_VERSION = process.env.WINDSURF_CLIENT_VERSION || '2.0.67';

// Email-lockout config must stay unset so no ban interferes (default 3
// failures / 15 min — the firebase path used below throws before recording).
beforeEach(() => { _resetEmailLockoutForTests(); });
afterEach(() => { __setLoginTransportForTests(null); _resetEmailLockoutForTests(); });

describe('Firebase referrer-block error mapping', () => {
  it('maps API_KEY_HTTP_REFERRER_BLOCKED to ERR_HTTP_REFERRER_BLOCKED', () => {
    // Static-validate the mapping line. Driving the whole login path for the
    // code assertion would be a heavier fixture; the exact errorCodeMap entry
    // is the pinned source of truth here.
    const m = LOGIN_SRC.match(/'API_KEY_HTTP_REFERRER_BLOCKED': 'ERR_HTTP_REFERRER_BLOCKED'/);
    assert.ok(m, 'errorCodeMap must map API_KEY_HTTP_REFERRER_BLOCKED → ERR_HTTP_REFERRER_BLOCKED');
    assert.ok(!m[0].includes(';'),
      'the mapping must be its own entry (not folded into a preceding line)');
  });

  it('the referrer-block code is NOT an auth failure (must not read as wrong password / feed lockout)', () => {
    // The lockout counter only moves when e?.isAuthFail — a referrer-block is
    // a deployment problem, so it must stay out of that list.
    assert.ok(LOGIN_SRC.match(/isAuthFail\s*=\s*\[/),
      'isAuthFail allowlist block must exist');
    const allowlist = LOGIN_SRC.slice(LOGIN_SRC.indexOf('isAuthFail = ['));
    const block = allowlist.slice(0, allowlist.indexOf('];'));
    assert.ok(block && !block.includes('API_KEY_HTTP_REFERRER_BLOCKED'),
      'API_KEY_HTTP_REFERRER_BLOCKED must not be treated as an auth failure');
  });

  it('the firebase hop reads the structured reason, the message, and the code', () => {
    // identitytoolkit's real referrer-block envelope is a numeric code plus a prose
    // message, with the machine-readable code in `details[].reason`:
    //   {error:{code:403, status:'PERMISSION_DENIED',
    //           message:'Requests from referer <x> are blocked.',
    //           details:[{reason:'API_KEY_HTTP_REFERRER_BLOCKED'}]}}
    // Reading only message/code (the original version of this code) meant the mapping
    // fired only for a shape Google never sends, and the operator got the prose string
    // as their error "code". All three sources must be consulted, reason first.
    //
    // Asserted structurally rather than by grepping for a variable name: the previous
    // version of this test pinned the literal `fbRes.data.error.message`, so a rename
    // broke it while the behaviour was fine. Behaviour is pinned end-to-end by the
    // transport-seam tests below; this one guards the extraction's THREE sources.
    const fbFn = LOGIN_SRC.match(/async function windsurfLoginViaFirebase\([^)]*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fbFn, 'windsurfLoginViaFirebase must exist');
    const body = fbFn[0];
    assert.match(body, /details/,
      'must read the structured details[] where Google puts the real reason');
    assert.match(body, /\breason\b/,
      'must read details[].reason — the machine-readable code');
    assert.match(body, /\.message\b/,
      'must still read the prose message');
    assert.match(body, /\.code\b/,
      'must fall back to the error code');
    assert.match(body, /createFriendlyAuthError\(/,
      'the error must flow through createFriendlyAuthError so the map applies');
  });
});

describe('Firebase referrer-block — end-to-end via transport seam', () => {
  function makeTransport(routes) {
    const fn = async (url, opts) => {
      for (const [matcher, reply] of routes) {
        if (url.includes(matcher)) {
          // Raw requests (PostAuth) get a Buffer so parsePostAuthResponseData
          // can decode the body; JSON hops get a plain object.
          if (opts.raw && !Buffer.isBuffer(reply.data)) {
            const raw = typeof reply.data === 'string' ? reply.data : JSON.stringify(reply.data);
            return { status: reply.status, data: Buffer.from(raw) };
          }
          return reply;
        }
      }
      throw new Error(`unexpected request to ${url}`);
    };
    return fn;
  }

  it('returns ERR_HTTP_REFERRER_BLOCKED for a code-only 403 from identitytoolkit', async () => {
    // Route the login flow down the legacy Firebase path: the email-method
    // probe (CheckUserLoginMethod + connections) must report "unknown method"
    // so windsurfLoginPrimaryHost falls through to windsurfLoginViaFirebase.
    const t = makeTransport([
      ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: {} }],
      // A non-auth1 method routes the flow to the legacy Firebase path.
      ['windsurf.com/_devin-auth/connections', { status: 200, data: { auth_method: { method: 'firebase' } } }],
      ['identitytoolkit.googleapis.com', {
        status: 403,
        data: { error: { code: 'API_KEY_HTTP_REFERRER_BLOCKED' } },
      }],
    ]);
    __setLoginTransportForTests(t);
    await assert.rejects(
      () => windsurfLogin('referrer-block@example.com', 'throwaway-password', null),
      (err) => {
        assert.equal(err.code, 'ERR_HTTP_REFERRER_BLOCKED',
          'the Firebase referrer-block must surface the mapped code');
        assert.equal(err.isAuthFail, false,
          'a referrer restriction is a deployment problem, not an auth failure');
        assert.ok(!err.firebaseCode.includes('ERR_'), `firebaseCode must be the raw code, got ${err.firebaseCode}`);
        return true;
      },
    );
  });

  it('returns ERR_HTTP_REFERRER_BLOCKED for the REAL envelope — numeric code + prose message + details[].reason', async () => {
    // The realistic Google 403 is NOT the code-only shape above. It is:
    //   {error:{code:403, status:'PERMISSION_DENIED',
    //           message:'Requests from referer <x> are blocked.',
    //           details:[{reason:'API_KEY_HTTP_REFERRER_BLOCKED'}]}}
    // The fix that reads `details[].reason` exists precisely for this shape; before
    // it, only message/code were read, so the mapping never fired and the operator got
    // the prose string as their error "code". This pins the shape the fix targets.
    const t = makeTransport([
      ['SeatManagementService/CheckUserLoginMethod', { status: 200, data: {} }],
      // A non-auth1 method routes the flow to the legacy Firebase path.
      ['windsurf.com/_devin-auth/connections', { status: 200, data: { auth_method: { method: 'firebase' } } }],
      ['identitytoolkit.googleapis.com', {
        status: 403,
        data: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Requests from referer <x> are blocked.', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } },
      }],
    ]);
    __setLoginTransportForTests(t);
    await assert.rejects(
      () => windsurfLogin('referrer-block2@example.com', 'throwaway-password', null),
      (err) => {
        assert.equal(err.code, 'ERR_HTTP_REFERRER_BLOCKED',
          'the structured reason in details[] must resolve to the mapped code');
        assert.equal(err.isAuthFail, false,
          'a referrer restriction is a deployment problem, not an auth failure');
        return true;
      },
    );
  });

  it('sends x-client-version + desktop referrer headers on every auth request', async () => {
    // The referrer-block fix only helps if the egress headers carry the same
    // desktop-client identity the upstream referrer allowlist expects. Pin
    // that the check-login-method probe and the Auth1 password/login hop both
    // carry x-client-version and a desktop Origin/Referer/User-Agent.
    const seen = [];
    const t = async (url, opts) => {
      seen.push({ url, opts });
      if (url.includes('SeatManagementService/CheckUserLoginMethod')) {
        return { status: 200, data: { userExists: true, hasPassword: true } };
      }
      if (url.includes('windsurf.com/_devin-auth/password/login')) {
        return { status: 200, data: { token: 'auth1-ok' } };
      }
      if (url.includes('WindsurfPostAuth')) {
        return { status: 200, data: Buffer.from(JSON.stringify({ sessionToken: 'devin-session-token$NEW', accountId: 'account-x' })) };
      }
      throw new Error(`unexpected request to ${url}`);
    };
    __setLoginTransportForTests(t);
    const result = await windsurfLogin('headers-check@example.com', 'throwaway-password', null);
    assert.ok(result.apiKey, 'login must complete so the header-bearing hops ran');

    const jsonHops = seen.filter(({ url }) => !url.includes('WindsurfPostAuth'));
    assert.ok(jsonHops.length >= 2, `expected >=2 JSON hops, saw ${jsonHops.length}`);
    for (const { url, opts } of jsonHops) {
      assert.match(url, /windsurf\.com/);
      // Assert the header is PRESENT and matches the resolved client version, not a
      // literal: WINDSURF_CLIENT_VERSION is a documented override (windsurf-login.js,
      // and identically in windsurf.js), so hardcoding the current default made this
      // test fail for any operator who set it — a false alarm about their config.
      assert.equal(opts.headers['x-client-version'], EXPECTED_CLIENT_VERSION,
        `x-client-version must be sent on ${url}`);
      assert.equal(opts.headers['Origin'], 'https://windsurf.com',
        `Origin must be present on ${url}`);
      assert.equal(opts.headers['Referer'], 'https://windsurf.com/',
        `Referer must be present on ${url}`);
      assert.match(opts.headers['User-Agent'], /^Mozilla\/5\.0 \(/,
        `a desktop User-Agent must be present on ${url}`);
    }
  });
});

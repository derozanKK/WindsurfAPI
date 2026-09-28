// Kit section G, item G-1: "an unauthenticated caller supplying a session id must
// not receive a per-user scope".
//
// Measured at the audit baseline: the property does NOT hold inside
// src/caller-key.js or hasPerUserScope. `callerKeyFromRequest({headers:{'x-dashboard-session':
// 'deadbeef'}}, '')` really does mint `session:<digest>` and hasPerUserScope really
// does trust it unconditionally. What holds is the COMPOSITION: every /v1 route sits
// behind the API-key gate at src/server.js:415, so the session branch is reachable
// only on an instance that has no credential configured at all — and no code in this
// repository ever writes `x-dashboard-session` (the dashboard authenticates with
// `x-dashboard-password`).
//
// What pins that composition is the SECOND describe below, which drives the real router
// over loopback: an independent audit removed src/server.js:415 in-process and showed
// that the pure-function tests in the first describe still passed 4/4, because they pin
// the key ladder, the credential extraction and the scope rule — not the routing. Both
// halves are needed: the first states the rule, the second proves the router enforces it
// and that a refused request never reaches a protected handler.
//
// All of it is green today and goes red if the wall moves: if the session header is ever
// accepted as a credential, if an API key stops outranking a session header in the
// caller-key ladder, or if the outer gate stops refusing a request before the route.

import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callerKeyFromRequest } from '../src/caller-key.js';
import { hasPerUserScope } from '../src/handlers/chat.js';
import { extractToken, startServer } from '../src/server.js';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';

const SESSION_HEADERS = [
  'x-dashboard-session',
  'x-session-id',
  'x-windsurf-session',
  'session-id',
];

function fakeReq({ headers = {}, ip = '127.0.0.1' } = {}) {
  return { headers, socket: { remoteAddress: ip } };
}

describe('G-1: the session caller-key branch stays behind the credential wall', () => {
  it('an API key outranks every session header shape', () => {
    for (const name of SESSION_HEADERS) {
      const key = callerKeyFromRequest(fakeReq({ headers: { [name]: 'deadbeef' } }), 'sk-real-key');
      assert.ok(key.startsWith('api:'), `${name} must not outrank a presented API key (got ${key})`);
      assert.ok(!key.startsWith('session:'), `${name} must never mint a session key when a credential was sent`);
      assert.equal(hasPerUserScope(key), false, `${name} must not earn a per-user scope via the session branch`);
    }
  });

  it('a session header is not a credential', () => {
    for (const name of SESSION_HEADERS) {
      const req = fakeReq({ headers: { [name]: 'deadbeef' } });
      assert.equal(extractToken(req), '', `${name} must not be readable as an API token`);
    }
    // The credential carriers still work, so the assertion above is about the
    // session headers and not about extractToken being inert.
    assert.equal(extractToken(fakeReq({ headers: { authorization: 'Bearer sk-real-key' } })), 'sk-real-key');
    assert.equal(extractToken(fakeReq({ headers: { 'x-api-key': 'sk-real-key' } })), 'sk-real-key');
  });

  it('the session branch is reachable only with no credential at all', () => {
    const req = fakeReq({ headers: { 'x-dashboard-session': 'deadbeef' } });
    assert.ok(callerKeyFromRequest(req, '').startsWith('session:'), 'the branch itself still exists');
    assert.ok(callerKeyFromRequest(req, 'sk-real-key').startsWith('api:'), 'and a credential still closes it');
  });

  it('hasPerUserScope grants the session branch only for session keys', () => {
    assert.equal(hasPerUserScope('session:abcdef'), true, 'the session branch is the scope it grants');
    assert.equal(hasPerUserScope('api:abcdef'), false);
    assert.equal(hasPerUserScope(''), false);
    assert.equal(hasPerUserScope(null), false);
  });
});

// GPT-07 (independent audit, 2026-09-22): the four tests above are pure-function tests,
// so an in-process run with the real outer gate removed (src/server.js:415 rewritten to
// `if (false && !validateApiKey(...))`) still passed 4/4 — they pin the key ladder, the
// credential extraction and the scope rule, not the routing this file's header claims.
// These drive the real router over loopback instead, and use the post-gate sentinel as
// proof that a rejected request never reached a protected handler.
const origApiKey = config.apiKey;
const origPw = config.dashboardPassword;
const origHost = config.host;
const origPort = config.port;
let server = null;

function waitListening(s) {
  return new Promise(r => { if (s.address()) return r(); s.once('listening', r); });
}

function request(port, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('G-1: the outer gate refuses every /v1 route before a caller key is derived', () => {
  beforeEach(() => {
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    config.apiKey = 'sk-chat-shared';
    config.dashboardPassword = 'operator-pw';
    config.host = '127.0.0.1';
    configureBindHost('127.0.0.1');
    config.port = 0;
  });
  afterEach(async () => {
    if (server) { await new Promise(r => server.close(r)); server = null; }
    config.apiKey = origApiKey; config.dashboardPassword = origPw;
    config.host = origHost; config.port = origPort;
  });

  it('no credential, a wrong credential, and a session header alone are all refused', async () => {
    server = startServer();
    await waitListening(server);
    const port = server.address().port;

    // Shapes that must never authorise, against every /v1 route that exists.
    const refused = [
      ['no credential', {}],
      ['wrong key', { authorization: 'Bearer wrong' }],
      ['session header only', { 'x-dashboard-session': 'deadbeef' }],
      ['session id only', { 'x-session-id': 'deadbeef' }],
      ['both session headers', { 'x-dashboard-session': 'deadbeef', 'x-session-id': 'deadbeef' }],
    ];
    const routes = [
      ['GET', '/v1/models'],
      ['POST', '/v1/chat/completions'],
      ['POST', '/v1/responses'],
      ['GET', '/v1/responses/whatever'],
    ];

    for (const [shape, headers] of refused) {
      for (const [method, path] of routes) {
        const res = await request(port, method, path, headers, method === 'POST' ? { model: 'm', messages: [] } : null);
        assert.equal(res.status, 401, `${method} ${path} with ${shape} must be 401`);
        assert.equal(res.body?.error?.type, 'auth_error', `${method} ${path} with ${shape} must fail as an auth error`);
      }
    }
  });

  it('a valid credential passes the gate (control: the sentinel after it is not 401)', async () => {
    server = startServer();
    await waitListening(server);
    const port = server.address().port;
    const auth = { authorization: 'Bearer sk-chat-shared' };

    // setup-env.mjs points DATA_DIR at a fresh temp dir, so the pool is empty and the
    // chat routes answer their post-gate sentinel deterministically: 503 for a POST
    // route (no active accounts) rather than 401. The point is that the gate let it
    // through — never that the route succeeded.
    const chat = await request(port, 'POST', '/v1/chat/completions', auth, { model: 'm', messages: [] });
    assert.notEqual(chat.status, 401, 'a valid key must pass the outer gate');
    assert.equal(chat.status, 503, 'and then hit the no-active-accounts sentinel behind it');
    assert.notEqual(chat.body?.error?.type, 'auth_error', 'the failure behind the gate is not an auth failure');

    // A key present but empty is still refused, so the control above is about the key.
    const empty = await request(port, 'POST', '/v1/chat/completions', { authorization: 'Bearer ' }, { model: 'm', messages: [] });
    assert.equal(empty.status, 401);
  });
});

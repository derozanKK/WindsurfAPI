/**
 * Scripted upstream + shared fixtures for scripts/dashboard-smoke.mjs.
 *
 * Why module seams instead of a fake HTTP server: the dashboard login, the
 * Cascade REST probe and the DEVIN_CONNECT unary RPCs each hardcode their
 * upstream origin (`windsurf.com`, `server.codeium.com`), so a local fake
 * listener cannot intercept them without a production env override. The
 * product already exposes the same `__set…ForTest` seams its unit tests use;
 * this helper wires them to a single route table so the smoke suite runs the
 * REAL server with ZERO outbound sockets.
 *
 * Four call shapes are covered, matching the four transports the dashboard
 * flows use:
 *   - scriptedLoginTransport  → src/dashboard/windsurf-login.js
 *   - scriptedPostJson        → src/windsurf-api.js (REST JSON)
 *   - scriptedCatalogTransport→ src/devin-connect-catalog.js (Connect-RPC proto)
 *   - scriptedFetch           → src/dashboard/devin-read.js (app.devin.ai JSON)
 *
 * Every route table fails closed: an unrouted call throws instead of reaching
 * the network. scripts/mutation-network-deny.mjs is installed by the smoke
 * script as a second, independent barrier.
 */

import { FakeEmitter } from './fake-emitter.mjs';

export const SMOKE = Object.freeze({
  // Synthetic credentials. Long and distinctive on purpose: the smoke suite
  // scans its own stdout/stderr and every HTTP body for these exact strings.
  apiKey: 'sk-fixture-smoke-downstream-9f4c2a7e1b6d',
  dashboardPassword: 'smoke-dashboard-pw-3c8e5a1f7b2d',

  emailNoPassword: 'smoke-nopass@example.test',
  emailHasPassword: 'smoke-haspass@example.test',
  emailCode: '246810',
  verifyToken: 'smoke-email-verify-7a1d4c9e2b8f',
  auth1Token: 'auth1_smoke_5e2c8a7d1f4b9c3e',
  sessionTokenEmail: 'devin-session-token$smoke-email-4d8a2c6f1e9b',
  sessionTokenAdded: 'devin-session-token$smoke-added-7b3e9d5a2c8f',

  // Fake app.devin.ai billing identity. Must satisfy the org-id regex.
  orgId: 'org-smoke',

  // One live-only selector, so /models/catalog can prove a real set diff
  // against the committed snapshot instead of reporting "not synced yet".
  liveSelector: 'smoke-live-model',
  liveAlias: 'smoke.alias',
  liveLabel: 'Smoke Live Model',
});

/** High-entropy values that must never reach stdout, stderr, or an HTTP body. */
export const SMOKE_SECRETS = Object.freeze([
  { label: 'downstream API key', value: SMOKE.apiKey },
  { label: 'dashboard password', value: SMOKE.dashboardPassword },
  { label: 'email verification token', value: SMOKE.verifyToken },
  { label: 'Auth1 login token', value: SMOKE.auth1Token },
  { label: 'email-flow session token', value: SMOKE.sessionTokenEmail },
  { label: 'pasted session token', value: SMOKE.sessionTokenAdded },
]);

/** Flow names, in execution order. The script and the CI wrapper share this. */
export const SMOKE_FLOWS = Object.freeze([
  'dashboard-html',
  'locale-en',
  'locale-zh-CN',
  'models-auth',
  'login-probe-no-password',
  'login-probe-has-password',
  'email-start',
  'email-complete',
  'account-add-token',
  'account-list',
  'account-probe',
  'refresh-credits',
  'catalog-diff',
  'request-ring',
  'devin-panel',
  'usage',
  'account-delete',
  'no-secret-leak',
]);

function parseBody(postData) {
  if (Buffer.isBuffer(postData)) postData = postData.toString('utf8');
  if (typeof postData !== 'string' || !postData) return null;
  try { return JSON.parse(postData); } catch { return null; }
}

function selectRoute(routes, target, body) {
  for (const route of routes) {
    if (route.match(target, body)) return route;
  }
  throw new Error(`dashboard-smoke fake upstream: unrouted request to ${target}`);
}

function replyFor(route, target, body, raw, opts) {
  return typeof route.reply === 'function' ? route.reply(target, body, raw, opts) : route.reply;
}

/**
 * windsurf-login transport. Reply `{ status, json }` for parsed calls, or
 * `{ status, buffer }` when the caller asked for `opts.raw` (PostAuth).
 * `reply(target, body, raw, opts)` also receives the RAW post body and the
 * request options: PostAuth posts an EMPTY body and carries the Auth1 token in
 * the `X-Devin-Auth1-Token` header, so a route that must distinguish two login
 * flows cannot rely on the parsed body alone.
 */
export function scriptedLoginTransport(routes) {
  const seen = [];
  const fn = async (url, opts = {}, postData) => {
    seen.push(String(url));
    const body = parseBody(postData);
    const reply = replyFor(selectRoute(routes, String(url), body), String(url), body, postData, opts);
    const status = reply.status ?? 200;
    if (opts.raw) {
      const data = Buffer.isBuffer(reply.buffer)
        ? reply.buffer
        : Buffer.from(JSON.stringify(reply.json ?? {}));
      return { status, data };
    }
    return { status, data: reply.json ?? {} };
  };
  fn.seen = seen;
  return fn;
}

/** src/windsurf-api.js postJson seam. `target` is the RPC path. */
export function scriptedPostJson(routes) {
  const seen = [];
  const fn = async (host, path, body) => {
    seen.push(`${host}${path}`);
    const reply = replyFor(selectRoute(routes, String(path), body), String(path), body);
    return {
      status: reply.status ?? 200,
      data: reply.json ?? {},
      raw: JSON.stringify(reply.json ?? {}),
    };
  };
  fn.seen = seen;
  return fn;
}

/**
 * Connect-RPC unary seam. `requestImpl(options, callback)` must behave like
 * https.request: return an emitter, call back with a response emitter, then
 * stream `data` and `end`. `reply.buffer` carries the protobuf bytes.
 */
export function scriptedCatalogTransport(routes) {
  const seen = [];
  const fn = (options, callback) => {
    seen.push(String(options?.path || ''));
    const reply = replyFor(selectRoute(routes, String(options?.path || ''), null), String(options?.path || ''), null);
    const req = new FakeEmitter();
    req.destroy = (err) => { if (err) req.emit('error', err); };
    req.end = () => {
      const res = new FakeEmitter();
      res.statusCode = reply.status ?? 200;
      callback(res);
      queueMicrotask(() => {
        const data = Buffer.isBuffer(reply.buffer)
          ? reply.buffer
          : Buffer.from(JSON.stringify(reply.json ?? {}));
        if (data.length) res.emit('data', data);
        res.emit('end');
        req.emit('close');
      });
    };
    return req;
  };
  fn.seen = seen;
  return fn;
}

/** src/dashboard/devin-read.js fetch seam. `target` is the absolute URL. */
export function scriptedFetch(routes) {
  const seen = [];
  const fn = async (url) => {
    seen.push(String(url));
    const reply = replyFor(selectRoute(routes, String(url), null), String(url), null);
    const status = reply.status ?? 200;
    const text = JSON.stringify(reply.json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => text,
    };
  };
  fn.seen = seen;
  return fn;
}

// RATE-RISK-2 — red→green pins for the five remaining RISK items from the
// RATE-RETRY audit (RR-SUMMARY «RISK 全清单» R-1…R-5, 2026-10-15):
//
//   R-1  postJson (windsurf-api.js) and the two dashboard httpsRequest helpers
//        accumulated response bodies unbounded (bufs.push + Buffer.concat →
//        toString('utf8')), so a huge/hostile body could OOM the process or
//        throw ERR_STRING_TOO_LONG inside the 'end' listener. All three readers
//        must share the bounded accumulator from devin-connect.js (same ceiling
//        and truncation contract) and reject over-cap bodies instead of parsing
//        a truncated prefix.
//   R-2  checkMessageRateLimit fail-open swallowed a 429/503 on the pre-flight
//        itself. 429/503 must report {hasCapacity:false, retryAfterMs} parsed
//        from resetsInSeconds / Retry-After; network errors stay fail-open.
//   R-3  WebFetch auto-approve recorded the approval key BEFORE the
//        HandleCascadeUserInteraction RPC, so one failed RPC permanently
//        skipped the retry (the has() guard) until the warm-stall ceiling. The
//        key must only be recorded after the RPC succeeds.
//   R-4  Optional per-account in-flight hard cap
//        DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT (default 0 = off) on getApiKey:
//        at/over cap the account must not be handed out (incl. the sticky arm),
//        and the existing stale-inflight sweep must release a leaked counter.
//   R-5  Dashboard proxy test: the TLS stage had no timer, so a target that
//        completed the tunnel and then went silent left the promise pending
//        forever. It must arm a timeout that destroys the socket and settles
//        with ERR_TIMEOUT.
//
// The env block below is read at MODULE LOAD by the graphs under test
// (devin-connect.js ceiling, client.js CASCADE_TIMEOUTS, grpc.js protocol
// selection, sticky-session.js enable flag), so it must be set before the
// first product import in this process. Static imports below are node
// builtins only; every product module is loaded via dynamic import after this
// block — same pattern as test/devin-connect-unary-body-bound.test.js.
process.env.DEVIN_CONNECT_MAX_ERROR_BODY_BYTES = '64'; // R-1 ceiling under test (assert against it, never input size)
process.env.CASCADE_POLL_INTERVAL_MS = '10';
process.env.CASCADE_IDLE_GRACE_MS = '1';
process.env.CASCADE_MAX_WAIT_MS = '800';
process.env.CASCADE_COLD_STALL_BASE_MS = '500';
process.env.GRPC_PROTOCOL = 'connect';
process.env.STICKY_SESSION_ENABLED = '1'; // R-4 sticky-arm case

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import { terminateRpcWithStatus, isConnectContentType } from './helpers/fake-grpc-trailers.mjs';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const windsurfApi = await import('../src/windsurf-api.js');
const windsurfLogin = await import('../src/dashboard/windsurf-login.js');
const emailOtp = await import('../src/dashboard/email-otp-login.js');
const auth = await import('../src/auth.js');
const sticky = await import('../src/account/sticky-session.js');
const { WindsurfClient } = await import('../src/client.js');
const { config } = await import('../src/config.js');
const dashboardApi = await import('../src/dashboard/api.js');
const { writeStringField, writeMessageField, writeVarintField } = await import('../src/proto.js');
const { wrapEnvelope, endOfStreamEnvelope } = await import('../src/connect.js');

const CAP = 64; // must match DEVIN_CONNECT_MAX_ERROR_BODY_BYTES above
const TRUNCATION_RE = new RegExp(`exceeded ${CAP} bytes; truncated`);

/** Set env vars for one test, then restore exactly (including "was unset"). */
function setEnvForTest(values) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// ─── R-1: fake https.request ────────────────────────────────────────────────
// The three readers call https.request at call time; the builtin export is
// patched and re-synced to the ESM view for the duration of one test (same
// seam test/https-proxy-policy.test.js uses for its capture-only fakes), so no
// socket is ever opened. `realHttpsRequest` is the network-guard-wrapped
// original captured at file load; restoring it keeps the guard authoritative.
const realHttpsRequest = https.request;

function fakeResponseTransport({ status = 200, headers = {}, chunks = [] } = {}) {
  return function fakeHttpsRequest(_opts, onResponse) {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => true;
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = headers;
      process.nextTick(() => {
        onResponse(res);
        for (const chunk of chunks) res.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        res.emit('end');
      });
    };
    return req;
  };
}

function installHttpsRequest(fake) {
  https.request = fake;
  syncBuiltinESMExports();
}

// 80 bytes across two chunks: the second chunk crosses the 64-byte ceiling, so
// the crossing-chunk slice is exercised (a single big chunk would not).
const OVER_CAP_CHUNKS = [Buffer.alloc(40, 0x61), Buffer.alloc(40, 0x62)];

afterEach(() => {
  https.request = realHttpsRequest;
  syncBuiltinESMExports();
  windsurfApi.__setWindsurfApiPostJsonForTest(null);
  windsurfApi.__resetUserJwtCache();
});

describe('R-1: response bodies are bounded (shared ceiling, reject on truncation)', () => {
  it('windsurf-api postJson: a body over the ceiling rejects as truncated', async () => {
    installHttpsRequest(fakeResponseTransport({ chunks: OVER_CAP_CHUNKS }));
    await assert.rejects(
      () => windsurfApi.getUserJwt('key-r1', 'server.codeium.com'),
      TRUNCATION_RE,
    );
  });

  it('windsurf-api postJson: a small body still parses (regression guard)', async () => {
    installHttpsRequest(fakeResponseTransport({
      chunks: [Buffer.from(JSON.stringify({ userJwt: 'jwt-r1' }))],
    }));
    assert.equal(await windsurfApi.getUserJwt('key-r1', 'server.codeium.com'), 'jwt-r1');
  });

  it('dashboard windsurf-login: a body over the ceiling rejects as truncated', async () => {
    installHttpsRequest(fakeResponseTransport({ chunks: OVER_CAP_CHUNKS }));
    await assert.rejects(
      () => windsurfLogin.refreshFirebaseToken('refresh-token-r1'),
      TRUNCATION_RE,
    );
  });

  it('dashboard windsurf-login: a small body still parses (regression guard)', async () => {
    installHttpsRequest(fakeResponseTransport({
      chunks: [Buffer.from(JSON.stringify({ id_token: 'id-r1', refresh_token: 'rt-r1', expires_in: '3600' }))],
    }));
    const refreshed = await windsurfLogin.refreshFirebaseToken('rt-r1');
    assert.equal(refreshed.idToken, 'id-r1');
  });

  it('dashboard email-otp-login: a body over the ceiling rejects as truncated', async () => {
    installHttpsRequest(fakeResponseTransport({ chunks: OVER_CAP_CHUNKS }));
    await assert.rejects(
      () => emailOtp.sendEmailVerification('r1@example.com', 'R1', 'turnstile-r1'),
      TRUNCATION_RE,
    );
  });

  it('dashboard email-otp-login: a small body still parses (regression guard)', async () => {
    installHttpsRequest(fakeResponseTransport({ chunks: [Buffer.from('{}')] }));
    const sent = await emailOtp.sendEmailVerification('r1@example.com', 'R1', 'turnstile-r1');
    assert.equal(sent.success, true);
  });
});

// ─── R-2: pre-flight rate limit must not swallow its own 429 ────────────────
describe('R-2: checkMessageRateLimit reports no-capacity on 429/503', () => {
  it('429 with resetsInSeconds reports {hasCapacity:false, retryAfterMs}', async () => {
    windsurfApi.__setWindsurfApiPostJsonForTest(async () => ({
      status: 429, data: { resetsInSeconds: 30 }, raw: '{}', headers: {},
    }));
    const rl = await windsurfApi.checkMessageRateLimit('key-r2');
    assert.equal(rl.hasCapacity, false);
    assert.equal(rl.retryAfterMs, 30000);
  });

  it('429 falls back to the Retry-After header when the body has no reset window', async () => {
    windsurfApi.__setWindsurfApiPostJsonForTest(async () => ({
      status: 429, data: {}, raw: '{}', headers: { 'retry-after': '7' },
    }));
    const rl = await windsurfApi.checkMessageRateLimit('key-r2');
    assert.equal(rl.hasCapacity, false);
    assert.equal(rl.retryAfterMs, 7000);
  });

  it('503 is treated the same and parses the proto3-JSON string form', async () => {
    windsurfApi.__setWindsurfApiPostJsonForTest(async () => ({
      status: 503, data: { resetsInSeconds: '12' }, raw: '{}', headers: {},
    }));
    const rl = await windsurfApi.checkMessageRateLimit('key-r2');
    assert.equal(rl.hasCapacity, false);
    assert.equal(rl.retryAfterMs, 12000);
  });

  it('Retry-After HTTP-date form is converted to a positive window', async () => {
    windsurfApi.__setWindsurfApiPostJsonForTest(async () => ({
      status: 429, data: {}, raw: '{}',
      headers: { 'retry-after': new Date(Date.now() + 5000).toUTCString() },
    }));
    const rl = await windsurfApi.checkMessageRateLimit('key-r2');
    assert.equal(rl.hasCapacity, false);
    assert.ok(rl.retryAfterMs > 3500 && rl.retryAfterMs <= 6000, `got ${rl.retryAfterMs}`);
  });

  it('the real postJson path carries the Retry-After header through end-to-end', async () => {
    // Exercises the un-stubbed postJson: the 429 branch must see res.headers
    // (the header pass-through added in this change), not just the body field.
    installHttpsRequest(fakeResponseTransport({
      status: 429, headers: { 'retry-after': '7' }, chunks: [Buffer.from('{}')],
    }));
    const rl = await windsurfApi.checkMessageRateLimit('key-r2');
    assert.equal(rl.hasCapacity, false);
    assert.equal(rl.retryAfterMs, 7000);
  });

  it('network errors still fail open (unchanged behavior)', async () => {
    windsurfApi.__setWindsurfApiPostJsonForTest(async () => { throw new Error('ECONNRESET'); });
    const rl = await windsurfApi.checkMessageRateLimit('key-r2');
    assert.equal(rl.hasCapacity, true);
  });

  it('non-throttle HTTP errors still fail open (unchanged behavior)', async () => {
    windsurfApi.__setWindsurfApiPostJsonForTest(async () => ({
      status: 500, data: {}, raw: '{}', headers: {},
    }));
    const rl = await windsurfApi.checkMessageRateLimit('key-r2');
    assert.equal(rl.hasCapacity, true);
  });
});

// ─── R-3: auto-approve must retry a failed approval RPC ─────────────────────
// Harness mirrors test/client-panel-retry.test.js: a real loopback http2 server
// stands in for the language server (loopback is allowed by the network guard),
// and the cascade flow runs unchanged. Only the fake LS is scripted: the first
// HandleCascadeUserInteraction fails, later ones succeed.

function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

function responseBody(payload, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function errorBody(message, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) {
    const body = Buffer.from(JSON.stringify({ error: { message } }));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 0x02;
    frame.writeUInt32BE(body.length, 1);
    body.copy(frame, 5);
    return { body: frame, trailers: null };
  }
  return { body: Buffer.alloc(0), trailers: { 'grpc-status': '5', 'grpc-message': encodeURIComponent(message) } };
}

function startCascadeResponse(cascadeId) {
  return writeStringField(1, cascadeId);
}

function trajectoryInfoResponse(status, trajectoryId = 'rr-trajectory', cascadeId = 'rr-cascade') {
  const trajectory = Buffer.concat([
    writeStringField(1, trajectoryId),
    writeStringField(6, cascadeId),
  ]);
  return Buffer.concat([
    writeMessageField(1, trajectory),
    writeVarintField(2, status),
  ]);
}

function pendingReadUrlStepResponse() {
  const spec = Buffer.concat([
    writeStringField(1, 'https://example.com/'),
    writeStringField(2, 'https://example.com'),
  ]);
  const body = Buffer.concat([
    writeStringField(1, 'https://example.com/'),
    writeVarintField(7, 8),
  ]);
  const step = Buffer.concat([
    writeVarintField(1, 40),
    writeVarintField(4, 9),
    writeMessageField(56, writeMessageField(14, spec)),
    writeMessageField(40, body),
  ]);
  return writeMessageField(1, step);
}

function readUrlContentDoneStepResponse() {
  const doc = Buffer.concat([
    writeStringField(2, 'Example Domain fetched body'),
    writeStringField(3, 'https://example.com/'),
    writeStringField(7, 'Example Domain summary'),
  ]);
  const body = Buffer.concat([
    writeStringField(1, 'https://example.com/'),
    writeMessageField(2, doc),
    writeStringField(3, 'https://example.com/'),
    writeVarintField(4, 123),
  ]);
  const step = Buffer.concat([
    writeVarintField(1, 40),
    writeVarintField(4, 3),
    writeMessageField(40, body),
  ]);
  return writeMessageField(1, step);
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', session => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => { terminateRpcWithStatus(stream); handler(stream, headers); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise(resolve => server.close(resolve));
  }
}

describe('R-3: WebFetch auto-approve retries a failed approval RPC', () => {
  it('a failed HandleCascadeUserInteraction is retried on a later poll (not skipped)', async () => {
    const restoreEnv = setEnvForTest({
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE: '1',
      WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE_ORIGINS: 'https://example.com',
    });
    let approvals = 0;
    let approved = false;
    let chunks = null;
    try {
      await withFakeLanguageServer((stream, headers) => {
        const received = [];
        stream.on('data', chunk => received.push(chunk));
        stream.on('end', () => {
          const method = String(headers[':path'] || '').split('/').pop();
          const respond = (payload) => {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(payload, headers));
          };
          if (method === 'StartCascade') return respond(startCascadeResponse('rr-cascade'));
          if (method === 'SendUserCascadeMessage') return respond(Buffer.alloc(0));
          if (method === 'GetCascadeTrajectorySteps') {
            return respond(approved ? readUrlContentDoneStepResponse() : pendingReadUrlStepResponse());
          }
          if (method === 'GetCascadeTrajectory') {
            return respond(trajectoryInfoResponse(approved ? 1 : 2));
          }
          if (method === 'HandleCascadeUserInteraction') {
            approvals++;
            if (approvals === 1) {
              // First attempt fails: the approval must NOT be recorded, so a
              // later poll retries it.
              const err = errorBody('approval rpc failed', headers);
              stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
              if (err.trailers) stream.additionalHeaders(err.trailers);
              stream.end(err.body);
              return;
            }
            approved = true;
            return respond(Buffer.alloc(0));
          }
          if (method === 'GetCascadeTrajectoryGeneratorMetadata') return respond(Buffer.alloc(0));
          stream.respond({ ':status': 404 });
          stream.end();
        });
      }, async (port) => {
        const client = new WindsurfClient('test-api-key', port, 'csrf-token');
        try {
          chunks = await client.cascadeChat([{ role: 'user', content: 'fetch it' }], 0, 'claude-4.5-haiku', {
            nativeMode: true,
            nativeAllowlist: ['read_url_content'],
          });
        } catch (err) {
          if (err?.kind !== 'transient_stall') throw err;
        }
      });
    } finally {
      restoreEnv();
    }
    assert.equal(approvals, 2, 'the failed approval must be retried exactly once on a later poll');
    assert.ok(chunks, 'the cascade must complete after the retried approval');
  });
});

// ─── R-4: optional per-account in-flight hard cap ───────────────────────────
describe('R-4: DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT (default 0 = off)', () => {
  const ENV = 'DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT';
  const createdIds = [];

  function seed(label, inflight = 0) {
    const a = auth.addAccountByKey(`test-key-rr-${label}-${Math.random().toString(36).slice(2)}`, label);
    createdIds.push(a.id);
    const acct = auth.getAccountInternal(a.id);
    acct.tier = 'pro';
    acct.status = 'active';
    acct._inflight = inflight;
    acct._inflightAt = inflight > 0 ? Date.now() : 0;
    return acct;
  }

  afterEach(() => {
    delete process.env[ENV];
    sticky.resetAllBindings();
    while (createdIds.length) { try { auth.removeAccount(createdIds.pop()); } catch {} }
  });

  it('default (0) leaves selection unchanged even at a high in-flight count', () => {
    const a = seed('rr-off', 99);
    const picked = auth.getApiKey([], null);
    assert.equal(picked?.id, a.id);
  });

  it('a single account at the cap is skipped → null instead of stacking', () => {
    process.env[ENV] = '2';
    const a = seed('rr-solo', 2);
    const picked = auth.getApiKey([], null);
    assert.equal(picked, null, `account ${a.id} is at the cap and must not be handed out`);
  });

  it('the sticky arm also honours the cap (a bound account at the cap is not served)', () => {
    process.env[ENV] = '2';
    const a = seed('rr-sticky', 2);
    sticky.setStickyBinding('rr-caller-1', null, a.id, a.apiKey);
    const picked = auth.getApiKey([], null, 'rr-caller-1');
    assert.equal(picked, null, 'the sticky binding must not bypass the hard cap');
  });

  it('the stale-inflight sweep releases a capped account again (leak cannot pin it out)', () => {
    process.env[ENV] = '1';
    const a = seed('rr-stale', 1);
    a._inflightAt = Date.now() - (auth.__inflightStaleMs() + 60_000);
    assert.equal(auth.getApiKey([], null), null, 'still capped before the sweep');
    assert.equal(auth.__runInflightCleanup(), 1, 'the stale slot is reclaimed');
    const picked = auth.getApiKey([], null);
    assert.equal(picked?.id, a.id);
  });
});

// ─── R-5: dashboard proxy test — TLS stage gets a timer ─────────────────────
describe('R-5: proxy test TLS stage settles on a silent target', () => {
  it('arms a timeout that destroys the socket and rejects with ERR_TIMEOUT', async () => {
    const savedAllowPrivate = config.allowPrivateProxyHosts;
    config.allowPrivateProxyHosts = true;
    const guardedTlsConnect = tls.connect;
    // The fail-closed network guard reads tls.connect's `servername` and would
    // refuse 'api.ipify.org' even though the socket under test is our loopback
    // blackhole. Hand the guard the loopback truth for this call: the socket
    // is already connected to 127.0.0.1, and SNI is irrelevant to a handshake
    // that never completes. The call still goes through the guard's own
    // wrapper — nothing leaves loopback.
    tls.connect = (opts, cb) => guardedTlsConnect({ ...opts, host: '127.0.0.1', servername: undefined }, cb);
    syncBuiltinESMExports();

    const sockets = new Set();
    const server = net.createServer(sock => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      // Accept the CONNECT, answer 200, then go silent: the TLS handshake
      // stalls forever unless the TLS stage arms its own timer.
      let buf = '';
      let responded = false;
      sock.on('data', chunk => {
        buf += chunk.toString('utf8');
        if (!responded && buf.includes('\r\n\r\n')) {
          responded = true;
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const outcome = await Promise.race([
        dashboardApi.testProxy({ host: '127.0.0.1', port, type: 'http' }, 250)
          .then(value => ({ ok: value }), err => ({ err })),
        new Promise(resolve => setTimeout(() => resolve({ watchdog: true }), 3000)),
      ]);
      assert.ok(outcome.err, `expected the TLS stage to reject, got ${JSON.stringify(outcome)}`);
      assert.match(outcome.err.message, /ERR_TIMEOUT/);
    } finally {
      tls.connect = guardedTlsConnect;
      syncBuiltinESMExports();
      for (const sock of sockets) { try { sock.destroy(); } catch {} }
      await new Promise(resolve => server.close(resolve));
      config.allowPrivateProxyHosts = savedAllowPrivate;
    }
  });
});

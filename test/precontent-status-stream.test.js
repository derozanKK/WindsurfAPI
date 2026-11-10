// P0 regression: a pre-content failure must not be reported as HTTP 200.
//
// Measured 2026-10-22 (Q5 F1): the SSE commit gate armed its 5 s bootstrap timer
// at WRAPPER CONSTRUCTION — before the handler acquired an account. The Cascade
// stream handler can wait up to QUEUE_MAX_WAIT_MS (30 s) for admission and only
// then discover the pool is exhausted, so the gate had already committed
// `200 text/event-stream`; the 429 and its Retry-After could only arrive as an
// in-band error frame (measured 30,341 ms, `retry-after: null`). The non-stream
// branch returned 429 + Retry-After for the same pool state.
//
// Two independent guards are asserted here:
//   1. the gate stays uncommitted until the first write (unit), and a late
//      pre-content error therefore rewrites the real status;
//   2. an exhausted pool fails admission fast and every one of the four stream
//      routes answers with the real status + Retry-After, never `200 SSE`.
//
// The route tests go over the REAL router for the reason
// retry-after-route-parity.test.js states: the defect lived in the assembly
// between the handler result and the route's header set, not in the handler.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import {
  addAccountByKey, removeAccount, getAccountList,
  markRateLimited, _resetLockoutForTests,
} from '../src/auth.js';
import { startServer, serveChatStream } from '../src/server.js';
import { setRuntimeApiKey } from '../src/runtime-config.js';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { createDeferredSseResponse } from '../src/sse-commit.js';
import { createRequestBudget } from '../src/request-budget.js';

const API_KEY = 'test-key-precontent';
const LABEL_PREFIX = 'precontent-';
const originals = {
  apiKey: config.apiKey, host: config.host, port: config.port,
  degradedServe: process.env.WINDSURFAPI_DEGRADED_SERVE,
  devinConnect: process.env.DEVIN_CONNECT,
};
let runningServer = null;
const created = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  if (runningServer) {
    await new Promise((r) => runningServer.close(r));
    runningServer = null;
  }
  for (const id of created) { removeAccount(id); created.delete(id); }
  for (const a of getAccountList()) {
    if (typeof a.label === 'string' && a.label.startsWith(LABEL_PREFIX)) removeAccount(a.id);
  }
  _resetLockoutForTests();
  setRuntimeApiKey('');
  config.apiKey = originals.apiKey;
  config.host = originals.host;
  config.port = originals.port;
  for (const [key, value] of [
    ['WINDSURFAPI_DEGRADED_SERVE', originals.degradedServe],
    ['DEVIN_CONNECT', originals.devinConnect],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    flushHeaders() { this.headersSent = true; },
    setHeader() {}, getHeader() {}, removeHeader() {},
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true; },
    on() {}, once() {}, removeListener() {}, destroy() { this.writableEnded = true; },
  };
}

const waitListening = (s) => new Promise((r) => (s.address() ? r() : s.once('listening', r)));

function post(port, path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* SSE or empty */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, body, raw });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Boot the real router with ONE pooled account that is rate-limited for the next
// ten minutes, degraded-serve OFF (so the pool really is exhausted for admission),
// and the connect backend off (so the request takes the Cascade path this defect
// lives on). glm-5.1 is a Cascade catalog model.
async function bootExhausted(label) {
  _resetLockoutForTests();
  process.env.DEVIN_CONNECT = '0';
  process.env.WINDSURFAPI_DEGRADED_SERVE = '0';
  config.apiKey = API_KEY;
  setRuntimeApiKey(API_KEY);
  config.host = '127.0.0.1';
  config.port = 0;
  const key = `fake-key-${LABEL_PREFIX}${label}`;
  const acct = addAccountByKey(key, `${LABEL_PREFIX}${label}`);
  if (acct?.id) created.add(acct.id);
  markRateLimited(key, 10 * 60 * 1000);
  runningServer = startServer();
  await waitListening(runningServer);
  return runningServer.address().port;
}

const AUTH = { authorization: `Bearer ${API_KEY}` };
const MODEL = 'glm-5.1';

// A pre-content failure must be a real status. `content-type: text/event-stream`
// with 200 is exactly the shape the defect produced; asserting the JSON content
// type makes the regression unambiguous even if a future gate commits a different
// 2xx.
function assertRealStatus(res, route) {
  assert.equal(res.statusCode, 429,
    `${route}: an exhausted pool must answer 429, got ${res.statusCode}. Body: ${res.raw.slice(0, 200)}`);
  assert.ok(res.headers['retry-after'],
    `${route}: Retry-After is the whole point — the client must learn when to retry`);
  assert.match(res.headers['retry-after'], /^\d+$/, `${route}: whole seconds, the header unit`);
  assert.doesNotMatch(String(res.headers['content-type'] || ''), /text\/event-stream/,
    `${route}: a failed request must not be committed as an SSE stream`);
  assert.equal(String(res.raw || '').startsWith('data:'), false,
    `${route}: the error must not be an in-band SSE frame`);
}

describe('SSE commit gate arms on the first write, not at construction', () => {
  it('stays uncommitted through a silent admission window, then rewrites a pre-content error', async () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { status: 200, bootstrapTimeoutMs: 10 });
    // Longer than the bootstrap timeout: the old construction-time timer would
    // have committed 200 here.
    await sleep(30);
    assert.equal(real.statusCode, null, 'no write has happened yet — the gate must not commit');
    gate.write('data: {"error":{"message":"pool exhausted","code":"RATE_LIMITED","retry_after_ms":570000}}\n\n');
    gate.end();
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], '570');
    assert.match(real.body, /"error"/);
  });

  it('arms the silence escape hatch on the first write (committed stream stays 200)', async () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { status: 200, bootstrapTimeoutMs: 10 });
    gate.write(': ping\n\n');
    assert.equal(real.statusCode, null, 'a heartbeat alone is still held');
    await sleep(30);
    assert.equal(real.statusCode, 200, 'after the first write the timer commits a live stream');
    gate.write('data: {"error":{"message":"late","code":"RATE_LIMITED"}}\n\n');
    gate.end();
    assert.equal(real.statusCode, 200, 'a post-commit error cannot rewrite the status');
  });

  it('handler-level: a 40 ms admission failure behind a 5 ms gate returns 503 + Retry-After', async () => {
    // The exact F1 race at unit scale: the gate's timer is shorter than the
    // queue wait. The handler is the real Cascade streamResponse, driven with a
    // waitForAccount that models a busy pool (returns null, no rate limit).
    // A pooled account is required only for the entitlement check; the fake
    // admission below never uses it.
    const acct = addAccountByKey(`fake-key-${LABEL_PREFIX}gate`, `${LABEL_PREFIX}gate`);
    if (acct?.id) created.add(acct.id);
    const result = await handleChatCompletions({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async waitForAccount() { await sleep(40); return null; },
      async ensureLs() {},
      getLsFor() { return { port: 17777, csrfToken: 'csrf', generation: 1 }; },
      budget: createRequestBudget({ deadlineMs: 60_000 }),
    });
    assert.equal(result.stream, true, 'precondition: the handler chose the stream shape');

    const res = fakeRes();
    await serveChatStream(res, result, {
      headers: { 'Content-Type': 'text/event-stream' },
      commitMs: 5,
    });
    assert.equal(res.statusCode, 503, 'a busy pool is a capacity failure, not a 200 stream');
    // The hint is the queue cadence (1 s) raised to the documented client
    // replay floor (rlClientBackoffFloorMs, default 30 s) — either way it must
    // be a positive whole-second value, not absent.
    assert.match(String(res.headers['retry-after']), /^\d+$/);
    assert.ok(Number(res.headers['retry-after']) >= 1);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(res.body.includes('data: [DONE]'), false);
  });
});

describe('every stream route returns the real pool status, not a committed 200', () => {
  it('/v1/chat/completions (OpenAI)', async () => {
    const port = await bootExhausted('chat');
    const res = await post(port, '/v1/chat/completions', {
      model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    assertRealStatus(res, '/v1/chat/completions');
  });

  it('/v1/messages (Anthropic)', async () => {
    const port = await bootExhausted('messages');
    const res = await post(port, '/v1/messages', {
      model: MODEL, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    assertRealStatus(res, '/v1/messages');
  });

  it('/v1/responses (OpenAI Responses)', async () => {
    const port = await bootExhausted('responses');
    const res = await post(port, '/v1/responses', {
      model: MODEL, stream: true, input: 'hi',
    }, AUTH);
    assertRealStatus(res, '/v1/responses');
  });

  it('/v1beta streamGenerateContent (Gemini)', async () => {
    const port = await bootExhausted('gemini');
    const res = await post(port, `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, AUTH);
    assertRealStatus(res, '/v1beta streamGenerateContent');
  });

  it('fails admission fast instead of waiting the 30 s queue window', async () => {
    const port = await bootExhausted('fastfail');
    const started = Date.now();
    const res = await post(port, '/v1/chat/completions', {
      model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    const elapsed = Date.now() - started;
    assertRealStatus(res, 'fast-fail');
    assert.ok(elapsed < 5_000,
      `a pool known-exhausted at t=0 must not hold the request for the queue window (took ${elapsed} ms)`);
  });
});

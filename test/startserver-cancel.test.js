// Real-socket cancellation across every chat-shaped streaming surface.
//
// Each dialect gets the same shape: a fake upstream writes one content chunk and
// then waits on `params.signal`; the client destroys the socket after the first
// byte; the handler must abort the upstream exactly once, must not replay or
// fail over, and the server must stay healthy for the next request.
//
// Gemini's `:generateContent` is the non-streaming verb — it answers only after
// the upstream completes, so there is no first chunk to destroy after. The
// streaming sibling `:streamGenerateContent?alt=sse` is the member of that route
// block that can observe a mid-stream hangup, and it exercises the same
// bindClientAbort + captureRes disconnect path.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';

const SAVED = {};
for (const key of ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY']) SAVED[key] = process.env[key];

let server;
let port;

// Per-test upstream accounting. armUpstream() runs before every it so one test
// can never inherit another's counters or already-settled abort promise.
const upstream = { calls: 0, aborts: 0, abortSeen: Promise.resolve(), resolveAbort: null };

function armUpstream() {
  upstream.calls = 0;
  upstream.aborts = 0;
  let resolveAbort;
  upstream.abortSeen = new Promise((resolve) => { resolveAbort = resolve; });
  upstream.resolveAbort = resolveAbort;
}

before(async () => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  config.apiKey = 'test-cancel-key';
  config.host = '127.0.0.1';
  config.port = 0;
  __setConnectDeps({
    streamChatCompletion: async (params, send) => {
      upstream.calls += 1;
      send({
        id: 'chatcmpl-cancel', object: 'chat.completion.chunk', created: 0,
        model: 'claude-haiku-5-5-low',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'first' }, finish_reason: null }],
      });
      await new Promise((_, reject) => {
        const fail = () => {
          upstream.aborts += 1;
          upstream.resolveAbort();
          reject(Object.assign(new Error('client disconnected'), { name: 'AbortError' }));
        };
        if (params.signal?.aborted) fail();
        else params.signal?.addEventListener('abort', fail, { once: true });
      });
    },
  });
  server = startServer();
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  port = server.address().port;
});

after(async () => {
  __resetConnectDeps();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of Object.keys(SAVED)) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

beforeEach(armUpstream);

// Drive one streaming request over a real socket, destroy it on the first byte,
// then wait for the upstream fake to observe the abort. Returns the first chunk
// so the caller can pin the dialect's wire shape.
async function destroyAfterFirstChunk(path, body) {
  const payload = JSON.stringify(body);
  let firstChunk = '';
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        authorization: 'Bearer test-cancel-key',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      assert.equal(res.statusCode, 200);
      res.once('data', (buf) => {
        firstChunk = buf.toString('utf8');
        req.destroy();
        resolve();
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
    req.end(payload);
  });
  await Promise.race([
    upstream.abortSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`upstream was not aborted on ${path}`)), 2000)),
  ]);
  return firstChunk;
}

// Shared contract for every dialect: one abort signal, one attempt, live server.
async function assertCancelled(firstChunk, marker) {
  assert.match(firstChunk, marker, 'first chunk must be shaped by the dialect under test');
  assert.equal(upstream.aborts, 1, 'upstream must observe exactly one abort');
  assert.equal(upstream.calls, 1, 'client cancellation must not replay or fail over');
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  await health.text();
}

describe('real-socket cancellation', () => {
  it('aborts chat/completions upstream once and keeps the server healthy', async () => {
    const firstChunk = await destroyAfterFirstChunk('/v1/chat/completions', {
      model: 'claude-haiku-5-5-low', stream: true,
      messages: [{ role: 'user', content: 'hold the stream' }],
    });
    await assertCancelled(firstChunk, /chat\.completion\.chunk/);
  });

  it('aborts /v1/messages upstream once and keeps the server healthy', async () => {
    const firstChunk = await destroyAfterFirstChunk('/v1/messages', {
      model: 'claude-haiku-5-5-low', max_tokens: 16, stream: true,
      messages: [{ role: 'user', content: 'hold the stream' }],
    });
    await assertCancelled(firstChunk, /message_start/);
  });

  it('aborts /v1/responses upstream once and keeps the server healthy', async () => {
    const firstChunk = await destroyAfterFirstChunk('/v1/responses', {
      model: 'claude-haiku-5-5-low', stream: true, input: 'hold the stream',
    });
    await assertCancelled(firstChunk, /response\.created/);
  });

  it('aborts Gemini streamGenerateContent upstream once and keeps the server healthy', async () => {
    const firstChunk = await destroyAfterFirstChunk('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
      contents: [{ role: 'user', parts: [{ text: 'hold the stream' }] }],
    });
    await assertCancelled(firstChunk, /"candidates"/);
  });
});

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';
import { __resetRequestRingForTest, listRequests } from '../src/dashboard/request-ring.js';

// O10 (2026-10-19 data-plane study): a stream that fails after its first
// content frame is already committed as HTTP 200, so its request-ring row
// cannot be classified from `status` alone. Every streaming surface must still
// record the failure class — the DEVIN_CONNECT code the non-stream error body
// carries (`result.body.error.code`). These are startServer-level requests so
// the real router, the commit gate and the per-protocol translator all run.
const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
for (const key of ENV_KEYS) SAVED[key] = process.env[key];

const MODEL = 'claude-haiku-5-5-low';
const FAILURE_CODE = 'CAPACITY';

let server;
let port;
let streamBehavior = 'ok';

function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-o10',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

before(async () => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-o10-only';
  delete process.env.WINDSURF_API_KEY;
  config.apiKey = 'test-o10-key';
  config.host = '127.0.0.1';
  config.port = 0;
  __setConnectDeps({
    toChatCompletion: async () => ({
      status: 200,
      body: {
        id: 'chatcmpl-o10',
        object: 'chat.completion',
        created: 0,
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    }),
    streamChatCompletion: async (_params, send) => {
      // One real content frame first: it commits the SSE response, so the
      // failure below is a genuine MID-stream failure (HTTP 200 already on the
      // wire), not a pre-content error the commit gate could rewrite into 4xx.
      send(chunk({ role: 'assistant', content: 'PARTIAL' }));
      if (streamBehavior === 'fail') {
        throw Object.assign(new Error('upstream died mid-stream'), { code: FAILURE_CODE });
      }
      send(chunk({}, 'stop'));
      return {
        content: 'PARTIAL',
        reasoning: '',
        toolCalls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
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
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

function post(path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-o10-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The ring row is patched when the stream handler settles, which can land a
// beat after the client observes the socket close. Wait for the expected class
// (bounded) so the assertion reports the actual value instead of racing.
async function waitRow(protocol, expectedClass) {
  let row = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    row = listRequests({ limit: 50 }).items.find((r) => r.protocol === protocol) || null;
    if (row && row.class === expectedClass) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return row;
}

async function assertFailureRow(protocol, response, body) {
  assert.equal(response.status, 200, body);
  const row = await waitRow(protocol, FAILURE_CODE);
  assert.ok(row, `${protocol}: request did not reach the ring`);
  assert.equal(row.stream, true, `${protocol}: row should be marked as a stream`);
  assert.equal(
    row.class,
    FAILURE_CODE,
    `${protocol}: a mid-stream failure row must carry the failure class (got ${JSON.stringify(row.class)})`,
  );
}

describe('O10: streaming failures carry the request-ring class', () => {
  it('records the failure class on a mid-stream chat failure', async () => {
    streamBehavior = 'fail';
    __resetRequestRingForTest();
    const res = await post('/v1/chat/completions', {
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = await res.text();
    assert.match(body, /"code":"CAPACITY"/, 'the failure must be a mid-stream error frame');
    await assertFailureRow('openai', res, body);
  });

  it('records the failure class on a mid-stream responses failure', async () => {
    streamBehavior = 'fail';
    __resetRequestRingForTest();
    const res = await post('/v1/responses', {
      model: MODEL,
      stream: true,
      store: false,
      input: 'hi',
    });
    const body = await res.text();
    assert.match(body, /response\.failed/, 'the failure must be a mid-stream response.failed event');
    await assertFailureRow('responses', res, body);
  });

  it('records the failure class on a mid-stream messages failure', async () => {
    streamBehavior = 'fail';
    __resetRequestRingForTest();
    const res = await post('/v1/messages', {
      model: MODEL,
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = await res.text();
    assert.match(body, /event: error/, 'the failure must be a mid-stream Anthropic error event');
    await assertFailureRow('messages', res, body);
  });

  it('records the failure class on a mid-stream gemini failure', async () => {
    streamBehavior = 'fail';
    __resetRequestRingForTest();
    const res = await post('/v1beta/models/claude-haiku-5-5-low:streamGenerateContent?alt=sse', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    const body = await res.text();
    assert.match(body, /__upstream_code":"CAPACITY"/, 'the failure must be a mid-stream Gemini error frame');
    await assertFailureRow('gemini', res, body);
  });

  it('leaves a successful stream row classified ok', async () => {
    streamBehavior = 'ok';
    __resetRequestRingForTest();
    const res = await post('/v1/chat/completions', {
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    const row = await waitRow('openai', 'ok');
    assert.ok(row, 'successful chat request did not reach the ring');
    assert.equal(row.class, 'ok');
  });
});

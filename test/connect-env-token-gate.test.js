import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';

// Single-token DEVIN_CONNECT deploy: the pool is intentionally empty and the
// connect client falls back to DEVIN_CONNECT_TOKEN. The HTTP prechecks must not
// 503 before that fallback is reached.
const SAVED = {};
const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
for (const k of ENV_KEYS) SAVED[k] = process.env[k];

let server;
let port;

before(async () => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  config.apiKey = 'test-dashboard-key';
  config.host = '127.0.0.1';
  config.port = 0;
  __setConnectDeps({
    toChatCompletion: async () => ({
      status: 200,
      body: {
        id: 'chatcmpl-env-token', object: 'chat.completion', created: 0,
        model: 'claude-opus-5-5-medium',
        choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    }),
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
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('DEVIN_CONNECT single-token deploy', () => {
  it('serves /v1/chat/completions with an env token and an empty pool', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-dashboard-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5-5-medium',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.choices?.[0]?.message?.content, 'PONG');
    assert.equal(body.model, 'claude-opus-5-5-medium');
  });
});

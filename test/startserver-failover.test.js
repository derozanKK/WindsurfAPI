import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';
import {
  addAccountByKey, removeAccount, __resetReloginState, __setReloginDeps,
} from '../src/auth.js';

// Real-router proof of the DEVIN_CONNECT cross-account failover SUCCESS path:
// the first pooled account's session token is dead (upstream 401 UNAUTHORIZED
// with an error body) and the request is served by the SECOND pooled account.
//
// The handler-level unit test (test/devin-connect-failover.test.js) already
// exercises handleChatCompletions directly. What was missing is the same path
// through startServer: HTTP auth, route dispatch, the real SSE writer, and the
// status/body a client actually receives. A regression that drops the failover
// hop (or hops twice) would pass the unit test's shape checks but change what
// this route returns.

const SAVED = {};
const ENV_KEYS = [
  'DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY',
  'DEVIN_CONNECT_FAILOVER_MAX', 'DEVIN_CONNECT_AUTO_RELOGIN',
];
for (const key of ENV_KEYS) SAVED[key] = process.env[key];

const API_KEY = 'test-failover-key';
let server;
let port;
let createdIds = [];
// Every upstream attempt, in order: { token, outcome }. `outcome` is the
// verdict the fake upstream returned for that token ('401' | '200').
let calls = [];

function seed(label) {
  const key = `devin-session-token$fo-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
}

// What devin-connect.js throws after classifyUpstreamError sees the upstream's
// 401: a classified code plus the raw error body folded into `.message`.
function unauthorizedWithBody() {
  const body = {
    error: {
      message: 'session token is invalid or expired',
      type: 'authentication_error',
      code: 'UNAUTHORIZED',
    },
  };
  return Object.assign(new Error(JSON.stringify(body)), { code: 'UNAUTHORIZED', status: 401 });
}

function completion(text) {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-failover',
      object: 'chat.completion',
      created: 0,
      model: 'swe-1-6-slow',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    },
  };
}

function chunk(content, finish = null) {
  return {
    id: 'chatcmpl-failover',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'swe-1-6-slow',
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }],
  };
}

before(async () => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-failover-only';
  delete process.env.WINDSURF_API_KEY;
  // Pin the product default so the assertions describe the shipped hop budget,
  // not a value chosen by the fixture. An explicit runner-provided value is
  // kept: the red-run control sets DEVIN_CONNECT_FAILOVER_MAX=0 to prove these
  // assertions actually bite on the failover hop.
  if (SAVED.DEVIN_CONNECT_FAILOVER_MAX === undefined) delete process.env.DEVIN_CONNECT_FAILOVER_MAX;
  delete process.env.DEVIN_CONNECT_AUTO_RELOGIN;
  config.apiKey = API_KEY;
  config.host = '127.0.0.1';
  config.port = 0;
  // Token-added accounts have no stored password, so same-account re-login must
  // fail; the ONLY recovery left is the cross-account hop under test.
  __setReloginDeps({ windsurfLogin: async () => { throw new Error('no stored credential'); } });
  server = startServer();
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  port = server.address().port;
});

after(async () => {
  __resetConnectDeps();
  __resetReloginState();
  __setReloginDeps(null);
  for (const id of createdIds.splice(0)) removeAccount(id);
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

beforeEach(() => {
  calls = [];
  __resetReloginState();
});

afterEach(() => {
  __resetConnectDeps();
  for (const id of createdIds.splice(0)) removeAccount(id);
});

function post(path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sseData(raw) {
  return raw.split(/\r?\n\r?\n/).filter(Boolean)
    .filter((frame) => !frame.startsWith(':'))
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim())
    .filter(Boolean)
    .map((data) => (data === '[DONE]' ? '[DONE]' : JSON.parse(data)));
}

describe('startServer DEVIN_CONNECT failover success path', () => {
  it('serves the request from the second account after the first token returns 401', async () => {
    const a = seed('ns-a');
    const b = seed('ns-b');
    __setConnectDeps({
      toChatCompletion: async (params) => {
        // The first account picked by the pool is the dead one; every later
        // attempt is served normally. Selection order is the pool's business,
        // so the fake keys off attempt order, not on a or b.
        const attempt = calls.length;
        if (attempt === 0) {
          calls.push({ token: params.token, outcome: '401' });
          throw unauthorizedWithBody();
        }
        calls.push({ token: params.token, outcome: '200' });
        return completion('FAILOVER_OK');
      },
    });

    const res = await post('/v1/chat/completions', {
      model: 'swe-1-6-slow',
      stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: FAILOVER_OK' }],
    });
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.choices?.[0]?.message?.content, 'FAILOVER_OK');
    // Exactly ONE failover hop: the dead token, then the healthy one. A loop
    // that kept hopping would show more attempts; a router that gave up would
    // show one attempt and a 401.
    assert.equal(calls.length, 2, `expected exactly one failover hop, saw ${calls.length} upstream calls`);
    assert.equal(calls[0].outcome, '401', 'the first attempt hit the dead account');
    assert.equal(calls[1].outcome, '200', 'the second attempt hit the healthy account');
    assert.notEqual(calls[0].token, calls[1].token, 'failover landed on a different account');
    // Both attempts used seeded pooled tokens (no env-token fallback, no
    // re-login token) — the hop went account→account.
    assert.deepEqual(new Set(calls.map((c) => c.token)), new Set([a.apiKey, b.apiKey]));
  });

  it('streams the healthy account after a pre-content 401, ending with [DONE]', async () => {
    const a = seed('s-a');
    const b = seed('s-b');
    __setConnectDeps({
      streamChatCompletion: async (params, send) => {
        const attempt = calls.length;
        if (attempt === 0) {
          calls.push({ token: params.token, outcome: '401' });
          // Fail BEFORE the first chunk: nothing is on the wire, so the loop
          // is allowed to replay the request on another account.
          throw unauthorizedWithBody();
        }
        calls.push({ token: params.token, outcome: '200' });
        send(chunk('FAILOVER_OK'));
        send(chunk('', 'stop'));
        return {
          content: 'FAILOVER_OK',
          reasoning: '',
          toolCalls: [],
          finish_reason: 'stop',
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        };
      },
    });

    const res = await post('/v1/chat/completions', {
      model: 'swe-1-6-slow',
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: FAILOVER_OK' }],
    });
    const raw = await res.text();
    assert.equal(res.status, 200, raw);

    const frames = sseData(raw);
    const content = frames
      .filter((frame) => frame !== '[DONE]')
      .map((frame) => frame.choices?.[0]?.delta?.content)
      .filter(Boolean)
      .join('');
    assert.equal(content, 'FAILOVER_OK', `streamed content from the healthy account:\n${raw}`);
    assert.equal(frames.at(-1), '[DONE]', 'the SSE stream closes with [DONE]');

    assert.equal(calls.length, 2, `expected exactly one failover hop, saw ${calls.length} upstream calls`);
    assert.equal(calls[0].outcome, '401');
    assert.equal(calls[1].outcome, '200');
    assert.notEqual(calls[0].token, calls[1].token, 'failover landed on a different account');
    assert.deepEqual(new Set(calls.map((c) => c.token)), new Set([a.apiKey, b.apiKey]));
  });
});

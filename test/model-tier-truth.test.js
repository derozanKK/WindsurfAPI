// CompatClients F1 — an explicit effort suffix in the requested model is
// AUTHORITATIVE; a separate `reasoning.effort` field must not rewrite it.
//
// Codex CLI (wire_api = "responses") sends `model: "gpt-6-luna-max"` together
// with `reasoning: {effort: "medium"}` on EVERY turn. mergeReasoningEffortIntoModel
// used to strip the requested `-max` suffix and rebuild the id from the effort
// field, so the proxy silently served `gpt-6-luna-medium` (4 credits) for a
// request that named the 7-credit tier — measured 18/18 requests in
// evidence/CompatClients.md. The chat route reported the rewritten name on both
// surfaces; the Responses route reported it on the stream surface and masked it
// on the non-stream one (it echoed the raw request string).
//
// These drive the REAL handlers and the REAL connect adapters; only the upstream
// generator is faked (`__setStreamChatForTest`), so `wire` is the selector that
// would actually be sent to server.codeium.com and `reported` is what the client
// receives. The two must agree on both stream and non-stream, on both routes.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleResponses } from '../src/handlers/responses.js';
import { __setStreamChatForTest } from '../src/devin-connect-openai.js';
import { cacheClear } from '../src/cache.js';

const MAX = 'gpt-6-luna-max';
const MEDIUM = 'gpt-6-luna-medium';
const CALLER = 'api:tiertruth000000000000000000:user:tier';

const SAVED = {};
const ENV_KEYS = [
  'DEVIN_CONNECT',
  'DEVIN_CONNECT_TOKEN',
  'WINDSURF_API_KEY',
  'WINDSURFAPI_STRICT_MODEL',
  'DEVIN_CONNECT_EAGER_PRIME',
];

/** The selector the handler actually put on the wire (fake upstream input). */
let wire = null;

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseFrames(raw) {
  return raw.split('\n\n').filter(Boolean).filter(f => !f.startsWith(':')).map(f => {
    const data = f.split('\n').find(line => line.startsWith('data: '))?.slice(6) || '';
    return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
  });
}

function parseEvents(raw) {
  return raw.trim().split('\n\n').filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .filter(frame => frame !== 'data: [DONE]')
    .map(frame => {
      const lines = frame.split('\n');
      return {
        event: lines.find(line => line.startsWith('event: '))?.slice(7),
        data: JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'),
      };
    });
}

/** One fake upstream turn for BOTH adapters; records the selector it was handed. */
function stubUpstream() {
  wire = null;
  __setStreamChatForTest(async function* (params) {
    wire = params.model;
    yield { type: 'content', text: 'ok' };
    yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  });
}

const reasoning = { effort: 'medium' };

async function runChat(stream) {
  const res = await handleChatCompletions({
    model: MAX,
    messages: [{ role: 'user', content: 'hi' }],
    reasoning,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  }, { callerKey: CALLER });
  if (!stream) return { status: res.status, model: res.body?.model, wire };
  const r = fakeRes();
  await res.handler(r);
  const frames = parseFrames(r.body);
  return {
    status: res.status,
    model: frames.find(f => f.model)?.model ?? null,
    models: [...new Set(frames.filter(f => f.model).map(f => f.model))],
    wire,
  };
}

async function runResponses(stream) {
  const result = await handleResponses({
    model: MAX,
    input: 'hi',
    reasoning,
    ...(stream ? { stream: true } : {}),
  }, { handleChatCompletions, context: { callerKey: CALLER } });
  if (!stream) return { status: result.status, model: result.body?.model, wire };
  const r = fakeRes();
  await result.handler(r);
  const events = parseEvents(r.body);
  const created = events.find(e => e.event === 'response.created');
  return {
    status: result.status,
    model: created?.data?.response?.model ?? null,
    wire,
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'test-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  cacheClear();
  stubUpstream();
});

afterEach(() => {
  __setStreamChatForTest(null);
  cacheClear();
  wire = null;
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('F1 — the requested model tier is authoritative over reasoning.effort', () => {
  it('/v1/chat/completions non-stream serves and reports the requested -max tier', async () => {
    const r = await runChat(false);

    assert.equal(r.status, 200);
    assert.equal(r.wire, MAX,
      `reasoning.effort=medium must not downgrade the wire selector (got ${r.wire})`);
    assert.equal(r.model, MAX, 'the response must report the model that was served');
    assert.notEqual(r.model, MEDIUM);
  });

  it('/v1/chat/completions stream serves and reports the requested -max tier on every chunk', async () => {
    const r = await runChat(true);

    assert.equal(r.status, 200);
    assert.equal(r.wire, MAX,
      `reasoning.effort=medium must not downgrade the wire selector (got ${r.wire})`);
    assert.deepEqual(r.models, [MAX],
      `every stream chunk must report the served model (got ${r.models.join(', ')})`);
  });

  it('/v1/responses non-stream reports the model that was actually served', async () => {
    const r = await runResponses(false);

    assert.equal(r.status, 200);
    assert.equal(r.wire, MAX,
      `reasoning.effort=medium must not downgrade the wire selector (got ${r.wire})`);
    // The non-stream Responses path used to echo the raw request string, which
    // MASKED this very defect (requested max, served medium, body said max).
    // It must follow the served name, not the requested one.
    assert.equal(r.model, r.wire,
      `response.model (${r.model}) must equal the served selector (${r.wire})`);
    assert.equal(r.model, MAX);
  });

  it('/v1/responses stream reports the model that was actually served', async () => {
    const r = await runResponses(true);

    assert.equal(r.status, 200);
    assert.equal(r.wire, MAX,
      `reasoning.effort=medium must not downgrade the wire selector (got ${r.wire})`);
    assert.equal(r.model, r.wire,
      `response.created.model (${r.model}) must equal the served selector (${r.wire})`);
    assert.equal(r.model, MAX);
  });

  it('still folds an effort into a BARE model id (the #115 behaviour this must not break)', async () => {
    // No explicit tier in the request → the effort field is the only signal and
    // is still honoured. gpt-6-luna is the bare family alias (catalog default
    // -medium); -high is a real tier.
    const res = await handleChatCompletions({
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high' },
    }, { callerKey: CALLER });

    assert.equal(res.status, 200);
    assert.equal(wire, 'gpt-6-luna-high', 'a bare model still takes the requested effort tier');
    assert.equal(res.body?.model, 'gpt-6-luna-high');
  });
});

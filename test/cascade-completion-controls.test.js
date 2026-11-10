// V-14 (KH-005) — the Cascade flow silently dropped every completion control.
//
// MEASURED on the audited baseline: `temperature`, `top_p`, `top_k` and
// `max_tokens` were placed only into the Devin Connect `completionOverrides`;
// neither Cascade entry point received them, and the wire builder hardcoded
// `max_output_tokens = 32768`. A caller asking for a tiny cap therefore got a
// much longer answer that still reported `finish_reason: "stop"` — a lie in the
// one field an auto-continuing client trusts.
//
// The contract this file pins:
//   * the caller's cap reaches the wire (CascadePlannerConfig field 6), clamped
//     to the value the real IDE is observed to send;
//   * the cap is enforced locally as `finish_reason: "length"`, so an upstream
//     that ignores the request cannot turn it into a clean stop;
//   * temperature / top_p / top_k are REFUSED on Cascade with a 400 that names
//     the parameter, because the wire has no field to carry them;
//   * the Devin Connect backend still honours all three (control).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleChatCompletions,
  __resetConnectDeps,
  __setConnectDeps,
} from '../src/handlers/chat.js';
import {
  buildSendCascadeMessageRequest,
  normalizeCascadeMaxOutputTokens,
  CASCADE_MAX_OUTPUT_TOKENS_CEILING,
} from '../src/windsurf.js';
import { parseFields, getField } from '../src/proto.js';
import { addAccountByKey, getApiKey, removeAccount } from '../src/auth.js';

// The response cache would replay the previous test's capped answer (its key does
// not carry max_tokens) and mask the cap under test.
process.env.RESPONSE_CACHE_ENABLED = '0';

const CALLER = 'api:v14:user:u1';
const CASCADE_MODEL = 'gemini-2.5-flash';
const CONNECT_MODEL = 'swe-1-6-slow';
const created = [];
let savedDevinConnect = null;

function seedAccount(label) {
  const a = addAccountByKey(`v14-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  return a;
}

beforeEach(() => { savedDevinConnect = process.env.DEVIN_CONNECT; });

afterEach(() => {
  __resetConnectDeps();
  if (savedDevinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = savedDevinConnect;
  while (created.length) {
    try { removeAccount(created.pop()); } catch {}
  }
});

/** Read max_output_tokens (field 6) out of the planner config (request field 5). */
function wireMaxOutputTokens(sendProto) {
  const request = parseFields(sendProto);
  const config = getField(request, 5, 2);
  assert.ok(config && config.value && config.value.length, 'the request must carry cascade_config (field 5)');
  // CascadeConfig.planner_config is field 1; max_output_tokens is field 6 of it.
  const plannerWrap = getField(parseFields(config.value), 1, 2);
  assert.ok(plannerWrap && plannerWrap.value, 'cascade_config must carry the planner config (field 1)');
  const field = getField(parseFields(plannerWrap.value), 6, 0);
  return field ? Number(field.value) : null;
}

function cascadeDeps(text, capture) {
  class FakeClient {
    async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
      if (capture) capture.completion = opts.completion;
      if (opts.onChunk) await opts.onChunk({ text, thinking: '', isError: false });
      // The non-stream path reads the returned array; the stream path uses onChunk.
      const chunks = opts.onChunk ? [] : [{ text, thinking: '', isError: false }];
      chunks.toolCalls = [];
      chunks.totalYielded = text.length;
      chunks.totalThinking = 0;
      return chunks;
    }
  }
  return {
    waitForAccount(tried) { return tried.length === 0 ? getApiKey(tried) : null; },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17991, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
    callerKey: CALLER,
  };
}

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
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return this; },
    once(event, cb) { this.on(event, cb); return this; },
    removeListener() {},
    writeHead() { return this; },
  };
}

function streamFrames(res) {
  return res.body.split('\n\n').filter(Boolean).map((frame) => {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return null;
    try { return JSON.parse(line.slice(6)); } catch { return null; }
  }).filter(Boolean);
}

function body(extra = {}) {
  return {
    model: CASCADE_MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'count to a thousand' }],
    ...extra,
  };
}

describe('V-14: the caller output cap reaches the Cascade wire', () => {
  it('writes max_tokens into CascadePlannerConfig field 6', () => {
    const withCap = buildSendCascadeMessageRequest('key', 'cascade-1', 'hi', 0, 'MODEL', 'sess', { maxOutputTokens: 64 });
    assert.equal(wireMaxOutputTokens(withCap), 64);
    const withoutCap = buildSendCascadeMessageRequest('key', 'cascade-1', 'hi', 0, 'MODEL', 'sess', {});
    assert.equal(wireMaxOutputTokens(withoutCap), 32768, 'an unset cap keeps the historical default byte-identically');
  });

  it('clamps to the IDE ceiling and ignores unusable values', () => {
    assert.equal(normalizeCascadeMaxOutputTokens(64), 64);
    assert.equal(normalizeCascadeMaxOutputTokens(1e9), CASCADE_MAX_OUTPUT_TOKENS_CEILING);
    assert.equal(normalizeCascadeMaxOutputTokens(0), CASCADE_MAX_OUTPUT_TOKENS_CEILING);
    assert.equal(normalizeCascadeMaxOutputTokens(-5), CASCADE_MAX_OUTPUT_TOKENS_CEILING);
    assert.equal(normalizeCascadeMaxOutputTokens('nope'), CASCADE_MAX_OUTPUT_TOKENS_CEILING);
    assert.equal(normalizeCascadeOutputFloor(), 1);
  });
});

function normalizeCascadeOutputFloor() {
  // A fractional cap must still ask for at least one token, never zero.
  return normalizeCascadeMaxOutputTokens(0.4);
}

describe('V-14: controls the Cascade wire cannot carry are refused, not dropped', () => {
  it('temperature on Cascade returns 400 param=temperature', async () => {
    process.env.DEVIN_CONNECT = '0';
    seedAccount('cascade-temp');
    const r = await handleChatCompletions(body({ temperature: 0.3 }), cascadeDeps('x'));
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.param, 'temperature');
    assert.equal(r.body.error.type, 'invalid_request_error');
    assert.match(r.body.error.message, /temperature/);
  });

  it('top_p and top_k are refused the same way', async () => {
    process.env.DEVIN_CONNECT = '0';
    seedAccount('cascade-topp');
    const topP = await handleChatCompletions(body({ top_p: 0.9 }), cascadeDeps('x'));
    assert.equal(topP.status, 400);
    assert.equal(topP.body.error.param, 'top_p');
    const topK = await handleChatCompletions(body({ top_k: 40 }), cascadeDeps('x'));
    assert.equal(topK.status, 400);
    assert.equal(topK.body.error.param, 'top_k');
  });

  it('control: the Devin Connect backend still honours them', async () => {
    process.env.DEVIN_CONNECT = '1';
    seedAccount('connect-temp');
    let seen = null;
    __setConnectDeps({
      toChatCompletion: async (params) => {
        seen = params.completion || null;
        return {
          status: 200,
          body: {
            id: 'x', object: 'chat.completion', created: 1, model: CONNECT_MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          },
        };
      },
    });
    const r = await handleChatCompletions(
      body({ model: CONNECT_MODEL, temperature: 0.3, top_p: 0.9, top_k: 40 }),
      { callerKey: CALLER },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(seen, { temperature: 0.3, topP: 0.9, topK: 40 }, 'the connect adapter must still receive them');
  });
});

describe('V-14: the cap is enforced locally and reported as length', () => {
  const LONG = 'A'.repeat(400); // 400 chars ≈ 100 tokens

  it('non-stream: a small max_tokens truncates the answer and reports length', async () => {
    process.env.DEVIN_CONNECT = '0';
    seedAccount('cascade-cap');
    const capture = {};
    const r = await handleChatCompletions(body({ max_tokens: 10 }), cascadeDeps(LONG, capture));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(capture.completion, { maxTokens: 10 }, 'the cap must reach the producer');
    const choice = r.body.choices[0];
    assert.equal(choice.message.content.length, 40, '10 tokens × 4 chars/token');
    assert.equal(choice.finish_reason, 'length', 'a cut answer is never reported as a clean stop');
  });

  it('non-stream control: no cap means the whole answer and finish_reason stop', async () => {
    process.env.DEVIN_CONNECT = '0';
    seedAccount('cascade-nocap');
    const r = await handleChatCompletions(body({}), cascadeDeps(LONG));
    assert.equal(r.status, 200);
    assert.equal(r.body.choices[0].message.content.length, 400);
    assert.equal(r.body.choices[0].finish_reason, 'stop');
  });

  it('stream: the cap stops the content channel and the terminal says length', async () => {
    process.env.DEVIN_CONNECT = '0';
    seedAccount('cascade-stream-cap');
    const r = await handleChatCompletions(body({ stream: true, max_tokens: 10 }), cascadeDeps(LONG));
    assert.equal(r.status, 200);
    const res = fakeRes();
    await r.handler(res);
    const chunks = streamFrames(res);
    const content = chunks.flatMap((c) => c.choices || []).map((c) => c.delta?.content || '').join('');
    assert.equal(content.length, 40);
    assert.equal(chunks.some((c) => c.choices?.[0]?.finish_reason === 'length'), true,
      `expected a length terminal, got ${JSON.stringify(chunks.map((c) => c.choices?.[0]?.finish_reason ?? c.error?.code))}`);
    assert.equal(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'), false);
    assert.ok(res.body.includes('data: [DONE]'), 'a length terminal is still a well-formed stream end');
  });

  it('stream control: no cap streams the whole answer and stops', async () => {
    process.env.DEVIN_CONNECT = '0';
    seedAccount('cascade-stream-nocap');
    const r = await handleChatCompletions(body({ stream: true }), cascadeDeps(LONG));
    const res = fakeRes();
    await r.handler(res);
    const chunks = streamFrames(res);
    const content = chunks.flatMap((c) => c.choices || []).map((c) => c.delta?.content || '').join('');
    assert.equal(content.length, 400);
    assert.equal(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'), true);
  });
});

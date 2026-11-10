// C3-01 (evidence/HistoryGapAudit/gaps.md): /v1/models advertises
// `supports_images` from the live DEVIN_CONNECT catalog (GetCliModelConfigs
// field #5), but no request path ever read the bit — images were forwarded to a
// model the same server had just told the client was text-only.
//
// Measurement (2026-10-25, production account, evidence/Wave4-Images.md):
// 240 catalog rows — 224 supports_images=true, 0 false, 16 silent. No live model
// exercises the false arm, so there is no capture of a false model rejecting an
// image. The gate therefore STRIPS image blocks and counts them
// (`images_dropped_capability`) instead of refusing the request with a 400: a
// hard failure derived from a bit whose false arm has never been observed is
// the same class of bug as the Codex `parallel_tool_calls` 400 that broke a
// working client (chat.js:3623-3635). Only an EXPLICIT false gates; a missing
// bit stays unknown and forwards unchanged, exactly like `disabled` (#4).
//
// Red-first: these tests were written before the gate existed and failed on the
// unmodified handler (images still in params.messages, counter undefined).

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleMessages } from '../src/handlers/messages.js';
import { setLiveCatalogSelectors, clearLiveCatalogSelectors } from '../src/devin-connect-models.js';
import { getConnectMetrics } from '../src/devin-connect-metrics.js';
import { log } from '../src/config.js';

const TEXT_ONLY = 'w4-text-only-model';
const VISION = 'w4-vision-model';
const SILENT = 'w4-silent-model';

// 1x1 transparent PNG.
const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const B64 = DATA_URL.split(',')[1];

const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'WINDSURFAPI_STRICT_MODEL'];
const SAVED_ENV = {};
for (const key of ENV_KEYS) SAVED_ENV[key] = process.env[key];

const upstream = { hits: 0, lastParams: null };

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
    removeListener() {},
  };
}

function chatBody(model) {
  return {
    id: 'chatcmpl-w4', object: 'chat.completion', created: 0, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function ask(body, context = { callerKey: '' }) {
  return handleChatCompletions(body, context);
}

async function captureLogs(fn) {
  const lines = [];
  const origInfo = log.info;
  const origWarn = log.warn;
  log.info = (...args) => { lines.push(args.join(' ')); };
  log.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    log.info = origInfo;
    log.warn = origWarn;
  }
}

function imageDrops() { return getConnectMetrics().images_dropped_capability; }

/** Every image block that would ride the connect wire. */
function wireImages(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (!Array.isArray(msg?.content)) continue;
    for (const part of msg.content) {
      if (part?.type === 'image_url' || part?.type === 'image' || part?.type === 'input_image') out.push(part);
    }
  }
  return out;
}

before(() => {
  process.env.DEVIN_CONNECT = '1';
  process.env.DEVIN_CONNECT_TOKEN = 'env-token-shape-only';
  delete process.env.WINDSURF_API_KEY;
  delete process.env.WINDSURFAPI_STRICT_MODEL;
  // Only these three selectors exist in the authoritative catalog for the run:
  // false, true, and silent (bit absent) — the three-state matrix.
  setLiveCatalogSelectors([
    { selector: TEXT_ONLY, provider: 'test', supportsImages: false },
    { selector: VISION, provider: 'test', supportsImages: true },
    { selector: SILENT, provider: 'test' },
  ]);
  __setConnectDeps({
    toChatCompletion: async (params) => {
      upstream.hits++;
      upstream.lastParams = params;
      return { status: 200, body: chatBody(params.model) };
    },
    streamChatCompletion: async (params, send) => {
      upstream.hits++;
      upstream.lastParams = params;
      send({ id: 'x', object: 'chat.completion.chunk', created: 0, model: params.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] });
      send({ id: 'x', object: 'chat.completion.chunk', created: 0, model: params.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    },
  });
});

beforeEach(() => {
  upstream.hits = 0;
  upstream.lastParams = null;
});

after(() => {
  __resetConnectDeps();
  clearLiveCatalogSelectors();
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

describe('connect image capability gate — supports_images:false', () => {
  it('strips the image, preserves the text turn, counts the drop and warns', async () => {
    const before = imageDrops();
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: DATA_URL } },
      ],
    }];
    const { value, lines } = await captureLogs(() => ask({ model: TEXT_ONLY, stream: false, messages }));
    assert.equal(value.status, 200, JSON.stringify(value.body));
    assert.equal(upstream.hits, 1);
    assert.equal(wireImages(upstream.lastParams.messages).length, 0, 'no image may ride the wire to a false model');
    assert.deepEqual(upstream.lastParams.messages, [{
      role: 'user',
      content: [{ type: 'text', text: 'what is in this image?' }],
    }], 'the text part must survive verbatim');
    assert.equal(imageDrops() - before, 1, 'one dropped image is counted');
    const warn = lines.find((l) => l.includes('images_dropped_capability'));
    assert.ok(warn, `a warn naming the counter must be emitted; got:\n${lines.join('\n')}`);
    assert.ok(warn.includes(TEXT_ONLY), 'the warn names the resolved selector');
    assert.ok(warn.includes('supports_images=false'), 'the warn names the capability');
  });

  it('strips images from replayed history and tool results too, counting every block', async () => {
    const before = imageDrops();
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: DATA_URL } },
      ] },
      { role: 'assistant', content: 'looked at it' },
      { role: 'user', content: [
        { type: 'text', text: 'and this one?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
        { type: 'image_url', image_url: { url: DATA_URL } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: [
        { type: 'text', text: 'tool output' },
        { type: 'image_url', image_url: { url: DATA_URL } },
      ] },
    ];
    const { value } = await captureLogs(() => ask({ model: TEXT_ONLY, stream: false, messages }));
    assert.equal(value.status, 200, JSON.stringify(value.body));
    assert.equal(wireImages(upstream.lastParams.messages).length, 0);
    assert.equal(imageDrops() - before, 4, 'every block counts: user history, two in the current turn, and the tool result');
    assert.equal(upstream.lastParams.messages[0].content[0].text, 'first');
    assert.equal(upstream.lastParams.messages[3].content[0].text, 'tool output');
  });

  it('strips on the streaming path before the wire adapter runs', async () => {
    const before = imageDrops();
    const result = await ask({
      model: TEXT_ONLY,
      stream: true,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: DATA_URL } },
      ] }],
    });
    assert.equal(result.status, 200);
    const res = fakeRes();
    await result.handler(res);
    assert.equal(upstream.hits, 1);
    assert.equal(wireImages(upstream.lastParams.messages).length, 0);
    assert.equal(imageDrops() - before, 1);
  });

  it('leaves an image-free request byte-identical even for a false model', async () => {
    const before = imageDrops();
    const messages = [{ role: 'user', content: 'plain text only' }];
    const { value, lines } = await captureLogs(() => ask({ model: TEXT_ONLY, stream: false, messages }));
    assert.equal(value.status, 200);
    assert.deepEqual(upstream.lastParams.messages, messages);
    assert.equal(imageDrops() - before, 0);
    assert.equal(lines.some((l) => l.includes('images_dropped_capability')), false, 'no warn when nothing was dropped');
  });

  // P2-3 (Kimi wave review): the answerability guard runs BEFORE stripping and
  // counts a non-text part as content. An image-only last turn therefore passed
  // it, was stripped to `content: []`, and the handler returned 200 while the
  // builder encoded an empty user frame — which consecutive user turns can merge
  // away, leaving the model to answer a stale earlier prompt. Nothing was left
  // to answer, so the honest answer is a clear 400.
  it('refuses an image-only last turn with a clear 400 instead of an empty user frame', async () => {
    const before = imageDrops();
    const messages = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: DATA_URL } }],
    }];
    const { value, lines } = await captureLogs(() => ask({ model: TEXT_ONLY, stream: false, messages }));
    assert.equal(value.status, 400, JSON.stringify(value.body));
    assert.equal(upstream.hits, 0, 'a turn with no answerable content must not reach the upstream');
    assert.equal(value.body.error.type, 'invalid_request_error');
    assert.equal(value.body.error.param, 'messages');
    assert.match(value.body.error.message, /supports_images/,
      'the error must name the capability that caused the strip');
    assert.match(value.body.error.message, /image/i);
    assert.equal(imageDrops() - before, 1, 'the block was still dropped and is counted');
    assert.ok(lines.some((l) => /image-only|no answerable/i.test(l)),
      `a warn must name the refusal; got:\n${lines.join('\n')}`);
  });

  // Control for the refusal: a conversation that ends on a TOOL RESULT is still
  // answerable even if an earlier user turn was image-only and got emptied by
  // the strip. The 400 is about the terminal turn, not about any empty turn.
  it('keeps a tool-result continuation answerable when an earlier user image is stripped', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: DATA_URL } }] },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool output' },
    ];
    const { value } = await captureLogs(() => ask({ model: TEXT_ONLY, stream: false, messages }));
    assert.equal(value.status, 200, JSON.stringify(value.body));
    assert.equal(upstream.hits, 1, 'a tool-result-terminated request is answerable');
    assert.equal(wireImages(upstream.lastParams.messages).length, 0);
    const toolTurn = upstream.lastParams.messages.find((m) => m.role === 'tool');
    assert.equal(toolTurn?.content, 'tool output', 'the tool result must survive');
  });
});

describe('connect image capability gate — true and unknown are untouched', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this image?' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ],
  }];

  it('forwards images unchanged to a model that declares supports_images=true', async () => {
    const before = imageDrops();
    const result = await ask({ model: VISION, stream: false, messages });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(upstream.lastParams.messages, messages);
    assert.equal(imageDrops() - before, 0);
  });

  it('forwards images unchanged when the catalog is silent (unknown is not a no)', async () => {
    const before = imageDrops();
    const result = await ask({ model: SILENT, stream: false, messages });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(upstream.lastParams.messages, messages);
    assert.equal(imageDrops() - before, 0);
  });
});

describe('connect image capability gate is shared by every surface', () => {
  it('/v1/responses input_image is stripped for a false model', async () => {
    const before = imageDrops();
    const result = await handleResponses({
      model: TEXT_ONLY,
      stream: false,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: DATA_URL },
        ],
      }],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(upstream.hits, 1);
    assert.equal(wireImages(upstream.lastParams.messages).length, 0);
    assert.equal(imageDrops() - before, 1);
  });

  it('/v1/messages Anthropic image block is stripped for a false model', async () => {
    const before = imageDrops();
    const result = await handleMessages({
      model: TEXT_ONLY,
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
        ],
      }],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(upstream.hits, 1);
    assert.equal(wireImages(upstream.lastParams.messages).length, 0);
    assert.equal(imageDrops() - before, 1);
  });
});

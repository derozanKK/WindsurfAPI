// Remote (http/https) `image_url` blocks on the DEVIN_CONNECT route.
//
// Before this, extractInlineImages (synchronous) accepted only data:/base64 and
// the wire builder called it, so an ordinary OpenAI image_url pointing at an
// https:// host was dropped with NO log line — measured 2026-10-23 on all four
// connect families (evidence/ToolMatrixLive.md §images: inline PNG answered
// "Red"/"Green", the same PNG behind HTTPS answered "Unknown"/"cannot see").
//
// The fix resolves URLs in streamChat() through image.js's fetchImageUrl, whose
// bounds (8 s deadline, 5 MB cap, image/* allowlist, per-hop private-IP lookup)
// are already covered by test/image-fetch-deadline.test.js. These tests prove the
// CONNECT wiring: success reaches #10, every rejection path is loud and drops only
// the image, the caller's messages are never mutated, and the synchronous builder
// still names an unresolved URL instead of silently discarding it.
//
// The transport is the same fake https.get seam the deadline suite uses, so no
// socket is opened and no host is resolved.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const transport = await import('./helpers/fake-image-transport.mjs');

const require = createRequire(import.meta.url);
const http = require('node:http');
const https = require('node:https');
http.get = transport.get;
https.get = transport.get;
syncBuiltinESMExports();

const {
  inlineRemoteImages,
  buildGetChatMessageRequest,
  extractInlineImages,
  streamChat,
  __setRequestImpl,
  REMOTE_IMAGE_MAX_PER_REQUEST,
} = await import('../src/devin-connect.js');
const { getConnectMetrics } = await import('../src/devin-connect-metrics.js');
const { parseFields, getAllFields, getField, writeStringField, writeVarintField } = await import('../src/proto.js');
const { wrapEnvelope, endOfStreamEnvelope, unwrapRequest } = await import('../src/connect.js');
const { log } = await import('../src/config.js');

const TOKEN = 'devin-session-token$test.jwt.sig';
const URL_A = 'https://img.example.test/a.png';
const HTTP_URL = 'http://img.example.test/a.png?signature=secret';
const HTTP_REDIRECT = 'http://cdn.example.test/b.png?signature=secret';
const ALLOW_HTTP = 'WINDSURFAPI_ALLOW_HTTP_IMAGES';
const originalAllowHttp = process.env[ALLOW_HTTP];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG_HEADERS = { 'content-type': 'image/png' };

const tick = () => new Promise((resolve) => setImmediate(resolve));
const imageBlock = (url) => ({ type: 'image_url', image_url: { url } });
const messagesWith = (url) => [{
  role: 'user',
  content: [{ type: 'text', text: 'what color?' }, imageBlock(url)],
}];

// #3 ChatMessage → repeated #10 ImageData.
function chatMessagesOf(proto) {
  return getAllFields(parseFields(proto), 3).map((f) => parseFields(f.value));
}
function imagesOf(cm) {
  return getAllFields(cm, 10).map((f) => parseFields(f.value));
}

function captureWarns() {
  const warnings = [];
  const original = log.warn;
  log.warn = (...args) => warnings.push(args.join(' '));
  return { warnings, restore: () => { log.warn = original; } };
}

function mockTransport(framePayloads, onBody) {
  return (_opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = (buf) => { onBody?.(buf); };
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        for (const p of framePayloads) res.emit('data', wrapEnvelope(p, { compress: false }));
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      });
      cb(res);
    };
    return req;
  };
}

async function collect(gen) {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

beforeEach(() => {
  transport.reset();
  delete process.env[ALLOW_HTTP];
});
afterEach(() => {
  __setRequestImpl(null);
  if (originalAllowHttp === undefined) delete process.env[ALLOW_HTTP];
  else process.env[ALLOW_HTTP] = originalAllowHttp;
});

describe('inlineRemoteImages — success', () => {
  it('fetches an https image_url, returns a new tree, and the bytes reach #10', async () => {
    const messages = messagesWith(URL_A);
    const before = getConnectMetrics().remote_images_inlined;
    const pending = inlineRemoteImages(messages);

    assert.equal(transport.hops.length, 1, 'the first hop must be issued immediately');
    assert.equal(transport.hops[0].url, URL_A);
    assert.equal(typeof transport.hops[0].options.lookup, 'function',
      'the SSRF lookup hook must be passed through');
    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(PNG);
    res.end();

    const out = await pending;
    assert.notEqual(out, messages, 'a changed request must be a new array');
    assert.notEqual(out[0], messages[0], 'the touched message must be a new object');
    assert.equal(out[0].content[0].text, 'what color?', 'text blocks keep their order');
    assert.equal(out[0].content[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(messages[0].content[1].image_url.url, URL_A,
      'the caller array must not be mutated (retry/failover re-passes it)');
    assert.equal(getConnectMetrics().remote_images_inlined - before, 1,
      'the inline must be counted');

    // And the wire builder turns the data URL into ImageData #10.
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'swe-2-medium', messages: out, env: {},
    });
    const cms = chatMessagesOf(proto);
    assert.equal(cms.length, 1);
    const imgs = imagesOf(cms[0]);
    assert.equal(imgs.length, 1, 'exactly one #10 image');
    assert.equal(getField(imgs[0], 1, 2).value.toString('utf8'), PNG.toString('base64'));
    assert.equal(getField(imgs[0], 2, 2).value.toString('utf8'), 'image/png');
  });

  it('leaves data: URLs and base64 blocks untouched without fetching or copying', async () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
      ],
    }];
    const out = await inlineRemoteImages(messages);
    assert.equal(out, messages, 'nothing to resolve → the input array is returned as-is');
    assert.equal(transport.hops.length, 0, 'no fetch for inline sources');
    assert.equal(extractInlineImages(out[0].content).length, 2);
  });

  it('preserves sibling fields (detail) on the replaced image_url block', async () => {
    const block = { type: 'image_url', image_url: { url: URL_A, detail: 'high' } };
    const pending = inlineRemoteImages([{ role: 'user', content: [block] }]);
    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(PNG);
    res.end();
    const out = await pending;
    assert.equal(out[0].content[0].image_url.detail, 'high');
  });
});

describe('inlineRemoteImages — bounded rejection paths', () => {
  it('drops a non-image content type, logs the host (not the URL), keeps the text', async () => {
    const cap = captureWarns();
    try {
      const pending = inlineRemoteImages(messagesWith(URL_A));
      const res = transport.respond(transport.hops[0], {
        status: 200, headers: { 'content-type': 'text/html' },
      });
      res.chunk('<html>not an image</html>');
      res.end();

      const out = await pending;
      assert.equal(out[0].content.length, 1, 'the rejected image block must be dropped');
      assert.equal(out[0].content[0].text, 'what color?', 'text survives');
      const text = cap.warnings.join('\n');
      assert.match(text, /remote image_url fetch failed/);
      assert.match(text, /Unsupported image type: text\/html/);
      assert.match(text, /img\.example\.test/, 'the log must name the host');
      assert.doesNotMatch(text, /\/a\.png/, 'the full URL (possible signed query) must not be logged');
    } finally { cap.restore(); }
  });

  it('never dials a private address a redirect points at', async () => {
    const cap = captureWarns();
    try {
      const pending = inlineRemoteImages(messagesWith(URL_A));
      transport.respond(transport.hops[0], { status: 302, location: 'http://10.0.0.5/x.png' });
      const out = await pending;
      assert.equal(transport.hops.length, 1,
        'the redirect target must be rejected by validation, not requested');
      assert.equal(out[0].content.length, 1, 'image dropped');
      assert.match(cap.warnings.join('\n'), /private\/internal/);
    } finally { cap.restore(); }
  });

  it('rejects a fetchImpl result that is not an allowlisted image type', async () => {
    // Guards the injected-transport path: fetchImageUrl enforces the allowlist
    // itself, but a different/regressed fetcher must not be able to smuggle
    // text bytes onto the wire as an image.
    const cap = captureWarns();
    try {
      const out = await inlineRemoteImages(messagesWith(URL_A), {
        fetchImpl: async () => ({ base64_data: 'AAAA', mime_type: 'text/html' }),
      });
      assert.equal(out[0].content.length, 1);
      assert.match(cap.warnings.join('\n'), /unsupported type "text\/html"/);
    } finally { cap.restore(); }
  });

  it('rejects an oversized base64 result from an injected fetcher', async () => {
    const cap = captureWarns();
    try {
      const out = await inlineRemoteImages(messagesWith(URL_A), {
        fetchImpl: async () => ({ base64_data: 'A'.repeat(7 * 1024 * 1024), mime_type: 'image/png' }),
      });
      assert.equal(out[0].content.length, 1);
      assert.match(cap.warnings.join('\n'), /exceeds 5242880 bytes/);
    } finally { cap.restore(); }
  });

  it('caps the number of fetches per request', async () => {
    const cap = captureWarns();
    try {
      const blocks = Array.from({ length: REMOTE_IMAGE_MAX_PER_REQUEST + 1 },
        (_, i) => imageBlock(`https://img.example.test/${i}.png`));
      const pending = inlineRemoteImages([{ role: 'user', content: blocks }]);
      for (let i = 0; i < REMOTE_IMAGE_MAX_PER_REQUEST; i++) {
        const res = transport.respond(transport.hops[i], { status: 200, headers: PNG_HEADERS });
        res.chunk(PNG);
        res.end();
        await tick();
      }
      const out = await pending;
      assert.equal(transport.hops.length, REMOTE_IMAGE_MAX_PER_REQUEST,
        'the 21st URL must not open a connection');
      assert.equal(out[0].content.length, REMOTE_IMAGE_MAX_PER_REQUEST,
        'the over-cap block is dropped, the fetched ones stay');
      assert.match(cap.warnings.join('\n'), /more than 20 remote image_url blocks/);
    } finally { cap.restore(); }
  });

  it('stops before fetching when the caller already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      inlineRemoteImages(messagesWith(URL_A), { signal: controller.signal }),
      (err) => err.name === 'AbortError' && err.code === 'ABORT_ERR',
    );
    assert.equal(transport.hops.length, 0);
  });
});

describe('inlineRemoteImages — plaintext http gate', () => {
  it('rejects a plaintext http image by default: no dial, text preserved, host-only warn', async () => {
    const cap = captureWarns();
    const before = getConnectMetrics().remote_image_fetch_failed;
    try {
      const pending = inlineRemoteImages(messagesWith(HTTP_URL));
      // A dialed hop means the gate regressed: answer it so the assertions fail
      // fast instead of waiting out the 8 s fetch deadline.
      const dialed = transport.hops.length;
      if (dialed) {
        const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
        res.chunk(PNG);
        res.end();
      }
      const out = await pending;

      assert.equal(dialed, 0, 'the URL must be rejected before any connection is opened');
      assert.equal(out[0].content.length, 1, 'only the image is dropped');
      assert.equal(out[0].content[0].text, 'what color?', 'text survives');
      assert.equal(getConnectMetrics().remote_image_fetch_failed - before, 1,
        'the rejection must be counted like every other failed fetch');
      const text = cap.warnings.join('\n');
      assert.match(text, /plaintext http/i);
      assert.match(text, /WINDSURFAPI_ALLOW_HTTP_IMAGES=1/, 'the error must name the escape hatch');
      assert.match(text, /img\.example\.test/, 'the log must name the host');
      assert.doesNotMatch(text, /signature=secret|\/a\.png/,
        'the full URL (possible signed query) must never be logged');
    } finally { cap.restore(); }
  });

  it('fetches a plaintext http image when WINDSURFAPI_ALLOW_HTTP_IMAGES=1', async () => {
    process.env[ALLOW_HTTP] = '1';
    const messages = messagesWith(HTTP_URL);
    const pending = inlineRemoteImages(messages);
    assert.equal(transport.hops.length, 1, 'the escape hatch must restore the old behaviour');
    assert.equal(transport.hops[0].url, HTTP_URL);

    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(PNG);
    res.end();
    const out = await pending;
    assert.equal(out[0].content[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(messages[0].content[1].image_url.url, HTTP_URL,
      'the caller array must not be mutated');
  });

  it('rejects a redirect hop that downgrades https to plaintext http', async () => {
    const cap = captureWarns();
    try {
      const pending = inlineRemoteImages(messagesWith(URL_A));
      transport.respond(transport.hops[0], { status: 302, location: HTTP_REDIRECT });
      await tick();
      // Answer a dialed downgrade hop so a regressed gate fails fast.
      if (transport.hops[1]) {
        const res = transport.respond(transport.hops[1], { status: 200, headers: PNG_HEADERS });
        res.chunk(PNG);
        res.end();
      }
      const out = await pending;

      assert.equal(transport.hops.length, 1, 'the downgraded hop must never be requested');
      assert.equal(out[0].content.length, 1, 'image dropped');
      assert.equal(out[0].content[0].text, 'what color?', 'text survives');
      const text = cap.warnings.join('\n');
      assert.match(text, /plaintext http/i);
      assert.match(text, /WINDSURFAPI_ALLOW_HTTP_IMAGES=1/);
      assert.match(text, /cdn\.example\.test/);
      assert.doesNotMatch(text, /signature=secret|\/b\.png/);
    } finally { cap.restore(); }
  });

  it('follows a redirect downgrade when the escape hatch is on', async () => {
    process.env[ALLOW_HTTP] = '1';
    const pending = inlineRemoteImages(messagesWith(URL_A));
    transport.respond(transport.hops[0], { status: 302, location: HTTP_REDIRECT });
    await tick();
    assert.equal(transport.hops.length, 2, 'the downgraded hop must be followed');
    assert.equal(transport.hops[1].url, HTTP_REDIRECT);

    const res = transport.respond(transport.hops[1], { status: 200, headers: PNG_HEADERS });
    res.chunk(PNG);
    res.end();
    const out = await pending;
    assert.equal(out[0].content[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('leaves https alone for non-1 flag values', async () => {
    for (const value of ['0', 'true', '']) {
      process.env[ALLOW_HTTP] = value;
      transport.reset();
      const pending = inlineRemoteImages(messagesWith(URL_A));
      const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
      res.chunk(PNG);
      res.end();
      const out = await pending;
      assert.equal(out[0].content[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`,
        `https must stay allowed with ${ALLOW_HTTP}=${JSON.stringify(value)}`);
    }
  });
});

describe('synchronous builder — explicit instead of silent', () => {
  it('warns and counts when a remote URL reaches buildGetChatMessageRequest', () => {
    const cap = captureWarns();
    const before = getConnectMetrics().remote_image_unresolved;
    try {
      const proto = buildGetChatMessageRequest({
        token: TOKEN,
        model: 'swe-2-medium',
        messages: messagesWith(URL_A),
        env: {},
      });
      const cms = chatMessagesOf(proto);
      assert.equal(cms.length, 1, 'the text still goes');
      assert.equal(imagesOf(cms[0]).length, 0, 'the unfetched image is not on the wire');
      const text = cap.warnings.join('\n');
      assert.match(text, /reached the wire builder unresolved/);
      assert.match(text, /img\.example\.test/);
      assert.equal(getConnectMetrics().remote_image_unresolved - before, 1);
    } finally { cap.restore(); }
  });
});

describe('synchronous builder — assistant-turn drop stays named', () => {
  it('counts and logs a remote image dropped from an image-only assistant turn', () => {
    // #272's drop is deliberate; the silence was the defect. A remote URL used to
    // slip past extractInlineImages with no count and no line, so it was doubly
    // invisible. It must be named like any other assistant image.
    const cap = captureWarns();
    const before = getConnectMetrics().assistant_images_dropped;
    try {
      buildGetChatMessageRequest({
        token: TOKEN,
        model: 'swe-2-medium',
        messages: [
          { role: 'assistant', content: [imageBlock(URL_A)] },
          { role: 'user', content: 'x' },
        ],
        env: {},
      });
      assert.match(cap.warnings.join('\n'), /from an assistant turn \(#272\)/);
      assert.equal(getConnectMetrics().assistant_images_dropped - before, 1);
    } finally { cap.restore(); }
  });
});

describe('streamChat — the production call site', () => {
  it('resolves the URL before the proto is built', async () => {
    let sent = null;
    __setRequestImpl(mockTransport([
      Buffer.concat([writeStringField(3, 'ok'), writeVarintField(5, 2)]),
    ], (body) => { sent = unwrapRequest(body); }));

    const pending = collect(streamChat({
      messages: messagesWith(URL_A),
      model: 'gpt-6-luna-max',
      token: TOKEN,
      env: { DEVIN_CONNECT_TOKEN: TOKEN },
    }));

    // streamChat awaits the image fetch before issuing the upstream request.
    await tick();
    assert.equal(transport.hops.length, 1, 'the image hop must be issued first');
    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(PNG);
    res.end();

    const events = await pending;
    assert.ok(events.some((e) => e.type === 'finish'), 'the stream completes');
    assert.ok(sent, 'the request body must have been captured');
    const cms = chatMessagesOf(sent);
    const imgs = imagesOf(cms[0]);
    assert.equal(imgs.length, 1, 'the fetched image must ride #10 on the real request');
    assert.equal(getField(imgs[0], 1, 2).value.toString('utf8'), PNG.toString('base64'));
  });
});

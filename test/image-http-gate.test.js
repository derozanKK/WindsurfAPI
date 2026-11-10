// HTTP-IMAGE-GATE: plaintext `http://` image URLs are a MITM surface.
//
// validateImageUrl accepted both protocols, so any hop between the gateway and the
// image host (proxy, DNS hijack, hostile Wi-Fi) could replace the bytes that end up
// inlined into the model's context — Cascade image blocks here, DEVIN_CONNECT #10
// through the same helper. The gate lives in validateImageUrl, which fetchImageHop
// runs on EVERY hop, so an https -> http redirect is covered too.
// WINDSURFAPI_ALLOW_HTTP_IMAGES=1 is the explicit opt-out (read live, exactly
// `=== '1'`, like net-safety's trustedProxyHops), for a trusted LAN mirror.
//
// The transport is the fake http/https.get seam from
// test/image-fetch-deadline.test.js: no socket is opened and no host is resolved,
// so "rejected before dialing" is observable as `transport.hops.length === 0`.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const transport = await import('./helpers/fake-image-transport.mjs');
const { encodePngRGBA } = await import('./helpers/png-encode.mjs');

const require = createRequire(import.meta.url);
const http = require('node:http');
const https = require('node:https');
http.get = transport.get;
https.get = transport.get;
syncBuiltinESMExports();

const { fetchImageUrl, extractImages } = await import('../src/image.js');
const { log } = await import('../src/config.js');

const ENV = 'WINDSURFAPI_ALLOW_HTTP_IMAGES';
const HTTP_URL = 'http://img.example.test/a.png?signature=secret';
const HTTPS_URL = 'https://img.example.test/a.png';
const HTTP_REDIRECT = 'http://cdn.example.test/b.png?signature=secret';
const PNG = Buffer.from('PNGDATA');
const PNG_HEADERS = { 'content-type': 'image/png' };
// A real 2x2 PNG, so the Cascade control path survives maybeShrinkImage.
const REAL_PNG = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0xff), 2, 2);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const originalEnv = process.env[ENV];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = originalEnv;
  transport.reset();
});

function captureWarns() {
  const warnings = [];
  const original = log.warn;
  log.warn = (...args) => warnings.push(args.join(' '));
  return { warnings, restore: () => { log.warn = original; } };
}

function watch(promise) {
  const state = { value: null, error: null };
  const settled = promise.then(
    (value) => { state.value = value; return 'resolved'; },
    (error) => { state.error = error; return 'rejected'; },
  );
  return { state, settled };
}

describe('HTTP-IMAGE-GATE: fetchImageUrl', () => {
  it('rejects a plaintext http URL by default before opening a connection', async () => {
    const cap = captureWarns();
    try {
      await assert.rejects(fetchImageUrl(HTTP_URL), (err) => {
        assert.match(err.message, /https/i);
        assert.match(err.message, /WINDSURFAPI_ALLOW_HTTP_IMAGES=1/);
        return true;
      });
      assert.equal(transport.hops.length, 0, 'the URL must be rejected before http.get');
      const text = cap.warnings.join('\n');
      assert.match(text, /plaintext http/i);
      assert.match(text, /img\.example\.test/, 'the warn must name the host');
      assert.doesNotMatch(text, /signature=secret|\/a\.png/,
        'the full URL (possible signed query) must never be logged');
    } finally { cap.restore(); }
  });

  it('fetches plaintext http when WINDSURFAPI_ALLOW_HTTP_IMAGES=1', async () => {
    process.env[ENV] = '1';
    const { state, settled } = watch(fetchImageUrl(HTTP_URL));
    assert.equal(transport.hops.length, 1, 'the escape hatch must restore the old behaviour');
    assert.equal(transport.hops[0].url, HTTP_URL);

    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(PNG);
    res.end();
    assert.equal(await settled, 'resolved');
    assert.equal(state.value.base64_data, PNG.toString('base64'));
    assert.equal(state.value.mime_type, 'image/png');
  });

  it('only the exact value 1 opens the gate', async () => {
    for (const value of ['0', 'true', 'yes', '', ' 1']) {
      process.env[ENV] = value;
      await assert.rejects(
        fetchImageUrl(HTTP_URL),
        /WINDSURFAPI_ALLOW_HTTP_IMAGES=1/,
        `value ${JSON.stringify(value)} must not enable plaintext http`,
      );
      assert.equal(transport.hops.length, 0, `value ${JSON.stringify(value)} dialed anyway`);
    }
  });

  it('leaves https alone for default and non-1 values', async () => {
    for (const value of [undefined, '0', 'true', '1']) {
      if (value === undefined) delete process.env[ENV];
      else process.env[ENV] = value;
      transport.reset();

      const { state, settled } = watch(fetchImageUrl(HTTPS_URL));
      const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
      res.chunk(PNG);
      res.end();
      assert.equal(await settled, 'resolved', `https must stay allowed with ${ENV}=${value}`);
      assert.equal(state.value.base64_data, PNG.toString('base64'));
    }
  });

  it('rejects a redirect hop that downgrades https to plaintext http', async () => {
    const cap = captureWarns();
    try {
      const { state, settled } = watch(fetchImageUrl(HTTPS_URL));
      transport.respond(transport.hops[0], { status: 302, location: HTTP_REDIRECT });
      assert.equal(await settled, 'rejected');
      assert.match(state.error.message, /WINDSURFAPI_ALLOW_HTTP_IMAGES=1/);
      assert.equal(transport.hops.length, 1, 'the downgraded hop must never be requested');
      const text = cap.warnings.join('\n');
      assert.match(text, /plaintext http/i);
      assert.match(text, /cdn\.example\.test/);
      assert.doesNotMatch(text, /signature=secret|\/b\.png/);
    } finally { cap.restore(); }
  });

  it('follows a redirect downgrade when the escape hatch is on', async () => {
    process.env[ENV] = '1';
    const { state, settled } = watch(fetchImageUrl(HTTPS_URL));
    transport.respond(transport.hops[0], { status: 302, location: HTTP_REDIRECT });
    await flush();
    assert.equal(transport.hops.length, 2, 'the redirect must be followed');
    assert.equal(transport.hops[1].url, HTTP_REDIRECT);

    const res = transport.respond(transport.hops[1], { status: 200, headers: PNG_HEADERS });
    res.chunk(PNG);
    res.end();
    assert.equal(await settled, 'resolved');
    assert.equal(state.value.base64_data, PNG.toString('base64'));
  });
});

describe('HTTP-IMAGE-GATE: Cascade extractImages', () => {
  it('drops plaintext http image sources, keeps the text, and logs only the host', async () => {
    const cap = captureWarns();
    try {
      const { text, images } = await extractImages([
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'url', url: HTTP_URL } },
        { type: 'image_url', image_url: { url: HTTP_REDIRECT } },
      ]);
      assert.equal(text, 'look at this', 'text blocks are untouched');
      assert.deepEqual(images, [], 'both http image shapes are dropped');
      assert.equal(transport.hops.length, 0, 'neither URL may reach the transport');
      const logged = cap.warnings.join('\n');
      assert.match(logged, /plaintext http/i);
      assert.match(logged, /img\.example\.test/);
      assert.match(logged, /cdn\.example\.test/);
      assert.doesNotMatch(logged, /signature=secret|\/a\.png|\/b\.png/,
        'only hosts are logged, never signed URLs');
    } finally { cap.restore(); }
  });

  it('still fetches an https image (control)', async () => {
    const pending = extractImages([
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: HTTPS_URL } },
    ]);
    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(REAL_PNG);
    res.end();

    const { text, images } = await pending;
    assert.equal(text, 'see');
    assert.equal(images.length, 1);
    assert.equal(images[0].base64_data, REAL_PNG.toString('base64'));
    assert.equal(images[0].mime_type, 'image/png');
  });

  // Schemes are case-insensitive (RFC 3986 §3.1), and `new URL()` normalizes them
  // anyway, so the only thing the case-sensitive `startsWith('https://')` gate did
  // was SKIP the block: the image vanished with no fetch, no warning, and no trace
  // other than the model answering as if no image had been attached. Uppercase
  // HTTPS must fetch; uppercase HTTP must reach validateImageUrl and be rejected by
  // the same https-only gate as lowercase (NOT be skipped silently).
  it('fetches an uppercase-scheme HTTPS image_url instead of skipping the block', async () => {
    const pending = extractImages([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'HTTPS://img.example.test/a.png' } },
    ]);
    assert.equal(transport.hops.length, 1, 'the scheme test must be case-insensitive');
    assert.equal(transport.hops[0].url, HTTPS_URL, 'the dialed URL is the normalized https form');
    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(REAL_PNG);
    res.end();

    const { text, images } = await pending;
    assert.equal(text, 'look');
    assert.equal(images.length, 1, 'an uppercase HTTPS image must reach the model');
  });

  it('rejects an uppercase-scheme HTTP image_url through the plaintext gate', async () => {
    const cap = captureWarns();
    try {
      const { images } = await extractImages([
        { type: 'image_url', image_url: { url: 'HTTP://img.example.test/a.png?signature=secret' } },
      ]);
      assert.deepEqual(images, []);
      assert.equal(transport.hops.length, 0, 'the URL must be rejected before http.get');
      const logged = cap.warnings.join('\n');
      assert.match(logged, /plaintext http/i,
        'uppercase HTTP must hit the https-only rejection, not be silently skipped');
      assert.doesNotMatch(logged, /signature=secret|\/a\.png/);
    } finally { cap.restore(); }
  });

  it('Cascade image sources: uppercase scheme follows the same fetch/reject split', async () => {
    // Same two cases through the `{type:'image', source:{type:'url'}}` shape, which
    // has no scheme gate of its own — the control that the fix does not double-gate.
    const pending = extractImages([
      { type: 'image', source: { type: 'url', url: 'HtTpS://img.example.test/a.png' } },
    ]);
    assert.equal(transport.hops.length, 1);
    const res = transport.respond(transport.hops[0], { status: 200, headers: PNG_HEADERS });
    res.chunk(REAL_PNG);
    res.end();
    assert.equal((await pending).images.length, 1);

    const cap = captureWarns();
    try {
      transport.reset();
      const rejected = await extractImages([
        { type: 'image', source: { type: 'url', url: 'HtTp://img.example.test/a.png' } },
      ]);
      assert.deepEqual(rejected.images, []);
      assert.equal(transport.hops.length, 0);
      assert.match(cap.warnings.join('\n'), /plaintext http/i);
    } finally { cap.restore(); }
  });
});

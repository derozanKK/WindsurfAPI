import test from 'node:test';
import { constants as bufferConstants } from 'node:buffer';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../src/vendor/png.js';
import jpegDecode from '../src/vendor/jpeg-js/decoder.js';
import jpegEncode from '../src/vendor/jpeg-js/encoder.js';

const source = readFileSync(new URL('../src/image.js', import.meta.url), 'utf8');
function shrinkText(text) {
  const first = 'export async function shrinkPixels(';
  const last = '\nconst FORMAT_TO_MIME = {';
  assert.equal(text.split(first).length, 2, 'the shrink function anchor must be unique');
  assert.equal(text.split(last).length, 2, 'the following constant anchor must be unique');
  return text.slice(text.indexOf(first), text.indexOf(last)).trimEnd();
}

// Only imports/export keywords are removed. Production function bodies are intact.
// Unused network/PDF functions are never called by this image-only harness.
function compile(text, overrides = {}) {
  const body = text.replace(/^import[^\n]*\n/gm, '')
    .replace(/^export (?=(?:async )?(?:function|const|let|var|class) )/gm, '');
  const build = new Function('decodePng', 'jpegDecode', 'jpegEncode', 'Buffer', 'bufferConstants', 'process',
    `${body}\nreturn { shrinkPixels, maybeShrinkImage, readImageDimensions, scaleRGBA };`);
  return build(overrides.decodePng ?? decodePng, overrides.jpegDecode ?? jpegDecode,
    overrides.jpegEncode ?? jpegEncode, Buffer, bufferConstants, { env: Object.create(null) });
}

function stubRun({ width = 16, height = 8, payloads, failAt = 0, math = Math, stringLimit = bufferConstants.MAX_STRING_LENGTH }) {
  const stats = { encodes: 0, decodes: 0, conversions: 0, qualities: [], sizes: [] };
  const build = new Function('Buffer', 'readImageDimensions', 'decodePixels', 'scaleRGBA',
    'jpegEncode', 'Math', 'bufferConstants', 'IMAGE_MAX_LONG_SIDE', 'IMAGE_MAX_BYTES',
    'IMAGE_JPEG_QUALITY', 'IMAGE_MAX_DECODE_PIXELS',
    `${shrinkText(source).replace(/^export /, '')}\nreturn shrinkPixels;`);
  const run = build(Buffer, () => ({ width, height }), () => {
    stats.decodes++;
    return { width, height, data: Buffer.alloc(4) };
  }, () => Buffer.alloc(4), (image, quality) => {
    stats.encodes++;
    if (stats.encodes > 2048) throw new Error('test encode watchdog');
    if (stats.encodes === failAt) throw new Error('injected encoder failure');
    stats.qualities.push(quality);
    stats.sizes.push([image.width, image.height]);
    const data = Buffer.from(payloads[Math.min(stats.encodes - 1, payloads.length - 1)]);
    Object.defineProperty(data, 'toString', {
      value(encoding, ...args) {
        if (encoding === 'base64') {
          stats.conversions++;
          if (4 * Math.ceil(this.length / 3) > stringLimit) throw new RangeError('injected native string limit');
        }
        return Buffer.prototype.toString.call(this, encoding, ...args);
      },
    });
    return { data };
  }, math, { MAX_STRING_LENGTH: stringLimit }, 1568, 400000, 85, 40 * 1024 * 1024);
  return { run, stats };
}

// Frozen verbatim from the supplied 014204f function; do not regenerate from current code.
const LEGACY_SHRINK = [
  "export async function shrinkPixels(base64, opts = {}) {",
  "  const maxLongSide = opts.maxLongSide ?? IMAGE_MAX_LONG_SIDE;",
  "  const maxBytes = opts.maxBytes ?? IMAGE_MAX_BYTES;",
  "  const startQuality = opts.quality ?? IMAGE_JPEG_QUALITY;",
  "  const MIN_JPEG_QUALITY = 60; // quality floor before we shrink dimensions further",
  "  // Dimension floor for the byte-convergence loop. The vendored jpeg-js encoder",
  "  // produces larger output than jimp's for incompressible content, so allow the",
  "  // long side to shrink further than jimp needed (128 vs the old 256) to still",
  "  // meet a tight byte budget for near-random images. Real screenshots compress",
  "  // well and rarely reach this floor.",
  "  const MIN_LONG_SIDE = 128;",
  "",
  "  try {",
  "    const buf = Buffer.from(base64, 'base64');",
  "    // Pre-decode budget check: read the header dimensions (cheap, no pixel",
  "    // decode) and bail before allocating anything if the declared pixel count is",
  "    // absurd. This shields the decoders from a crafted decode bomb (tiny bytes,",
  "    // giant IHDR/SOF dimensions) — the vendored png.js also self-guards, but",
  "    // refusing here means we never even attempt the multi-hundred-MB allocation.",
  "    // Returning ok:false makes the caller keep the original image (passthrough).",
  "    const headerDims = readImageDimensions(base64);",
  "    if (headerDims && headerDims.width * headerDims.height > IMAGE_MAX_DECODE_PIXELS) {",
  "      return { ok: false, error: `image ${headerDims.width}x${headerDims.height} exceeds decode pixel budget` };",
  "    }",
  "    const original = decodePixels(buf); // { width, height, data:RGBA }",
  "    const srcW = original.width;",
  "    const srcH = original.height;",
  "    if (!srcW || !srcH) return { ok: false, error: 'decoded image has no dimensions' };",
  "",
  "    let curLong = Math.min(maxLongSide, Math.max(srcW, srcH));",
  "    let outBase64 = '';",
  "    for (;;) {",
  "      // Scale from the full-res original each pass so repeated downscales never",
  "      // compound quality loss.",
  "      let w = srcW, h = srcH, data = original.data;",
  "      if (Math.max(srcW, srcH) > curLong) {",
  "        const scale = curLong / Math.max(srcW, srcH);",
  "        w = Math.max(1, Math.round(srcW * scale));",
  "        h = Math.max(1, Math.round(srcH * scale));",
  "        data = scaleRGBA(original.data, srcW, srcH, w, h);",
  "      }",
  "      let quality = startQuality;",
  "      for (;;) {",
  "        const jpg = jpegEncode({ data, width: w, height: h }, quality);",
  "        outBase64 = jpg.data.toString('base64');",
  "        if (outBase64.length <= maxBytes || quality <= MIN_JPEG_QUALITY) break;",
  "        quality = Math.max(MIN_JPEG_QUALITY, quality - 10);",
  "      }",
  "      if (outBase64.length <= maxBytes || curLong <= MIN_LONG_SIDE) break;",
  "      curLong = Math.max(MIN_LONG_SIDE, Math.round(curLong * 0.8));",
  "    }",
  "    return { ok: true, base64_data: outBase64, mime_type: 'image/jpeg' };",
  "  } catch (e) {",
  "    return { ok: false, error: e?.message || String(e) };",
  "  }",
  "}",
].join('\n');
const legacySource = source.replace(shrinkText(source), LEGACY_SHRINK);

function pngFixture(width, height, noisy = false) {
  const rgba = Buffer.alloc(width * height * 4);
  let seed = 0x13579bdf;
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      rgba[i + c] = noisy ? seed >>> 24 : [180, 60, 20][c];
    }
    rgba[i + 3] = noisy ? (i >>> 2) & 255 : 255;
  }
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const name = Buffer.from(type, 'ascii');
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    name.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([name, data])), out.length - 4);
    return out;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return { base64: bytes.toString('base64'), rgba, width, height };
}

const DEFAULT_LONG_SIDES = [1568, 1254, 1003, 802, 642, 514, 411, 329, 263, 210, 168, 134, 128];
const MAX_DEFAULT_ENCODINGS = 52;

test('IMG-2: the dimension loop has an executable budget, not an open-ended header', () => {
  assert.match(shrinkText(source), /const MAX_DEFAULT_DIMENSION_PASSES = 13;/);
  assert.match(shrinkText(source), /for \(let dimensionPass = 0; dimensionPass < maxDimensionPasses; dimensionPass\+\+\)/);
});

test('IMG-2: a deterministic noisy PNG must visit all 52 candidates at an impossible target', async () => {
  const fixture = pngFixture(1600, 129, true);
  let decodes = 0;
  const calls = [];
  const api = compile(source, {
    decodePng(bytes) { decodes++; return decodePng(bytes); },
    jpegEncode(image, quality) {
      if (calls.length >= 100) throw new Error('test encode watchdog');
      calls.push({ width: image.width, height: image.height, quality, data: image.data });
      return jpegEncode(image, quality);
    },
  });
  const opts = { maxLongSide: 1568, maxBytes: 0, quality: 85 };
  const result = await api.shrinkPixels(fixture.base64, opts);
  assert.equal(result.ok, true);
  assert.equal(decodes, 1, 'header parsing must not be confused with another pixel decode');
  assert.ok(calls.length <= MAX_DEFAULT_ENCODINGS);
  assert.equal(calls.length, MAX_DEFAULT_ENCODINGS, 'the final 128px pass must not be truncated');
  for (let pass = 0; pass < DEFAULT_LONG_SIDES.length; pass++) {
    const group = calls.slice(pass * 4, pass * 4 + 4);
    const width = DEFAULT_LONG_SIDES[pass];
    const height = Math.max(1, Math.round(129 * (width / 1600)));
    assert.deepEqual(group.map(({ quality }) => quality), [85, 75, 65, 60]);
    assert.deepEqual(group.map(({ width: w, height: h }) => [w, h]), Array.from({ length: 4 }, () => [width, height]));
    assert.ok(group.every(call => call.data === group[0].data), 'all qualities at a dimension share RGBA');
    if (pass > 0) assert.notEqual(group[0].data, calls[(pass - 1) * 4].data);
  }
  const oldResult = await compile(legacySource).shrinkPixels(fixture.base64, opts);
  assert.deepEqual(result, oldResult);
  assert.deepEqual(api.readImageDimensions(result.base64_data), { width: 128, height: 10 });
  assert.ok(result.base64_data.length > opts.maxBytes, 'the target remains soft at the floor');
});

test('IMG-2: valid larger and smaller overrides retain every original pass', async () => {
  function schedule(initial) {
    const sides = [initial];
    while (sides.at(-1) > 128) sides.push(Math.max(128, Math.round(sides.at(-1) * 0.8)));
    return sides;
  }
  for (const [maxLongSide, quality] of [[4096, 95], [2048, 100], [134, 85], [128, 60], [64, 50], [1568, 105]]) {
    const { run, stats } = stubRun({ width: 4096, height: 4096, payloads: [Buffer.alloc(8)] });
    const result = await run('', { maxLongSide, quality, maxBytes: 0 });
    const qualities = [quality];
    while (qualities.at(-1) > 60) qualities.push(Math.max(60, qualities.at(-1) - 10));
    const sides = schedule(maxLongSide);
    assert.equal(result.ok, true);
    assert.equal(stats.encodes, sides.length * qualities.length);
    assert.deepEqual(stats.sizes, sides.flatMap(side => qualities.map(() => [side, side])));
    assert.deepEqual(stats.qualities, sides.flatMap(() => qualities));
    assert.equal(stats.decodes, 1);
  }
});

test('IMG-2: the first fit still exits immediately', async () => {
  const { run, stats } = stubRun({ width: 4096, height: 4096, payloads: [Buffer.alloc(3)] });
  assert.equal((await run('', { maxBytes: 4 })).ok, true);
  assert.equal(stats.encodes, 1);
  assert.deepEqual(stats.qualities, [85]);
});

test('IMG-2: non-finite options that previously fit on the first attempt are not rejected', async () => {
  for (const maxLongSide of [Number.NaN, Infinity, -Infinity]) {
    const { run, stats } = stubRun({ payloads: [Buffer.alloc(3)] });
    const result = await run('', { maxLongSide, maxBytes: Infinity });
    assert.equal(result.ok, true);
    assert.equal(stats.encodes, 1);
  }
});

test('IMG-2: fault injection demonstrates that the default dimension budget is active', async () => {
  // This is a broken-transition test, not a claim about a valid input image.
  const math = Object.create(Math);
  math.round = value => value / 0.8;
  const { run, stats } = stubRun({ width: 1568, height: 1568, payloads: [Buffer.alloc(8)], math });
  const result = await run('', { maxBytes: 0 });
  assert.equal(result.ok, true, 'the legacy loop hits the test-only encode watchdog instead');
  assert.equal(stats.encodes, MAX_DEFAULT_ENCODINGS);
});

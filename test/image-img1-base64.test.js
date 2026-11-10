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

test('IMG-1: padded lengths at B-1, B and B+1 select the same candidate with one conversion', async () => {
  for (const n of [4, 5, 6]) {
    const first = Buffer.alloc(n, 0x5a);
    const next = Buffer.from([0x23]);
    const length = first.toString('base64').length;
    for (const maxBytes of [length - 1, length, length + 1]) {
      const { run, stats } = stubRun({ payloads: [first, next] });
      const result = await run('', { maxBytes });
      const fits = maxBytes >= length;
      assert.deepEqual(result, {
        ok: true, base64_data: (fits ? first : next).toString('base64'), mime_type: 'image/jpeg',
      });
      assert.deepEqual(stats.qualities, fits ? [85] : [85, 75]);
      assert.equal(stats.conversions, 1, 'rejected candidates must not allocate base64 strings');
    }
  }
});

test('IMG-1: the floor returns the last candidate, not the smallest candidate', async () => {
  const payloads = [8, 12, 9, 16].map((n, i) => Buffer.alloc(n, 40 + i));
  const { run, stats } = stubRun({ payloads });
  const result = await run('', { maxBytes: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.base64_data, payloads[3].toString('base64'));
  assert.deepEqual(stats.qualities, [85, 75, 65, 60]);
  assert.equal(stats.conversions, 1);
});

test('IMG-1: an encoder failure keeps the error shape and never serializes a rejected candidate', async () => {
  const { run, stats } = stubRun({ payloads: [Buffer.alloc(8)], failAt: 2 });
  assert.deepEqual(await run('', { maxBytes: 0 }), { ok: false, error: 'injected encoder failure' });
  assert.equal(stats.conversions, 0);
});

test('IMG-1: a native string-limit failure must not be bypassed by a later smaller candidate', async () => {
  const { run, stats } = stubRun({ payloads: [Buffer.alloc(8), Buffer.alloc(1)], stringLimit: 4 });
  assert.deepEqual(await run('', { maxBytes: 4 }), { ok: false, error: 'injected native string limit' });
  assert.equal(stats.encodes, 1);
  assert.equal(stats.conversions, 1, 'the native failure happens before another candidate is tried');
});

test('IMG-1: the padded-length identity includes empty output and every residue', () => {
  for (let n = 0; n <= 1024; n++) {
    assert.equal(4 * Math.ceil(n / 3), Buffer.alloc(n).toString('base64').length);
  }
});

test('IMG-1: real PNG and JPEG bytes match the frozen shrink oracle', async () => {
  const fixture = pngFixture(257, 131, true);
  const jpeg = jpegEncode({ data: fixture.rgba, width: 257, height: 131 }, 92).data.toString('base64');
  const before = compile(legacySource);
  const after = compile(source);
  for (const input of [fixture.base64, jpeg]) {
    for (const opts of [
      { maxLongSide: 192, maxBytes: 400000, quality: 85 },
      { maxLongSide: 192, maxBytes: 0, quality: 85 },
      { maxLongSide: 128, maxBytes: 0, quality: 95 },
      { maxLongSide: 192, maxBytes: Number.NaN, quality: 60 },
    ]) {
      const oldResult = await before.shrinkPixels(input, opts);
      const newResult = await after.shrinkPixels(input, opts);
      assert.equal(oldResult.ok, true);
      assert.deepEqual(newResult, oldResult);
      assert.deepEqual(Buffer.from(newResult.base64_data, 'base64'), Buffer.from(oldResult.base64_data, 'base64'));
      assert.deepEqual(after.readImageDimensions(newResult.base64_data), before.readImageDimensions(oldResult.base64_data));
    }
  }
});

test('IMG-1: a real JPEG-derived exact boundary agrees at B-1, B and B+1', async () => {
  const fixture = pngFixture(257, 131, true);
  const before = compile(legacySource);
  const after = compile(source);
  const first = await before.shrinkPixels(fixture.base64, { maxLongSide: 192, maxBytes: Infinity, quality: 85 });
  assert.equal(first.ok, true);
  const boundary = first.base64_data.length;
  for (const maxBytes of [boundary - 1, boundary, boundary + 1]) {
    const opts = { maxLongSide: 192, maxBytes, quality: 85 };
    assert.deepEqual(await after.shrinkPixels(fixture.base64, opts), await before.shrinkPixels(fixture.base64, opts));
  }
});

test('IMG-1: all gate metadata stays unchanged, including original dimensions', async () => {
  const fixture = pngFixture(257, 131, true);
  const before = compile(legacySource);
  const after = compile(source);
  const image = { base64_data: fixture.base64, mime_type: 'image/jpeg' };
  for (const opts of [
    { maxLongSide: 192, maxBytes: 400000, maxBase64Len: Infinity },
    { maxLongSide: 192, maxBytes: 0, maxBase64Len: Infinity },
    { maxLongSide: 192, maxBytes: 0, maxBase64Len: 20 },
    { maxLongSide: 512, maxBytes: 400000, maxBase64Len: Infinity },
  ]) {
    const oldResult = await before.maybeShrinkImage(image, opts);
    const newResult = await after.maybeShrinkImage(image, opts);
    assert.deepEqual(newResult, oldResult);
    assert.deepEqual([newResult.width, newResult.height], [257, 131]);
  }
  const gif = Buffer.alloc(64);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(2000, 6);
  gif.writeUInt16LE(8, 8);
  const inputs = [
    { base64_data: Buffer.from('not an image').toString('base64'), mime_type: 'image/png' },
    { base64_data: gif.toString('base64'), mime_type: 'image/gif' },
    { base64_data: '', mime_type: 'image/png' },
  ];
  for (const input of inputs) {
    for (const maxBase64Len of [Infinity, 16]) {
      assert.deepEqual(await after.maybeShrinkImage(input, { maxBase64Len }),
        await before.maybeShrinkImage(input, { maxBase64Len }));
    }
  }
});

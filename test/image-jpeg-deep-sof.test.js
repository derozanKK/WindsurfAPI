// E3-SOF: a JPEG whose SOF sits beyond the 256 KiB header read must still obey
// the module's own decode pixel budget.
//
// readImageDimensions() reads only the first 256 KiB for JPEG, so the pre-decode
// guard was skipped whenever that read returned null: a byte-oversized JPEG with
// its SOF at offset 262400 reached jpegDecode with a 50 Mpixel frame
// (evidence: .agent/audit-20260922/evidence/protocol-probes/, report §E3).
//
// The real src/image.js runs here with exactly ONE import boundary redirected — the
// vendored JPEG decoder — to test/helpers/jpeg-decode-stub.mjs, which counts the call
// and throws before allocating (see test/helpers/image-codec-seam.mjs, which asserts
// the single redirection and the untouched module body). No large decode is ever
// performed; the fixtures are marker-structure only (SOI, APP2 filler, SOF0, APP2
// filler, SOS, entropy bytes, EOI), exactly the shape the recorded probe used.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadImageWithCodecStub } from './helpers/image-codec-seam.mjs';
import { calls, takeCalls } from './helpers/jpeg-decode-stub.mjs';

const stub = { calls, takeCalls };
const { maybeShrinkImage, shrinkPixels, extractImages, readImageDimensions } = await loadImageWithCodecStub().then((loaded) => loaded.module);

const HEADER_WINDOW = 256 * 1024;
const PIXEL_BUDGET = 40 * 1024 * 1024;
const DECODER_MP = PIXEL_BUDGET / 1_000_000;
const MAX_BASE64_LEN = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 100;

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function appSegment(payloadLen, byte = 0x41) {
  const buf = Buffer.alloc(4 + payloadLen);
  buf[0] = 0xff;
  buf[1] = 0xe2;
  buf.writeUInt16BE(payloadLen + 2, 2);
  buf.fill(byte, 4);
  return buf;
}

function sof0(width, height) {
  const b = Buffer.alloc(19);
  b[0] = 0xff;
  b[1] = 0xc0;
  b.writeUInt16BE(17, 2);
  b[4] = 8;
  b.writeUInt16BE(height, 5);
  b.writeUInt16BE(width, 7);
  b[9] = 3;
  [[1, 0x11, 0], [2, 0x11, 1], [3, 0x11, 1]].forEach(([id, sampling, qt], i) => {
    b[10 + i * 3] = id;
    b[11 + i * 3] = sampling;
    b[12 + i * 3] = qt;
  });
  return b;
}

function sos() {
  const b = Buffer.alloc(14);
  b[0] = 0xff;
  b[1] = 0xda;
  b.writeUInt16BE(12, 2);
  b[4] = 3;
  [[1, 0x00], [2, 0x11], [3, 0x11]].forEach(([id, tables], i) => {
    b[5 + i * 2] = id;
    b[6 + i * 2] = tables;
  });
  b[11] = 0;
  b[12] = 63;
  b[13] = 0;
  return b;
}

function buildJpeg({ width = 1000, height = 500, sofOffset = 512, totalBytes = 5_300_000, includeSof = true } = {}) {
  const parts = [SOI];
  let pos = SOI.length;
  const push = (buf) => {
    parts.push(buf);
    pos += buf.length;
  };
  const fillerTo = (target) => {
    while (pos < target) {
      const room = target - pos;
      push(appSegment(Math.max(1, Math.min(65533, room - 4))));
    }
  };
  if (includeSof) {
    fillerTo(sofOffset);
    push(sof0(width, height));
  }
  const trailer = sos().length + 16 + EOI.length;
  fillerTo(Math.max(pos + 1, totalBytes - trailer));
  push(sos());
  push(Buffer.alloc(16, 0x00));
  push(EOI);
  return Buffer.concat(parts);
}

// Byte-oversized fixtures (base64 above the module's re-encode trigger) are the
// only ones that reach the decoder without an in-window header, which is exactly
// the boundary under test.
const deepOverCap = buildJpeg({ width: 10000, height: 5000, sofOffset: 262400 });
const deepBelowCap = buildJpeg({ width: 1000, height: 500, sofOffset: 262400 });
const noSof = buildJpeg({ includeSof: false, totalBytes: 5_300_000 });

const deepOverCapB64 = deepOverCap.toString('base64');
const deepBelowCapB64 = deepBelowCap.toString('base64');
const noSofB64 = noSof.toString('base64');

describe('E3-SOF: JPEG decode ceiling beyond the header window', () => {
  it('builds fixtures that are byte-oversized and push the SOF past the header window (control)', () => {
    assert.ok(deepOverCap.length > 5_242_880, 'fixture must exceed the byte budget');
    assert.ok(deepOverCapB64.length > MAX_BASE64_LEN, 'fixture must exceed the base64 trigger');
    assert.equal(readImageDimensions(deepOverCapB64, 'jpeg'), null, 'the header read must not see a SOF at 262400');
    assert.equal(HEADER_WINDOW, 262144);
    const shallowB64 = buildJpeg({ width: 10000, height: 5000, sofOffset: 512, totalBytes: 100_000 }).toString('base64');
    assert.deepEqual(readImageDimensions(shallowB64, 'jpeg'), { width: 10000, height: 5000 });
  });

  it('never hands a deep over-cap frame to the decoder', async () => {
    stub.takeCalls();
    const decision = await maybeShrinkImage({ base64_data: deepOverCapB64, mime_type: 'image/jpeg' });
    assert.equal(stub.calls.length, 0, 'the decoder was reached with a 10000x5000 frame whose SOF sits past the header window');
    assert.equal(decision.dropped, true);
    assert.match(decision.reason, /decode pixel budget/, `expected the pixel-budget refusal, got: ${decision.reason}`);
  });

  it('never hands a deep over-cap frame to the decoder when the label lies about the format', async () => {
    stub.takeCalls();
    const decision = await maybeShrinkImage({ base64_data: deepOverCapB64, mime_type: 'image/png' });
    assert.equal(stub.calls.length, 0, 'a mislabeled deep over-cap frame reached the decoder');
    assert.match(decision.reason, /decode pixel budget/);
  });

  it('never hands a deep over-cap frame to the decoder through the extractImages entry point', async () => {
    stub.takeCalls();
    const out = await extractImages([{
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: deepOverCapB64 },
    }]);
    assert.equal(stub.calls.length, 0, 'the default caller path reached the decoder with a 50 Mpixel frame');
    assert.deepEqual(out.images, []);
  });

  it('still reaches the decoder for a deep frame below the ceiling (control)', async () => {
    stub.takeCalls();
    const result = await shrinkPixels(deepBelowCapB64, {});
    assert.equal(stub.calls.length, 1, 'a deep 1000x500 frame must still be offered to the decoder');
    assert.equal(result.ok, false);
    assert.match(result.error, /JPEG_DECODE_STUB/);
  });

  it('still reaches the decoder for a frame exactly at the ceiling (control)', async () => {
    const exact = buildJpeg({ width: 8192, height: 5120, sofOffset: 512, totalBytes: 100_000 }).toString('base64');
    assert.equal(8192 * 5120, PIXEL_BUDGET, 'the exact-cap fixture must sit exactly on the module ceiling');
    stub.takeCalls();
    const result = await shrinkPixels(exact, {});
    assert.equal(stub.calls.length, 1, 'a frame exactly at the ceiling must not be refused');
    assert.equal(result.ok, false);
    assert.match(result.error, /JPEG_DECODE_STUB/, `expected the frame to be offered to the decoder, got: ${result.error}`);
  });

  it('keeps the shallow over-cap refusal on the header path (control)', async () => {
    const shallow = buildJpeg({ width: 10000, height: 5000, sofOffset: 512, totalBytes: 100_000 }).toString('base64');
    stub.takeCalls();
    const decision = await maybeShrinkImage({ base64_data: shallow, mime_type: 'image/jpeg' });
    assert.equal(stub.calls.length, 0, 'a shallow over-cap frame must never reach the decoder');
    assert.equal(decision.resized, false);
    assert.match(decision.reason, /exceeds 1568px/);
  });

  it('captures the tightened decoder option, and the memory guard, when no SOF is found', async () => {
    stub.takeCalls();
    await shrinkPixels(noSofB64, {});
    assert.equal(stub.calls.length, 1, 'a JPEG without an SOF must still reach the decoder');
    const call = stub.calls[0];
    assert.equal(call.maxResolutionInMP, DECODER_MP, 'the past-the-window bypass leaves the decoder ceiling at the old value');
    assert.equal(call.maxMemoryUsageInMB, 512, 'the decoder memory guard must be retained');
    assert.equal(call.useTArray, true);
  });

  it('still applies the full-buffer guard on a direct shrinkPixels call', async () => {
    stub.takeCalls();
    const result = await shrinkPixels(deepOverCapB64, {});
    assert.equal(stub.calls.length, 0, 'shrinkPixels handed a deep over-cap frame to the decoder');
    assert.equal(result.ok, false);
    assert.match(result.error, /decode pixel budget/);
  });

  it('leaves a tiny in-budget JPEG untouched (control)', async () => {
    const tiny = buildJpeg({ width: 16, height: 8, sofOffset: 512, totalBytes: 4_000 }).toString('base64');
    stub.takeCalls();
    const decision = await maybeShrinkImage({ base64_data: tiny, mime_type: 'image/jpeg' });
    assert.equal(stub.calls.length, 0, 'a tiny image must not be decoded');
    assert.equal(decision.dropped, false);
    assert.equal(decision.resized, false);
    assert.equal(decision.base64_data, tiny);
    assert.equal(decision.mime_type, 'image/jpeg');
  });
});

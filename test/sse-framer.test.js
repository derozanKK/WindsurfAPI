import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SseFramer, findFrameEnd, parseSseLine } from '../src/sse-framer.js';
import { createDeferredSseResponse } from '../src/sse-commit.js';

function collect(options = {}) {
  const frames = [];
  const comments = [];
  const framer = new SseFramer({
    ...options,
    onFrame: (f) => frames.push(f),
    onComment: (c) => comments.push(c),
  });
  return { framer, frames, comments };
}

function splitRun(bytes, cut, options = {}) {
  const frames = [];
  let overflow = null;
  const framer = new SseFramer({
    ...options,
    onFrame: (f) => frames.push(f),
    onOverflow: (e) => { overflow = e; },
  });
  framer.push(bytes.subarray(0, cut));
  framer.push(bytes.subarray(cut));
  framer.end();
  return { failed: framer.failed, overflow, frames };
}

describe('SseFramer', () => {
  it('parses canonical LF frames', () => {
    const { framer, frames } = collect();
    framer.push('event: message\ndata: {"a":1}\n\n');
    assert.deepEqual(frames, [{ event: 'message', data: '{"a":1}' }]);
  });

  it('parses CRLF frames', () => {
    const { framer, frames } = collect();
    framer.push('event: message\r\ndata: {"a":1}\r\n\r\n');
    assert.deepEqual(frames, [{ event: 'message', data: '{"a":1}' }]);
  });

  it('joins multi-line data with a newline', () => {
    const { framer, frames } = collect();
    framer.push('data: line1\ndata: line2\n\n');
    assert.deepEqual(frames, [{ event: null, data: 'line1\nline2' }]);
  });

  it('flushes a final frame at EOF without a blank line', () => {
    const { framer, frames } = collect();
    framer.push('data: tail');
    framer.end();
    assert.deepEqual(frames, [{ event: null, data: 'tail' }]);
  });

  it('preserves a multi-byte character split across Buffer chunks', () => {
    const { framer, frames } = collect();
    const bytes = Buffer.from('data: 你\n\n');
    framer.push(bytes.subarray(0, 7));
    framer.push(bytes.subarray(7));
    assert.deepEqual(frames, [{ event: null, data: '你' }]);
  });

  it('surfaces comments separately', () => {
    const { framer, comments } = collect();
    framer.push(': ping\n\n');
    assert.deepEqual(comments, [': ping']);
  });

  it('fails closed at the byte cap', () => {
    let overflow = null;
    const { framer } = collect({ maxFrameBytes: 8, onOverflow: (e) => { overflow = e; } });
    framer.push('data: 1234567890\n\n');
    assert.equal(framer.failed, true);
    assert.equal(overflow.code, 'SSE_FRAME_TOO_LARGE');
  });

  it('does not reject a batch of complete frames just because the push is large', () => {
    let overflow = null;
    const { framer, frames } = collect({ maxFrameBytes: 8, onOverflow: (e) => { overflow = e; } });
    framer.push('data: 1\n\ndata: 2\n\n');
    assert.equal(framer.failed, false);
    assert.equal(overflow, null);
    assert.deepEqual(frames, [{ event: null, data: '1' }, { event: null, data: '2' }]);
  });

  it('applies the cap to the frame payload, not the wire prefix', () => {
    let overflow = null;
    const { framer, frames } = collect({ maxFrameBytes: 10, onOverflow: (e) => { overflow = e; } });
    framer.push('data: 1234567890\n\n');
    assert.equal(framer.failed, false);
    assert.equal(overflow, null);
    assert.deepEqual(frames, [{ event: null, data: '1234567890' }]);
  });

  it('holds a trailing CR when the next chunk starts with LF', () => {
    const { framer, frames } = collect();
    framer.push('event: m\r');
    framer.push('\ndata: a\r\ndata: b\r\n\r\n');
    assert.deepEqual(frames, [{ event: 'm', data: 'a\nb' }]);
  });

  it('does not dispatch after end', () => {
    const { framer, frames } = collect();
    framer.push('data: one\n\n');
    framer.end();
    framer.push('data: two\n\n');
    assert.deepEqual(frames, [{ event: null, data: 'one' }]);
  });

  it('findFrameEnd recognizes LF and CRLF boundaries', () => {
    assert.deepEqual(findFrameEnd('a\n\nb'), { frameEnd: 1, next: 3 });
    assert.deepEqual(findFrameEnd('a\r\n\r\nb'), { frameEnd: 1, next: 5 });
    assert.equal(findFrameEnd('a\nb'), null);
  });

  it('findFrameEnd recognizes mixed line terminators', () => {
    assert.deepEqual(findFrameEnd('a\n\r\nb'), { frameEnd: 1, next: 4 });
    assert.deepEqual(findFrameEnd('a\r\n\rb'), { frameEnd: 1, next: 4 });
    assert.deepEqual(findFrameEnd('a\r\n\nb'), { frameEnd: 1, next: 4 });
    assert.deepEqual(findFrameEnd('a\n\rb'), { frameEnd: 1, next: 3 });
  });

  it('does not treat one lone CRLF as a frame boundary', () => {
    assert.equal(findFrameEnd('data: a\r\n'), null);
    assert.equal(findFrameEnd('data: a\r\nb'), null);
    assert.equal(findFrameEnd('data: a\n'), null);
    assert.equal(findFrameEnd('data: a\r'), null);
  });

  it('keeps a frame exactly at the cap accepted across every byte split', () => {
    const bytes = Buffer.from('data: 1234567890\n\n');
    const whole = splitRun(bytes, 0, { maxFrameBytes: 10 });
    assert.equal(whole.failed, false);
    assert.deepEqual(whole.frames, [{ event: null, data: '1234567890' }]);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
      assert.equal(got.failed, false, `cut ${cut} must not fail`);
      assert.deepEqual(got.frames, whole.frames, `cut ${cut} frames`);
    }
  });

  it('rejects a frame one byte over the cap at every byte split', () => {
    const bytes = Buffer.from('data: 12345678901\n\n');
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
      assert.equal(got.failed, true, `cut ${cut} must fail`);
      assert.deepEqual(got.frames, [], `cut ${cut} must not emit a frame`);
    }
  });

  it('counts the cap in UTF-8 bytes and survives a split inside a multi-byte character', () => {
    const bytes = Buffer.from('data: 你\n\n');
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const exact = splitRun(bytes, cut, { maxFrameBytes: 3 });
      assert.equal(exact.failed, false, `exact cut ${cut}`);
      assert.deepEqual(exact.frames, [{ event: null, data: '你' }], `exact cut ${cut}`);
      const over = splitRun(bytes, cut, { maxFrameBytes: 2 });
      assert.equal(over.failed, true, `over cut ${cut}`);
      assert.deepEqual(over.frames, [], `over cut ${cut}`);
    }
  });

  it('agrees with whole-frame behavior for every partition of a short frame', () => {
    const bytes = Buffer.from('data: 你\n\n');
    const run = (cuts, cap) => {
      const frames = [];
      let overflow = null;
      const framer = new SseFramer({
        maxFrameBytes: cap,
        onFrame: (f) => frames.push(f),
        onOverflow: (e) => { overflow = e.code; },
      });
      let prev = 0;
      for (const cut of cuts) {
        framer.push(bytes.subarray(prev, cut));
        prev = cut;
      }
      framer.push(bytes.subarray(prev));
      framer.end();
      return { failed: framer.failed, overflow, frames };
    };
    for (let mask = 0; mask < (1 << (bytes.length - 1)); mask += 1) {
      const cuts = [];
      for (let i = 1; i < bytes.length; i += 1) {
        if (mask & (1 << (i - 1))) cuts.push(i);
      }
      const exact = run(cuts, 3);
      assert.equal(exact.failed, false, `mask ${mask} exact`);
      assert.deepEqual(exact.frames, [{ event: null, data: '你' }], `mask ${mask} exact frames`);
      const over = run(cuts, 2);
      assert.equal(over.failed, true, `mask ${mask} over`);
      assert.deepEqual(over.frames, [], `mask ${mask} over frames`);
    }
  });

  it('keeps a CRLF frame exactly at the cap accepted across every byte split', () => {
    const bytes = Buffer.from('data: 1234567890\r\n\r\n');
    const whole = splitRun(bytes, 0, { maxFrameBytes: 10 });
    assert.equal(whole.failed, false);
    assert.deepEqual(whole.frames, [{ event: null, data: '1234567890' }]);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
      assert.equal(got.failed, false, `cut ${cut} must not fail`);
      assert.deepEqual(got.frames, whole.frames, `cut ${cut} frames`);
    }
  });

  it('counts event names and joined multi-line data toward the cap', () => {
    const bytes = Buffer.from('event: message\ndata: 12345\ndata: 67890\n\n');
    const whole = splitRun(bytes, 0, { maxFrameBytes: 18 });
    assert.equal(whole.failed, false);
    assert.deepEqual(whole.frames, [{ event: 'message', data: '12345\n67890' }]);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const exact = splitRun(bytes, cut, { maxFrameBytes: 18 });
      assert.equal(exact.failed, false, `exact cut ${cut}`);
      assert.deepEqual(exact.frames, whole.frames, `exact cut ${cut} frames`);
      const over = splitRun(bytes, cut, { maxFrameBytes: 17 });
      assert.equal(over.failed, true, `over cut ${cut}`);
      assert.deepEqual(over.frames, [], `over cut ${cut} must not emit a frame`);
    }
  });

  it('holds an incomplete frame at the cap but fails one byte over it', () => {
    const exact = collect({ maxFrameBytes: 10 });
    exact.framer.push('data: 1234567890');
    assert.equal(exact.framer.failed, false);
    assert.deepEqual(exact.frames, []);
    exact.framer.push('\n\n');
    assert.deepEqual(exact.frames, [{ event: null, data: '1234567890' }]);

    const over = collect({ maxFrameBytes: 10 });
    over.framer.push('data: 12345678901');
    assert.equal(over.framer.failed, true);
    assert.deepEqual(over.frames, []);
  });

  it('bounds an incomplete comment or unrecognized line', () => {
    const comment = collect({ maxFrameBytes: 10 });
    comment.framer.push(': 123456789');
    assert.equal(comment.framer.failed, true);

    const unknown = collect({ maxFrameBytes: 10 });
    unknown.framer.push('x'.repeat(11));
    assert.equal(unknown.framer.failed, true);
  });

  it('preserves a tab after the colon and consumes at most one space', () => {
    const { framer, frames } = collect();
    framer.push('data:\tvalue\n\n');
    framer.push('event:\tmsg\ndata: x\n\n');
    framer.push('data:  value\n\n');
    assert.deepEqual(frames, [
      { event: null, data: '\tvalue' },
      { event: '\tmsg', data: 'x' },
      { event: null, data: ' value' },
    ]);
  });

  it('applies the cap to ignored lines independently of retained payload', () => {
    const cases = [
      ['comment', 'data: 1234567890\n: ok\n\n'],
      ['unknown', 'data: 1234567890\nfoo: bar\n\n'],
      ['id', 'data: 1234567890\nid: a\n\n'],
      ['retry', 'data: 1234567890\nretry: 1\n\n'],
    ];
    for (const [name, input] of cases) {
      const bytes = Buffer.from(input);
      const whole = splitRun(bytes, 0, { maxFrameBytes: 10 });
      assert.equal(whole.failed, false, name);
      assert.deepEqual(whole.frames, [{ event: null, data: '1234567890' }], name);
      for (let cut = 0; cut <= bytes.length; cut += 1) {
        const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
        assert.deepEqual(got, whole, `${name} cut ${cut}`);
      }
    }
  });

  it('rejects an event value over the cap even when a later event replaces it', () => {
    const bytes = Buffer.from('event: abcdefghijk\nevent: x\ndata: y\n\n');
    const whole = splitRun(bytes, 0, { maxFrameBytes: 10 });
    assert.equal(whole.failed, true);
    assert.deepEqual(whole.frames, []);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
      assert.equal(got.failed, true, `cut ${cut} must fail`);
      assert.deepEqual(got.frames, [], `cut ${cut} must not emit a frame`);
    }
  });

  it('keeps an in-progress event replacement within the cap split-invariant', () => {
    const bytes = Buffer.from('event: abcdefgh\nevent: 12345\n\n');
    const whole = splitRun(bytes, 0, { maxFrameBytes: 10 });
    assert.equal(whole.failed, false);
    assert.deepEqual(whole.frames, [{ event: '12345', data: '' }]);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
      assert.deepEqual(got, whole, `cut ${cut}`);
    }
  });

  it('allows a temporary data+event sum over the cap when a later event replaces it', () => {
    const bytes = Buffer.from('data: 12345678\nevent: abc\nevent: x\n\n');
    const whole = splitRun(bytes, 0, { maxFrameBytes: 10 });
    assert.equal(whole.failed, false);
    assert.deepEqual(whole.frames, [{ event: 'x', data: '12345678' }]);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
      assert.deepEqual(got, whole, `cut ${cut}`);
    }
  });

  it('rejects a data+event frame whose final payload exceeds the cap at every split', () => {
    const bytes = Buffer.from('data: 12345678\nevent: abc\n\n');
    const whole = splitRun(bytes, 0, { maxFrameBytes: 10 });
    assert.equal(whole.failed, true);
    assert.deepEqual(whole.frames, []);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
      assert.equal(got.failed, true, `cut ${cut}`);
      assert.deepEqual(got.frames, [], `cut ${cut}`);
    }
  });

  it('parses a colon-less recognized field as an empty value', () => {
    assert.deepEqual(parseSseLine('data'), { field: 'data', value: '' });
    assert.deepEqual(parseSseLine('event'), { field: 'event', value: '' });
    assert.deepEqual(parseSseLine('id'), { field: 'id', value: '' });
    assert.deepEqual(parseSseLine('retry'), { field: 'retry', value: '' });
    assert.equal(parseSseLine('datax'), null);
    assert.equal(parseSseLine('data '), null);

    const { framer, frames } = collect();
    framer.push('data: a\ndata\ndata: b\n\n');
    framer.push('event\ndata: x\n\n');
    assert.deepEqual(frames, [
      { event: null, data: 'a\n\nb' },
      { event: '', data: 'x' },
    ]);
  });

  it('flushes a bare data field at EOF as an empty data frame', () => {
    const { framer, frames } = collect();
    framer.push('data');
    framer.end();
    assert.deepEqual(frames, [{ event: null, data: '' }]);
  });

  it('agrees with whole-frame behavior across the deterministic matrix', () => {
    const cases = [
      ['comment after cap', 'data: 1234567890\n: ok\n\n', 10],
      ['unknown after cap', 'data: 1234567890\nfoo: bar\n\n', 10],
      ['id after cap', 'data: 1234567890\nid: a\n\n', 10],
      ['retry after cap', 'data: 1234567890\nretry: 1\n\n', 10],
      ['event overwrite', 'event: abcdefgh\nevent: 12345\n\n', 10],
      ['event oversize', 'event: abcdefghijk\nevent: x\ndata: y\n\n', 10],
      ['data+event replacement', 'data: 12345678\nevent: abc\nevent: x\n\n', 10],
      ['data+event final over', 'data: 12345678\nevent: abc\n\n', 10],
      ['bare data', 'data: a\ndata\ndata: b\n\n', 10],
      ['bare event', 'event\ndata: x\n\n', 10],
      ['bare data EOF', 'data', 10],
      ['multiline data', 'data: 1\ndata: 2\ndata: 3\n\n', 5],
      ['UTF8', 'data: 你\n\n', 3],
      ['error mixture', ': note\ndata: {"error":{"code":"RATE_LIMITED"}}\n\n', 64],
      ['comment CRLF', 'data: 1234567890\r\n: ok\r\n\r\n', 10],
      ['comment CR', 'data: 1234567890\r: ok\r\r', 10],
      ['bare data CRLF', 'data: a\r\ndata\r\ndata: b\r\n\r\n', 10],
      ['event overwrite CR', 'event: abcdefgh\revent: 12345\r\r', 10],
    ];
    for (const [name, input, cap] of cases) {
      const bytes = Buffer.from(input);
      const whole = splitRun(bytes, 0, { maxFrameBytes: cap });
      for (let cut = 0; cut <= bytes.length; cut += 1) {
        const got = splitRun(bytes, cut, { maxFrameBytes: cap });
        assert.deepEqual(got, whole, `${name} cut ${cut}`);
      }
    }
  });

  it('agrees with every partition of a comment-bearing frame', () => {
    const bytes = Buffer.from('data: 1\n: x\n\n');
    const run = (cuts, cap) => {
      const frames = [];
      let overflow = null;
      const framer = new SseFramer({
        maxFrameBytes: cap,
        onFrame: (f) => frames.push(f),
        onOverflow: (e) => { overflow = e.code; },
      });
      let prev = 0;
      for (const cut of cuts) {
        framer.push(bytes.subarray(prev, cut));
        prev = cut;
      }
      framer.push(bytes.subarray(prev));
      framer.end();
      return { failed: framer.failed, overflow, frames };
    };
    for (let mask = 0; mask < (1 << (bytes.length - 1)); mask += 1) {
      const cuts = [];
      for (let i = 1; i < bytes.length; i += 1) {
        if (mask & (1 << (i - 1))) cuts.push(i);
      }
      const exact = run(cuts, 3);
      assert.equal(exact.failed, false, `mask ${mask} exact`);
      assert.deepEqual(exact.frames, [{ event: null, data: '1' }], `mask ${mask} exact frames`);
      const over = run(cuts, 2);
      assert.equal(over.failed, true, `mask ${mask} over`);
      assert.deepEqual(over.frames, [], `mask ${mask} over frames`);
    }
  });
});

describe('SseFramer leading BOM', () => {
  it('strips a leading UTF-8 BOM so the first frame is not dropped', () => {
    const bytes = Buffer.from('\uFEFF' + 'data: {"a":1}\n\n');
    const expected = [{ event: null, data: '{"a":1}' }];
    assert.deepEqual(splitRun(bytes, 0).frames, expected, 'whole buffer');
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut);
      assert.equal(got.failed, false, `cut ${cut} must not fail`);
      assert.deepEqual(got.frames, expected, `cut ${cut} frames`);
    }
  });

  it('strips the BOM before classifying the first field, not before the frame cap', () => {
    // The BOM is wire decoration, not payload: a frame exactly at the cap is
    // still accepted when the stream starts with a BOM.
    const bytes = Buffer.from('\uFEFF' + 'data: 1234567890\n\n');
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const got = splitRun(bytes, cut, { maxFrameBytes: 10 });
      assert.equal(got.failed, false, `cut ${cut} must not fail`);
      assert.deepEqual(got.frames, [{ event: null, data: '1234567890' }], `cut ${cut}`);
    }
  });

  it('does not strip a BOM that arrives after the stream started', () => {
    const { framer, frames } = collect();
    framer.push('data: a\n\n');
    framer.push('\uFEFFdata: b\n\n');
    assert.deepEqual(frames, [{ event: null, data: 'a' }]);
  });

  it('dispatches a typed ping event as a ping frame', () => {
    const { framer, frames } = collect();
    framer.push('event: ping\ndata: {"type":"ping"}\n\n');
    assert.deepEqual(frames, [{ event: 'ping', data: '{"type":"ping"}' }]);
  });
});

describe('sse-commit + CRLF', () => {
  it('turns a CRLF error frame into a JSON 429', () => {
    const real = {
      statusCode: null, headers: null, body: '', writableEnded: false,
      writeHead(s, h) { this.statusCode = s; this.headers = h; },
      write(c) { this.body += String(c); return true; },
      end(c) { if (c) this.body += String(c); this.writableEnded = true; },
      setHeader() {}, getHeader() {}, removeHeader() {}, on() {}, once() {}, removeListener() {}, destroy() {},
    };
    const res = createDeferredSseResponse(real, { status: 200 });
    res.write('data: {"error":{"message":"busy","code":"RATE_LIMITED","retry_after_ms":2500}}\r\n\r\n');
    res.end();
    assert.equal(real.statusCode, 429);
    assert.equal(real.headers['retry-after'], '30');
  });
});

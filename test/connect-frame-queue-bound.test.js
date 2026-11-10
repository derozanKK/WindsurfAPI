// GFReliability: the DEVIN_CONNECT frame queue is filled by `res.on('data')`
// and drained by the streamChat generator. Nothing bounded it, so a slow
// consumer (a client applying backpressure) let the decoded events accumulate
// in memory for as long as the upstream kept streaming. These tests pin the
// two halves of the fix:
//
//   1. a hard cap: a single burst that crosses it fails the stream with
//      QUEUE_OVERFLOW and drops the buffered events instead of growing;
//   2. backpressure: between the cap and the producer, the socket is paused at
//      the high-water mark and resumed once the consumer drains, so a slow
//      consumer never lets the queue reach the cap;
//   3. below the high-water mark nothing changes (no pause, same events).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamChat, __setRequestImpl } from '../src/devin-connect.js';
import { writeStringField } from '../src/proto.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../src/connect.js';

const TOKEN = 'devin-session-token$queue-test.jwt.sig';

// Field #3 is the decoded content field (see devin-connect-finish-callsite).
function contentEnvelope(text) {
  return wrapEnvelope(writeStringField(3, text), { compress: false });
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.paused = false;
  res.pauseCalls = 0;
  res.resumeCalls = 0;
  res.pause = () => {
    res.paused = true;
    res.pauseCalls += 1;
  };
  res.resume = () => {
    if (!res.paused) return;
    res.paused = false;
    res.resumeCalls += 1;
    res.emit('resume');
  };
  return res;
}

function transport(res, onRequest) {
  return (_opts, cb) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.setTimeout = () => req;
    req.write = () => {};
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      cb(res);
      onRequest(req, res);
    };
    return req;
  };
}

function streamOpts(env) {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'claude-sonnet-4.6',
    token: TOKEN,
    env: { DEVIN_CONNECT_TOKEN: TOKEN, ...(env || {}) },
  };
}

afterEach(() => __setRequestImpl(null));

describe('DEVIN_CONNECT frame queue: bounded by a configurable cap', () => {
  it('fails with QUEUE_OVERFLOW instead of buffering past the frame cap', async () => {
    const res = fakeRes();
    let capturedReq = null;
    __setRequestImpl(transport(res, (req) => {
      capturedReq = req;
      // One chunk carrying 40 decoded frames: pausing the socket cannot help
      // within a single synchronous data event, so the hard cap must fire.
      const frames = [];
      for (let i = 0; i < 40; i++) frames.push(contentEnvelope(`t${i}`));
      res.emit('data', Buffer.concat(frames));
      res.emit('end');
    }));

    const it = streamChat(streamOpts({ DEVIN_CONNECT_MAX_QUEUE_FRAMES: '8' }))[Symbol.asyncIterator]();
    await assert.rejects(it.next(), (err) => {
      assert.equal(err.code, 'QUEUE_OVERFLOW', 'overflow has its own stable code');
      assert.match(err.message, /frame queue exceeded/i, 'the error names the queue and the cap');
      return true;
    }, 'the first read must reject — the buffered events are dropped, not delivered');
    assert.ok(res.pauseCalls >= 1, 'the socket was paused at the high-water mark before overflowing');
    assert.ok(capturedReq, 'request was created');
  });

  it('fails with QUEUE_OVERFLOW when the byte cap is crossed, not just the frame count', async () => {
    const res = fakeRes();
    __setRequestImpl(transport(res, () => {
      // One 600-char content event is charged ~1300 bytes (text×2 + overhead),
      // over the 1000-byte cap — the frame count is nowhere near its own limit.
      res.emit('data', Buffer.concat([
        contentEnvelope('x'.repeat(600)),
        contentEnvelope('y'),
      ]));
      res.emit('end');
    }));

    const it = streamChat(streamOpts({ DEVIN_CONNECT_MAX_QUEUE_BYTES: '1000' }))[Symbol.asyncIterator]();
    await assert.rejects(it.next(), (err) => {
      assert.equal(err.code, 'QUEUE_OVERFLOW', 'the byte cap fails the same way as the frame cap');
      assert.match(err.message, /bytes/i, 'the error names the byte ceiling');
      return true;
    });
  });

  it('applies backpressure when the consumer is slower than the producer', async () => {
    const res = fakeRes();
    const total = 24;
    const cap = 8;
    let emitted = 0;
    let consumed = 0;
    let maxInFlight = 0;

    __setRequestImpl(transport(res, () => {
      let i = 0;
      const pump = () => {
        while (i < total && !res.paused) {
          res.emit('data', contentEnvelope(`t${i++}`));
          emitted = i;
          maxInFlight = Math.max(maxInFlight, emitted - consumed);
        }
        if (i < total) {
          res.once('resume', pump);
          return;
        }
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      };
      setImmediate(pump);
    }));

    const seen = [];
    for await (const ev of streamChat(streamOpts({ DEVIN_CONNECT_MAX_QUEUE_FRAMES: String(cap) }))) {
      if (ev.type !== 'content') continue;
      seen.push(ev.text);
      consumed += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(seen, Array.from({ length: total }, (_, i) => `t${i}`), 'every frame is delivered, in order');
    assert.ok(res.pauseCalls >= 1, 'the socket was paused instead of buffering without bound');
    assert.ok(res.resumeCalls >= 1, 'the socket was resumed after the consumer drained');
    assert.ok(
      maxInFlight <= cap,
      `producer ran ${maxInFlight} frames ahead of the consumer; the cap is ${cap}`,
    );
  });

  it('does not pause or alter the stream when the queue stays under the cap', async () => {
    const res = fakeRes();
    __setRequestImpl(transport(res, () => {
      const frames = [];
      for (let i = 0; i < 20; i++) frames.push(contentEnvelope(`c${i}`));
      res.emit('data', Buffer.concat([...frames, endOfStreamEnvelope()]));
      res.emit('end');
    }));

    const events = [];
    for await (const ev of streamChat(streamOpts())) events.push(ev);

    assert.deepEqual(
      events.filter((e) => e.type === 'content').map((e) => e.text),
      Array.from({ length: 20 }, (_, i) => `c${i}`),
      'default caps leave the event sequence untouched',
    );
    assert.equal(res.pauseCalls, 0, 'no backpressure below the high-water mark');
    assert.equal(res.resumeCalls, 0, 'no resume below the high-water mark');
  });
});

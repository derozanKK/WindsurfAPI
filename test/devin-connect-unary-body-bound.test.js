// Bounded reads for the two unary upstream readers that sit next to the
// streamChat non-200 guard (whose ceiling is covered in test/devin-connect.test.js):
//
//   - postConnectUnary (GetUserJwt) accumulated a whole response body and then
//     discarded it on non-200. A 500 with a 600MiB body was measured holding
//     599.6MiB mid-read on node 24.21 (arrayBuffers, post-gc) before the mint
//     degraded to null — unbounded memory for a body nothing reads.
//   - the catalog unary probe (GetCliModelConfigs / GetUserStatus / AssignModel)
//     did `raw.toString('utf8').slice(0, 200)` — toString BEFORE the slice — so
//     a 500 with a 600MiB body threw ERR_STRING_TOO_LONG inside the 'end'
//     listener. Nothing catches it there: it escaped as an uncaughtException and
//     src/index.js:42-44 exits on that, so one bad response dropped every tenant.
//
// Both now share createBoundedBodyAccumulator with the streamChat branch. As
// with the streamChat ceiling, the value is read at module load: set the env
// BEFORE the first import of the module graph in this process. Nothing in
// test/setup-env.mjs imports product modules (its header explains why), so
// devin-connect.js is still fresh here; if that ever changes, the first case
// below goes red (no marker / no warning) rather than silently measuring the
// 8MiB default.
//
// The assertions compare against the CEILING, never against the input size — an
// uncapped reader also "handles" the input, so input-sized expectations cannot
// tell the two apart. Multi-chunk bodies throughout: a single big chunk would
// not exercise the crossing-chunk slice this ceiling depends on.
process.env.DEVIN_CONNECT_MAX_ERROR_BODY_BYTES = '64';

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const connect = await import('../src/devin-connect.js');
const catalog = await import('../src/devin-connect-catalog.js');
const { log } = await import('../src/config.js');
const { writeStringField } = await import('../src/proto.js');
const { wrapEnvelope } = await import('../src/connect.js');

const CAP = 64; // must match DEVIN_CONNECT_MAX_ERROR_BODY_BYTES above
const MARKER = '\n[... truncated: upstream error body exceeded the cap ...]';

/** Fake https.request: one response whose chunks arrive as separate 'data' events. */
function fakeResponse(statusCode, chunks) {
  return (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      // Deliver asynchronously, the way a real socket does.
      setImmediate(() => {
        cb(res);
        for (const chunk of chunks) res.emit('data', chunk);
        res.emit('end');
        req.emit('close'); // unaryCall clears its 30s guard timer on 'close'
      });
    };
    return req;
  };
}

/** Run `run` with log.warn captured; returns the joined warning lines. */
async function captureWarns(run) {
  const warns = [];
  const original = log.warn;
  log.warn = (...args) => { warns.push(args.join(' ')); };
  try { await run(); } finally { log.warn = original; }
  return warns;
}

afterEach(() => {
  connect.__setRequestImpl(null);
  catalog.__setCatalogRequestImpl(null);
  connect.invalidateUserJwtCache();
});

describe('postConnectUnary bounds the unary response read (GetUserJwt)', () => {
  it('marks the truncation when a multi-chunk body crosses the ceiling', async () => {
    const warns = await captureWarns(async () => {
      connect.__setRequestImpl(fakeResponse(500, [
        Buffer.alloc(40, 0x41), Buffer.alloc(40, 0x42), Buffer.alloc(40, 0x43),
      ]));
      assert.equal(
        await connect.mintUserJwt('devin-session-token$cap-over'),
        null,
        'a non-200 mint still degrades to null',
      );
    });
    const capWarns = warns.filter((w) => w.includes(`exceeded ${CAP} bytes`));
    assert.equal(capWarns.length, 1, `exactly one truncation warning per response; got ${capWarns.length}`);
    assert.match(capWarns[0], /truncated/, 'the warning must name the truncation');
  });

  it('warns only once even when chunks keep arriving past the ceiling', async () => {
    const warns = await captureWarns(async () => {
      connect.__setRequestImpl(fakeResponse(500, [
        Buffer.alloc(40), Buffer.alloc(40), Buffer.alloc(40), Buffer.alloc(40), Buffer.alloc(40),
      ]));
      await connect.mintUserJwt('devin-session-token$cap-many');
    });
    assert.equal(warns.filter((w) => w.includes(`exceeded ${CAP} bytes`)).length, 1);
  });

  it('does not truncate a body exactly at the ceiling (boundary)', async () => {
    const warns = await captureWarns(async () => {
      connect.__setRequestImpl(fakeResponse(500, [Buffer.alloc(32), Buffer.alloc(32)]));
      await connect.mintUserJwt('devin-session-token$cap-exact');
    });
    assert.equal(
      warns.filter((w) => w.includes(`exceeded ${CAP} bytes`)).length, 0,
      `a body of exactly ${CAP} bytes must not be marked truncated`,
    );
  });

  it('truncates a body one byte over the ceiling (boundary)', async () => {
    const warns = await captureWarns(async () => {
      connect.__setRequestImpl(fakeResponse(500, [Buffer.alloc(32), Buffer.alloc(33)]));
      await connect.mintUserJwt('devin-session-token$cap-plus1');
    });
    assert.equal(
      warns.filter((w) => w.includes(`exceeded ${CAP} bytes`)).length, 1,
      `a body of ${CAP + 1} bytes must be marked truncated`,
    );
  });

  it('does not parse a truncated 200 frame as a credential', async () => {
    // A complete, valid frame (field #1 = the JWT) followed by filler so the
    // total crosses the ceiling. Uncapped, the frame parses and the filler is
    // never looked at, so the mint would return the credential from a response
    // that is not the whole response.
    const framed = wrapEnvelope(writeStringField(1, 'jwt-value'), { compress: false });
    const warns = await captureWarns(async () => {
      connect.__setRequestImpl(fakeResponse(200, [
        Buffer.concat([framed, Buffer.alloc(20, 0x46)]),
        Buffer.alloc(40, 0x46),
      ]));
      assert.equal(
        await connect.mintUserJwt('devin-session-token$cap-200'),
        null,
        'a truncated frame must not be parsed as a credential',
      );
    });
    assert.equal(
      warns.filter((w) => w.includes(`exceeded ${CAP} bytes`)).length, 1,
      'the discarded oversized 200 must be visible in the log',
    );
  });
});

describe('catalog unary probe bounds the body and slices before stringifying', () => {
  it('keeps exactly the ceiling-sized prefix and marks the truncation', async () => {
    catalog.__setCatalogRequestImpl(fakeResponse(500, [
      Buffer.alloc(30, 0x41), Buffer.alloc(30, 0x42), Buffer.alloc(30, 0x43),
    ]));
    const err = await catalog.fetchUserStatus({ token: 'devin-session-token$cat-over' })
      .then(() => null, (e) => e);
    assert.ok(err, 'an oversized non-200 must still reject with a classified error');
    assert.ok(
      err.message.endsWith(MARKER),
      'the clipped body must be marked, not silently described as a shorter error',
    );
    const payload = err.message.slice(0, -MARKER.length).split('HTTP 500: ').pop();
    assert.equal(
      payload.length, CAP,
      `the kept body must be the ceiling (${CAP}), not the 200-byte classification window`,
    );
    assert.equal(
      payload, 'A'.repeat(30) + 'B'.repeat(30) + 'C'.repeat(4),
      'the crossing chunk must be sliced at the ceiling, not dropped whole',
    );
  });

  it('leaves a body at exactly the ceiling whole and unmarked (boundary)', async () => {
    catalog.__setCatalogRequestImpl(fakeResponse(500, [
      Buffer.alloc(32, 0x44), Buffer.alloc(32, 0x45),
    ]));
    const err = await catalog.fetchUserStatus({ token: 'devin-session-token$cat-exact' })
      .then(() => null, (e) => e);
    assert.ok(err.message.endsWith('D'.repeat(32) + 'E'.repeat(32)),
      'a body of exactly the ceiling must pass through whole');
    assert.doesNotMatch(err.message, /truncated/);
  });

  it('leaves a short body whole and unmarked', async () => {
    catalog.__setCatalogRequestImpl(fakeResponse(429, [Buffer.from('too many requests')]));
    const err = await catalog.fetchUserStatus({ token: 'devin-session-token$cat-short' })
      .then(() => null, (e) => e);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.match(err.message, /too many requests/);
    assert.doesNotMatch(err.message, /truncated/, 'a body that fit must not be marked truncated');
  });

  it('rejects an oversized 200 body instead of decoding a prefix as the message', async () => {
    // Valid protobuf (field #99 is ignored by decodeUserStatusFull), so an
    // uncapped reader resolves normally and only the truncation guard rejects.
    const body = writeStringField(99, 'x'.repeat(80));
    catalog.__setCatalogRequestImpl(fakeResponse(200, [
      body.subarray(0, 40), body.subarray(40),
    ]));
    await assert.rejects(
      catalog.fetchUserStatus({ token: 'devin-session-token$cat-200' }),
      (e) => e.code === 'UPSTREAM_ERROR' && e.message.includes(`exceeded ${CAP} bytes`),
      'a truncated single-message response must fail, not decode its prefix',
    );
  });
});

// Replay of the AccountMatrix §7.1 upstream rejection through the REAL
// production path — no handler seam, no classifier stub:
//
//   handleChatCompletions -> toChatCompletion -> chatWithRetry -> streamChat
//     -> StreamingFrameParser -> classifyUpstreamError -> connectErrorToHttp
//
// The upstream bytes are the captured 106-byte end-of-stream trailer verbatim
// (sha256 f8f40e32…4845268a, evidence/AccountMatrix.md §7.1): an image request
// to a model whose /v1/models row OMITS supports_images. The only fake is the
// socket (`__setRequestImpl`), so the classification and the HTTP surface are
// the production ones.
//
// Run in the tree under test:
//   node --import ./test/setup-env.mjs evidence/UpstreamErrorMapping-probe.mjs
//
// Prints one JSON object; `image_rejection` is the §7.1 case and the two
// `transient_*` cases are the control that must stay 503.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

// Captured frame, verbatim (evidence/AccountMatrix.md §7.1).
const FRAME_HEX = '03000000651f8b08000000000000ff004c00b3ff7b226572726f72223a7b22636f6465223a22696e76616c69645f617267756d656e74222c226d657373616765223a22616e20696e7465726e616c206572726f72206f63637572726564227d7d0300aee1cf014c000000';
const frame = Buffer.from(FRAME_HEX, 'hex');
const frameSha = createHash('sha256').update(frame).digest('hex');

// 1x1 transparent PNG — the same shape the matrix probe sent (a user image).
const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

process.env.DEVIN_CONNECT = '1';
process.env.DEVIN_CONNECT_TOKEN = 'devin-session-token$probe.only';
delete process.env.WINDSURF_API_KEY;
delete process.env.WINDSURFAPI_STRICT_MODEL;

const { __setRequestImpl, classifyUpstreamError } = await import('../src/devin-connect.js');
const { setLiveCatalogSelectors, clearLiveCatalogSelectors } = await import('../src/devin-connect-models.js');
const { handleChatCompletions, connectErrorToHttp } = await import('../src/handlers/chat.js');

let hits = 0;
/** Fake connect socket: replays `frames` after `status`. */
function transport(status, frames) {
  return (_opts, cb) => {
    hits++;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = status;
      setImmediate(() => {
        for (const chunk of frames) res.emit('data', chunk);
        res.emit('end');
      });
      cb(res);
    };
    return req;
  };
}

const imageMessages = [{
  role: 'user',
  content: [{ type: 'text', text: 'one word: the dominant color' }, { type: 'image_url', image_url: { url: DATA_URL } }],
}];
const textMessages = [{ role: 'user', content: 'hi' }];

async function run(label, { status = 200, frames, messages = textMessages }) {
  hits = 0;
  __setRequestImpl(transport(status, frames));
  const result = await handleChatCompletions(
    { model: 'swe-2-medium', stream: false, messages },
    { callerKey: '' },
  );
  return {
    label,
    upstream_hits: hits,
    status: result.status,
    type: result.body?.error?.type ?? null,
    code: result.body?.error?.code ?? null,
    message: result.body?.error?.message ?? null,
  };
}

const out = {
  frame: { bytes: frame.length, sha256: frameSha },
  classifier: (() => {
    const c = classifyUpstreamError('an internal error occurred', 'invalid_argument', null);
    return { code: c.code, message: c.message, http: connectErrorToHttp(c.code) };
  })(),
  image_rejection: null,
  transient_capacity: null,
  transient_internal: null,
};

try {
  // The §7.1 model row has NO supports_images bit — unknown, not false.
  setLiveCatalogSelectors([{ selector: 'swe-2-medium', provider: 'probe' }]);

  out.image_rejection = await run('image -> unknown-capability model', {
    frames: [frame],
    messages: imageMessages,
  });

  // Control 1: a genuine transient capacity blip delivered as HTTP 503.
  out.transient_capacity = await run('transient 503 capacity', {
    status: 503,
    frames: [Buffer.from(JSON.stringify({ error: { code: 'unavailable', message: "We're currently facing high demand for this model. Please try again later." } }), 'utf8')],
  });

  // Control 2: the transient backend fault with no gRPC code, as a 500.
  out.transient_internal = await run('transient 500 internal error', {
    status: 500,
    frames: [Buffer.from('an internal error occurred (trace ID: 3b8f1d2c)', 'utf8')],
  });
} finally {
  clearLiveCatalogSelectors();
  __setRequestImpl(null);
}

console.log(JSON.stringify(out, null, 2));

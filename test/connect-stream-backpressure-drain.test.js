// V-08 (KH-001) — the Connect stream and both translated surfaces discarded
// `res.write()`'s verdict.
//
// MEASURED on the audited baseline: the connect handler wrote every frame into a
// writable that had already returned false, and `createCaptureRes.write()` returned
// a constant `true` no matter what the real socket said — so even the Cascade
// bounded drain could never arm behind a translator. A slow reader therefore bought
// unbounded upstream production (more Connect frames, more poll turns, more memory)
// with no backpressure at all.
//
// Two levels of proof, both required:
//   * the WRITER contract, driven through the real handler with a writable whose
//     `write()` verdicts and `drain` event the test owns; and
//   * the PRODUCER contract, driven through the REAL `streamChatCompletion` adapter
//     (`__setStreamChatForTest` fakes only the upstream transport, so the awaiting
//     code under test is the shipped one — an injected producer that merely happens
//     to await proves nothing).
//
// The Responses case drives the whole chain (chat handler -> captureRes ->
// translator -> socket), because the defect was exactly the seam between them.

process.env.DEVIN_CONNECT = '1';
process.env.STICKY_SESSION_ENABLED = '0';
process.env.DEVIN_CONNECT_SESSION_REUSE = '0';
process.env.RESPONSE_CACHE_ENABLED = '0';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { handleChatCompletions, __resetConnectDeps } = await import('../src/handlers/chat.js');
const { handleResponses } = await import('../src/handlers/responses.js');
const { handleMessages } = await import('../src/handlers/messages.js');
const { handleGemini } = await import('../src/handlers/gemini.js');
const { __setStreamChatForTest } = await import('../src/devin-connect-openai.js');
const { resetResponseStore } = await import('../src/response-store.js');
const auth = await import('../src/auth.js');

const MODEL = 'swe-1-6-slow';
const CALLER = 'session:v08-backpressure';
const created = [];

function seedAccount(label) {
  const a = auth.addAccountByKey(
    `devin-session-token$v08-${label}-${Math.random().toString(36).slice(2)}`, label,
  );
  created.push(a.id);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

/**
 * A writable the test fully controls: it records every frame, reports `false` at
 * one chosen write, and exposes the live drain-listener count so a leaked or
 * duplicated waiter is visible.
 */
function controlledRes({ falseAt = 0, autoDrain = false } = {}) {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headersSent = false;
  res.writableEnded = false;
  res.writes = [];
  res.falseSignals = 0;
  res.drainListenerPeak = 0;
  const origOn = res.on.bind(res);
  res.on = (event, handler) => {
    const out = origOn(event, handler);
    if (event === 'drain') res.drainListenerPeak = Math.max(res.drainListenerPeak, res.listenerCount('drain'));
    return out;
  };
  res.setHeader = () => res;
  res.writeHead = () => res;
  res.flushHeaders = () => {};
  res.write = (chunk) => {
    res.writes.push(String(chunk));
    const verdict = res.writes.length !== falseAt;
    if (!verdict) {
      res.falseSignals += 1;
      // `autoDrain` models a reader that IS slow but alive: the bytes are taken
      // on the next turn of the loop. Tests that need the stream to park omit it.
      if (autoDrain) setImmediate(() => res.emit('drain'));
    }
    return verdict;
  };
  res.end = (chunk) => { if (chunk) res.write(chunk); res.writableEnded = true; return res; };
  return res;
}

const pump = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function sseChunks(res) {
  return res.writes
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) return null;
      try { return JSON.parse(line.slice(6)); } catch { return null; }
    })
    .filter(Boolean);
}

function streamBody() {
  return { model: MODEL, stream: true, messages: [{ role: 'user', content: 'stream this' }] };
}

/** The upstream transport: two content deltas then a clean terminal. */
function scriptedUpstream(events = [
  { type: 'content', text: 'ALPHA' },
  { type: 'content', text: 'BETA' },
  { type: 'finish', reason: 'stop' },
], onPull = null) {
  __setStreamChatForTest(async function* () {
    for (const ev of events) {
      // A generator is pulled one event at a time, and the shipped adapter
      // awaits `send` before pulling the next — so this counter is a direct
      // observation of how far the producer got.
      onPull?.(ev);
      yield ev;
    }
  });
}

/** Anthropic SSE frames, in wire order. */
function anthropicEvents(res) {
  return res.writes
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const event = (lines.find((l) => l.startsWith('event: ')) || '').slice(7);
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!event || !dataLine) return null;
      try { return { event, data: JSON.parse(dataLine.slice(6)) }; } catch { return null; }
    })
    .filter(Boolean);
}

/** Gemini's streamed JSON-array body (the default wire format). */
function geminiFrames(res) {
  return JSON.parse(res.writes.join(''));
}

function geminiText(res) {
  return geminiFrames(res)
    .flatMap((f) => f.candidates || [])
    .flatMap((c) => c.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
}

/** Resolve `promise` or fail if it is still parked after `ms`. */
async function withDeadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  __resetConnectDeps();
  resetResponseStore();
});

afterEach(() => {
  __setStreamChatForTest(null);
  __resetConnectDeps();
  delete process.env.WINDSURFAPI_MAX_DRAIN_MS;
  while (created.length) {
    try { auth.removeAccount(created.pop()); } catch {}
  }
});

describe('V-08: the Connect stream holds its producer on a false write', () => {
  it('write()=false on a content frame pauses upstream production until drain and no frame is duplicated', async () => {
    seedAccount('pause');
    scriptedUpstream();
    const result = await handleChatCompletions(streamBody(), { callerKey: CALLER });
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    // Frame 3 is the second content delta (1 role prime, 2 ALPHA, 3 BETA).
    const res = controlledRes({ falseAt: 3 });
    let settled = false;
    const running = result.handler(res).then(() => { settled = true; });

    await pump();
    assert.equal(res.falseSignals, 1, 'the controlled socket must have reported backpressure exactly once');
    assert.equal(res.writes.length, 3, `production must stop at the false frame, got ${JSON.stringify(res.writes)}`);
    assert.equal(settled, false, 'the handler must still be parked behind the drain');

    // Several more turns of the loop must add nothing: the wait is one, not a queue.
    await pump(8);
    assert.equal(res.writes.length, 3, 'no frame may be produced while the socket has not drained');
    assert.ok(res.drainListenerPeak <= 1, `at most one drain waiter, saw ${res.drainListenerPeak}`);

    res.emit('drain');
    await running;

    const chunks = sseChunks(res);
    const content = chunks
      .flatMap((c) => c.choices || [])
      .map((c) => c.delta?.content || '')
      .join('');
    assert.equal(content, 'ALPHABETA', `content must be delivered once and in order, got ${JSON.stringify(content)}`);
    assert.equal(res.writes.join('').split('BETA').length - 1, 1, 'the false frame is never resent');
    assert.equal(chunks.at(-1).choices?.[0]?.finish_reason, 'stop', 'the terminal frame still arrives last');
    assert.ok(res.writes.join('').endsWith('data: [DONE]\n\n'), 'the sentinel follows the terminal frame');
  });

  it('the terminal frame and [DONE] wait behind a pressured content frame', async () => {
    seedAccount('terminal');
    scriptedUpstream();
    const result = await handleChatCompletions(streamBody(), { callerKey: CALLER });
    const res = controlledRes({ falseAt: 2 }); // the ALPHA delta
    const running = result.handler(res);

    await pump();
    assert.equal(res.writes.length, 2, 'the finish frame must not overtake the pressured content frame');
    res.emit('drain');
    await running;

    const kinds = res.writes.map((w) => (w === 'data: [DONE]\n\n' ? 'DONE' : 'frame'));
    assert.equal(kinds.at(-1), 'DONE');
    assert.equal(res.writes.length, 5, `role + 2 content + finish + DONE, got ${JSON.stringify(res.writes)}`);
  });

  it('a half-open client is bounded: the drain timeout ends the stream instead of pinning it', async () => {
    process.env.WINDSURFAPI_MAX_DRAIN_MS = '25';
    seedAccount('timeout');
    scriptedUpstream();
    const result = await handleChatCompletions(streamBody(), { callerKey: CALLER });
    const res = controlledRes({ falseAt: 2 });

    // No drain is ever emitted — the client stopped reading but kept the socket.
    await result.handler(res);

    const errors = sseChunks(res).filter((c) => c.error);
    assert.equal(errors.length, 1, 'the timeout must surface one typed error frame');
    assert.equal(errors[0].error.code, 'DRAIN_TIMEOUT');
    assert.equal(res.writes.join('').split('ALPHA').length - 1, 1, 'the pressured frame is still written exactly once');
  });

  it('control: a reader that never reports backpressure gets the whole turn byte-identically', async () => {
    seedAccount('control');
    scriptedUpstream();
    const result = await handleChatCompletions(streamBody(), { callerKey: CALLER });
    const res = controlledRes(); // never returns false
    await result.handler(res);

    assert.equal(res.falseSignals, 0);
    assert.equal(res.drainListenerPeak, 0, 'no waiter is created when the socket never pressures');
    const content = sseChunks(res)
      .flatMap((c) => c.choices || [])
      .map((c) => c.delta?.content || '')
      .join('');
    assert.equal(content, 'ALPHABETA');
    assert.ok(res.writes.join('').endsWith('data: [DONE]\n\n'));
  });
});

describe('V-08: the Responses translator reports the real socket verdict', () => {
  it('a false write inside the translator stops the Chat producer until the real socket drains', async () => {
    seedAccount('responses');
    scriptedUpstream();
    const result = await handleResponses(
      { model: MODEL, stream: true, input: 'stream this' },
      { context: { callerKey: 'api:v08:user:t' } },
    );
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    // Frame 3 is `response.output_item.added` — early, so the rest of the turn is
    // still unproduced when the socket reports backpressure.
    const res = controlledRes({ falseAt: 3 });
    let settled = false;
    const running = result.handler(res).then(() => { settled = true; });

    await pump();
    assert.equal(res.falseSignals, 1, 'the translator must report the real socket verdict through captureRes');
    // The false verdict is reported mid-feed: the remaining events of THAT chat
    // chunk are already produced and are written (they are bounded by one chunk,
    // not by the upstream turn). What must stop is the NEXT chunk.
    const stalled = res.writes.length;
    assert.ok(stalled < 6, `the whole turn must not fit in ${stalled} events`);
    assert.equal(settled, false, 'the Responses handler must still be parked');

    await pump(8);
    assert.equal(res.writes.length, stalled, 'no further Responses event may be produced while the socket is pressured');

    res.emit('drain');
    await running;

    const body = res.writes.join('');
    assert.equal(body.split('"type":"response.output_text.delta"').length - 1, 2, 'both deltas arrive exactly once');
    assert.equal(body.split('"type":"response.completed"').length - 1, 1, 'exactly one terminal event');
    assert.ok(body.endsWith('data: [DONE]\n\n'), 'the sentinel is last');
  });

  it('the Responses [DONE] does not overtake a pressured terminal event', async () => {
    seedAccount('responses-done');
    scriptedUpstream();
    // Count the frames first so the false lands on the LAST event before [DONE].
    const probeResult = await handleResponses(
      { model: MODEL, stream: true, input: 'stream this' },
      { context: { callerKey: 'api:v08:user:t2' } },
    );
    const probe = controlledRes();
    await probeResult.handler(probe);
    const total = probe.writes.length;
    assert.ok(total > 3);

    const result = await handleResponses(
      { model: MODEL, stream: true, input: 'stream this' },
      { context: { callerKey: 'api:v08:user:t3' } },
    );
    const res = controlledRes({ falseAt: total - 1, autoDrain: true });
    await result.handler(res);
    const body = res.writes.join('');
    assert.equal(res.falseSignals, 1, 'the terminal event must have reported backpressure');
    assert.ok(body.endsWith('data: [DONE]\n\n'), 'the sentinel still ends the stream');
    assert.equal(body.split('data: [DONE]').length - 1, 1, 'the sentinel is written once, after the drain');
  });
});

// ── D8: the two capture-response translators ─────────────────────────────────
//
// One layer deeper than the Connect and Responses exits: the Anthropic and Gemini
// translators wrote to the REAL socket and dropped its verdict, and their
// `createCaptureRes` returned a constant `true` and never forwarded 'drain'. So
// chat.js's bounded writer never armed behind either translator — a slow reader
// bought unbounded upstream production on /v1/messages and Gemini
// :streamGenerateContent. Returning the verdict WITHOUT the drain forward is the
// invalid half-fix: the producer would park for the full WINDSURFAPI_MAX_DRAIN_MS
// on a signal that never arrives.
//
// The producer here is the real `streamChatCompletion` adapter (only the upstream
// transport is scripted), and the generator pull log is a direct observation of
// how far it got.

const messagesBody = () => ({
  model: MODEL,
  stream: true,
  messages: [{ role: 'user', content: 'stream this' }],
});

const geminiBody = () => ({
  contents: [{ role: 'user', parts: [{ text: 'stream this' }] }],
});

describe('D8: the Messages translator reports the real socket verdict', () => {
  it('a false write pauses the producer until the real socket drains, with no duplicated frame', async (t) => {
    seedAccount('messages-drain');
    const pulled = [];
    scriptedUpstream(undefined, (ev) => pulled.push(ev));
    const result = await handleMessages(messagesBody(), { callerKey: CALLER });
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    // message_start(1) + typed ping(2) + content_block_start(3) + the ALPHA
    // delta(4).
    const res = controlledRes({ falseAt: 4 });
    let settled = false;
    const running = result.handler(res).then(() => { settled = true; });
    // A failing assertion must not leave the turn parked for the 120s default.
    t.after(async () => {
      res.emit('drain');
      await withDeadline(running, 2000, 'the Messages handler cleanup').catch(() => {});
    });

    await pump();
    assert.equal(res.falseSignals, 1, 'the translator must report the real socket verdict through captureRes');
    assert.equal(res.writes.length, 4, `production must stop at the false frame, got ${JSON.stringify(res.writes)}`);
    assert.equal(settled, false, 'the Messages handler must still be parked behind the drain');
    assert.deepEqual(pulled.map((e) => e.type), ['content', 'content'],
      'the producer stopped before the terminal event was pulled');

    // Several more turns of the loop must add nothing: the wait is one, not a queue.
    await pump(8);
    assert.equal(res.writes.length, 4, 'no translated frame may be produced while the socket has not drained');
    assert.ok(res.drainListenerPeak <= 2,
      `one persistent forward + at most one waiter, saw ${res.drainListenerPeak}`);

    res.emit('drain');
    await withDeadline(running, 2000, 'the Messages handler after drain');

    const events = anthropicEvents(res);
    const deltas = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta?.text || '');
    assert.deepEqual(deltas, ['ALPHA', 'BETA'], 'each delta arrives exactly once and in order');
    assert.equal(events.filter((e) => e.event === 'message_stop').length, 1, 'exactly one message_stop');
    assert.equal(events.at(-1).event, 'message_stop', 'the terminal event still arrives last');
    assert.equal(pulled.length, 3, 'the producer resumed and consumed the whole script');
  });

  it('a client close while parked settles the wait without another byte or a parked handler', async (t) => {
    seedAccount('messages-close');
    const pulled = [];
    scriptedUpstream(undefined, (ev) => pulled.push(ev));
    const result = await handleMessages(messagesBody(), { callerKey: CALLER });
    const res = controlledRes({ falseAt: 4 });
    const running = result.handler(res);
    t.after(async () => { res.emit('close'); await running.catch(() => {}); });

    await pump();
    assert.equal(res.writes.length, 4);
    assert.equal(pulled.length, 2);

    // The client vanishes while the producer is held; no 'drain' will ever arrive.
    res.emit('close');
    await withDeadline(running, 2000, 'the Messages handler after close');

    assert.equal(res.writes.length, 4, 'no frame is written after the client is gone');
    assert.equal(pulled.length, 2, 'the producer was not driven past the held callback');
    assert.ok(!anthropicEvents(res).some((e) => e.event === 'message_stop'),
      'a turn whose client vanished never earns a clean terminal event');
  });

  it('control: a fast reader gets the whole translated turn and arms no waiter', async () => {
    seedAccount('messages-control');
    scriptedUpstream();
    const result = await handleMessages(messagesBody(), { callerKey: CALLER });
    const res = controlledRes(); // never returns false
    await result.handler(res);

    assert.equal(res.falseSignals, 0);
    assert.ok(res.drainListenerPeak <= 1, 'no drain waiter beyond the (fix-only) real-socket forward');
    assert.ok(res.listenerCount('drain') <= 1, 'no waiter is left attached');
    const events = anthropicEvents(res);
    const deltas = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta?.text || '');
    assert.deepEqual(deltas, ['ALPHA', 'BETA']);
    assert.equal(events.at(-1).event, 'message_stop');
  });
});

describe('D8: the Gemini translator reports the real socket verdict', () => {
  it('a false write pauses the producer until the real socket drains, and the body still parses', async (t) => {
    seedAccount('gemini-drain');
    const pulled = [];
    scriptedUpstream(undefined, (ev) => pulled.push(ev));
    const result = await handleGemini(MODEL, geminiBody(), { callerKey: CALLER }, { stream: true, alt: null });
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);

    // Frame 1 is the opening `[{...ALPHA...}` of the streamed JSON array.
    const res = controlledRes({ falseAt: 1 });
    let settled = false;
    const running = result.handler(res).then(() => { settled = true; });
    t.after(async () => {
      res.emit('drain');
      await withDeadline(running, 2000, 'the Gemini handler cleanup').catch(() => {});
    });

    await pump();
    assert.equal(res.falseSignals, 1, 'the translator must report the real socket verdict through captureRes');
    assert.equal(res.writes.length, 1, `production must stop at the false frame, got ${JSON.stringify(res.writes)}`);
    assert.equal(settled, false, 'the Gemini handler must still be parked behind the drain');
    assert.deepEqual(pulled.map((e) => e.type), ['content', 'content'],
      'the producer stopped before the terminal event was pulled');

    await pump(8);
    assert.equal(res.writes.length, 1, 'no translated frame may be produced while the socket has not drained');
    assert.ok(res.drainListenerPeak <= 2,
      `one persistent forward + at most one waiter, saw ${res.drainListenerPeak}`);

    res.emit('drain');
    await withDeadline(running, 2000, 'the Gemini handler after drain');

    const frames = geminiFrames(res);
    assert.equal(geminiText(res), 'ALPHABETA', 'each delta arrives exactly once and in order');
    assert.equal(frames.filter((f) => f.candidates?.[0]?.finishReason).length, 1, 'exactly one terminal frame');
    assert.equal(frames.at(-1).candidates?.[0]?.finishReason, 'STOP');
    assert.equal(pulled.length, 3, 'the producer resumed and consumed the whole script');
  });

  it('a client close while parked settles the wait without another byte or a parked handler', async () => {
    seedAccount('gemini-close');
    const pulled = [];
    scriptedUpstream(undefined, (ev) => pulled.push(ev));
    const result = await handleGemini(MODEL, geminiBody(), { callerKey: CALLER }, { stream: true, alt: null });
    const res = controlledRes({ falseAt: 1 });
    const running = result.handler(res);

    await pump();
    assert.equal(res.writes.length, 1);

    res.emit('close');
    await withDeadline(running, 2000, 'the Gemini handler after close');

    assert.equal(res.writes.length, 1, 'no frame is written after the client is gone');
    assert.equal(pulled.length, 2, 'the producer was not driven past the held callback');
  });

  it('control: a fast reader gets the whole translated turn and arms no waiter', async () => {
    seedAccount('gemini-control');
    scriptedUpstream();
    const result = await handleGemini(MODEL, geminiBody(), { callerKey: CALLER }, { stream: true, alt: null });
    const res = controlledRes(); // never returns false
    await result.handler(res);

    assert.equal(res.falseSignals, 0);
    assert.ok(res.drainListenerPeak <= 1, 'no drain waiter beyond the (fix-only) real-socket forward');
    assert.ok(res.listenerCount('drain') <= 1, 'no waiter is left attached');
    assert.equal(geminiText(res), 'ALPHABETA');
    assert.equal(geminiFrames(res).at(-1).candidates?.[0]?.finishReason, 'STOP');
  });
});

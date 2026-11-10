// #250 on the CASCADE stream path: leading think-tagged CONTENT must be rerouted
// into the reasoning channel.
//
// WHY THIS PATH, SPECIFICALLY
//
// The reroute defense shipped in the connect layer only
// (src/devin-connect-openai.js:241, gated DEVIN_CONNECT_THINKTEXT_REROUTE). The
// Cascade path had none — and Cascade is the flow the README's recommended config
// points Claude Code at, so it carries most of the traffic the issue affects. A
// leak the client stores as visible assistant text gets resent next turn, which
// re-primes more reasoning-as-text: the self-reinforcing loop the classifier
// exists to break. Fixing only the quieter path relocates the bug.
//
// These are BEHAVIOUR tests, not source greps. The interception point sits inside
// streamResponse's `emitContent` closure, and the only honest way to prove a
// closure-local transform fires is to drive a real stream and read the bytes off
// the wire. chat.js has ReferenceError'd inside this exact region before — the
// error-path `chunk(...)` call fixed alongside this change was an undefined
// function swallowed by a try/catch, invisible to every grep (see the last case
// in this file). Reading `delta.content` from the SSE body is the assertion that
// cannot be fooled that way.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  getAccountInternal,
  getApiKey,
  removeAccount,
} from '../src/auth.js';
import { handleChatCompletions, isCascadeThinkRerouteEnabled } from '../src/handlers/chat.js';

// Built by concatenation so this file never contains a literal think tag — the
// same convention response-classifier.test.js uses, and it keeps the markers out
// of anything that scans the repo for them.
const OPEN = '<' + 'think' + '>';
const CLOSE = '<' + '/' + 'think' + '>';

const createdIds = [];
let savedEnv;

function seed(label) {
  const a = addAccountByKey(`devin-session-token$xk-${label}-${Math.random().toString(36).slice(2)}`, label);
  createdIds.push(a.id);
  const acct = getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

function fakeResponse() {
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.statusCode = status; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true; },
    on() {}, once() {}, removeListener() {},
  };
}

/**
 * A fake Cascade upstream that pushes `chunks` through onChunk verbatim.
 *
 * Each chunk is the {text, thinking} shape client.js's cascadeChat produces
 * (client.js:1105-1141 — thinking and text are separate channels at the source,
 * which is why #250's failure mode arrives as `text` with no `thinking` at all).
 *
 * @param {Array<{text?: string, thinking?: string}>} chunks
 * @param {{throwAfter?: boolean}} [opts] throwAfter: fail the stream once the
 *   chunks are delivered, to drive the partial-then-error tail path.
 */
function contextFor(chunks, { throwAfter = false } = {}) {
  class FakeClient {
    async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
      for (const c of chunks) opts.onChunk(c);
      if (throwAfter) {
        // hadSuccess is already true (content was emitted), so the retry gate
        // short-circuits and this lands on the partial-then-error tail.
        const err = new Error('upstream stalled after partial content');
        err.isModelError = true;
        throw err;
      }
      return { text: '', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
    }
  }
  return {
    waitForAccount(tried, _signal, _maxWait, modelKey) { return getApiKey(tried, modelKey); },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: FakeClient,
  };
}

/** Drive one streamed Cascade turn and return the raw SSE body. */
async function runStream(chunks, { body = {}, ...opts } = {}) {
  const result = await handleChatCompletions(
    {
      // gemini-2.5-flash routes through the Cascade flow, and its key carries no
      // /thinking/ marker — which keeps shouldFallbackThinkingToText's
      // non-reasoning-model branch live, the case that matters for a
      // fully-rerouted turn.
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'what is 6 times 7' }],
      stream: true,
      ...body,
    },
    contextFor(chunks, opts),
  );
  assert.equal(result.status, 200, 'the stream must start');
  const res = fakeResponse();
  await result.handler(res);
  return res.body;
}

/** Every delta.<field> off the wire, concatenated in arrival order. */
function wireField(raw, field) {
  let out = '';
  for (const m of raw.matchAll(/^data: (\{.*\})$/gm)) {
    let frame;
    try { frame = JSON.parse(m[1]); } catch { continue; }
    const v = frame?.choices?.[0]?.delta?.[field];
    if (typeof v === 'string') out += v;
  }
  return out;
}

const wireContent = (raw) => wireField(raw, 'content');
const wireReasoning = (raw) => wireField(raw, 'reasoning_content');

beforeEach(() => {
  savedEnv = {
    DEVIN_CONNECT: process.env.DEVIN_CONNECT,
    DEVIN_ONLY: process.env.DEVIN_ONLY,
    reroute: process.env.WINDSURFAPI_CASCADE_THINK_REROUTE,
    dedup: process.env.WINDSURFAPI_REASONING_DEDUP,
  };
  // Cascade transport, not connect: the gap under test is Cascade-specific.
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_ONLY;
  delete process.env.WINDSURFAPI_CASCADE_THINK_REROUTE;
});

afterEach(() => {
  // Only ids this file created. Never map removeAccount over the account list.
  while (createdIds.length) { try { removeAccount(createdIds.pop()); } catch {} }
  for (const [envName, key] of [
    ['DEVIN_CONNECT', 'DEVIN_CONNECT'],
    ['DEVIN_ONLY', 'DEVIN_ONLY'],
    ['WINDSURFAPI_CASCADE_THINK_REROUTE', 'reroute'],
    ['WINDSURFAPI_REASONING_DEDUP', 'dedup'],
  ]) {
    if (savedEnv[key] === undefined) delete process.env[envName];
    else process.env[envName] = savedEnv[key];
  }
});

describe('#250 Cascade path: leading think-tagged content is rerouted to reasoning', () => {
  it('reroutes a leading think block out of the content channel (default ON)', async () => {
    seed('reroute-on');
    const raw = await runStream([
      { text: OPEN + 'Let me compute 6*7. ' + CLOSE + 'The answer is 42.', thinking: '' },
    ]);

    assert.equal(wireContent(raw), 'The answer is 42.',
      'the visible answer must be exactly the post-marker text — a leak here is #250');
    assert.equal(wireReasoning(raw), 'Let me compute 6*7. ',
      'the reasoning span must arrive on reasoning_content');
    assert.ok(!wireContent(raw).includes(OPEN) && !wireContent(raw).includes(CLOSE),
      'no marker bytes may survive in the content channel');
  });

  it('reroutes a block split across deltas (the straddle case a whole-string check would miss)', async () => {
    // client.js slices cumulative step text with a per-step cursor, so a marker
    // routinely straddles a chunk boundary. This is the shape that defeats any
    // per-delta regex and needs the classifier's carry-over buffer.
    seed('reroute-split');
    const raw = await runStream([
      { text: '<' + 'thin', thinking: '' },
      { text: 'k' + '>reasoning part one, ', thinking: '' },
      { text: 'part two', thinking: '' },
      { text: '<' + '/thi', thinking: '' },
      { text: 'nk' + '>Final: 42.', thinking: '' },
    ]);

    assert.equal(wireContent(raw), 'Final: 42.');
    assert.equal(wireReasoning(raw), 'reasoning part one, part two');
  });

  it('OFF (WINDSURFAPI_CASCADE_THINK_REROUTE=0) leaves the bytes verbatim', async () => {
    // The kill switch this repo requires for a default-on behaviour change. Off
    // must be byte-identical to before the fix: markers and all, in content,
    // with nothing on the reasoning channel.
    process.env.WINDSURFAPI_CASCADE_THINK_REROUTE = '0';
    seed('reroute-off');
    const payload = OPEN + 'Let me compute 6*7. ' + CLOSE + 'The answer is 42.';
    const raw = await runStream([{ text: payload, thinking: '' }]);

    assert.equal(wireContent(raw), payload,
      'with the switch off the content channel must be untouched, markers included');
    assert.equal(wireReasoning(raw), '',
      'nothing may be promoted to the reasoning channel when the reroute is off');
  });

  it('no marker: an ordinary answer is byte-identical, in one frame per delta', async () => {
    // The transform must be inert on normal traffic — that is what makes
    // defaulting it ON defensible. Asserts the framing too: a classifier that
    // held and re-emitted chunks would change the delta boundaries even while
    // the concatenation matched.
    seed('reroute-plain');
    const raw = await runStream([
      { text: 'The answer ', thinking: '' },
      { text: 'is 42.', thinking: '' },
    ]);

    assert.equal(wireContent(raw), 'The answer is 42.');
    assert.equal(wireReasoning(raw), '');
    const contentFrames = [...raw.matchAll(/^data: (\{.*\})$/gm)]
      .map((m) => JSON.parse(m[1]))
      .filter((f) => typeof f?.choices?.[0]?.delta?.content === 'string'
        && f.choices[0].delta.content.length > 0);
    assert.deepEqual(contentFrames.map((f) => f.choices[0].delta.content),
      ['The answer ', 'is 42.'],
      'unmarked deltas must stream one-for-one, not be coalesced or delayed');
  });

  it('a marker mid-answer is NOT rerouted (only a LEADING block is a leak)', async () => {
    // Scope guard. Text that quotes a marker after real content has started is
    // the model talking ABOUT markers, not leaking reasoning. Rerouting it would
    // delete visible bytes the user asked for.
    seed('reroute-mid');
    const payload = 'Here is the tag we use: ' + OPEN + 'inner' + CLOSE + ' — got it?';
    const raw = await runStream([{ text: payload, thinking: '' }]);

    assert.equal(wireContent(raw), payload);
    assert.equal(wireReasoning(raw), '');
  });

  it('does not double-transform with reasoningDedup at the same interception point', async () => {
    // The two transforms sit on the same choke point and interact directly: the
    // reroute calls emitThinking, which SEEDS the dedup's seenReasoning. Feeding
    // the classifier AFTER the dedup would make its own rerouted output look
    // like a duplicate prefix and get held; both running on one span could
    // suppress the answer entirely. Upstream here emits reasoning on the real
    // thinking channel AND repeats it as leading think-tagged text — the exact
    // overlap case — so the answer must still arrive exactly once.
    seed('reroute-dedup');
    const reasoning = 'Six sevens are forty-two. ';
    const raw = await runStream([
      { text: '', thinking: reasoning },
      { text: OPEN + reasoning + CLOSE + 'It is 42.', thinking: '' },
    ]);

    assert.equal(wireContent(raw), 'It is 42.',
      'the answer must be delivered exactly once — not held by the dedup, not doubled');
    assert.ok(!wireContent(raw).includes(OPEN),
      'markers must not reach the client through the dedup path either');
    // The reasoning arrives on its own channel; the rerouted duplicate of it
    // must not add a second visible copy.
    assert.ok(wireReasoning(raw).startsWith(reasoning));
    assert.equal(wireContent(raw).includes(reasoning), false,
      'the reasoning text must not also appear in the content channel');
  });

  it('a whole-turn think block still reaches the client (no silent content loss)', async () => {
    // The content-loss shape review flagged: if the ENTIRE turn was a think
    // block, a content-only client would see nothing. The existing
    // shouldFallbackThinkingToText net catches it for a non-reasoning model, so
    // the bytes stay visible. This is why default-ON does not risk an empty answer.
    seed('reroute-whole');
    const raw = await runStream([
      { text: OPEN + 'entirely reasoning, no answer text' + CLOSE, thinking: '' },
    ]);

    assert.match(wireContent(raw), /entirely reasoning, no answer text/,
      'a fully-rerouted turn must be promoted back to content rather than vanish');
  });

  it('reroutes a think block far larger than the undecided-hold ceiling', async () => {
    // Regression for the ordering bug hardened in response-classifier.js: the
    // MAX_LEAD overflow check used to run BEFORE the marker scan, so once enough
    // undecided bytes were held the leading marker was never scanned and the
    // whole buffer — markers and reasoning included — was dumped to the text
    // channel. Measured on the pre-fix code: a single 8193-char delta was not
    // rerouted while 8192 was, and Cascade does deliver large single deltas
    // (final-sweep top-ups in client.js re-emit a whole step's tail at once).
    // No test fed more than 8192 held chars, which is why it survived.
    seed('reroute-oversize');
    const reasoning = 'r'.repeat(20000);
    const raw = await runStream([
      { text: OPEN + reasoning + CLOSE + 'Answer after a long think.', thinking: '' },
    ]);

    assert.equal(wireContent(raw), 'Answer after a long think.',
      'a think block bigger than the hold ceiling must still be rerouted, not '
      + 'dumped into the content channel unscanned');
    assert.equal(wireReasoning(raw), reasoning);
  });

  it('an unterminated span is delivered as text at the tail, never dropped', async () => {
    // flush() is the classifier's caller-side invariant: forget it and an
    // unclosed span disappears. Visible beats dropped.
    seed('reroute-unterminated');
    const raw = await runStream([
      { text: OPEN + 'reasoning that never closes', thinking: '' },
    ]);

    assert.match(wireContent(raw), /reasoning that never closes/,
      'an unterminated span must be flushed to the client, not silently held');
  });

  it('releases the held tail when the stream fails after partial content', async () => {
    // The partial-then-error path. It also pins the `chunk(...)` ReferenceError
    // fixed alongside this change: that undefined call sat inside a try/catch, so
    // it silently skipped the rest of the block including the synthetic stop
    // frame. A grep could not see it; a driven stream can.
    seed('reroute-error-tail');
    const raw = await runStream([
      { text: OPEN + 'partial reasoning', thinking: '' },
    ], { throwAfter: true });

    assert.match(wireContent(raw), /partial reasoning/,
      'the classifier tail must be released on the failure path too');
    // A06/KH-002: a failure after content is an explicit error frame, not a
    // fabricated stop. A ReferenceError here would swallow the terminal frame.
    assert.ok(/"error"\s*:/.test(raw),
      'the partial-then-error tail must still emit its terminal error frame');
    assert.equal(/"finish_reason":"stop"/.test(raw), false,
      'a dead turn must not be dressed up as a successful stop');
  });

  // ── emulateTools + failure: the accThinking hole ──────────────────────────
  //
  // Adversarial review (2026-08-10) found both of these. The test above only
  // covers an UNTERMINATED span, which the classifier still holds in `pending`
  // and flush() releases. A CLOSED span in emulateTools mode is a different
  // path: it was already rerouted OUT of the classifier and buffered into
  // accThinking (emulateTools defers reasoning so a reasoning_content delta
  // cannot precede a tail tool_call — "Content block not found" in Claude Code).
  // flush() never touches accThinking, so on a stream failure that reasoning
  // was silently dropped. Cascade + emulateTools is the README's Claude Code
  // config, so this is the live shape, not an edge case.
  const TOOLS = [{
    type: 'function',
    function: { name: 'noop', description: 'd', parameters: { type: 'object', properties: {} } },
  }];

  it('emulateTools + failure: a CLOSED rerouted span is not dropped from accThinking', async () => {
    seed('reroute-emulate-error');
    const raw = await runStream([
      { text: OPEN + 'reasoning that came as content' + CLOSE + 'answer here', thinking: '' },
    ], { body: { tools: TOOLS }, throwAfter: true });

    // gemini-2.5-flash is non-reasoning, so shouldFallbackThinkingToText promotes
    // the buffered reasoning back to visible text rather than dropping it.
    const all = wireContent(raw) + wireReasoning(raw);
    assert.match(all, /reasoning that came as content/,
      'buffered reasoning must survive the failure path — pre-fix it vanished '
      + 'because only thinkClassifier.flush() ran and accThinking was never released');
    assert.match(wireContent(raw), /answer here/, 'the post-marker answer must still arrive');
  });

  it('emulateTools + failure on an ALL-thinking turn still delivers its bytes and errors', async () => {
    // The worse half: when the whole turn was a rerouted think block, nothing was
    // ever emitted, so emittedClientPayload stayed false and the client got an
    // empty assistant turn plus a raw {"error":...} frame with NO finish_reason.
    seed('reroute-emulate-error-all');
    const raw = await runStream([
      { text: OPEN + 'pure reasoning, no answer' + CLOSE, thinking: '' },
    ], { body: { tools: TOOLS }, throwAfter: true });

    const all = wireContent(raw) + wireReasoning(raw);
    assert.match(all, /pure reasoning, no answer/,
      'an all-thinking turn must still deliver its bytes on the failure path');
    // A06/KH-002: releasing accThinking still sets emittedClientPayload, but
    // the terminal is now the honest error frame, never a synthetic stop.
    assert.ok(/"error"\s*:/.test(raw),
      'releasing accThinking must set emittedClientPayload so the partial-delivered '
      + 'branch emits the structured error frame');
    assert.equal(/"finish_reason":"stop"/.test(raw), false,
      'an interrupted turn must not be closed as a successful stop');
  });
});

describe('isCascadeThinkRerouteEnabled', () => {
  it('defaults ON when unset or empty', () => {
    assert.equal(isCascadeThinkRerouteEnabled({}), true);
    assert.equal(isCascadeThinkRerouteEnabled({ WINDSURFAPI_CASCADE_THINK_REROUTE: '' }), true);
  });

  it('only an exact "0" disables it', () => {
    assert.equal(isCascadeThinkRerouteEnabled({ WINDSURFAPI_CASCADE_THINK_REROUTE: '0' }), false);
    // Guards the Number()/falsy rewrite that silently disabled sibling knobs
    // (#241, #242): '00' and 'false' are not the off value.
    assert.equal(isCascadeThinkRerouteEnabled({ WINDSURFAPI_CASCADE_THINK_REROUTE: '00' }), true);
    assert.equal(isCascadeThinkRerouteEnabled({ WINDSURFAPI_CASCADE_THINK_REROUTE: 'false' }), true);
    assert.equal(isCascadeThinkRerouteEnabled({ WINDSURFAPI_CASCADE_THINK_REROUTE: '1' }), true);
  });
});

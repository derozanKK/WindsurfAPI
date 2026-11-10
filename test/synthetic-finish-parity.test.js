// A stream that died mid-answer must not read as complete on ANY internal route.
//
// When a Cascade stream fails AFTER already delivering content, chat.js closes it
// with a FABRICATED finish_reason:'stop' — injecting the error as a content delta
// would corrupt the assistant message, so a clean close is the right wire shape for
// a direct OpenAI client. But all three internal translators guard against exactly
// this case, and all three keyed that guard on "did a terminal signal arrive". The
// synthetic close satisfied it.
//
// v3.9.2 fixed ONE of the three (responses). This file exists because that is the
// FOURTH occurrence of this repo's "fix covered only some routes" trap — and this
// time the incomplete fix was in the fix itself. So the guard is written per-route
// and asserts the WHOLE set, not one path.
//
// Two entry points had to be closed on messages/gemini, not one:
//   1. the synthetic finish_reason frame, and
//   2. the bare `[DONE]` sentinel — chat.js writes it on the truncated path too.
// Plugging only (1) leaves the guard defeated via (2). Both are covered below.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const H = new URL('../src/handlers/', import.meta.url);

const fakeRes = () => ({
  out: '', writableEnded: false, headersSent: false,
  writeHead() { this.headersSent = true; },
  write(c) { this.out += c; return true; },
  end(c) { if (c) this.out += c; this.writableEnded = true; },
  on() { return this; },
});

// An upstream that delivers content and then dies. `synthetic` mirrors what
// chat.js emits on that path: a fabricated finish frame AND a `[DONE]`.
const dyingStream = ({ synthetic, done = true }) => async () => ({
  status: 200, stream: true,
  handler: async (res) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The capital is Par' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(synthetic ? { __synthetic_finish: true } : {}),
    })}\n\n`);
    if (done) res.write('data: [DONE]\n\n');
    res.end();
  },
});

async function runMessages(upstream) {
  const { handleMessages } = await import(`${H}messages.js`);
  const r = await handleMessages(
    { model: 'claude-sonnet-4.6', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    { handleChatCompletions: upstream, callerKey: 'api:k:user:u' },
  );
  const res = fakeRes();
  if (r.stream) await r.handler(res);
  return res.out;
}

async function runGemini(upstream) {
  const { handleGemini } = await import(`${H}gemini.js`);
  const r = await handleGemini('gemini-3.0-pro',
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    { handleChatCompletions: upstream, callerKey: 'api:k:user:u' }, { stream: true });
  const res = fakeRes();
  if (r.stream) await r.handler(res);
  return res.out;
}

async function runResponses(upstream) {
  const { handleResponses } = await import(`${H}responses.js`);
  const r = await handleResponses(
    { model: 'm', stream: true, store: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    { handleChatCompletions: upstream, context: { callerKey: 'api:k:user:u' } },
  );
  const res = fakeRes();
  if (r.stream) await r.handler(res);
  return res.out;
}

describe('a synthetic close is surfaced as a failure on every internal route', () => {
  it('/v1/messages does not report stop_reason:end_turn', async () => {
    // Anthropic's stop_reason enum has no "truncated" value, so BUG1's contract is
    // that a truncation becomes an `error` event (502 → retryable 529) rather than a
    // bogus stop_reason. Verified broken before the fix: end_turn, no error frame.
    const out = await runMessages(dyingStream({ synthetic: true }));
    assert.equal(/"stop_reason":"end_turn"/.test(out), false,
      'a truncated answer must not be reported as a natural end_turn');
    assert.ok(/event: error/.test(out) || /overloaded|upstream_error/.test(out),
      'the truncation must surface as an error event');
  });

  it('/v1beta gemini does not report finishReason:STOP', async () => {
    const out = await runGemini(dyingStream({ synthetic: true }));
    assert.equal(/"finishReason":"STOP"/.test(out), false,
      'a truncated answer must not be reported as a clean STOP');
    assert.ok(/"error"/.test(out) || /UNAVAILABLE/.test(out),
      'the truncation must surface as an error frame');
  });

  it('/v1/responses does not report response.completed', async () => {
    const out = await runResponses(dyingStream({ synthetic: true }));
    const events = [...out.matchAll(/^event: (\S+)$/gm)].map(m => m[1]);
    assert.notEqual(events.at(-1), 'response.completed');
  });
});

describe('the bare [DONE] sentinel is not proof of completion', () => {
  // The second entry point. chat.js emits `[DONE]` on the truncated path too, so a
  // translator that treats it as authoritative stays defeated even after the
  // finish-frame check is fixed. This is what made the first attempt at this fix
  // look like it had no effect.
  it('/v1/messages: [DONE] after a synthetic finish does not clear the guard', async () => {
    const out = await runMessages(dyingStream({ synthetic: true, done: true }));
    assert.equal(/"stop_reason":"end_turn"/.test(out), false);
  });

  it('/v1beta gemini: [DONE] after a synthetic finish does not clear the guard', async () => {
    const out = await runGemini(dyingStream({ synthetic: true, done: true }));
    assert.equal(/"finishReason":"STOP"/.test(out), false);
  });
});

describe('a REAL terminal frame still completes normally on every route', () => {
  // The other half of the contract: the marker must be the ONLY difference. Without
  // these, the fix above could pass by breaking every normal stream.
  it('/v1/messages reports end_turn', async () => {
    const out = await runMessages(dyingStream({ synthetic: false }));
    assert.match(out, /"stop_reason":"end_turn"/);
    assert.equal(/event: error/.test(out), false);
  });

  it('/v1beta gemini reports STOP', async () => {
    const out = await runGemini(dyingStream({ synthetic: false }));
    assert.match(out, /"finishReason":"STOP"/);
  });

  it('/v1/responses reports response.completed', async () => {
    const out = await runResponses(dyingStream({ synthetic: false }));
    const events = [...out.matchAll(/^event: (\S+)$/gm)].map(m => m[1]);
    assert.equal(events.at(-1), 'response.completed');
  });
});

describe('source parity — every internal translator discounts the synthetic close', () => {
  // A behavioural test per route can still drift: a NEW internal route added later
  // would have no test here and would silently repeat the bug. This meta-guard reads
  // the sources so a route that forgets the check fails the build.
  for (const route of ['messages', 'gemini', 'responses']) {
    it(`${route}.js consults __synthetic_finish`, () => {
      const src = readFileSync(new URL(`${route}.js`, H), 'utf8');
      assert.match(src, /__synthetic_finish/,
        `${route}.js must discount a fabricated terminal frame — chat.js emits one to `
        + 'close a stream that died mid-answer, and treating it as real reports a '
        + 'truncated reply as complete');
    });
  }

  it('chat.js never fabricates a successful stop for a partial failure', () => {
    const src = readFileSync(new URL('chat.js', H), 'utf8');
    const helperStart = src.indexOf('export function finishPartialStreamAfterError');
    const helperEnd = src.indexOf('export function finishTruncatedStream', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, 'the partial-failure helper must exist');
    const helper = src.slice(helperStart, helperEnd);
    assert.doesNotMatch(helper, /finish_reason:\s*'stop'/,
      'a failure after content must not be closed as a successful stop');
    assert.doesNotMatch(helper, /\[DONE\]/,
      'a failed stream must not write the clean-finish sentinel');
  });

  it('chat.js only marks the truncation terminal on internal routes', () => {
    // A length terminal for an upstream poll truncation is still fabricated; the
    // marker must be gated so a direct /v1/chat/completions client sees the
    // standard `length` shape without the private translator flag.
    const src = readFileSync(new URL('chat.js', H), 'utf8');
    assert.match(src, /internalRoute \? \{ __synthetic_finish: true \} : \{\}/,
      'the marker must be gated on the internal-route flag');
    assert.match(src, /internalRoute: !isOpenAIClient/,
      'the gate must be driven by the route, not hardcoded');
  });
});

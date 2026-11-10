// A2 (protocol absorption, 2026-10-18): an upstream error that arrives AFTER a
// success terminal must not be silently dropped, and it must not be rewritten
// into a success. Each front end has a different terminal event, so each gets
// its own assertion:
//
//   Messages  — `error` event, and NO message_delta / message_stop after it
//   Responses — `response.failed`, and NO response.completed after it
//   Gemini    — an error frame, and no frame carrying a finishReason after it
//   chat      — the error frame reaches the client (the OpenAI route's clean
//               close after content is the documented contract; see the case)
//   SSE gate  — a terminal already committed to the wire is not re-decided
//
// Fake upstream: `handleChatCompletions` is replaced by a handler that writes
// the internal OpenAI SSE frames chat.js would write, so the frame order below
// is exactly what the translators see from a misbehaving upstream.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { startServer } from '../src/server.js';
import { __resetConnectDeps, __setConnectDeps } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleGemini } from '../src/handlers/gemini.js';
import { createDeferredSseResponse } from '../src/sse-commit.js';

function fakeRes() {
  return {
    body: '', writableEnded: false,
    statusCode: null, headers: null,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    on() { return this; }, once() { return this; }, off() { return this; },
    setHeader() {}, flushHeaders() {},
  };
}

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const LATE = { type: 'upstream_error', code: 'UPSTREAM_ERROR', message: 'upstream died after the terminal chunk' };

// The exact order the ticket names: a real success terminal, THEN the error.
// `[DONE]` follows because that is what chat.js writes at stream end.
function lateErrorFrames() {
  return [
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    chunk({ error: LATE }),
    'data: [DONE]\n\n',
  ];
}

function streamDeps(frames) {
  return {
    async handleChatCompletions() {
      return {
        status: 200, stream: true,
        async handler(res) { for (const f of frames) res.write(f); res.end(); },
      };
    },
  };
}

function sseEvents(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const event = frame.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
    const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || data.trim() === '[DONE]') return { event, data: null };
    return { event, data: JSON.parse(data) };
  });
}

function dataEvents(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || data.trim() === '[DONE]') return null;
    return JSON.parse(data);
  }).filter(Boolean);
}

describe('A2 — an upstream error after a success terminal is not masked', () => {
  it('Anthropic Messages: error event, and no message_delta/message_stop after it', async () => {
    const result = await handleMessages({
      model: 'claude-haiku-5-5-low', max_tokens: 32, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, streamDeps(lateErrorFrames()));
    const res = fakeRes();
    await result.handler(res);
    const events = sseEvents(res.body);

    const errorIndex = events.findIndex((e) => e.event === 'error');
    assert.notEqual(errorIndex, -1, 'the late error is surfaced as an error event');
    assert.equal(events[errorIndex].data.error.message, LATE.message, 'the upstream message survives');
    // Anthropic's `error` is a terminal event. Anything that would settle the
    // turn as a completed answer must NOT follow it.
    const after = events.slice(errorIndex + 1);
    assert.equal(after.some((e) => e.event === 'message_stop'), false, 'no message_stop after the error');
    assert.equal(after.some((e) => e.event === 'message_delta'), false, 'no message_delta (stop_reason) after the error');
    assert.equal(events.some((e) => e.data?.type === 'message_delta' && e.data.delta?.stop_reason === 'end_turn'), false,
      'the upstream finish_reason:stop never becomes a completed Anthropic turn');
    // The content that did arrive is still delivered before the error.
    assert.equal(events.some((e) => e.data?.delta?.text === 'hello'), true);
  });

  it('Responses: response.failed, and no response.completed after it', async () => {
    const result = await handleResponses({
      model: 'gpt-5.2', stream: true, store: false, input: 'hi',
    }, { ...streamDeps(lateErrorFrames()), context: { callerKey: 'api:late-error:user:t' } });
    const res = fakeRes();
    await result.handler(res);
    const events = dataEvents(res.body);

    const failedIndex = events.findIndex((e) => e.type === 'response.failed');
    assert.notEqual(failedIndex, -1, 'the late error is surfaced as response.failed');
    assert.equal(events[failedIndex].response.status, 'failed');
    assert.equal(events[failedIndex].response.error.message, LATE.message);
    assert.equal(events.some((e) => e.type === 'response.completed'), false, 'no response.completed for a failed turn');
    assert.equal(events.some((e) => e.type === 'response.output_item.done'), false, 'no completed output item for a failed turn');
    assert.equal(events.some((e) => e.type === 'response.output_text.delta'), true, 'the text that did arrive is still delivered');
  });

  it('Gemini: an error frame, and no finishReason after it', async () => {
    const result = await handleGemini('gemini-3-pro', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, streamDeps(lateErrorFrames()), { stream: true, alt: 'sse' });
    const res = fakeRes();
    await result.handler(res);
    const events = dataEvents(res.body);

    const errorIndex = events.findIndex((e) => e.error);
    assert.notEqual(errorIndex, -1, 'the late error is surfaced as an error frame');
    assert.equal(events[errorIndex].error.message, LATE.message);
    const after = events.slice(errorIndex + 1);
    assert.equal(after.some((e) => e.candidates?.[0]?.finishReason), false, 'no finishReason frame after the error');
    assert.equal(events.some((e) => e.candidates?.[0]?.finishReason), false, 'the upstream finish_reason:stop never becomes STOP');
  });

  it('SSE commit gate: a committed terminal is not re-decided by a later error', () => {
    const real = fakeRes();
    const res = createDeferredSseResponse(real, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      protocol: 'openai',
    });
    const terminal = chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    const error = chunk({ error: { message: 'late', code: 'UPSTREAM_ERROR' } });
    res.write(terminal);
    assert.equal(real.statusCode, 200, 'the success terminal committed the SSE response');
    res.write(error);
    res.end();
    // First terminal wins at the gate: the bytes are forwarded verbatim. The
    // gate must not rewrite an already-sent 200 into a JSON error, and must not
    // swallow the frame either.
    assert.equal(real.statusCode, 200);
    assert.equal(real.headers['content-type'], 'text/event-stream');
    assert.equal(real.body, terminal + error, 'the late error frame is forwarded byte-identically');
  });
});

// The DEFAULT route. On /v1/chat/completions the upstream's success terminal is
// already on the wire when the error arrives, so the only remaining signal is
// the error frame itself — the requirement here is that it is NOT dropped.
//
// The `[DONE]` that chat.js appends after content is the documented clean close
// for a direct OpenAI client (test/devin-connect-failover.test.js: "Content
// already on the wire keeps the historical clean-close behavior"): the OpenAI
// stream has no representation for "partial answer + error", and injecting the
// error as a content delta would corrupt the assistant message. The test pins
// the ORDER — the error frame must precede that terminator — not the terminator.
describe('A2 — the chat route surfaces a post-terminal upstream error', () => {
  const SAVED = {};
  const ENV_KEYS = ['DEVIN_CONNECT', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY'];
  let server;
  let port;

  before(async () => {
    for (const key of ENV_KEYS) SAVED[key] = process.env[key];
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOKEN = 'test-env-token-shape-only';
    delete process.env.WINDSURF_API_KEY;
    config.apiKey = 'test-late-error-key';
    config.host = '127.0.0.1';
    config.port = 0;
    __setConnectDeps({
      toChatCompletion: async () => ({ status: 200, body: { choices: [] } }),
      streamChatCompletion: async (_params, send) => {
        send({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] });
        send({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'claude-haiku-5-5-low', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        // The transport dies after the upstream already reported a clean stop.
        throw Object.assign(new Error('upstream died after the terminal chunk'), { code: 'UPSTREAM_ERROR' });
      },
    });
    server = startServer();
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    port = server.address().port;
  });

  after(async () => {
    __resetConnectDeps();
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const key of ENV_KEYS) {
      if (SAVED[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED[key];
    }
  });

  it('emits the error frame after the terminal chunk instead of dropping it', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-late-error-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-5-5-low', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    const raw = body.split(/\r?\n\r?\n/).filter(Boolean)
      .map((frame) => frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
      .filter(Boolean);

    const terminalIndex = raw.findIndex((d) => d !== '[DONE]' && JSON.parse(d).choices?.[0]?.finish_reason === 'stop');
    const errorIndex = raw.findIndex((d) => d !== '[DONE]' && JSON.parse(d).error);
    assert.notEqual(terminalIndex, -1, 'the upstream success terminal reached the client');
    assert.notEqual(errorIndex, -1, 'the late upstream error reached the client (not silently dropped)');
    assert.ok(errorIndex > terminalIndex, 'the error frame follows the terminal it arrived after');
    assert.equal(JSON.parse(raw[errorIndex]).error.message, 'upstream died after the terminal chunk');
    const doneIndex = raw.indexOf('[DONE]');
    assert.ok(doneIndex === -1 || doneIndex > errorIndex, 'the documented clean-close terminator never precedes the error');
  });
});

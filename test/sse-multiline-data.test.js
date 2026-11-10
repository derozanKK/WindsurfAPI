// A3(a) — an SSE `data:` field may span several lines. The spec joins the
// values of repeated `data:` lines with U+000A, and the wire may terminate any
// line with LF, CR or CRLF. An empty `data:` line therefore contributes an
// empty string and still adds a separator (so `data: a` / `data:` / `data: b`
// yields "a\n\nb").
//
// This file pins the shared framer and the deferred commit gate, then drives
// the same multi-line frames through a real translator so the framer → JSON
// path is exercised end to end. The JSON is pretty-printed: its internal
// newlines become the repeated `data:` lines, and the joined payload must parse
// back to the original object.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SseFramer } from '../src/sse-framer.js';
import { createDeferredSseResponse } from '../src/sse-commit.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleGemini } from '../src/handlers/gemini.js';

const EOLS = { LF: '\n', CR: '\r', CRLF: '\r\n' };

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

// One SSE event: every line of the pretty JSON becomes its own `data:` line,
// terminated with `eol`, followed by a blank line (two more terminators).
function dataFrame(obj, eol) {
  const body = pretty(obj).split('\n').map((line) => `data: ${line}`).join(eol);
  return body + eol + eol;
}

function collect() {
  const frames = [];
  const framer = new SseFramer({ onFrame: (f) => frames.push(f) });
  return { framer, frames };
}

function fakeRes() {
  return {
    body: '', writableEnded: false, statusCode: null, headers: null,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.body += String(c); this.writableEnded = true; },
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    flushHeaders() {},
    on() { return this; }, once() { return this; }, off() { return this; },
    setHeader() {}, getHeader() { return undefined; }, removeHeader() {},
  };
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

function eventsOf(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const event = frame.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
    const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || data.trim() === '[DONE]') return { event, data: null };
    return { event, data: JSON.parse(data) };
  });
}

describe('A3(a) — multi-line SSE data in the shared framer', () => {
  const payload = { choices: [{ index: 0, delta: { content: 'hello' } }] };
  const expected = pretty(payload);

  for (const [name, eol] of Object.entries(EOLS)) {
    it(`joins repeated data: lines with LF (${name} wire terminators)`, () => {
      const { framer, frames } = collect();
      framer.push(dataFrame(payload, eol));
      framer.end();
      assert.equal(frames.length, 1);
      assert.equal(frames[0].event, null);
      assert.equal(frames[0].data, expected, 'the data value is the exact JSON text, newlines preserved');
      assert.deepEqual(JSON.parse(frames[0].data), payload);
    });

    it(`survives a chunk boundary at every wire character (${name})`, () => {
      const wire = dataFrame(payload, eol);
      const { framer, frames } = collect();
      for (const ch of wire) framer.push(ch);
      framer.end();
      assert.equal(frames.length, 1, `one frame, not ${frames.length}`);
      assert.equal(frames[0].data, expected);
    });
  }

  it('an empty data: line contributes an empty string plus a separator', () => {
    for (const [name, eol] of Object.entries(EOLS)) {
      const wire = ['data: {"a":', 'data:', 'data: 1}'].join(eol) + eol + eol;
      const { framer, frames } = collect();
      framer.push(wire);
      framer.end();
      assert.equal(frames.length, 1, name);
      assert.equal(frames[0].data, '{"a":\n\n1}', `${name}: empty line is retained as a blank line`);
      assert.deepEqual(JSON.parse(frames[0].data), { a: 1 });
    }
  });

  it('accepts mixed line terminators in one event and keeps the event name', () => {
    const { framer, frames } = collect();
    framer.push('event: chunk\r\ndata: {"a":\ndata: 1}\r\r');
    framer.end();
    assert.deepEqual(frames, [{ event: 'chunk', data: '{"a":\n1}' }]);
  });

  it('dispatches a multi-line event followed immediately by another event', () => {
    const { framer, frames } = collect();
    framer.push(dataFrame({ a: 1 }, '\r\n') + dataFrame({ b: 2 }, '\n'));
    framer.end();
    assert.equal(frames.length, 2);
    assert.deepEqual(JSON.parse(frames[0].data), { a: 1 });
    assert.deepEqual(JSON.parse(frames[1].data), { b: 2 });
  });
});

describe('A3(a) — multi-line SSE data in the deferred commit gate', () => {
  it('detects an error carried by a multi-line data payload', () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { bootstrapTimeoutMs: 0 });
    const wire = dataFrame({ error: { message: 'boom', type: 'rate_limit_error' } }, '\r\n');
    // Split inside the first CRLF pair so the gate also sees a partial line.
    const cut = wire.indexOf('\r\n') + 1;
    gate.write(wire.slice(0, cut));
    gate.write(wire.slice(cut));
    gate.end();
    assert.equal(real.statusCode, 429, 'the real status is delivered instead of a 200 SSE stream');
    assert.match(real.headers['content-type'], /^application\/json/);
    assert.equal(real.body.includes('data:'), false, 'no SSE bytes were committed');
    assert.equal(JSON.parse(real.body).error.message, 'boom');
  });

  it('holds a multi-line bootstrap frame, then commits it with the content frame', () => {
    const real = fakeRes();
    const gate = createDeferredSseResponse(real, { bootstrapTimeoutMs: 0 });
    gate.write(dataFrame({ choices: [{ index: 0, delta: { role: 'assistant' } }] }, '\n'));
    assert.equal(gate.headersSent, false, 'a role-only chunk is still a bootstrap');
    assert.equal(real.body, '');
    gate.write(dataFrame({ choices: [{ index: 0, delta: { content: 'hi' } }] }, '\n'));
    gate.end();
    assert.equal(gate.headersSent, true);
    assert.equal(real.statusCode, 200);
    assert.equal(real.body.includes('assistant'), true, 'the held bootstrap frame was flushed on commit');
    assert.equal(real.body.includes('hi'), true);
  });
});

describe('A3(a) — multi-line SSE data reaches the translators as JSON', () => {
  for (const [name, eol] of Object.entries(EOLS)) {
    it(`Messages parses a pretty-printed chunk split over data: lines (${name})`, async () => {
      const frames = [
        dataFrame({ choices: [{ index: 0, delta: { content: 'hello' } }] }, eol),
        dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, eol),
        `data: [DONE]${eol}${eol}`,
      ];
      const result = await handleMessages({
        model: 'claude-haiku-5-5-low', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }, streamDeps(frames));
      const res = fakeRes();
      await result.handler(res);
      const events = eventsOf(res.body);
      const text = events
        .filter((e) => e.data?.delta?.type === 'text_delta')
        .map((e) => e.data.delta.text).join('');
      assert.equal(text, 'hello');
      assert.equal(events.find((e) => e.data?.type === 'message_delta')?.data?.delta?.stop_reason, 'end_turn');
    });
  }

  it('Responses parses a pretty-printed chunk split over CRLF data: lines', async () => {
    const frames = [
      dataFrame({ choices: [{ index: 0, delta: { content: 'hello' } }] }, '\r\n'),
      dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '\r\n'),
      'data: [DONE]\r\n\r\n',
    ];
    const result = await handleResponses({
      model: 'gpt-5.2', stream: true, store: false, input: 'hi',
    }, { ...streamDeps(frames), context: { callerKey: 'api:a3-multiline:user:t' } });
    const res = fakeRes();
    await result.handler(res);
    const events = eventsOf(res.body).map((e) => e.data).filter(Boolean);
    const text = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
    assert.equal(text, 'hello');
  });

  it('Gemini parses a pretty-printed chunk split over CR data: lines', async () => {
    const frames = [
      dataFrame({ choices: [{ index: 0, delta: { content: 'hello' } }] }, '\r'),
      dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '\r'),
      'data: [DONE]\r\r',
    ];
    const result = await handleGemini('gemini-3-pro', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, streamDeps(frames), { stream: true, alt: 'sse' });
    const res = fakeRes();
    await result.handler(res);
    const parts = eventsOf(res.body).flatMap((e) => e.data?.candidates?.[0]?.content?.parts || []);
    assert.equal(parts.map((p) => p.text || '').join(''), 'hello');
  });
});

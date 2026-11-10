// The Responses translator must share the same SSE line-terminator rule as the
// other two dialects. A CRLF upstream (or a frame split across TCP writes) used
// to be invisible to the old `indexOf('\n\n')` scanner, so the turn closed as
// `response.incomplete` with no content. These tests drive the real handler.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleResponses } from '../src/handlers/responses.js';

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; },
    setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}

const dataFrame = (o, eol = '\n') => `data: ${JSON.stringify(o)}${eol}${eol}`;

async function run(writes) {
  const r = await handleResponses(
    { model: 'gpt-5.2', stream: true, input: 'hi' },
    {
      async handleChatCompletions() {
        return {
          status: 200, stream: true,
          async handler(res) { for (const w of writes) res.write(w); res.end(); },
        };
      },
      context: { callerKey: 'api:frame:user:t' },
    },
  );
  const res = fakeRes();
  await r.handler(res);
  return res.body;
}

describe('Responses SSE framing', () => {
  it('accepts CRLF terminators and still completes the turn', async () => {
    const body = await run([
      dataFrame({ choices: [{ index: 0, delta: { content: 'hi' } }] }, '\r\n'),
      dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '\r\n'),
      'data: [DONE]\r\n\r\n',
    ]);
    assert.match(body, /response\.output_text\.delta/);
    assert.match(body, /response\.completed/);
    assert.doesNotMatch(body, /response\.incomplete/);
  });

  it('reassembles a frame split across writes', async () => {
    const frame = dataFrame({ choices: [{ index: 0, delta: { content: 'split' } }] });
    const finish = dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    const body = await run([frame.slice(0, 7), frame.slice(7, 23), frame.slice(23), finish]);
    assert.match(body, /split/);
    assert.match(body, /response\.completed/);
  });

  it('flushes a final frame that has no blank-line terminator', async () => {
    const body = await run([
      dataFrame({ choices: [{ index: 0, delta: { content: 'tail' } }] }),
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
    ]);
    assert.match(body, /tail/);
    assert.match(body, /response\.completed/);
  });
});

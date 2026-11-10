// Both non-OpenAI frontends consume the same chat SSE. A CRLF upstream is legal
// SSE, and the old `indexOf('\n\n')` scanners silently dropped every frame.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';
import { handleGemini } from '../src/handlers/gemini.js';

const crlf = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; },
  };
}

describe('Anthropic messages: CRLF upstream framing', () => {
  it('translates CRLF chat frames instead of dropping the turn', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6', stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200, stream: true,
          async handler(res) {
            res.write(crlf({ choices: [{ index: 0, delta: { content: 'crlf-ok' } }] }));
            res.write(crlf({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\r\n\r\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    assert.match(res.body, /crlf-ok/);
    assert.match(res.body, /event: message_stop/);
  });
});

describe('Gemini: CRLF upstream framing', () => {
  it('translates CRLF chat frames into candidates', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200, stream: true,
          async handler(res) {
            res.write(crlf({ choices: [{ index: 0, delta: { content: 'crlf-ok' } }] }));
            res.write(crlf({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\r\n\r\n');
          },
        };
      },
    }, { stream: true, alt: 'sse' });
    const res = fakeRes();
    await result.handler(res);
    assert.match(res.body, /crlf-ok/);
    assert.match(res.body, /STOP/);
  });
});

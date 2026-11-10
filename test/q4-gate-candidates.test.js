import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';
import { buildGetChatMessageRequest, __testing } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const SIG = 'EpkCCkYIBxgCKkDsignatureBase64Payload==';
const chunk = delta => `data: ${JSON.stringify({ id: 'q4', model: 'm', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(s) { this.body += String(s); return true; },
    end(s) { if (s) this.write(s); this.writableEnded = true; },
    on() { return this; },
  };
}
function wireChats(proto) {
  return getAllFields(parseFields(proto), 3).filter(f => f.wireType === 2).map(f => parseFields(f.value));
}
const str = (fields, n) => getField(fields, n, 2)?.value.toString('utf8') ?? null;

describe('Q4 candidate gates: boundaries absent from PR282 author tests', () => {
  it('Messages SSE preserves every signature increment, not only the OpenAI adapter increments', async () => {
    const result = await handleMessages({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }] }, {
      async handleChatCompletions() {
        return { status: 200, stream: true, async handler(res) {
          res.write(chunk({ reasoning_content: 'think' }));
          res.write(chunk({ reasoning_signature: 'Ep' }));
          res.write(chunk({ reasoning_signature: 'kC' }));
          res.write(chunk({ content: 'answer' }));
          res.write(`data: ${JSON.stringify({ id: 'q4', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
        } };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const signature = [...res.body.matchAll(/"type":"signature_delta","signature":"([^"]*)"/g)].map(m => m[1]).join('');
    assert.equal(signature, 'EpkC');
  });

  for (const nativeToolCall of [false, true]) {
    it(`signed reasoning-only assistant survives nativeToolCall=${nativeToolCall}`, () => {
      const messages = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: null, reasoning_content: 'signed-only', reasoning_signature: SIG },
        { role: 'user', content: 'next' },
      ];
      const proto = buildGetChatMessageRequest({ token: 'offline-fixture', model: 'm', messages, nativeToolCall, env: {} });
      const assistant = wireChats(proto).filter(c => Number(getField(c, 2, 0).value) === __testing.SOURCE.ASSISTANT);
      assert.equal(assistant.length, 1);
      assert.equal(str(assistant[0], 11), 'signed-only');
      assert.equal(str(assistant[0], 12), SIG);
    });
  }

  it('negative control: unsigned empty assistant remains dropped', () => {
    const proto = buildGetChatMessageRequest({ token: 'offline-fixture', model: 'm', env: {}, messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: null, reasoning_content: 'unsigned-only' },
      { role: 'user', content: 'next' },
    ] });
    assert.equal(wireChats(proto).filter(c => Number(getField(c, 2, 0).value) === __testing.SOURCE.ASSISTANT).length, 0);
  });
});

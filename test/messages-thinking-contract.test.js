import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';

function chatChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      const cbs = listeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseAnthropicEvents(raw) {
  return raw
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const lines = frame.split('\n');
      return {
        event: lines.find(line => line.startsWith('event: '))?.slice(7),
        data: JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'),
      };
    });
}

describe('Thinking outbound contract (messages handler)', () => {
  it('(a) non-stream: reasoning_content -> thinking block, signature always present ("" when reasoning_signature missing)', async () => {
    // Case 1: reasoning_content without reasoning_signature (signature key kept as "")
    const resNoSig = await handleMessages({
      model: 'claude-sonnet-4.6',
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          body: {
            model: 'claude-sonnet-4.6',
            choices: [{
              index: 0,
              message: { role: 'assistant', reasoning_content: 'thought process', content: 'hello world' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        };
      },
    });

    assert.equal(resNoSig.status, 200);
    const thinkingNoSig = resNoSig.body.content.find(c => c.type === 'thinking');
    assert.ok(thinkingNoSig, 'thinking block should be emitted');
    assert.equal(thinkingNoSig.thinking, 'thought process');
    assert.equal(thinkingNoSig.signature, '', 'signature must be "" (key present) when reasoning_signature is missing');

    // Case 2: reasoning_content WITH reasoning_signature (signature forwarded verbatim)
    const resWithSig = await handleMessages({
      model: 'claude-sonnet-4.6',
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          body: {
            model: 'claude-sonnet-4.6',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                reasoning_content: 'thought process',
                reasoning_signature: 'valid_sig_123',
                content: 'hello world',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        };
      },
    });

    assert.equal(resWithSig.status, 200);
    const thinkingWithSig = resWithSig.body.content.find(c => c.type === 'thinking');
    assert.ok(thinkingWithSig, 'thinking block should be emitted');
    assert.equal(thinkingWithSig.thinking, 'thought process');
    assert.equal(thinkingWithSig.signature, 'valid_sig_123', 'signature must match reasoning_signature');
  });

  it('(b) stream: signature_delta before content_block_stop ONLY when reasoning_signature present', async () => {
    // Case 1: streaming thinking without signature (no signature_delta event)
    const streamNoSig = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'thinking chunk' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const resFake1 = fakeRes();
    await streamNoSig.handler(resFake1);
    const events1 = parseAnthropicEvents(resFake1.body);
    const sigDeltas1 = events1.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'signature_delta');
    assert.equal(sigDeltas1.length, 0, 'no signature_delta should be emitted when reasoning_signature is absent');
    const thinkingStart1 = events1.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking');
    assert.equal(thinkingStart1.data.content_block.signature, '', 'thinking content_block_start must carry signature key');

    // Case 2: streaming thinking WITH signature (signature_delta emitted right before content_block_stop for thinking block)
    const streamWithSig = await handleMessages({
      model: 'claude-sonnet-4.6',
      stream: true,
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'thinking chunk', reasoning_signature: 'sig_stream_999' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });

    const resFake2 = fakeRes();
    await streamWithSig.handler(resFake2);
    const events2 = parseAnthropicEvents(resFake2.body);

    const thinkingStartIdx = events2.findIndex(e => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking');
    assert.ok(thinkingStartIdx !== -1, 'content_block_start thinking event must exist');

    const thinkingStopIdx = events2.findIndex((e, idx) => idx > thinkingStartIdx && e.event === 'content_block_stop' && e.data.index === events2[thinkingStartIdx].data.index);
    assert.ok(thinkingStopIdx !== -1, 'content_block_stop for thinking block must exist');

    const sigDeltaEvent = events2[thinkingStopIdx - 1];
    assert.equal(sigDeltaEvent.event, 'content_block_delta', 'event immediately before content_block_stop must be content_block_delta');
    assert.equal(sigDeltaEvent.data.delta?.type, 'signature_delta', 'delta type must be signature_delta');
    assert.equal(sigDeltaEvent.data.delta?.signature, 'sig_stream_999', 'signature must match reasoning_signature');
  });

  it('concatenates multiple signature chunks into one delta before block stop', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'go' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200, stream: true,
          async handler(res) {
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_content: 'think', reasoning_signature: 'Ep' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: { reasoning_signature: 'kC' }, finish_reason: null }] }));
            res.write(chatChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const events = parseAnthropicEvents(res.body);
    const signatureDeltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'signature_delta');
    assert.equal(signatureDeltas.length, 1, 'exactly one non-empty signature_delta');
    assert.equal(signatureDeltas[0].data.delta.signature, 'EpkC');
    assert.ok(events.indexOf(signatureDeltas[0]) < events.findIndex(e => e.event === 'content_block_stop'));
  });
});

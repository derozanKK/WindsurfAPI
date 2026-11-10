// F5 (DataAuditTools findings): the Gemini frontend dropped
// `generationConfig.topK` while /v1/messages forwards the same knob as `top_k`
// and the DEVIN_CONNECT chat path turns `top_k` into CompletionConfig.topK
// (chat.js "Forward client sampling controls", pinned by
// test/devin-connect-failover.test.js "forwards temperature/top_p/top_k/
// max_tokens"). Gemini was the one surface that never filled the field, so a
// caller's determinism/quality knob silently did nothing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { geminiToOpenAI, handleGemini } from '../src/handlers/gemini.js';

const OK_CHAT = {
  status: 200,
  body: {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'gemini-2.5-pro',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
};

describe('gemini generationConfig.topK', () => {
  it('maps topK onto the internal top_k next to top_p', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { topK: 40, topP: 0.9, temperature: 0.4 },
    }, 'gemini-2.5-pro');
    assert.equal(out.top_k, 40);
    assert.equal(out.top_p, 0.9);
    assert.equal(out.temperature, 0.4);
  });

  it('omits top_k when the caller sends no topK', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { topP: 0.9 },
    }, 'gemini-2.5-pro');
    assert.equal('top_k' in out, false, 'no top_k key when the caller sent none');
  });

  it('carries top_k through handleGemini to the chat handler', async () => {
    let captured = null;
    const r = await handleGemini(
      'gemini-2.5-pro',
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { topK: 40 },
      },
      { handleChatCompletions: async (body) => { captured = body; return OK_CHAT; } },
      { stream: false },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(captured.top_k, 40, 'top_k reaches the chat handler, which forwards it to CompletionConfig.topK');
  });
});

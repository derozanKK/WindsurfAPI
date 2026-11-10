// F2 (DataAuditTools findings): `generationConfig.candidateCount` was never
// read by geminiToOpenAI, so the chat route's `n` gate was unreachable from
// this surface. A client that set candidateCount:2 got a 200 with a single
// candidate — sampling/voting code then read `candidates[1]` as undefined, the
// exact failure shape the chat `n` gate exists to prevent. Mirror that gate
// here: only 1 is honourable, and the refusal must be a Gemini-shaped
// INVALID_ARGUMENT that names the field and the fix.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleGemini } from '../src/handlers/gemini.js';

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

function geminiBody(generationConfig) {
  return {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    ...(generationConfig ? { generationConfig } : {}),
  };
}

describe('gemini generationConfig.candidateCount', () => {
  it('rejects candidateCount>1 with 400 INVALID_ARGUMENT naming candidateCount (non-stream)', async () => {
    let called = false;
    const r = await handleGemini(
      'gemini-2.5-pro',
      geminiBody({ candidateCount: 2 }),
      { handleChatCompletions: async () => { called = true; return OK_CHAT; } },
      { stream: false },
    );
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.status, 'INVALID_ARGUMENT');
    assert.match(r.body.error.message, /candidateCount/, 'the caller must be told which field was refused');
    assert.match(r.body.error.message, /candidateCount=1/, 'and what value is supported');
    assert.equal(called, false, 'no model turn may run for a request that cannot be honoured');
  });

  it('rejects candidateCount>1 on the streaming path too, before any byte is streamed', async () => {
    let called = false;
    const r = await handleGemini(
      'gemini-2.5-pro',
      geminiBody({ candidateCount: 3 }),
      { handleChatCompletions: async () => { called = true; return OK_CHAT; } },
      { stream: true },
    );
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.stream, undefined, 'a refused request must not return a stream handler');
    assert.equal(r.body.error.status, 'INVALID_ARGUMENT');
    assert.match(r.body.error.message, /candidateCount/);
    assert.equal(called, false);
  });

  it('passes candidateCount:1 through and omits it from the chat body (1 is the only supported value)', async () => {
    let captured = null;
    const r = await handleGemini(
      'gemini-2.5-pro',
      geminiBody({ candidateCount: 1, temperature: 0.2 }),
      { handleChatCompletions: async (body) => { captured = body; return OK_CHAT; } },
      { stream: false },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(captured, 'chat handler called');
    assert.equal('n' in captured, false, 'candidateCount is not forwarded as n — 1 is the default');
    assert.equal(captured.temperature, 0.2, 'other generationConfig fields still map');
  });

  it('leaves a request with no candidateCount untouched', async () => {
    let captured = null;
    const r = await handleGemini(
      'gemini-2.5-pro',
      geminiBody(undefined),
      { handleChatCompletions: async (body) => { captured = body; return OK_CHAT; } },
      { stream: false },
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal('n' in captured, false);
  });
});

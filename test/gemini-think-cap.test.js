// Live finding (evidence/ToolMatrixLive.md, flag 2): `gemini-3-6-flash-medium`
// max_tokens does not bound thinking. Probes returned completion_tokens 105
// under max_tokens:64 and 271 under max_tokens:128 while the visible answer was
// a short string — the upstream counts thinking in completion_tokens but spends
// it OUTSIDE the cap.
//
// The adapter cannot retroactively enforce the cap: the only exact token count
// is the upstream's, and it arrives on the terminal frame after every delta has
// already been delivered. Cutting on a chars/4 estimate would drop delivered
// content mid-answer and could report a complete answer as truncated. So the
// honest contract is: when completion_tokens (thinking included) reaches or
// passes the caller's cap, the turn must NOT report a clean 'stop' — it reports
// 'length'. Nothing already delivered is retracted or truncated.
//
// These tests drive the real adapters through the fake-generator seam
// (__setStreamChatForTest), exactly as the live shape arrives: N thinking
// tokens under a smaller cap, then a short visible answer, then a finish event
// whose usage reports the upstream's full count.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toChatCompletion,
  streamChatCompletion,
  __setStreamChatForTest,
} from '../src/devin-connect-openai.js';
import { applyOutputCap, resolveFinishReason } from '../src/devin-connect.js';

afterEach(() => __setStreamChatForTest(null));

const MODEL = 'gemini-3-6-flash-medium';

// A fake generator that emits `thinkingTokens` reasoning deltas (one token-ish
// word each), a visible answer, and the upstream's usage block. This mirrors
// the measured live stream: thinking first, then the short answer, then a
// terminal frame reporting completion_tokens INCLUDING the thinking.
function fakeGenerator({ thinkingTokens, cap, answer = 'PONG', finishReason = 'stop', contentChunks = null }) {
  return async function* (params) {
    assert.equal(params.completion?.maxTokens, cap, 'the requested cap must reach the generator');
    for (let i = 0; i < thinkingTokens; i++) {
      yield { type: 'reasoning', text: `thought${i} ` };
    }
    const chunks = contentChunks || [answer];
    for (const chunk of chunks) {
      if (chunk) yield { type: 'content', text: chunk };
    }
    yield {
      type: 'finish',
      reason: finishReason,
      usage: {
        prompt_tokens: 12,
        completion_tokens: thinkingTokens + 1,
        total_tokens: 13 + thinkingTokens,
      },
    };
  };
}

function connectParams(cap) {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    completion: { maxTokens: cap },
  };
}

describe('max_tokens vs thinking (live: gemini-3-6-flash-medium)', () => {
  it('non-stream: thinking overrun reports length and keeps every delivered token', async () => {
    // Live shape: 105 completion tokens under max_tokens:64, short answer.
    __setStreamChatForTest(fakeGenerator({ thinkingTokens: 104, cap: 64 }));
    const { status, body } = await toChatCompletion(connectParams(64));

    assert.equal(status, 200);
    const choice = body.choices[0];
    assert.equal(choice.finish_reason, 'length',
      'completion_tokens 105 > cap 64 is a budget overrun, not a clean stop');
    assert.equal(choice.message.content, 'PONG', 'the visible answer must survive intact');
    const reasoning = choice.message.reasoning_content || '';
    assert.equal(reasoning, Array.from({ length: 104 }, (_, i) => `thought${i} `).join(''),
      'every thinking delta must be delivered — the overrun is reported, not hidden');
    assert.equal(body.usage.completion_tokens, 105,
      'usage keeps the upstream count so clients can see what was actually spent');
  });

  it('non-stream: the 128-cap / 271-token live shape reports length', async () => {
    __setStreamChatForTest(fakeGenerator({ thinkingTokens: 270, cap: 128 }));
    const { body } = await toChatCompletion(connectParams(128));
    assert.equal(body.choices[0].finish_reason, 'length');
    assert.equal(body.choices[0].message.content, 'PONG');
  });

  it('non-stream: a turn under the cap is still a clean stop (no false truncation)', async () => {
    __setStreamChatForTest(fakeGenerator({ thinkingTokens: 20, cap: 64 }));
    const { body } = await toChatCompletion(connectParams(64));
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.choices[0].message.content, 'PONG');
  });

  it('non-stream: landing exactly on the cap stays length (existing contract)', async () => {
    // completion_tokens = 64 exactly.
    __setStreamChatForTest(fakeGenerator({ thinkingTokens: 63, cap: 64 }));
    const { body } = await toChatCompletion(connectParams(64));
    assert.equal(body.choices[0].finish_reason, 'length');
  });

  it('non-stream: a stronger terminal state is never overwritten by the cap check', async () => {
    __setStreamChatForTest(fakeGenerator({ thinkingTokens: 104, cap: 64, finishReason: 'tool_calls' }));
    const { body } = await toChatCompletion(connectParams(64));
    assert.equal(body.choices[0].finish_reason, 'tool_calls',
      'tool_calls / content_filter describe what the turn DID; a budget overrun must not relabel it');

    __setStreamChatForTest(fakeGenerator({ thinkingTokens: 104, cap: 64, finishReason: 'content_filter' }));
    const second = await toChatCompletion(connectParams(64));
    assert.equal(second.body.choices[0].finish_reason, 'content_filter');
  });

  it('stream: every delta is delivered before the terminal length frame (nothing dropped mid-chunk)', async () => {
    const contentChunks = ['full ', 'answer ', 'beyond the cap'];
    __setStreamChatForTest(fakeGenerator({ thinkingTokens: 104, cap: 64, contentChunks }));

    const frames = [];
    const send = (frame) => frames.push(frame);
    const result = await streamChatCompletion(connectParams(64), send, { emulateTools: false });

    // Nothing is truncated: the chunk that crosses the cap boundary is emitted
    // whole, and every reasoning delta is still on the wire.
    const contentDeltas = frames.flatMap((f) => f.choices || []).map((c) => c.delta?.content).filter(Boolean);
    assert.equal(contentDeltas.join(''), contentChunks.join(''),
      'the visible answer must be delivered in full');
    const reasoningDeltas = frames.flatMap((f) => f.choices || []).map((c) => c.delta?.reasoning_content).filter(Boolean);
    assert.equal(reasoningDeltas.length, 104, 'no thinking delta may be dropped');

    const terminal = frames.filter((f) => (f.choices || []).some((c) => c.finish_reason));
    assert.equal(terminal.length, 1, 'exactly one terminal frame');
    assert.equal(terminal[0].choices[0].finish_reason, 'length');
    assert.equal(result.finish_reason, 'length', 'the assembled result agrees with the wire');

    // The terminal frame comes AFTER the content it describes.
    const finishIdx = frames.indexOf(terminal[0]);
    const lastContentIdx = frames.findLastIndex((f) => (f.choices || []).some((c) => c.delta?.content));
    assert.ok(lastContentIdx < finishIdx, 'finish must follow all delivered content');
  });

  it('stream: a turn under the cap still ends with stop', async () => {
    __setStreamChatForTest(fakeGenerator({ thinkingTokens: 20, cap: 64 }));
    const frames = [];
    const result = await streamChatCompletion(connectParams(64), (f) => frames.push(f), { emulateTools: false });
    assert.equal(result.finish_reason, 'stop');
    assert.equal(frames.filter((f) => (f.choices || []).some((c) => c.finish_reason))[0].choices[0].finish_reason, 'stop');
  });
});

describe('applyOutputCap — the single cap rule shared by the wire and the adapter', () => {
  it('upgrades a clean stop when completion_tokens reaches or passes the cap', () => {
    assert.equal(applyOutputCap('stop', { completion_tokens: 64 }, 64), 'length');
    assert.equal(applyOutputCap('stop', { completion_tokens: 105 }, 64), 'length');
    assert.equal(applyOutputCap('stop', { completion_tokens: 271 }, 128), 'length');
    assert.equal(applyOutputCap('stop', { completion_tokens: 63 }, 64), 'stop');
  });

  it('never relabels a stronger state', () => {
    for (const reason of ['tool_calls', 'content_filter', 'error', 'length']) {
      assert.equal(applyOutputCap(reason, { completion_tokens: 999 }, 64), reason);
    }
  });

  it('does nothing without a usable cap or usage', () => {
    assert.equal(applyOutputCap('stop', { completion_tokens: 999 }, null), 'stop');
    assert.equal(applyOutputCap('stop', { completion_tokens: 999 }, 0), 'stop');
    assert.equal(applyOutputCap('stop', null, 64), 'stop');
    assert.equal(applyOutputCap('stop', {}, 64), 'stop');
  });
});

describe('resolveFinishReason — overrun is no longer invisible to the wire layer', () => {
  it('reports length when thinking pushes completion past the cap', () => {
    // The exact pre-fix blind spot: equality-only missed every overrun.
    assert.equal(resolveFinishReason(2, { completion_tokens: 105 }, 64, {}), 'length');
    assert.equal(resolveFinishReason(4, { completion_tokens: 271 }, 128, {}), 'length');
    assert.equal(resolveFinishReason(2, { completion_tokens: 129 }, 128, {}), 'length');
  });

  it('keeps the under-cap and equality behaviour', () => {
    assert.equal(resolveFinishReason(2, { completion_tokens: 127 }, 128, {}), 'stop');
    assert.equal(resolveFinishReason(2, { completion_tokens: 128 }, 128, {}), 'length');
  });

  it('an operator override still wins over the usage inference', () => {
    assert.equal(
      resolveFinishReason(2, { completion_tokens: 271 }, 128, { DEVIN_CONNECT_STOP_REASON_MAP: '2=stop' }),
      'stop',
      'an operator who captured the real integers outranks this inference',
    );
  });

  it('a stronger enum still wins', () => {
    assert.equal(resolveFinishReason(10, { completion_tokens: 271 }, 128, {}), 'tool_calls');
    assert.equal(resolveFinishReason(11, { completion_tokens: 271 }, 128, {}), 'content_filter');
  });
});

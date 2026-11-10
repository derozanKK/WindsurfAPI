import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  streamChatCompletion,
  __setStreamChatForTest,
} from '../src/devin-connect-openai.js';

// Regression coverage for the deferred role-priming fix: the role-priming chunk
// must NOT be sent before the upstream demonstrably opens, otherwise the very
// first send() flips `emitted=true` in handlers/chat.js and disarms the
// !emitted-gated account recovery branches (re-login / failover), and it would
// also make the adapter's own pre-emit transport retry look unsafe.
// See src/devin-connect-openai.js streamChatCompletion §1.

afterEach(() => {
  __setStreamChatForTest(null);
  delete process.env.DEVIN_CONNECT_EAGER_PRIME;
});

function fakeStream(events) {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

function collectSend() {
  const frames = [];
  return { send: (d) => frames.push(d), frames };
}

const isRole = (f) => f.choices[0]?.delta?.role === 'assistant';

describe('streamChatCompletion deferred priming (recovery safety)', () => {
  it('does NOT prime when the FIRST upstream event is a transient error (recovery stays armed)', async () => {
    // Mirror the caller: `emitted` flips true on the first send(). If the prime
    // fired before the throw, emitted would be true and recovery disarmed.
    let emitted = false;
    const send = () => { emitted = true; };
    __setStreamChatForTest(async function* () {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      // eslint-disable-next-line no-unreachable
      yield;
    });
    await assert.rejects(
      streamChatCompletion({ model: 'm', messages: [] }, send, { id: 'x', created: 1 }),
      /reset/,
    );
    assert.equal(emitted, false, 'no byte on the wire → caller can still recover');
  });

  it('propagates a pre-open error without sending ANY frame', async () => {
    const { send, frames } = collectSend();
    __setStreamChatForTest(async function* () {
      throw Object.assign(new Error('unauthorized'), { code: 'UNAUTHORIZED' });
      // eslint-disable-next-line no-unreachable
      yield;
    });
    await assert.rejects(
      streamChatCompletion({ model: 'm', messages: [] }, send, { id: 'x', created: 1 }),
      /unauthorized/,
    );
    assert.equal(frames.length, 0, 'zero frames emitted before upstream opened');
  });

  it('a normal stream produces the SAME event sequence as before (role → reasoning → content → finish → usage)', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'reasoning', text: 'let me think ' },
      { type: 'reasoning', text: 'about it.' },
      { type: 'content', text: 'The answer ' },
      { type: 'content', text: 'is 42.' },
      { type: 'finish', reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send, { id: 'x', created: 1, includeUsage: true });

    // role chunk is first, and identical to today's shape.
    assert.deepEqual(frames[0].choices[0].delta, { role: 'assistant', content: '' });
    assert.equal(frames.filter(isRole).length, 1, 'exactly one role chunk');

    const kinds = frames.map((f) => {
      const d = f.choices[0]?.delta;
      if (isRole(f)) return 'role';
      if (d?.reasoning_content != null) return 'reasoning';
      if (f.choices.length === 0) return 'usage';
      if (f.choices[0]?.finish_reason) return 'finish';
      if (d?.content != null) return 'content';
      return '?';
    });
    assert.deepEqual(kinds, ['role', 'reasoning', 'reasoning', 'content', 'content', 'finish', 'usage']);

    const finish = frames.find((f) => f.choices[0]?.finish_reason === 'stop');
    assert.deepEqual(finish.choices[0].delta, {});
    assert.equal(result.content, 'The answer is 42.');
    assert.equal(result.reasoning, 'let me think about it.');
    assert.equal(result.finish_reason, 'stop');
  });

  it('role chunk is deferred until AFTER the first delta arrives (prime is lazy)', async () => {
    // The first frame emitted is the role chunk, but crucially it is only sent
    // once the generator has produced its first real event — proven by the
    // send happening at all (a pre-open throw would send nothing, see above).
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'hi' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    await streamChatCompletion({ model: 'm', messages: [] }, send);
    assert.ok(isRole(frames[0]), 'role chunk leads');
    assert.equal(frames[1].choices[0].delta.content, 'hi', 'then the content delta');
  });

  it('an empty / immediate-finish stream still yields a valid finished stream (role → finish)', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send, { id: 'x', created: 1 });

    // Even with no delta, the client gets a well-formed stream: role then finish.
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[0].choices[0].delta, { role: 'assistant', content: '' });
    assert.deepEqual(frames[1].choices[0].delta, {});
    assert.equal(frames[1].choices[0].finish_reason, 'stop');
    assert.equal(result.content, '');
    assert.equal(result.finish_reason, 'stop');
  });

  it('an empty stream with usage opt-in still emits the trailing usage frame', async () => {
    __setStreamChatForTest(fakeStream([
      { type: 'finish', reason: 'stop', usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } },
    ]));
    const { send, frames } = collectSend();
    await streamChatCompletion({ model: 'm', messages: [] }, send, { includeUsage: true });
    assert.equal(frames.length, 3); // role, finish, usage
    assert.deepEqual(frames[0].choices[0].delta, { role: 'assistant', content: '' });
    assert.equal(frames[1].choices[0].finish_reason, 'stop');
    assert.deepEqual(frames[2].choices, []);
    assert.deepEqual(frames[2].usage, { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 });
  });

  it('a mid-stream error AFTER a real delta keeps behavior unchanged (already emitted → propagates)', async () => {
    // Once a real delta has streamed, prime has fired and the caller's `emitted`
    // is true; a subsequent throw is a genuine mid-stream failure that must NOT
    // be silently swallowed here. It propagates for the caller to surface.
    let emitted = false;
    const send = () => { emitted = true; };
    __setStreamChatForTest(async function* () {
      yield { type: 'content', text: 'partial' };
      throw Object.assign(new Error('mid'), { code: 'ECONNRESET' });
    });
    await assert.rejects(
      streamChatCompletion({ model: 'm', messages: [] }, send),
      /mid/,
    );
    assert.equal(emitted, true, 'a delta already reached the wire before the error');
  });

  it('DEVIN_CONNECT_EAGER_PRIME=1 restores the legacy eager role chunk', async () => {
    process.env.DEVIN_CONNECT_EAGER_PRIME = '1';
    let framesBeforeThrow = 0;
    const send = () => { framesBeforeThrow++; };
    __setStreamChatForTest(async function* () {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      // eslint-disable-next-line no-unreachable
      yield;
    });
    // With the opt-in, the role chunk is sent eagerly BEFORE the upstream opens,
    // so the frame lands even though the stream then throws (legacy behavior).
    await assert.rejects(
      streamChatCompletion({ model: 'm', messages: [] }, send),
      /reset/,
    );
    assert.equal(framesBeforeThrow, 1, 'eager prime sent the role chunk up front');
  });

  it('a tool_call is treated as a real delta and primes the stream', async () => {
    __setStreamChatForTest(fakeStream([
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ id: 'c1', name: 'a', arguments: '{}' }],
      },
    ]));
    const { send, frames } = collectSend();
    const result = await streamChatCompletion({ model: 'm', messages: [] }, send);
    // role chunk precedes the tool_calls delta.
    assert.ok(isRole(frames[0]), 'role chunk leads');
    const toolFrame = frames.find((f) => f.choices[0]?.delta?.tool_calls);
    assert.ok(toolFrame, 'tool_calls delta emitted');
    assert.equal(frames.filter(isRole).length, 1, 'exactly one role chunk');
    assert.equal(result.finish_reason, 'tool_calls');
  });
});

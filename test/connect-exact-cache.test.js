// DEVIN_CONNECT exact-match cache: the outer slot must cover the stream path
// (the inner cascade cache is unreachable once the connect short-circuit fires)
// and must replay the stored finish reason instead of flattening it to 'stop'.
//
// These drive the real handler with the connect network calls mocked, so no
// token or socket is touched. The cache is process-global; every test clears it.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount, markRateLimited } from '../src/auth.js';
import { cacheClear, cacheGet, cacheKey, cacheSet, cacheStats } from '../src/cache.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import { streamChatCompletion as realStreamChatCompletion, __setStreamChatForTest } from '../src/devin-connect-openai.js';
import { getSessionReasoningTrail, _resetForTests as resetSessionContinuity } from '../src/session-continuity.js';

const CALLER = 'api:test:user:connect-cache';
const MODEL = 'swe-1-6-slow';
const created = [];
const saved = {};
let defaultAccount = null;

function seed() {
  const a = addAccountByKey(`devin-session-token$cache-${Math.random().toString(36).slice(2)}`, 'cache-test');
  created.push(a.id);
  return a;
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseFrames(raw) {
  return raw.split('\n\n').filter(Boolean).filter(f => !f.startsWith(':')).map(f => {
    const data = f.split('\n').find(line => line.startsWith('data: '))?.slice(6) || '';
    return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
  });
}

function body(extra = {}) {
  return { model: MODEL, messages: [{ role: 'user', content: 'hi' }], __callerKey: CALLER, ...extra };
}

function nonStream(content, finishReason = 'stop', extraMessage = {}) {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-cache-test', object: 'chat.completion', created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content, ...extraMessage }, finish_reason: finishReason }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  };
}

beforeEach(() => {
  saved.DEVIN_CONNECT = process.env.DEVIN_CONNECT;
  process.env.DEVIN_CONNECT = '1';
  cacheClear();
  defaultAccount = seed();
});

afterEach(() => {
  __resetConnectDeps();
  __setStreamChatForTest(null);
  resetSessionContinuity();
  cacheClear();
  while (created.length) removeAccount(created.pop());
  if (saved.DEVIN_CONNECT === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = saved.DEVIN_CONNECT;
  delete process.env.DEVIN_CONNECT_SESSION_REUSE;
  delete process.env.DEVIN_CONNECT_SESSION_REASONING_INJECT;
  delete process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS;
});

describe('DEVIN_CONNECT exact cache', () => {
  it('serves a repeated non-stream request without calling upstream and keeps finish_reason=length', async () => {
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => { calls++; return nonStream('cached answer', 'length'); },
    });

    const first = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(first.status, 200);
    assert.equal(calls, 1);

    const second = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(calls, 1, 'the second request must be served from the cache');
    assert.equal(second.status, 200);
    assert.equal(second.body.choices[0].message.content, 'cached answer');
    assert.equal(second.body.choices[0].finish_reason, 'length',
      'a cached truncation must not be replayed as a clean stop');
    assert.ok(cacheStats().hits >= 1);
  });

  it('serves a repeated stream request without calling upstream and keeps finish_reason=length', async () => {
    let calls = 0;
    __setConnectDeps({
      streamChatCompletion: async () => {
        calls++;
        return { content: 'streamed answer', reasoning: '', finish_reason: 'length',
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, toolCalls: [] };
      },
    });

    const first = await handleChatCompletions(body({ stream: true, stream_options: { include_usage: true } }), { callerKey: CALLER });
    assert.equal(first.status, 200);
    await first.handler(fakeRes());
    assert.equal(calls, 1);

    const second = await handleChatCompletions(body({ stream: true, stream_options: { include_usage: true } }), { callerKey: CALLER });
    const res = fakeRes();
    await second.handler(res);
    assert.equal(calls, 1, 'the second stream must be served from the cache');

    const frames = parseFrames(res.body);
    const finish = frames.find(frame => frame.choices?.[0]?.finish_reason);
    assert.ok(finish, 'a finish chunk must be emitted');
    assert.equal(finish.choices[0].finish_reason, 'length');
    assert.equal(frames.at(-1), '[DONE]');
  });

  it('serves a cache hit even when every pooled account is rate-limited', async () => {
    markRateLimited(defaultAccount.apiKey, 60_000);
    cacheSet(cacheKey(body(), CALLER), {
      text: 'cached despite 429', thinking: '', finishReason: 'stop',
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => { calls++; return nonStream('upstream should not run'); },
    });

    const result = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'cached despite 429');
    assert.equal(calls, 0, 'a cache hit must not acquire or call an upstream account');
  });

  it('does not cache tool-call turns', async () => {
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => {
        calls++;
        return nonStream(null, 'tool_calls', {
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
        });
      },
    });

    const first = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(first.status, 200);
    const second = await handleChatCompletions(body(), { callerKey: CALLER });
    assert.equal(second.status, 200);
    assert.equal(calls, 2, 'a tool-call turn must not populate the text cache');
  });

  it('does not cache without a trustworthy per-user scope', async () => {
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => { calls++; return nonStream('uncached'); },
    });
    const unscoped = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] };

    await handleChatCompletions(unscoped, { callerKey: '' });
    await handleChatCompletions(unscoped, { callerKey: '' });
    assert.equal(calls, 2, 'a bare API key must not share a response-cache slot');
  });

  it('replays the stored stop sequence for the internal Messages carrier', async () => {
    let calls = 0;
    __setConnectDeps({
      toChatCompletion: async () => {
        calls++;
        // The real adapter already applied stop and returns the truncated text;
        // it carries the matched cause on `stop` because the text no longer has it.
        return Object.assign(nonStream('hello ', 'stop'), { stop: 'END' });
      },
    });

    const request = body({ stop: ['END'] });
    const first = await handleChatCompletions(request, { callerKey: CALLER });
    assert.equal(first.status, 200);
    assert.equal(calls, 1);

    const second = await handleChatCompletions(request, { callerKey: CALLER, __messagesStopCarrier: true });
    assert.equal(calls, 1);
    assert.equal(second.body.choices[0].message.content, 'hello ');
    assert.equal(second.body.choices[0]._windsurf_stop_sequence, 'END',
      'the carrier must survive the cache replay, not just the live turn');
  });

  it('replays the stored stop sequence on the stream carrier too', async () => {
    let calls = 0;
    __setConnectDeps({
      streamChatCompletion: async () => {
        calls++;
        return { content: 'hello END world', reasoning: '', finish_reason: 'stop',
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, toolCalls: [] };
      },
    });

    const request = body({ stream: true, stop: ['END'] });
    const first = await handleChatCompletions(request, { callerKey: CALLER });
    await first.handler(fakeRes());
    assert.equal(calls, 1);

    const second = await handleChatCompletions(request, { callerKey: CALLER, __messagesStopCarrier: true });
    const res = fakeRes();
    await second.handler(res);
    assert.equal(calls, 1);
    const finish = parseFrames(res.body).find(frame => frame.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0]._windsurf_stop_sequence, 'END');
  });

  // P-04: a rescue REPLACES an attempt. The wire, the returned value (which the
  // handler stores as the cache's `thinking` and commits to session continuity),
  // the cache replay and the next turn's continuity trail must all name the SAME
  // attempt. Before the fix the generator emitted ABANDONED reasoning deltas from
  // attempt 1 while `result.reasoning` — and therefore every stored surface — held
  // only attempt 2's FINAL reasoning.
  it('P-04: commits one rescued attempt to the wire, the cache and session continuity', async () => {
    process.env.DEVIN_CONNECT_SESSION_REUSE = '1';
    process.env.DEVIN_CONNECT_SESSION_REASONING_INJECT = '1';
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    resetSessionContinuity();
    cacheClear();

    let attempts = 0;
    __setStreamChatForTest(async function* () {
      attempts++;
      if (attempts === 1) {
        yield { type: 'reasoning', text: 'ABANDONED-1 ' };
        yield { type: 'reasoning', text: 'ABANDONED-2 ' };
        yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } };
        return;
      }
      yield { type: 'reasoning', text: 'FINAL-1 ' };
      yield { type: 'reasoning', text: 'FINAL-2' };
      yield { type: 'content', text: 'the answer' };
      yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 6, completion_tokens: 9, total_tokens: 15 } };
    });

    let captured = null;
    __setConnectDeps({
      // The real adapter over the scripted upstream: the cache/continuity paths
      // below are driven by the actual streamChatCompletion return value, not a
      // hand-written stub that could hide the divergence.
      streamChatCompletion: async (...args) => {
        captured = await realStreamChatCompletion(...args);
        return captured;
      },
    });

    const request = () => ({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      __callerKey: CALLER,
    });

    const first = await handleChatCompletions(request(), { callerKey: CALLER });
    assert.equal(first.status, 200);
    const res1 = fakeRes();
    await first.handler(res1);
    assert.equal(attempts, 2, 'precondition: the rescue must have fired');

    const reasoningOf = (res) => parseFrames(res.body)
      .map((frame) => frame.choices?.[0]?.delta?.reasoning_content)
      .filter(Boolean)
      .join('');
    assert.equal(reasoningOf(res1), 'FINAL-1 FINAL-2',
      'the live stream must carry only the committed attempt');
    assert.ok(!res1.body.includes('ABANDONED'), 'no abandoned reasoning delta may reach the wire');
    assert.equal(captured.reasoning, 'FINAL-1 FINAL-2',
      'the returned value used for the cache and continuity must match the wire');

    // The stored value itself, not just its replay: `thinking` is the cache's
    // reasoning slot and `text` is what `delivered` accumulated.
    const cached = cacheGet(cacheKey(request(), CALLER));
    assert.ok(cached, 'the first stream must populate the response cache');
    assert.equal(cached.thinking, 'FINAL-1 FINAL-2',
      'the cached reasoning must be the committed attempt, never ABANDONED + FINAL');
    assert.equal(cached.text, 'the answer', 'the cached visible text must be the committed answer');

    // Cache replay: the same request must be served from the stored value and
    // must not resurrect the abandoned attempt.
    const second = await handleChatCompletions(request(), { callerKey: CALLER });
    assert.equal(second.status, 200);
    const res2 = fakeRes();
    await second.handler(res2);
    assert.equal(attempts, 2, 'the second request must be served from the cache');
    assert.equal(reasoningOf(res2), 'FINAL-1 FINAL-2',
      'cached replay must serve the same reasoning the client saw live');
    assert.ok(!res2.body.includes('ABANDONED'), 'cache replay must not resurrect the abandoned attempt');

    // Next-turn continuity: the trail is read from the committed pair.
    const trail = getSessionReasoningTrail(CALLER, [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'the answer' },
      { role: 'user', content: 'next' },
    ], { DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_SESSION_REASONING_INJECT: '1' });
    assert.ok(trail, 'a continuity trail must exist after the committed turn');
    assert.ok(trail.includes('FINAL-1 FINAL-2'), 'continuity must quote the committed reasoning');
    assert.ok(!trail.includes('ABANDONED'), 'continuity must not quote the abandoned attempt');
  });
});

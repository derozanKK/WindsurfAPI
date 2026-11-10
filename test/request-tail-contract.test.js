// The request-tail policy, pinned. Companion document: docs/REQUEST-TAIL-CONTRACT.md.
//
// Both 400s live in ONE block in the shared chat layer (src/handlers/chat.js,
// `_handleChatCompletionsInner`): predicate A rejects a conversation whose last
// non-system turn is not user/tool/function; predicate B rejects an empty NEWEST
// user turn, wherever it sits. That block returns before the stream branch, backend
// selection, account acquisition and the cache, so every surface inherits it — which
// is exactly why 8334cea moved the check into the shared layer (a per-route guard was
// both bypassable and over-rejecting). Where the assertion is about the guard itself,
// these tests drive the REAL handleChatCompletions rather than a mock: a mock would
// bypass the very thing under test.
//
// Why the 400s stay (measured, not stylistic): 8334cea measured that the upstream
// cannot serve an assistant-terminated conversation — it answers UPSTREAM_INTERNAL,
// which lands in reportInternalError, and two consecutive of those quarantine the
// account for 120s. 79cd990 (fix #28, OpenClaw probe scenario #14) measured that an
// empty user turn is answered against the system prompt as if it were the prompt,
// producing nonsense. Serving either shape is not a missing feature; it is a way to
// get a caller's account quarantined.
//
// The documented divergence: the Anthropic and Gemini converters drop turns that
// yield no text/image/tool BEFORE delegating to the shared layer, so those two
// surfaces serve the textless variants of both shapes. That difference is
// documented, not endorsed — these tests pin BOTH sides (drop → served, and
// kept-with-text → the same 400, re-enveloped in each surface's vocabulary) so a
// change in either direction reds a test and has to be argued.
//
// test/mutations/request-tail-contract.json holds the machine-checkable half: every
// mutant below must red this file.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleGemini } from '../src/handlers/gemini.js';
import { handleResponses } from '../src/handlers/responses.js';

const CTX = { callerKey: 'api:test:user:tail-contract' };

// Records every delegation to the shared layer and answers 200, so a test can
// assert both that the request was served and what the converter forwarded.
function fakeChat(reply = 'ok') {
  const calls = [];
  return {
    calls,
    handleChatCompletions: async (body) => {
      calls.push(body);
      return {
        status: 200,
        body: {
          model: body.model,
          choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        },
      };
    },
  };
}

const chatBody = (messages, extra = {}) => ({ model: 'claude-sonnet-4.6', max_tokens: 8, messages, ...extra });

describe('the shared guard rejects an empty newest user turn (predicate B)', () => {
  const emptyShapes = [
    ['empty string content', { role: 'user', content: '' }],
    ['empty part array', { role: 'user', content: [] }],
    ['whitespace-only text part', { role: 'user', content: [{ type: 'text', text: '   ' }] }],
  ];

  for (const [label, turn] of emptyShapes) {
    it(`rejects ${label} with 400 invalid_request_error`, async () => {
      const res = await handleChatCompletions(chatBody([{ role: 'user', content: 'hi' }, turn]), CTX);
      assert.equal(res.status, 400, `${label} must be rejected locally`);
      assert.equal(res.body.error.type, 'invalid_request_error');
      assert.equal(res.body.error.param, 'messages');
      assert.match(res.body.error.message, /last user message has empty content/);
    });
  }

  it('fires on the newest user turn anywhere, even when the tail is a tool result', async () => {
    // Measured on master at contract-write time: the predicate reads
    // `messages.filter(m => m.role === 'user').pop()`, so it polices the newest
    // user turn in the WHOLE array, not the tail. An agent loop that appends an
    // empty user turn mid-loop gets the 400 even though its tail (the tool
    // result) is answerable. Pinned so a relaxation of predicate B is deliberate.
    const res = await handleChatCompletions(chatBody([
      { role: 'user', content: '' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ]), CTX);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.param, 'messages');
    assert.match(res.body.error.message, /last user message has empty content/);
  });

  it('does not fire on a turn whose only content is a non-text part', async () => {
    // 79cd990 scoped the check to "pure-text empties only": image_url / file /
    // audio parts count as content. An image-only turn is therefore NOT one of
    // the shapes this contract rejects (it is served, subject to the rest of
    // the pipeline).
    const res = await handleChatCompletions(chatBody([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
    ]), CTX);
    assert.notEqual(res.status, 400, 'an image-only user turn must not be read as empty content');
  });
});

describe('the shared guard rejects a textless assistant tail (predicate A)', () => {
  it('an assistant turn with empty content is rejected like any assistant tail', async () => {
    // Content-independent: the answerable-role check never looks at the
    // assistant turn's content, so the textless variant is the same 400.
    const res = await handleChatCompletions(chatBody([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
    ]), CTX);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.type, 'invalid_request_error');
    assert.equal(res.body.error.param, 'messages');
    assert.match(res.body.error.message, /must end with a user message or a tool result/);
  });

  it('runs first: a conversation violating both predicates reports the assistant-tail error', async () => {
    // Predicate A is evaluated before predicate B, so an empty newest user turn
    // behind an assistant tail reports "must end with a user message…", not
    // "empty content". Pinned because swapping the two checks would otherwise
    // red nothing, and "which 400 wins" is a decision, not an accident.
    const res = await handleChatCompletions(chatBody([
      { role: 'user', content: '' },
      { role: 'assistant', content: 'x' },
    ]), CTX);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /must end with a user message or a tool result/);
    assert.doesNotMatch(res.body.error.message, /empty content/);
  });
});

describe('the guard runs before the streaming path', () => {
  it('a stream:true request with an empty newest user turn gets a plain 400, no SSE handler', async () => {
    // The guard returns from the shared layer before any stream branch exists
    // (the first stream branch is far below it). A rejected stream request must
    // therefore come back as an ordinary 400 result — no `stream`/`handler`
    // pair, so the router writes one JSON error and no SSE frame ever starts.
    const res = await handleChatCompletions(
      chatBody([{ role: 'user', content: 'hi' }, { role: 'user', content: '' }], { stream: true }),
      CTX,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.param, 'messages');
    assert.equal(res.stream, undefined, 'the guard must return before a stream handler is built');
  });
});

describe('the Anthropic surface: textless turns are dropped, so the guard never sees them', () => {
  it('an empty newest user turn is dropped and the request is served (documented difference)', async () => {
    // anthropicToOpenAI pushes a turn only when it yields text/image/tool; an
    // empty part array yields none and is dropped (messages.js, the push chain
    // around :729-741 has no final else). The delegated request therefore ends
    // on the earlier user turn and passes the shared guard.
    const fake = fakeChat();
    const res = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: [] }] },
      { ...CTX, handleChatCompletions: fake.handleChatCompletions },
    );
    assert.equal(res.status, 200, 'the textless turn is dropped, so the request is served');
    assert.equal(fake.calls.length, 1, 'the request must be delegated, not rejected');
    assert.deepEqual(fake.calls[0].messages, [{ role: 'user', content: 'hi' }]);
  });

  it('a textless assistant tail is dropped the same way', async () => {
    const fake = fakeChat();
    const res = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }] },
      { ...CTX, handleChatCompletions: fake.handleChatCompletions },
    );
    assert.equal(res.status, 200, 'a textless assistant turn never reaches the guard');
    assert.deepEqual(fake.calls[0].messages, [{ role: 'user', content: 'hi' }]);
  });

  it('an assistant tail WITH text is not dropped — the shared 400 is mapped to the Anthropic envelope', async () => {
    // The boundary of the divergence: once the turn yields text it survives
    // conversion and the guard sees the same assistant tail it rejects on the
    // chat surface.
    const res = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'The answer is' }] },
      CTX,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.type, 'error');
    assert.equal(res.body.error.type, 'invalid_request_error');
    assert.match(res.body.error.message, /must end with a user message or a tool result/);
  });

  it('the mapped 400 also covers stream:true — no SSE is started', async () => {
    const res = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'The answer is' }] },
      CTX,
    );
    assert.equal(res.status, 400);
    assert.equal(res.stream, undefined);
    assert.equal(res.body.error.type, 'invalid_request_error');
  });
});

describe('the Responses surface reaches the same guard', () => {
  it('an empty newest user turn given as an empty array is rejected with the shared 400', async () => {
    // normalizeMessageContent used to stringify a zero-length content array into
    // the two-character string "[]" (JSON.stringify([])), so this shape slipped
    // past predicate B and went upstream carrying literal junk instead of
    // receiving the same 400 the chat surface gives it. Pinned so the
    // conversion cannot quietly regress to "[]" again.
    const res = await handleResponses(
      { model: 'claude-sonnet-4.6', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, { role: 'user', content: [] }] },
      CTX,
    );
    assert.equal(res.status, 400, 'the responses surface must reach the shared empty-user 400');
    assert.equal(res.body.error.type, 'invalid_request_error');
    assert.equal(res.body.error.param, 'messages');
    assert.match(res.body.error.message, /last user message has empty content/);
  });
});

describe('the Gemini surface: textless turns are dropped, so the guard never sees them', () => {
  it('a trailing user turn with empty parts is dropped and the request is served (documented difference)', async () => {
    // geminiToOpenAI pushes a turn only when it yields text/image/tool; a `model`
    // turn maps to assistant, everything else to user. Empty parts yield nothing
    // and the turn is dropped (gemini.js, the push chain around :235-247).
    const fake = fakeChat();
    const res = await handleGemini(
      'gemini-2.5-pro',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'user', parts: [] }] },
      { ...CTX, handleChatCompletions: fake.handleChatCompletions },
      { stream: false },
    );
    assert.equal(res.status, 200, 'the textless turn is dropped, so the request is served');
    assert.equal(fake.calls.length, 1, 'the request must be delegated, not rejected');
    assert.deepEqual(fake.calls[0].messages, [{ role: 'user', content: 'hi' }]);
  });

  it('a textless trailing model turn is dropped the same way', async () => {
    const fake = fakeChat();
    const res = await handleGemini(
      'gemini-2.5-pro',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'model', parts: [] }] },
      { ...CTX, handleChatCompletions: fake.handleChatCompletions },
      { stream: false },
    );
    assert.equal(res.status, 200, 'a textless model turn never reaches the guard');
    assert.deepEqual(fake.calls[0].messages, [{ role: 'user', content: 'hi' }]);
  });

  it('a model tail WITH text is not dropped — mapped to INVALID_ARGUMENT 400', async () => {
    const res = await handleGemini(
      'gemini-2.5-pro',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'model', parts: [{ text: 'The answer is' }] }] },
      CTX,
      { stream: false },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 400);
    assert.equal(res.body.error.status, 'INVALID_ARGUMENT');
    assert.match(res.body.error.message, /must end with a user message or a tool result/);
  });

  it('the same 400 covers the streaming call — no SSE is started', async () => {
    const res = await handleGemini(
      'gemini-2.5-pro',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'model', parts: [{ text: 'The answer is' }] }] },
      CTX,
      { stream: true },
    );
    assert.equal(res.status, 400);
    assert.equal(res.stream, undefined);
    assert.equal(res.body.error.status, 'INVALID_ARGUMENT');
  });
});

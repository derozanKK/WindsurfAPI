// PR #274 review M1 — the shared-layer orphan-tool sweep must stay removed.
//
// 99ad55d deleted `repairUnanswerableMessages`, a pre-pass in chat.js that
// dropped orphan `tool` / `function` results across the WHOLE array using a
// seen-so-far id set. Re-adding that sweep is a regression on two counts:
//
//   * it drops a result whose matching call appears LATER in the history (the
//     seen-so-far trap tool-emulation.js:1099-1108 documents), and
//   * it pre-empts the documented opt-in rule: `stripOrphans` is OFF by default
//     and only the native tool wire passes `true`, so a shared-layer sweep
//     silently changes what every text-emulation path forwards.
//
// The policy is settled by docs/REQUEST-TAIL-CONTRACT.md: the shared layer does
// not drop message content. It rejects only the two unanswerable TAILS (400) and
// otherwise forwards the transcript.
//
// WHY THIS FILE EXISTS. PR #274's own pins call `normalizeMessagesForCascade`
// directly; `test/tool-emulation-boundary.test.js` never loads chat.js, so it
// cannot see a pre-pass reintroduced ABOVE the shared layer — re-installing the
// sweep leaves it green (the review's finding). These tests drive the REAL
// `handleChatCompletions` with the connect upstream mocked and assert what
// actually rides the wire, so the sweep's return fails them.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { cacheClear } from '../src/cache.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';

const CALLER = 'api:test:user:orphan-guard';
const MODEL = 'swe-1-6-slow';

function nonStream(content = 'ok') {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-orphan-guard', object: 'chat.completion', created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  };
}

// Serialize everything the encoder could carry so a marker anywhere in the
// outbound message list is visible regardless of how a path reshapes turns.
function wireText(messages) {
  return JSON.stringify(messages ?? []);
}

describe('the shared layer forwards orphan tool results (PR #274 M1 guard)', () => {
  let accountId = null;
  let captured = null;
  let savedConnect;

  beforeEach(() => {
    savedConnect = process.env.DEVIN_CONNECT;
    process.env.DEVIN_CONNECT = '1';
    cacheClear();
    captured = null;
    accountId = addAccountByKey(`devin-session-token$orphan-guard-${Math.random().toString(36).slice(2)}`, 'orphan-guard-test').id;
    __setConnectDeps({
      toChatCompletion: async (params) => {
        captured = params.messages;
        return nonStream();
      },
    });
  });

  afterEach(() => {
    __resetConnectDeps();
    cacheClear();
    if (accountId) removeAccount(accountId);
    accountId = null;
    if (savedConnect === undefined) delete process.env.DEVIN_CONNECT;
    else process.env.DEVIN_CONNECT = savedConnect;
  });

  async function send(messages, tools = null) {
    const res = await handleChatCompletions(
      { model: MODEL, messages, __callerKey: CALLER, ...(tools ? { tools } : {}) },
      { callerKey: CALLER },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(captured), 'the connect upstream must have been called');
    return captured;
  }

  it('keeps a mid-array orphan result (a whole-array sweep would drop it)', async () => {
    const outbound = await send([
      { role: 'user', content: 'a' },
      { role: 'tool', tool_call_id: 'never-declared', content: 'ORPHAN_MARKER' },
      { role: 'user', content: 'summarise' },
    ]);
    assert.match(wireText(outbound), /ORPHAN_MARKER/,
      'the orphan tool result must reach the outbound transcript, not be swept at the shared layer');
    assert.ok(outbound.some((m) => m?.role === 'tool' && m?.tool_call_id === 'never-declared'),
      'and it must still be a tool message, not silently rewritten into something else');
  });

  it('keeps a result whose matching call appears LATER (not seen-so-far)', async () => {
    const outbound = await send([
      { role: 'tool', tool_call_id: 'c1', content: 'RESULT_FIRST_MARKER' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'user', content: 'go' },
    ]);
    assert.match(wireText(outbound), /RESULT_FIRST_MARKER/,
      'a result whose call is later in the history is not an orphan');
    assert.ok(outbound.some((m) => m?.role === 'tool' && m?.tool_call_id === 'c1'));
  });

  it('keeps a legacy role:function result (the sweep covered function too)', async () => {
    const outbound = await send([
      { role: 'user', content: 'a' },
      { role: 'function', name: 'legacy_fn', tool_call_id: 'fn-never-declared', content: 'FUNCTION_MARKER' },
      { role: 'user', content: 'continue' },
    ]);
    assert.match(wireText(outbound), /FUNCTION_MARKER/,
      'role:function history must survive the shared layer');
  });

  it('keeps a mid-array orphan through the TEXT-EMULATION fold (tools present)', async () => {
    // With tools the connect path calls normalizeMessagesForCascade, whose
    // orphan-stripping is opt-in (native wire only). Force the def gate off with
    // an invalid tag map so the emulation path runs with stripOrphans unset: the
    // orphan must be FOLDED into <tool_result> text, never pre-dropped above it.
    const savedTags = process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
    process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = 'not-a-tag-map';
    try {
      const outbound = await send([
        { role: 'user', content: 'a' },
        { role: 'tool', tool_call_id: 'never-declared', content: 'FOLD_MARKER' },
        { role: 'user', content: 'summarise' },
      ], [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: {} } }]);
      assert.match(wireText(outbound), /FOLD_MARKER/,
        'the emulation fold must see the orphan content');
    } finally {
      if (savedTags === undefined) delete process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
      else process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = savedTags;
    }
  });
});

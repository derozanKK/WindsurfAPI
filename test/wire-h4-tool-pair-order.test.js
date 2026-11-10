// #273.1 — a tool_result that appears BEFORE its matching assistant call is
// rejected by the native upstream, so the native history normalization must
// restore call-then-result order before the wire.
//
// Measured 2026-10-25 against a scratch DEVIN_CONNECT instance (real account,
// claude-haiku-5-5-medium, nativeToolCall=true, one call id):
//
//   [user, assistant(call a), tool(a), user]  -> 200, "ALPHA-42"
//   [user, tool(a), assistant(call a), user]  -> 502 invalid_argument
//                                                "There is an issue with this
//                                                request, please try a different model."
//   [user, assistant(call a), user]           -> 502 invalid_argument
//                                                (dropping only the result leaves
//                                                an unanswered call, also rejected)
//   [user, tool(a), user]                     -> 200, but finish_reason=tool_calls:
//                                                the model re-issued the call, so the
//                                                client would execute the action twice
//
// Dropping either half is therefore not a fix. Moving the result after its call
// is the only repair that both preserves the content and reproduces the measured
// accepted shape. The reorder is native-path only (`nativeStructured`): the
// text-emulation wire has no role=4 frames and its bytes must not change.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { cacheClear } from '../src/cache.js';
import { handleChatCompletions, __setConnectDeps, __resetConnectDeps } from '../src/handlers/chat.js';
import {
  orderToolResultsAfterCalls,
  normalizeMessagesForCascade,
  stripOrphanedToolResults,
} from '../src/handlers/tool-emulation.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const user = (content = 'continue') => ({ role: 'user', content });
const call = (id) => ({ id, type: 'function', function: { name: 'f', arguments: '{}' } });
const assistant = (ids, content = null) => ({
  role: 'assistant', content, tool_calls: (Array.isArray(ids) ? ids : [ids]).map(call),
});
const result = (id, content = 'output') => ({ role: 'tool', tool_call_id: id, content });

const options = {
  modelKey: 'swe-1-7', route: 'devin_connect',
  nativeStructured: true, injectUserPreamble: false, stripOrphans: true,
};
const normalize = (messages, extra = {}) => normalizeMessagesForCascade(messages, [], {
  ...options, ...extra,
});
const buildWire = (messages) => {
  const originalUUID = crypto.randomUUID;
  let n = 0;
  // Fix entropy before encoding, not by erasing fields from the encoded bytes.
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  syncBuiltinESMExports();
  try {
    return buildGetChatMessageRequest({
      token: 'wire-test', model: 'swe-1-7', messages,
      sessionId: 'wire-session', sessionModelConfig: { id: 'wire-config', turn: 1 },
      deviceSeed: 'wire-device', nativeToolCall: true, env: {},
    });
  } finally {
    crypto.randomUUID = originalUUID;
    syncBuiltinESMExports();
  }
};
const frames = (messages) => getAllFields(parseFields(buildWire(messages)), 3)
  .filter((f) => f.wireType === 2).map((f) => parseFields(f.value));
const roles = (items) => items.map((f) => getField(f, 2, 0).value);
const strings = (fields, tag) => getAllFields(fields, tag)
  .filter((f) => f.wireType === 2).map((f) => f.value.toString('utf8'));
const callIds = (items) => items.flatMap((f) => getAllFields(f, 6)
  .map((c) => strings(parseFields(c.value), 1)[0]));
const resultIds = (items) => items.map((f) => strings(f, 7)[0]).filter(Boolean);

describe('#273.1 native tool-pair order', () => {
  it('H4-T1: moves an adjacent reversed result after its call', () => {
    const input = [user('go'), result('a', 'RESULT-A'), assistant('a'), user('done')];
    const out = orderToolResultsAfterCalls(input);
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
    assert.equal(out[1], input[2], 'the assistant message object is reused, not rebuilt');
    assert.equal(out[2], input[1], 'the result message object is reused, not rebuilt');
    assert.equal(out[2].content, 'RESULT-A', 'the result body is preserved');

    const items = frames(normalize(input));
    assert.deepEqual(roles(items), [1, 2, 4, 1], 'call frame precedes the tool_result frame');
    assert.deepEqual(callIds(items), ['a']);
    assert.deepEqual(resultIds(items), ['a']);
    assert.deepEqual(strings(items[2], 3), ['RESULT-A']);
  });

  it('H4-T2: moves a reversed result across an intervening turn, preserving that turn', () => {
    const input = [user('go'), result('a', 'R'), user('interlude'), assistant('a', 'before'), user('done')];
    const out = orderToolResultsAfterCalls(input);
    assert.deepEqual(out.map((m) => m.role), ['user', 'user', 'assistant', 'tool', 'user']);
    assert.deepEqual(out.map((m) => m.content), ['go', 'interlude', 'before', 'R', 'done']);

    const items = frames(normalize(input));
    // The assistant turn carries text + one call, so the native encoder emits a
    // preText frame and then a call frame; the two leading user turns merge on
    // the wire (same-role text coalescing).
    assert.deepEqual(roles(items), [1, 2, 2, 4, 1]);
    assert.deepEqual(callIds(items), ['a']);
    assert.deepEqual(resultIds(items), ['a']);
  });

  it('H4-T3: an already ordered history is returned untouched and its wire is byte-identical', () => {
    const ordered = [user('go'), assistant('a', 'before'), result('a'), user('done')];
    assert.strictEqual(orderToolResultsAfterCalls(ordered), ordered);
    const plain = [user('go'), assistant('a'), result('a'), user('done')];
    assert.strictEqual(orderToolResultsAfterCalls(plain), plain);
    assert.deepEqual(buildWire(normalize(ordered)), buildWire(ordered));
  });

  it('H4-T4: a result with no call anywhere stays where it is (stripOrphans owns that policy)', () => {
    const input = [user('go'), result('ghost', 'ORPHAN'), user('done')];
    assert.strictEqual(orderToolResultsAfterCalls(input), input);
    assert.deepEqual(stripOrphanedToolResults(input), [user('go'), user('done')]);
    const items = frames(normalize(input));
    assert.deepEqual(roles(items), [1], 'the opted-in orphan strip drops it and the users coalesce');
  });

  it('H4-T5: a reversed parallel batch becomes call/result pairs in call order', () => {
    const input = [
      user('go'), result('a', 'RA'), result('b', 'RB'),
      assistant(['a', 'b']), user('done'),
    ];
    const out = orderToolResultsAfterCalls(input);
    assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user']);

    const items = frames(normalize(input));
    assert.deepEqual(roles(items), [1, 2, 4, 2, 4, 1]);
    assert.deepEqual(callIds(items), ['a', 'b']);
    assert.deepEqual(resultIds(items), ['a', 'b']);
    assert.deepEqual(strings(items[2], 3), ['RA']);
    assert.deepEqual(strings(items[4], 3), ['RB']);
  });

  it('H4-T6: the text-emulation wire is unchanged (no native frames to order)', () => {
    const input = [user('go'), result('a', 'R'), assistant('a'), user('done')];
    const emulated = normalize(input, { nativeStructured: false, stripOrphans: false });
    assert.deepEqual(emulated.map((m) => m.role), ['user', 'user', 'assistant', 'user']);
    const items = frames(normalize(input, { nativeStructured: false, stripOrphans: false }));
    // The synthetic tool_result user turn coalesces with the preceding user
    // turn on the text wire; no native #6/#7 frames exist to order.
    assert.deepEqual(roles(items), [1, 2, 1]);
    assert.deepEqual(callIds(items), []);
  });
});

// End-to-end: the handler's own normalization must hand the connect upstream a
// call-then-result history. `interleaveParallelToolMessages` alone cannot do it
// (it only looks forward from an assistant run), so this drives the REAL handler
// with the connect upstream mocked, exactly like the PR #274 M1 guard.
describe('#273.1 the connect handler forwards call-then-result order', () => {
  const CALLER = 'api:test:user:pair-order';
  const MODEL = 'swe-1-6-slow';
  const TOOLS = [{ type: 'function', function: { name: 'f', description: 'test tool', parameters: { type: 'object', properties: {} } } }];
  let accountId = null;
  let captured = null;
  let savedConnect;

  const nonStream = (content = 'ok') => ({
    status: 200,
    body: {
      id: 'chatcmpl-pair-order', object: 'chat.completion', created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  });

  beforeEach(() => {
    savedConnect = process.env.DEVIN_CONNECT;
    process.env.DEVIN_CONNECT = '1';
    cacheClear();
    captured = null;
    accountId = addAccountByKey(`devin-session-token$pair-order-${Math.random().toString(36).slice(2)}`, 'pair-order-test').id;
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

  it('H4-T7: a reversed pair reaches the upstream as [assistant, tool]', async () => {
    const res = await handleChatCompletions({
      model: MODEL,
      __callerKey: CALLER,
      tools: TOOLS,
      messages: [user('go'), result('c1', 'RESULT-BODY'), assistant('c1'), user('done')],
    }, { callerKey: CALLER });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(captured), 'the connect upstream must have been called');
    // The handler injects its tool preamble as a system turn; the client
    // history after it is what this guard is about.
    const history = captured.filter((m) => m.role !== 'system');
    assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
    assert.equal(history[2].tool_call_id, 'c1');
    assert.equal(history[2].content, 'RESULT-BODY');
    assert.equal(history[1].tool_calls[0].id, 'c1');
  });

  // P2-1 (Kimi wave review): the repair used to run only inside
  // normalizeMessagesForCascade({nativeStructured:true}), and nativeStructured
  // requires tools to be declared. With no tools the handler took the
  // interleave-only branch while the wire builder still emitted native #6/#7
  // (nativeToolCall defaults on), so the reversed pair reached the upstream as
  // [1,4,2,1] — the exact shape #273.1 measured as a 502.
  it('H4-T8: with NO tools declared, a reversed pair still reaches the wire call-first', async () => {
    const res = await handleChatCompletions({
      model: MODEL,
      __callerKey: CALLER,
      messages: [user('go'), result('c1', 'RESULT-BODY'), assistant('c1'), user('done')],
    }, { callerKey: CALLER });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(captured), 'the connect upstream must have been called');
    const history = captured.filter((m) => m.role !== 'system');
    assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'tool', 'user'],
      'the no-tools native history must be repaired before the wire');
    assert.equal(history[2].tool_call_id, 'c1');
    assert.equal(history[2].content, 'RESULT-BODY');
    assert.equal(history[1].tool_calls[0].id, 'c1');

    const items = frames(history);
    assert.deepEqual(roles(items), [1, 2, 4, 1],
      'wire order must be user, assistant(#6 call), tool_result(#7), user — not [1,4,2,1]');
    assert.deepEqual(callIds(items), ['c1']);
    assert.deepEqual(resultIds(items), ['c1']);
  });
});

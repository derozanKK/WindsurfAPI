// Malformed content parts must never take the request down: a null element in
// a content array (chat / Anthropic / responses) and an untyped message-content
// array (responses) are answered the way the shared pipeline already handles
// bad input — the tail guard's 400, or the chat layer's text coercion — instead
// of a TypeError → 500 or JSON junk served as the prompt.
//
// RC0 (reverting a guard reds this file; each revert measured by hand on this
// branch, then restored):
//   - src/cache.js normalizeBinary null guards   → the three chat cases
//   - src/handlers/messages.js null-block skip   → the two Anthropic content cases
//   - src/handlers/messages.js system-walk guard → the Anthropic system:[null] case
//   - src/handlers/responses.js message loop     → the four responses cases
//
// Outside-in shapes that filed the report (raw HTTP, 2026-10-07):
//   POST /v1/chat/completions {"user":"alice","messages":[{"role":"user",
//   "content":[null]}]} → 500 {"error":{"message":"Internal error",…}} with
//   "Handler error: TypeError: Cannot read properties of null (reading
//   'type')" at src/cache.js:89;
//   POST /v1/messages content:[null] → 500 with the same TypeError at
//   src/handlers/messages.js:664;
//   POST /v1/messages {"system":[null],…} → 500 with
//   "TypeError: Cannot read properties of null (reading 'text')" at
//   src/handlers/messages.js:646.

import './setup-env.mjs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleMessages } from '../src/handlers/messages.js';
import { handleResponses } from '../src/handlers/responses.js';
import { cacheClear } from '../src/cache.js';
import {
  __resetModelCatalogState,
  __setModelCatalogDeps,
  __waitForModelCatalogSync,
  addAccountByKey,
  getAccountInternal,
  getApiKey,
  removeAccount,
} from '../src/auth.js';

const MODEL = 'gemini-2.5-flash';
// A trustworthy per-user scope, the shape a client mints with body.user — the
// cache key is only computed for callers that have one (hasPerUserScope).
const SCOPE = 'api:test:user:rc0-null-part';
const createdIds = [];

function seed() {
  const added = addAccountByKey(`devin-session-token$xk-null-part-${Math.random().toString(36).slice(2)}`, 'null-part');
  createdIds.push(added.id);
  const account = getAccountInternal(added.id);
  account.tier = 'pro';
  account.status = 'active';
  return account;
}

// The repo's own backend seam. The fake client captures the messages the
// handler hands to the wire, so assertions below read the shape production
// sends to a backend, not an internal helper's return value.
function fakeBackend() {
  const seen = { messages: null };
  class FakeClient {
    async cascadeChat(messages) {
      seen.messages = messages;
      return Object.assign([{ text: 'ANSWER' }], { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
    }
  }
  return {
    seen,
    context: {
      waitForAccount: (tried, _signal, _maxWait, modelKey) => getApiKey(tried, modelKey),
      ensureLs: async () => {},
      getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
      WindsurfClient: FakeClient,
    },
  };
}

function lastUser(messages) {
  return (messages || []).filter(m => m?.role === 'user').pop();
}

beforeEach(() => {
  cacheClear();
  __setModelCatalogDeps({
    disableConnectSync: true,
    getCascadeModelConfigs: async () => ({ configs: [] }),
  });
});

afterEach(async () => {
  while (createdIds.length) { try { removeAccount(createdIds.pop()); } catch {} }
  await __waitForModelCatalogSync();
  __resetModelCatalogState();
  __setModelCatalogDeps(null);
  cacheClear();
});

describe('null content parts never crash a part walker', () => {
  it('chat: content:[null] with a per-user scope gets the shared 400, not a 500', async () => {
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: [null] }] },
      { callerKey: SCOPE },
    );
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.match(result.body.error.message, /empty content/);
  });

  it('chat: content:[null, {type:text}] is served — the null part is not fatal', async () => {
    seed();
    const { seen, context } = fakeBackend();
    const result = await handleChatCompletions(
      { model: MODEL, messages: [{ role: 'user', content: [null, { type: 'text', text: 'ok' }] }] },
      { ...context, callerKey: SCOPE },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(JSON.stringify(lastUser(seen.messages)?.content).includes('ok'), JSON.stringify(seen.messages));
  });

  it('chat: messages:[null] does not crash the cache-key walk', async () => {
    const result = await handleChatCompletions(
      { model: MODEL, messages: [null] },
      { callerKey: SCOPE },
    );
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error.message, /must end with a user message/);
  });

  it('Anthropic: content:[null] is answered 400, not 500', async () => {
    const result = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 16, messages: [{ role: 'user', content: [null] }] },
      {},
    );
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.match(result.body.error.message, /must end with a user message/);
  });

  it('Anthropic: content:[null, {type:text}] is served with the null block skipped', async () => {
    seed();
    const { seen, context } = fakeBackend();
    const result = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 16, messages: [{ role: 'user', content: [null, { type: 'text', text: 'ok' }] }] },
      context,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(JSON.stringify(lastUser(seen.messages)?.content).includes('ok'), JSON.stringify(seen.messages));
  });

  it('Anthropic: system:[null] does not crash the converter (string system still works)', async () => {
    seed();
    const { seen, context } = fakeBackend();
    const reported = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 16, system: [null], messages: [{ role: 'user', content: 'hi' }] },
      context,
    );
    assert.equal(reported.status, 200, JSON.stringify(reported.body));

    const mixed = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 16, system: [null, { type: 'text', text: 'ok' }], messages: [{ role: 'user', content: 'hi' }] },
      context,
    );
    assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
    const sys = (seen.messages || []).find(m => m?.role === 'system');
    assert.ok(sys && sys.content.includes('ok'), JSON.stringify(seen.messages));

    const stringSystem = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 16, system: 'plain', messages: [{ role: 'user', content: 'hi' }] },
      context,
    );
    assert.equal(stringSystem.status, 200, JSON.stringify(stringSystem.body));
    assert.equal((seen.messages || []).find(m => m?.role === 'system')?.content, 'plain');
  });
});

describe('untyped message-content arrays are text, not JSON junk', () => {
  it('responses: [{text}] is coerced to a text part, not stringified', async () => {
    seed();
    const { seen, context } = fakeBackend();
    const result = await handleResponses(
      { model: MODEL, input: [{ role: 'user', content: [{ text: 'hi' }] }] },
      { context: { ...context, callerKey: SCOPE } },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(lastUser(seen.messages)?.content, [{ type: 'text', text: 'hi' }]);
  });

  it("responses: a ['hi'] string array is served as text, not flipped to 400", async () => {
    seed();
    const { seen, context } = fakeBackend();
    const result = await handleResponses(
      { model: MODEL, input: [{ role: 'user', content: ['hi'] }] },
      { context: { ...context, callerKey: SCOPE } },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(lastUser(seen.messages)?.content, [{ type: 'text', text: 'hi' }]);
  });

  it('responses: a textless untyped turn is not masked from the shared tail guard', async () => {
    for (const content of [[null], [{}], []]) {
      const result = await handleResponses(
        { model: MODEL, input: [{ role: 'user', content }] },
        { context: { callerKey: SCOPE } },
      );
      assert.equal(result.status, 400, `${JSON.stringify(content)}: ${JSON.stringify(result.body)}`);
      assert.match(result.body.error.message, /empty content/);
    }
  });

  it('responses: tool outputs with no typed parts keep their JSON rendering', async () => {
    seed();
    const { seen, context } = fakeBackend();
    const result = await handleResponses(
      {
        model: MODEL,
        input: [
          { type: 'function_call_output', call_id: 'c1', output: ['a', 'b'] },
          { role: 'user', content: 'go' },
        ],
      },
      { context: { ...context, callerKey: SCOPE } },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const toolTurn = (seen.messages || []).find(m => typeof m.content === 'string' && m.content.includes('tool_result'));
    assert.ok(toolTurn && toolTurn.content.includes('["a","b"]'), JSON.stringify(seen.messages));
  });
});

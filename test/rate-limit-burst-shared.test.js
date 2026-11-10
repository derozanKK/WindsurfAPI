// Q5-P1 (ownership): the "IP-level" rate-limit burst breaker must be
// PROCESS-scoped, not per-request.
//
// Before the fix, each request carried its own `context.__rateLimitEvents`
// array, so a second request started from zero and the "Windsurf upstream is
// applying IP-level cooldown" claim was false: the breaker could never see a
// burst that started in a previous request, and the pool kept burning accounts.
//
// This test drives the real non-stream Cascade loop through two requests:
//   request 1: accounts A and B are rate-limited (2 events), C succeeds;
//   request 2: A is rate-limited again -> the 3rd event in the window must
//              trip the breaker and short-circuit BEFORE B/C are tried.
// The scripted account source deliberately re-offers A even though request 1
// cooled it, which is exactly the case the breaker exists to stop.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { __resetRateLimitBurstForTest } from '../src/rate-limit-burst.js';

const createdIds = [];
let originalDevinConnect;
let originalDevinOnly;

function seed(label) {
  const key = `devin-session-token$burst-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  acct.status = 'active';
  createdIds.push(acct.id);
  return { id: acct.id, apiKey: acct.apiKey };
}

// One request's view of the pool. `script` is the exact account order the
// handler is allowed to acquire; `calls` records which accounts actually
// reached the upstream.
function contextFor(accounts, rateLimitedKeys) {
  let cursor = 0;
  const calls = [];
  class FakeClient {
    constructor(apiKey) { this.apiKey = apiKey; }
    async cascadeChat() {
      calls.push(this.apiKey);
      if (rateLimitedKeys.has(this.apiKey)) {
        throw new Error('message rate limit exceeded: too many requests');
      }
      return Object.assign([{ text: 'OK' }], { toolCalls: [] });
    }
  }
  return {
    calls,
    ctx: {
      waitForAccount() {
        if (cursor >= accounts.length) return null;
        const a = accounts[cursor++];
        return { id: a.id, apiKey: a.apiKey };
      },
      ensureLs: async () => {},
      getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
      WindsurfClient: FakeClient,
    },
  };
}

beforeEach(() => {
  originalDevinConnect = process.env.DEVIN_CONNECT;
  originalDevinOnly = process.env.DEVIN_ONLY;
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_ONLY;
  __resetRateLimitBurstForTest();
});

afterEach(() => {
  while (createdIds.length) removeAccount(createdIds.pop());
  __resetRateLimitBurstForTest();
  if (originalDevinConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = originalDevinConnect;
  if (originalDevinOnly === undefined) delete process.env.DEVIN_ONLY;
  else process.env.DEVIN_ONLY = originalDevinOnly;
});

describe('IP-level rate-limit burst breaker is process-scoped', () => {
  it('a second request sees the burst recorded by the first and short-circuits', async () => {
    const a = seed('a');
    const b = seed('b');
    const c = seed('c');
    const accounts = [a, b, c];

    // Request 1: A and B rate-limited, C serves the answer. Two events land in
    // the window — below the 3-event threshold, so request 1 must NOT trip.
    const first = contextFor(accounts, new Set([a.apiKey, b.apiKey]));
    const r1 = await handleChatCompletions(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'one' }], stream: false },
      first.ctx,
    );
    assert.equal(r1.status, 200, 'request 1 falls through to the healthy account');
    assert.deepEqual(first.calls, [a.apiKey, b.apiKey, c.apiKey], 'request 1 tried A, B then C');

    // Request 2: A rate-limits again. The process-scoped window already holds
    // two events, so this is the third and must trip the breaker immediately.
    const second = contextFor(accounts, new Set([a.apiKey, b.apiKey, c.apiKey]));
    const r2 = await handleChatCompletions(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'two' }], stream: false },
      second.ctx,
    );

    assert.equal(r2.status, 429, 'request 2 is short-circuited as an IP-level burst');
    assert.equal(second.calls.length, 1, 'request 2 did NOT burn the rest of the pool');
    assert.deepEqual(second.calls, [a.apiKey], 'request 2 stopped on its first rate-limited account');
    assert.match(r2.body?.error?.message || '', /IP-level cooldown/i,
      'the response explains the upstream-wide cooldown');
  });
});

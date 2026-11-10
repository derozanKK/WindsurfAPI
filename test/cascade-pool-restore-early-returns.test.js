// P2-4 — a checked-out Cascade reuse entry is removed from the pool by
// `poolCheckout` (conversation-pool.js); `poolCheckin` is the only way back.
// Every early return between the checkout and the end-of-loop restore block must
// therefore decide the entry's fate explicitly:
//
//   - restore it when the upstream turn left the cascade in a resumable state
//     (the request failed with a real upstream verdict, or the turn completed
//     before the client vanished);
//   - drop it when the turn was interrupted mid-answer (the #101 half-broken
//     trajectory: restoring it makes the next turn see a trailing tool_result
//     with no user prompt — test/cascade-abort-side-effects.test.js pins that
//     contract).
//
// A skipped restore is NOT healed by TTL: the entry is no longer IN the pool, so
// the next turn pays a full history replay — the exact prompt-cache write the
// pool exists to avoid. Each test below drives the real handler with a fake
// language server/client and asserts the pool's size afterwards.

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const CALLER = 'session:pool-restore-early-returns';
const PORT = 47999;
const MODEL = 'gemini-2.5-flash';

let handleChatCompletions;
let resolveModel;
let auth;
let pool;
let burst;

const created = [];

before(async () => {
  ({ handleChatCompletions } = await import('../src/handlers/chat.js'));
  ({ resolveModel } = await import('../src/models.js'));
  auth = await import('../src/auth.js');
  pool = await import('../src/conversation-pool.js');
  burst = await import('../src/rate-limit-burst.js');
});

beforeEach(() => {
  pool.poolClear();
  burst.__resetRateLimitBurstForTest();
});

// Per-test account cleanup: isAllTemporarilyUnavailable / isAllRateLimited scan
// the WHOLE pool, so a leftover active account from an earlier test would make
// the exhausted-pool case look available and mask the path under test.
afterEach(() => {
  while (created.length) {
    try { auth.removeAccount(created.pop()); } catch {}
  }
  pool.poolClear();
});

after(() => {
  while (created.length) {
    try { auth.removeAccount(created.pop()); } catch {}
  }
  pool.poolClear();
});

function seedAccount(label) {
  const a = auth.addAccountByKey(
    `devin-session-token$pr-${label}-${Math.random().toString(36).slice(2)}`, label,
  );
  created.push(a.id);
  const acct = auth.getAccountInternal(a.id);
  acct.tier = 'pro';
  acct.status = 'active';
  return acct;
}

// Exactly the bag buildReuseOpts() produces for a tool-less chat request.
function reuseOpts() {
  return { tools: [], toolChoice: null, toolPreamble: '', preambleTier: null, emulateTools: false, route: 'chat' };
}

function seedReuse(acct, messages, modelKey) {
  const fpBefore = pool.fingerprintBefore(messages, modelKey, CALLER, reuseOpts());
  pool.checkin(fpBefore, {
    cascadeId: 'seeded-cascade',
    sessionId: 'seeded-session',
    lsPort: PORT,
    lsGeneration: 1,
    apiKey: acct.apiKey,
    modelKey,
    stepOffset: 1,
    generatorOffset: 1,
  }, CALLER, 0);
  assert.equal(pool.poolStats().size, 1, 'precondition: seeded reuse entry');
  return fpBefore;
}

function contextFor(acct, ClientClass, extra = {}) {
  return {
    callerKey: CALLER,
    waitForAccount: () => ({ id: acct.id, email: acct.email, apiKey: acct.apiKey, proxy: null }),
    ensureLs: async () => {},
    getLsFor: () => ({ port: PORT, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: ClientClass,
    ...extra,
  };
}

function chatBody(stream = false) {
  return {
    model: MODEL,
    messages: [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second turn' },
    ],
    stream,
  };
}

function chunks(text, extra = {}) {
  const out = [{ text }];
  out.cascadeId = 'seeded-cascade';
  out.sessionId = 'seeded-session';
  out.stepOffset = 2;
  out.generatorOffset = 2;
  out.usage = null;
  out.toolCalls = [];
  Object.assign(out, extra);
  return out;
}

function nonStreamClient(behavior) {
  return class FakeClient {
    constructor() {}
    async cascadeChat(messages, modelEnum, modelUid, opts) {
      return behavior(opts, messages);
    }
  };
}

function fakeRes() {
  const listeners = new Map();
  const state = { body: '', writableEnded: false, statusCode: 0 };
  const res = {
    get writableEnded() { return state.writableEnded; },
    get body() { return state.body; },
    writeHead(status) { state.statusCode = status; res.statusCode = status; },
    write(chunk) { state.body += String(chunk); return true; },
    end(chunk) { if (chunk) res.write(chunk); state.writableEnded = true; },
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); return res; },
    once(event, cb) {
      const wrap = (...args) => { res.removeListener(event, wrap); cb(...args); };
      res.on(event, wrap);
    },
    removeListener(event, cb) {
      const list = listeners.get(event) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    emit(event, ...args) {
      for (const cb of [...(listeners.get(event) || [])]) cb(...args);
    },
    // A real client hang-up fires 'close' WITHOUT marking writableEnded.
    disconnect() { res.emit('close'); },
  };
  return res;
}

describe('non-stream early returns restore the checked-out cascade', () => {
  it('client abort AFTER the upstream turn completed (post-call abort window)', async () => {
    const acct = seedAccount('abort-complete');
    const body = chatBody(false);
    const modelKey = resolveModel(body.model);
    seedReuse(acct, body.messages, modelKey);

    const ac = new AbortController();
    const Client = nonStreamClient(() => {
      // The upstream turn resolved, then the client vanished before the handler
      // committed it. nonStreamResponse's post-call abort check marks this shape
      // reuseEntryRestorable: the cascade holds a COMPLETE turn.
      ac.abort();
      return chunks('the completed answer');
    });

    const result = await handleChatCompletions(body, contextFor(acct, Client, { signal: ac.signal }));
    assert.equal(result.status, 499, 'an aborted non-stream turn returns the established 499');
    assert.equal(pool.poolStats().size, 1,
      'the completed turn lost its checked-out cascade — the next turn pays a full history replay');
  });

  it('client abort that INTERRUPTED the turn still drops the half-broken cascade', async () => {
    const acct = seedAccount('abort-interrupted');
    const body = chatBody(false);
    const modelKey = resolveModel(body.model);
    seedReuse(acct, body.messages, modelKey);

    const ac = new AbortController();
    const Client = nonStreamClient(() => {
      ac.abort();
      throw Object.assign(new Error('aborted mid-answer'), { name: 'AbortError' });
    });

    const result = await handleChatCompletions(body, contextFor(acct, Client, { signal: ac.signal }));
    assert.equal(result.status, 499);
    assert.equal(pool.poolStats().size, 0,
      'a half-broken trajectory must not be restored (#101): the next turn would resume a partial answer');
  });

  it('policy_blocked returns without losing the cascade', async () => {
    const acct = seedAccount('policy');
    const body = chatBody(false);
    const modelKey = resolveModel(body.model);
    seedReuse(acct, body.messages, modelKey);

    const Client = nonStreamClient(() => {
      throw new Error('request blocked by our content policy');
    });

    const result = await handleChatCompletions(body, contextFor(acct, Client));
    assert.equal(result.status, 451, 'policy_blocked keeps its 451 contract');
    assert.equal(result.body?.error?.type, 'policy_blocked');
    assert.equal(pool.poolStats().size, 1,
      'a policy refusal is not a broken cascade — the entry must go back to the pool');
  });

  it('IP-rate-limit burst short-circuit returns without losing the cascade', async () => {
    const acct = seedAccount('burst');
    const body = chatBody(false);
    const modelKey = resolveModel(body.model);
    seedReuse(acct, body.messages, modelKey);

    // Trip the process-scoped burst detector for this model before the request,
    // so the handler's own rate-limit observation crosses the threshold.
    for (let i = 0; i < 3; i++) {
      burst.recordRateLimitBurstEvent({ model: modelKey, account: `seed-${i}`, cooldownMs: 60_000 });
    }

    const Client = nonStreamClient(() => {
      throw new Error('rate limit exceeded');
    });

    const result = await handleChatCompletions(body, contextFor(acct, Client));
    assert.equal(result.status, 429);
    assert.match(String(result.body?.error?.message || ''), /IP-level cooldown/,
      'precondition: the burst short-circuit must have fired');
    assert.equal(pool.poolStats().size, 1,
      'the burst return dropped the checked-out cascade');
  });

  it('exhausted-pool admission fast-fail restores the entry it already checked out', async () => {
    const acct = seedAccount('exhausted');
    const body = chatBody(false);
    const modelKey = resolveModel(body.model);
    seedReuse(acct, body.messages, modelKey);

    // Make the checked-out owner (and therefore the whole pool) unavailable.
    auth.markRateLimited(acct.apiKey, 600_000, modelKey);
    const prevDegraded = process.env.WINDSURFAPI_DEGRADED_SERVE;
    process.env.WINDSURFAPI_DEGRADED_SERVE = '0';
    try {
      const Client = nonStreamClient(() => chunks('never reached'));
      const ctx = contextFor(acct, Client, { waitForAccount: () => null });
      const hitsBefore = pool.poolStats().hits;
      const result = await handleChatCompletions(body, ctx);
      assert.equal(pool.poolStats().hits, hitsBefore + 1,
        'precondition: the handler must have checked out the seeded cascade');
      assert.equal(result.status, 429, 'precondition: the admission fast-fail must have fired');
      assert.match(String(result.body?.error?.message || ''), /账号队列耗尽/);
      assert.equal(pool.poolStats().size, 1,
        'the fast-fail return dropped the checked-out cascade (same leak class as the other early returns)');
    } finally {
      if (prevDegraded === undefined) delete process.env.WINDSURFAPI_DEGRADED_SERVE;
      else process.env.WINDSURFAPI_DEGRADED_SERVE = prevDegraded;
    }
  });
});

describe('stream top-of-loop abort restores the checked-out cascade', () => {
  it('a disconnect during the retry backoff restores an untouched checkout', async () => {
    const acct = seedAccount('stream-top-abort');
    const body = chatBody(true);
    const modelKey = resolveModel(body.model);
    seedReuse(acct, body.messages, modelKey);

    const res = fakeRes();
    let upstreamCalls = 0;
    class FakeClient {
      constructor() {}
      async cascadeChat() {
        upstreamCalls += 1;
        // Attempt 0 fails as a transient upstream fault, so the handler enters
        // internalErrorBackoff (an await). The client leaves during that window;
        // attempt 1 starts at the top-of-loop abort check with the checkout still
        // held and nothing emitted.
        setImmediate(() => res.disconnect());
        throw new Error('an internal error occurred (trace ID: pool-restore-test)');
      }
    }

    const result = await handleChatCompletions(body, contextFor(acct, FakeClient));
    assert.equal(result.status, 200);
    assert.equal(result.stream, true);
    await result.handler(res);

    assert.equal(upstreamCalls, 1, 'precondition: the second attempt never reached upstream');
    assert.equal(pool.poolStats().size, 1,
      'the top-of-loop abort return dropped the checked-out cascade even though no upstream turn ran for that attempt');
  });
});

// Request-budget contract (Q5 F2): ONE route-owned deadline + ONE upstream-turn
// counter, observed by every retry layer.
//
// Before this, each layer owned a bound and they composed multiplicatively: the
// connect adapter's documented 5-call ceiling was per INVOCATION, the handler
// could invoke it 9–18 times per request, and nothing clamped a 600 s cascade
// poll window to the time the request had left. The tests below pin the two
// observable promises:
//   1. a slow/failing chain cannot exceed the budget (wall clock);
//   2. a retrying adapter stops at the turn cap / deadline instead of spending
//      its own per-layer allowance.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount, getApiKey, _resetLockoutForTests } from '../src/auth.js';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { createRequestBudget, resolveRequestBudgetMs, isBudgetExceededError } from '../src/request-budget.js';
import { streamChatCompletion, toChatCompletion, __setStreamChatForTest } from '../src/devin-connect-openai.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const created = new Set();
const envSaved = new Map();

afterEach(() => {
  for (const id of created) { removeAccount(id); created.delete(id); }
  _resetLockoutForTests();
  __setStreamChatForTest();
  for (const [key, value] of envSaved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envSaved.clear();
});

function saveEnv(key) {
  if (!envSaved.has(key)) envSaved.set(key, process.env[key]);
}

function addAccount(label) {
  const acct = addAccountByKey(`budget-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`, `budget-${label}`);
  if (acct?.id) created.add(acct.id);
  return acct;
}

// A budget that passes the pre-sleep gate but is spent by the time the backoff
// returns — the interleaving that made CI v3.9.57 (run 39861008441) issue one
// doomed retry: budgetedSleep() returns `remainingMs() > 0`, and timer
// granularity lets that be true with less than a millisecond left, so a loop
// that only checked BEFORE the wait re-issued an attempt the deadline killed
// mid-flight. canStartAttempt() is this stub's own clock, so the test never
// races wall time; remainingMs() stays positive so the REAL budgetedSleep()
// actually sleeps instead of short-circuiting.
function budgetSpentDuringBackoff() {
  let canStartCalls = 0;
  return {
    totalMs: 60_000,
    get canStartAttemptCalls() { return canStartCalls; },
    remainingMs: () => 60_000,
    expired: () => false,
    takeTurn: () => true,
    canStartAttempt: () => { canStartCalls += 1; return canStartCalls === 1; },
    describe: () => 'stub budget remaining=60000ms turns=0/6',
  };
}

// A budget with time left, but far less than the backoff the retry asked for:
// the state both outer loops were in when CI v3.9.57 issued a doomed retry.
// canStartAttempt() is deliberately true — a post-sleep gate cannot catch this
// one, because budgetedSleep() had already returned `remainingMs() > 0`. The
// rule under test is that the backoff itself must be affordable.
function budgetTooShortForBackoff(leftMs = 5) {
  return {
    totalMs: 60_000,
    remainingMs: () => leftMs,
    expired: () => false,
    takeTurn: () => true,
    canStartAttempt: () => true,
    describe: () => `stub budget remaining=${leftMs}ms`,
  };
}

describe('budget primitives', () => {
  it('defaults to 10 min, +5 min for streams, and honours env overrides', () => {
    assert.equal(resolveRequestBudgetMs({ stream: false, env: {} }), 600_000);
    assert.equal(resolveRequestBudgetMs({ stream: true, env: {} }), 900_000);
    assert.equal(resolveRequestBudgetMs({ stream: false, env: { WINDSURFAPI_REQUEST_BUDGET_MS: '120000' } }), 120_000);
    assert.equal(resolveRequestBudgetMs({
      stream: true,
      env: { WINDSURFAPI_REQUEST_BUDGET_MS: '120000', WINDSURFAPI_REQUEST_BUDGET_STREAM_MS: '30000' },
    }), 150_000);
    // A garbage value falls back to the default instead of disabling the bound.
    assert.equal(resolveRequestBudgetMs({ stream: false, env: { WINDSURFAPI_REQUEST_BUDGET_MS: 'nope' } }), 600_000);
  });

  it('clamps waits, expires at the deadline, and caps upstream turns at 6 by default', () => {
    let clock = 1_000;
    const budget = createRequestBudget({ deadlineMs: 500, now: () => clock });
    assert.equal(budget.remainingMs(), 500);
    clock += 200;
    assert.equal(budget.remainingMs(), 300);
    assert.equal(budget.waitMs(30_000), 300, 'a layer wait may only be shortened');
    assert.equal(budget.waitMs(100), 100);
    assert.equal(budget.turnCap, 6);
    for (let i = 0; i < 6; i += 1) assert.equal(budget.takeTurn(), true, `turn ${i + 1}`);
    assert.equal(budget.turnsUsed, 6);
    assert.equal(budget.takeTurn(), false);
    assert.equal(budget.canStartAttempt(), false);
    clock += 400;
    assert.equal(budget.expired(), true);
    assert.equal(budget.remainingMs(), 0);
    assert.equal(budget.waitMs(5_000), 0);
  });

  it('a turn-cap stop is a non-retryable 504-class error', () => {
    const budget = createRequestBudget({ deadlineMs: 60_000, upstreamTurnCap: 0 });
    assert.throws(() => budget.takeTurnOrThrow('test'), (err) => {
      assert.equal(isBudgetExceededError(err), true);
      assert.equal(err.code, 'DEADLINE_EXCEEDED');
      assert.equal(err.type, 'upstream_deadline_exceeded');
      assert.equal(err.status, undefined, 'a numeric 5xx status would make isRetryable() retry it');
      return true;
    });
  });
});

describe('the connect adapter observes the request budget', () => {
  it('stops the empty-retry chain at the turn cap (2) instead of spending its own allowance', async () => {
    saveEnv('DEVIN_CONNECT_RETRY_ON_EMPTY_MS');
    process.env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS = '0';
    let calls = 0;
    // Every turn is an empty completion, which the adapter would normally retry
    // up to 2 times (and rescue up to 2 more). The request budget caps the whole
    // request at 2 turns.
    __setStreamChatForTest(async function* fake() {
      calls += 1;
      yield { type: 'finish', reason: 'stop' };
    });
    const budget = createRequestBudget({ deadlineMs: 60_000, upstreamTurnCap: 2 });
    await assert.rejects(
      () => streamChatCompletion(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
        () => {},
        { budget, displayModel: 'gpt-5.5' },
      ),
      (err) => isBudgetExceededError(err),
    );
    assert.equal(calls, 2, 'the third upstream call must never be issued');
  });

  it('stops the non-stream retry chain at the deadline', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* fake() {
      calls += 1;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const budget = createRequestBudget({ deadlineMs: 80 });
    const started = Date.now();
    await assert.rejects(
      () => toChatCompletion(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
        { budget, maxRetries: 5, retryBaseMs: 400 },
      ),
      /socket hang up/,
      'the last real upstream error is surfaced, not a synthetic budget error',
    );
    const elapsed = Date.now() - started;
    assert.equal(calls, 1, 'no retry may start after the deadline');
    assert.ok(elapsed < 600, `the retry loop must stop at the deadline (took ${elapsed} ms)`);
  });

  it('re-checks the budget after the backoff (non-stream): a spent wait never reaches the upstream', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* fake() {
      calls += 1;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const budget = budgetSpentDuringBackoff();
    await assert.rejects(
      () => toChatCompletion(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
        { budget, maxRetries: 3, retryBaseMs: 1 },
      ),
      (err) => {
        assert.equal(err.message, 'socket hang up', 'the real upstream error surfaces');
        assert.equal(isBudgetExceededError(err), false, 'not a synthetic budget error');
        return true;
      },
    );
    assert.equal(calls, 1, 'the retry after the backoff must never be issued');
    assert.equal(budget.canStartAttemptCalls, 2, 'both the pre-sleep and the post-sleep gate ran');
  });

  it('re-checks the budget after the backoff (stream): a spent wait never reaches the upstream', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* fake() {
      calls += 1;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const budget = budgetSpentDuringBackoff();
    await assert.rejects(
      () => streamChatCompletion(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
        () => {},
        { budget, maxRetries: 3, retryBaseMs: 1 },
      ),
      (err) => {
        assert.equal(err.message, 'socket hang up', 'the real upstream error surfaces');
        assert.equal(isBudgetExceededError(err), false, 'not a synthetic budget error');
        return true;
      },
    );
    assert.equal(calls, 1, 'the retry after the backoff must never be issued');
    assert.equal(budget.canStartAttemptCalls, 2, 'both the pre-sleep and the post-sleep gate ran');
  });

  it('will not pace a retry the budget cannot cover (non-stream)', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* fake() {
      calls += 1;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    await assert.rejects(
      () => toChatCompletion(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
        { budget: budgetTooShortForBackoff(), maxRetries: 3, retryBaseMs: 400 },
      ),
      /socket hang up/,
      'the real upstream error surfaces, not a synthetic budget error',
    );
    assert.equal(calls, 1, 'a 400 ms backoff with 5 ms of budget must not start a retry');
  });

  it('will not pace a retry the budget cannot cover (stream)', async () => {
    let calls = 0;
    __setStreamChatForTest(async function* fake() {
      calls += 1;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    await assert.rejects(
      () => streamChatCompletion(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
        () => {},
        { budget: budgetTooShortForBackoff(), maxRetries: 3, retryBaseMs: 400 },
      ),
      /socket hang up/,
      'the real upstream error surfaces, not a synthetic budget error',
    );
    assert.equal(calls, 1, 'a 400 ms backoff with 5 ms of budget must not start a retry');
  });
});

describe('the cascade handler observes the request budget', () => {
  it('a slow failing chain cannot exceed the budget', async () => {
    for (const label of ['a', 'b', 'c']) addAccount(label);
    let calls = 0;
    class SlowFailClient {
      async cascadeChat() {
        calls += 1;
        await sleep(60);
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
    }
    const budget = createRequestBudget({ deadlineMs: 100 });
    const started = Date.now();
    const result = await handleChatCompletions({
      model: 'glm-5.1',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async waitForAccount(tried, _signal, _maxWaitMs, modelKey) { return getApiKey(tried, modelKey); },
      async ensureLs() {},
      getLsFor() { return { port: 17777, csrfToken: 'csrf', generation: 1 }; },
      WindsurfClient: SlowFailClient,
      budget,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.status, 504, `a budget stop is a 504, got ${result.status}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body?.error?.type, 'upstream_deadline_exceeded');
    assert.ok(calls <= 2, `the account loop must stop at the deadline (${calls} upstream calls)`);
    assert.ok(elapsed < 700,
      `three attempts at 60 ms + unclamped 500/1000 ms backoffs would take ~1.7 s; the budget must bound it (took ${elapsed} ms)`);
  });

  it('refuses the next upstream turn when the turn cap is already spent', async () => {
    addAccount('cap');
    let calls = 0;
    class CountingClient {
      async cascadeChat() { calls += 1; return { text: 'ok', cascadeId: 'c', sessionId: 's', stepOffset: 0, generatorOffset: 0 }; }
    }
    const budget = createRequestBudget({ deadlineMs: 60_000, upstreamTurnCap: 0 });
    const result = await handleChatCompletions({
      model: 'glm-5.1',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async waitForAccount(tried, _signal, _maxWaitMs, modelKey) { return getApiKey(tried, modelKey); },
      async ensureLs() {},
      getLsFor() { return { port: 17777, csrfToken: 'csrf', generation: 1 }; },
      WindsurfClient: CountingClient,
      budget,
    });
    assert.equal(calls, 0, 'a spent budget must refuse the upstream call, not issue it');
    assert.equal(result.status, 504);
  });
});

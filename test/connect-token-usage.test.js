import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { recordTokenUsage, getStats, resetStats } from '../src/dashboard/stats.js';
import { normalizeConnectUsage } from '../src/devin-connect.js';
import { openAIToAnthropic } from '../src/handlers/messages.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// B1 — the DEVIN_CONNECT request path (both non-stream toChatCompletion and the
// three streamChatCompletion sites) must feed recordTokenUsage, or the dashboard
// "Token 用量分布" card stays empty on connect-only deployments (homecloud showed
// tokenTotals all-zero / requests_with_usage:0 despite hundreds of requests,
// because only the cascade paths called recordTokenUsage).

describe('B1: recordTokenUsage accumulates a DEVIN_CONNECT usage shape', () => {
  it('maps OpenAI-style usage (prompt/completion + cache_read) into tokenTotals', () => {
    resetStats();
    // Shape returned by devin-connect-openai.js (ev.usage → body.usage / return.usage).
    recordTokenUsage({
      prompt_tokens: 120,
      completion_tokens: 45,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    const tt = getStats().tokenTotals;
    assert.equal(tt.requests_with_usage, 1, 'a connect turn with usage must increment the counter');
    assert.equal(tt.cache_read, 20, 'cached_tokens → cache_read');
    assert.equal(tt.fresh_input, 100, 'fresh_input = prompt - cached (120-20)');
    assert.equal(tt.output, 45, 'completion_tokens → output');
    assert.equal(tt.total, 165, 'total = fresh + cacheR + cacheW + output');
    resetStats();
  });

  it('is a safe no-op on null/absent usage (the try/catch guard around it never needs to fire)', () => {
    resetStats();
    recordTokenUsage(null);
    recordTokenUsage(undefined);
    recordTokenUsage({});
    assert.equal(getStats().tokenTotals.requests_with_usage, 0, 'no usage → no counter bump, no throw');
    resetStats();
  });
});

describe('B1: the DEVIN_CONNECT paths are actually wired to recordTokenUsage', () => {
  // Source-level invariant (chat.js connect handler is not unit-drivable without a
  // full pool + mocked upstream; same source-assertion convention as
  // http-cache-control.test.js). Guards against the wiring being dropped again.
  const chat = readFileSync(join(REPO_ROOT, 'src/handlers/chat.js'), 'utf-8');

  it('non-stream connect choke point records usage from r.out.body.usage', () => {
    // `[,)]` accepts the per-model second argument added for per-model token
    // stats; the WIRING is what this guards, not the arity.
    assert.match(chat, /recordTokenUsage\(r\.out\?\.body\?\.usage[,)]/,
      'non-stream connect ok-path must feed recordTokenUsage');
  });

  it('both streamChatCompletion sites capture and record the returned usage', () => {
    // The return value used to be discarded (`await streamChatCompletion(...)`);
    // now each is captured into _sr* and recorded. Q5 removed the handler-owned
    // transient replay, so the two remaining ok paths are the initial attempt
    // and the re-login retry.
    const matches = chat.match(/recordTokenUsage\(_sr\d?\?\.usage[,)]/g) || [];
    assert.ok(matches.length >= 2, `expected >=2 stream usage-record sites, found ${matches.length}`);
    // And ensure NO ok-return stream path discards the result (both the direct
    // `(params, send, connectMeta)` site and the re-login `({...token}, …)` site
    // must capture into _sr* before finalize — a bare discard = token dist
    // empty on that path). Guard both call shapes. The attribution name in this
    // pattern is connectDisplayModel (P2-6): the served name, not reqModelName.
    assert.doesNotMatch(chat, /await streamChatCompletion\([^;]*\);\n\s+finalizeConnectAccount\(a, \{ model: connectDisplayModel, startTime: ccStart, err: null \}\);\n\s+return \{ kind: 'ok' \}/,
      'a streamChatCompletion result on any ok path must be captured (const _sr = …), not discarded');
    // Exactly two capture sites (main attempt, re-login replay).
    assert.equal(matches.length, 2, `expected exactly 2 stream capture sites, found ${matches.length}`);
  });
});

// O2 (evidence/ClientSandboxes.md §5.3): omp 18.12.6 saw `prompt_tokens: 3` for an
// ~11.5k prompt on 2 of 7 requests. The condition was NOT a retry/failover: those two
// were the FIRST request of a fresh conversation, which the upstream reported as a
// cache WRITE (`#7.2` fresh=3, `#7.4` cache_write=11329). `normalizeConnectUsage`
// put cache_write only into total_tokens, so the OpenAI-shaped prompt_tokens was the
// fresh remainder alone — the real input count is fresh + cache_read + cache_write.
// The same two responses also omitted `prompt_tokens_details` entirely (tag 5 is
// absent on a write turn), while the other five carried `cached_tokens`.
describe('O2: prompt_tokens is the real input count on every connect turn', () => {
  // The measured cache-write shape: fresh=3, cache_write=11329, completion=170
  // (total 11,502 in the capture).
  const WRITE_TURN = { prompt: 3, completion: 170, cache_write_tokens: 11329 };
  // The measured cache-read shape from the other five responses.
  const READ_TURN = { prompt: 3, completion: 170, cache_read_tokens: 10878 };

  it('a cache-write turn reports the full input, not the fresh remainder', () => {
    const u = normalizeConnectUsage(WRITE_TURN);
    assert.equal(u.prompt_tokens, 3 + 11329, 'fresh + cache_write is the input the model processed');
    assert.equal(u.completion_tokens, 170);
    assert.equal(u.total_tokens, u.prompt_tokens + u.completion_tokens,
      'the OpenAI arithmetic identity now holds by construction: cache_write is input, not an extra');
    assert.equal(u.cache_creation_input_tokens, 11329, 'the write is still reported separately');
    assert.equal(u.fresh_input_tokens, 3, 'and the fresh remainder is recoverable for Anthropic-shaped consumers');
  });

  it('prompt_tokens_details is present even when the upstream reported no cache read', () => {
    const u = normalizeConnectUsage(WRITE_TURN);
    assert.deepEqual(u.prompt_tokens_details, { cached_tokens: 0 },
      'OpenAI always carries the detail object; omitting it made the breakdown disappear on write turns');
  });

  it('a cache-read turn keeps cached_tokens a subset of the full input', () => {
    const u = normalizeConnectUsage(READ_TURN);
    assert.equal(u.prompt_tokens, 3 + 10878);
    assert.equal(u.prompt_tokens_details.cached_tokens, 10878);
    assert.equal(u.total_tokens, 3 + 10878 + 170);
    assert.equal(u.fresh_input_tokens, 3);
  });

  it('the Anthropic surface still sees mutually exclusive buckets (no double count)', () => {
    // /v1/messages reads the SAME object; input_tokens is fresh-only there and the
    // cache counters are siblings. Including the write in prompt_tokens must not
    // leak into input_tokens, or Claude Code would count the prefix twice.
    const usage = normalizeConnectUsage(WRITE_TURN);
    const out = openAIToAnthropic({
      model: 'claude-sonnet-4-6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage,
    }, 'claude-sonnet-4-6', 'msg_o2');
    assert.equal(out.usage.input_tokens, 3);
    assert.equal(out.usage.cache_creation_input_tokens, 11329);
    assert.equal(out.usage.cache_read_input_tokens, 0);
    assert.equal(
      out.usage.input_tokens + out.usage.cache_creation_input_tokens + out.usage.cache_read_input_tokens,
      usage.prompt_tokens,
      'the three Anthropic buckets must add back up to the full input',
    );
  });

  it('the dashboard token card books fresh / read / write once each', () => {
    resetStats();
    recordTokenUsage(normalizeConnectUsage(WRITE_TURN));
    const tt = getStats().tokenTotals;
    assert.equal(tt.fresh_input, 3, 'fresh must not absorb the cache write');
    assert.equal(tt.cache_read, 0);
    assert.equal(tt.cache_write, 11329);
    assert.equal(tt.output, 170);
    assert.equal(tt.total, 11502, 'fresh + read + write + output, counted once');
    resetStats();
  });
});

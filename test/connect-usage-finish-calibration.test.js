// Two usage/finish defects that every paid response hit, both live-reproduced on
// a paid teams account and both fixed at the point where the value is born, so all
// four protocol routes are corrected together.
//
// 1. USAGE SUBSET INVARIANT. The connect path reported the upstream's raw
//    fresh-input count as prompt_tokens while cached_tokens carried the cache hit.
//    On a cache-hit turn that produced cached_tokens=1765 alongside
//    prompt_tokens=3 — a subset field larger than its superset — and
//    total_tokens=158 against ~1768 real input tokens, a ~91% under-report. Every
//    billing relay in front of this proxy meters from exactly these numbers. The
//    Cascade path already normalised this (#118); the connect path did not.
//
// 2. STOP REASON 4. STOP_REASON_DEFAULT guessed 4 = max_turn_requests → 'length'
//    from the protobuf variant NAME order. On a paid account 4 is the normal
//    completion: three probes with max_tokens 300 / 8 / 40 all returned 4, and the
//    max_tokens=300 one answered "HI" (2 chars, unambiguously complete). So every
//    complete paid response read as truncated — finish_reason='length' on
//    /v1/chat/completions, status='incomplete' on /v1/responses. A client that
//    auto-continues on a length finish would loop forever on complete answers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapFinishReason, resolveFinishReason, normalizeConnectUsage } from '../src/devin-connect.js';

describe('stop reason mapping (paid calibration 2026-07-27)', () => {
  it('4 is a clean stop, not a truncation', () => {
    assert.equal(mapFinishReason(4, {}), 'stop',
      'a paid account returns 4 on normal completion — mapping it to length makes '
      + 'every complete response look truncated');
  });

  it('keeps the live-anchored free-tier value', () => {
    assert.equal(mapFinishReason(2, {}), 'stop', '2 is the verified free-tier clean stop');
  });

  it('reports genuine truncation from the descriptor-pinned enum AND from usage', () => {
    // 3 and 5 are no longer name-order guesses: the binary descriptor set pins
    // 3 = MAX_TOKENS and 5 = MAX_NEWLINES, so the enum itself reports 'length'.
    // (4 remains 'stop' — the paid capture outranks its MIN_LOG_PROB name.)
    assert.equal(mapFinishReason(3, {}), 'length');
    assert.equal(mapFinishReason(5, {}), 'length');
    // The usage-based inference still covers an enum that only says 'stop'
    // (e.g. 2/4) when completion_tokens lands on the caller's cap.
    assert.equal(resolveFinishReason(3, { completion_tokens: 128 }, 128, {}), 'length',
      'a turn that used its entire output budget is a genuine truncation');
    assert.equal(resolveFinishReason(2, { completion_tokens: 128 }, 128, {}), 'length');
    // And an operator with a real capture can override the enum mapping outright.
    assert.equal(mapFinishReason(3, { DEVIN_CONNECT_STOP_REASON_MAP: '3=stop' }), 'stop');
    assert.equal(mapFinishReason(5, { DEVIN_CONNECT_STOP_REASON_MAP: '5=content_filter' }),
      'content_filter');
  });

  it('an unknown value degrades to stop, never to an error-looking reason', () => {
    assert.equal(mapFinishReason(99, {}), 'stop');
    assert.equal(mapFinishReason(0, {}), 'stop');
  });

  it('null means "no reason yet", not a stop', () => {
    assert.equal(mapFinishReason(null, {}), null);
  });

  it('an operator can still override the whole table', () => {
    // The escape hatch matters because these integers are calibrated from
    // captures, not from a published schema.
    const env = { DEVIN_CONNECT_STOP_REASON_MAP: '4=length,2=length' };
    assert.equal(mapFinishReason(4, env), 'length');
    assert.equal(mapFinishReason(2, env), 'length');
  });

  it('rejects an override to a value outside the OpenAI vocabulary', () => {
    const env = { DEVIN_CONNECT_STOP_REASON_MAP: '4=banana' };
    assert.equal(mapFinishReason(4, env), 'stop', 'an invalid mapping must not take effect');
  });
});

describe('usage subset invariant on the connect path', () => {
  // Uses the REAL production normalizer. An earlier version of this suite
  // reimplemented the arithmetic inline, so degrading the production path did not
  // fail it — a mirror test is not a test. Verified by mutation: with the mirror,
  // breaking `prompt = fresh + cacheRead` left all 12 cases green.
  const normalize = (u) => normalizeConnectUsage(u);

  it('cached_tokens is a SUBSET of prompt_tokens on a cache-hit turn', () => {
    // The measured live shape before the fix: fresh=3, cache_read=1765.
    const u = normalize({ prompt: 3, completion: 155, cache_read_tokens: 1765, cache_write_tokens: 6 });
    assert.equal(u.prompt_tokens, 3 + 1765 + 6,
      'prompt_tokens must include BOTH cache read and cache write');
    assert.ok(u.prompt_tokens_details.cached_tokens <= u.prompt_tokens,
      `cached_tokens ${u.prompt_tokens_details.cached_tokens} must not exceed prompt_tokens ${u.prompt_tokens}`);
  });

  it('total_tokens is the full billable cost, counted once', () => {
    const u = normalize({ prompt: 3, completion: 155, cache_read_tokens: 1765, cache_write_tokens: 6 });
    assert.equal(u.total_tokens, 3 + 1765 + 6 + 155,
      'cache_write is already inside prompt_tokens, so the total must not add it again');
    assert.equal(u.total_tokens, u.prompt_tokens + u.completion_tokens,
      'OpenAI arithmetic identity holds by construction');
  });

  it('a cache-write turn (first call) reports the write as INPUT, not as a side cost', () => {
    // O2 (evidence/ClientSandboxes.md §5.3): omp saw prompt_tokens=3 for an ~11.5k
    // prompt on exactly the two cache-WRITE turns. A write is input the model
    // processed (the prefix was read to be cached), so it belongs in prompt_tokens;
    // #118's "generation-side" framing only ever described the Cascade bucket split.
    const u = normalize({ prompt: 3, completion: 210, cache_write_tokens: 1771 });
    assert.equal(u.prompt_tokens, 3 + 1771, 'fresh + cache_write is the real input count');
    assert.equal(u.cache_creation_input_tokens, 1771, 'the write stays visible on the Anthropic field');
    assert.equal(u.total_tokens, 3 + 1771 + 210);
  });

  it('an uncached turn still carries the OpenAI detail object (zero cached)', () => {
    const u = normalize({ prompt: 400, completion: 20 });
    assert.equal(u.prompt_tokens, 400);
    assert.equal(u.total_tokens, 420);
    assert.deepEqual(u.prompt_tokens_details, { cached_tokens: 0 },
      'omitting the detail object made the cache breakdown disappear on write turns (O2)');
    assert.equal('cache_creation_input_tokens' in u, false, 'no write counter was reported');
  });

  it('holds for arbitrary combinations (property check)', () => {
    for (let i = 0; i < 200; i++) {
      const u = normalize({
        prompt: Math.floor(Math.random() * 500),
        completion: Math.floor(Math.random() * 500),
        cache_read_tokens: Math.random() < 0.5 ? Math.floor(Math.random() * 3000) : null,
        cache_write_tokens: Math.random() < 0.5 ? Math.floor(Math.random() * 3000) : null,
      });
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      assert.ok(cached <= u.prompt_tokens, 'cached_tokens must always be a subset');
      assert.equal(u.total_tokens, u.prompt_tokens + u.completion_tokens,
        'the OpenAI identity must hold for every combination, not just the measured ones');
    }
  });
});

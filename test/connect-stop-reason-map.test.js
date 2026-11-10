// P1 (Q7 descriptor audit): the old table mapped every StopReason to 'stop',
// so a native tool-call turn, a max-token truncation, a content filter and an
// upstream ERROR were all reported to clients as a clean completion.
//
// The table below is the enum as defined by the binary descriptor set
// (exa.codeium_common_pb.StopReason, 0–13, extracted in the Q7 audit from
// leookun/devin-2api @ e7ddc55 `descriptors.pb`). The independent Go decoder
// (internal/adapter/devin/response_decoder.go) corroborates the non-trivial
// rows: INCOMPLETE/MAX_TOKENS/PARTIAL → length, FUNCTION_CALL → tool_use,
// ERROR → error.
//
// 2 and 4 additionally have LIVE anchors (2 = free-tier clean stop, 4 = paid
// clean stop, 2026-07-27 calibration); the descriptor does not contradict them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapFinishReason, resolveFinishReason } from '../src/devin-connect.js';
import { log } from '../src/config.js';

const DESCRIPTOR_STOP_REASON = {
  0: 'stop',           // STOP_REASON_UNSPECIFIED
  1: 'length',         // INCOMPLETE
  2: 'stop',           // STOP_PATTERN (live-anchored clean stop)
  3: 'length',         // MAX_TOKENS
  4: 'stop',           // MIN_LOG_PROB (live-anchored paid clean stop)
  5: 'length',         // MAX_NEWLINES
  6: 'stop',           // EXIT_SCOPE
  7: 'stop',           // NONFINITE_LOGIT_OR_PROB
  8: 'stop',           // FIRST_NON_WHITESPACE_LINE
  9: 'length',         // PARTIAL
  10: 'tool_calls',    // FUNCTION_CALL
  11: 'content_filter', // CONTENT_FILTER
  12: 'stop',          // NON_INSERTION
  13: 'error',         // ERROR
};

describe('StopReason → OpenAI finish_reason (descriptor-backed)', () => {
  it('maps every enum value 0–13 exactly once, as Number and as BigInt', () => {
    for (const [raw, want] of Object.entries(DESCRIPTOR_STOP_REASON)) {
      const n = Number(raw);
      assert.equal(mapFinishReason(n, {}), want, `StopReason ${n} must map to ${want}`);
      assert.equal(mapFinishReason(BigInt(n), {}), want,
        `the BigInt form of ${n} must map identically (proto varints decode as BigInt)`);
    }
  });

  it('FUNCTION_CALL (10) reports tool_calls, not a clean stop', () => {
    assert.equal(mapFinishReason(10, {}), 'tool_calls');
  });

  it('MAX_TOKENS (3) reports length, not a clean stop', () => {
    assert.equal(mapFinishReason(3, {}), 'length');
  });

  it('CONTENT_FILTER (11) reports content_filter, not a clean stop', () => {
    assert.equal(mapFinishReason(11, {}), 'content_filter');
  });

  it('ERROR (13) reports error, not a clean stop', () => {
    assert.equal(mapFinishReason(13, {}), 'error');
  });

  it('null means "no reason yet", not a stop', () => {
    assert.equal(mapFinishReason(null, {}), null);
  });

  it('unknown values fall back to stop and log once per distinct value', () => {
    const warns = [];
    const original = log.warn;
    log.warn = (...args) => warns.push(args.join(' '));
    try {
      assert.equal(mapFinishReason(424242, {}), 'stop');
      assert.equal(mapFinishReason(424242, {}), 'stop');
      assert.equal(mapFinishReason(424242n, {}), 'stop');
    } finally {
      log.warn = original;
    }
    assert.equal(warns.length, 1, 'one line per unknown value, not one per frame');
    assert.match(warns[0], /424242/, 'the log line must name the value for diagnosis');
  });

  it('an operator override still wins over the descriptor table', () => {
    const env = { DEVIN_CONNECT_STOP_REASON_MAP: '13=stop,3=stop,10=content_filter' };
    assert.equal(mapFinishReason(13, env), 'stop');
    assert.equal(mapFinishReason(3, env), 'stop');
    assert.equal(mapFinishReason(10, env), 'content_filter');
  });

  it('the usage-based truncation inference never overwrites a stronger reason', () => {
    // A FUNCTION_CALL / CONTENT_FILTER / ERROR turn that happens to land on the
    // token cap is still a tool call / refusal / failure, not a truncation.
    for (const reason of [10, 11, 13]) {
      const mapped = mapFinishReason(reason, {});
      assert.equal(resolveFinishReason(reason, { completion_tokens: 64 }, 64, {}), mapped);
    }
    // A clean-stop enum still upgrades on a genuine cap hit.
    assert.equal(resolveFinishReason(2, { completion_tokens: 64 }, 64, {}), 'length');
  });
});

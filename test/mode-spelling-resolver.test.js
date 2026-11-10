// G4 offline half — DEVIN_CONNECT mode-name resolver matrix.
//
// The live Pro matrix (devinpro-complete-capability-matrix, 2026-10-19) probed 23
// enabled mode names: 6 returned 200 and 17 returned 400 model_not_found BEFORE
// any upstream roundtrip. That split is decided entirely by the pure resolver
// (resolveConnectSelector → mapped:false) plus the strict-model gate in
// handlers/chat.js, so it is lockable offline with no account and no network.
//
// This file pins the spelling rules that the live run proved:
//   - the effort tier comes BEFORE the lane: swe-2-<tier>-lightning resolves,
//     swe-2-lightning-<tier> does not (reversed order was a live 400);
//   - there is no fast-lane selector on the gpt-6 family (gpt-6-astra-fast 400);
//   - bare family names that only exist with a vendor prefix do not resolve
//     (gpt-5-6 / fable-5-1 / opus-5-5), while their prefixed forms do;
//   - swe-2 has no -priority tier even though gpt-5 families do.
//
// Rows are written as the live HTTP outcome: a selector means the name resolves
// (upstream 200 in the matrix), null means no selector and therefore 400. That
// live mapping is the 23-name table plus the three correct-order lightning forms
// (GAP-CLOSURE 2026-10-19). The remaining near-miss controls are catalog-backed
// resolver expectations and were not live-probed.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveConnectSelector,
  isKnownConnectSelector,
  getSnapshotSelectors,
  hasLiveCatalog,
  FREE_TIER_SELECTOR,
} from '../src/devin-connect-models.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

// The 23 enabled mode names exactly as the live matrix enumerated them.
// Left column: request model name. Right column: upstream selector, or null for
// the 17 names the matrix recorded as 400 model_not_found.
const MODE_MATRIX = [
  // Cascade mode words are not model selectors on the Connect path.
  ['normal', null],
  ['fast', null],
  ['fusion', null],
  ['fusion-fast', null],
  ['async', null],
  ['lite', null],
  ['ultra', null],
  // SWE-2 effort tiers: the three live 200s.
  ['swe-2-medium', 'swe-2-medium'],
  ['swe-2-high', 'swe-2-high'],
  ['swe-2-max', 'swe-2-max'],
  // -priority is not a swe-2 tier (the catalog only carries -priority on gpt-5
  // families), so all three live 400s.
  ['swe-2-priority-medium', null],
  ['swe-2-priority-high', null],
  ['swe-2-priority-max', null],
  // Reversed lane order — the live matrix's canonical near-miss.
  ['swe-2-lightning-medium', null],
  ['swe-2-lightning-high', null],
  ['swe-2-lightning-max', null],
  // GPT-6 family: bare mode names resolve to their -medium tier.
  ['gpt-6-astra', 'gpt-6-astra-medium'],
  ['gpt-6-astra-fast', null],
  ['gpt-5-6', null],
  ['fable-5-1', null],
  ['opus-5-5', null],
  ['gpt-6-sol', 'gpt-6-sol-medium'],
  ['gpt-6-1-sol', 'gpt-6-1-sol-medium'],
];

// Near-miss spellings outside the 23-name list, plus the prefixed positive
// controls that prove the rejection is about the spelling, not the model.
const NEAR_MISS_MATRIX = [
  // Correct lane order: these 200'd live (GAP-CLOSURE 2026-10-19).
  ['swe-2-medium-lightning', 'swe-2-medium-lightning'],
  ['swe-2-high-lightning', 'swe-2-high-lightning'],
  ['swe-2-max-lightning', 'swe-2-max-lightning'],
  // Reversed lane order, one tier down from the 23-name list.
  ['swe-2-lightning-low', null],
  // No fast lane on any gpt-6 selector.
  ['gpt-6-sol-fast', null],
  ['gpt-6-1-sol-fast', null],
  // Prefixed bare names exist; the unprefixed family word alone does not.
  ['claude-fable-5-1', 'claude-fable-5-1-medium'],
  ['claude-opus-5-5', 'claude-opus-5-5-medium'],
  ['gpt-5-6-sol', 'gpt-5-6-sol-medium'],
  // -priority IS a real tier for gpt-5 families — the suffix is not globally
  // rejected, only absent from swe-2.
  ['gpt-5-5-medium-priority', 'gpt-5-5-medium-priority'],
];

const SNAPSHOT_SELECTORS = new Set(getSnapshotSelectors());
const ALL_ROWS = [...MODE_MATRIX, ...NEAR_MISS_MATRIX];

const SAVED_CONNECT_TOKEN = process.env.DEVIN_CONNECT_TOKEN;
const SAVED_WINDSURF_API_KEY = process.env.WINDSURF_API_KEY;

beforeEach(() => {
  // Cold-start catalog authority: the snapshot, not a live sync.
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
  delete process.env.WINDSURFAPI_STRICT_MODEL;
});

afterEach(() => {
  delete process.env.DEVIN_CONNECT;
  if (SAVED_CONNECT_TOKEN === undefined) delete process.env.DEVIN_CONNECT_TOKEN;
  else process.env.DEVIN_CONNECT_TOKEN = SAVED_CONNECT_TOKEN;
  if (SAVED_WINDSURF_API_KEY === undefined) delete process.env.WINDSURF_API_KEY;
  else process.env.WINDSURF_API_KEY = SAVED_WINDSURF_API_KEY;
});

describe('DEVIN_CONNECT mode-name resolver matrix (live Pro capture 2026-10-19)', () => {
  it('enumerates the 23 mode names from the live matrix, 6 hits + 17 rejects', () => {
    assert.equal(MODE_MATRIX.length, 23, 'the matrix must stay the full live list');
    assert.equal(MODE_MATRIX.filter(([, s]) => s !== null).length, 6);
    assert.equal(MODE_MATRIX.filter(([, s]) => s === null).length, 17);
  });

  it('locks the resolve result for every one of the 23 mode names', () => {
    for (const [name, expected] of MODE_MATRIX) {
      const got = resolveConnectSelector(name, { warnOnFallback: false });
      if (expected === null) {
        assert.equal(got.mapped, false,
          `${name} must NOT resolve (live matrix recorded 400 model_not_found)`);
        assert.equal(got.selector, FREE_TIER_SELECTOR,
          `${name} must degrade to the free-tier fallback internally, never to a guessed paid selector`);
      } else {
        assert.equal(got.mapped, true, `${name} must resolve to ${expected}`);
        assert.equal(got.selector, expected, `${name} resolved to the wrong selector`);
      }
    }
  });

  it('every hit target is a selector the catalog snapshot actually exposes', () => {
    for (const [name, expected] of ALL_ROWS) {
      if (expected === null) continue;
      assert.equal(SNAPSHOT_SELECTORS.has(expected), true,
        `${name} → ${expected} is not in devin-catalog-snapshot.json (matrix row is stale)`);
      assert.equal(isKnownConnectSelector(expected), true,
        `${name} → ${expected} is not a known selector at cold start`);
    }
  });

  it('runs on the frozen snapshot (no live catalog sync in this process)', () => {
    assert.equal(hasLiveCatalog(), false,
      'matrix expectations assume the cold-start snapshot authority');
  });
});

describe('mode spelling near-misses', () => {
  it('resolves the correct lane order swe-2-<tier>-lightning', () => {
    for (const [name, expected] of NEAR_MISS_MATRIX.filter(([n]) => n.endsWith('-lightning'))) {
      assert.deepEqual(resolveConnectSelector(name, { warnOnFallback: false }),
        { selector: expected, mapped: true }, name);
    }
  });

  it('rejects the reversed lane order swe-2-lightning-<tier>', () => {
    for (const name of ['swe-2-lightning-medium', 'swe-2-lightning-high', 'swe-2-lightning-max', 'swe-2-lightning-low']) {
      const got = resolveConnectSelector(name, { warnOnFallback: false });
      assert.equal(got.mapped, false, `${name} (reversed order) must not resolve`);
    }
  });

  it('rejects a -fast suffix that no gpt-6 selector carries', () => {
    for (const name of ['gpt-6-astra-fast', 'gpt-6-sol-fast', 'gpt-6-1-sol-fast']) {
      const got = resolveConnectSelector(name, { warnOnFallback: false });
      assert.equal(got.mapped, false, `${name} must not resolve: the gpt-6 family has no fast lane`);
    }
  });

  it('rejects bare family names that only exist with a vendor prefix', () => {
    for (const [bare, prefixed, selector] of [
      ['gpt-5-6', 'gpt-5-6-sol', 'gpt-5-6-sol-medium'],
      ['fable-5-1', 'claude-fable-5-1', 'claude-fable-5-1-medium'],
      ['opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5-medium'],
    ]) {
      assert.equal(resolveConnectSelector(bare, { warnOnFallback: false }).mapped, false,
        `bare ${bare} must not resolve`);
      assert.deepEqual(resolveConnectSelector(prefixed, { warnOnFallback: false }),
        { selector, mapped: true }, `${prefixed} is the form that resolves`);
    }
  });

  it('rejects swe-2 -priority tiers while gpt-5 -priority selectors stay valid', () => {
    for (const name of ['swe-2-priority-medium', 'swe-2-priority-high', 'swe-2-priority-max', 'swe-2-medium-priority']) {
      assert.equal(resolveConnectSelector(name, { warnOnFallback: false }).mapped, false,
        `${name} must not resolve: the snapshot has no swe-2 priority tier`);
    }
    assert.deepEqual(resolveConnectSelector('gpt-5-5-medium-priority', { warnOnFallback: false }),
      { selector: 'gpt-5-5-medium-priority', mapped: true });
  });
});

describe('strict-model gate turns every rejected spelling into 400 model_not_found', () => {
  it('rejects each unmapped matrix row before any upstream call', async () => {
    process.env.DEVIN_CONNECT = '1';
    const rejected = [...new Set(ALL_ROWS.filter(([, s]) => s === null).map(([n]) => n))];
    assert.equal(rejected.length, 20, 'expected 20 distinct rejected spellings across both tables');
    for (const name of rejected) {
      const result = await handleChatCompletions({
        model: name,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(result.status, 400, `${name} must be a 400`);
      assert.equal(result.body.error.code, 'model_not_found', `${name} error code`);
      assert.equal(result.body.error.type, 'invalid_request_error', `${name} error type`);
      assert.equal(result.body.error.param, 'model', `${name} error param`);
      assert.match(result.body.error.message, /not a valid model/i, `${name} error message`);
    }
  });
});

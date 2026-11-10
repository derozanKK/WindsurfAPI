import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableModelsForAccount } from '../src/auth.js';
import {
  getModelInfo,
  getTierModels,
  registerDiscoveredFreeModel,
} from '../src/models.js';

// #149 decision memo (evidence/Wave4-Models.md §2): the public closure reason
// claimed the free tier is statically gemini-2.5-flash + glm-4.7 + kimi-k2.
// The tree deliberately carries ONE model (4b72ecd, v2.0.0, "FREE_TIER_BASE
// updated to gemini-2.5-flash only") and grows the free list per account:
// GetUserStatus's authoritative allowlist for enum-keyed models, a successful
// call (updateCapability → registerDiscoveredFreeModel) for everything else.
// These pins are the cold-start contract, not a snapshot: widening the base
// table has to re-argue the decision instead of silently passing.
describe('#149 — free-tier cold start is one model, by design', () => {
  it('the static free table is exactly gemini-2.5-flash', () => {
    assert.deepEqual(getTierModels('free'), ['gemini-2.5-flash']);
  });

  it('does not statically claim glm-4.7 / kimi-k2', () => {
    const free = getTierModels('free');
    for (const key of ['glm-4.7', 'kimi-k2']) {
      assert.ok(getModelInfo(key), `${key} must stay in the catalog`);
      // Enum-keyed → GetUserStatus's per-account allowlist supplies them when
      // the upstream entitles them. A static entry would instead advertise the
      // model to accounts the upstream did not entitle, and those requests fail
      // upstream (permission_denied → 529) rather than with a clean 403.
      assert.ok(getModelInfo(key).enumValue > 0, `${key} must stay enum-keyed`);
      assert.ok(!free.includes(key), `${key} must not be in the cold-start free table`);
    }
  });

  it('a free account with no probe and no capabilities lists exactly the base table', () => {
    assert.deepEqual(getAvailableModelsForAccount({ tier: 'free' }), ['gemini-2.5-flash']);
  });

  it('grows through discovery, which is how the extra free models appear', () => {
    // Last on purpose: it mutates the process-wide discovery set.
    registerDiscoveredFreeModel('glm-4.7');
    assert.ok(getTierModels('free').includes('glm-4.7'));
  });
});

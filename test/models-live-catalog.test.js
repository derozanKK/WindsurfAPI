// audit 2026-07-12 (v3.2.4 regression fix): after v3.2.3 made resolveConnectSelector
// recognize live-synced selectors, the /v1/models handler still
// filtered against the frozen CATALOG_SELECTORS snapshot ONLY, and the 37 upstream-
// added selectors (gpt-5-6-*/grok-4-5-*/nemotron) aren't in the hardcoded MODELS
// table either — so they ran fine at /v1/chat/completions but were absent from
// /v1/models, leaving Codex/clients unable to discover them. handleModels now
// (a) filters on the authoritative live catalog (with snapshot fallback only
// while a contributor lacks LKG rows) and (b) synthesizes live-only selectors.
//
// NOTE: handleModels imports devin-connect-models via a plain (cached) import, so
// these tests use the SAME cached singleton (no ?fresh= — that would give the
// handler a different instance than the one we seed). Each non-empty seed replaces
// the prior live catalog, so cross-test leakage inside this file is bounded.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearLiveCatalogSelectors,
  setLiveCatalogSelectors,
  resolveConnectSelector,
} from '../src/devin-connect-models.js';
import { handleModels } from '../src/handlers/models.js';

const ENV_ON = { DEVIN_CONNECT: '1' };

afterEach(() => clearLiveCatalogSelectors());

describe('/v1/models — live-catalog synthesis (audit v3.2.4)', () => {
  it('lists a live-only selector that is NOT in the MODELS table nor the snapshot', () => {
    // Suffixed synthetic selectors: live-only fixtures that must stay absent from MODELS
    // and the snapshot — a real selector can be covered by a later model sync (the
    // 2026-10-16 sync landed grok-4-5-medium / gpt-5-6-sol-medium). Same convention as
    // dashboard-models-connect-parity.test.js.
    setLiveCatalogSelectors([
      { selector: '  grok-4-5-medium-live-catalog  ', provider: 'xai', label: 'Grok 4.5 (medium)', supportsImages: true },
      { selector: 'gpt-5-6-sol-medium-live-catalog', provider: 'openai', label: 'GPT-5.6 Sol (medium)', supportsImages: false },
    ]);
    const { data } = handleModels(ENV_ON);
    const ids = new Set(data.map((m) => m.id));
    assert.ok(ids.has('grok-4-5-medium-live-catalog'), 'grok-4-5-medium-live-catalog must appear in /v1/models');
    assert.ok(ids.has('gpt-5-6-sol-medium-live-catalog'), 'gpt-5-6-sol-medium-live-catalog must appear in /v1/models');
    const grok = data.find((m) => m.id === 'grok-4-5-medium-live-catalog');
    assert.equal(grok.object, 'model');
    assert.equal(grok.owned_by, 'xai');
    assert.equal(grok._source, 'live_catalog');
    assert.equal(grok.supports_images, true);
    assert.equal(data.some((m) => m.id !== m.id.trim()), false,
      'live catalog whitespace must not leak into public model ids');
    assert.equal(data.find((m) => m.id === 'gpt-5-6-sol-medium-live-catalog').supports_images, false);
  });

  it('does NOT duplicate a selector already emitted by the MODELS table', () => {
    setLiveCatalogSelectors([{ selector: 'swe-1-6-slow', provider: 'windsurf' }]);
    const { data } = handleModels(ENV_ON);
    const count = data.filter((m) => m.id === 'swe-1-6-slow').length;
    assert.ok(count <= 1, `swe-1-6-slow must not be duplicated (got ${count})`);
  });

  it('deduplicates a live canonical selector already represented by a client alias', () => {
    const selector = 'claude-opus-4-6';
    setLiveCatalogSelectors([{ selector, provider: 'anthropic' }]);
    const { data } = handleModels(ENV_ON);
    const matching = data.filter((m) => {
      if (m._source === 'live_catalog') return m.id === selector;
      return resolveConnectSelector(m._windsurf_id, { warnOnFallback: false }).selector === selector;
    });

    assert.equal(matching.length, 1,
      `one upstream selector must produce one discovery row, got: ${matching.map((m) => m.id).join(', ')}`);
  });

  it('deduplicates MODELS rows that resolve to the same upstream selector', () => {
    const aliases = new Set(['gpt-5.5', 'gpt-5.5-low']);
    const { data } = handleModels(ENV_ON);
    const matching = data.filter((model) => aliases.has(model.id));

    assert.equal(matching.length, 1,
      `gpt-5.5 and gpt-5.5-low both resolve to gpt-5-5-low; discovery must emit one row, got: ${matching.map((model) => model.id).join(', ')}`);
    assert.equal(
      resolveConnectSelector(matching[0]._windsurf_id, { warnOnFallback: false }).selector,
      'gpt-5-5-low',
    );
    assert.equal(matching[0].id, 'gpt-5.5',
      'family alias gpt-5.5 stays the discovery id; do not retarget to gpt-5.5-low');
  });

  it('lists glm-5.2, not glm-5.1, when both resolve to selector glm-5-2', () => {
    const { data } = handleModels(ENV_ON);
    const ids = data.map((m) => m.id);
    assert.equal(ids.includes('glm-5.2'), true, 'glm-5.2 must be the public discovery id');
    assert.equal(ids.includes('glm-5.1'), false,
      'glm-5.1 is a SELECTOR_MAP alias of glm-5-2 and must not hide glm-5.2');
    const row = data.find((m) => m.id === 'glm-5.2');
    assert.equal(
      resolveConnectSelector(row._windsurf_id, { warnOnFallback: false }).selector,
      'glm-5-2',
    );
  });

  it('non-DEVIN_CONNECT deployment returns the full list without live synthesis', () => {
    setLiveCatalogSelectors([{ selector: 'grok-4-5-medium', provider: 'xai' }]);
    // Explicitly override the inherited process environment. Maintainers often
    // run the suite from a real DEVIN_CONNECT=1 deployment shell, and an empty
    // object intentionally inherits that environment inside handleModels().
    const { data } = handleModels({ DEVIN_CONNECT: '0' });
    assert.equal(data.some((m) => m._source === 'live_catalog'), false);
  });
});

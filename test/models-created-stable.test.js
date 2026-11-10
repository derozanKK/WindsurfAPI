// O13: GET /v1/models `created` is process-stable. Clients compare catalog
// rows across polls; stamping Date.now() per request makes the list look
// rebuilt every second.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listModels, MODEL_CREATED } from '../src/models.js';
import { handleModels } from '../src/handlers/models.js';
import {
  clearLiveCatalogSelectors,
  setLiveCatalogSelectors,
} from '../src/devin-connect-models.js';

const ENV_OFF = { DEVIN_CONNECT: '0' };
const ENV_ON = { DEVIN_CONNECT: '1' };
// Suffixed synthetic selector: a live-only fixture must never be covered by a real
// MODELS/snapshot landing (dashboard-models-connect-parity.test.js convention).
const LIVE_ONLY = 'grok-4-5-medium-created-stable';
const FREE_SELECTOR = 'swe-1-6-slow';

afterEach(() => clearLiveCatalogSelectors());

function createdValues(payload) {
  return payload.data.map((row) => row.created);
}

function listModelsSource() {
  const src = readFileSync(new URL('../src/models.js', import.meta.url), 'utf8');
  const start = src.indexOf('export function listModels');
  assert.ok(start >= 0, 'listModels must exist');
  return src.slice(start);
}

describe('O13 MODEL_CREATED', () => {
  it('is an exported unix-seconds integer captured at module load', () => {
    assert.equal(typeof MODEL_CREATED, 'number');
    assert.equal(Number.isInteger(MODEL_CREATED), true);
    assert.ok(MODEL_CREATED > 0);
  });

  it('listModels stamps every row with MODEL_CREATED', () => {
    const rows = listModels();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.created, MODEL_CREATED);
    }
  });

  it('two handleModels calls in the same process return identical created', () => {
    const first = handleModels(ENV_OFF);
    const second = handleModels(ENV_OFF);
    assert.ok(first.data.length > 0);
    assert.deepEqual(createdValues(first), createdValues(second));
    assert.equal(first.data[0].created, MODEL_CREATED);
    assert.equal(second.data[0].created, MODEL_CREATED);
  });

  it('live_catalog and free_reachable rows use the same constant', () => {
    setLiveCatalogSelectors([
      { selector: LIVE_ONLY, provider: 'xai', label: 'Grok 4.5 (medium)' },
    ]);
    const first = handleModels(ENV_ON);
    const live = first.data.find((row) => row.id === LIVE_ONLY);
    const floor = first.data.find((row) => row.id === FREE_SELECTOR);
    assert.ok(live, 'live-only selector must be synthesized');
    assert.equal(live._source, 'live_catalog');
    assert.equal(live.created, MODEL_CREATED);
    assert.ok(floor, 'free-reachable floor must be present');
    assert.equal(floor.created, MODEL_CREATED);
    for (const row of first.data) {
      assert.equal(row.created, MODEL_CREATED);
    }

    const second = handleModels(ENV_ON);
    assert.deepEqual(createdValues(first), createdValues(second));
    assert.equal(second.data.find((row) => row.id === LIVE_ONLY).created, MODEL_CREATED);
    assert.equal(second.data.find((row) => row.id === FREE_SELECTOR).created, MODEL_CREATED);
  });

  it('does not re-read Date.now inside listModels or the models handler', () => {
    const handlerSrc = readFileSync(new URL('../src/handlers/models.js', import.meta.url), 'utf8');
    assert.equal(handlerSrc.includes('Date.now'), false);
    assert.equal(listModelsSource().includes('Date.now'), false);
  });
});

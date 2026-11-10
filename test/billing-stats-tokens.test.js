// Per-model token attribution.
//
// tokenTotals answered "how many tokens did this deployment move"; nothing
// answered "which model moved them", which is the question a bill asks. These
// execute the shipped recorder, not a mirror: recordTokenUsage is the only writer
// of both maps, so a future edit that forgets the per-model half fails here.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStats,
  recordRequest,
  recordTokenUsage,
  resetStats,
} from '../src/dashboard/stats.js';

afterEach(() => resetStats());

const USAGE = {
  prompt_tokens: 1_200,
  completion_tokens: 300,
  prompt_tokens_details: { cached_tokens: 200 },
  cache_creation_input_tokens: 50,
};

describe('tokensByModel', () => {
  it('splits the same usage into per-model buckets and keeps the global totals', () => {
    recordTokenUsage(USAGE, 'swe-2-medium');
    recordTokenUsage(USAGE, 'swe-2-medium');
    recordTokenUsage(USAGE, 'claude-opus-4-8-medium');

    const stats = getStats();
    assert.equal(stats.tokenTotals.total, 3 * (1000 + 200 + 50 + 300));
    assert.deepEqual(stats.tokensByModel['swe-2-medium'], {
      fresh_input: 2000,
      cache_read: 400,
      cache_write: 100,
      output: 600,
      total: 3100,
      requests_with_usage: 2,
    });
    assert.equal(stats.tokensByModel['claude-opus-4-8-medium'].total, 1550);
  });

  it('records no per-model row when the caller does not know the model', () => {
    recordTokenUsage(USAGE, null);
    recordTokenUsage(USAGE, '   ');

    const stats = getStats();
    assert.equal(stats.tokenTotals.requests_with_usage, 2, 'the global tally still counts the turn');
    assert.deepEqual(stats.tokensByModel, {},
      'an unknown model must not invent a row — "(other)" is for capped keys, not for absent ones');
  });

  it('keeps the per-model map inside the request table key set', () => {
    recordRequest('swe-2-medium', true, 10, null);
    recordTokenUsage(USAGE, 'swe-2-medium');
    const stats = getStats();
    for (const key of Object.keys(stats.tokensByModel)) {
      assert.ok(Object.hasOwn(stats.modelCounts, key),
        `${key} has tokens but no request row — the dashboard joins these by key`);
    }
  });
});

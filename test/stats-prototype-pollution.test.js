// P-01 — caller-controlled model keys must never reach an object prototype.
//
// The model string comes straight off the request body. Before the fix,
// recordRequest('__proto__') resolved `modelCounts['__proto__']` to
// Object.prototype and incremented `.requests` on it, so every object in the
// process inherited the counter. These probes drive the real recorder and
// assert both the absence of pollution and the accounting outcome.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStats, recordRequest, recordTokenUsage, resetStats } from '../src/dashboard/stats.js';

const OTHER = '(other)';
const DANGEROUS = ['__proto__', 'constructor', 'toString'];
const COUNTER_FIELDS = [
  'requests', 'success', 'errors', 'totalMs', 'recentMs', 'lastTs',
  'fresh_input', 'cache_read', 'cache_write', 'output', 'total', 'requests_with_usage',
];
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };

// Targets the pre-fix bug wrote through: Object.prototype for "__proto__",
// the Object constructor for "constructor", and Object.prototype.toString for
// "toString". Capture their own-property sets so a failing red run can be
// cleaned up and cannot contaminate the rest of the process.
function captureTargets() {
  return [Object, Object.prototype, Object.prototype.toString].map(target => ({
    target,
    descriptors: Object.getOwnPropertyDescriptors(target),
  }));
}

function restoreTargets(saved) {
  for (const { target, descriptors } of saved) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!Object.hasOwn(descriptors, key)) {
        try { delete target[key]; } catch {}
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!Object.hasOwn(target, key)) {
        try { Object.defineProperty(target, key, descriptor); } catch {}
      }
    }
  }
}

function assertNoCounterFields(target, label) {
  for (const field of COUNTER_FIELDS) {
    assert.equal(Object.hasOwn(target, field), false, `${label} gained own property ${field}`);
  }
}

describe('P-01 stats model-key prototype safety', () => {
  let savedTargets;

  beforeEach(() => {
    savedTargets = captureTargets();
    resetStats();
  });

  afterEach(() => {
    resetStats();
    restoreTargets(savedTargets);
  });

  for (const [name, target, label] of [
    ['__proto__', Object.prototype, 'Object.prototype'],
    ['constructor', Object, 'the Object constructor'],
    ['toString', Object.prototype.toString, 'Object.prototype.toString'],
  ]) {
    it(`recordRequest(${JSON.stringify(name)}) does not pollute ${label}`, () => {
      recordRequest(name, true, 12, null);

      assertNoCounterFields(target, label);
      const stats = getStats();
      assert.equal(stats.totalRequests, 1);
      assert.equal(Object.hasOwn(stats.modelCounts, name), false, 'dangerous key must not become a model row');
      assert.equal(stats.modelCounts[OTHER].requests, 1, 'the request is still counted in the overflow bucket');
      assert.equal(stats.modelCounts[OTHER].success, 1);
    });

    it(`recordTokenUsage(${JSON.stringify(name)}) does not pollute ${label}`, () => {
      recordTokenUsage(USAGE, name);

      assertNoCounterFields(target, label);
      const stats = getStats();
      assert.equal(stats.tokenTotals.total, 15, 'global token totals still count the turn');
      assert.equal(Object.hasOwn(stats.tokensByModel, name), false, 'dangerous key must not become a token row');
      assert.equal(Object.hasOwn(stats.tokensByModel, OTHER), false,
        'an unknown model must not invent an (other) row');
    });
  }

  it('dangerous names never appear as own keys in any per-model map', () => {
    for (const name of DANGEROUS) {
      recordRequest(name, true, 1, null);
      recordTokenUsage(USAGE, name);
    }

    const stats = getStats();
    for (const map of [stats.modelCounts, stats.tokensByModel, stats.creditsByModel]) {
      for (const name of DANGEROUS) {
        assert.equal(Object.hasOwn(map, name), false, `per-model map kept own key ${name}`);
      }
    }
    assert.equal(stats.modelCounts[OTHER].requests, 3);
  });

  it('keeps ordinary model attribution intact', () => {
    recordRequest('gpt-test', true, 12, null);
    recordTokenUsage(USAGE, 'gpt-test');

    const stats = getStats();
    assert.equal(stats.modelCounts['gpt-test'].requests, 1);
    assert.equal(stats.tokensByModel['gpt-test'].total, 15);
    assert.equal(Object.getPrototypeOf(stats.modelCounts), Object.prototype);
    assert.equal(Object.getPrototypeOf(stats.tokensByModel), Object.prototype);
  });
});

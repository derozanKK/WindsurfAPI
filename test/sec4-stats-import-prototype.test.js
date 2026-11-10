// SEC-4 — prototype-key refusal on the stats import path (/dashboard/api/stats/import).
//
// Fidelity note (2026-10-15): this file used to regex-extract importStats out of
// the module source and run that copy inside a string-evaluated function with
// stubbed _state / scheduleSave / RECENT_REQ_CAP (the stub said 200; the module
// ships 500). That asserts a copy of the text, not the module — module-level
// state, the real persistence path and every interaction with the rest of
// stats.js were replaced by the fixture. It now drives the real module the way
// the dashboard does: importStats() in, exportStats() out, with resetStats() as
// the isolation hook (same pattern as policy-block-ring.test.js /
// connect-token-usage.test.js).
//
// The persistence side effect (a debounced write of the temp-dir stats.json) is
// what setup-env's DATA_DIR is for; run this file through `npm test` or
// `node --import ./test/setup-env.mjs --test`, never bare `node --test`.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { importStats, exportStats, resetStats } from '../src/dashboard/stats.js';

// exportStats() carries a per-call timestamp; compare the rest of the snapshot.
function snapshot() {
  const { _exportedAt, ...rest } = exportStats();
  return rest;
}

describe('SEC-4 stats import prototype protection (real module)', () => {
  beforeEach(() => resetStats());

  it('SEC-4: JSON own __proto__ cannot change the state prototype on replace', () => {
    const payload = JSON.parse('{"__proto__":{"totalRequests":1},"totalRequests":7,"recentRequests":[]}');
    assert.equal(Object.hasOwn(payload, '__proto__'), true, 'object-literal syntax is not the HTTP JSON attack');
    assert.deepEqual(importStats(payload, { mode: 'replace' }), { ok: true, mode: 'replace' });
    const s = exportStats();
    assert.equal(s.totalRequests, 7);
    assert.equal(Object.hasOwn(s, '__proto__'), false);
    assert.equal(Object.prototype.totalRequests, undefined);
  });

  it('SEC-4: constructor/prototype keys are removed recursively in replace and merge', () => {
    for (const mode of ['replace', 'merge']) {
      resetStats();
      importStats({ creditsByModel: { normal: 1 }, recentRequests: [] }); // seed, as the old fixture did
      const input = JSON.parse('{"constructor":{"prototype":{"polluted":true}},"creditsByModel":{"normal":3,"__proto__":{"polluted":true},"constructor":2,"prototype":2},"recentRequests":[]}');
      assert.equal(importStats(input, { mode }).ok, true);
      const s = exportStats();
      assert.equal(Object.hasOwn(s, 'constructor'), false);
      const byModel = s.creditsByModel;
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        assert.equal(Object.hasOwn(byModel, key), false, `${mode}: ${key}`);
      }
      assert.equal(Object.getPrototypeOf(byModel), Object.prototype);
      assert.equal(byModel.normal, mode === 'merge' ? 4 : 3);
      assert.equal(Object.prototype.polluted, undefined);
    }
  });

  it('SEC-4: object-literal __proto__ is not confused with an own JSON key', () => {
    const input = { __proto__: { totalRequests: 1 }, recentRequests: [] };
    assert.equal(Object.hasOwn(input, '__proto__'), false);
    assert.deepEqual(importStats(input, { mode: 'replace' }), { ok: true, mode: 'replace' });
    const s = exportStats();
    assert.equal(s.totalRequests, 0);
    assert.deepEqual(s.recentRequests, []);
  });

  it('SEC-4: a replace payload carrying __proto__ cannot leak an inherited default into the next merge', () => {
    // Direct observation of _state's prototype is not part of the module's public
    // surface (getStats()/exportStats() return copies), so probe the equivalent
    // behaviour: if the payload had changed the state's prototype, the next merge
    // would read an inherited totalRequests of 1 and store 6 instead of 5.
    importStats(JSON.parse('{"__proto__":{"totalRequests":1},"recentRequests":[]}'), { mode: 'replace' });
    importStats({ totalRequests: 5 }, { mode: 'merge' });
    assert.equal(exportStats().totalRequests, 5);
  });

  it('SEC-4: clone failure leaves the existing state untouched', () => {
    importStats({ totalRequests: 3, creditsByModel: { normal: 1 } });
    const before = snapshot();
    const cycle = {}; cycle.self = cycle;
    assert.deepEqual(importStats(cycle, { mode: 'replace' }), { ok: false, error: 'invalid snapshot' });
    assert.deepEqual(snapshot(), before);
  });

  it("SEC-4: merge caps recentRequests at the module's real RECENT_REQ_CAP", () => {
    // The old fixture hardcoded RECENT_REQ_CAP = 200 while the module ships 500;
    // this reads the real constant through the real merge path.
    const incoming = [];
    for (let i = 0; i < 520; i++) incoming.push({ ts: 1000 + i, model: `m-${i}` });
    assert.equal(importStats({ recentRequests: incoming }).ok, true);
    const kept = exportStats().recentRequests;
    assert.equal(kept.length, 500, 'the cap must be the module value, not a stub');
    assert.equal(kept[0].ts, 1020, 'oldest entries beyond the cap are dropped first');
    assert.equal(kept[kept.length - 1].ts, 1519, 'newest entry retained at tail');
  });
});

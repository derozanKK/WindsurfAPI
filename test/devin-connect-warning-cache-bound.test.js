// D-SCALE-001 (scale lane, reproduced P2) — the DEVIN_CONNECT degrade-warning record
// was process-lifetime AND caller-controlled.
//
// resolveConnectSelector() records every UNKNOWN model name so the "paid request
// downgraded to free tier" warning fires once per distinct name instead of on every
// request. That record had no cap, no TTL and no delete, and src/handlers/chat.js:3245
// resolves the model BEFORE the strict-model 400 at :3253 — so a completed, rejected
// request still left the caller's raw string resident until restart. 1,025 distinct
// junk names retained 1,025 strings; nothing in the suite bounded it.
//
// The repair keeps the dedupe, keys the cache by SHA-256 digest (fixed 64 chars, so
// retained bytes are bounded as well as cardinality) and evicts the oldest insertion
// once 1,024 entries are exceeded. A duplicate hit does NOT refresh its position, so
// the oldest name may warn again after eviction.
//
// Everything below drives the REAL resolver and the REAL handler; the only seam is
// __testing.degradeWarned, the same object the two pre-existing suites reset. Bounded
// fixtures only: short synthetic names, no sockets, no accounts, no upstream calls.
// A live socket attempt fails loudly here — the deny preload that the audit gates
// export into this child turns any non-loopback connect into NETWORK_STUB_MISS.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectSelector, __testing, FREE_TIER_SELECTOR } from '../src/devin-connect-models.js';
import { handleChatCompletions } from '../src/handlers/chat.js';

// The cap Main approved: at most 1,024 retained entries, oldest insertion evicted.
const MAX_ENTRIES = 1024;
const DEGRADE_MARK = 'paid request downgraded to free tier';

const SAVED_ENV = {
  DEVIN_CONNECT: process.env.DEVIN_CONNECT,
  WINDSURFAPI_STRICT_MODEL: process.env.WINDSURFAPI_STRICT_MODEL,
};

let warnings = [];
let originalWarn = null;

/** Warning lines this test process captured; the filter isolates the degrade signal. */
const degradeWarns = () => warnings.filter((line) => line.includes(DEGRADE_MARK));
const degradeWarnsFor = (name) => degradeWarns().filter((line) => line.includes(name)).length;

beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  __testing.degradeWarned.clear();
});

afterEach(() => {
  console.warn = originalWarn;
  __testing.degradeWarned.clear();
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('DEVIN_CONNECT degrade-warning cache is bounded (D-SCALE-001)', () => {
  it('warning-cache-bounds-distinct-rejections', () => {
    const count = MAX_ENTRIES + 1;
    for (let i = 0; i < count; i++) {
      const r = resolveConnectSelector(`zzscale-junk-${i}`);
      assert.equal(r.selector, FREE_TIER_SELECTOR, 'an unknown name still degrades to the free selector');
      assert.equal(r.mapped, false, 'an unknown name still reports mapped:false');
    }

    assert.equal(
      degradeWarns().length, count,
      'every distinct unknown name still gets its one warning — the bound must not swallow names',
    );
    assert.ok(
      __testing.degradeWarned.size <= MAX_ENTRIES,
      `${count} distinct rejected names left ${__testing.degradeWarned.size} entries resident; the cache must stay at or below ${MAX_ENTRIES}`,
    );
    assert.equal(
      __testing.degradeWarned.size, MAX_ENTRIES,
      'after overflowing by one the cache sits exactly at its cap',
    );
  });

  it('warning-cache-forgets-oldest-keeps-recent', () => {
    const oldest = 'zzscale-oldest-ghost';
    const recent = 'zzscale-recent-ghost';

    resolveConnectSelector(oldest);
    resolveConnectSelector(oldest);
    assert.equal(degradeWarnsFor(oldest), 1, 'a repeat of the same unknown name is deduped');

    // Fill the cache: 1,024 distinct names is enough to push the oldest insertion out.
    for (let i = 0; i < MAX_ENTRIES; i++) resolveConnectSelector(`zzscale-fill-${i}`);
    resolveConnectSelector(recent);

    resolveConnectSelector(oldest);
    assert.equal(
      degradeWarnsFor(oldest), 2,
      'the evicted oldest name must be able to warn again instead of being suppressed forever',
    );

    resolveConnectSelector(recent);
    assert.equal(degradeWarnsFor(recent), 1, 'a recent name stays deduped after the eviction');
  });

  it('warning-cache-retains-no-raw-long-model', () => {
    const longName = `zzscale-long-${'ghostname'.repeat(40)}`;
    assert.ok(longName.length > 300, 'fixture precondition: a modestly long synthetic name');

    resolveConnectSelector(longName);

    const entries = [...__testing.degradeWarned];
    assert.equal(entries.length, 1, 'the unknown name is still recorded, so the dedupe works');
    for (const key of entries) {
      assert.notEqual(key, longName, 'the raw caller-supplied name must never be retained');
      assert.equal(
        String(key).includes('zzscale-long-'), false,
        'no retained key may embed the raw model name',
      );
      assert.equal(
        String(key).length, 64,
        `retained keys must be fixed-width digests, not caller-length strings (got ${String(key).length} chars)`,
      );
      assert.match(String(key), /^[0-9a-f]{64}$/, 'a retained key is a lowercase hex SHA-256 digest');
    }
  });

  it('warning-cache-controls-preserve-resolution', () => {
    assert.equal(
      typeof __testing.degradeWarned.clear, 'function',
      'the pre-existing suites reset this seam with __testing.degradeWarned.clear()',
    );
    const before = __testing.degradeWarned.size;
    const known = 'claude-opus-4-8-medium';

    assert.deepEqual(
      resolveConnectSelector(known),
      { selector: known, mapped: true },
      'a real catalog selector still resolves to itself',
    );
    assert.deepEqual(
      resolveConnectSelector('claude-opus-4.8'),
      { selector: known, mapped: true },
      'a curated dotted alias still resolves to its catalog target',
    );
    assert.deepEqual(
      resolveConnectSelector(''),
      { selector: FREE_TIER_SELECTOR, mapped: false },
      'empty input still returns the free-tier default',
    );
    assert.deepEqual(
      resolveConnectSelector('zzscale-warnoff-ghost', { warnOnFallback: false }),
      { selector: FREE_TIER_SELECTOR, mapped: false },
      'warnOnFallback:false still degrades silently',
    );

    assert.equal(
      __testing.degradeWarned.size, before,
      'a mapped, empty or silent call must not consume cache entries',
    );
    assert.equal(degradeWarns().length, 0, 'none of the control calls emits the degrade warning');
  });

  it('warning-cache-handler-strict400-unchanged', async () => {
    process.env.DEVIN_CONNECT = '1';
    process.env.WINDSURFAPI_STRICT_MODEL = '1';
    const model = 'zzscale-handler-ghost';

    const first = await handleChatCompletions({
      model,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(first.status, 400, 'an unmapped model is still rejected by the strict gate');
    assert.equal(first.body.error.code, 'model_not_found');
    assert.equal(first.body.error.param, 'model');
    assert.match(first.body.error.message, /not a valid model/i);
    assert.equal(degradeWarnsFor(model), 1, 'the first rejected request warns once');
    const sizeAfterFirst = __testing.degradeWarned.size;

    const second = await handleChatCompletions({
      model,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.deepEqual(second, first, 'the strict rejection body must not move');
    assert.equal(degradeWarnsFor(model), 1, 'a repeat rejected request is deduped');
    assert.equal(
      __testing.degradeWarned.size, sizeAfterFirst,
      'a repeat rejected request adds no cache entry',
    );
  });
});

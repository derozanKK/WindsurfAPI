// Unit contract for the DevIn panel builders (src/dashboard/devin-panel.js).
//
// The panel's whole claim is "no fabricated data": every section is either a
// real in-process fact or an explicit `available:false` + reason. These tests
// pin that claim at the builder boundary, including the two places it is easy
// to lose: a merged turn list that silently drops the ring total, and a
// "sessions" array that returns empty instead of saying why.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDevinPanel,
  buildQuotaSection,
  buildRuntimeSection,
  buildSessionsSection,
  buildSessionSources,
  buildTurnsSection,
  MAX_SCAN_ACCOUNTS,
  QUOTA_KNOB_KEYS,
  RUNTIME_SWITCH_KEYS,
  SOURCE_REASONS,
  TURN_ROW_CAP,
  TURN_WINDOW_MS,
} from '../src/dashboard/devin-panel.js';

const NOW = 1_700_000_000_000;

function page(items, summary = {}) {
  const totals = items.reduce((acc, row) => ({
    promptTokens: acc.promptTokens + row.promptTokens,
    completionTokens: acc.completionTokens + row.completionTokens,
    totalTokens: acc.totalTokens + row.totalTokens,
    credit: acc.credit + row.credit,
    acu: acc.acu + row.acu,
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0, credit: 0, acu: 0 });
  return {
    items,
    total: items.length,
    capacity: 100,
    summary: { requests: items.length, ...totals, lastTs: items.length ? items[0].ts : 0, ...summary },
  };
}

function row(ts, extra = {}) {
  return {
    ts,
    model: 'swe-2',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    credit: 1,
    acu: 0.5,
    ...extra,
  };
}

describe('buildTurnsSection', () => {
  it('merges accounts newest-first and sums each ring summary', () => {
    const rings = {
      a1: page([row(NOW - 1_000), row(NOW - 60_000)]),
      a2: page([row(NOW - 30_000, { model: 'swe-2-max' })]),
    };
    const turns = buildTurnsSection({
      accounts: [{ id: 'a1', ref: 'acct-11111111' }, { id: 'a2', ref: 'acct-22222222' }],
      readRequests: (id) => rings[id],
      now: NOW,
    });
    assert.equal(turns.available, true);
    assert.equal(turns.scanned, 2);
    assert.equal(turns.accountsWithTurns, 2);
    assert.equal(turns.retained, 3);
    assert.equal(turns.summary.totalTokens, 45);
    assert.equal(turns.summary.credit, 3);
    assert.equal(turns.summary.acu, 1.5);
    assert.deepEqual(turns.items.map((r) => r.ts), [NOW - 1_000, NOW - 30_000, NOW - 60_000]);
    assert.equal(turns.items[1].model, 'swe-2-max');
  });

  it('keeps failed attempts out of the billed-turn view', () => {
    const failed = row(NOW - 5_000, {
      billed: false, promptTokens: 0, completionTokens: 0, totalTokens: 0, credit: 0, acu: 0,
      outcome: 'rate_limited', status: 429,
    });
    const turns = buildTurnsSection({
      accounts: [{ id: 'a1', ref: 'acct-11111111' }],
      readRequests: () => ({
        items: [failed, row(NOW - 10_000)],
        total: 2,
        billed: 1,
        failed: 1,
        capacity: 100,
        summary: { requests: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, credit: 1, acu: 0.5, lastTs: NOW - 10_000 },
      }),
      now: NOW,
    });
    assert.equal(turns.retained, 1, 'the ring total that counts billed turns comes from summary.requests');
    assert.equal(turns.accountsWithTurns, 1);
    assert.equal(turns.window.turns, 1, 'a failed attempt is not a billed turn');
    assert.equal(turns.items.length, 1);
    assert.equal(turns.items[0].ts, NOW - 10_000);
  });

  it('counts the trailing window from the rows it actually read', () => {
    const turns = buildTurnsSection({
      accounts: [{ id: 'a1', ref: 'acct-11111111' }],
      readRequests: () => page([
        row(NOW - 10),
        row(NOW - TURN_WINDOW_MS + 1),
        row(NOW - TURN_WINDOW_MS - 1),
      ]),
      now: NOW,
    });
    assert.equal(turns.window.ms, TURN_WINDOW_MS);
    assert.equal(turns.window.turns, 2);
    assert.equal(turns.window.totalTokens, 30);
    // The retained total still covers every row, window or not.
    assert.equal(turns.retained, 3);
  });

  it('caps the rendered rows without lying about the retained total', () => {
    const many = Array.from({ length: 80 }, (_, i) => row(NOW - i * 1_000));
    const turns = buildTurnsSection({
      accounts: [{ id: 'a1', ref: 'acct-11111111' }],
      readRequests: () => page(many),
      now: NOW,
      rowCap: 5,
    });
    assert.equal(turns.items.length, 5);
    assert.equal(turns.shown, 5);
    assert.equal(turns.retained, 80);
  });

  it('reports the pool size and the cap instead of implying a full scan', () => {
    const turns = buildTurnsSection({
      accounts: [{ id: 'a1', ref: 'acct-11111111' }],
      totalAccounts: 600,
      readRequests: () => page([row(NOW - 1_000)]),
      now: NOW,
    });
    assert.equal(turns.scanned, 1);
    assert.equal(turns.totalAccounts, 600);
    assert.equal(turns.capped, true);
    const full = buildTurnsSection({
      accounts: [{ id: 'a1', ref: 'acct-11111111' }],
      totalAccounts: 1,
      readRequests: () => page([row(NOW - 1_000)]),
      now: NOW,
    });
    assert.equal(full.capped, false);
  });

  it('survives a broken reader and a missing page without failing the panel', () => {
    const turns = buildTurnsSection({
      accounts: [{ id: 'boom', ref: 'acct-bad' }, { id: 'missing', ref: 'acct-null' }, { id: 'ok', ref: 'acct-ok' }],
      readRequests: (id) => {
        if (id === 'boom') throw new Error('ring exploded');
        if (id === 'missing') return null;
        return page([row(NOW - 5)]);
      },
      now: NOW,
    });
    assert.equal(turns.scanned, 3);
    assert.equal(turns.accountsWithTurns, 1);
    assert.equal(turns.items.length, 1);
    assert.equal(turns.items[0].accountRef, 'acct-ok');
  });

  it('drops rows without a finite timestamp and truncates hostile model text', () => {
    const turns = buildTurnsSection({
      accounts: [{ id: 'a1', ref: 'acct-11111111' }],
      readRequests: () => page([
        row(Number.NaN),
        { ts: NOW - 1, model: `m${'x'.repeat(400)}`, promptTokens: 1, completionTokens: 1, totalTokens: 2, credit: 0, acu: 0 },
      ]),
      now: NOW,
    });
    assert.equal(turns.items.length, 1);
    assert.equal(turns.items[0].model.length, 120);
  });

  it('never exposes the raw account id, only the hashed ref', () => {
    const turns = buildTurnsSection({
      accounts: [{ id: 'raw-account-id-1234', ref: 'acct-abcdef12' }],
      readRequests: () => page([row(NOW - 1)]),
      now: NOW,
    });
    const json = JSON.stringify(turns);
    assert.ok(!json.includes('raw-account-id-1234'));
    assert.equal(turns.items[0].accountRef, 'acct-abcdef12');
  });

  it('returns an available, empty section when there are no accounts', () => {
    const turns = buildTurnsSection({ accounts: [], readRequests: () => null, now: NOW });
    assert.equal(turns.available, true);
    assert.equal(turns.scanned, 0);
    assert.equal(turns.retained, 0);
    assert.deepEqual(turns.items, []);
    assert.equal(turns.window.turns, 0);
  });
});

describe('buildRuntimeSection', () => {
  it('whitelists switch keys and reports source + override', () => {
    const runtime = buildRuntimeSection({
      switches: {
        devinConnect: { value: true, override: true, source: 'config' },
        devinCliMode: { value: 'acp', override: null, source: 'env' },
        somethingElse: { value: 1, override: 1, source: 'config' },
      },
    });
    assert.deepEqual(runtime.switches.map((s) => s.key), [...RUNTIME_SWITCH_KEYS]);
    const connect = runtime.switches.find((s) => s.key === 'devinConnect');
    assert.deepEqual(connect, { key: 'devinConnect', value: true, source: 'config', overridden: true });
    const cli = runtime.switches.find((s) => s.key === 'devinCliMode');
    assert.deepEqual(cli, { key: 'devinCliMode', value: 'acp', source: 'env', overridden: false });
    assert.ok(!runtime.switches.some((s) => s.key === 'somethingElse'));
  });

  it('defaults every switch to null/env when the caller passes nothing', () => {
    const runtime = buildRuntimeSection();
    assert.equal(runtime.switches.length, RUNTIME_SWITCH_KEYS.length);
    assert.ok(runtime.switches.every((s) => s.value === null && s.source === 'env' && s.overridden === false));
    assert.equal(runtime.langServer.running, false);
    assert.equal(runtime.langServer.activeRequests, 0);
    assert.equal(runtime.detach.enabled, false);
    assert.equal(runtime.detach.counters, null);
  });

  it('sums active requests, counts ready instances and keeps admission counters', () => {
    const runtime = buildRuntimeSection({
      langServer: {
        running: true,
        pid: 4242,
        port: 42100,
        totalRssBytes: 1024,
        instances: [
          { ready: true, activeRequests: 2 },
          { ready: false, activeRequests: 1 },
        ],
        admissionStats: {
          startAttempts: 5,
          startSuccesses: 4,
          startFailures: 1,
          poolWaits: 2,
          memoryWaits: 0,
          poolExhausted: 0,
          memoryGuardBlocks: 0,
          evictions: 1,
          lastFailure: { kind: 'pool_capacity', errorType: 'ls_pool_exhausted', at: NOW - 1_000 },
          lastSuccess: { key: 'default' },
        },
      },
      detach: { enabled: true, entries: 2, bytes: 99, draining: false, admit: 3, serve: 1, re_detach: 0 },
    });
    assert.equal(runtime.langServer.instances, 2);
    assert.equal(runtime.langServer.ready, 1);
    assert.equal(runtime.langServer.activeRequests, 3);
    assert.equal(runtime.langServer.admission.startAttempts, 5);
    assert.equal(runtime.langServer.admission.lastFailure.errorType, 'ls_pool_exhausted');
    assert.equal(runtime.detach.entries, 2);
    assert.equal(runtime.detach.bytes, 99);
    assert.equal(runtime.detach.counters.admit, 3);
    assert.ok(!('entries' in runtime.detach.counters));
    assert.ok(!('bytes' in runtime.detach.counters));
    assert.ok(!('draining' in runtime.detach.counters));
  });

  it('reports the credential store as read-only presence flags', () => {
    const runtime = buildRuntimeSection({ credStoreEnabled: true, remoteCredStore: false });
    assert.deepEqual(runtime.credentials, { credStoreEnabled: true, remoteCredStore: false, writable: false });
  });
});

describe('session sources', () => {
  it('names exactly one available source and gives the others a reason', () => {
    const sources = buildSessionSources();
    const available = sources.filter((s) => s.available === true);
    assert.equal(available.length, 1);
    assert.equal(available[0].id, 'proxyTurns');
    const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
    assert.equal(byId.cascadeTrajectories.available, false);
    assert.equal(byId.cascadeTrajectories.reason, SOURCE_REASONS.LS_ONLY);
    assert.ok(byId.cascadeTrajectories.rpcs.includes('LanguageServerService/GetAllCascadeTrajectories'));
    assert.equal(byId.acpSessions.available, false);
    assert.equal(byId.acpSessions.reason, SOURCE_REASONS.NOT_TRACKED);
  });

  it('marks the proxy turn ring as billed-only and process-local', () => {
    const proxy = buildSessionSources().find((s) => s.id === 'proxyTurns');
    assert.deepEqual(proxy.notes, [SOURCE_REASONS.BILLED_ONLY, SOURCE_REASONS.PROCESS_LOCAL]);
  });

  it('composes a sessions section that always carries the source table', () => {
    const section = buildSessionsSection();
    assert.ok(Array.isArray(section.sources));
    assert.equal(section.sources.length, 3);
    assert.equal(section.turns.available, true);
  });
});

describe('buildQuotaSection', () => {
  it('maps the drought decision without inventing absent numbers', () => {
    const quota = buildQuotaSection({
      drought: {
        drought: true,
        threshold: 20,
        activeAccounts: 3,
        knownAccounts: 3,
        quotaKnownAccounts: 2,
        droughtAccounts: 1,
        coverageMet: true,
        lowestWeeklyPercent: 12.5,
        lowestDailyPercent: 0,
        restrictEnabled: true,
        restrictionFailOpen: false,
        freeTierModels: ['swe-2'],
      },
    });
    assert.equal(quota.drought.active, true);
    assert.equal(quota.drought.threshold, 20);
    assert.equal(quota.drought.lowestWeeklyPercent, 12.5);
    assert.equal(quota.drought.lowestDailyPercent, 0);
    assert.deepEqual(quota.drought.freeTierModels, ['swe-2']);
    assert.equal(quota.drought.coverageMet, true);
  });

  it('reports nulls (not zeros) when the drought summary is absent', () => {
    const quota = buildQuotaSection();
    assert.equal(quota.drought.active, false);
    assert.equal(quota.drought.threshold, null);
    assert.equal(quota.drought.lowestWeeklyPercent, null);
    assert.equal(quota.drought.coverageMet, false);
    assert.deepEqual(quota.drought.freeTierModels, []);
  });

  it('distinguishes an env-following knob from a runtime-config override', () => {
    const quota = buildQuotaSection({
      tunables: { cooldownEnabled: true, cooldownMs: 1800000, dryThreshold: 0, spendOnDemand: true, onDemandReserveUsd: 0 },
      overrides: { cooldownEnabled: null, cooldownMs: 900000, dryThreshold: null, spendOnDemand: false, onDemandReserveUsd: null },
    });
    assert.deepEqual(quota.knobs.map((k) => k.key), [...QUOTA_KNOB_KEYS]);
    const cooldownMs = quota.knobs.find((k) => k.key === 'cooldownMs');
    assert.deepEqual(cooldownMs, { key: 'cooldownMs', value: 1800000, override: 900000, source: 'config', overridden: true });
    const dry = quota.knobs.find((k) => k.key === 'dryThreshold');
    assert.deepEqual(dry, { key: 'dryThreshold', value: 0, override: null, source: 'env', overridden: false });
    const spend = quota.knobs.find((k) => k.key === 'spendOnDemand');
    assert.equal(spend.value, true);
    assert.equal(spend.override, false);
    assert.equal(spend.source, 'config');
  });
});

describe('buildDevinPanel', () => {
  it('assembles the four top-level fields and stamps the generation time', () => {
    const panel = buildDevinPanel({ now: NOW });
    assert.equal(panel.ok, true);
    assert.equal(panel.generatedAt, NOW);
    assert.ok(panel.runtime);
    assert.ok(panel.sessions);
    assert.ok(panel.quota);
    assert.equal(panel.runtime.switches.length, RUNTIME_SWITCH_KEYS.length);
    assert.equal(panel.sessions.turns.available, true);
    assert.equal(panel.quota.knobs.length, QUOTA_KNOB_KEYS.length);
  });

  it('uses caller-supplied sections instead of rebuilding them', () => {
    const runtime = buildRuntimeSection({ uptimeSec: 42 });
    const panel = buildDevinPanel({ now: NOW, runtime, sessions: buildSessionsSection(), quota: buildQuotaSection() });
    assert.equal(panel.runtime.uptimeSec, 42);
  });

  it('caps the account scan constant at a bounded value', () => {
    assert.ok(Number.isInteger(MAX_SCAN_ACCOUNTS));
    assert.ok(MAX_SCAN_ACCOUNTS > 0 && MAX_SCAN_ACCOUNTS <= 1000);
    assert.ok(TURN_ROW_CAP > 0 && TURN_ROW_CAP <= 200);
  });
});

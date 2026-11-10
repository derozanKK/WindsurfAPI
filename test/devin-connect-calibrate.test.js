// devin-connect-calibrate.test.js — CI coverage for the unified tag calibrator.
//
// The harness itself ships a runnable offline self-test (selfTest()), but that
// only runs when the script is invoked. This pins its behavior in `npm test`:
//   - the offline self-test exits clean with no token / network / billing,
//   - the pure classify/aggregate/findCandidates/status functions behave,
//   - a real run is gated behind CALIBRATE_REAL + a token (never fires here).
//
// Mirrors the structure of devin-connect-paid-verify.test.js (spawn for the
// self-test gate, direct import for the pure logic).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTag, aggregateDumps, findCandidates, runCalibration, statusTable,
  FREE_BASELINE, TARGETS,
} from '../scripts/devin-connect-calibrate.mjs';
import { decodeFrame } from '../src/devin-connect.js';
import { writeStringField, writeFixed64Field } from '../src/proto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const script = join(root, 'scripts', 'devin-connect-calibrate.mjs');

function runScript(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('devin-connect calibrate harness — gating', () => {
  it('runs its offline self-test clean with no token, no network, no billing', async () => {
    const { code, stdout } = await runScript({ CALIBRATE_REAL: '' });
    assert.equal(code, 0, `self-test exit 0\n${stdout}`);
    assert.match(stdout, /SELFTEST\] OK/);
    assert.match(stdout, /no token, no network, no billing/);
  });

  it('does not fire a probe unless CALIBRATE_REAL=1', async () => {
    const { stdout } = await runScript({ CALIBRATE_REAL: '' });
    assert.match(stdout, /running offline self-test only/);
    assert.doesNotMatch(stdout, /firing one DEBUG_META probe/);
  });
});

describe('classifyTag — wire-shape → target bucket', () => {
  it('routes a meta varint to billing/cache (#46)', () => {
    const r = classifyTag({ scope: 'meta', tag: 14, kind: 'varint', preview: 1500 });
    assert.equal(r.bucket, 'billing/cache');
    assert.equal(r.task, '#46');
    assert.deepEqual(r.targets.sort(), ['billing', 'cache_tokens']);
  });

  it('routes a top-level string to actual_model_uid (#47)', () => {
    const r = classifyTag({ scope: 'top', tag: 8, kind: 'string', preview: 'claude-opus-4-8' });
    assert.equal(r.bucket, 'actual_model_uid');
    assert.equal(r.task, '#47');
  });

  it('routes a top-level sub-message to tool_calls (#49)', () => {
    const r = classifyTag({ scope: 'top', tag: 12, kind: 'message', preview: '<msg 47b>' });
    assert.equal(r.bucket, 'tool_calls');
    assert.equal(r.task, '#49');
  });

  it('marks an unrecognized shape as unknown with no targets', () => {
    const r = classifyTag({ scope: 'meta', tag: 99, kind: 'message', preview: '<msg 5b>' });
    assert.equal(r.bucket, 'unknown');
    assert.equal(r.targets.length, 0);
  });

  it('routes a top-level numeric to billing/cache — #22 is a descriptor-verified double', () => {
    const r = classifyTag({ scope: 'top', tag: 22, kind: 'fixed64', preview: 0.0006735000060871243 });
    assert.equal(r.bucket, 'billing/cache');
    assert.equal(r.task, '#46');
    assert.deepEqual(r.targets, ['billing']);
  });

  it('routes a top-level varint to billing/cache too', () => {
    const r = classifyTag({ scope: 'top', tag: 26, kind: 'varint', preview: 1200 });
    assert.equal(r.bucket, 'billing/cache');
    assert.equal(r.task, '#46');
  });
});

describe('aggregateDumps — per-frame dumps → tag inventory', () => {
  it('infers wire kind from the dump value and dedupes across frames', () => {
    const inv = aggregateDumps(
      [{ 1: 'bot', 3: 'PONG', 8: 'claude-opus-4-8', 12: '<msg 40b>' }, { 3: 'more' }],
      [{ 6: 6, 14: 1500 }],
    );
    assert.equal(inv.top[8].kind, 'string');
    assert.equal(inv.top[12].kind, 'message');
    assert.equal(inv.top[3].kind, 'string');
    assert.equal(inv.meta[14].kind, 'varint');
    assert.equal(inv.meta[14].preview, 1500);
  });

  it('keeps a fixed64 dump entry as fixed64 — never mangled to "[object Object]"', () => {
    const acu = 0.0006735000060871243;
    const raw = Buffer.alloc(8);
    raw.writeDoubleLE(acu, 0);
    const inv = aggregateDumps([{ 22: { kind: 'fixed64', preview: acu, raw: raw.toString('hex') } }], [], []);
    assert.equal(inv.top[22].kind, 'fixed64');
    assert.equal(inv.top[22].preview, acu);
  });
});

describe('findCandidates — diff against the free baseline', () => {
  it('flags only tags absent from the known free baseline', () => {
    const inv = aggregateDumps(
      [{ 1: 'bot', 3: 'PONG', 8: 'claude-opus-4-8', 12: '<msg 47b>' }],
      [{ 6: 6, 14: 1500, 15: 200 }],
    );
    const { candidates } = findCandidates(inv);
    // #1/#3 (top) and #6 (meta) are baseline → never flagged.
    assert.ok(!candidates.some((c) => c.scope === 'top' && [1, 3].includes(c.tag)));
    assert.ok(!candidates.some((c) => c.scope === 'meta' && c.tag === 6));
    // #8/#12 (top) and #14/#15 (meta) are new → flagged with the right bucket.
    assert.ok(candidates.some((c) => c.scope === 'top' && c.tag === 8 && c.bucket === 'actual_model_uid'));
    assert.ok(candidates.some((c) => c.scope === 'top' && c.tag === 12 && c.bucket === 'tool_calls'));
    assert.equal(candidates.filter((c) => c.scope === 'meta' && c.bucket === 'billing/cache').length, 2);
  });

  it('a pure-free capture yields zero candidates (no false positives)', async () => {
    const report = await runCalibration({
      real: false,
      deps: { frameDumps: [{ 1: 'b', 3: 'PONG', 4: 2, 9: 't', 17: 'u' }], metaDumps: [{ 6: 6 }] },
    });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.envLines.length, 0);
  });
});

describe('runCalibration — env-line generation', () => {
  it('emits the calibrated DEVIN_CONNECT_* lines for discovered candidates', async () => {
    const report = await runCalibration({
      real: false,
      deps: {
        frameDumps: [{ 1: 'b', 3: 'PONG', 8: 'claude-opus-4-8', 12: '<msg 47b>' }],
        metaDumps: [{ 6: 6, 14: 1500, 15: 200 }],
      },
    });
    assert.ok(report.envLines.some((l) => l === 'DEVIN_CONNECT_ACTUAL_MODEL_TAG=8'));
    assert.ok(report.envLines.some((l) => /outer=12/.test(l)));
    assert.ok(report.envLines.some((l) => /14,15/.test(l)));
    assert.ok(report.envLines.some((l) => /^# meta varint candidates at tags \[14,15\] —/.test(l)));
  });

  it('surfaces a probe error without throwing', async () => {
    // No real path, no deps dumps → empty inventory, modelAlive defaults true.
    const report = await runCalibration({ real: false, deps: {} });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.error, null);
  });
});

describe('#22 top-level double (committed_acu_cost) — production dump shape', () => {
  it('classifies a real decodeFrame dump as a billing candidate, never actual_model_uid', async () => {
    // committed_acu_cost is a descriptor-verified top-level double field 22
    // (docs/DEVIN-CONNECT-CUTOVER.md §7); the frame below is the shape a paid
    // turn would carry, decoded by the production dump path (dumpMeta).
    const acu = 0.0006735000060871243;
    const raw = Buffer.alloc(8);
    raw.writeDoubleLE(acu, 0);
    const payload = Buffer.concat([
      writeStringField(1, 'bot-enterprise'),
      writeFixed64Field(22, raw),
    ]);
    const frame = decodeFrame(payload, { dumpMeta: true });
    assert.equal(frame.frameDump[22].kind, 'fixed64', 'decoder dump entry is fixed64');

    const report = await runCalibration({ real: false, deps: { frameDumps: [frame.frameDump], metaDumps: [] } });
    const c22 = report.candidates.find((c) => c.scope === 'top' && c.tag === 22);
    assert.equal(c22.bucket, 'billing/cache');
    assert.equal(c22.task, '#46');
    // The misclassification emitted DEVIN_CONNECT_ACTUAL_MODEL_TAG=22 — a cost
    // double wired as the model-uid tag. That line must never come back.
    assert.ok(!report.envLines.some((l) => /DEVIN_CONNECT_ACTUAL_MODEL_TAG=22/.test(l)));
    // ...and the top-level candidate is surfaced with the ^N pin form instead.
    assert.ok(report.envLines.some((l) => /\^22/.test(l)));
  });

  it('a multi-candidate top frame keeps the ^N example generic — never pairs a key with the wrong tag', async () => {
    // The descriptor puts credit_cost #14 and committed_acu_cost #22 both at the
    // top level; a hint saying `committed_acu_cost=^14` would wire credit as ACU.
    const raw14 = Buffer.alloc(8);
    raw14.writeDoubleLE(1.25, 0);
    const raw22 = Buffer.alloc(8);
    raw22.writeDoubleLE(0.0006735000060871243, 0);
    const payload = Buffer.concat([
      writeStringField(1, 'bot-enterprise'),
      writeFixed64Field(14, raw14),
      writeFixed64Field(22, raw22),
    ]);
    const frame = decodeFrame(payload, { dumpMeta: true });
    const report = await runCalibration({ real: false, deps: { frameDumps: [frame.frameDump], metaDumps: [] } });
    const line = report.envLines.find((l) => /top-level numeric candidates/.test(l));
    assert.ok(line, 'top-level hint present');
    assert.ok(!/committed_acu_cost=\^14/.test(line));
    assert.ok(/<field>=\^14/.test(line));
  });
});

describe('statusTable — per-target state', () => {
  it('reports CANDIDATE FOUND for a discovered tag and pending otherwise', async () => {
    const report = await runCalibration({
      real: false,
      deps: { frameDumps: [{ 8: 'claude-opus-4-8' }], metaDumps: [] },
    });
    const tbl = statusTable(report, {});
    assert.equal(tbl.find((r) => r.target === 'actual_model_uid').state, 'CANDIDATE FOUND');
    assert.equal(tbl.find((r) => r.target === 'tool_calls').state, 'pending');
  });

  it('reports CALIBRATED when the target env var is already set', () => {
    const tbl = statusTable({ candidates: [] }, { DEVIN_CONNECT_ACTUAL_MODEL_TAG: '8' });
    assert.ok(tbl.find((r) => r.target === 'actual_model_uid').state.startsWith('CALIBRATED'));
  });

  it('covers every declared target', () => {
    const tbl = statusTable({ candidates: [] }, {});
    assert.equal(tbl.length, TARGETS.length);
  });
});

describe('FREE_BASELINE — sanity', () => {
  it('holds the known free top + meta tags', () => {
    assert.ok(FREE_BASELINE.top.has(3)); // content
    assert.ok(FREE_BASELINE.meta.has(6)); // provider constant
  });
});

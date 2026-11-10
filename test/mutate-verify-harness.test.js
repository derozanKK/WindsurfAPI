// The mutation harness's own verdict logic, which nothing covered until now.
//
// scripts/mutate-verify.mjs is what the ledger's trust rests on: "a test that has never
// failed is not a test" is only meaningful if the thing reporting CAUGHT/SURVIVED is itself
// right. It has now been wrong in both directions inside one round:
//
//   1. it reported a TRUNCATED run as a clean SURVIVED (a mutation containing
//      `process.exit(0)` yielded pass=1 fail=0 against a baseline of 4 — verdict SURVIVED
//      while three assertions never executed);
//   2. the guard added for (1) then ABORTED on mutations that were genuinely CAUGHT,
//      because it compared test counts without checking whether anything had failed. A
//      syntax-error mutation reports pass=0 fail=1 — caught, correctly — and the guard
//      killed the run, printed a message asserting "nothing failed" that was false in that
//      very case, ignored --keep-going, and skipped every later mutation.
//
// Both directions are pinned here. The shape of the bug is worth naming: a guard written
// from ONE reproduction and then applied unconditionally.
//
// These tests drive the real script as a subprocess against real spec files in a tmpdir,
// mutating a throwaway fixture module rather than anything under src/ — the harness refuses
// to touch untracked files, so the fixture is created, committed to a scratch clone, and the
// clone is thrown away. That is heavier than stubbing, and it is the point: the failure modes
// above were both in the interaction between the spec, git, and node's reporter, none of
// which a stub reproduces.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, statSync, readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REAL_GIT, SKIP_REASON } from './git-fixture-env.js';

// The production harness still refuses unavailable Git. Probe before importing it;
// a module-load exception cannot be represented as a skipped test.
const { acquireMutationLock, harnessEnv, materializeMutationWorkspace, workspaceSnapshot } =
  REAL_GIT ? await import('../scripts/mutation-harness-utils.mjs') : {};

const REPO = process.cwd();
let clone;
let specDir;

/** A scratch git repo with the harness, a fixture module, and a test over it. */
before(() => {
  if (!REAL_GIT) return;
  clone = mkdtempSync(join(tmpdir(), 'mv-harness-'));
  specDir = mkdtempSync(join(tmpdir(), 'mv-spec-'));
  mkdirSync(join(clone, 'scripts'));
  mkdirSync(join(clone, 'test'));
  cpSync(join(REPO, 'scripts/mutate-verify.mjs'), join(clone, 'scripts/mutate-verify.mjs'));
  cpSync(join(REPO, 'scripts/mutation-harness-utils.mjs'), join(clone, 'scripts/mutation-harness-utils.mjs'));
  cpSync(join(REPO, 'scripts/mutation-network-deny.mjs'), join(clone, 'scripts/mutation-network-deny.mjs'));
  // setup-env.mjs is loaded via --import by the harness; a stub keeps the clone standalone.
  writeFileSync(join(clone, 'test/setup-env.mjs'), 'export {};\n');
  writeFileSync(join(clone, 'src.mjs'), `
import { writeFileSync } from 'node:fs';
export function alpha() { return 'a'; }
export function beta() { return 'b'; }
export function gamma() { return 'c'; }
export function delta() { return 'd'; }
`);
  writeFileSync(join(clone, 'test/fixture.test.js'), `
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alpha, beta, gamma, delta } from '../src.mjs';
describe('fixture', () => {
  it('alpha', () => assert.equal(alpha(), 'a'));
  it('beta',  () => assert.equal(beta(), 'b'));
  it('gamma', () => assert.equal(gamma(), 'c'));
  it('delta', () => assert.equal(delta(), 'd'));
});
`);
  // A deliberately red suite, committed like every other fixture: the refusal wording for a
  // genuinely failing baseline is only meaningful against a real failing run.
  writeFileSync(join(clone, 'test/red.test.js'), `
import { it } from 'node:test';
import assert from 'node:assert/strict';
it('failing fixture assertion', () => assert.equal(1, 2));
`);
  const git = (...a) => execFileSync('git', a, { cwd: clone, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'harness test');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
});

after(() => {
  if (clone) rmSync(clone, { recursive: true, force: true });
  if (specDir) rmSync(specDir, { recursive: true, force: true });
});

/**
 * Run the harness on a spec; return { code, out }.
 *
 * The spec file lives OUTSIDE the clone. Writing it inside makes the tree dirty, and guard 1
 * then refuses to run — which is the guard working correctly and this test measuring nothing.
 */
function runHarness(spec, extraArgs = [], envOverrides = null) {
  const specPath = join(specDir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const env = envOverrides ? { ...process.env, ...envOverrides } : process.env;
  try {
    const out = execFileSync(process.execPath, ['scripts/mutate-verify.mjs', specPath, ...extraArgs],
      { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('a failure from a truncated or load-broken suite is never mutation evidence', () => {
  it('a syntax-error mutation is UNTRUSTWORTHY, not CAUGHT', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    // Node reports one file-level failure for this load break, while the baseline
    // contains four tests. A nonzero fail count is not proof that the real guard
    // assertions ran.
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{
        name: 'syntax error',
        file: 'src.mjs',
        anchor: 'export function alpha()',
        replacement: 'this is not javascript ((( export function alpha()',
      }],
    });
    const out = strip(r.out);
    assert.doesNotMatch(out, /^\s*CAUGHT\b/m, `truncated failure was blessed:\n${out}`);
    assert.match(out, /infrastructure failure|changed how many tests RAN/);
    assert.equal(r.code, 2, 'load-broken mutation evidence must be infrastructure failure');
  });

  it('--keep-going cannot continue after untrustworthy evidence', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [
        {
          name: 'first: syntax error (caught, count changes)',
          file: 'src.mjs',
          anchor: 'export function alpha()',
          replacement: 'bad ((( export function alpha()',
        },
        {
          name: 'second: must still run',
          file: 'src.mjs',
          anchor: "return 'b';",
          replacement: "return 'WRONG';",
        },
      ],
    }, ['--keep-going']);
    const out = strip(r.out);
    assert.doesNotMatch(out, /^\s*(?:CAUGHT|SURVIVED).*second: must still run/m,
      'keep-going applies to real verdict mismatches, not infrastructure failure');
    assert.equal(r.code, 2);
  });
});

describe('a truncated run is never reported as a clean survivor', () => {
  it('a mutation that exits the process mid-suite aborts with an explanation', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    // The original defect. Nothing fails, so `fail > 0` is false and the naive verdict is
    // SURVIVED — while most assertions never executed.
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{
        name: 'truncates the suite',
        file: 'src.mjs',
        anchor: "export function gamma() { return 'c'; }",
        replacement: "export function gamma() { process.exit(0); }",
      }],
    });
    const out = strip(r.out);
    // Match VERDICT lines only. The abort message itself contains the word "SURVIVED"
    // (explaining what would otherwise be reported), so a bare /SURVIVED/ check fails on
    // correct behaviour — which it did on the first version of this test.
    const verdictLines = out.split('\n').filter((l) => /^\s*(CAUGHT|SURVIVED)\b/.test(l.trim()));
    assert.deepEqual(verdictLines, [],
      `a truncated run must produce NO verdict at all, got:\n${verdictLines.join('\n')}`);
    assert.match(out, /changed how many tests RAN/,
      'and the abort must say why, so the reader narrows the mutation instead of trusting it');
    assert.equal(r.code, 2, 'harness-cannot-produce-a-verdict is exit 2, not 1');
  });

  it('cannot bless a truncated run through allowTruncatedCatch', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{
        name: 'truncates despite the legacy override',
        file: 'src.mjs',
        anchor: "export function gamma() { return 'c'; }",
        replacement: "export function gamma() { process.exit(0); }",
        allowTruncatedCatch: true,
      }],
    });
    const out = strip(r.out);
    assert.doesNotMatch(out, /SURVIVED/);
    assert.match(out, /changed how many tests RAN/);
    assert.equal(r.code, 2);
  });

  it('cannot forge a complete caught run with test-authored TAP', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    // The old human TAP parser accepted these lines as the missing aggregate:
    // a process exit after writing pass/fail/tests made a truncated mutation
    // look like a legitimate CAUGHT result.  The structured reporter never
    // yields ordinary test stdout and therefore has no summary to trust.
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{
        name: 'forged TAP plus truncation',
        file: 'src.mjs',
        anchor: "export function gamma() { return 'c'; }",
        replacement: "export function gamma() { process.stdout.write('ℹ pass 3\\nℹ fail 1\\nℹ tests 4\\n'); process.exit(0); }",
      }],
    });
    const out = strip(r.out);
    const verdictLines = out.split('\n').filter((l) => /^\s*(CAUGHT|SURVIVED)\b/.test(l.trim()));
    assert.deepEqual(verdictLines, [], `forged TAP produced a verdict:\n${out}`);
    assert.match(out, /changed how many tests RAN|infrastructure failure/);
    assert.equal(r.code, 2);
  });
});

describe('the pre-flight guards refuse rather than warn', () => {
  it('a mutation target outside the repo is refused before anything runs', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{ name: 'escape', file: '../outside.txt', anchor: 'x', replacement: 'y' }],
    });
    assert.match(strip(r.out), /escapes the repo|not tracked/);
    assert.equal(r.code, 2);
  });

  it('an untracked target is refused, since the restore could not undo it', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    // The file must exist and be untracked. It also makes the tree dirty, which guard 1
    // catches FIRST — so assert on either refusal: both are correct, and which one fires is
    // an ordering detail, not the property under test.
    const stray = join(clone, 'untracked.mjs');
    writeFileSync(stray, 'export const x = 1;\n');
    try {
      const r = runHarness({
        tests: ['test/fixture.test.js'],
        expectBaselinePass: 4,
        mutations: [{ name: 'untracked', file: 'untracked.mjs', anchor: 'x = 1', replacement: 'x = 2' }],
      });
      assert.match(strip(r.out), /not tracked|working tree is dirty/,
        'an untracked mutation target must never be written to — the restore cannot undo it');
      assert.equal(r.code, 2);
    } finally {
      rmSync(stray, { force: true });
    }
  });

  it('an anchor that does not match exactly once is refused', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{ name: 'ambiguous', file: 'src.mjs', anchor: 'export function', replacement: 'x' }],
    });
    assert.match(strip(r.out), /matched 4 times/,
      'a multi-match anchor would mutate only the first occurrence');
    assert.equal(r.code, 2);
  });

  it('a stale expectBaselinePass is refused', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 999,
      mutations: [{ name: 'x', file: 'src.mjs', anchor: "return 'b';", replacement: "return 'z';" }],
    });
    assert.match(strip(r.out), /baseline pass=4 but spec expects 999/);
    assert.equal(r.code, 2);
  });

  it('a test path that would be parsed as a node option is refused', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness({
      tests: ['--import=/tmp/evil.mjs'],
      expectBaselinePass: 4,
      mutations: [{ name: 'x', file: 'src.mjs', anchor: "return 'b';", replacement: "return 'z';" }],
    });
    assert.match(strip(r.out), /node option/);
    assert.equal(r.code, 2);
  });
});

describe('an unexpected verdict exits 1, distinct from a harness error', () => {
  it('a survivor expected to be caught exits 1', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{
        name: 'comment-only change, wrongly expected to be caught',
        file: 'src.mjs',
        anchor: "export function delta() { return 'd'; }",
        replacement: "export function delta() { /* noop */ return 'd'; }",
      }],
    });
    const out = strip(r.out);
    assert.match(out, /SURVIVED/);
    assert.equal(r.code, 1,
      'exit 1 = the harness worked and a mutation misbehaved; exit 2 = the harness could not '
      + 'produce a verdict. CI has to be able to tell those apart.');
  });

  it('and the tree is left clean either way', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: clone, encoding: 'utf8' });
    assert.equal(status.trim(), '',
      `the harness left the scratch repo dirty:\n${status}`);
  });
});

// A baseline that node CANCELLED is not a red suite, and the label matters: on 2026-10-05
// a node-22 run reported `pass=99 fail=0 cancelled=95` (the event loop drained before the
// rest ran — test/devin-connect.test.js's fake transport swallows the idle timer that
// src/devin-connect.js unrefs) and guard 2 printed zero failures as the explanation while
// listing all 95 cancelled tests under `failing:`. That cost a full investigation chasing
// assertions that never executed.
//
// Node 24 will not cancel a suite on request — every recipe tried here (unref'd wake-up
// timers, a never-resolving promise with nothing holding the loop, process.exit, pre-aborted
// and mid-flight AbortSignals) yields `cancelled: 0` — so the second clone below swaps in a
// reporter that emits exactly the summary the node-22 run produced. Everything downstream of
// the runner is the real script: real git, real clone, real guards. Only the counter source
// is a stub, because the counter is the thing under test.
describe('a cancelled baseline is reported as truncated, never as a failing suite', () => {
  let truncClone;

  before(() => {
    if (!REAL_GIT) return;
    truncClone = mkdtempSync(join(tmpdir(), 'mv-trunc-'));
    mkdirSync(join(truncClone, 'scripts'));
    mkdirSync(join(truncClone, 'test'));
    cpSync(join(REPO, 'scripts/mutate-verify.mjs'), join(truncClone, 'scripts/mutate-verify.mjs'));
    cpSync(join(REPO, 'scripts/mutation-harness-utils.mjs'), join(truncClone, 'scripts/mutation-harness-utils.mjs'));
    cpSync(join(REPO, 'scripts/mutation-network-deny.mjs'), join(truncClone, 'scripts/mutation-network-deny.mjs'));
    writeFileSync(join(truncClone, 'test/setup-env.mjs'), 'export {};\n');
    writeFileSync(join(truncClone, 'src.mjs'), "export function alpha() { return 'a'; }\n");
    writeFileSync(join(truncClone, 'test/fixture.test.js'), `
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { alpha } from '../src.mjs';
it('alpha', () => assert.equal(alpha(), 'a'));
`);
    // The node-22 summary: nothing failed, 95 tests were cancelled, and each cancellation
    // arrives as a test:fail record carrying the test's name — which is exactly why the old
    // message could print 95 names beside zero failures.
    writeFileSync(join(truncClone, 'test/truncating-reporter.mjs'), `
export default async function* truncatingReporter() {
  yield '@@MUTATION_SUMMARY ' + JSON.stringify({
    success: false,
    counts: { tests: 194, failed: 0, passed: 99, cancelled: 95, skipped: 0, todo: 0, topLevel: 1, suites: 3 },
  }) + '\\n';
  for (let i = 1; i <= 95; i++) {
    yield '@@MUTATION_FAIL ' + JSON.stringify({ name: 'cancelled test #' + i, failureType: 'cancelledByParent' }) + '\\n';
  }
}
`);
    // The real spec is untouched; only the summary source is replaced.
    const harness = readFileSync(join(truncClone, 'scripts/mutate-verify.mjs'), 'utf8');
    writeFileSync(join(truncClone, 'scripts/mutate-verify.mjs'), harness.replace(
      "'--test-reporter=./scripts/mutation-harness-utils.mjs',",
      "'--test-reporter=./test/truncating-reporter.mjs',"));
    const git = (...a) => execFileSync('git', a, { cwd: truncClone, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'harness test');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
  });

  after(() => { if (truncClone) rmSync(truncClone, { recursive: true, force: true }); });

  const truncSpec = () => ({
    tests: ['test/fixture.test.js'],
    mutations: [{ name: 'x', file: 'src.mjs', anchor: 'alpha', replacement: 'ALPHA' }],
  });

  function runTruncHarness() {
    const specPath = join(specDir, 'trunc.json');
    writeFileSync(specPath, JSON.stringify(truncSpec(), null, 2));
    try {
      const out = execFileSync(process.execPath, ['scripts/mutate-verify.mjs', specPath],
        { cwd: truncClone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  }

  it('says truncated and labels the names cancelled, not failing', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runTruncHarness();
    const out = strip(r.out);
    assert.match(out, /TRUNCATED/, `a cancelled run must not read as a red suite:\n${out}`);
    assert.match(out, /cancelled=95/, 'and it must name the count it measured');
    assert.match(out, /^\s*cancelled: cancelled test #1\b/m, 'the list belongs under cancelled:');
    assert.doesNotMatch(out, /^\s*failing:/m,
      'zero failures were measured; printing names under failing: is the mislabel itself:\n' + out);
    assert.doesNotMatch(out, /Fix the suite first/,
      'the suite is not failing — telling the reader to fix it sends them after assertions that never ran');
    // The remedy must name a control that actually exists. "raise the runner's force-exit
    // threshold" named nothing: node --help on 22.23.3 and 24.21.0 lists only the boolean
    // --test-force-exit among the --test* options, there is no threshold knob, and
    // runSuite's own comment records that the flag ends runs early and must not be used —
    // so the sentence's only real-world referent makes truncation WORSE. Pinned as an
    // absence assertion, because a presence assertion alone lets the dead remedy back in.
    // Ordered absence-first on purpose: the absence guard is the regression guard, so when
    // the dead remedy comes back this is the assertion that names it.
    assert.doesNotMatch(out, /force-exit threshold/,
      'no such knob exists; --test-force-exit ends a run early, it does not raise a threshold:\n' + out);
    assert.match(out, /Make the whole suite run \(keep a live handle until the suite ends\) and re-run\./,
      `the remedy must name a control that exists:\n${out}`);
    assert.equal(r.code, 2, 'a truncated baseline is still a harness-level refusal (exit 2)');
  });

  it('a genuinely failing baseline keeps the red-suite wording', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    // The control: the split must not soften a real failure into "truncated". A committed
    // red fixture through the REAL reporter, so this is the shape a broken suite produces.
    const r = runHarness({
      tests: ['test/red.test.js'],
      mutations: [{ name: 'x', file: 'src.mjs', anchor: 'alpha', replacement: 'ALPHA' }],
    });
    const out = strip(r.out);
    assert.match(out, /baseline is not green/, `a red suite must still say so:\n${out}`);
    assert.match(out, /^\s*failing: failing fixture assertion/m, 'and list real failures as failing:');
    assert.doesNotMatch(out, /TRUNCATED|cancelled=/,
      'fail>0 with cancelled=0 is a red suite, not a truncated one');
    assert.equal(r.code, 2);
  });
});

// A caller that exports FORCE_COLOR made the harness unusable: node wraps the summary in
// SGR codes, the anchored `ℹ pass N` counters match nothing, and EVERY run ends at guard 2
// with "baseline is not green" while the suite was in fact perfectly green.
//
// It failed safe — a zero count can never manufacture a false SURVIVED — but the message
// blamed the suite for a defect in the measurement, which is the same disguise as the
// round-3 false SURVIVEDs (`pass=0` is "not measured", never "not caught").
//
// Not hypothetical: with FORCE_COLOR=3 exported, 6 of the 10 tests in THIS file failed, so
// the repo's own gate was green only because the ambient environment happened not to set it.
//
// The env is passed explicitly rather than inherited so the assertion holds both ways: the
// bug reproduces on a machine that does not set FORCE_COLOR, and the control case stays a
// control on a machine that does.
describe('the measurement survives a colour-forcing caller', () => {
  const spec = () => ({
    tests: ['test/fixture.test.js'],
    expectBaselinePass: 4,
    mutations: [{
      name: 'beta returns the wrong letter',
      file: 'src.mjs',
      anchor: "export function beta() { return 'b'; }",
      replacement: "export function beta() { return 'z'; }",
    }],
  });

  for (const value of ['3', '1', '']) {
    it(`FORCE_COLOR=${JSON.stringify(value)} still yields a real baseline and verdict`, { skip: REAL_GIT ? false : SKIP_REASON }, () => {
      const r = runHarness(spec(), [], { FORCE_COLOR: value });
      const out = strip(r.out);
      assert.doesNotMatch(out, /baseline is not green/,
        `FORCE_COLOR=${JSON.stringify(value)} zeroed the counters: the suite ran, the parser `
        + 'did not. Measured before the fix — every value except "0" colours the summary, '
        + `including the empty string.\n${out}`);
      assert.match(out, /baseline 4 pass \/ 0 fail/,
        'the baseline count must be the real one, not a colour-mangled 0');
      assert.match(out, /CAUGHT/, 'and the verdict must still be produced');
      assert.equal(r.code, 0);
    });
  }

  it('FORCE_COLOR=0 (the one value that does not colour) is unaffected', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness(spec(), [], { FORCE_COLOR: '0' });
    const out = strip(r.out);
    assert.match(out, /baseline 4 pass \/ 0 fail/);
    assert.equal(r.code, 0);
  });
});

describe('the mutation child environment is hermetic', () => {
  it('does not carry credentials, proxies, auth switches, or real data paths', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const env = harnessEnv({
      API_KEY: 'sentinel-api-key',
      DASHBOARD_PASSWORD: 'sentinel-password',
      DEVIN_CONNECT_TOKEN: 'sentinel-token',
      WINDSURF_API_KEY: 'sentinel-windsurf-key',
      CODEIUM_AUTH_TOKEN: 'sentinel-codeium-token',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'sentinel-github-token',
      HTTP_PROXY: 'http://sentinel.invalid:8080',
      HTTPS_PROXY: 'http://sentinel.invalid:8080',
      ALL_PROXY: 'http://sentinel.invalid:8080',
      DATA_DIR: '/sentinel/real-data',
      WINDSURFAPI_ALLOW_UNAUTHENTICATED: '1',
      NODE_OPTIONS: '--require=/sentinel/preload.cjs',
      PATH: '/sentinel/bin',
      HOME: '/sentinel/home',
      FORCE_COLOR: '3',
    });

    for (const key of [
      'API_KEY', 'DASHBOARD_PASSWORD', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY',
      'CODEIUM_AUTH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY',
      'ALL_PROXY', 'DATA_DIR', 'WINDSURFAPI_ALLOW_UNAUTHENTICATED', 'NODE_OPTIONS',
      'FORCE_COLOR',
    ]) assert.equal(env[key], undefined, `${key} must not cross the harness boundary`);

    assert.notEqual(env.PATH, '/sentinel/bin');
    assert.notEqual(env.HOME, '/sentinel/home');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null');
    assert.equal(env.WINDSURFAPI_SKIP_DOTENV, '1');
    assert.equal(env.LANG, 'C');
    assert.equal(env.LC_ALL, 'C');
    assert.equal(env.TZ, 'UTC');
    assert.equal(env.NO_COLOR, '1');
  });

  it('blocks hard-coded non-loopback fetch before it can become mutation evidence', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{
        name: 'attempts a real external fetch',
        file: 'src.mjs',
        anchor: "export function alpha() { return 'a'; }",
        replacement: "export function alpha() { return fetch('https://example.com/'); }",
      }],
    });
    const out = strip(r.out);
    assert.match(out, /NETWORK_STUB_MISS|infrastructure failure/);
    assert.doesNotMatch(out, /^\s*CAUGHT\b/m);
    assert.equal(r.code, 2);
  });

  it('discards non-target test side effects instead of leaving them in the Owner checkout', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const outside = join(clone, 'non-target-side-effect.txt');
    const r = runHarness({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: 4,
      mutations: [{
        name: 'writes a non-target file',
        file: 'src.mjs',
        anchor: "export function alpha() { return 'a'; }",
        replacement: "export function alpha() { writeFileSync('non-target-side-effect.txt', 'mutated\\n'); return 'WRONG'; }",
      }],
    });
    assert.equal(r.code, 2, `side effect must make the scratch verdict unsafe:\n${strip(r.out)}`);
    assert.equal(existsSync(outside), false, 'the source checkout must remain byte-for-byte untouched');
  });

  it('snapshots every ref namespace and Git pseudoref state', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const gitOut = (...args) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' }).trim();
    const head = gitOut('rev-parse', 'HEAD');
    const originalBlob = gitOut('hash-object', '-w', '--stdin');
    const replacementBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: clone, encoding: 'utf8', input: 'replacement\n',
    }).trim();
    const refs = [
      ['refs/custom/review', head],
      ['refs/notes/review', head],
      [`refs/replace/${originalBlob}`, replacementBlob],
    ];
    for (const [ref, oid] of refs) {
      const before = workspaceSnapshot(clone);
      gitOut('update-ref', ref, oid);
      assert.notEqual(workspaceSnapshot(clone), before, `${ref} must change the snapshot`);
      gitOut('update-ref', '-d', ref);
    }
    const beforePseudo = workspaceSnapshot(clone);
    writeFileSync(join(clone, '.git', 'ORIG_HEAD'), `${head}\n`);
    assert.notEqual(workspaceSnapshot(clone), beforePseudo, 'ORIG_HEAD must change the snapshot');
    rmSync(join(clone, '.git', 'ORIG_HEAD'), { force: true });

    const emptyAdmin = join(clone, '.git', 'sequencer');
    const beforeEmptyAdmin = workspaceSnapshot(clone);
    mkdirSync(emptyAdmin, { recursive: true });
    assert.notEqual(workspaceSnapshot(clone), beforeEmptyAdmin, 'empty admin dirs must change the snapshot');
    rmSync(emptyAdmin, { recursive: true, force: true });

    const emptyRefs = join(clone, '.git', 'refs', 'custom-empty');
    const beforeEmptyRefs = workspaceSnapshot(clone);
    mkdirSync(emptyRefs, { recursive: true });
    assert.notEqual(workspaceSnapshot(clone), beforeEmptyRefs, 'empty ref namespaces must change the snapshot');
    rmSync(emptyRefs, { recursive: true, force: true });
  });

  it('ignores index stat-cache churn but still detects staged index semantics', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const gitOut = (...args) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' }).trim();
    const target = join(clone, 'src.mjs');
    const original = readFileSync(target, 'utf8');
    const baseline = workspaceSnapshot(clone);

    // Restoring a worktree-only mutation legitimately rewrites the raw Git
    // index stat cache. That is not a repository side effect when the cached
    // diff and staged entries are unchanged.
    writeFileSync(target, `${original}\n// transient worktree mutation\n`);
    gitOut('checkout', 'HEAD', '--', 'src.mjs');
    assert.equal(workspaceSnapshot(clone), baseline,
      'a complete checkout restore must not fail only because index stat-cache bytes changed');

    // A real staged content change remains observable through the semantic
    // cached diff / stage-entry snapshot even though the raw index bytes are
    // intentionally ignored.
    writeFileSync(target, `${original}\n// staged mutation\n`);
    gitOut('add', 'src.mjs');
    assert.notEqual(workspaceSnapshot(clone), baseline,
      'a staged content change must still change the workspace snapshot');
    gitOut('checkout', 'HEAD', '--', 'src.mjs');
    assert.equal(workspaceSnapshot(clone), baseline, 'fixture must return to the exact baseline');
  });

  it('snapshots ignored owner files and executable mode changes', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const ignored = join(clone, 'ignored-owner.txt');
    writeFileSync(join(clone, '.gitignore'), 'ignored-owner.txt\n');
    writeFileSync(ignored, 'owner bytes\n');
    const before = workspaceSnapshot(clone);
    writeFileSync(ignored, 'mutated owner bytes\n');
    const afterBytes = workspaceSnapshot(clone);
    assert.notEqual(afterBytes, before, 'ignored file byte changes must be visible to the snapshot');
    writeFileSync(ignored, 'owner bytes\n');
    const beforeMode = workspaceSnapshot(clone);
    const mode = statSync(ignored).mode;
    chmodSync(ignored, mode ^ 0o111);
    const afterMode = workspaceSnapshot(clone);
    assert.notEqual(afterMode, beforeMode, 'ignored file mode changes must be visible to the snapshot');
    chmodSync(ignored, mode);
    rmSync(ignored, { force: true });
    rmSync(join(clone, '.gitignore'), { force: true });
  });

  it('materializes the network preload but never copies forbidden state trees', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const opencode = join(clone, '.opencode');
    const oldWorktree = join(clone, '.claude', 'worktrees', 'old');
    mkdirSync(opencode, { recursive: true });
    mkdirSync(oldWorktree, { recursive: true });
    writeFileSync(join(opencode, 'state.md'), 'owner-only\n');
    writeFileSync(join(oldWorktree, 'state.md'), 'legacy-owner-only\n');
    let materialized;
    try {
      materialized = materializeMutationWorkspace(clone);
      assert.equal(
        readFileSync(join(materialized.root, 'scripts', 'mutation-network-deny.mjs'), 'utf8'),
        readFileSync(join(clone, 'scripts', 'mutation-network-deny.mjs'), 'utf8'),
        'the disposable clone must carry the exact network preload bytes',
      );
      assert.equal(existsSync(join(materialized.root, '.opencode')), false);
      assert.equal(existsSync(join(materialized.root, '.claude', 'worktrees')), false);
    } finally {
      materialized?.cleanup();
      rmSync(opencode, { recursive: true, force: true });
      rmSync(join(clone, '.claude'), { recursive: true, force: true });
    }
  });
});

describe('the mutation harness stale-lock recovery is claim-safe', () => {
  it('takes the lock in the Owner repo before materializing a clone', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const release = acquireMutationLock(clone);
    try {
      const r = runHarness({
        tests: ['test/fixture.test.js'],
        expectBaselinePass: 4,
        mutations: [{
          name: 'lock is owner-global',
          file: 'src.mjs',
          anchor: "return 'b';",
          replacement: "return 'z';",
        }],
      });
      assert.equal(r.code, 2, `a held Owner lock must block the harness:\n${strip(r.out)}`);
      assert.match(strip(r.out), /mutation harness lock is already held|LOCK_FAILURE|already held/i);
    } finally {
      release();
    }
  });

  it('refuses a stale lock that already has a competing recovery claim', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const lockDir = join(clone, '.git', 'codex', 'mutation-harness.lock');
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, 'owner'), '999999999\n', 'utf8');
    writeFileSync(join(lockDir, 'recovery'), 'another-contender\n', 'utf8');
    try {
      assert.throws(
        () => acquireMutationLock(clone),
        /claim stale mutation harness lock|already held|recover/i,
      );
      assert.equal(readFileSync(join(lockDir, 'owner'), 'utf8'), '999999999\n');
      assert.equal(readFileSync(join(lockDir, 'recovery'), 'utf8'), 'another-contender\n');
    } finally {
      rmSync(join(clone, '.git', 'codex'), { recursive: true, force: true });
    }
  });
});

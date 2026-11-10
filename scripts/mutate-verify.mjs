#!/usr/bin/env node
//
// Mutation verification harness.
//
// Mutation verification is this repo's default way of proving a test actually tests
// something: re-introduce the defect, confirm the assertions fail by a specific count.
// Everyone hand-rolls the loop, and the hand-rolled version has bitten repeatedly. This
// script exists to make those specific failures impossible rather than remembered.
//
// What it refuses to do, and why each guard is here:
//
//   1. REFUSES TO RUN ON a dirty tree (except the explicitly Owner-owned
//      `.opencode/state.md`). The suite is still materialized into a disposable
//      clone, but a clean-tree invocation is the release-grade contract.
//
//   2. PROVES THE BASELINE IS NON-ZERO FIRST. A mutation "SURVIVED" is only meaningful if
//      the suite passed before it. Four false SURVIVED verdicts in round 3 came from a
//      suite that was not running at all (wrong path, module-load env, import-time const).
//
//   3. FAILS LOUDLY ON A MISSING OR AMBIGUOUS ANCHOR. A `.replace()` whose anchor does not
//      match is a silent no-op: tests pass, and the mutation is reported as SURVIVED when
//      nothing was ever mutated. Anchors must match exactly once.
//
//   4. RESTORES FROM the synthetic HEAD, not the index. `git checkout HEAD -- <file>`
//      restores the materialized reviewed bytes after each mutation; any other side
//      effect causes the disposable workspace to be discarded.
//
// Usage:
//   node scripts/mutate-verify.mjs <spec.json> [--keep-going]
//
// Spec format:
//   {
//     "tests": ["test/foo.test.js"],           // suite to run (required)
//     "expectBaselinePass": 12,                // optional: assert the exact baseline
//     "mutations": [
//       {
//         "name": "half 1 reverted",
//         "file": "src/auth.js",
//         "anchor": "exact source text, must appear exactly once",
//         "replacement": "what to put there",
//         "expectCaught": true                 // default true; false = documented SURVIVOR
//       }
//     ]
//   }
//
// Exit code 0 only when every mutation matched its expectation.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import {
  harnessEnv, repoGit, workspaceSnapshot, acquireMutationLock, assertContainedRegularFile,
  parseMutationReporterOutput,
  materializeMutationWorkspace,
} from './mutation-harness-utils.mjs';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

const SOURCE_ROOT = process.cwd();
let WORKSPACE_ROOT = SOURCE_ROOT;
const git = (args, root = WORKSPACE_ROOT) => repoGit(root, args);

/**
 * Exit 2 = the harness could not produce a trustworthy verdict (bad spec, dirty tree,
 * truncated run). Exit 1 = the harness worked and a mutation behaved unexpectedly. Keeping
 * those distinct matters because CI must be able to tell "your test has a gap" from
 * "the tool broke"; an uncaught crash also exits 1 by default, so main() traps that too.
 */
function die(msg) {
  console.error(`${RED}mutate-verify: ${msg}${RESET}`);
  process.exit(2);
}

/** Release-grade clean-tree preflight; the disposable clone handles restoration. */
function assertCleanTree() {
  const status = git(['status', '--porcelain'], SOURCE_ROOT);
  const unsafe = status.split('\n').filter(Boolean)
    .filter(line => line !== '?? .opencode/state.md');
  if (unsafe.length === 0) return;
  console.error(`${RED}mutate-verify: refusing to run — the working tree is dirty.${RESET}`);
  console.error('');
  console.error('  The release harness requires a reviewed commit before clean-tree mutation');
  console.error('  evidence. Use mutate-verify-dirty.mjs for the current uncommitted bytes; it');
  console.error('  runs in a disposable clone and never rewrites this checkout.');
  console.error('');
  console.error('  Commit the fix first, then re-run.');
  console.error('');
  for (const line of unsafe) console.error(`    ${line}`);
  process.exit(2);
}

/**
 * A mutation's target must be a TRACKED file inside the repo.
 *
 * Without this the harness happily writes to anything the spec names — including a path
 * outside the repo, or an untracked one inside it. Either is unrecoverable: the restore is
 * `git checkout HEAD -- <path>`, which fails for both, and the failure escapes before the
 * final tree check runs. Reproduced with file: "../outside.txt".
 */
function assertMutableTarget(file, root = WORKSPACE_ROOT) {
  if (isAbsolute(file)) die(`mutation target must be a repo-relative path, got "${file}"`);
  const rel = relative(root, resolve(root, file));
  if (rel.startsWith('..')) die(`mutation target escapes the repo: "${file}"`);
  try { assertContainedRegularFile(root, file); }
  catch (err) { die(err.message); }
  let tracked = '';
  try {
    tracked = git(['ls-files', '--error-unmatch', '--', rel], root);
  } catch {
    die(`mutation target is not tracked by git: "${file}". The restore step is `
      + '`git checkout HEAD -- <file>`, which cannot recover an untracked file, so the '
      + 'mutation would be permanent.');
  }
  if (!tracked) die(`mutation target is not tracked by git: "${file}"`);
  return rel;
}

/**
 * Test paths are spliced into node's argv, so an entry beginning with `-` would be parsed
 * as a node OPTION — `--import` there is arbitrary code execution while the baseline still
 * prints green. Specs are committed files rather than user input, so this is a footgun
 * rather than an attack surface, but it costs one line to close.
 */
function assertPlainTestPaths(tests) {
  for (const t of tests) {
    if (typeof t !== 'string' || t.startsWith('-')) {
      die(`spec.tests entry "${t}" starts with "-"; it would be parsed as a node option, `
        + 'not a test file');
    }
  }
}

/** Run the suite through the structured reporter; never count test-authored TAP. */
function runSuite(tests) {
  const args = [
    '--import', './scripts/mutation-network-deny.mjs',
    '--import', './test/setup-env.mjs',
    '--test-reporter=./scripts/mutation-harness-utils.mjs',
    // No --test-force-exit: measured on the Linux runner it ends the run early and still
    // exits 0, so a suite can report fewer tests than it owns (12 identical runs: 8 distinct
    // counts with it, 10/10 stable without). Guard 5 exists to refuse exactly that evidence.
    '--test', ...tests,
  ];
  // NODE_TEST_CONTEXT must not reach the child. When this harness is itself invoked from
  // inside `node --test` — which is exactly what a regression test for the harness does —
  // the inherited variable makes the child refuse to run anything at all:
  //   "node:test run() is being called recursively within a test file. skipping running files"
  // The child then reports 0 tests, the baseline check calls that "not green", and the real
  // failure is invisible behind a message about the suite. Deleting the variable is the whole
  // fix; forcing --test-reporter does not help, because nothing runs to be reported.
  // FORCE_COLOR is also deliberately absent.  The structured reporter is not
  // colour-sensitive, but a hermetic evidence child must not inherit presentation
  // switches (or any other ambient caller state) in the first place.
  const env = harnessEnv();
  let out = '';
  let errOut = '';
  let executionFailure = null;
  try {
    out = execFileSync(process.execPath, args, {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // node --test exits non-zero when tests fail; the output is still what we need.
    out = e.stdout || '';
    errOut = e.stderr || '';
    executionFailure = {
      status: e.status,
      signal: e.signal,
      killed: e.killed === true,
      code: e.code,
    };
  }
  const measured = parseMutationReporterOutput(out, errOut, executionFailure);
  const { pass, fail, tests: testCount, skipped, cancelled, todo } = measured;
  return {
    pass, fail, tests: testCount, total: testCount || pass + fail, skipped, cancelled, todo,
    infrastructureFailure: measured.infrastructureFailure,
    executionFailure,
    ok: !measured.infrastructureFailure && fail === 0 && pass > 0 && testCount === pass
      && skipped === 0 && cancelled === 0 && todo === 0,
    failedNames: measured.failedNames,
  };
}

/**
 * The refusal text for a baseline that is not `ok`, split by WHAT WAS MEASURED.
 *
 * `node:test` reports a suite whose event loop drained before every test ran as
 * CANCELLED tests, not failed ones: `pass=99 fail=0 cancelled=95`. That is a
 * truncated run wearing a green `fail=0`, and calling it a red suite sends the
 * reader to fix assertions that never ran. Measured on node 22 with this repo's
 * own suite (2026-10-05); node 24 does not drain this way.
 *
 * With fail === 0 there are no `test:fail` records from failing assertions, so
 * every name in `failedNames` belongs to a cancelled test — which is why the
 * same array can be relabelled rather than re-derived.
 */
function baselineRefusal(base) {
  if (base.fail > 0) {
    return `baseline is not green (pass=${base.pass} fail=${base.fail} tests=${base.tests}). `
      + 'Every "SURVIVED" below would be meaningless. Fix the suite first.'
      + (base.failedNames.length ? `\n  failing: ${base.failedNames.join(', ')}` : '');
  }
  if (base.cancelled > 0) {
    return `baseline is TRUNCATED, not green and not red (pass=${base.pass} fail=0 `
      + `cancelled=${base.cancelled} tests=${base.tests}). `
      + `${base.cancelled} test(s) were cancelled because the event loop drained before they ran, `
      + 'so this run measured less than the suite owns and every verdict below is unproven. '
      + 'Make the whole suite run (keep a live handle until the suite ends) and re-run.'
      + (base.failedNames.length ? `\n  cancelled: ${base.failedNames.join(', ')}` : '');
  }
  return `baseline did not measure what it claims (pass=${base.pass} fail=${base.fail} `
    + `tests=${base.tests} skipped=${base.skipped} cancelled=${base.cancelled} todo=${base.todo}). `
    + 'Nothing failed and nothing was cancelled, so no cause is claimed here: the counts do not '
    + 'add up to a completed run, and every "SURVIVED" below would be meaningless. '
    + 'Make the suite run to completion first.'
    + (base.failedNames.length ? `\n  failing: ${base.failedNames.join(', ')}` : '');
}

function main() {
  const argv = process.argv.slice(2);
  const keepGoing = argv.includes('--keep-going');
  const specPath = argv.find((a) => !a.startsWith('--'));
  if (!specPath) die('usage: node scripts/mutate-verify.mjs <spec.json> [--keep-going]');

  let spec;
  try {
    spec = JSON.parse(readFileSync(resolve(specPath), 'utf8'));
  } catch (e) {
    die(`could not read spec ${specPath}: ${e.message}`);
  }
  if (!Array.isArray(spec.tests) || spec.tests.length === 0) die('spec.tests must be a non-empty array');
  if (!Array.isArray(spec.mutations) || spec.mutations.length === 0) die('spec.mutations must be a non-empty array');

  assertPlainTestPaths(spec.tests);
  assertCleanTree();
  // Validate every target BEFORE running anything, so a bad path in mutation 9 does not
  // surface only after eight mutations have already run.
  for (const m of spec.mutations) if (m?.file) assertMutableTarget(m.file, SOURCE_ROOT);
  // The lock belongs to the Owner repository's common Git directory.  Acquiring it
  // after materialization would put each invocation in a different disposable
  // `.git/` and allow concurrent mutation runs to proceed against the same Owner.
  let releaseMutationLock;
  try { releaseMutationLock = acquireMutationLock(SOURCE_ROOT); }
  catch (err) { die(err.message); }
  let materialized;
  try { materialized = materializeMutationWorkspace(SOURCE_ROOT); }
  catch (err) { die(`could not create disposable mutation workspace: ${err.message}`); }
  WORKSPACE_ROOT = materialized.root;
  process.once('exit', materialized.cleanup);
  for (const m of spec.mutations) if (m?.file) assertMutableTarget(m.file);
  const baselineWorkspace = workspaceSnapshot(WORKSPACE_ROOT);

  // Guard 2: a SURVIVED verdict is meaningless if the suite was not passing to begin with.
  console.log(`${DIM}baseline: ${spec.tests.join(' ')}${RESET}`);
  const base = runSuite(spec.tests);
  if (!base.ok) {
    die(baselineRefusal(base));
  }
  if (workspaceSnapshot(WORKSPACE_ROOT) !== baselineWorkspace) {
    die('baseline test run changed repository files, refs, index, or remotes; mutation evidence is unsafe.');
  }
  if (spec.expectBaselinePass != null && base.pass !== spec.expectBaselinePass) {
    die(`baseline pass=${base.pass} but spec expects ${spec.expectBaselinePass}. `
      + 'Either the suite changed or the spec is stale — both are worth knowing before '
      + 'trusting any verdict below.');
  }
  console.log(`${GREEN}baseline ${base.pass} pass / 0 fail${RESET}\n`);

  const results = [];
  for (const m of spec.mutations) {
    const label = m.name || `${m.file} anchor`;
    if (!m.file || typeof m.anchor !== 'string' || typeof m.replacement !== 'string') {
      die(`mutation "${label}" needs file, anchor and replacement`);
    }
    const relFile = assertMutableTarget(m.file);
    const abs = resolve(WORKSPACE_ROOT, relFile);
    const before = readFileSync(abs, 'utf8');
    // A signal kills the process outright, so the `finally` restore below never runs and
    // src/ is left mutated with nothing printed. Register a handler for the duration of the
    // write so Ctrl-C / CI cancellation still restores.
    const onSignal = (sig) => {
      try { git(['checkout', 'HEAD', '--', relFile]); } catch { /* best effort */ }
      console.error(`\n${RED}mutate-verify: ${sig} — restored ${relFile} before exiting.${RESET}`);
      process.exit(130);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    // Guard 3: an anchor that does not match exactly once is a silent no-op.
    const hits = before.split(m.anchor).length - 1;
    if (hits !== 1) {
      git(['checkout', 'HEAD', '--', m.file]);
      die(`mutation "${label}": anchor matched ${hits} times in ${m.file} (need exactly 1). `
        + 'A non-matching anchor would mutate nothing and report SURVIVED.');
    }

    writeFileSync(abs, before.replace(m.anchor, m.replacement));
    let r;
    try {
      r = runSuite(spec.tests);
    } finally {
      // Guard 4: HEAD, never the index.
      git(['checkout', 'HEAD', '--', relFile]);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }

    // Guard 5: a SURVIVED verdict requires that the mutated run executed as many tests as
    // the baseline.
    //
    // Without it, a mutation that TRUNCATES the suite is reported as a clean survivor.
    // Reproduced: a replacement containing `process.exit(0)` produced `pass=1 fail=0`
    // against a baseline of 4 — verdict SURVIVED, while three tests silently never ran. That
    // is the same class of lie guard 2 catches for the baseline, one level down.
    //
    if (r.infrastructureFailure) {
      die(`mutation "${label}" produced a network/stub miss, abnormal child termination, unexpected Git, or an uncaught child error; this is infrastructure failure, not mutation evidence.`);
    }
    const complete = r.tests === base.tests
      && r.pass + r.fail === base.tests
      && r.skipped === 0 && r.cancelled === 0 && r.todo === 0;
    if (!complete) {
      git(['checkout', 'HEAD', '--', relFile]);
      die(`mutation "${label}" changed how many tests RAN: baseline ${base.tests}, mutated `
        + `${r.tests} (pass=${r.pass} fail=${r.fail} skipped=${r.skipped} cancelled=${r.cancelled} todo=${r.todo}). `
        + 'A failure from a truncated or load-broken suite is not mutation evidence; make the mutation narrower so the full suite still runs.');
    }

    // Guard 6: the mutation must not have left OTHER files dirty. The restore only covers
    // the file we wrote; a replacement whose test run writes elsewhere would otherwise let
    // every later mutation run under exactly the condition guard 1 forbids.
    if (workspaceSnapshot(WORKSPACE_ROOT) !== baselineWorkspace) {
      die(`mutation "${label}" changed repository files, refs, index, or remotes after restore. `
        + 'Inspect the repository before re-running.');
    }

    const expectCaught = m.expectCaught !== false;
    const caught = r.fail > 0;
    const asExpected = caught === expectCaught;
    results.push({ label, caught, expectCaught, asExpected, pass: r.pass, fail: r.fail, failedNames: r.failedNames });

    const verdict = caught ? `CAUGHT ${r.fail}` : 'SURVIVED';
    const colour = asExpected ? (caught ? GREEN : YELLOW) : RED;
    const mark = asExpected ? ' ' : '✗';
    console.log(`${colour}${mark} ${verdict.padEnd(12)}${RESET} ${label}  ${DIM}(pass=${r.pass} fail=${r.fail})${RESET}`);
    if (caught && r.failedNames.length) {
      for (const n of r.failedNames.slice(0, 4)) console.log(`${DIM}      ↳ ${n}${RESET}`);
    }
    if (!asExpected && !keepGoing) break;
  }

  // Final state must be clean, or the harness itself left debris.
  const after = git(['status', '--porcelain']);
  if (after) {
    console.error(`\n${RED}mutate-verify: tree is dirty after the run — restore failed:${RESET}`);
    console.error(after);
    process.exit(2);
  }

  const bad = results.filter((r) => !r.asExpected);
  console.log('');
  if (bad.length === 0) {
    releaseMutationLock?.();
    console.log(`${GREEN}all ${results.length} mutation(s) behaved as expected; tree clean${RESET}`);
    process.exit(0);
  }
  console.log(`${RED}${bad.length} of ${results.length} mutation(s) did NOT behave as expected:${RESET}`);
  for (const r of bad) {
    console.log(`  ${r.label}: expected ${r.expectCaught ? 'CAUGHT' : 'SURVIVED'}, got ${r.caught ? 'CAUGHT' : 'SURVIVED'}`);
    if (!r.caught) {
      console.log(`${DIM}    A survivor means the assertions do not cover this defect. Either add one`);
      console.log(`    that drives the real call site, or — if it genuinely cannot be guarded —`);
      console.log(`    record WHY and what premise keeps it harmless (see round 8).${RESET}`);
    }
  }
  process.exit(1);
}

try {
  main();
} catch (e) {
  // An uncaught throw would exit 1, colliding with the legitimate "a mutation did not
  // behave as expected" code. Re-map to 2 so a crashed harness is never mistaken for a
  // real finding, and say plainly that the tree may need checking.
  console.error(`${RED}mutate-verify: crashed — ${e?.message || e}${RESET}`);
  console.error('  Run `git status --short` and restore any mutated file with '
    + '`git checkout HEAD -- <file>`.');
  process.exit(2);
}

// The proofs for baseline drift and for wire byte identity both existed before this test
// and both were wired into the wrong place: the baseline checker ran only in the local
// gate, so a wrong pin reached CI green, and the release suite skipped the byte comparison
// whenever no base was supplied, so a release could ship with no wire evidence at all
// (a sibling CI job on the same SHA happened to run it — a coincidence, not a gate).
//
// This asserts the wiring only. It cannot show that either step FAILS when it should:
// that is `test/spec-baseline-check.test.js` for the checker (a wrong pin exits 1) and
// `test/wire-byte-identity.test.js` for the comparison (a missing or wrong base exits 1,
// the correct one compares 270 requests). Both were run by hand against a wrong pin and a
// wrong base before this file existed; a wiring assertion is not a substitute for them.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

/** The block of one top-level job, from its header to the next job header. */
function jobBlock(yaml, job) {
  const start = yaml.indexOf('\n  ' + job + ':\n');
  assert.ok(start >= 0, `job ${job} is gone`);
  const rest = yaml.slice(start + 1);
  const end = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

it('pull-request CI executes the measured baseline check, not only the static one', () => {
  const block = jobBlock(ci, 'specs');
  assert.match(block, /run: node scripts\/spec-baseline-check\.mjs\n/,
    'the specs job must execute the measured baseline check');
  // The check reads `git diff origin/master...HEAD` to decide what to measure. A shallow
  // clone leaves origin/master at HEAD, which silently widens the selection to every spec
  // (still correct, but no longer scoped) — and worse, it would hide a change-scoped bug.
  assert.match(block, /fetch-depth: 0/, 'the specs job needs history for change-scoped selection');
  assert.doesNotMatch(block, /--base\s/, 'the default base is deliberate; do not pin a revision here');
});

it('the release suite is given a strict-ancestor wire base and is told to require it', () => {
  const block = jobBlock(release, 'test');
  assert.match(block, /node scripts\/wire-base\.mjs/,
    'the release test job must select the baseline through the shared selector');
  assert.match(block, /refusing to compare \$HEAD_SHA against itself/,
    'a release run must refuse to compare the tree with itself');
  assert.match(block, /echo "WIRE_BASE_REQUIRED=1" >> "\$GITHUB_ENV"/,
    'without WIRE_BASE_REQUIRED=1 the wire test skips and the release ships without evidence');
  assert.match(block, /WIRE_BASE_TREE=\$RUNNER_TEMP\/wire-base/,
    'the selected base has to reach the test process');
  assert.match(block, /fetch-depth: 0/, 'the base is a tag, so tags must be fetched');
  // Ordering matters: the environment has to be exported before the suite runs.
  assert.ok(block.indexOf('WIRE_BASE_REQUIRED=1') < block.indexOf('run: npm run test:release'),
    'the base must be selected before the suite runs');
});

it('no workflow relaxes the wire comparison back to a skip', () => {
  for (const [name, yaml] of [['ci.yml', ci], ['release.yml', release]]) {
    assert.doesNotMatch(yaml, /WIRE_BASE_REQUIRED['"]?\s*[:=]\s*['"]?0/, `${name} must not disable the requirement`);
  }
});

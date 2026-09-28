// WHY THIS FILE EXISTS. test/wire-byte-identity.test.js compares request bytes against a
// released tree, and until 2026-09-22 it never identified that tree: any directory with
// the right two filenames was accepted, so the recorded re-check passed while the
// `.claude/worktrees/wire-base` fallback sat three releases stale
// (evidence/wire-recheck/result.json documents exactly that near-miss). The gate now
// resolves the expected release from the tested repository's annotated tags, measures
// the base checkout's HEAD with Git, and refuses the comparison unless they agree.
//
// The rules live in test/wire-provenance.js. Every Git call there is injectable, so the
// cases below run on any machine — the one case that needs a real repository is gated by
// the existing test/git-fixture-env.js machine gate, not by a Windows/system-Git
// requirement, and never weakens the strict-ancestor selector in scripts/wire-base.mjs
// (test/wire-base-selection.test.js still owns that policy).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { REAL_GIT, SKIP_REASON, isolatedGitEnv } from './git-fixture-env.js';
import { PROVENANCE_PREFIX, absentBase, formatProvenance, resolveWireProvenance } from './wire-provenance.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTED = 'a'.repeat(40);
const TESTED_ROOT = join(ROOT, 'tested-checkout');
const BASE_ROOT = join(ROOT, 'base-checkout');
const RELEASE_SHA = 'c22e0bf36fef2f4c07bbd3feb87c124d6e361b14';
const STALE_SHA = '0c355453d0a509816309bbaa0bb59ee222958a0c';
const SELECTION = { tag: 'v3.9.37', sha: RELEASE_SHA, kind: 'annotated', head: TESTED, releases: 3 };

/** A Git runner with the three reads the resolver performs, and nothing else. */
function fakeGit({ heads = { [TESTED_ROOT]: TESTED, [BASE_ROOT]: RELEASE_SHA }, porcelain = {}, dirtySrc = '', tagRefs = {} } = {}) {
  const calls = [];
  const git = (args, cwd) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === 'rev-parse HEAD') {
      if (!(cwd in heads)) throw Object.assign(new Error('git failed'), { stderr: `fatal: not a git repository: ${cwd}` });
      return heads[cwd];
    }
    if (key === 'status --porcelain=v1 --untracked-files=all') return porcelain[cwd] ?? '';
    if (key === 'status --porcelain=v1 --untracked-files=all -- src') return dirtySrc;
    if (key.startsWith('rev-parse refs/tags/')) {
      const tag = key.slice('rev-parse refs/tags/'.length).replace('^{commit}', '');
      if (!(tag in tagRefs)) throw Object.assign(new Error('git failed'), { stderr: `fatal: bad revision 'refs/tags/${tag}^{commit}'` });
      return tagRefs[tag];
    }
    throw new Error(`unexpected git call: ${key}`);
  };
  return { git, calls };
}

const resolveWith = (options = {}) => {
  const { git, calls } = fakeGit(options.git);
  const selectBase = options.selectBase === undefined ? () => SELECTION : options.selectBase;
  return {
    calls,
    run: (env = {}) => resolveWireProvenance({
      root: TESTED_ROOT, baseTree: options.baseTree ?? BASE_ROOT, env, git, selectBase, comparisons: 270,
    }),
  };
};

test('a matching base is accepted and the identity line names both revisions', () => {
  const { run } = resolveWith();
  const provenance = run({ WIRE_BASE_REQUIRED: '1' });

  assert.equal(provenance.testedHead, TESTED);
  assert.equal(provenance.baseHead, RELEASE_SHA, 'the base HEAD is measured, not taken from the environment');
  assert.equal(provenance.baseTree, BASE_ROOT);
  assert.equal(provenance.expected.tag, 'v3.9.37');
  assert.equal(provenance.expected.sha, RELEASE_SHA);
  assert.equal(provenance.expected.from, 'selection');
  assert.equal(provenance.comparisons, 270);
  assert.equal(provenance.skipped, false);

  const line = formatProvenance(provenance);
  assert.ok(line.startsWith(PROVENANCE_PREFIX));
  const diagnostic = JSON.parse(line.slice(PROVENANCE_PREFIX.length));
  assert.deepEqual(
    {
      tested_head: diagnostic.tested_head, tested_root: diagnostic.tested_root,
      base_root: diagnostic.base_root, base_head: diagnostic.base_head,
      expected_tag: diagnostic.expected_tag, expected_sha: diagnostic.expected_sha,
      comparisons: diagnostic.comparisons,
    },
    {
      tested_head: TESTED, tested_root: TESTED_ROOT, base_root: BASE_ROOT, base_head: RELEASE_SHA,
      expected_tag: 'v3.9.37', expected_sha: RELEASE_SHA, comparisons: 270,
    },
  );
});

test('a base at the wrong revision fails before the comparison', () => {
  const { run } = resolveWith({ git: { heads: { [TESTED_ROOT]: TESTED, [BASE_ROOT]: STALE_SHA } } });
  assert.throws(run, /not the expected release v3\.9\.37 \(c22e0bf/);
});

test('the tested commit itself is never a comparison base', () => {
  const selfAsBase = resolveWith({ git: { heads: { [TESTED_ROOT]: TESTED, [BASE_ROOT]: TESTED } } });
  assert.throws(selfAsBase.run, /refusing a self comparison/);

  // …and neither through an environment expectation, which is checked against the
  // tested HEAD rather than trusted.
  const selfAsExpectation = resolveWith({ selectBase: () => null });
  assert.throws(() => selfAsExpectation.run({ WIRE_BASE_SHA: TESTED }), /against itself/);
});

test('an unmatched base fails even when the environment names the expected SHA', () => {
  const { run } = resolveWith({
    git: { heads: { [TESTED_ROOT]: TESTED, [BASE_ROOT]: STALE_SHA } },
    selectBase: () => null,
  });
  assert.throws(() => run({ WIRE_BASE_SHA: RELEASE_SHA }), /not the expected release/);
});

test('the expected identity must exist and must be a full object id', () => {
  const unresolvable = resolveWith({ selectBase: () => null });
  assert.throws(unresolvable.run, /cannot establish the expected release identity/);

  const selectionFails = resolveWith({
    selectBase: () => { throw Object.assign(new Error('spawn git ENOENT'), { stderr: 'fatal: not a git repository' }); },
  });
  assert.throws(selectionFails.run, /release selection failed: fatal: not a git repository/);

  // A selection that cannot run is still workable when CI supplies the identity, and
  // then the measured base HEAD is what decides.
  const fromEnv = resolveWith({ selectBase: () => { throw new Error('no git'); } });
  assert.equal(fromEnv.run({ WIRE_BASE_SHA: RELEASE_SHA }).expected.from, 'env');
  assert.throws(() => fromEnv.run({ WIRE_BASE_SHA: 'HEAD' }), /not a full object id/);
  assert.throws(() => fromEnv.run({ WIRE_BASE_SHA: RELEASE_SHA.slice(0, 12) }), /not a full object id/);
});

test('environment expectations are validated against the selection, not accepted', () => {
  const { run } = resolveWith();
  assert.throws(() => run({ WIRE_BASE_SHA: STALE_SHA }), /contradicts the selected release v3\.9\.37/);
  assert.throws(() => run({ WIRE_BASE_TAG: 'v3.9.35' }), /contradicts the selected release v3\.9\.37/);
});

test('a supplied release tag must resolve to the base HEAD in the base checkout', () => {
  const matching = resolveWith({ git: { tagRefs: { 'v3.9.37': RELEASE_SHA } } });
  const provenance = matching.run({ WIRE_BASE_TAG: 'v3.9.37', WIRE_BASE_SHA: RELEASE_SHA });
  assert.equal(provenance.tagRefVerified, true);
  assert.equal(provenance.expected.from, 'selection+env');

  const elsewhere = resolveWith({ git: { tagRefs: { 'v3.9.37': STALE_SHA } } });
  assert.throws(() => elsewhere.run({ WIRE_BASE_TAG: 'v3.9.37' }), /not to its HEAD/);

  const unknown = resolveWith({ git: { tagRefs: {} } });
  assert.throws(() => unknown.run({ WIRE_BASE_TAG: 'v3.9.37' }), /WIRE_BASE_TAG v3\.9\.37 in the base checkout/);
});

test('a base with local changes under src/ is not immutable release evidence', () => {
  const dirty = resolveWith({ git: { dirtySrc: ' M src/devin-connect.js' } });
  assert.throws(dirty.run, /dirty under src\/.*src\/devin-connect\.js/s);

  // Changes elsewhere in the base are recorded, not fatal: the comparison consumes src/.
  const notes = resolveWith({ git: { porcelain: { [BASE_ROOT]: ' M README.md', [TESTED_ROOT]: ' M src/index.js' } } });
  const provenance = notes.run();
  assert.equal(provenance.baseDirty, true);
  assert.equal(provenance.testedDirty, true);
});

test('an unreadable base or tested tree fails with the reason it was measured', () => {
  const missingBase = resolveWith({ git: { heads: { [TESTED_ROOT]: TESTED } } });
  assert.throws(missingBase.run, /cannot resolve the base HEAD at .*not a git repository/);

  const missingTested = resolveWith({ git: { heads: { [BASE_ROOT]: RELEASE_SHA } } });
  assert.throws(missingTested.run, /cannot resolve the tested HEAD at/);
});

test('an absent base skips locally and fails closed when the gate requires one', () => {
  const skipped = absentBase({ root: TESTED_ROOT, reason: 'no pre-change tree', env: {}, comparisons: 270 });
  assert.equal(skipped.skipped, true);
  const line = formatProvenance(skipped);
  const diagnostic = JSON.parse(line.slice(PROVENANCE_PREFIX.length));
  assert.deepEqual({ skipped: diagnostic.skipped, reason: diagnostic.reason, comparisons: diagnostic.comparisons },
    { skipped: true, reason: 'no pre-change tree', comparisons: 270 });

  assert.throws(
    () => absentBase({ root: TESTED_ROOT, reason: 'no pre-change tree', env: { WIRE_BASE_REQUIRED: '1' }, comparisons: 270 }),
    /WIRE_BASE_REQUIRED=1/,
  );
});

// The unit cases above drive the rules with a fake runner. These two run the real gate
// against real directories, because a fake and the real test file could otherwise
// disagree about what actually happens.

function runWireGate(env) {
  // NODE_TEST_CONTEXT is set for every test-file process by the runner; a child that
  // inherits it refuses to run files ("node:test run() is being called recursively")
  // and exits 0 without testing anything. The shard runner deletes it for the same
  // reason. Anything this gate produces must not be discarded by that guard.
  const childEnv = { ...env, WIRE_BASE_REQUIRED: '1', NO_COLOR: '1' };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--import', './test/setup-env.mjs', '--test', 'test/wire-byte-identity.test.js'], {
    cwd: ROOT, encoding: 'utf8', env: childEnv, timeout: 60_000,
  });
  return { child, output: `${child.stdout ?? ''}${child.stderr ?? ''}`.slice(0, 4000) };
}

test('a base tree with no Git identity is refused instead of compared', (t) => {
  // A byte-identical copy of this tree's src/, with no .git: the old gate would compare
  // against it and report a green "identical" result for a revision it cannot name. The
  // copy is what makes this case portable — no release checkout, no Git required.
  const baseTree = mkdtempSync(join(tmpdir(), 'wire-base-anonymous-'));
  t.after(() => rmSync(baseTree, { recursive: true, force: true }));
  cpSync(join(ROOT, 'src'), join(baseTree, 'src'), { recursive: true });

  const { child, output } = runWireGate({ ...process.env, WIRE_BASE_TREE: baseTree });
  assert.notEqual(child.status, 0, `the gate accepted an unidentified base:\n${output}`);
  assert.match(output, /WIRE_PROVENANCE_FAILURE /, `no provenance failure in:\n${output}`);
  assert.match(output, /cannot resolve the base HEAD|expected release identity/,
    `the failure must name the base identity, not a byte diff:\n${output}`);
  assert.doesNotMatch(output, /WIRE_PROVENANCE_COMPARED /, 'the comparison must not run at all');
});

// …and the same refusal with a real repository whose HEAD is a real revision, which no
// fake Git runner can stand in for. Needs Git at a trusted absolute POSIX path, like
// every other real-repository fixture in this suite.
test('the real gate refuses a real checkout that is not the selected release',
  { skip: REAL_GIT ? false : SKIP_REASON }, (t) => {
    const baseTree = mkdtempSync(join(tmpdir(), 'wire-base-wrong-'));
    t.after(() => rmSync(baseTree, { recursive: true, force: true }));
    const env = isolatedGitEnv();
    const git = (...args) => {
      const result = spawnSync(REAL_GIT, args, { cwd: baseTree, encoding: 'utf8', env });
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.email', 'wire-fixture@example.test');
    git('config', 'user.name', 'wire provenance fixture');
    mkdirSync(join(baseTree, 'src', 'handlers'), { recursive: true });
    for (const file of ['src/devin-connect.js', 'src/handlers/tool-emulation.js']) {
      writeFileSync(join(baseTree, file), '// a directory with the right filenames is not a released revision\n');
    }
    git('add', '.');
    git('commit', '-q', '-m', 'not a release');

    const { child, output } = runWireGate({ ...env, WIRE_BASE_TREE: baseTree });
    assert.notEqual(child.status, 0, `the gate accepted a foreign revision:\n${output}`);
    assert.match(output, /WIRE_PROVENANCE_FAILURE /, `no provenance failure in:\n${output}`);
    assert.match(output, /not the expected release|refusing|expected release identity/,
      `the failure must name the identity, not a byte diff:\n${output}`);
    assert.doesNotMatch(output, /WIRE_PROVENANCE_COMPARED /, 'the comparison must not run at all');
  });

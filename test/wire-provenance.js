// WHY THIS HELPER EXISTS. test/wire-byte-identity.test.js compares the protobuf request
// bytes of the current tree against a released one. Until 2026-09-22 it loaded whatever
// directory WIRE_BASE_TREE (or its `.claude/worktrees/wire-base` fallback) happened to
// hold and never asked WHICH revision that was: the recorded re-check passed while the
// explicit env path was a release, and would have passed identically against a checkout
// three releases stale (evidence/wire-recheck/result.json). A comparison whose base
// cannot be named is not evidence, and a base that IS the tested commit proves nothing.
//
// So the base identity is resolved and enforced BEFORE the base modules are imported:
// expected release from the tested repository's annotated release tags (scripts/
// wire-base.mjs selectBase — the strict-ancestor policy lives there and is untouched),
// actual base HEAD measured with Git in the base checkout, and the comparison refused
// unless the measured HEAD is exactly the expected revision, is not the tested commit,
// and the base's src/ tree is clean.
//
// Every Git call is injectable: the cross-platform unit tests drive the enforcement
// logic with a fake runner (test/wire-provenance.test.js), and the real test file passes
// realGit. Nothing here needs /usr/bin/git to be importable.
import { execFileSync } from 'node:child_process';

const OBJECT_ID = /^[0-9a-f]{40,64}$/i;
export const PROVENANCE_PREFIX = 'WIRE_PROVENANCE ';
export const FAILURE_PREFIX = 'WIRE_PROVENANCE_FAILURE ';

/** Git for the real gate: the checkout under test, and the base checkout beside it. */
export function realGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .replace(/\r\n/g, '\n')
    .trim();
}

function failure(reason, detail = {}) {
  const error = new Error(`wire provenance: ${reason}`);
  error.wireProvenance = { reason, ...detail };
  return error;
}

const oneLine = value => String(value ?? '').trim().split('\n')[0].slice(0, 300);
const firstLines = value => String(value ?? '').trim().split('\n').slice(0, 5).join(' | ');

/**
 * Resolve the comparison base the wire gate is about to use. Throws — with a reason that
 * is printed before the throw — when the base cannot be identified or does not match the
 * release the tested tree says it should be.
 */
export function resolveWireProvenance({ root, baseTree, env = {}, git = realGit, selectBase, comparisons }) {
  const required = env.WIRE_BASE_REQUIRED === '1';
  const suppliedSha = env.WIRE_BASE_SHA || null;
  const suppliedTag = env.WIRE_BASE_TAG || null;
  if (suppliedSha && !OBJECT_ID.test(suppliedSha)) {
    throw failure(`WIRE_BASE_SHA is not a full object id: ${JSON.stringify(suppliedSha)}`);
  }

  let selection = null;
  let selectionError = null;
  try {
    selection = selectBase(root);
  } catch (error) {
    selectionError = oneLine(error.stderr || error.message || error);
  }

  if (selection && suppliedSha && selection.sha !== suppliedSha) {
    throw failure(`WIRE_BASE_SHA ${suppliedSha} contradicts the selected release ${selection.tag} (${selection.sha})`);
  }
  if (selection && suppliedTag && selection.tag !== suppliedTag) {
    throw failure(`WIRE_BASE_TAG ${suppliedTag} contradicts the selected release ${selection.tag}`);
  }
  const expectedSha = selection ? selection.sha : suppliedSha;
  const expectedTag = selection ? selection.tag : suppliedTag;
  if (!expectedSha) {
    const why = selectionError
      ? `release selection failed: ${selectionError}`
      : 'no annotated release tag is a strict ancestor of HEAD';
    throw failure(`cannot establish the expected release identity (${why})`
      + ' — set WIRE_BASE_SHA/WIRE_BASE_TAG to the release this base must be');
  }

  const measure = (args, cwd, what) => {
    try {
      return git(args, cwd);
    } catch (error) {
      throw failure(`cannot resolve ${what} (${oneLine(error.stderr || error.message || error)})`);
    }
  };
  const status = ['status', '--porcelain=v1', '--untracked-files=all'];

  const testedHead = measure(['rev-parse', 'HEAD'], root, `the tested HEAD at ${root}`);
  if (expectedSha === testedHead) throw failure(`refusing to compare ${testedHead} against itself`);

  const baseHead = measure(['rev-parse', 'HEAD'], baseTree, `the base HEAD at ${baseTree}`);
  const testedStatus = measure(status, root, `the tested worktree status at ${root}`);
  const baseStatus = measure(status, baseTree, `the base worktree status at ${baseTree}`);
  const baseSrcStatus = measure([...status, '--', 'src'], baseTree, `the base src/ status at ${baseTree}`);

  if (baseHead === testedHead) {
    throw failure(`the base checkout at ${baseTree} is the tested commit ${testedHead} — refusing a self comparison`);
  }
  if (baseHead !== expectedSha) {
    throw failure(`base HEAD ${baseHead} is not the expected release ${expectedTag ?? '(unnamed)'} (${expectedSha}) at ${baseTree}`);
  }
  if (baseSrcStatus) {
    throw failure(`the compared base checkout is dirty under src/ at ${baseTree}: ${firstLines(baseSrcStatus)}`);
  }

  // CI names the release tag it materialised; that name is an expectation to measure
  // against, not a value to print in place of a measurement.
  let tagRefVerified = null;
  if (suppliedTag) {
    const tagSha = measure(['rev-parse', `refs/tags/${suppliedTag}^{commit}`], baseTree,
      `WIRE_BASE_TAG ${suppliedTag} in the base checkout`);
    if (tagSha !== baseHead) {
      throw failure(`WIRE_BASE_TAG ${suppliedTag} resolves to ${tagSha} in the base checkout, not to its HEAD ${baseHead}`);
    }
    tagRefVerified = true;
  }

  return {
    skipped: false,
    root,
    baseTree,
    testedHead,
    testedDirty: testedStatus !== '',
    baseHead,
    baseDirty: baseStatus !== '',
    expected: {
      tag: expectedTag,
      sha: expectedSha,
      kind: selection?.kind ?? null,
      from: selection ? (suppliedSha || suppliedTag ? 'selection+env' : 'selection') : 'env',
      releases: selection?.releases ?? null,
    },
    selectionError,
    tagRefVerified,
    env: { WIRE_BASE_SHA: suppliedSha, WIRE_BASE_TAG: suppliedTag, WIRE_BASE_REQUIRED: required },
    comparisons,
  };
}

/**
 * No base tree at all. Optional locally (skip with a reason), fatal in CI
 * (WIRE_BASE_REQUIRED=1): a gate that cannot run must never look green.
 */
export function absentBase({ root, reason, env = {}, comparisons }) {
  if (env.WIRE_BASE_REQUIRED === '1') throw failure(`${reason} (WIRE_BASE_REQUIRED=1)`);
  return { skipped: true, root, reason, comparisons, env: { WIRE_BASE_REQUIRED: env.WIRE_BASE_REQUIRED === '1' } };
}

/** One machine-readable line: what was tested, what it was compared against, how much. */
export function formatProvenance(provenance) {
  if (provenance.skipped) {
    return PROVENANCE_PREFIX + JSON.stringify({
      skipped: true,
      reason: provenance.reason,
      tested_root: provenance.root,
      comparisons: provenance.comparisons,
    });
  }
  return PROVENANCE_PREFIX + JSON.stringify({
    tested_head: provenance.testedHead,
    tested_root: provenance.root,
    tested_dirty: provenance.testedDirty,
    base_root: provenance.baseTree,
    base_head: provenance.baseHead,
    base_dirty: provenance.baseDirty,
    expected_tag: provenance.expected.tag,
    expected_sha: provenance.expected.sha,
    expected_from: provenance.expected.from,
    expected_releases: provenance.expected.releases,
    selection_error: provenance.selectionError,
    tag_ref_verified: provenance.tagRefVerified,
    env: provenance.env,
    comparisons: provenance.comparisons,
  });
}

/** Print the failure reason before throwing, so a captured log names the cause. */
export function reportProvenanceFailure(error) {
  process.stdout.write(FAILURE_PREFIX + JSON.stringify(error?.wireProvenance ?? { reason: String(error?.message ?? error) }) + '\n');
}

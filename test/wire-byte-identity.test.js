// WHY THIS FILE EXISTS. "The default path emits the same bytes" is this project's
// first invariant — the upstream is a stateful validator, so a stray byte in a
// request frame is a rejected session, not a style question. Until now that
// invariant was only checked by an author-run script living outside the repo, so a
// pull request could change the encoder, pass every test, and be merged.
//
// This test makes the invariant mechanical: it builds complete request frames
// through the current tree and through a PRE-CHANGE tree, over a fixed matrix of
// histories x prepare routes x native/emulated x env switches, and requires the
// bytes to be identical. Any PR that alters default-path output fails here.
//
// The comparison base is the last released tag (CI exports WIRE_BASE_TREE after
// materialising it from scripts/wire-base.mjs, which picks the newest ANNOTATED tag
// that is a strict ancestor of the tested commit — `git describe --tags` returns
// HEAD's own tag on a release commit, and a gate that compares the tree with itself
// passes without testing anything). Locally a `.claude/worktrees/wire-base` checkout
// works. When neither exists the test SKIPS with a reason instead of passing
// quietly — a gate that cannot run must never look green.
//
// The base is IDENTIFIED, not assumed (2026-09-22, D-WIRE-BASE). A directory holding
// the right two filenames is not a released revision, and the recorded re-check of this
// gate passed while its stdout named no revision at all: WIRE_BASE_TREE happened to
// point at v3.9.37, and the stale `.claude/worktrees/wire-base` fallback (0c35545, three
// releases back) was one unset variable away from being the compared tree — the log
// would have reported a byte difference, if any, without ever naming what it compared
// against. So before importing the base modules this file resolves the expected release
// from the tested repository's annotated tags, measures the base checkout's HEAD with
// Git, and refuses to compare unless they match, the base is not the tested commit, and
// the base's src/ tree is clean. The resolved identity is printed as one `WIRE_PROVENANCE`
// line — a comparison whose base cannot be named in the output is not evidence.
//
// WHAT THIS DOES NOT PROVE (2026-09-17 review, protocol lens — do not read this
// gate as "the wire is correct"):
//   • it compares the protobuf request body only; not HTTP/Connect framing, not the
//     handler, not the response stream;
//   • the matrix is 9 histories x 5 prepare routes x native/emulated x 3 env, chosen
//     around the shapes that changed recently — it does NOT contain #271's
//     split-call + stray-text shape, and every replay env here is default or
//     explicitly off, so reasoning-replay behaviour is out of scope;
//   • a pre-existing defect that survives both trees passes by construction: dropping
//     image-only assistant turns (#272) is byte-identical before and after any of
//     these commits.
// It proves exactly one thing, and it is the thing it must prove: the default path
// did not move.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { selectBase } from '../scripts/wire-base.mjs';
import { absentBase, formatProvenance, reportProvenanceFailure, resolveWireProvenance } from './wire-provenance.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const EXPECTED_COMPARISONS = 270;

function findBaseTree() {
  const candidates = [
    process.env.WIRE_BASE_TREE,
    join(ROOT, '.claude', 'worktrees', 'wire-base'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const root = resolve(candidate);
    if (existsSync(join(root, 'src', 'devin-connect.js')) && existsSync(join(root, 'src', 'handlers', 'tool-emulation.js'))) {
      return root;
    }
  }
  return null;
}

const BASE = findBaseTree();
const SKIP = 'no pre-change tree to compare against — set WIRE_BASE_TREE to a checkout of the last release';
// Resolved — and enforced — in this child, before any base module is imported. See
// test/wire-provenance.js for the rules and test/wire-provenance.test.js for them
// exercised without a real Git.
let PROVENANCE;
try {
  PROVENANCE = BASE
    ? resolveWireProvenance({
      root: ROOT, baseTree: BASE, env: process.env, selectBase, comparisons: EXPECTED_COMPARISONS,
    })
    : absentBase({ root: ROOT, reason: SKIP, env: process.env, comparisons: EXPECTED_COMPARISONS });
} catch (error) {
  reportProvenanceFailure(error);
  throw error;
}
process.stdout.write(formatProvenance(PROVENANCE) + '\n');

async function load(root) {
  const file = name => pathToFileURL(resolve(root, 'src', name)).href;
  return {
    wire: await import(file('devin-connect.js')),
    tools: await import(file('handlers/tool-emulation.js')),
  };
}

const U = { role: 'user', content: 'continue' };
const tc = id => ({ id, type: 'function', function: { name: 'f', arguments: '{}' } });
const A = id => ({ role: 'assistant', content: null, tool_calls: [tc(id)] });
const T = id => ({ role: 'tool', tool_call_id: id, content: `result-${id}` });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } };
const batch = (text = 'before') => [
  { role: 'assistant', content: text, reasoning: 'R', reasoning_content: 'A', tool_calls: [tc('a'), tc('b')] },
  T('a'), T('b'), U,
];

// The same nine histories the author's offline harness uses. They are chosen to
// cover the shapes that changed in recent releases (empty assistant turns, image
// turns, call/result ordering, reasoning replay) rather than to be exhaustive.
const HISTORIES = [
  [U],
  [{ role: 'assistant', content: '' }, U],
  [{ role: 'assistant', content: null, reasoning: 'R' }, U],
  [{ role: 'assistant', content: [image] }, U],
  [{ role: 'assistant', content: 'before' },
    { role: 'assistant', content: [image, { type: 'text', text: 'caption' }] }, U],
  [T('a'), A('a'), U],
  [T('missing'), U],
  batch(),
  batch(''),
];
const ROUTES = ['raw', 'direct', 'normalize', 'strip', 'emulation'];
const ENVS = [
  {},
  { DEVIN_CONNECT_REPLAY_REASONING: '0' },
  { DEVIN_CONNECT_REPLAY_REASONING: '0', DEVIN_CONNECT_IMAGE_TAG: '0' },
];

function prepare(api, input, route) {
  const messages = structuredClone(input);
  if (route === 'raw') return messages;
  if (route === 'direct') return api.tools.interleaveParallelToolMessages(messages);
  return api.tools.normalizeMessagesForCascade(messages, [], {
    modelKey: 'swe-1-7', route: 'devin_connect', injectUserPreamble: false,
    nativeStructured: route !== 'emulation',
    ...(route === 'strip' ? { stripOrphans: true } : {}),
  });
}

function build(api, messages, env = {}, nativeToolCall = true) {
  const originalUUID = crypto.randomUUID;
  let n = 0;
  // Deterministic ids: two unrestricted calls mint different UUIDs, and comparing
  // them would either fail for the wrong reason or force both trees to be patched
  // in ways that hide a real byte change.
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  syncBuiltinESMExports();
  try {
    return api.wire.buildGetChatMessageRequest({
      token: 'offline-only', model: 'swe-1-7', messages, env, nativeToolCall,
      deviceSeed: 'wire-device', sessionId: 'wire-session',
      sessionModelConfig: { id: 'wire-config', turn: 1 },
    });
  } finally {
    crypto.randomUUID = originalUUID;
    syncBuiltinESMExports();
  }
}

test('the default path emits the same complete request bytes as the last release', { skip: PROVENANCE.skipped ? PROVENANCE.reason : false }, async () => {
  const current = await load(ROOT);
  const previous = await load(BASE);
  let compared = 0;
  for (const [index, history] of HISTORIES.entries()) {
    for (const route of ROUTES) {
      for (const native of [false, true]) {
        for (const env of ENVS) {
          const before = build(previous, prepare(previous, history, route), env, native);
          const after = build(current, prepare(current, history, route), env, native);
          assert.deepEqual(after, before,
            `fixture=${index} route=${route} native=${native} env=${JSON.stringify(env)}: request bytes changed`);
          compared++;
        }
      }
    }
  }
  // What this run actually measured, next to what it claimed it would: the identity
  // line above is only evidence together with a count of the comparisons it covers.
  process.stdout.write('WIRE_PROVENANCE_COMPARED ' + JSON.stringify({
    compared, expected: EXPECTED_COMPARISONS, base_head: PROVENANCE.baseHead ?? null,
  }) + '\n');
  // A shrunken matrix must not read as a pass.
  assert.equal(compared, EXPECTED_COMPARISONS, 'the comparison matrix changed size; update the expectation deliberately');
});

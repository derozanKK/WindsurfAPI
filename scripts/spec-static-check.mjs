#!/usr/bin/env node
// Static mutation-spec consistency check — the half of pr-gate that needs no test run.
//
// WHY THIS EXISTS AS ITS OWN ENTRY POINT
//
// Three baseline/anchor drifts landed on master in one week (#241's anchors, the
// retry-rescue 82/87 -> 88 collision, reasoning-continuity 289 -> 300). Every one was
// a MERGE product: each PR measured its own spec correctly in isolation and was wrong
// once stacked. None was visible to `npm test`, because the suite does not run specs.
//
// pr-gate.mjs already implements these checks, but it is a local, manual, worktree-based
// tool: on `--local` it scopes to ALL specs and measures every baseline, which spawns a
// test run per spec (>5 min measured). That is the right shape for a pre-merge review
// and the wrong shape for per-PR CI.
//
// So this script carries ONLY the checks that read files and never execute tests:
//
//   1. anchor uniqueness   — every mutation anchor appears EXACTLY once in its target.
//                            0 => the pinned line was edited and the mutation is now a
//                            silent no-op that reports SURVIVED. 2+ => mutate-verify's
//                            guard aborts. Neither is visible to the suite.
//   2. spec well-formedness — parseable JSON, required fields present, `file` exists,
//                            `tests` exist. A spec that cannot load is a spec that
//                            silently stops guarding.
//   3. baseline presence   — expectBaselinePass must be a number, not absent and not a
//                            string. The VALUE is verified by scripts/spec-baseline-audit.mjs
//                            (which does run tests) — deliberately not here.
//
// Measured cost: ~0.3s for 25 specs / 236 mutations. Cheap enough to run on every push.
//
// Deliberately NOT here: baseline VALUE verification. It needs a real test run, and a
// check that is slow gets skipped. Value drift is caught post-merge by the audit script.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SPEC_DIR = join(process.cwd(), 'test', 'mutations');

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { red: '', green: '', yellow: '', dim: '', bold: '', reset: '' };

// Same algorithm as pr-gate.mjs countOccurrences: a disagreement between the two would
// be unexplainable, so the step is identical rather than merely equivalent.
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function loadSpecs() {
  if (!existsSync(SPEC_DIR)) return [];
  return readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((name) => {
      const abs = join(SPEC_DIR, name);
      try {
        return { name, abs, spec: JSON.parse(readFileSync(abs, 'utf8')) };
      } catch (err) {
        return { name, abs, parseError: err.message };
      }
    });
}

const problems = [];
const specs = loadSpecs();
let mutationCount = 0;

if (!specs.length) {
  console.error(`${C.red}spec-static-check: no specs found under test/mutations${C.reset}`);
  process.exit(2);
}

for (const s of specs) {
  if (s.parseError) {
    problems.push({ spec: s.name, kind: 'parse', detail: s.parseError });
    continue;
  }
  const spec = s.spec;

  if (!Array.isArray(spec.tests) || spec.tests.length === 0) {
    problems.push({ spec: s.name, kind: 'shape', detail: '`tests` must be a non-empty array' });
  } else {
    for (const t of spec.tests) {
      if (!existsSync(join(process.cwd(), t))) {
        problems.push({ spec: s.name, kind: 'missing-test', detail: t });
      }
    }
  }

  // A number is required. `undefined` means nothing pins the count; a string would pass
  // a loose `==` and fail the strict comparison mutate-verify does.
  if (!Number.isSafeInteger(spec.expectBaselinePass) || spec.expectBaselinePass <= 0) {
    problems.push({ spec: s.name, kind: 'baseline-shape',
      detail: 'expectBaselinePass must be a positive safe integer' });
  }
  // Counting it()/test() source text is not a lower bound: comments, strings and
  // conditional registration can inflate it; loops and aliases can reduce it.
  // Numeric drift is decided by the mandatory structured baseline execution step,
  // not by pretending this static anchor/schema checker executed any tests.

  if (!Array.isArray(spec.mutations) || spec.mutations.length === 0) {
    problems.push({ spec: s.name, kind: 'shape', detail: '`mutations` must be a non-empty array' });
    continue;
  }

  for (const m of spec.mutations) {
    mutationCount++;
    const label = (m.name || '(unnamed)').slice(0, 70);
    if (!m.file) {
      problems.push({ spec: s.name, kind: 'shape', detail: `mutation missing \`file\`: ${label}` });
      continue;
    }
    const abs = join(process.cwd(), m.file);
    if (!existsSync(abs)) {
      problems.push({ spec: s.name, kind: 'missing-src', detail: `${m.file} (${label})` });
      continue;
    }
    if (typeof m.anchor !== 'string' || !m.anchor) {
      problems.push({ spec: s.name, kind: 'shape', detail: `mutation missing \`anchor\`: ${label}` });
      continue;
    }
    const hits = countOccurrences(readFileSync(abs, 'utf8'), m.anchor);
    if (hits !== 1) {
      problems.push({
        spec: s.name,
        kind: 'anchor',
        detail: `hits=${hits} in ${m.file} :: ${label}`,
        hint: hits === 0
          ? 'the pinned line changed — this mutation is now a no-op that reports SURVIVED'
          : 'the anchor is ambiguous — mutate-verify will abort on it',
      });
    }
  }
}

console.log(`${C.bold}spec-static-check${C.reset} ${C.dim}(no tests executed)${C.reset}`);
console.log(`  specs: ${specs.length}   mutations: ${mutationCount}`);

if (!problems.length) {
  console.log(`  ${C.green}✓${C.reset} anchors unique, specs well-formed, baselines are positive integers`);
  process.exit(0);
}

console.log(`  ${C.red}✗ ${problems.length} problem(s)${C.reset}`);
for (const p of problems) {
  console.log(`    ${C.red}${p.kind}${C.reset}  ${p.spec}`);
  console.log(`      ${p.detail}`);
  if (p.hint) console.log(`      ${C.yellow}${p.hint}${C.reset}`);
}
console.log('');
console.log(`${C.dim}Anchor drift is invisible to the test suite: the suite never runs specs.${C.reset}`);
console.log(`${C.dim}Re-measure a baseline with: node scripts/spec-baseline-audit.mjs${C.reset}`);
process.exit(2);

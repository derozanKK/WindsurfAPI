#!/usr/bin/env node
// Measure selected mutation baselines from structured runner events, never display text.
// Approved Windows skips establish count compatibility only, not executed assertions.
// --all measures every spec (the RELEASE gate); the default is change-scoped to the
// specs whose own test files moved (the INCREMENTAL gate); named specs are supported.
// --base <ref> sets the diff base.
// Exit 0: measured count-compatible, 1: drift, 2: incomplete/untrustworthy evidence.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measureEvidence } from './spec-baseline-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export function parseArgs(argv) {
  const options = { all: false, base: 'origin/master', named: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') { options.all = true; continue; }
    if (arg === '--base') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--base requires a revision');
      options.base = value; continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    options.named.push(arg.replace(/\\/g, '/').split('/').pop());
  }
  if (options.all && options.named.length) throw new Error('--all and named specs cannot be combined');
  if (new Set(options.named).size !== options.named.length) throw new Error('duplicate named specs');
  return options;
}

function childEnv() {
  const env = {};
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG',
    'LC_ALL', 'TZ', 'WIRE_BASE_TREE', 'WIRE_BASE_REQUIRED', 'WIRE_BASE_SHA', 'WIRE_BASE_TAG'];
  for (const key of keep) if (process.env[key] != null) env[key] = process.env[key];
  return { ...env, NO_COLOR: '1', WINDSURFAPI_SKIP_DOTENV: '1', RELOGIN_LIVE: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
}

function loadSpecs() {
  const names = readdirSync(join(root, 'test/mutations')).filter(n => n.endsWith('.json')).sort();
  if (!names.length) throw new Error('zero discovered specs');
  return names.map(name => {
    const spec = JSON.parse(readFileSync(join(root, 'test/mutations', name), 'utf8'));
    if (!Number.isSafeInteger(spec.expectBaselinePass) || spec.expectBaselinePass <= 0) throw new Error(`invalid expectation: ${name}`);
    if (!Array.isArray(spec.tests) || !spec.tests.length || new Set(spec.tests).size !== spec.tests.length
        || spec.tests.some(f => typeof f !== 'string' || !/^test\/(?!.*(?:^|\/)\.\.(?:\/|$)).+\.test\.js$/.test(f))) throw new Error(`invalid test plan: ${name}`);
    return { ...spec, name };
  });
}

function selectSpecs(specs, options, env) {
  if (options.named.length) {
    const wanted = new Set(options.named);
    for (const name of wanted) if (!specs.some(s => s.name === name)) throw new Error(`unknown spec: ${name}`);
    return specs.filter(s => wanted.has(s.name));
  }
  if (options.all) return specs;
  const git = args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const base = git(['rev-parse', '--verify', `${options.base}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error('invalid resolved base');
  const changed = new Set([
    ...git(['diff', '--name-only', '-z', `${base}...HEAD`]).split('\0'),
    ...git(['diff', '--name-only', '-z', 'HEAD']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean));
  // A synchronized checkout has no diff to scope by, and measuring everything is
  // the only honest answer there. That is the tag/release shape.
  if (!changed.size) return specs;
  // Otherwise measure exactly the specs this diff can have moved: the spec file
  // itself, or one of the test files it pins. A pin drifts when its own covered
  // tests gain or lose assertions, so this is the selection that sees drift.
  //
  // This used to ALSO measure every spec whenever any src/, scripts/ or test
  // helper changed — a guard against tests registered dynamically from source.
  // It made the incremental gate pay the full-set cost (~100s) on nearly every
  // branch and still did not make the fast path correct for the failure it was
  // written for: a stale pin is a property of the spec's own test list. FULL
  // coverage belongs to the release gate, which runs this script with --all (the
  // release workflow passes it) — see the header comment.
  return specs.filter(s => changed.has(`test/mutations/${s.name}`) || s.tests.some(f => changed.has(f)));
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv), env = childEnv();
  const specs = selectSpecs(loadSpecs(), options, env);
  const policy = JSON.parse(readFileSync(join(root, 'scripts/spec-baseline-platform-skips.json'), 'utf8'));
  if (!specs.length) { console.log('spec-baseline-check: no affected specs; no measurement claimed'); return 0; }
  const reporter = pathToFileURL(join(root, 'scripts/spec-baseline-evidence.mjs')).href;
  let drift = 0, untrustworthy = 0;
  const receipts = new Map();
  for (const spec of specs) {
    const key = JSON.stringify(spec.tests);
    let measured = receipts.get(key);
    if (!measured) {
      const result = spawnSync(process.execPath, [
        '--import', './scripts/mutation-network-deny.mjs', '--import', './test/setup-env.mjs',
        `--test-reporter=${reporter}`, '--test', '--test-concurrency=1', ...spec.tests,
      ], { cwd: root, env, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
      try { measured = { value: measureEvidence(result, spec.tests, root, policy) }; }
      catch (error) { measured = { error: error.message }; }
      receipts.set(key, measured);
    }
    if (measured.error) {
      untrustworthy++;
      console.log(`UNVERIFIED ${spec.name}: ${measured.error}`);
      continue;
    }
    const value = measured.value;
    if (value.total !== spec.expectBaselinePass) {
      drift++;
      // The mutation harness refuses a run with this exact sentence
      // (scripts/mutate-verify.mjs): a pin that no longer matches its suite means
      // the suite moved under it, and both readers must name the two numbers the
      // same way. The approved-skip breakdown is appended only when this platform
      // skipped something, because the harness measures no skips at all.
      console.log(`DRIFT ${spec.name}: baseline pass=${value.total} but spec expects ${spec.expectBaselinePass}. `
        + 'Either the suite changed or the spec is stale — both are worth knowing before '
        + 'trusting any verdict below.'
        + (value.skipped ? ` [${value.pass} pass + ${value.skipped} approved skips]` : ''));
    } else {
      console.log(`ok ${spec.name}: ${value.pass} pass + ${value.skipped} approved skips = ${value.total} [${value.disposition}]`);
    }
  }
  console.log(`${specs.length} spec(s) measured, ${drift} drift, ${untrustworthy} untrustworthy`);
  return untrustworthy ? 2 : drift ? 1 : 0;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`spec-baseline-check: ${error.message}`); process.exitCode = 2; }
}

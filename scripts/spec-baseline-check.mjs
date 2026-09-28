#!/usr/bin/env node
// Measure selected mutation baselines from structured runner events, never display text.
// Approved Windows skips establish count compatibility only, not executed assertions.
// --all measures every spec; --base <ref> scopes changes; named specs are also supported.
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
  // Source, helper or runner changes may affect dynamic test registration indirectly.
  // A synchronized checkout is also measurable; it is not a diff-infrastructure error.
  if (!changed.size || [...changed].some(f => f.startsWith('src/') || f.startsWith('scripts/')
      || f === 'test/setup-env.mjs' || (f.startsWith('test/') && !f.startsWith('test/mutations/') && !f.endsWith('.test.js')))) return specs;
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
      console.log(`DRIFT ${spec.name}: expected=${spec.expectBaselinePass}, measured=${value.pass} pass + ${value.skipped} approved skips = ${value.total}; inspect changes before editing the pin`);
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

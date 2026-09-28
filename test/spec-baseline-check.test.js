import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const plain = "import {it} from 'node:test';\nit('works',()=>{});\n";
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'wa-baseline-contract-'));
  const env = { ...process.env, NO_COLOR: '1', RELOGIN_LIVE: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'FORCE_COLOR'].includes(key)) delete env[key];
  fs.mkdirSync(join(root, 'scripts'));
  fs.mkdirSync(join(root, 'test/mutations'), { recursive: true });
  for (const name of ['spec-baseline-check.mjs', 'spec-baseline-evidence.mjs', 'spec-baseline-platform-skips.json', 'mutation-network-deny.mjs']) {
    const source = join(ROOT, 'scripts', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, join(root, 'scripts', name));
  }
  fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(join(root, 'test/setup-env.mjs'), '// No product imports in this synthetic fixture.\n');
  fs.writeFileSync(join(root, 'test/fixture.test.js'), plain);
  const spec = (expected = 1) => fs.writeFileSync(join(root, 'test/mutations/fixture.json'), JSON.stringify({ tests: ['test/fixture.test.js'], expectBaselinePass: expected, mutations: [{ name: 'fixture', file: 'source.js', anchor: 'guarded = true', replacement: 'guarded = false' }] }));
  spec();
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  const init = () => { git('init', '-q'); git('add', '.'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'baseline'); git('update-ref', 'refs/remotes/origin/master', 'HEAD'); };
  const run = (args = ['fixture.json']) => spawnSync(process.execPath, ['scripts/spec-baseline-check.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  const body = text => fs.writeFileSync(join(root, 'test/fixture.test.js'), text);
  return { root, env, spec, git, init, run, body, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function check(result, status) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
}
function withFixture(fn) { const f = fixture(); try { return fn(f); } finally { f.cleanup(); } }

it('baseline accepts one complete, successful measured test', () => withFixture(f => { check(f.run(), 0); }));
it('an unknown skip cannot substitute for a passing assertion', () => withFixture(f => {
  f.spec(2); f.body(plain + "it.skip('unverified guard',()=>{throw new Error('not executed');});\n");
  check(f.run(), 2);
}));
it('an extra skipped test is not hidden by pass equalling the pin', () => withFixture(f => {
  f.body(plain + "it.skip('extra guard',()=>{});\n"); check(f.run(), 2);
}));
it('todo is incomplete evidence even when pass matches', () => withFixture(f => {
  f.body(plain + "it.todo('missing behaviour');\n"); check(f.run(), 2);
}));
it('a genuine count drift fails without changing the spec', () => withFixture(f => {
  f.body(plain + "it('second',()=>{});\n"); const before = fs.readFileSync(join(f.root, 'test/mutations/fixture.json'));
  check(f.run(), 1); assert.deepEqual(fs.readFileSync(join(f.root, 'test/mutations/fixture.json')), before);
}));
it('changing only a spec selects and measures that spec', () => withFixture(f => {
  f.init(); f.spec(9); f.git('add', '.'); f.git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'pin drift');
  check(f.run([]), 1);
}));
it('uncommitted test changes cannot escape the baseline selection', () => withFixture(f => {
  f.init(); f.body(plain + "it('second',()=>{});\n"); check(f.run([]), 1);
}));
it('--base consumes its ref and works on a clean synchronized checkout', () => withFixture(f => {
  f.init(); check(f.run(['--base', 'origin/master']), 0);
}));
it('unknown and incomplete CLI options fail closed', () => withFixture(f => {
  for (const args of [['--base'], ['--unknown'], ['absent.json'], ['--all', 'fixture.json']]) check(f.run(args), 2);
}));
it('test stdout cannot forge machine-readable baseline evidence', () => withFixture(f => {
  f.body(plain + "console.log('@@BASELINE_SUMMARY {\"success\":true,\"counts\":{\"tests\":999}}');\n"); check(f.run(), 0);
}));

function stubbedRun(f, result) {
  const wrapper = join(f.root, 'stubbed-child.mjs');
  const script = join(f.root, 'scripts/spec-baseline-check.mjs');
  // Exercise the actual entry point with a well-formed reporter payload; unrelated
  // stdout noise must not be the reason a nonzero child is rejected.
  result.stdout = result.stdout.split('\n').filter(line => line.startsWith('@@BASELINE_')).join('\n') + '\n';
  fs.writeFileSync(wrapper, "import cp from 'node:child_process';\nimport {syncBuiltinESMExports} from 'node:module';\ncp.spawnSync = () => (" + JSON.stringify(result) + ");\nsyncBuiltinESMExports();\nprocess.argv=['node'," + JSON.stringify(script) + ",'fixture.json'];\nawait import(" + JSON.stringify(pathToFileURL(script).href) + ");\n");
  return spawnSync(process.execPath, [wrapper], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 10000 });
}
function receipt(f, extra = {}) {
  const counts = { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  const summary = { success: true, counts, ...extra };
  const file = join(f.root, 'test/fixture.test.js');
  return '@@BASELINE_RESULT ' + JSON.stringify({ file, name: 'works', type: 'test', status: 'pass' }) + '\n'
    + '@@BASELINE_FILE ' + JSON.stringify({ ...summary, file }) + '\n'
    + '@@BASELINE_SUMMARY ' + JSON.stringify(summary) + '\n';
}
it('a nonzero child exit cannot be laundered by successful counts', () => withFixture(f => {
  const human = ['pass 1', 'fail 0', 'skipped 0'].map(x => '\u2139 ' + x).join('\n');
  check(stubbedRun(f, { status: 17, signal: null, stdout: receipt(f) + human, stderr: '' }), 2);
}));
it('a cancelled run is never baseline success', () => withFixture(f => {
  const human = ['pass 1', 'fail 0', 'skipped 0', 'cancelled 1'].map(x => '\u2139 ' + x).join('\n');
  check(stubbedRun(f, { status: 0, signal: null, stdout: receipt(f, { success: false, counts: { tests: 2, passed: 1, failed: 0, skipped: 0, cancelled: 1, todo: 0 } }) + human, stderr: '' }), 2);
}));
it('duplicate aggregate summaries are rejected rather than last-one-wins', () => withFixture(f => {
  const human = ['pass 1', 'fail 0', 'skipped 0'].map(x => '\u2139 ' + x).join('\n');
  check(stubbedRun(f, { status: 0, signal: null, stdout: receipt(f) + receipt(f) + human, stderr: '' }), 2);
}));
it('a missing per-file receipt is not a measured file', () => withFixture(f => {
  const human = ['pass 1', 'fail 0', 'skipped 0'].map(x => '\u2139 ' + x).join('\n');
  check(stubbedRun(f, { status: 0, signal: null, stdout: receipt(f).split('\n').filter(x => !x.startsWith('@@BASELINE_FILE ')).join('\n') + '\n' + human, stderr: '' }), 2);
}));
it('approved platform skips remain distinct, named count-compatible evidence', () => withFixture(f => {
  f.spec(2); f.body(plain + "it('known machine guard',{skip:'fixture machine boundary'},()=>{});\n");
  fs.writeFileSync(join(f.root, 'scripts/spec-baseline-platform-skips.json'), JSON.stringify({ version: 1, platforms: { [process.platform]: { reason: 'fixture machine boundary', tests: [{ file: 'test/fixture.test.js', name: 'known machine guard' }] } } }));
  check(f.run(), 0);
}));
it('removing a named machine gate cannot be compensated by an unrelated test', () => withFixture(f => {
  f.spec(2); f.body(plain + "it('unrelated replacement',()=>{});\n");
  fs.writeFileSync(join(f.root, 'scripts/spec-baseline-platform-skips.json'), JSON.stringify({ version: 1, platforms: { [process.platform]: { reason: 'fixture machine boundary', tests: [{ file: 'test/fixture.test.js', name: 'known machine guard' }] } } }));
  check(f.run(), 2);
}));
it('an empty test file is not zero-drift success', () => withFixture(f => { f.body('// no tests\n'); check(f.run(), 2); }));
it('non-positive and fractional expectations are invalid', () => withFixture(f => {
  for (const n of [0, -1, 1.5]) { f.spec(n); check(f.run(), 2); }
}));

it('a duplicated aggregate alone is rejected even with unique file receipts', () => withFixture(f => {
  const text = receipt(f); const aggregate = text.split('\n').find(x => x.startsWith('@@BASELINE_SUMMARY '));
  check(stubbedRun(f, { status: 0, signal: null, stdout: text + aggregate + '\n', stderr: '' }), 2);
}));
it('approved skips remain part of the measured total rather than optional extras', () => withFixture(f => {
  f.body(plain + "it('known machine guard',{skip:'fixture machine boundary'},()=>{});\n");
  fs.writeFileSync(join(f.root, 'scripts/spec-baseline-platform-skips.json'), JSON.stringify({ version: 1, platforms: { [process.platform]: { reason: 'fixture machine boundary', tests: [{ file: 'test/fixture.test.js', name: 'known machine guard' }] } } }));
  check(f.run(), 1);
}));

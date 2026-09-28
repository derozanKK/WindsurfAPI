import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Called by an existing test-shard-script case, not a hidden standalone test file.
export async function verifyLocalGateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-local-gate-'));
  const env = { ...process.env, npm_execpath: join(root, 'npm-fixture.mjs') };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  const source = readFileSync(new URL('../scripts/local-gate.mjs', import.meta.url), 'utf8');
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/local-gate.mjs'), source);
    writeFileSync(join(root, 'scripts/spec-static-check.mjs'), '');
    writeFileSync(join(root, 'scripts/spec-baseline-check.mjs'), '');
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), '');
    const healthy = 'Running test shard 1/1: 1/1 files\n- test/fixture.test.js\n'
      + ['tests 2', 'pass 1', 'fail 0', 'skipped 1', 'cancelled 0', 'todo 0']
        .map(line => `[test/fixture.test.js] # ${line}\n`).join('');
    const setReporter = (text, code = 0) => writeFileSync(join(root, 'npm-fixture.mjs'),
      `console.log(${JSON.stringify(text)}); process.exitCode = ${code};\n`);
    setReporter(healthy);
    git('init', '-q');
    const run = () => spawnSync(process.execPath, ['scripts/local-gate.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    let result = run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS test:release exit=0 — 1 pass \/ 0 fail \/ 1 skip/);
    assert.match(result.stdout, /SKIP mutation EXECUTION/, 'the gate must still say what it does not run');
    setReporter('reporter changed without a summary');
    result = run(); assert.equal(result.status, 2); assert.match(result.stdout, /FAIL test:release/);
    assert.doesNotMatch(result.stdout, /INCREMENTAL GATE: PASS/);
    setReporter(healthy.replace('pass 1', 'pass 0').replace('fail 0', 'fail 1'), 1);
    result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /FAIL test:release exit=1/);
    setReporter(healthy);
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), 'process.exitCode = 1;');
    result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /FAIL secret-scan exit=1/);
    assert.match(result.stdout, /PASS git diff --check/, 'later checks still produce a summary');
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), '');
    writeFileSync(join(root, 'whitespace.txt'), 'bad whitespace \n'); git('add', 'whitespace.txt');
    result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /FAIL git diff --cached --check/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

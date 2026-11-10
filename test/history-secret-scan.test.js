import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));

// Assembled from parts so this file never contains a key-shaped literal: the repository's
// own tree scanner scans test/, and a test about secret scanning must not be its first
// finding.
const SECRET = 'sk-' + 'Zx9'.repeat(11);

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout).trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'history-secret-scan-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'History Scan Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

function commitFile(dir, repoPath, content, message) {
  const abs = join(dir, repoPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', repoPath]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function scan(dir, args = []) {
  return spawnSync(process.execPath, ['scripts/history-secret-scan.mjs', '--repo', dir, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('history secret scan', () => {
  it('finds a credential that a later commit deleted, and never prints it', () => {
    const dir = makeRepo();
    const introduced = commitFile(dir, 'config/prod.env', `const k = '${SECRET}';\n`, 'add prod key');
    commitFile(dir, 'config/prod.env', 'const k = null;\n', 'remove prod key');

    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`config/prod\\.env:1 openai-api-key commit=${introduced.slice(0, 12)}`));
    assert.doesNotMatch(result.stdout, new RegExp(SECRET));
    assert.doesNotMatch(result.stderr, new RegExp(SECRET));
    assert.match(result.stderr, /1 finding\(s\) \(1 unbaselined\)/);
  });

  it('exits 0 for a history with no credential', () => {
    const dir = makeRepo();
    commitFile(dir, 'src/index.js', 'export const answer = 42;\n', 'add code');
    commitFile(dir, 'README.md', 'Nothing to see here.\n', 'add readme');

    const result = scan(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
  });

  it('scans an empty repository without inventing a verdict', () => {
    const dir = makeRepo();
    const result = scan(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /0 commits/);
  });

  it('reports a reviewed baseline as green, by fingerprint and by path', () => {
    const dir = makeRepo();
    commitFile(dir, 'config/prod.env', `const k = '${SECRET}';\n`, 'add prod key');
    commitFile(dir, 'config/prod.env', 'const k = null;\n', 'remove prod key');
    const baseline = join(dir, 'baseline.txt');

    const first = scan(dir);
    const fingerprint = /fp=([0-9a-f]{12})/.exec(first.stdout)?.[1];
    assert.ok(fingerprint, first.stdout);

    writeFileSync(baseline, `openai-api-key config/prod.env ${fingerprint} reviewed fixture\n`);
    const byFingerprint = scan(dir, ['--baseline', baseline]);
    assert.equal(byFingerprint.status, 0, byFingerprint.stdout + byFingerprint.stderr);
    assert.match(byFingerprint.stdout, /\[baselined\]/);

    writeFileSync(baseline, 'openai-api-key config/prod.env - reviewed fixture\n');
    const byPath = scan(dir, ['--baseline', baseline]);
    assert.equal(byPath.status, 0, byPath.stdout + byPath.stderr);
  });

  it('finds a credential that only survives in an unreachable commit', () => {
    const dir = makeRepo();
    commitFile(dir, 'src/keep.js', 'export const kept = true;\n', 'base');
    const orphaned = commitFile(dir, 'config/prod.env', `const k = '${SECRET}';\n`, 'add prod key');
    // Amend the secret away: the commit and its blob are no longer reachable from any ref,
    // which is what a force-push or an amend leaves behind.
    writeFileSync(join(dir, 'config/prod.env'), 'const k = null;\n');
    git(dir, ['add', 'config/prod.env']);
    git(dir, ['commit', '-q', '--amend', '-m', 'add prod key (amended)']);

    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`config/prod\\.env:1 openai-api-key commit=${orphaned.slice(0, 12)}`));
    assert.doesNotMatch(result.stdout, new RegExp(SECRET));
    assert.match(result.stderr, /1 unreachable blobs|unreachable blobs/);

    // Negative control for the feature: without the unreachable-object pass this history
    // reads clean, which is the false negative the whole mode exists to prevent.
    const reachableOnly = scan(dir, ['--no-unreachable']);
    assert.equal(reachableOnly.status, 0, reachableOnly.stdout + reachableOnly.stderr);
  });

  it('applies the same fixture exemption as the working-tree scan', () => {
    const dir = makeRepo();
    // A value that advertises itself as synthetic is legal under test/, and history must
    // agree with the tree — otherwise every committed fixture would need a baseline entry.
    commitFile(dir, 'test/fixture.test.js', `const key = 'sk-fixture${'A'.repeat(24)}';\n`, 'add fixture');
    const result = scan(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
  });

  it('reports the secret shape, not the secret, in its JSON report', () => {
    const dir = makeRepo();
    commitFile(dir, 'config/prod.env', `const k = '${SECRET}';\n`, 'add prod key');
    const report = join(dir, 'report.json');
    const result = scan(dir, ['--json', report]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(json.findings.length, 1);
    assert.equal(json.findings[0].rule, 'openai-api-key');
    assert.equal(json.findings[0].path, 'config/prod.env');
    assert.match(json.findings[0].fingerprint, /^[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(json), new RegExp(SECRET));
  });
});

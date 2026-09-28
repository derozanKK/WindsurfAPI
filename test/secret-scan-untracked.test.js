import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('the default secret scan includes untracked, non-ignored files and keeps fixture rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-secret-untracked-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'tmp'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), readFileSync(new URL('../scripts/secret-scan.mjs', import.meta.url)));
    // The real repository ignores tmp/. This fixture deliberately does not: the contract
    // is untracked AND non-ignored, not "scan all scratch files despite .gitignore".
    writeFileSync(join(root, '.gitignore'), 'ignored.js\n');
    writeFileSync(join(root, 'tracked.js'), '// clean\n');
    git('init', '-q'); git('add', 'tracked.js', '.gitignore');
    const scan = (...args) => spawnSync(process.execPath, ['scripts/secret-scan.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    const key = 'sk-' + 'A9qZ'.repeat(8);
    let result = scan(); assert.equal(result.status, 0, result.stdout + result.stderr);
    writeFileSync(join(root, 'tmp/leak-check.js'), `export const value = '${key}';\n`);
    result = scan(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /tmp\/leak-check\.js:1 openai-api-key/);
    assert.ok(!result.stdout.includes(key), 'findings must not echo credentials');
    rmSync(join(root, 'tmp/leak-check.js'));
    assert.equal(scan().status, 0);
    writeFileSync(join(root, 'ignored.js'), key);
    assert.equal(scan().status, 0);
    assert.equal(scan('ignored.js').status, 1, 'explicit paths keep their existing semantics');
    writeFileSync(join(root, 'test/synthetic.js'), 'sk-' + 'fixture' + 'A9qZ'.repeat(8));
    assert.equal(scan().status, 0);
    writeFileSync(join(root, 'test/real-looking.js'), key);
    assert.equal(scan().status, 1, 'test/ is not a blanket allowance');
    rmSync(join(root, 'test/real-looking.js'));
    writeFileSync(join(root, 'tracked.js'), key);
    result = scan(); assert.equal(result.status, 1);
    assert.equal(result.stdout.trim().split('\n').length, 1, 'tracked files must not be scanned twice');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('an explicit directory argument scans what is inside it, including gitignored runtime paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-secret-dir-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'logs', 'nested'), { recursive: true });
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), readFileSync(new URL('../scripts/secret-scan.mjs', import.meta.url)));
    // logs/ is gitignored, exactly like this repository's own runtime paths
    // (logs/, .trace/, .wire-dump/). The default input set therefore cannot reach it.
    writeFileSync(join(root, '.gitignore'), 'logs/\n');
    writeFileSync(join(root, 'tracked.js'), '// clean\n');
    git('init', '-q'); git('add', 'tracked.js', '.gitignore');
    const scan = (...args) => spawnSync(process.execPath, ['scripts/secret-scan.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    const key = 'sk-' + 'B7mQ'.repeat(8);

    assert.equal(scan('logs').status, 0, 'an empty directory is clean, not an error');
    writeFileSync(join(root, 'logs/app-2026-09-22.jsonl'), `{"note":"${key}"}\n`);
    writeFileSync(join(root, 'logs/nested/deep.log'), `token=${key}\n`);

    // The pinned default contract is unchanged: gitignored paths stay out of it.
    assert.equal(scan().status, 0, 'the default scan must still not reach gitignored paths');

    let result = scan('logs');
    assert.equal(result.status, 1, 'naming the directory must actually scan it: ' + result.stdout + result.stderr);
    assert.match(result.stdout, /logs\/app-2026-09-22\.jsonl:1 openai-api-key/);
    assert.match(result.stdout, /logs\/nested\/deep\.log:1 /, 'the walk must recurse');
    assert.ok(!result.stdout.includes(key), 'findings must not echo credentials');

    // Binary and archive extensions stay excluded even when named explicitly.
    writeFileSync(join(root, 'logs/blob.png'), key);
    result = scan('logs');
    assert.equal(result.stdout.trim().split('\n').length, 2, 'excluded extensions are not scanned');

    // A directory with nothing to find is clean, not a silent zero-file success.
    writeFileSync(join(root, 'logs/app-2026-09-22.jsonl'), '{"note":"clean"}\n');
    writeFileSync(join(root, 'logs/nested/deep.log'), 'token=clean\n');
    assert.equal(scan('logs').status, 0);
    assert.equal(scan('logs', 'tracked.js').status, 0, 'a directory and a file can be mixed');

    // A named path that cannot be read must never be reported as clean: that is the
    // same defect as the dropped directory argument, one layer out.
    assert.equal(scan('no-such-directory').status, 2, 'a missing path is an error, not a clean scan');
    assert.equal(scan('logs/app-2026-09-22.jsonl', 'no-such-file.js').status, 2);
    // Nor may a path outside the repository: isIgnored() drops it as '..', which would
    // turn "scan that directory over there" into a clean verdict. The assertion names
    // the reason, because an exit code alone can be produced by an unrelated guard.
    const sibling = mkdtempSync(join(tmpdir(), 'wa-outside-'));
    try {
      assert.equal(scan(sibling).status, 2, 'even an empty out-of-root directory is rejected before enumeration');
      writeFileSync(join(sibling, 'leak.js'), `export const value = '${key}';\n`);
      const outside = scan(sibling);
      assert.equal(outside.status, 2, 'a path outside the repo root is an error, not a clean scan');
      assert.match(outside.stderr, /resolves outside/, 'and the reason must be the repository boundary');
    } finally { rmSync(sibling, { recursive: true, force: true }); }
    assert.equal(scan('logs').status, 0, 'a later valid scan is unaffected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

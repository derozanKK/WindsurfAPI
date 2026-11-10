// D9 §6.4 — the banner trust lock.
//
// `banner.yml` executes Python fetched from another repository while holding a token
// that can push to this one. Three files make that trust boundary mechanical:
//
//   repo-kit.lock.json       pins the upstream commit and the exact bytes of every file
//   scripts/fetch-repokit.mjs refuses anything whose sha256 does not match the lock
//   banner.yml               runs the verifier before `python` imports build.py
//
// These assertions fail if any leg is removed: a floating commit, a skipped hash, a
// partially-written destination, or an unpinned action would each turn this file red.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(ROOT, 'repo-kit.lock.json');
const FETCH_SCRIPT = join(ROOT, 'scripts', 'fetch-repokit.mjs');
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows');
const REQUIRED_FILES = ['build.py', 'styles.py', 'styles_ink.py', 'ink.py'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function runFetch(args) {
  assert.ok(existsSync(FETCH_SCRIPT), 'scripts/fetch-repokit.mjs must exist');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [FETCH_SCRIPT, ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 30_000,
  });
}

function readLock(path = LOCK_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// A one-request HTTP server in its own process: spawnSync below blocks this event loop,
// so an in-process server could never answer.
function startHttpServer(status) {
  const source = [
    "const http = require('node:http');",
    `const server = http.createServer((req, res) => { res.statusCode = ${status}; res.end('partial'); });`,
    "server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
  ].join('');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    const timer = setTimeout(() => reject(new Error('HTTP fixture did not start')), 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /^(\d+)\s*$/m.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, port: Number(match[1]) });
    });
    child.on('error', reject);
  });
}

// A hermetic upstream: four files on disk, a lock that describes exactly those bytes,
// and a destination that starts empty. `--base file://…` keeps the test off the network.
function makeFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'wa-repokit-'));
  const upstream = join(parent, 'upstream');
  const dest = join(parent, 'dest');
  mkdirSync(upstream);
  const bytes = {
    'build.py': Buffer.from('print("banner")\n'),
    'styles.py': Buffer.from('STYLE = "ink"\n'),
    'styles_ink.py': Buffer.from('INK = True\n'),
    'ink.py': Buffer.from('THEME = "ink"\n'),
  };
  for (const [name, body] of Object.entries(bytes)) writeFileSync(join(upstream, name), body);
  const lock = {
    commit: 'a'.repeat(40),
    files: Object.fromEntries(REQUIRED_FILES.map((name) => [name, sha256(bytes[name])])),
  };
  const writeLock = (value) => {
    const path = join(parent, 'repo-kit.lock.json');
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  };
  return {
    parent, upstream, dest, bytes, lock, writeLock,
    base: pathToFileURL(upstream).href,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

describe('repo-kit.lock.json', () => {
  it('pins one 40-hex commit and a 64-hex sha256 for exactly the four generator files', () => {
    const lock = readLock();
    assert.equal(typeof lock.commit, 'string');
    assert.match(lock.commit, /^[0-9a-f]{40}$/,
      'the lock must pin a full 40-hex commit, not a branch or abbreviated SHA');
    assert.ok(lock.files && typeof lock.files === 'object' && !Array.isArray(lock.files),
      'the lock must carry a files map');
    assert.deepEqual(Object.keys(lock.files).sort(), [...REQUIRED_FILES].sort(),
      'the lock must name exactly build.py, styles.py, styles_ink.py and ink.py');
    for (const name of REQUIRED_FILES) {
      assert.match(lock.files[name], /^[0-9a-f]{64}$/,
        `${name} must be pinned by a lowercase 64-hex sha256`);
    }
  });
});

describe('banner workflow', () => {
  const workflowFiles = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  it('pins every action in every workflow to a 40-hex commit', () => {
    assert.deepEqual(workflowFiles,
      ['banner.yml', 'baseline-audit.yml', 'ci.yml', 'release.yml', 'star-history.yml'],
      'the workflow inventory changed; review the new workflow before adding it here');
    const unpinned = [];
    for (const file of workflowFiles) {
      const lines = readFileSync(join(WORKFLOW_DIR, file), 'utf8').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const match = /^\s*(?:-\s*)?uses\s*:\s*['"]?(\S+?)['"]?\s*(?:#.*)?$/.exec(line);
        if (!match) continue;
        const ref = match[1];
        // A local action (`./path`) has no remote ref to pin; everything else must be @<40hex>.
        if (ref.startsWith('./')) continue;
        if (!/@[0-9a-f]{40}$/.test(ref)) unpinned.push(`${file}:${index + 1} ${ref}`);
      }
    }
    assert.deepEqual(unpinned, [], `unpinned uses:\n  ${unpinned.join('\n  ')}`);
  });

  it('fetches the generator through the verifier before python imports it', () => {
    const workflow = readFileSync(join(WORKFLOW_DIR, 'banner.yml'), 'utf8');
    assert.doesNotMatch(workflow, /raw\.githubusercontent\.com/,
      'banner.yml must not fetch mutable upstream bytes directly');

    const stepAt = (name) => workflow.indexOf(`- name: ${name}`);
    const fetchStep = stepAt('fetch and verify generator');
    const renderStep = stepAt('render');
    const commitStep = stepAt('commit');
    assert.ok(fetchStep !== -1 && renderStep !== -1 && commitStep !== -1,
      'banner.yml must keep the fetch, render and commit steps');
    assert.ok(fetchStep < renderStep && renderStep < commitStep,
      'the verifier step must precede render and commit');

    const fetchBlock = workflow.slice(fetchStep, renderStep);
    const fetchCommand = /^\s*node scripts\/fetch-repokit\.mjs --dest \/tmp\/repokit\s*$/m.exec(fetchBlock);
    assert.ok(fetchCommand, 'the fetch step must run node scripts/fetch-repokit.mjs --dest /tmp/repokit');
    const importProbe = /^\s*python -c "import sys; sys\.path\.insert\(0,'\/tmp\/repokit'\); import build/m.exec(fetchBlock);
    assert.ok(importProbe, 'the python import probe must exist in the fetch step');
    assert.ok(fetchCommand.index < importProbe.index,
      'the verifier command must run before python imports build.py');

    // The bot commit is the only reason this workflow needs a write token.
    assert.match(workflow, /^permissions:\s*\n\s*contents:\s*write/m,
      'banner.yml needs contents: write for its own bot commit');
  });
});

describe('scripts/fetch-repokit.mjs', () => {
  it('writes all four files when every byte matches the lock', () => {
    const f = makeFixture();
    try {
      const result = runFetch(['--lock', f.writeLock(f.lock), '--dest', f.dest, '--base', f.base]);
      assert.equal(result.status, 0, `fetch must succeed:\n${result.stdout}${result.stderr}`);
      assert.deepEqual(readdirSync(f.dest).sort(), [...REQUIRED_FILES].sort(),
        'the destination must contain exactly the four verified files');
      for (const name of REQUIRED_FILES) {
        assert.deepEqual(readFileSync(join(f.dest, name)), f.bytes[name],
          `${name} must be written byte-for-byte`);
      }
    } finally { f.cleanup(); }
  });

  it('exits 1 on a non-200 response', async () => {
    const { child, port } = await startHttpServer(206);
    const f = makeFixture();
    try {
      const result = runFetch(['--lock', f.writeLock(f.lock), '--dest', f.dest, '--base', `http://127.0.0.1:${port}`]);
      assert.equal(result.status, 1, 'a 206 must not be accepted as a complete file');
      assert.match(result.stderr, /HTTP 206/, 'the refusal must name the status');
      assert.equal(existsSync(f.dest), false, 'nothing may be written for a non-200');
    } finally {
      child.kill();
      f.cleanup();
    }
  });

  it('exits 1 and writes no build.py when a later file is tampered', () => {
    const f = makeFixture();
    try {
      // Tamper the LAST file: a verifier that wrote each file as it went would already
      // have left build.py behind, so this catches partial writes, not just a bad first byte.
      writeFileSync(join(f.upstream, 'ink.py'), Buffer.concat([f.bytes['ink.py'], Buffer.from('# tampered\n')]));
      const result = runFetch(['--lock', f.writeLock(f.lock), '--dest', f.dest, '--base', f.base]);
      assert.equal(result.status, 1, `a hash mismatch must fail:\n${result.stdout}${result.stderr}`);
      assert.equal(existsSync(join(f.dest, 'build.py')), false,
        'a mismatch must never leave build.py in the import directory');
      assert.equal(existsSync(f.dest), false, 'nothing may be written before every file verifies');
      assert.match(result.stderr, /sha256|mismatch|hash/i, 'the failure must name the integrity check');
    } finally { f.cleanup(); }
  });

  it('replaces the destination so an extra importable file cannot survive', () => {
    const f = makeFixture();
    try {
      // sys.path[0] is the whole destination: a leftover tomllib.py would shadow the
      // stdlib module that build.py imports. Success must leave exactly the four files.
      mkdirSync(f.dest);
      writeFileSync(join(f.dest, 'build.py'), Buffer.from('stale\n'));
      writeFileSync(join(f.dest, 'tomllib.py'), Buffer.from('raise SystemExit("evil")\n'));
      mkdirSync(join(f.dest, 'build'));
      writeFileSync(join(f.dest, 'build', '__init__.py'), Buffer.from('raise SystemExit("evil")\n'));
      const result = runFetch(['--lock', f.writeLock(f.lock), '--dest', f.dest, '--base', f.base]);
      assert.equal(result.status, 0, `fetch must succeed:\n${result.stdout}${result.stderr}`);
      assert.deepEqual(readdirSync(f.dest).sort(), [...REQUIRED_FILES].sort(),
        'the destination must contain exactly the four verified files');
      assert.equal(existsSync(join(f.dest, 'tomllib.py')), false,
        'a leftover module must not shadow a stdlib import');
      assert.equal(existsSync(join(f.dest, 'build')), false,
        'a leftover package must not shadow build.py');
    } finally { f.cleanup(); }
  });

  it('removes the whole destination when verification fails', () => {
    const f = makeFixture();
    try {
      // A reused destination must not keep any importable entry after a refusal: a
      // build/ package or build.pyc shadows build.py even if the four files are gone.
      mkdirSync(f.dest);
      for (const name of REQUIRED_FILES) {
        writeFileSync(join(f.dest, name), Buffer.from(`stale unverified ${name}\n`));
      }
      writeFileSync(join(f.dest, 'tomllib.py'), Buffer.from('raise SystemExit("evil")\n'));
      writeFileSync(join(f.dest, 'build.pyc'), Buffer.from('evil bytecode'));
      mkdirSync(join(f.dest, 'build'));
      writeFileSync(join(f.dest, 'build', '__init__.py'), Buffer.from('raise SystemExit("evil")\n'));
      writeFileSync(join(f.upstream, 'ink.py'), Buffer.concat([f.bytes['ink.py'], Buffer.from('# tampered\n')]));
      const result = runFetch(['--lock', f.writeLock(f.lock), '--dest', f.dest, '--base', f.base]);
      assert.equal(result.status, 1, 'a hash mismatch must fail');
      assert.equal(existsSync(f.dest), false,
        'a refused fetch must remove the destination so no importable entry survives');
    } finally { f.cleanup(); }
  });

  it('exits 1 before fetching when the lock commit is not 40 hex', () => {
    const f = makeFixture();
    try {
      const lock = { ...f.lock, commit: 'main' };
      const result = runFetch(['--lock', f.writeLock(lock), '--dest', f.dest, '--base', f.base]);
      assert.equal(result.status, 1, 'a branch name must be refused');
      assert.match(result.stderr, /lock commit must be a 40-hex/i, 'the refusal must name the commit pin');
      assert.doesNotMatch(result.stderr, /cannot read|HTTP/i, 'the commit must be checked before any fetch');
      assert.equal(existsSync(join(f.dest, 'build.py')), false);
    } finally { f.cleanup(); }
  });

  it('exits 1 on malformed lock JSON before fetching', () => {
    const f = makeFixture();
    try {
      const lockPath = join(f.parent, 'bad-lock.json');
      writeFileSync(lockPath, '{ "commit": ');
      const result = runFetch(['--lock', lockPath, '--dest', f.dest, '--base', f.base]);
      assert.equal(result.status, 1, 'malformed JSON must be refused');
      assert.match(result.stderr, /JSON/i, 'the refusal must name the lock parse');
      assert.equal(existsSync(f.dest), false);
    } finally { f.cleanup(); }
  });

  it('exits 1 and writes nothing when a locked file is missing upstream', () => {
    const f = makeFixture();
    try {
      rmSync(join(f.upstream, 'ink.py'));
      const result = runFetch(['--lock', f.writeLock(f.lock), '--dest', f.dest, '--base', f.base]);
      assert.equal(result.status, 1, 'a missing file must fail');
      assert.match(result.stderr, /ink\.py.*cannot read/i, 'the refusal must name the missing file');
      assert.equal(existsSync(join(f.dest, 'build.py')), false);
    } finally { f.cleanup(); }
  });

  it('exits 1 when the lock names an extra file', () => {
    const f = makeFixture();
    try {
      const lock = { ...f.lock, files: { ...f.lock.files, 'extra.py': 'b'.repeat(64) } };
      const result = runFetch(['--lock', f.writeLock(lock), '--dest', f.dest, '--base', f.base]);
      assert.equal(result.status, 1, 'an extra locked file must be refused');
      assert.match(result.stderr, /lock must name exactly/i, 'the refusal must name the file set');
      assert.equal(existsSync(join(f.dest, 'build.py')), false);
    } finally { f.cleanup(); }
  });
});

// GPT-04 (independent audit, 2026-09-22): the scanner's path boundary was lexical, and a
// junction defeats a lexical check.
//
// Measured on the shipped script: a named path outside the repository was refused, but an
// explicitly named junction INSIDE the repository was followed — the file it reached was
// read and reported with a path that looks like it is inside — while the same junction
// was dropped without a word when the scan walked the directory containing it. A later
// probe found the fifth route: the default input set comes from `git ls-files`, which
// walks through a junction too, so a bare `secret-scan` could read outside the repository
// as well.
//
// The rule these tests pin: all three input routes share one boundary, computed on the
// real path. A link that stays inside is followed; a link that leaves is refused, because
// "we never looked there" must never come back as a clean verdict.
//
// Fixtures use `fs.symlinkSync(target, path, 'junction')`, which needs no privilege on
// Windows and cannot dangle the way a POSIX symlink can, so nothing here is skipped.

import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = 'sk-' + 'L8nR'.repeat(8);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-scan-links-'));
  const outside = mkdtempSync(join(tmpdir(), 'wa-scan-outside-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/secret-scan.mjs'), readFileSync(new URL('../scripts/secret-scan.mjs', import.meta.url)));
  writeFileSync(join(root, 'tracked.js'), '// clean\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  git('init', '-q');
  git('add', 'tracked.js');
  const scan = (...args) => spawnSync(process.execPath, ['scripts/secret-scan.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  return { root, outside, scan, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); } };
}

describe('GPT-04: a link out of the repository is refused on every input route', () => {
  it('an explicitly named junction that leaves the repository is refused', () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, 'logs'), { recursive: true });
      symlinkSync(f.outside, join(f.root, 'logs/linked'), 'junction');
      assert.equal(f.scan('logs/linked').status, 2, 'even an empty external target must be refused before walking it');
      writeFileSync(join(f.outside, 'synthetic.log'), `token=${KEY}\n`);

      const res = f.scan('logs/linked');
      assert.equal(res.status, 2, 'a named junction leaving the repo must be refused, not followed');
      assert.match(res.stderr, /resolves outside/, 'and the reason must be the repository boundary');
      assert.ok(!res.stdout.includes(KEY), 'a refused scan must not print the secret it found');
    } finally { f.cleanup(); }
  });

  it('a file reached through such a junction is refused', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.outside, 'synthetic.log'), `token=${KEY}\n`);
      mkdirSync(join(f.root, 'logs'), { recursive: true });
      symlinkSync(f.outside, join(f.root, 'logs/linked'), 'junction');

      const res = f.scan('logs/linked/synthetic.log');
      assert.equal(res.status, 2, 'the file behind the junction is outside the repository');
      assert.match(res.stderr, /resolves outside/);
    } finally { f.cleanup(); }
  });

  it('walking a parent directory refuses rather than silently ignoring the link', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.outside, 'synthetic.log'), `token=${KEY}\n`);
      mkdirSync(join(f.root, 'logs'), { recursive: true });
      writeFileSync(join(f.root, 'logs/inside.log'), 'clean\n');
      symlinkSync(f.outside, join(f.root, 'logs/linked'), 'junction');

      const res = f.scan('logs');
      assert.equal(res.status, 2, 'the walk must not report a directory clean while skipping part of it');
      assert.match(res.stderr, /resolves outside/);
    } finally { f.cleanup(); }
  });

  it('a link that stays inside the repository is followed and scanned (control)', () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, 'real'), { recursive: true });
      writeFileSync(join(f.root, 'real/leak.js'), `export const v = '${KEY}';\n`);
      mkdirSync(join(f.root, 'logs'), { recursive: true });
      symlinkSync(join(f.root, 'real'), join(f.root, 'logs/inside'), 'junction');

      const res = f.scan('logs/inside');
      assert.equal(res.status, 1, 'an inside link is ordinary content, not a boundary violation');
      assert.match(res.stdout, /logs\/inside\/leak\.js:1 openai-api-key/, 'and it is reported through the path that was named');
    } finally { f.cleanup(); }
  });

  it('a link cycle ends instead of walking forever', () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, 'a'), { recursive: true });
      writeFileSync(join(f.root, 'a/x.js'), 'clean\n');
      symlinkSync(join(f.root, 'a'), join(f.root, 'a/self'), 'junction');

      const res = f.scan('a');
      assert.equal(res.status, 0, 'a cycle that stays inside is not an error, it is just visited once');
    } finally { f.cleanup(); }
  });

  it('a broken link is not a crash and not a boundary violation', () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, 'logs'), { recursive: true });
      symlinkSync(join(f.root, 'does-not-exist'), join(f.root, 'logs/broken'), 'junction');

      const res = f.scan('logs');
      assert.ok(res.status === 0 || res.status === 2, `expected a clean or refused scan, got ${res.status}`);
      assert.doesNotMatch(res.stderr, /Error:|throw/, 'a missing target must not surface as a stack trace');
    } finally { f.cleanup(); }
  });

  it('a named path on another drive is refused', () => {
    // The fixture lives on the temp drive; naming a path on the repository's drive (or
    // any absolute path outside) must be refused rather than scanned and reported with an
    // absolute path. On POSIX this is the same '..' case the boundary already covered.
    const f = fixture();
    try {
      const foreign = process.platform === 'win32' ? 'D:/' : '/';
      const res = f.scan(foreign);
      assert.equal(res.status, 2, 'an absolute path outside the repository is not a scan target');
    } finally { f.cleanup(); }
  });

  it('the default git-listed set is boundary-checked too (the route that takes no argument)', () => {
    // The fifth route, and the one that runs on every push: `git ls-files -co` walks
    // through a junction itself, so the default input set can name a path that reads as
    // inside the repository while resolving outside it. Measured before the fix: a bare
    // `secret-scan` in this fixture read the outside file.
    const f = fixture();
    try {
      writeFileSync(join(f.outside, 'synthetic.log'), `token=${KEY}\n`);
      mkdirSync(join(f.root, 'logs'), { recursive: true });
      // Git on POSIX lists an untracked directory symlink itself, not its children.
      // Pin the child in the index before replacing only this owned fixture directory;
      // both platforms must expose the same dangerous default input path.
      mkdirSync(join(f.root, 'logs/linked'));
      writeFileSync(join(f.root, 'logs/linked/synthetic.log'), '// fixture placeholder');
      execFileSync('git', ['add', 'logs/linked/synthetic.log'], { cwd: f.root, stdio: 'pipe' });
      rmSync(join(f.root, 'logs/linked'), { recursive: true, force: true });
      symlinkSync(f.outside, join(f.root, 'logs/linked'), 'junction');

      const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: f.root, encoding: 'utf8' });
      assert.match(listed, /logs\/linked\/synthetic\.log/, 'the fixture must expose the outside file to the default input set');

      const res = f.scan();
      assert.equal(res.status, 2, 'a default scan whose input set reaches outside the repository must refuse');
      assert.match(res.stderr, /resolves outside/);
      assert.ok(!res.stdout.includes(KEY), 'and it must not print the secret it read');
    } finally { f.cleanup(); }
  });

  it('the real repository still scans clean by default (anti-over-refusal control)', () => {
    // The boundary applies to the default `git ls-files` set too. If it were drawn too
    // tightly it would refuse the repository itself, so this is the control that says the
    // rule did not simply break the scan.
    const repo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const res = spawnSync(process.execPath, ['scripts/secret-scan.mjs'], { cwd: repo, encoding: 'utf8', timeout: 120000 });
    assert.equal(res.status, 0, `the repository must still scan clean: ${res.stdout}${res.stderr}`);
  });
});

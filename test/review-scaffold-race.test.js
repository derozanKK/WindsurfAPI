import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspaceDir } from '../src/client.js';

it('a directory created after the existence check is not owned by this call', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'wa-scaffold-race-'));
  const target = join(root, 'workspace');
  const original = fs.existsSync;
  let injected = false;
  try {
    fs.existsSync = path => {
      if (path === target && !injected) {
        injected = true;
        fs.mkdirSync(target);
        fs.writeFileSync(join(target, 'package.json'), '{"name":"concurrent-owner"}');
        fs.writeFileSync(join(target, 'README.md'), 'concurrent owner bytes');
        return false;
      }
      return original(path);
    };
    syncBuiltinESMExports();
    ensureWorkspaceDir(target);
    assert.equal(injected, true, 'the intended interleaving must have occurred');
    assert.equal(fs.readFileSync(join(target, 'package.json'), 'utf8'), '{"name":"concurrent-owner"}');
    assert.equal(fs.readFileSync(join(target, 'README.md'), 'utf8'), 'concurrent owner bytes');
    assert.equal(original(join(target, '.gitignore')), false, 'a lost claim may not seed other files');
  } finally {
    fs.existsSync = original; syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('a file created after directory acquisition is never truncated by stub seeding', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'wa-scaffold-file-race-'));
  const target = join(root, 'workspace');
  const original = fs.mkdirSync;
  let injected = false;
  try {
    fs.mkdirSync = (path, options) => {
      const result = original(path, options);
      if (path === target && !injected) {
        injected = true;
        fs.writeFileSync(join(target, 'README.md'), 'late owner bytes');
      }
      return result;
    };
    syncBuiltinESMExports();
    ensureWorkspaceDir(target);
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(join(target, 'README.md'), 'utf8'), 'late owner bytes');
  } finally {
    fs.mkdirSync = original; syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('a concurrently created directory without colliding stub filenames is also preserved', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'wa-scaffold-empty-race-'));
  const target = join(root, 'workspace'), original = fs.existsSync;
  let injected = false;
  try {
    fs.existsSync = path => {
      if (path === target && !injected) {
        injected = true; fs.mkdirSync(target); fs.writeFileSync(join(target, 'owner-notes.txt'), 'keep');
        return false;
      }
      return original(path);
    };
    syncBuiltinESMExports(); ensureWorkspaceDir(target);
    assert.equal(injected, true);
    assert.deepEqual(fs.readdirSync(target), ['owner-notes.txt'], 'file-level wx is not a directory ownership proof');
    assert.equal(fs.readFileSync(join(target, 'owner-notes.txt'), 'utf8'), 'keep');
  } finally { fs.existsSync = original; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});

// GPT-01 (independent audit, 2026-09-22): the workspace scaffold migration destroyed
// content it could not prove it owned.
//
// What it did: `isLegacyScaffold()` returned true for any directory whose package.json
// `name` was not `proxy-workspace-stub` — i.e. the test for "this is our old template"
// was "this is not the name we write today". The caller then ran
// `rmSync(<dir>/src, { recursive: true, force: true })` and overwrote package.json,
// README.md and .gitignore. Measured on the real helper: an unmarked project directory
// lost `src/`, README and package.json; a directory merely *named* `my-project` but
// containing authored files lost them too.
//
// These tests pin the replacement rule — the only ownership this code can prove is what
// its own call created, so an existing directory is never modified — and the control
// that the fresh-creation path still works, which is what actually keeps the model from
// seeing a project-shaped placeholder on the wire.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspaceDir } from '../src/client.js';

// A stable snapshot of everything under a directory, so "unchanged" is byte-exact and
// covers files a test author would not think to list.
function snapshot(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else out[rel] = readFileSync(full, 'utf-8');
    }
  };
  walk(root, '');
  return out;
}

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'wa-scaffold-'));
}

describe('GPT-01: workspace scaffold only ever touches what it created', () => {
  it('an existing directory with authored content is byte-identical after the call', () => {
    const root = tempWorkspace();
    try {
      // The audit's "unmarked owner project" case: a real project that simply is not
      // named the way our own stub is named.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-real-project', version: '3.1.4' }, null, 2) + '\n');
      writeFileSync(join(root, 'README.md'), '# My real project\n\nAuthored by the operator.\n');
      writeFileSync(join(root, 'notes.txt'), 'hand-written\n');
      writeFileSync(join(root, 'src/app.js'), 'export const keep = true;\n');
      const before = snapshot(root);

      ensureWorkspaceDir(root);

      assert.deepEqual(snapshot(root), before, 'an existing directory must not be modified in any way');
      assert.ok(existsSync(join(root, 'src/app.js')), 'authored source must survive');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a directory named like the old placeholder is still left alone (control)', () => {
    const root = tempWorkspace();
    try {
      const inner = join(root, 'my-project');
      mkdirSync(join(inner, 'src'), { recursive: true });
      writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'my-project', version: '0.1.0' }, null, 2) + '\n');
      writeFileSync(join(inner, 'src/index.js'), '// Entry point\nconsole.log("authored by the operator");\n');
      const before = snapshot(root);

      ensureWorkspaceDir(inner);

      assert.deepEqual(snapshot(root), before, 'the name alone was never evidence of ownership');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an existing stub directory is left untouched and not rewritten (control)', () => {
    const root = tempWorkspace();
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'proxy-workspace-stub', version: '0.0.0' }, null, 2) + '\n');
      writeFileSync(join(root, 'README.md'), 'edited by hand\n');
      const before = snapshot(root);

      ensureWorkspaceDir(root);

      assert.deepEqual(snapshot(root), before, 'an existing scaffold is not rewritten either');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a directory holding only files we did not write is left alone, even when none of them collide (control)', () => {
    // The other ownership tests use directories that already contain a package.json, so
    // the `wx` stub writes stop at the first collision and the behaviour looks identical
    // whether or not the existing-directory guard is present. This case removes that
    // ambiguity: nothing in here shares a name with a stub file, so only the guard can
    // keep the directory byte-identical. Without it the scaffold seeds three files into
    // somebody else's directory.
    const root = tempWorkspace();
    try {
      writeFileSync(join(root, 'notes.txt'), 'hand-written notes\n');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/app.js'), 'export const keep = true;\n');
      const before = snapshot(root);

      ensureWorkspaceDir(root);

      assert.deepEqual(snapshot(root), before, 'a directory we did not create must not be seeded, colliding names or not');
      assert.ok(!existsSync(join(root, 'package.json')), 'no stub package.json may appear in a directory we did not create');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a path that does not exist still gets the labeled stub', () => {
    const root = tempWorkspace();
    const target = join(root, 'workspace-abc123');
    try {
      ensureWorkspaceDir(target);

      const files = snapshot(target);
      assert.ok(files['package.json'], 'the scaffold must create a package.json');
      assert.match(files['package.json'], /proxy-workspace-stub/, 'and it must be the labeled stub, not a project-shaped one');
      assert.match(files['README.md'], /Proxy workspace placeholder/);
      assert.doesNotMatch(files['package.json'], /my-project/, 'the pre-#108 project-shaped name must never be seeded');
      assert.ok(existsSync(join(target, '.gitignore')), 'the third stub file is written too');
      assert.ok(!existsSync(join(target, 'src')), 'and no project-shaped src/ is seeded');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

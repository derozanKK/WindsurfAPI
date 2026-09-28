import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(source, expected = 1, anchor = 'guarded = true') {
  const root = fs.mkdtempSync(join(tmpdir(), 'wa-static-bound-'));
  try {
    fs.mkdirSync(join(root, 'scripts'));
    fs.mkdirSync(join(root, 'test/mutations'), { recursive: true });
    fs.copyFileSync(new URL('../scripts/spec-static-check.mjs', import.meta.url), join(root, 'scripts/spec-static-check.mjs'));
    fs.writeFileSync(join(root, 'test/fixture.test.js'), source);
    fs.writeFileSync(join(root, 'source.js'), 'export const guarded = true;\n');
    fs.writeFileSync(join(root, 'test/mutations/fixture.json'), JSON.stringify({ expectBaselinePass: expected, tests: ['test/fixture.test.js'], mutations: [{ file: 'source.js', name: 'control', anchor, replacement: 'guarded = false' }] }));
    return spawnSync(process.execPath, ['scripts/spec-static-check.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
it('a comment containing test syntax is not a proven baseline drift', () => {
  const result = fixture("import {it} from 'node:test';\n/*\nit('not executed',()=>{});\n*/\nit('real',()=>{});\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
it('a conditionally unregistered test is not a static lower bound', () => {
  const result = fixture("import {it} from 'node:test';\nif (false) {\n it('not registered',()=>{});\n}\nit('real',()=>{});\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
it('static validation still rejects non-positive and fractional pins', () => {
  for (const pin of [0, -1, 0.5, 1.5]) {
    const result = fixture("import {it} from 'node:test'; it('real',()=>{});\n", pin);
    assert.equal(result.status, 2, result.stdout + result.stderr);
  }
});
it('static validation still rejects absent mutation anchors', () => {
  const result = fixture("import {it} from 'node:test'; it('real',()=>{});\n", 1, 'absent');
  assert.equal(result.status, 2);
  assert.match(result.stdout, /hits=0/);
});

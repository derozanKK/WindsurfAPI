import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture() {
  const parent = fs.mkdtempSync(join(tmpdir(), 'wa-scan-cwd-'));
  const root = join(parent, 'repo'), away = join(parent, 'caller');
  fs.mkdirSync(join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(away);
  fs.copyFileSync(new URL('../scripts/secret-scan.mjs', import.meta.url), join(root, 'scripts/secret-scan.mjs'));
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const scan = (arg, cwd) => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/secret-scan.mjs'), arg],
      { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.error, undefined); assert.equal(r.signal, null);
    return r;
  };
  return { root, away, scan, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}
it('ignored scanner source reached by an internal alias is independent of caller cwd', () => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.root, 'logs'));
    fs.symlinkSync(f.root, join(f.root, 'logs/root'), 'junction');
    for (const cwd of [f.root, f.away]) {
      const r = f.scan('logs', cwd);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(r.stdout.trim(), '', 'no self-fixture false positive');
    }
  } finally { f.cleanup(); }
});
it('a caller-cwd alias cannot grant a different repository file an ignored identity', () => {
  const f = fixture();
  const secret = 'sk-' + ['P7nQ', 'L8vM'].join('').repeat(4);
  try {
    fs.mkdirSync(join(f.root, 'runtime'));
    fs.writeFileSync(join(f.root, 'runtime/secret-scan.mjs'), secret);
    fs.symlinkSync(join(f.root, 'scripts'), join(f.away, 'runtime'), 'junction');
    for (const cwd of [f.root, f.away]) {
      const r = f.scan('runtime/secret-scan.mjs', cwd);
      assert.equal(r.status, 1, 'the actual input must be scanned, not the same spelling under cwd');
      assert.match(r.stdout, /runtime\/secret-scan\.mjs:1 openai-api-key/);
      assert.ok(!r.stdout.includes(secret)); assert.ok(!r.stderr.includes(secret));
    }
  } finally { f.cleanup(); }
});

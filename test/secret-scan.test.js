import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));

function runSecretScan(args = []) {
  return spawnSync(process.execPath, ['scripts/secret-scan.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('secret scan', () => {
  it('reports only path, line, and rule without printing secret values', () => {
    const dir = join(root, 'tmp', 'secret-scan-test');
    const file = join(dir, 'fixture.js');
    const apiKey = 'sk-' + 'A'.repeat(32);
    const password = 'secret-value-' + 'B'.repeat(24);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(file, `const apiKey = "${apiKey}";\nconst password = "${password}";\n`);
      const result = runSecretScan(['tmp/secret-scan-test/fixture.js']);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /tmp\/secret-scan-test\/fixture\.js:1 openai-api-key/);
      assert.match(result.stdout, /tmp\/secret-scan-test\/fixture\.js:2 literal-credential-assignment/);
      assert.doesNotMatch(result.stdout, new RegExp(apiKey));
      assert.doesNotMatch(result.stdout, new RegExp(password));
      assert.equal(result.stderr, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unquoted .env-style credential assignments', () => {
    const dir = join(root, 'tmp', 'secret-scan-test');
    const file = join(dir, 'dotenv-fixture.env');
    const apiKey = 'AbCdEf' + '0123456789'.repeat(2);
    const dash = 'hunter2' + 'Xy9'.repeat(7);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(file, `API_KEY=${apiKey}\nDASHBOARD_PASSWORD=${dash}\n`);
      const result = runSecretScan(['tmp/secret-scan-test/dotenv-fixture.env']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /dotenv-fixture\.env:1 unquoted-env-secret/);
      assert.match(result.stdout, /dotenv-fixture\.env:2 unquoted-env-secret/);
      assert.doesNotMatch(result.stdout, new RegExp(apiKey));
      assert.doesNotMatch(result.stdout, new RegExp(dash));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves indirection, placeholders, and short values alone', () => {
    const dir = join(root, 'tmp', 'secret-scan-test');
    const file = join(dir, 'dotenv-clean.env');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(file, [
        'API_KEY=process.env.API_KEY',
        'API_KEY=${API_KEY}',
        'API_KEY=',
        'DASHBOARD_PASSWORD=YOUR_PASSWORD_HERE',
        'GEMINI_API_KEY=short',
        '',
      ].join('\n'));
      const result = runSecretScan(['tmp/secret-scan-test/dotenv-clean.env']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans test/_research instead of exempting it wholesale', () => {
    const name = `scan-probe-${process.pid}.js`;
    const file = join(root, 'test', '_research', name);
    const key = 'sk-' + 'Z8nR'.repeat(8);
    try {
      writeFileSync(file, `export const leaked = '${key}';\n`);
      const result = runSecretScan([`test/_research/${name}`]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`test/_research/${name}:1 openai-api-key`));
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('passes on the tracked repository contents', () => {
    const result = runSecretScan();
    assert.equal(result.status, 0, result.stdout || result.stderr);
  });
});

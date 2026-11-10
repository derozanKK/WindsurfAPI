/**
 * CI wrapper for scripts/smoke-matrix.mjs.
 *
 * The script boots the real server and drives every user-visible family; this
 * test owns process lifecycle and the acceptance contract:
 *   - exit code 0
 *   - one machine-readable summary line with passed === total, 0 failed and
 *     every declared family green
 *   - one FAMILY line per family, all green
 *   - every flow line is a PASS (a single FAIL is enough to fail this test)
 *   - no synthetic credential appears in the child's stdout/stderr
 *
 * The child is spawned with scripts/mutation-network-deny.mjs preloaded, so a
 * seam the matrix forgot cannot silently reach a real provider.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATRIX_FAMILIES, MATRIX_SECRETS } from './helpers/smoke-matrix-upstream.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 240_000;
const OUTPUT_CAP = 8 * 1024 * 1024;

function cap(text) {
  return text.length > OUTPUT_CAP ? text.slice(-OUTPUT_CAP) : text;
}

function tail(text, max = 6000) {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function runMatrix() {
  return new Promise((resolvePromise) => {
    // The runner sets NODE_TEST_CONTEXT for every test-file process; a plain
    // child script must not inherit it (nor a parent NODE_OPTIONS/FORCE_COLOR).
    const env = { ...process.env, WINDSURFAPI_SKIP_DOTENV: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    delete env.FORCE_COLOR;

    const child = spawn(
      process.execPath,
      ['--import', './scripts/mutation-network-deny.mjs', 'scripts/smoke-matrix.mjs'],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, ...result });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = cap(stdout + chunk); });
    child.stderr.on('data', (chunk) => { stderr = cap(stderr + chunk); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, signal: 'TIMEOUT', error: null });
    }, TIMEOUT_MS);
    timer.unref?.();

    child.on('close', (code, signal) => finish({ code, signal, error: null }));
    child.on('error', (error) => finish({ code: null, signal: null, error }));
  });
}

test('smoke matrix is green across every family and leaks no secret', { timeout: TIMEOUT_MS + 20_000 }, async () => {
  const result = await runMatrix();
  const combined = `${result.stdout}\n${result.stderr}`;

  // Scan BEFORE printing any child output: if a credential leaked, the CI log
  // must not repeat it.
  for (const secret of MATRIX_SECRETS) {
    assert.ok(
      !combined.includes(secret.value),
      `${secret.label} leaked into the matrix child's stdout/stderr`,
    );
  }

  assert.equal(result.error, null, `failed to spawn the matrix: ${result.error?.message || 'unknown'}`);
  assert.equal(result.signal, null, `matrix was killed (${result.signal})`);
  assert.equal(
    result.code,
    0,
    `matrix exited ${result.code}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`,
  );

  const summary = result.stdout.match(
    /SMOKE-MATRIX SUMMARY: (\d+)\/(\d+) flows passed, (\d+) failed, (\d+)\/(\d+) families green/,
  );
  assert.ok(summary, `summary line missing\n${tail(result.stdout)}`);
  const [, passedText, totalText, failedText, greenText, familiesText] = summary;
  assert.equal(Number(failedText), 0, `${failedText} flow(s) failed\n${tail(result.stdout)}`);
  assert.equal(Number(passedText), Number(totalText), `passed ${passedText} of ${totalText}`);
  assert.equal(Number(familiesText), MATRIX_FAMILIES.length, 'summary family total does not match the manifest');
  assert.equal(Number(greenText), MATRIX_FAMILIES.length, `${greenText} of ${familiesText} families green`);
  assert.ok(Number(totalText) >= 40, `only ${totalText} flows ran; the matrix is not comprehensive`);

  for (const family of MATRIX_FAMILIES) {
    const row = result.stdout.match(new RegExp(`^FAMILY ${family} (\\d+)/(\\d+)$`, 'm'));
    assert.ok(row, `family ${family} printed no census line\n${tail(result.stdout)}`);
    assert.equal(row[1], row[2], `family ${family} is ${row[1]}/${row[2]}`);
  }

  const failLines = result.stdout.split('\n').filter((line) => line.startsWith('FAIL'));
  assert.deepEqual(failLines, [], `FAIL lines present\n${tail(result.stdout)}`);
});

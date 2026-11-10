/**
 * CI wrapper for scripts/dashboard-smoke.mjs.
 *
 * The script boots the real server and drives the operator flows; this test
 * only owns process lifecycle and the acceptance contract:
 *   - exit code 0
 *   - one machine-readable summary line with passed === total and 0 failed
 *   - every declared flow printed a PASS line
 *   - no synthetic credential appears in the child's stdout/stderr
 *
 * The child is spawned with scripts/mutation-network-deny.mjs preloaded, so a
 * seam the smoke script forgot cannot silently reach a real provider.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMOKE_FLOWS, SMOKE_SECRETS } from './helpers/dashboard-smoke-upstream.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 180_000;
const OUTPUT_CAP = 4 * 1024 * 1024;

function cap(text) {
  return text.length > OUTPUT_CAP ? text.slice(-OUTPUT_CAP) : text;
}

function tail(text, max = 4000) {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function runSmoke() {
  return new Promise((resolvePromise) => {
    // The runner sets NODE_TEST_CONTEXT for every test-file process; a plain
    // child script must not inherit it (nor a parent NODE_OPTIONS/FORCE_COLOR).
    const env = { ...process.env, WINDSURFAPI_SKIP_DOTENV: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    delete env.FORCE_COLOR;

    const child = spawn(
      process.execPath,
      ['--import', './scripts/mutation-network-deny.mjs', 'scripts/dashboard-smoke.mjs'],
      {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
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

test('dashboard smoke suite is green and leaks no secret', { timeout: TIMEOUT_MS + 20_000 }, async () => {
  const result = await runSmoke();
  const combined = `${result.stdout}\n${result.stderr}`;

  // Scan BEFORE printing any child output: if a credential leaked, the CI log
  // must not repeat it.
  for (const secret of SMOKE_SECRETS) {
    assert.ok(
      !combined.includes(secret.value),
      `${secret.label} leaked into the smoke child's stdout/stderr`,
    );
  }

  assert.equal(result.error, null, `failed to spawn smoke script: ${result.error?.message || 'unknown'}`);
  assert.equal(result.signal, null, `smoke script was killed (${result.signal})`);
  assert.equal(
    result.code,
    0,
    `smoke script exited ${result.code}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`,
  );

  const summary = result.stdout.match(/DASHBOARD-SMOKE SUMMARY: (\d+)\/(\d+) flows passed, (\d+) failed/);
  assert.ok(summary, `summary line missing\n${tail(result.stdout)}`);
  const [, passedText, totalText, failedText] = summary;
  assert.equal(Number(failedText), 0, `${failedText} flow(s) failed\n${tail(result.stdout)}`);
  assert.equal(Number(passedText), Number(totalText), `passed ${passedText} of ${totalText}`);
  assert.equal(Number(totalText), SMOKE_FLOWS.length, 'summary total does not match the declared flow manifest');

  for (const flow of SMOKE_FLOWS) {
    assert.match(result.stdout, new RegExp(`^PASS  ${flow}(?: —|$)`, 'm'), `flow ${flow} did not report PASS`);
  }
});

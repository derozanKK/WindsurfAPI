// WHY THIS FILE EXISTS. Packaged first run generates the operator's API_KEY and
// DASHBOARD_PASSWORD when they are unset and prints them once, prominently, so the
// user can log in. src/index.js printed those two lines through `log.warn` — and
// src/dashboard/logger.js copies every log call into the dashboard ring buffer, the
// live SSE subscribers, logs/app-<date>.jsonl and logs/error-<date>.jsonl. The console
// print is the intended, operator-scoped display; the JSONL files outlive the session
// and carry a wider local readership (bug reports, container logs, backups), so the
// generated secrets must not be in them.
//
// Measured before the fix (evidence/probes/d6-bootstrap-log-persistence/result.json):
// appJsonlHits 1 and errorJsonlHits 1 for each generated value.
//
// The scenario harness is real packaged bootstrap + real logger patch + the actual
// src/index.js print block (see test/helpers/bootstrap-credential-scenario.mjs). It
// reports occurrence counts, not the secret values.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(ROOT, 'test', 'helpers', 'bootstrap-credential-scenario.mjs');

function scenario(name) {
  // Credentials are stripped from the child environment: this suite must never depend
  // on, or expose, a real operator's API_KEY / DASHBOARD_PASSWORD.
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.API_KEY;
  delete env.DASHBOARD_PASSWORD;
  const child = spawnSync(process.execPath, [HARNESS, name], {
    cwd: ROOT, encoding: 'utf8', env, timeout: 60_000,
  });
  assert.equal(child.status, 0, `scenario ${name} did not run:\n${child.stderr}${child.stdout}`);
  return JSON.parse(child.stdout);
}

const byKey = observation => Object.fromEntries(observation.checks.map(check => [check.key, check]));
const SINK_FIELDS = ['appJsonlHits', 'errorJsonlHits', 'bufferHits', 'subscriberHits'];

function assertOnlyOnConsole(observation, { origin, keys }) {
  const checks = byKey(observation);
  for (const key of keys) {
    const check = checks[key];
    assert.equal(check.origin, origin, `${key} should have been ${origin}`);
    assert.equal(check.consoleHits, 1,
      `${key} must be shown to the operator exactly once on the console (got ${check.consoleHits})`);
    for (const field of SINK_FIELDS) {
      assert.equal(check[field], 0, `${key} reached ${field} (${check[field]} occurrence(s))`);
    }
  }
}

test('a packaged first run shows each generated credential once and persists neither', () => {
  const observation = scenario('generated');

  assert.deepEqual(observation.generatedKeys, ['API_KEY', 'DASHBOARD_PASSWORD'],
    'both credentials are unset in this scenario, so both are generated');
  assert.equal(observation.envFile.hasApiKey, true, 'the .env beside the exe is where they belong');
  assert.equal(observation.envFile.hasDashboardPassword, true);

  // The sinks must be demonstrably live, or "absent from the log" proves nothing.
  assert.equal(observation.nonsecret.sentinelOnDisk, true, 'the JSONL files were written and flushed');
  assert.equal(observation.nonsecret.bannerOnConsole, true);
  assert.equal(observation.nonsecret.bannerLogged, true, 'the non-secret banner stays in the log');
  assert.equal(observation.nonsecret.persistExplanationLogged, true, 'the .env explanation stays in the log');

  assertOnlyOnConsole(observation, { origin: 'generated', keys: ['API_KEY', 'DASHBOARD_PASSWORD'] });

  // Bootstrapping still works: the operator gets usable credentials for this run.
  for (const key of ['API_KEY', 'DASHBOARD_PASSWORD']) {
    const check = byKey(observation)[key];
    assert.equal(check.inProcessEnv, true, `${key} must be active in the environment`);
    assert.equal(check.inConfig, true, `${key} must reach config`);
  }
});

test('credentials that already exist are neither generated nor displayed', () => {
  const observation = scenario('preset');

  assert.deepEqual(observation.generatedKeys, [], 'nothing to generate when both keys are set');
  assert.equal(observation.generatedEnvPath, null);
  assert.equal(observation.nonsecret.sentinelOnDisk, true);
  assert.equal(observation.nonsecret.bannerLogged, false, 'an untouched config prints no first-run banner');

  const checks = byKey(observation);
  for (const key of ['API_KEY', 'DASHBOARD_PASSWORD']) {
    assert.equal(checks[key].origin, 'preset');
    assert.equal(checks[key].consoleHits, 0, `${key} must not be echoed by a first-run display`);
    for (const field of SINK_FIELDS) assert.equal(checks[key][field], 0);
  }
});

test('one missing key displays only the key that was generated', () => {
  const observation = scenario('partial');

  assert.deepEqual(observation.generatedKeys, ['DASHBOARD_PASSWORD']);
  assert.equal(observation.nonsecret.sentinelOnDisk, true);

  const checks = byKey(observation);
  assert.equal(checks.API_KEY.origin, 'preset');
  assert.equal(checks.API_KEY.consoleHits, 0, 'the pre-existing API key is not part of the display');
  assert.equal(checks.DASHBOARD_PASSWORD.origin, 'generated');
  assert.equal(checks.DASHBOARD_PASSWORD.consoleHits, 1);
  assert.equal(checks.DASHBOARD_PASSWORD.inConfig, true, 'the generated password reaches the dashboard config');

  for (const key of ['API_KEY', 'DASHBOARD_PASSWORD']) {
    for (const field of SINK_FIELDS) assert.equal(checks[key][field], 0, `${key} reached ${field}`);
  }
});

test('an unwritable .env keeps the generated credentials in memory and on the console only', () => {
  const observation = scenario('persist-failure');

  assert.deepEqual(observation.generatedKeys, ['API_KEY', 'DASHBOARD_PASSWORD']);
  assert.equal(observation.generatedEnvPath, null, 'the .env write failed, so nothing was persisted');
  assert.match(String(observation.generatedPersistError), /\w/, 'the failure reason is carried for the operator');
  assert.equal(observation.envFile.isDirectory, true);
  assert.equal(observation.nonsecret.sentinelOnDisk, true);
  assert.equal(observation.nonsecret.persistExplanationLogged, true,
    'the operator is still told the write failed');

  assertOnlyOnConsole(observation, { origin: 'generated', keys: ['API_KEY', 'DASHBOARD_PASSWORD'] });

  for (const key of ['API_KEY', 'DASHBOARD_PASSWORD']) {
    const check = byKey(observation)[key];
    assert.equal(check.inProcessEnv, true, `${key} must stay usable this run`);
    assert.equal(check.inConfig, true);
  }
});

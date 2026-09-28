// D-TEST-EGRESS: the default test preload must deny unmocked external requests.
//
// Ordinary local tests add synthetic accounts, and addAccountByKey starts a
// catalog sync that dials server.codeium.com. Before this repair an unguarded
// `npm test` run therefore emitted real upstream 401s
// (.agent/audit-20260922/evidence/repairs/state-dirty/gate-01.log:418). The fix
// lives in test/setup-env.mjs: after its dotenv/data-dir isolation it awaits the
// same fail-closed transport guard the mutation harness preloads, unless the
// existing opt-in live suite is fully armed.
//
// Every case below runs in a fresh sentinel child (test/_network-guard-child.mjs)
// with NODE_OPTIONS removed, because an inherited deny preload installs the very
// guard the default is supposed to install by itself. The child replaces every
// guarded native transport and globalThis.fetch with counted terminal stubs
// before importing the real setup, so a missing guard is a red assertion and
// never a real request: the stubs throw TEST_TRANSPORT_SENTINEL without DNS or a
// socket, including for the reserved domain used as the fixture.
//
// This is Node test-harness containment for the exercised APIs. It is not an OS
// sandbox and does not retroactively make earlier broad runs offline evidence.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..');
const CHILD = join(REPO, 'test', '_network-guard-child.mjs');
const DENY_PRELOAD = pathToFileURL(join(REPO, 'scripts', 'mutation-network-deny.mjs')).href;

// Arming fields the live suite owns. They are cleared so a caller's environment
// can never decide what this file observes.
const LIVE_FIELDS = [
  'RELOGIN_LIVE', 'RELOGIN_LIVE_EMAIL', 'RELOGIN_LIVE_PASSWORD',
  'DEVIN_CONNECT_CRED_KEY', 'DEVIN_CONNECT_AUTO_RELOGIN',
];

const ARMED = {
  RELOGIN_LIVE: '1',
  RELOGIN_LIVE_EMAIL: 'synthetic@example.invalid',
  RELOGIN_LIVE_PASSWORD: 'synthetic-not-a-secret',
  DEVIN_CONNECT_CRED_KEY: 'synthetic-not-a-secret',
};

const scratch = mkdtempSync(join(tmpdir(), 'network-guard-test-'));
let childCount = 0;

after(() => { rmSync(scratch, { recursive: true, force: true }); });

function runChild(mode, { args = [], env = {} } = {}) {
  childCount += 1;
  const reportPath = join(scratch, `${childCount}-${mode}.json`);
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  for (const field of LIVE_FIELDS) delete childEnv[field];
  Object.assign(childEnv, env);

  const result = spawnSync(process.execPath, [CHILD, mode, `--report=${reportPath}`, ...args], {
    cwd: REPO, env: childEnv, encoding: 'utf8', timeout: 120000,
  });
  let report = null;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* surfaced below */ }
  return {
    status: result.status, signal: result.signal,
    stdout: result.stdout || '', stderr: result.stderr || '', report,
  };
}

function assertChildPassed(run, label) {
  assert.ok(run.report,
    `${label}: child produced no report (exit=${run.status} signal=${run.signal})\n${run.stderr.slice(-2000)}`);
  assert.equal(run.status, 0,
    `${label}: child exit=${run.status}\n${run.report.failures.join('\n')}\n${run.stderr.slice(-2000)}`);
  assert.equal(run.report.ok, true, `${label}: ${run.report.failures.join('; ')}`);
}

describe('default test network guard (D-TEST-EGRESS)', () => {
  it('setup-env denies unmocked external transports and keeps loopback pass-through', () => {
    const run = runChild('guard-contract');
    assertChildPassed(run, 'default guard');

    const names = run.report.checks.map(entry => entry.name);
    for (const expected of [
      'denied: https.request({hostname:egress.invalid,port:443})',
      'denied: fetch(https://egress.invalid/)',
      'pass-through: net.connect({host:127.0.0.1})',
      'pass-through: net.connect({socketPath:/tmp/x.sock})',
      'no terminal transport ran during the catalog sync route',
      'the catalog call sites reached the guarded transport entry',
    ]) {
      assert.ok(names.includes(expected), `missing check: ${expected}`);
    }
  });

  it('the fully-armed live opt-in still runs without the guard', () => {
    const run = runChild('probe', { args: ['--expect=skipped'], env: { ...ARMED } });
    assertChildPassed(run, 'fully armed');
  });

  it('partial arming keeps the guard installed', () => {
    const cases = [
      ['flag only', { RELOGIN_LIVE: '1' }],
      ['no password', {
        RELOGIN_LIVE: '1', RELOGIN_LIVE_EMAIL: ARMED.RELOGIN_LIVE_EMAIL,
        DEVIN_CONNECT_CRED_KEY: ARMED.DEVIN_CONNECT_CRED_KEY,
      }],
      ['no cred key', {
        RELOGIN_LIVE: '1', RELOGIN_LIVE_EMAIL: ARMED.RELOGIN_LIVE_EMAIL,
        RELOGIN_LIVE_PASSWORD: ARMED.RELOGIN_LIVE_PASSWORD,
      }],
      ['whitespace cred key', { ...ARMED, DEVIN_CONNECT_CRED_KEY: '   ' }],
    ];
    for (const [label, env] of cases) {
      assertChildPassed(runChild('probe', { args: ['--expect=installed'], env }), `partial arming: ${label}`);
    }
  });

  it('an explicit deny preload still wins when the live suite is fully armed', () => {
    const run = runChild('probe', {
      args: ['--expect=installed', '--preload=1'],
      env: { ...ARMED, NODE_OPTIONS: `--import ${DENY_PRELOAD}` },
    });
    assertChildPassed(run, 'armed + explicit preload');
  });

  it('WINDSURFAPI_TEST_DATA_DIR isolation and skip-dotenv are unchanged', () => {
    const run = runChild('data-dir', { env: { WINDSURFAPI_TEST_DATA_DIR: join(scratch, 'caller-data-dir') } });
    assertChildPassed(run, 'caller DATA_DIR');
  });
});

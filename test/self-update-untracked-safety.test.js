import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import {
  handleDashboardApi,
  setGitExecFileForTest,
  setSelfUpdateRestartSchedulerForTest,
  setSelfUpdateSupervisorDetectorForTest,
} from '../src/dashboard/api.js';
import { setRuntimeApiKey, setRuntimeDashboardPassword } from '../src/runtime-config.js';
import {
  isolateProcessGitEnv, isolatedGitEnv, REAL_GIT, SAFE_TMP_ROOT, SKIP_REASON,
} from './git-fixture-env.js';

function git(cwd, args) {
  if (!cwd) throw new Error('self-update safety fixture cwd is required');
  return execFileSync(REAL_GIT, args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' }).trim();
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

it('rollback refuses an untracked path that reset --hard would overwrite, then force mode stashes it', { skip: REAL_GIT ? false : SKIP_REASON }, async () => {
  const restoreGitEnv = isolateProcessGitEnv();
  const originalCwd = process.cwd();
  const originalPassword = config.dashboardPassword;
  const originalApiKey = config.apiKey;
  const originalNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
  const root = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-rollback-untracked-'));
  try {
    git(root, ['init', '--initial-branch=master']);
    git(root, ['config', 'user.name', 'WindsurfAPI Test']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'commit.gpgsign', 'false']);

    const victim = join(root, 'victim.txt');
    writeFileSync(join(root, '.gitignore'), 'data/self-update-before.json\ndata/self-update-before.pending.json\ndata/self-update-journal.json\n');
    writeFileSync(victim, 'tracked rollback content\n');
    git(root, ['add', '.gitignore', 'victim.txt']);
    git(root, ['commit', '-m', 'before rollback']);
    const before = git(root, ['rev-parse', 'HEAD']);

    rmSync(victim);
    git(root, ['add', '-u']);
    git(root, ['commit', '-m', 'remove tracked path']);
    const after = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(victim, 'owner untracked content\n');
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'self-update-before.json'), JSON.stringify({ commit: before, after, ts: Date.now() }));

    config.dashboardPassword = '';
    config.apiKey = '';
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
    configureBindHost('127.0.0.1');
    setGitExecFileForTest(null);
    setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: true, kind: 'test' }));
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      release();
      return false;
    });
    process.chdir(root);

    const refusedRes = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, refusedRes);
    const refused = refusedRes.json();
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.error, 'ERR_UNCOMMITTED_CHANGES');
    assert.deepEqual(refused.dirtyFiles, ['?? victim.txt']);
    assert.equal(git(root, ['rev-parse', 'HEAD']), after);
    assert.equal(readFileSync(victim, 'utf8'), 'owner untracked content\n');

    const forcedRes = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', { forceReset: true }, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, forcedRes);
    const forced = forcedRes.json();
    // D6: the force reset and stash are applied, but the scheduler declined,
    // so this is a pending rollback with its retry point intact — not success.
    assert.equal(forced.ok, false, JSON.stringify(forced));
    assert.equal(forced.error, 'ERR_RESTART_NOT_SCHEDULED');
    assert.equal(forced.rollbackPointRetained, true);
    assert.equal(forced.rolledBackTo, before.slice(0, 7));
    assert.equal(git(root, ['rev-parse', 'HEAD']), before);
    assert.equal(readFileSync(victim, 'utf8'), 'tracked rollback content\n');
    assert.equal(git(root, ['show', 'stash@{0}^3:victim.txt']), 'owner untracked content');
  } finally {
    process.chdir(originalCwd);
    setGitExecFileForTest(null);
    setSelfUpdateSupervisorDetectorForTest(null);
    setSelfUpdateRestartSchedulerForTest(null);
    config.dashboardPassword = originalPassword;
    config.apiKey = originalApiKey;
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    configureBindHost('0.0.0.0');
    if (originalNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
    else process.env.DASHBOARD_ALLOW_NO_AUTH = originalNoAuth;
    rmSync(root, { recursive: true, force: true });
    restoreGitEnv();
  }
});

it('rollback refuses an ignored target collision even with force, without blocking unrelated ignored data', { skip: REAL_GIT ? false : SKIP_REASON }, async () => {
  const restoreGitEnv = isolateProcessGitEnv();
  const originalCwd = process.cwd();
  const originalPassword = config.dashboardPassword;
  const originalApiKey = config.apiKey;
  const originalNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
  const root = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-rollback-ignored-'));
  try {
    git(root, ['init', '--initial-branch=master']);
    git(root, ['config', 'user.name', 'WindsurfAPI Test']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'commit.gpgsign', 'false']);

    const victim = join(root, 'victim.txt');
    const harmless = join(root, 'safe.runtime');
    writeFileSync(join(root, '.gitignore'), 'victim.txt\n*.runtime\ndata/self-update-before.json\ndata/self-update-before.pending.json\n');
    writeFileSync(victim, 'tracked rollback content\n');
    git(root, ['add', '.gitignore']);
    git(root, ['add', '-f', 'victim.txt']);
    git(root, ['commit', '-m', 'before rollback']);
    const before = git(root, ['rev-parse', 'HEAD']);

    rmSync(victim);
    git(root, ['add', '-u']);
    git(root, ['commit', '-m', 'remove tracked path']);
    const after = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(victim, 'owner ignored content\n');
    writeFileSync(harmless, 'unrelated ignored runtime data\n');
    mkdirSync(join(root, 'data'));
    const point = join(root, 'data', 'self-update-before.json');
    writeFileSync(point, JSON.stringify({ commit: before, after, ts: Date.now() }));

    config.dashboardPassword = '';
    config.apiKey = '';
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
    configureBindHost('127.0.0.1');
    setGitExecFileForTest(null);
    setSelfUpdateSupervisorDetectorForTest(() => ({ supervised: true, kind: 'test' }));
    setSelfUpdateRestartSchedulerForTest((_callback, release) => {
      release();
      return false;
    });
    process.chdir(root);

    for (const body of [{}, { forceReset: true }]) {
      const res = fakeRes();
      await handleDashboardApi('POST', '/self-update/rollback', body, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
      const result = res.json();
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.error, 'ERR_IGNORED_PATH_CONFLICT');
      assert.deepEqual(result.conflictPaths, ['victim.txt']);
      assert.equal(git(root, ['rev-parse', 'HEAD']), after);
      assert.equal(readFileSync(victim, 'utf8'), 'owner ignored content\n');
      assert.equal(readFileSync(harmless, 'utf8'), 'unrelated ignored runtime data\n');
      assert.equal(readFileSync(point, 'utf8').length > 0, true);
      assert.equal(git(root, ['stash', 'list']), '');
    }

    // Once the operator manually moves the colliding path, unrelated ignored
    // runtime data must not cause a coarse directory-level false positive.
    rmSync(victim);
    const allowedRes = fakeRes();
    await handleDashboardApi('POST', '/self-update/rollback', {}, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, allowedRes);
    const allowed = allowedRes.json();
    // D6: the reset is applied but the scheduler declined, so this is not a
    // successful rollback — it is a pending one with its retry point intact.
    assert.equal(allowed.ok, false, JSON.stringify(allowed));
    assert.equal(allowed.error, 'ERR_RESTART_NOT_SCHEDULED');
    assert.equal(allowed.rolledBackTo, before.slice(0, 7));
    assert.equal(git(root, ['rev-parse', 'HEAD']), before);
    assert.equal(readFileSync(harmless, 'utf8'), 'unrelated ignored runtime data\n');
  } finally {
    process.chdir(originalCwd);
    setGitExecFileForTest(null);
    setSelfUpdateSupervisorDetectorForTest(null);
    setSelfUpdateRestartSchedulerForTest(null);
    config.dashboardPassword = originalPassword;
    config.apiKey = originalApiKey;
    setRuntimeApiKey('');
    setRuntimeDashboardPassword('');
    configureBindHost('0.0.0.0');
    if (originalNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
    else process.env.DASHBOARD_ALLOW_NO_AUTH = originalNoAuth;
    rmSync(root, { recursive: true, force: true });
    restoreGitEnv();
  }
});

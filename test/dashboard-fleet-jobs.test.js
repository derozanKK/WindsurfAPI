// Fleet runs (UISpec P0-3 / AC-FLEET-1..5).
//
// The pool-wide probe/refresh used to be ONE blocking POST: the browser could
// not show progress, could not cancel, and could only read failures by
// selecting rows first. These tests pin the replacement contract:
//   - a run advances `done` per account, so a poller sees several n/N values
//   - cancel stops SCHEDULING (the in-flight account finishes)
//   - failures and skips keep their per-account email + reason
//   - the legacy blocking routes share the same loop and the same skip
//     classification (skipped is never success)
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  addAccountByKey,
  configureBindHost,
  removeAccount,
  setAccountStatus,
  _resetLockoutForTests,
} from '../src/auth.js';
import { config } from '../src/config.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import {
  __resetFleetJobsForTest,
  awaitFleetJob,
  cancelFleetJob,
  getFleetJob,
  publicFleetJob,
  startFleetJob,
} from '../src/dashboard/fleet-jobs.js';
import { _resetRuntimeConfigForTests } from '../src/runtime-config.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const originalAllowNoAuth = process.env.DASHBOARD_ALLOW_NO_AUTH;
const created = new Set();

afterEach(() => {
  for (const id of created) removeAccount(id);
  created.clear();
  __resetFleetJobsForTest();
  _resetRuntimeConfigForTests();
  _resetLockoutForTests();
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  if (originalAllowNoAuth === undefined) delete process.env.DASHBOARD_ALLOW_NO_AUTH;
  else process.env.DASHBOARD_ALLOW_NO_AUTH = originalAllowNoAuth;
  configureBindHost('0.0.0.0');
});

function enableOpenLocal() {
  _resetRuntimeConfigForTests();
  config.dashboardPassword = '';
  config.apiKey = '';
  configureBindHost('127.0.0.1');
  process.env.DASHBOARD_ALLOW_NO_AUTH = '1';
}

function add(label, patch = {}) {
  const account = addAccountByKey(`fleet-key-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`, `${label}@fixture.invalid`);
  Object.assign(account, patch);
  created.add(account.id);
  return account;
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

async function call(method, path, body) {
  const res = fakeRes();
  // The real server hands handleDashboardApi a subpath without the query
  // string; dashboardUrl(req) carries the query. Mirror that here.
  const subpath = path.split('?')[0];
  await handleDashboardApi(method, subpath, body, { url: `/dashboard/api${path}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return { status: res.statusCode, body: res.json() };
}

describe('fleet job progress and cancel (AC-FLEET-1)', () => {
  it('advances n/N per account and stops scheduling on cancel', async () => {
    for (let i = 0; i < 12; i++) add(`progress-${i}`);
    const ops = {
      probe: async (account) => {
        await sleep(15);
        return { id: account.id, email: account.email, ok: true, tier: 'pro' };
      },
    };
    const job = startFleetJob({ op: 'probe', ops });
    assert.equal(job.total, 12);
    assert.equal(job.state, 'running');

    const seen = new Set();
    for (let i = 0; i < 200 && job.state === 'running'; i++) {
      await sleep(5);
      const snap = publicFleetJob(job);
      seen.add(snap.done);
      if (snap.done >= 4) cancelFleetJob(job.id);
    }
    await job.promise;

    assert.equal(job.state, 'cancelled');
    assert.ok(seen.size >= 3, `a poller must observe several progress values, saw ${[...seen].join(',')}`);
    assert.ok(job.done >= 4, 'already-finished items are kept');
    assert.ok(job.done < 12, 'cancel stops scheduling new accounts');
    assert.equal(job.items.length, job.done);
    assert.equal(job.current, null);
  });

  it('reports a finished run as done, and cancel after the fact is a no-op', async () => {
    add('done-1');
    add('done-2');
    const job = startFleetJob({ op: 'probe', ops: { probe: async (a) => ({ ok: true, email: a.email }) } });
    await awaitFleetJob(job.id);
    assert.equal(job.state, 'done');
    assert.equal(job.done, 2);
    assert.equal(job.okCount, 2);
    const again = cancelFleetJob(job.id);
    assert.equal(again.state, 'done', 'a finished job cannot be cancelled');
  });
});

describe('fleet job payload (AC-FLEET-2)', () => {
  it('pages items by `since` so a poll only carries the delta', async () => {
    add('delta-1');
    add('delta-2');
    add('delta-3');
    const job = startFleetJob({ op: 'probe', ops: { probe: async (a) => ({ ok: true, email: a.email }) } });
    await job.promise;

    const all = publicFleetJob(job, { since: 0 });
    assert.equal(all.items.length, 3);
    assert.equal(all.itemCount, 3);
    assert.equal(all.since, 0);

    const tail = publicFleetJob(job, { since: 2 });
    assert.equal(tail.items.length, 1);
    assert.equal(tail.since, 2);

    const beyond = publicFleetJob(job, { since: 99 });
    assert.deepEqual(beyond.items, [], 'a cursor past the end yields no items');
  });

  it('keeps the email and the human-mappable reason for failures and skips', async () => {
    const ok = add('detail-ok');
    const failed = add('detail-fail');
    const skipped = add('detail-skip');
    const ops = {
      probe: async (account) => {
        if (account.id === failed.id) return { ok: false, error: 'ERR_PROBE_FAILED' };
        if (account.id === skipped.id) return { ok: false, skipped: true, reason: 'ls_not_idle_resident' };
        return { ok: true, email: account.email };
      },
    };
    const job = startFleetJob({ op: 'probe', ops });
    await job.promise;

    assert.equal(job.okCount, 1);
    assert.equal(job.failCount, 1);
    assert.equal(job.skippedCount, 1);
    const byId = new Map(job.items.map((item) => [item.id, item]));
    assert.equal(byId.get(failed.id).email, 'detail-fail@fixture.invalid');
    assert.equal(byId.get(failed.id).error, 'ERR_PROBE_FAILED');
    assert.equal(byId.get(skipped.id).skipped, true);
    assert.equal(byId.get(skipped.id).reason, 'ls_not_idle_resident');
    assert.equal(byId.get(ok.id).ok, true);
  });

  it('targets active accounts only and reports how many were excluded', async () => {
    add('target-active-1');
    add('target-active-2');
    const off = add('target-off');
    const banned = add('target-banned');
    setAccountStatus(off.id, 'disabled');
    setAccountStatus(banned.id, 'banned');

    const job = startFleetJob({ op: 'refresh', ops: { refresh: async (a) => ({ ok: true, email: a.email }) } });
    await job.promise;
    assert.equal(job.total, 2);
    assert.equal(job.excluded, 2, 'disabled/banned accounts are named, not silently dropped');
    // The UI lists the excluded accounts (P1-7), so the count must come with names.
    assert.deepEqual(
      job.excludedAccounts.map((a) => a.email).sort(),
      ['target-banned@fixture.invalid', 'target-off@fixture.invalid'],
    );
    const snapshot = publicFleetJob(job);
    assert.equal(snapshot.excludedAccounts.length, 2);
    assert.ok(snapshot.items.every((item) => Number.isFinite(item.at) && item.at > 0),
      'every attempt carries the time it ran');
  });

  it('runs only the caller-selected ids, and de-dupes them', async () => {
    // "Run on the checked rows" must not become "run on the pool": the route
    // forwards `ids` from the selection bar, and a dropped list would refresh
    // every account behind the operator's back.
    const picked = add('ids-picked');
    const other = add('ids-other');
    const seen = [];
    const job = startFleetJob({
      op: 'refresh',
      ids: [picked.id, picked.id, 'ghost-id'],
      ops: { refresh: async (a) => { seen.push(a.id); return { ok: true, email: a.email }; } },
    });
    await job.promise;

    assert.deepEqual(seen, [picked.id], 'only the selected, existing account runs (once)');
    assert.ok(!seen.includes(other.id), 'an unselected account was refreshed');
    assert.equal(job.total, 1);
    assert.equal(job.requested, 3, 'the requested count is what the caller sent');
    assert.equal(job.excluded, 0, 'an explicit selection is not a pool sweep');
  });
});

describe('fleet routes', () => {
  it('POST /accounts/fleet-jobs starts a job the client can poll and cancel', async () => {
    enableOpenLocal();
    add('route-1');
    add('route-2');
    const started = await call('POST', '/accounts/fleet-jobs', { op: 'probe' });
    assert.equal(started.status, 200);
    assert.equal(started.body.success, true);
    const jobId = started.body.job.id;
    assert.ok(jobId);

    const job = await awaitFleetJob(jobId);
    assert.equal(job.state, 'done');
    const polled = await call('GET', `/accounts/fleet-jobs/${jobId}?since=0`);
    assert.equal(polled.status, 200);
    assert.equal(polled.body.job.state, 'done');
    assert.equal(polled.body.job.total, 2);
    assert.equal(polled.body.job.items.length, 2);
    for (const item of polled.body.job.items) {
      assert.equal(item.ok, false, 'no language server in the test process');
      assert.equal(item.skipped, true);
      assert.equal(typeof item.reason, 'string');
    }

    const cancelled = await call('POST', `/accounts/fleet-jobs/${jobId}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.job.state, 'done');
  });

  it('rejects an unknown op and an unknown job id', async () => {
    enableOpenLocal();
    const bad = await call('POST', '/accounts/fleet-jobs', { op: 'delete' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'ERR_FLEET_OP_INVALID');

    const missing = await call('GET', '/accounts/fleet-jobs/fleet-does-not-exist', {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'ERR_FLEET_JOB_NOT_FOUND');
    assert.equal(getFleetJob('fleet-does-not-exist'), null);
  });

  it('legacy POST /accounts/probe-all shares the loop and never counts a skip as success', async () => {
    enableOpenLocal();
    add('legacy-1');
    add('legacy-2');
    const res = await call('POST', '/accounts/probe-all', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.attempted, 0);
    assert.equal(res.body.skippedCount, 2);
    assert.equal(res.body.okCount, 0);
    for (const item of res.body.results) {
      assert.equal(item.ok, false);
      assert.equal(item.skipped, true);
    }
  });
});

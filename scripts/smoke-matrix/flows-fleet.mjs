/**
 * Smoke-matrix families: fleet · kpi.
 *
 * fleet (3.9.54, bb45dce): probe-all / refresh-all stopped being one blocking
 * POST and became a job with an identity the browser can watch:
 *
 *   POST /accounts/fleet-jobs           → { job } with an id, total, excluded
 *   GET  /accounts/fleet-jobs/:id?since → delta page (items after `since`)
 *   POST /accounts/fleet-jobs/:id/cancel→ stop SCHEDULING; the in-flight item
 *                                         finishes, so `done` never regresses
 *
 * The three properties a naive implementation gets wrong, and which this family
 * pins against the real routes:
 *   - the result list OUTLIVES the run (a finished/cancelled job is still
 *     readable — 3.9.53 kept failures inside the selection bar, so deselecting
 *     the rows erased the evidence);
 *   - `since` is an offset, not a filter, so a poll resends only the delta;
 *   - inactive accounts are EXCLUDED and reported (`excluded`/`excludedAccounts`)
 *     instead of silently shrinking the denominator.
 *
 * kpi (3.9.54, bb45dce): the KPI strip is a PARTITION over resolveAccountState —
 * 正常 + 手动停用 + 需处理 === total — and 需处理 is the same predicate as
 * `filter=flagged`. The pool balance is deduped per billing owner: two members
 * of one org/team read the same on-demand balance, so summing per account
 * multiplied the pool total by the team size.
 */

import { setTimeout as delay } from 'node:timers/promises';

const JOB_ID_RE = /^fleet-[0-9a-f-]{36}$/;
/** The scripted upstream reports $12.50 for every refreshed account. */
const SCRIPTED_BALANCE = 12.5;

export function registerFleetFlows(ctx) {
  const { http, requireThat, addFlow, deps, state } = ctx;

  async function pollJob(id, { since = 0 } = {}) {
    const r = await http('GET', `/dashboard/api/accounts/fleet-jobs/${encodeURIComponent(id)}?since=${since}`);
    requireThat(r.status === 200 && r.json?.success === true, `poll status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(r.json.job?.id === id, `poll returned job ${r.json.job?.id}`);
    return r.json.job;
  }

  async function waitForState(id, predicate, { timeoutMs = 20_000, since = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let job = await pollJob(id, { since });
    while (!predicate(job)) {
      if (Date.now() >= deadline) {
        throw new Error(`job ${id} stuck in ${job.state} ${job.done}/${job.total} (${job.error || 'no error'})`);
      }
      await delay(20);
      job = await pollJob(id, { since });
    }
    return job;
  }

  async function startJob(body) {
    const r = await http('POST', '/dashboard/api/accounts/fleet-jobs', { body });
    requireThat(r.status === 200 && r.json?.success === true, `start status ${r.status} error ${r.json?.error || '?'}`);
    return r.json.job;
  }

  // ─── fleet ───────────────────────────────────────────────────────────
  addFlow('fleet', 'fleet.start-poll-delta', async () => {
    const started = await startJob({ op: 'refresh' });
    requireThat(JOB_ID_RE.test(String(started.id)), `job id ${started.id}`);
    requireThat(started.op === 'refresh', `op ${started.op}`);
    requireThat(started.total >= 1, `a refresh run targeted ${started.total} accounts`);
    requireThat(started.since === 0 && Array.isArray(started.items), 'the start response is not a since=0 page');
    requireThat(started.done <= started.total, `done ${started.done} > total ${started.total}`);

    const job = await waitForState(started.id, (j) => j.state !== 'running');
    requireThat(job.state === 'done', `state ${job.state} error ${job.error || '?'}`);
    requireThat(job.done === job.total, `done ${job.done}/${job.total}`);
    requireThat(job.itemCount === job.total, `itemCount ${job.itemCount} vs total ${job.total}`);
    requireThat(job.items.length === job.total, `start page carried ${job.items.length} items for ${job.total} accounts`);
    requireThat(job.ok === job.total && job.fail === 0 && job.skipped === 0, `ok ${job.ok} fail ${job.fail} skipped ${job.skipped} of ${job.total}`);
    requireThat(job.finishedAt >= job.startedAt && job.startedAt > 0, `timestamps ${job.startedAt}→${job.finishedAt}`);
    requireThat(job.cancelRequested === false, 'an uncancelled job reports cancelRequested');
    requireThat(job.current === null, `a finished job still names current=${JSON.stringify(job.current)}`);
    for (const item of job.items) {
      requireThat(typeof item.id === 'string' && item.id, 'an item has no account id');
      requireThat(typeof item.email === 'string' && item.email, `item ${item.id} has no email`);
      requireThat(item.ok === true, `item ${item.id} failed: ${item.error || item.reason || '?'}`);
      requireThat(typeof item.at === 'number' && item.at > 0, `item ${item.id} has no timestamp`);
    }

    // `since` is an offset into the SAME list, so the delta is exactly the tail.
    const delta = await pollJob(job.id, { since: job.itemCount });
    requireThat(delta.since === job.itemCount, `delta since ${delta.since}`);
    requireThat(delta.items.length === 0, `a caught-up poll resent ${delta.items.length} items`);
    requireThat(delta.itemCount === job.itemCount, 'the caught-up poll lost the item count');
    const tail = await pollJob(job.id, { since: 1 });
    requireThat(tail.items.length === job.total - 1, `since=1 returned ${tail.items.length} of ${job.total - 1}`);
    requireThat(tail.items[0].id === job.items[1].id, 'since=1 did not start at the second item');

    // The result list outlives the run: no selection state to lose.
    const reread = await pollJob(job.id, { since: 0 });
    requireThat(reread.state === 'done' && reread.items.length === job.total, 'a finished job stopped being readable');
    return `${job.total} accounts refreshed; delta paging + persistent results`;
  });

  addFlow('fleet', 'fleet.excludes-inactive', async () => {
    const add = await http('POST', '/dashboard/api/accounts', {
      body: { token: 'devin-session-token$smoke-fleet-idle-4c8e1a', label: 'fleet-idle@fixture.invalid' },
    });
    requireThat(add.status === 200 && add.json?.success === true, `fixture add status ${add.status}`);
    const idleId = add.json.account.id;
    const off = await http('PATCH', `/dashboard/api/accounts/${encodeURIComponent(idleId)}`, { body: { status: 'disabled' } });
    requireThat(off.status === 200 && off.json?.success === true, `disable status ${off.status}`);
    try {
      const started = await startJob({ op: 'refresh' });
      const job = await waitForState(started.id, (j) => j.state !== 'running');
      requireThat(job.state === 'done', `state ${job.state}`);
      requireThat(job.excluded >= 1, `excluded ${job.excluded}; a disabled account was counted as a target`);
      requireThat(Array.isArray(job.excludedAccounts), 'excludedAccounts missing');
      requireThat(job.excludedAccounts.length === job.excluded, `${job.excludedAccounts.length} names for ${job.excluded} excluded accounts`);
      requireThat(job.excludedAccounts.some((a) => a.id === idleId), 'the disabled account was not named in excludedAccounts');
      requireThat(!job.items.some((item) => item.id === idleId), 'a disabled account was refreshed');
      requireThat(job.done === job.total, `done ${job.done}/${job.total}`);
      return `${job.total} refreshed, ${job.excluded} inactive excluded by name`;
    } finally {
      await http('DELETE', `/dashboard/api/accounts/${encodeURIComponent(idleId)}`);
    }
  });

  addFlow('fleet', 'fleet.cancel-and-persist', async () => {
    // The run is serial and the scripted upstream is instant, so a cancel would
    // race the whole job. Stretch the per-account read instead of racing a
    // sleep: the cancel must land while an item is genuinely in flight.
    const original = deps.postJson;
    let slowed = 0;
    const slowPostJson = async (host, path, body, proxy) => {
      if (String(path).includes('GetUserStatus')) {
        slowed++;
        await delay(250);
      }
      return original(host, path, body, proxy);
    };
    deps.installPostJson(slowPostJson);
    try {
      const started = await startJob({ op: 'refresh' });
      requireThat(started.total >= 3, `only ${started.total} active accounts; a mid-run cancel needs a queue`);
      const running = await waitForState(started.id, (j) => j.done >= 1);
      requireThat(running.state === 'running', `job already ${running.state} after the first item`);

      const cancel = await http('POST', `/dashboard/api/accounts/fleet-jobs/${encodeURIComponent(started.id)}/cancel`, { body: {} });
      requireThat(cancel.status === 200 && cancel.json?.success === true, `cancel status ${cancel.status}`);
      requireThat(cancel.json.job.cancelRequested === true, 'cancel was not recorded on a running job');
      requireThat(cancel.json.job.done >= 1, 'cancel regressed done');

      const finished = await waitForState(started.id, (j) => j.state !== 'running');
      requireThat(finished.state === 'cancelled', `state ${finished.state}`);
      requireThat(finished.done < finished.total, `cancel ran every item: ${finished.done}/${finished.total}`);
      requireThat(finished.done >= 1, 'cancel lost the item that had already run');
      requireThat(finished.finishedAt > 0, 'a cancelled job has no finishedAt');

      const later = await pollJob(finished.id, { since: 0 });
      requireThat(later.state === 'cancelled', `a cancelled job stopped reporting: ${later.state}`);
      requireThat(later.items.length === finished.done, `persisted ${later.items.length} items for done ${finished.done}`);
      requireThat(later.cancelRequested === true, 'the persisted job forgot it was cancelled');
      requireThat(slowed > 0, 'the slow transport never ran; the cancel was not observed mid-run');
      return `cancelled at ${finished.done}/${finished.total}; results persisted`;
    } finally {
      deps.installPostJson(original);
    }
  });

  addFlow('fleet', 'fleet.invalid-inputs', async () => {
    const badOp = await http('POST', '/dashboard/api/accounts/fleet-jobs', { body: { op: 'delete' } });
    requireThat(badOp.status === 400 && badOp.json?.error === 'ERR_FLEET_OP_INVALID', `bad op status ${badOp.status} error ${badOp.json?.error}`);

    const tooLarge = await http('POST', '/dashboard/api/accounts/fleet-jobs', {
      body: { op: 'refresh', ids: Array.from({ length: 1001 }, (_, i) => `ghost-${i}`) },
    });
    requireThat(tooLarge.status === 400 && tooLarge.json?.error === 'ERR_FLEET_TOO_LARGE', `too-large status ${tooLarge.status}`);
    requireThat(tooLarge.json.max === 1000, `max ${tooLarge.json.max}`);

    const missing = await http('GET', '/dashboard/api/accounts/fleet-jobs/fleet-not-a-job');
    requireThat(missing.status === 404 && missing.json?.error === 'ERR_FLEET_JOB_NOT_FOUND', `unknown job status ${missing.status}`);
    const cancelMissing = await http('POST', '/dashboard/api/accounts/fleet-jobs/fleet-not-a-job/cancel', { body: {} });
    requireThat(cancelMissing.status === 404 && cancelMissing.json?.error === 'ERR_FLEET_JOB_NOT_FOUND', `cancel unknown status ${cancelMissing.status}`);

    // "Run on the checked rows" must run exactly those rows. The route used to
    // drop the selection and sweep the pool, which is indistinguishable from a
    // deliberate fleet-wide run until you read `total`.
    const picked = state.tokenAccountId;
    requireThat(typeof picked === 'string' && picked, 'the pool has no token account to select');
    const one = await startJob({ op: 'refresh', ids: [picked, picked] });
    const oneDone = await waitForState(one.id, (j) => j.state !== 'running');
    requireThat(oneDone.total === 1, `a one-account selection targeted ${oneDone.total} accounts`);
    requireThat(oneDone.items.length === 1 && oneDone.items[0].id === picked, `the selection ran ${oneDone.items.map((i) => i.id).join(',')}`);
    requireThat(oneDone.ok === 1, `the selected refresh reported ok ${oneDone.ok}`);

    // An explicit id list that matches nothing is a legitimate empty run, not
    // an error: the caller asked for exactly those rows.
    const empty = await startJob({ op: 'refresh', ids: ['ghost-a', 'ghost-b', 'ghost-a'] });
    const emptyDone = await waitForState(empty.id, (j) => j.state !== 'running');
    requireThat(emptyDone.state === 'done', `empty run state ${emptyDone.state}`);
    requireThat(emptyDone.total === 0 && emptyDone.done === 0 && emptyDone.items.length === 0, `empty run ran ${emptyDone.done}/${emptyDone.total}`);
    return 'bad op 400, >1000 ids 400, unknown job 404, empty list done, selection honoured';
  });

  // ─── kpi ─────────────────────────────────────────────────────────────
  addFlow('kpi', 'kpi.partition', async () => {
    const before = (await http('GET', '/dashboard/api/accounts?view=summary')).json?.stats;
    requireThat(before && typeof before.stateCounts === 'object', 'stats.stateCounts missing from the list payload');

    const fixtures = [];
    const create = async (label, status) => {
      const add = await http('POST', '/dashboard/api/accounts', {
        body: { token: `devin-session-token$smoke-kpi-${label}-7b3e5a`, label: `${label}@fixture.invalid` },
      });
      requireThat(add.status === 200 && add.json?.success === true, `${label} add status ${add.status}`);
      const id = add.json.account.id;
      fixtures.push(id);
      if (status) {
        const patched = await http('PATCH', `/dashboard/api/accounts/${encodeURIComponent(id)}`, { body: { status } });
        requireThat(patched.status === 200 && patched.json?.success === true, `${label} status ${patched.status}`);
      }
      return id;
    };

    try {
      const activeId = await create('active', null);
      const disabledId = await create('disabled', 'disabled');
      const erroredId = await create('error', 'error');

      // `banned` and `reauth` are evidence-gated: a hand-written status would
      // forge the ban detector's verdict (and skip bannedReason/bannedAt), so
      // the operator may only write the three they can act on.
      const forged = await http('PATCH', `/dashboard/api/accounts/${encodeURIComponent(activeId)}`, { body: { status: 'banned' } });
      requireThat(forged.status === 400 && forged.json?.error === 'ERR_ACCOUNT_STATUS_INVALID',
        `a hand-written banned status was accepted (${forged.status} ${forged.json?.error || ''})`);

      const payload = (await http('GET', '/dashboard/api/accounts?view=summary&limit=1000')).json;
      const stats = payload.stats;
      const sum = Object.values(stats.stateCounts).reduce((total, n) => total + n, 0);
      requireThat(sum === stats.total, `stateCounts sum ${sum} !== total ${stats.total}`);
      requireThat(stats.total - before.total === 3, `pool grew by ${stats.total - before.total}, not 3`);
      requireThat(stats.stateCounts.active - before.stateCounts.active === 1, `active delta ${stats.stateCounts.active - before.stateCounts.active}`);
      requireThat(stats.stateCounts.disabled - before.stateCounts.disabled === 1, `disabled delta ${stats.stateCounts.disabled - before.stateCounts.disabled}`);
      requireThat(stats.stateCounts.error - before.stateCounts.error === 1, `error delta ${stats.stateCounts.error - before.stateCounts.error}`);

      // 已停用 means the operator's switch, nothing else; 需处理 is the rest.
      requireThat(stats.disabled === stats.stateCounts.disabled, `disabled ${stats.disabled} !== stateCounts.disabled ${stats.stateCounts.disabled}`);
      requireThat(stats.attention === stats.total - stats.stateCounts.active - stats.stateCounts.disabled, 'attention is not the complement of active + disabled');
      requireThat(stats.flagged === stats.attention, `flagged ${stats.flagged} !== attention ${stats.attention}`);
      requireThat(typeof stats.banned === 'number', 'the raw banned counter disappeared');
      requireThat(typeof stats.rateLimited === 'number', 'the raw rateLimited counter disappeared');

      // The KPI number and the filtered rows are one predicate.
      const flagged = await http('GET', '/dashboard/api/accounts?view=summary&filter=flagged&limit=1000');
      requireThat(flagged.status === 200, `flagged status ${flagged.status}`);
      requireThat(flagged.json.total === stats.attention, `filter=flagged total ${flagged.json.total} !== KPI ${stats.attention}`);
      requireThat(flagged.json.stats.flagged === flagged.json.total, 'the filtered payload disagrees with its own stats');
      const ids = new Set(flagged.json.accounts.map((a) => a.id));
      requireThat(ids.has(erroredId), 'an errored account is missing from 需处理');
      requireThat(!ids.has(disabledId), 'a manually disabled account is in 需处理');
      requireThat(!ids.has(activeId), 'a healthy account is in 需处理');
      return `${stats.total} accounts: ${stats.stateCounts.active} healthy, ${stats.stateCounts.disabled} switched off, ${stats.attention} need attention`;
    } finally {
      for (const id of fixtures) await http('DELETE', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    }
  });

  addFlow('kpi', 'kpi.balance-dedupe', async () => {
    const summary = (await http('GET', '/dashboard/api/accounts?view=summary&limit=1000')).json;
    const full = (await http('GET', '/dashboard/api/accounts?view=full&limit=1000')).json;
    requireThat(summary?.stats && Array.isArray(full?.accounts), 'account list payload incomplete');
    const stats = summary.stats;

    // Same plausibility window getAccountListStats applies (a uint64 sentinel
    // decodes to ~1.8e13 USD and must never be summed).
    const plausible = full.accounts.filter((a) => typeof a.credits?.balance === 'number'
      && Number.isFinite(a.credits.balance) && a.credits.balance >= 0 && a.credits.balance <= 1_000_000);
    requireThat(plausible.length >= 3, `only ${plausible.length} accounts carry a balance; the fleet refresh did not populate the pool`);
    requireThat(stats.balanceAccounts === plausible.length, `stats.balanceAccounts ${stats.balanceAccounts} !== ${plausible.length} reported balances`);

    const naive = plausible.reduce((total, a) => total + a.credits.balance, 0);
    requireThat(stats.balanceOwners >= 1 && stats.balanceOwners < stats.balanceAccounts,
      `no billing-owner dedupe: ${stats.balanceOwners} owners for ${stats.balanceAccounts} accounts`);
    requireThat(stats.balanceSharedAccounts === stats.balanceAccounts - stats.balanceOwners,
      `shared ${stats.balanceSharedAccounts} !== ${stats.balanceAccounts} - ${stats.balanceOwners}`);
    requireThat(stats.balanceTotal > 0, `balanceTotal ${stats.balanceTotal}`);
    requireThat(stats.balanceTotal < naive - 0.001,
      `balanceTotal ${stats.balanceTotal} was not deduped (naive per-account sum ${naive})`);
    requireThat(stats.balanceTotal <= SCRIPTED_BALANCE * stats.balanceOwners + 0.001,
      `balanceTotal ${stats.balanceTotal} exceeds one balance per owner (${stats.balanceOwners})`);

    // The shared owners are the token accounts the ACU reader resolved into one
    // org: the same read must not be counted twice.
    const balances = new Set(plausible.map((a) => a.credits.balance));
    if (balances.size === 1 && balances.has(SCRIPTED_BALANCE)) {
      requireThat(Math.abs(stats.balanceTotal - SCRIPTED_BALANCE * stats.balanceOwners) < 0.01,
        `balanceTotal ${stats.balanceTotal} !== ${SCRIPTED_BALANCE} × ${stats.balanceOwners} owners`);
    }
    return `${stats.balanceAccounts} balances → ${stats.balanceOwners} owners ($${stats.balanceTotal} vs naive $${naive.toFixed(2)})`;
  });
}

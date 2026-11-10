/**
 * Smoke-matrix family: reauth.
 *
 * SessionReauth (3.9.52) is the state a `devin-session-token$…` account enters
 * when the FREE GetUserStatus liveness probe confirms the token is dead. The
 * state is the whole bit (`status === 'reauth'`), the badge is derived from it,
 * and every path that would put the retired token back into rotation must
 * answer 409 instead of silently clearing it.
 *
 * The liveness verdict is scripted per token through auth.js's documented
 * `__setReloginDeps` seam, so the suite runs the REAL state machine and routes
 * without an account.
 */

const ACCOUNT_REF_RE = /^acct-[0-9a-f]{8}$/;

export function registerReauthFlows(ctx) {
  const { http, requireThat, addFlow, state, deps, SMOKE, MATRIX } = ctx;

  async function addAccount(token, label) {
    const r = await http('POST', '/dashboard/api/accounts', { body: { token, label } });
    requireThat(r.status === 200 && r.json?.success === true, `add ${label} status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(typeof r.json.account?.id === 'string', `add ${label} returned no account id`);
    requireThat(!r.text.includes(token), `add ${label} echoed the token`);
    return r.json.account.id;
  }

  async function deleteAccount(id) {
    const r = await http('DELETE', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    requireThat(r.status === 200 && r.json?.success === true, `delete ${id} status ${r.status}`);
  }

  // ─── reauth ──────────────────────────────────────────────────────────
  addFlow('reauth', 'reauth.probe-marks-and-badge', async () => {
    const id = await addAccount(MATRIX.reauthToken, 'reauth-smoke');
    state.reauthAccountId = id;
    deps.liveness.set(MATRIX.reauthToken, { alive: false, code: 'UNAUTHORIZED' });

    const probe = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(id)}/reauth`, {
      body: { action: 'probe' },
    });
    requireThat(probe.status === 200, `probe status ${probe.status} error ${probe.json?.error || '?'}`);
    requireThat(probe.json?.checked === true, `checked ${probe.json?.checked}`);
    requireThat(probe.json?.alive === false, `alive ${probe.json?.alive}`);
    requireThat(probe.json?.code === 'UNAUTHORIZED', `code ${probe.json?.code}`);
    requireThat(probe.json?.marked === true, `marked ${probe.json?.marked}`);
    requireThat(probe.json?.status === 'reauth', `status ${probe.json?.status}`);

    const acct = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    requireThat(acct.status === 200, `account status ${acct.status}`);
    requireThat(acct.json?.account?.status === 'reauth', `account status ${acct.json?.account?.status}`);
    const record = acct.json?.account?.reauth;
    requireThat(record && typeof record === 'object', 'reauth evidence record missing');
    requireThat(record.at > 0, `reauth.at ${record.at}`);
    requireThat(record.source === 'manual', `reauth.source ${record.source}`);
    requireThat(record.code === 'UNAUTHORIZED', `reauth.code ${record.code}`);
    requireThat(Object.keys(record).sort().join(',') === 'at,code,source', `reauth record shape ${Object.keys(record).join(',')}`);
    requireThat(!acct.text.includes(MATRIX.reauthToken), 'dead token echoed by the account view');

    const cards = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(id)}/devin-cards`);
    requireThat(cards.status === 200 && cards.json?.ok === true, `cards status ${cards.status}`);
    requireThat(ACCOUNT_REF_RE.test(String(cards.json.key?.accountRef)), `key accountRef ${cards.json.key?.accountRef}`);
    requireThat(cards.json.key?.state === 'reauth', `key.state ${cards.json.key?.state}`);
    requireThat(cards.json.key?.reauth?.required === true, 'key card does not require reauth');
    requireThat(cards.json.key?.reauth?.at === record.at, 'key card and account disagree on the confirmation time');
    requireThat(cards.json.key?.reauth?.source === 'manual', `key card source ${cards.json.key?.reauth?.source}`);
    requireThat(cards.json.key?.reauth?.code === 'UNAUTHORIZED', `key card code ${cards.json.key?.reauth?.code}`);
    requireThat(!cards.text.includes(MATRIX.reauthToken), 'dead token echoed by the cards payload');

    const pool = await http('GET', '/dashboard/api/pool-events');
    requireThat(pool.status === 200, `pool status ${pool.status}`);
    const row = (pool.json?.accounts || []).find((a) => a.id === id);
    requireThat(!!row, 'reauth account missing from pool-events');
    requireThat(row.state === 'reauth', `pool state ${row.state}`);

    const list = await http('GET', '/dashboard/api/accounts');
    const listed = (list.json?.accounts || []).find((a) => a.id === id);
    requireThat(listed?.status === 'reauth', `account list status ${listed?.status}`);

    // Badge wiring: the row/notice markup and the translated label both exist.
    const html = await http('GET', '/dashboard', { auth: 'none' });
    requireThat(html.status === 200, `dashboard status ${html.status}`);
    requireThat(html.text.includes('id="add-reauth-banner"'), 'reauth banner marker missing');
    requireThat(html.text.includes('data-i18n="accounts.reauth.bannerTitle"'), 'reauth banner i18n marker missing');
    const en = await http('GET', '/dashboard/i18n/en.json', { auth: 'none' });
    const zh = await http('GET', '/dashboard/i18n/zh-CN.json', { auth: 'none' });
    requireThat(ctx.readPath(en.json, 'accounts.status.reauth') === 'Needs re-auth', 'reauth badge label drifted');
    requireThat(typeof ctx.readPath(zh.json, 'accounts.status.reauth') === 'string'
      && ctx.readPath(zh.json, 'accounts.status.reauth') !== 'Needs re-auth', 'reauth badge is untranslated in zh-CN');

    return 'probe marks reauth; badge, pool and cards agree';
  });

  addFlow('reauth', 'reauth.route-guards', async () => {
    const id = state.reauthAccountId;
    requireThat(!!id, 'no reauth account recorded by the previous flow');

    const patch = await http('PATCH', `/dashboard/api/accounts/${encodeURIComponent(id)}`, { body: { status: 'active' } });
    requireThat(patch.status === 409, `enable status ${patch.status}`);
    requireThat(patch.json?.error === 'ERR_REAUTH_TOKEN_UNCHANGED', `enable error ${patch.json?.error}`);

    const sameToken = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(id)}/reauth`, {
      body: { action: 'token', token: MATRIX.reauthToken },
    });
    requireThat(sameToken.status === 409, `same-token status ${sameToken.status}`);
    requireThat(sameToken.json?.error === 'ERR_REAUTH_TOKEN_UNCHANGED', `same-token error ${sameToken.json?.error}`);

    // The bound paste on the login route is the same contract.
    const bound = await http('POST', '/dashboard/api/windsurf-login/token', {
      body: { accountId: id, token: MATRIX.reauthToken },
    });
    requireThat(bound.status === 409, `bound-paste status ${bound.status}`);
    requireThat(bound.json?.error === 'ERR_REAUTH_TOKEN_UNCHANGED', `bound-paste error ${bound.json?.error}`);
    requireThat(!bound.text.includes(MATRIX.reauthToken), 'bound paste echoed the token');

    const auth1 = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(id)}/reauth`, {
      body: { action: 'token', token: SMOKE.auth1Token },
    });
    requireThat(auth1.status === 400 && auth1.json?.error === 'ERR_AUTH1_NOT_A_POOL_KEY', `auth1 status ${auth1.status} error ${auth1.json?.error}`);

    const invalid = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(id)}/reauth`, {
      body: { action: 'token', token: 'definitely-not-' + 'a-pool-token' },
    });
    requireThat(invalid.status === 400 && invalid.json?.error === 'ERR_REAUTH_TOKEN_INVALID', `invalid status ${invalid.status} error ${invalid.json?.error}`);

    const badAction = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(id)}/reauth`, {
      body: { action: 'teleport' },
    });
    requireThat(badAction.status === 400 && badAction.json?.error === 'ERR_REAUTH_ACTION_INVALID', `action status ${badAction.status} error ${badAction.json?.error}`);

    const missing = await http('POST', '/dashboard/api/accounts/deadbeef/reauth', { body: { action: 'probe' } });
    requireThat(missing.status === 404 && missing.json?.error === 'ERR_ACCOUNT_NOT_FOUND', `unknown status ${missing.status} error ${missing.json?.error}`);

    // A parked account outranks a token verdict: probe must refuse, not
    // resurrect it.
    const disabledId = await addAccount(MATRIX.reauthTokenDisabled, 'reauth-disabled');
    const disable = await http('PATCH', `/dashboard/api/accounts/${encodeURIComponent(disabledId)}`, { body: { status: 'disabled' } });
    requireThat(disable.status === 200 && disable.json?.success === true, `disable status ${disable.status}`);
    const notApplicable = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(disabledId)}/reauth`, {
      body: { action: 'probe' },
    });
    requireThat(notApplicable.status === 409, `disabled probe status ${notApplicable.status}`);
    requireThat(notApplicable.json?.error === 'ERR_REAUTH_NOT_APPLICABLE', `disabled probe error ${notApplicable.json?.error}`);
    await deleteAccount(disabledId);

    const still = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    requireThat(still.json?.account?.status === 'reauth', 'a refused guard changed the state');
    return 'enable/same-token/bound-paste 409; invalid inputs 400; parked 409';
  });

  addFlow('reauth', 'reauth.recover-paths', async () => {
    const id = state.reauthAccountId;
    requireThat(!!id, 'no reauth account recorded by the first reauth flow');

    // 1. A DIFFERENT token is a real rotation: install it and clear the state.
    const rotated = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(id)}/reauth`, {
      body: { action: 'token', token: MATRIX.reauthTokenNext },
    });
    requireThat(rotated.status === 200 && rotated.json?.success === true, `rotate status ${rotated.status} error ${rotated.json?.error || '?'}`);
    requireThat(rotated.json?.reauthenticated === true, `reauthenticated ${rotated.json?.reauthenticated}`);
    requireThat(rotated.json?.account?.status === 'active', `rotated status ${rotated.json?.account?.status}`);
    requireThat(!rotated.text.includes(MATRIX.reauthTokenNext), 'replacement token echoed by the route');

    const acct = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(id)}`);
    requireThat(acct.json?.account?.status === 'active', `account status ${acct.json?.account?.status}`);
    requireThat(acct.json?.account?.reauth === null, 'reauth evidence survived a real rotation');
    const cards = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(id)}/devin-cards`);
    requireThat(cards.json?.key?.state === 'ok', `key.state ${cards.json?.key?.state}`);
    requireThat(cards.json?.key?.reauth?.required === false, 'key card still requires reauth');
    requireThat(cards.json?.key?.rotatedAt > 0, `key.rotatedAt ${cards.json?.key?.rotatedAt}`);
    const pool = await http('GET', '/dashboard/api/pool-events');
    const row = (pool.json?.accounts || []).find((a) => a.id === id);
    requireThat(row && row.state !== 'reauth', `pool state ${row?.state}`);
    await deleteAccount(id);
    deps.liveness.delete(MATRIX.reauthToken);
    deps.liveness.delete(MATRIX.reauthTokenNext);

    // 2. The liveness probe itself may clear a stale verdict.
    const aliveId = await addAccount(MATRIX.reauthTokenAlive, 'reauth-alive');
    deps.liveness.set(MATRIX.reauthTokenAlive, { alive: false, code: 'UNAUTHORIZED' });
    const dead = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(aliveId)}/reauth`, { body: { action: 'probe' } });
    requireThat(dead.status === 200 && dead.json?.status === 'reauth', `alive setup status ${dead.status} ${dead.json?.status}`);
    deps.liveness.set(MATRIX.reauthTokenAlive, { alive: true, code: 'OK' });
    const alive = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(aliveId)}/reauth`, { body: { action: 'probe' } });
    requireThat(alive.status === 200, `alive probe status ${alive.status}`);
    requireThat(alive.json?.checked === true && alive.json?.alive === true, `alive payload ${JSON.stringify(alive.json)}`);
    requireThat(alive.json?.cleared === true, `cleared ${alive.json?.cleared}`);
    requireThat(alive.json?.status === 'active', `alive status ${alive.json?.status}`);
    await deleteAccount(aliveId);
    deps.liveness.delete(MATRIX.reauthTokenAlive);

    // 3. The operator's explicit override still exists (force), and only force.
    const forceId = await addAccount(MATRIX.reauthTokenForce, 'reauth-force');
    deps.liveness.set(MATRIX.reauthTokenForce, { alive: false, code: 'UNAUTHORIZED' });
    const mark = await http('POST', `/dashboard/api/accounts/${encodeURIComponent(forceId)}/reauth`, { body: { action: 'probe' } });
    requireThat(mark.json?.status === 'reauth', `force setup status ${mark.json?.status}`);
    const forced = await http('PATCH', `/dashboard/api/accounts/${encodeURIComponent(forceId)}`, {
      body: { status: 'active', force: true },
    });
    requireThat(forced.status === 200 && forced.json?.success === true, `force status ${forced.status} error ${forced.json?.error}`);
    const after = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(forceId)}`);
    requireThat(after.json?.account?.status === 'active', `forced status ${after.json?.account?.status}`);
    await deleteAccount(forceId);
    deps.liveness.delete(MATRIX.reauthTokenForce);

    return 'fresh token, probe-alive and force override each recover; same token never does';
  });
}

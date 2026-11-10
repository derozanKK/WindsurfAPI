// SessionReauth Phase 1 — `status:'reauth'` in the account state machine.
//
// The state exists to break one specific loop: a retired `devin-session-token$`
// 401s forever on a single-account pool, and with N accounts the error-TTL
// half-open recovery keeps putting the dead key back in rotation. A bare 401 is
// NOT proof (the non-stream path documents an entitlement wall that is
// byte-for-byte identical), so the state is written only by the free
// GetUserStatus probe — that two-signal rule is what these tests pin.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_STATE_VALUES,
  __deserializeAccount,
  __maybeRecoverErrorAccount,
  __resetReauthChecks,
  __resetReloginState,
  __serializeAccounts,
  __setReloginDeps,
  addAccountByKey,
  clearNeedsReauth,
  getAccountCount,
  getAccountInternal,
  getAccountList,
  getAccountListStats,
  getApiKey,
  markAccountReauthenticated,
  markNeedsReauth,
  probeAndRecoverConnectAccount,
  removeAccount,
  reportDeadToken,
  reportError,
  reportSuccess,
  requestReauthCheck,
  resetAccountErrors,
  resolveAccountState,
  setAccountStatus,
} from '../src/auth.js';
import { getConnectMetrics, resetConnectMetrics } from '../src/devin-connect-metrics.js';

const created = new Set();
let keySeq = 0;

function newAccount(label = 'acct', patch = {}) {
  const account = addAccountByKey(`devin-session-token$test-${label}-${++keySeq}-${Date.now()}`, label);
  Object.assign(account, patch);
  created.add(account.id);
  return account;
}

function stubProbe(result) {
  __setReloginDeps({ checkSessionLiveness: async () => result });
}

afterEach(() => {
  for (const id of created) removeAccount(id);
  created.clear();
  __resetReauthChecks();
  __resetReloginState();
  __setReloginDeps(null);
  resetConnectMetrics();
});

describe('state ladder', () => {
  it('lists reauth between banned and error', () => {
    const idx = ACCOUNT_STATE_VALUES.indexOf('reauth');
    assert.ok(idx > ACCOUNT_STATE_VALUES.indexOf('banned'), 'reauth must rank below banned');
    assert.ok(idx < ACCOUNT_STATE_VALUES.indexOf('error'), 'reauth must rank above error');
  });

  it('resolves reauth out of every self-healing cooldown', () => {
    const now = 1_000_000;
    assert.equal(resolveAccountState({ status: 'reauth' }, now), 'reauth');
    assert.equal(resolveAccountState({ status: 'reauth', errorCount: 9 }, now), 'reauth');
    assert.equal(resolveAccountState({ status: 'reauth', quotaResetAt: now + 1 }, now), 'reauth');
    assert.equal(resolveAccountState({ status: 'reauth', rateLimitedUntil: now + 1 }, now), 'reauth');
    assert.equal(resolveAccountState({ status: 'reauth', _modelRateLimits: { m: now + 1 } }, now), 'reauth');
    // ...but the two states that outrank a token verdict still win.
    assert.equal(resolveAccountState({ status: 'banned' }, now), 'banned');
    assert.equal(resolveAccountState({ status: 'disabled' }, now), 'disabled');
  });
});

describe('selection never resurrects a reauth account (I1)', () => {
  it('is never returned by getApiKey, even as the only account', async () => {
    const a = newAccount('only');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    assert.equal(getApiKey(), null);
    assert.equal(getAccountInternal(a.id).status, 'reauth');
  });

  it('is refused by degraded serve too (rate-limited + reauth)', () => {
    const a = newAccount('degraded');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    // Degraded serve exists to cover a TRANSIENT throttle. A dead token is not
    // transient, so the fallback must not pick it even when it is the only one.
    a.rateLimitedUntil = Date.now() + 60_000;
    assert.equal(getApiKey(), null);
  });

  it('is not resurrected by the half-open error TTL', () => {
    const a = newAccount('halfopen');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    // Simulate a stale error clock: even 15+ minutes later the recovery arm
    // must not touch it (it only runs for status === 'error').
    a.erroredAt = Date.now() - 901_000;
    __maybeRecoverErrorAccount(a, Date.now());
    assert.equal(a.status, 'reauth');
    assert.equal(getApiKey(), null);
    assert.equal(getAccountInternal(a.id).status, 'reauth');
  });

  it('a stale error TTL on a real error account still recovers', () => {
    const a = newAccount('errored');
    a.status = 'error';
    a.erroredAt = Date.now() - 901_000;
    __maybeRecoverErrorAccount(a, Date.now());
    assert.equal(a.status, 'active', 'the control case: reauth must not have broken error recovery');
  });
});

describe('two-signal detection', () => {
  it('a chat 401 alone (no probe) does not bench the account', () => {
    const a = newAccount('chat401');
    // Exactly what the chat path does on UNAUTHORIZED before the verdict:
    reportError(a.apiKey);
    reportDeadToken(a.apiKey);
    assert.notEqual(a.status, 'reauth');
    assert.equal(resolveAccountState(a, Date.now()) !== 'reauth', true);
  });

  it('a 401 whose probe says the token is ALIVE stays active', async () => {
    const a = newAccount('blip');
    stubProbe({ alive: true });
    const r = await requestReauthCheck(a.id, { source: 'request' });
    assert.equal(r.checked, true);
    assert.equal(r.alive, true);
    assert.notEqual(getAccountInternal(a.id).status, 'reauth');
  });

  it('a 401 whose probe answers UNAUTHORIZED marks reauth with its evidence', async () => {
    const a = newAccount('dead');
    stubProbe({ alive: false, code: 'UNAUTHORIZED' });
    const r = await requestReauthCheck(a.id, { source: 'request' });
    assert.equal(r.checked, true);
    assert.equal(r.marked, true);
    const live = getAccountInternal(a.id);
    assert.equal(live.status, 'reauth');
    assert.equal(live.reauth.source, 'request');
    assert.equal(live.reauth.code, 'UNAUTHORIZED');
    assert.ok(live.reauth.at > 0);
    assert.equal(getConnectMetrics().reauth_required, 1);
  });

  for (const code of ['CAPACITY', 'UPSTREAM_INTERNAL', 'NO_TOKEN', 'RATE_LIMITED']) {
    it(`a transient probe verdict (${code}) changes nothing`, async () => {
      const a = newAccount(`transient-${code}`);
      stubProbe({ alive: false, code });
      const r = await requestReauthCheck(a.id, { source: 'request' });
      assert.equal(r.checked, true);
      assert.equal(r.marked, false);
      assert.equal(getAccountInternal(a.id).status, 'active');
    });
  }

  it('a probe that throws is not evidence of anything', async () => {
    const a = newAccount('probe-throw');
    __setReloginDeps({ checkSessionLiveness: async () => { throw Object.assign(new Error('boom'), { code: 'UPSTREAM_ERROR' }); } });
    const r = await requestReauthCheck(a.id, { source: 'request' });
    assert.equal(r.checked, false);
    assert.equal(getAccountInternal(a.id).status, 'active');
  });

  it('an alive probe clears a stale reauth (the proxy/upstream blip case)', async () => {
    const a = newAccount('stale');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    stubProbe({ alive: true });
    const r = await requestReauthCheck(a.id, { source: 'manual', force: true });
    assert.equal(r.cleared, true);
    assert.equal(getAccountInternal(a.id).status, 'active');
    assert.equal(getAccountInternal(a.id).reauth, undefined);
    assert.equal(getConnectMetrics().reauth_cleared, 1);
  });

  it('de-dupes a burst of dead verdicts into one probe', async () => {
    const a = newAccount('burst');
    let calls = 0;
    __setReloginDeps({ checkSessionLiveness: async () => { calls++; return { alive: false, code: 'UNAUTHORIZED' }; } });
    await Promise.all([
      requestReauthCheck(a.id, { source: 'request' }),
      requestReauthCheck(a.id, { source: 'request' }),
      requestReauthCheck(a.id, { source: 'request' }),
    ]);
    assert.equal(calls, 1, 'concurrent callers must share one in-flight probe');
    assert.equal(getAccountInternal(a.id).status, 'reauth');
    // The cooldown then suppresses a later re-check.
    const later = await requestReauthCheck(a.id, { source: 'request' });
    assert.equal(later.reason, 'COOLDOWN');
  });

  it('ignores a verdict for a token that was replaced mid-probe', async () => {
    const a = newAccount('raced');
    __setReloginDeps({
      checkSessionLiveness: async () => {
        a.apiKey = 'devin-session-token$rotated-mid-probe';
        return { alive: false, code: 'UNAUTHORIZED' };
      },
    });
    const r = await requestReauthCheck(a.id, { source: 'request', force: true });
    assert.equal(r.reason, 'TOKEN_CHANGED');
    assert.equal(getAccountInternal(a.id).status, 'active');
  });
});

describe('reauth is terminal (P1)', () => {
  it('reportError cannot walk it into error and the TTL cannot revive it', () => {
    const a = newAccount('terminal-error');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    // The chat path reports errors on every 401; enough of them used to flip a
    // healthy account to 'error', whose 900 s half-open arm then put the dead
    // key back in rotation.
    for (let i = 0; i < 6; i++) reportError(a.apiKey);
    assert.equal(getAccountInternal(a.id).status, 'reauth');
    assert.equal(getAccountInternal(a.id).errorCount, 0, 'a benched account must not accumulate an error budget');
    a.erroredAt = Date.now() - 901_000;
    __maybeRecoverErrorAccount(a, Date.now());
    assert.equal(getAccountInternal(a.id).status, 'reauth');
    assert.equal(getApiKey(), null);
  });

  it('reportSuccess clears the error budget but does not promote it to active', () => {
    const a = newAccount('terminal-success');
    a.errorCount = 3;
    a._errorAt = Date.now();
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    reportSuccess(a.apiKey);
    const live = getAccountInternal(a.id);
    assert.equal(live.errorCount, 0);
    assert.equal(live.status, 'reauth', 'only a fresh token (or an alive probe) leaves reauth');
    assert.equal(getApiKey(), null);
  });
});

describe('liveness sweep records the state', () => {
  it('marks reauth when the probe says UNAUTHORIZED and no re-login is available', async () => {
    const a = newAccount('sweep');
    __setReloginDeps({
      checkSessionLiveness: async () => ({ alive: false, code: 'UNAUTHORIZED' }),
      isCredStoreEnabled: () => false,
      getCredential: () => null,
    });
    const r = await probeAndRecoverConnectAccount(a.id);
    assert.equal(r.alive, false);
    assert.equal(r.recovered, false);
    assert.equal(getAccountInternal(a.id).status, 'reauth');
    assert.equal(getAccountInternal(a.id).reauth.source, 'liveness');
  });

  it('clears a reauth account whose token probes alive', async () => {
    const a = newAccount('sweep-alive');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    __setReloginDeps({
      checkSessionLiveness: async () => ({ alive: true }),
      isCredStoreEnabled: () => false,
      getCredential: () => null,
    });
    const r = await probeAndRecoverConnectAccount(a.id);
    assert.equal(r.alive, true);
    assert.equal(getAccountInternal(a.id).status, 'active');
  });
});

describe('the operator cannot lie to the pool (I2)', () => {
  it('refuses reauth → active without a replaced token', () => {
    const a = newAccount('force-guard');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    assert.throws(() => setAccountStatus(a.id, 'active'), /ERR_REAUTH_TOKEN_UNCHANGED/);
    assert.equal(getAccountInternal(a.id).status, 'reauth');
    // force is the documented escape hatch and must clear the evidence.
    setAccountStatus(a.id, 'active', { force: true });
    assert.equal(getAccountInternal(a.id).status, 'active');
    assert.equal(getAccountInternal(a.id).reauth, undefined);
  });

  it('refuses "reset errors" on a reauth account', () => {
    const a = newAccount('reset-guard');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    assert.throws(() => resetAccountErrors(a.id), /ERR_REAUTH_TOKEN_UNCHANGED/);
    assert.equal(getAccountInternal(a.id).status, 'reauth');
  });

  it('allows reauth → disabled (operator intent always wins)', () => {
    const a = newAccount('disable-ok');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    assert.equal(setAccountStatus(a.id, 'disabled'), true);
    assert.equal(getAccountInternal(a.id).status, 'disabled');
  });

  it('refuses the SAME key as a re-authentication, accepts a new one', () => {
    const a = newAccount('same-key');
    const original = a.apiKey;
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    assert.throws(() => markAccountReauthenticated(a.id, { apiKey: original }), /ERR_REAUTH_TOKEN_UNCHANGED/);
    assert.equal(getAccountInternal(a.id).status, 'reauth');
    markAccountReauthenticated(a.id, { apiKey: 'devin-session-token$brand-new', via: 'email_code' });
    const live = getAccountInternal(a.id);
    assert.equal(live.status, 'active');
    assert.equal(live.apiKey, 'devin-session-token$brand-new');
    assert.equal(live.reauth, undefined);
    assert.ok(live.keyRotatedAt > 0, 'the key rotation must be recorded');
    assert.equal(getConnectMetrics().reauth_ok, 1);
  });

  it('refuses to install a token on a disabled or banned account', () => {
    for (const status of ['disabled', 'banned']) {
      const a = newAccount(`no-install-${status}`, { status });
      assert.throws(
        () => markAccountReauthenticated(a.id, { apiKey: 'devin-session-token$new', via: 'password', allowSameKey: true }),
        /ERR_REAUTH_NOT_APPLICABLE/,
      );
      assert.equal(getAccountInternal(a.id).status, status, 'a login must not un-ban or re-enable');
      assert.equal(getAccountInternal(a.id).apiKey, a.apiKey, 'the refused token must not be installed');
    }
  });

  it('a successful login clears a stale ban-signal streak', () => {
    const a = newAccount('streak');
    a._banSignalCount = 2;
    a._banSignalAt = Date.now();
    markAccountReauthenticated(a.id, { apiKey: 'devin-session-token$fresh', via: 'email_code' });
    const live = getAccountInternal(a.id);
    assert.equal(live._banSignalCount, 0);
    assert.equal(live._banSignalAt, 0);
  });

  it('a successful login may install the SAME key (the login is the proof)', () => {
    const a = newAccount('same-key-proof');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    markAccountReauthenticated(a.id, { apiKey: a.apiKey, via: 'password', allowSameKey: true });
    assert.equal(getAccountInternal(a.id).status, 'active');
  });
});

describe('persistence', () => {
  it('round-trips status + evidence through serialize/deserialize', () => {
    const a = newAccount('persist');
    markNeedsReauth(a.id, { source: 'liveness', code: 'UNAUTHORIZED' });
    const raw = __serializeAccounts().find((row) => row.id === a.id);
    assert.equal(raw.status, 'reauth');
    assert.ok(raw.reauth && raw.reauth.at > 0);
    const restored = __deserializeAccount(raw);
    assert.equal(restored.status, 'reauth');
    assert.equal(restored.reauth.source, 'liveness');
    assert.equal(restored.reauth.code, 'UNAUTHORIZED');
  });

  it('drops a malformed evidence record but keeps the status', () => {
    const restored = __deserializeAccount({
      id: 'broken', email: 'broken@example.invalid', apiKey: 'devin-session-token$x',
      status: 'reauth', reauth: { at: 'not-a-number', source: 'evil', code: 42 }, addedAt: Date.now(),
    });
    assert.equal(restored.status, 'reauth', 'the status is the bit — it must survive');
    assert.equal(restored.reauth, undefined, 'unusable evidence is dropped, not rendered');
  });

  it('does not persist evidence for a healthy account', () => {
    const a = newAccount('healthy');
    a.reauth = { at: Date.now(), source: 'request', code: 'UNAUTHORIZED' };
    const raw = __serializeAccounts().find((row) => row.id === a.id);
    assert.equal(raw.reauth, undefined);
  });
});

describe('list surface', () => {
  it('counts reauth separately and includes it in flagged', () => {
    const a = newAccount('stats');
    newAccount('stats-healthy');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    const stats = getAccountListStats();
    assert.equal(stats.reauth, 1);
    assert.equal(stats.banned, 0);
    assert.ok(stats.flagged >= 1);
    assert.equal(getAccountCount().reauth, 1);
  });

  it('status=reauth filters to exactly those rows', () => {
    const a = newAccount('filter');
    newAccount('filter-healthy');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    const rows = getAccountList({ status: 'reauth' });
    assert.deepEqual(rows.map((r) => r.id), [a.id]);
    assert.equal(rows[0].state, 'reauth');
    assert.equal(rows[0].reauth.source, 'request');
  });

  it('filter=flagged returns it', () => {
    const a = newAccount('flagged');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    assert.ok(getAccountList({ filter: 'flagged' }).some((r) => r.id === a.id));
  });

  it('never exposes the key in the reauth evidence', () => {
    const a = newAccount('leak');
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    const row = getAccountList({ status: 'reauth' })[0];
    assert.equal(JSON.stringify(row.reauth).includes(a.apiKey), false);
  });
});

describe('clearNeedsReauth', () => {
  it('only acts on a reauth account', () => {
    const a = newAccount('clear-noop');
    assert.equal(clearNeedsReauth(a.id), false);
    markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' });
    assert.equal(clearNeedsReauth(a.id, { reason: 'test' }), true);
    assert.equal(getAccountInternal(a.id).status, 'active');
    assert.equal(clearNeedsReauth(a.id), false);
  });

  it('does not overwrite an operator disable', () => {
    const a = newAccount('clear-disabled');
    setAccountStatus(a.id, 'disabled');
    assert.equal(markNeedsReauth(a.id, { source: 'request', code: 'UNAUTHORIZED' }), false);
    assert.equal(getAccountInternal(a.id).status, 'disabled');
  });
});

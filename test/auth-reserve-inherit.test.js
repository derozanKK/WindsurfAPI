// V-17 (audit CORE-004) — the per-account on-demand reserve has a documented
// third state: `onDemandReserve: null` = "inherit the global runtime-config
// default" (setAccountSpendPolicy's own contract, and the dashboard's
// `reserveOverride: null` display). `Number(null) === 0` and `Number('') === 0`,
// so the old `Number.isFinite(Number(x))` guard silently converted inherit into
// an EXPLICIT zero reserve on resolve, on save and on load: a configured global
// floor of $25 became "spend the balance to the last cent", and every save
// materialized the corruption into accounts.json.
//
// Invariant pinned here: only an explicit finite number is a reserve. null /
// undefined / '' are "no override", and that meaning survives a serialize →
// deserialize round trip.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey, removeAccount, applyQuotaSnapshot, setAccountSpendPolicy,
  getAccountSpendState, __serializeAccounts, __deserializeAccount,
} from '../src/auth.js';

const created = [];
const ENV_KEYS = ['WINDSURFAPI_ON_DEMAND_RESERVE_USD', 'WINDSURFAPI_SPEND_ON_DEMAND'];
const savedEnv = {};

function add(label) {
  const account = addAccountByKey(
    `v17-key-${Date.now()}-${created.length}-${Math.random().toString(36).slice(2)}`,
    label,
  );
  created.push(account.id);
  return account;
}

function persisted(account) {
  const record = __serializeAccounts().find(a => a.apiKey === account.apiKey);
  assert.ok(record, 'account is serialized');
  return record;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
  while (created.length) removeAccount(created.pop());
});

describe('V-17 — on-demand reserve: null means inherit, never zero', () => {
  it('reserve:null round-trips as inherit and is not coerced to zero', () => {
    const acct = add('v17-roundtrip');
    setAccountSpendPolicy(acct.id, { reserve: null });
    assert.equal(acct.onDemandReserve, null, 'clear leaves the in-memory override absent');

    const record = persisted(acct);
    assert.equal(Object.hasOwn(record, 'onDemandReserve'), false,
      'an inherited reserve is not materialized into accounts.json as an explicit 0');
    assert.equal(__deserializeAccount(record).onDemandReserve, null,
      'a restart must not turn inherit into an explicit zero override');

    // Older/hand-edited files can still carry the null explicitly.
    assert.equal(__deserializeAccount({ apiKey: 'k1', onDemandReserve: null }).onDemandReserve, null,
      'persisted null stays inherit');
    assert.equal(__deserializeAccount({ apiKey: 'k2', onDemandReserve: '' }).onDemandReserve, null,
      'an empty string is absence, not zero');
    assert.equal(__deserializeAccount({ apiKey: 'k3' }).onDemandReserve, null,
      'an absent field is inherit');
  });

  it('an inherited reserve resolves to the configured global floor (not zero)', () => {
    savedEnv.WINDSURFAPI_ON_DEMAND_RESERVE_USD = process.env.WINDSURFAPI_ON_DEMAND_RESERVE_USD;
    process.env.WINDSURFAPI_ON_DEMAND_RESERVE_USD = '25';
    const acct = add('v17-inherit-global');
    setAccountSpendPolicy(acct.id, { reserve: null }); // the documented "clear" state
    acct.credits = { balance: 10 };          // under the $25 global floor
    const now = 20_000_000;

    const state = getAccountSpendState(acct, now);
    assert.equal(state.reserve, 25, 'null override inherits the global reserve of $25');
    assert.equal(state.reserveOverride, null, 'the dashboard reports "inherit", not an override of 0');

    applyQuotaSnapshot(acct, 0, now);        // included quota dry, balance under the floor
    assert.ok(acct.quotaResetAt > now,
      'a balance under the inherited floor is dry → cooled (never burned to zero)');
  });

  it('an explicit zero reserve still means zero (control)', () => {
    savedEnv.WINDSURFAPI_ON_DEMAND_RESERVE_USD = process.env.WINDSURFAPI_ON_DEMAND_RESERVE_USD;
    process.env.WINDSURFAPI_ON_DEMAND_RESERVE_USD = '25';
    const acct = add('v17-explicit-zero');
    acct.credits = { balance: 10 };
    setAccountSpendPolicy(acct.id, { reserve: 0 });

    const state = getAccountSpendState(acct, 20_100_000);
    assert.equal(state.reserve, 0, 'an explicit numeric zero beats the global floor');
    assert.equal(state.reserveOverride, 0);

    const record = persisted(acct);
    assert.equal(record.onDemandReserve, 0, 'an explicit zero IS persisted');
    assert.equal(__deserializeAccount(record).onDemandReserve, 0,
      'an explicit zero survives the round trip');

    applyQuotaSnapshot(acct, 0, 20_100_000);
    assert.ok(!acct.quotaResetAt, 'reserve 0 + funded balance keeps serving (historical default)');
  });

  it('a real numeric override survives the round trip (control)', () => {
    const acct = add('v17-numeric');
    setAccountSpendPolicy(acct.id, { reserve: 12.5 });
    const record = persisted(acct);
    assert.equal(record.onDemandReserve, 12.5);
    assert.equal(__deserializeAccount(record).onDemandReserve, 12.5);
    assert.equal(__deserializeAccount({ apiKey: 'k4', onDemandReserve: '7.5' }).onDemandReserve, 7.5,
      'a numeric string from the dashboard form still parses');
  });

  it('non-numeric input is rejected instead of being coerced to zero', () => {
    const acct = add('v17-garbage');
    setAccountSpendPolicy(acct.id, { reserve: null }); // documented inherit state
    for (const bad of [false, true, 'false', 'abc', [], {}, NaN, Infinity]) {
      setAccountSpendPolicy(acct.id, { reserve: bad });
      assert.equal(acct.onDemandReserve, null,
        `${JSON.stringify(bad)} must not become an explicit reserve (Number(false) === 0)`);
    }
    assert.equal(__deserializeAccount({ apiKey: 'k5', onDemandReserve: false }).onDemandReserve, null,
      'a persisted boolean is not a reserve');
  });
});

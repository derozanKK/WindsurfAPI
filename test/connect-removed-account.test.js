// A removed account's late verdict must not land on whoever holds its key now.
//
// finalizeConnectAccount resolves the account's live credential through its
// immutable id, but `currentApiKeyForId(id, fallback)` answers with the
// acquire-time snapshot when the id is gone. A request can outlive its account
// (the dashboard deletes/replaces it while the stream is in flight) and the
// replacement can legitimately be created with the SAME synthetic key — so the
// fallback re-keyed the verdict onto the replacement. A late UNAUTHORIZED then
// charged the new account's error budget; a late success cleared it.
//
// The outcome belongs to the removed identity: it must be dropped, not
// re-targeted. These are behaviour tests against the real finalizer.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAccountByKey, removeAccount, getAccountInternal } from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';

const createdIds = [];

function seed(label, apiKey) {
  const key = apiKey || `devin-session-token$removed-${label}-${Math.random().toString(36).slice(2)}`;
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
}

function syntheticError(code) {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

afterEach(() => {
  while (createdIds.length) removeAccount(createdIds.pop());
});

describe('late verdict for a removed account', () => {
  it('late_outcome_for_removed_account_does_not_penalize_recreated_account', () => {
    const a = seed('removed-a');
    const key = a.apiKey;
    // What the handler holds while the request is in flight: an acquire-time
    // value snapshot ({ id, apiKey }), not the pool object.
    const snapshot = { id: a.id, apiKey: key };
    getAccountInternal(a.id)._inflight = 1; // mimic the acquire

    assert.equal(removeAccount(a.id), true, 'precondition: A was removed mid-request');

    const b = seed('recreated-b', key);
    assert.notEqual(b.id, a.id, 'precondition: B is a different identity');
    assert.equal(b.apiKey, key, 'precondition: B was created with the same synthetic key');

    finalizeConnectAccount(snapshot, {
      model: 'swe-1-6-slow',
      startTime: Date.now() - 5,
      err: syntheticError('UNAUTHORIZED'),
    });

    const live = getAccountInternal(b.id);
    assert.equal(live.errorCount || 0, 0, "A's late 401 must not charge B's error budget");
    assert.equal(live.status, 'active', 'B stays in rotation');
    assert.equal(live.rateLimitedUntil || 0, 0, 'no cooldown written onto B');
    assert.equal(live.quotaResetAt || 0, 0, 'no quota cooldown written onto B');
    assert.equal(live.internalErrorStreak || 0, 0, 'no internal-error streak written onto B');
    assert.equal(getAccountInternal(a.id), null, 'A stays gone');
  });

  it('control: the same late 401 still charges an account that was not removed', () => {
    const a = seed('kept-a');
    const snapshot = { id: a.id, apiKey: a.apiKey };
    getAccountInternal(a.id)._inflight = 1;

    finalizeConnectAccount(snapshot, {
      model: 'swe-1-6-slow',
      startTime: Date.now() - 5,
      err: syntheticError('UNAUTHORIZED'),
    });

    assert.equal(getAccountInternal(a.id).errorCount, 1,
      'the guard must be scoped to removed identities, not suppress auth faults');
    assert.equal(getAccountInternal(a.id)._inflight, 0, 'the slot is still released');
  });
});

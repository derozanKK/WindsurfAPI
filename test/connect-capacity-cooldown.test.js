// CAPACITY cooldown must actually gate DEVIN_CONNECT selection.
//
// Third occurrence of the structural trap #224 fixed for RATE_LIMITED: connect
// selection calls getApiKey(triedKeys, modelKey=null, callerKey, selector), and
// isRateLimitedForModel only consults _modelRateLimits when modelKey is truthy —
// so ANY model-scoped cooldown was invisible to the connect path and the pool
// re-picked the throttled account for the throttled model on the very next turn.
//
// Unlike #224 the fix is NOT to go account-wide (that benches a healthy account
// for every other model, which the CAPACITY branch explicitly avoids): the
// cooldown is written under the connect SELECTOR and selection checks that
// dimension too.

// ⚠️ sticky-session.js reads STICKY_SESSION_ENABLED into a module-load `const`
// (src/account/sticky-session.js:73) and auth.js statically imports it (:14), so the
// env has to be set BEFORE the first import of either — every src import below must
// stay dynamic for exactly that reason. This file used to set the env inside the
// sticky test body, after auth.js had already frozen the const to false: the guard
// `if (!sticky.isStickyEnabled()) return;` then returned before a single assertion ran
// (measured: the case took 0.65ms and never reached its body, vs 5.7ms once the env is
// armed ahead of the import). The precondition assert inside the case now fails loudly
// if that ordering is ever broken again.
process.env.STICKY_SESSION_ENABLED = '1';

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  addAccountByKey, removeAccount, getAccountInternal,
  getApiKey, releaseAccountById, markRateLimited,
} = await import('../src/auth.js');
const sticky = await import('../src/account/sticky-session.js');

const created = [];
function seed(label) {
  const a = addAccountByKey(`devin-session-token$cap-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  return getAccountInternal(a.id);
}
afterEach(() => { while (created.length) removeAccount(created.pop()); });

const SELECTOR = 'swe-1-6-slow';

describe('CAPACITY cooldown visibility on the connect path', () => {
  it('a selector-scoped cooldown removes the account from connect selection', () => {
    const hot = seed('overloaded');
    // Exactly what finalizeConnectAccount's CAPACITY branch now writes.
    markRateLimited(hot.apiKey, 60 * 1000, SELECTOR, 'c');

    // Connect selection shape: modelKey=null + the resolved selector.
    const picked = getApiKey([], null, null, SELECTOR);
    assert.equal(picked, null,
      'the only account is cooled for this selector — connect must not re-pick it');
  });

  it('the cooled account is still served for a DIFFERENT selector (model dimension kept)', () => {
    const hot = seed('overloaded-2');
    markRateLimited(hot.apiKey, 60 * 1000, SELECTOR, 'c');

    const picked = getApiKey([], null, null, 'some-other-selector');
    assert.ok(picked, 'a cooldown for one selector must not bench the account globally');
    assert.equal(picked.id, hot.id);
    releaseAccountById(picked.id);
  });

  it('connect selection prefers the healthy peer over the cooled one', () => {
    const hot = seed('cooled');
    const healthy = seed('healthy');
    markRateLimited(hot.apiKey, 60 * 1000, SELECTOR, 'c');

    const picked = getApiKey([], null, null, SELECTOR);
    assert.ok(picked, 'the healthy peer must serve');
    assert.equal(picked.id, healthy.id, 'must not hand back the capacity-throttled account');
    releaseAccountById(picked.id);
  });

  it('a sticky-bound account that is capacity-cooled falls through instead of being re-pinned', () => {
    // The sticky fast path must honor the selector dimension too — otherwise a
    // binding deterministically re-pins the exact overloaded account for the exact
    // overloaded selector, making the 60s window a guaranteed no-op.
    assert.equal(sticky.isStickyEnabled(), true,
      'precondition: STICKY_SESSION_ENABLED must be set before the first src import '
      + '(module-load const) — if this fails the case below would silently not run');

    sticky.resetAllBindings();
    const hot = seed('sticky-cooled');
    const healthy = seed('sticky-healthy');
    const caller = 'api:capacitycapacitycapacitycapacity:user:u1';
    // Key shape matters: bindConnectSticky writes `(callerKey, modelKey=null,
    // selector)` — bindingKey() is `caller\0*\0<selector>`, and the connect
    // acquisition looks the SAME selector up. Binding with selector=null here
    // writes `caller\0*\0*`, which the connect lookup can never resolve: the
    // fast path is then never entered and the case passes for the wrong reason.
    sticky.setStickyBinding(caller, null, hot.id, hot.apiKey, SELECTOR);

    // Positive control: with no cooldown the binding IS the answer, so the
    // fall-through asserted below is caused by the selector cooldown and not by a
    // binding that never resolves (wrong key shape / sticky path never entered).
    // `_sticky` is set only by the sticky fast path (auth.js:2071), so it proves
    // this acquisition went through the code under test rather than normal selection.
    const pinned = getApiKey([], null, caller, SELECTOR);
    assert.equal(pinned?._sticky, true, 'precondition: the live binding answered this acquisition');
    assert.equal(pinned.id, hot.id, 'precondition: the live binding wins selection');
    releaseAccountById(pinned.id);

    markRateLimited(hot.apiKey, 60 * 1000, SELECTOR, 'c');

    const picked = getApiKey([], null, caller, SELECTOR);
    assert.ok(picked, 'must still serve via normal selection');
    assert.equal(picked.id, healthy.id, 'binding must not survive a selector cooldown');
    releaseAccountById(picked.id);
  });
});

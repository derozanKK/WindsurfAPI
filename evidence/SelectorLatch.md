# SelectorLatchFix — reviewer F1/F2 and classifier narrowing

Lane: `SelectorLatchFix` · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w70-latch`
Branch: `fix/selector-latch` · base: `0c8b689` (`release/3.10.0`) · no push, no tag.

---

## 1. F1 — a late old-credential denial must not latch the new credential

**Defect (base).** `finalizeConnectAccount()` resolves `apiKey = currentApiKeyForId(acct.id, acct.apiKey)`
(the LIVE key) and passes it to `markSelectorIneligible()`. The handler already computes
`credentialCurrent` for every other auth/health verdict, but the `SELECTOR_NOT_ELIGIBLE` arm ignored it.
An attempt that presented key `A-old`, rotated to `A-new` mid-flight, and then received the upstream
denial wrote `_selectorIneligible[X]` onto the account — i.e. the old epoch's verdict became the new
credential's availability state. With no peer the selector then had no candidate at all.

**Fix.** `src/handlers/chat.js:2694-2703` passes the already-captured epoch test:
`markSelectorIneligible(apiKey, selector || model, { credentialCurrent })`.
`src/auth.js:2112-2117` returns `false` before touching `_selectorIneligible` when the credential is
stale. `bumpConnect('selector_ineligible')` still runs unconditionally — the observation is counted;
only the availability write is skipped.

**Test.** `test/connect-selector-scope.test.js` →
`late_old_selector_denial_must_not_override_new_credential_success`
(rotate via `markAccountReauthenticated`, success on the new key, then the old attempt's denial;
asserts `latched=false`, account `active`, metric +1, and `getApiKey(X)` still returns A after the
peer is removed).

## 2. F2 — the latch must ask the scheduler's own admission question

**Defect (base).** `markSelectorIneligible()` re-implemented a near-copy of the scheduler filter:
`status`, entitlement, latch, cooldown, RPM. It omitted `isAccountInMaintenance()` and
`isInflightCapped()`. A peer that was in maintenance / at its per-account in-flight cap therefore
counted as a takeover candidate, the rejected account was latched, and the next `getApiKey()` had no
candidate at all (empty pool → queue/504) while the rejected account sat unselectable.

**Fix.** `src/auth.js:2055-2090` adds `isAdmittedForRequest(account, { modelKey, connectSelector,
now, inflightCap, excludeKeys })` — one conjunction covering status, request exclusions, maintenance
(account + language-server), cooldown/selector latch, RPM window, in-flight cap, and tier/entitlement.
It is used by:

* `markSelectorIneligible()` (`:2126-2127`) — the peer test;
* `getApiKey()`'s sticky arm (`:2946-2952`);
* `getApiKey()`'s hard filter (`:3024-3034`).

It is **side-effect free**: `isCooledForRequestReadOnly()` and `rpmHistoryCount()` are read-only twins
of `isCooledForRequest()` / `pruneRpmHistory()` (no expired-entry deletion, no reservation token, no
`_inflight` bump, no maintenance slot). `getApiKey()` keeps its own housekeeping (`pruneRpmHistory`,
reservation push, `_inflight++`) only after admission. No `getApiKey()` call is used for probing.

**Tests** (`test/connect-selector-scope.test.js`):

* `selector_latch_requires_a_peer_admitted_by_scheduler_maintenance_filter` — peer holds
  `_maintenance=1`; no latch, and A stays selectable.
* `selector_latch_requires_a_peer_admitted_by_scheduler_inflight_filter` — peer is at
  `DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT=1`; no latch, A stays selectable.

Both first assert the scheduler already skips the peer, so the tests pin the shared premise rather
than a latch-only special case.

## 3. Classifier — account-scoped wording only

`src/devin-connect.js:2334` narrowed from
`(this|the)? (model|selector) … (no longer|not) (available|entitled|enabled|offered) (for|to|on) your (account|plan|tier|subscription|workspace)`
to
`(this|the)? (model|selector)\b … \bno longer available for your account\b`.

The broad form preempted the `/upgrade` arm, so an explicit tier wall
(`This model is no longer available for your plan. Please /upgrade …`) became
`SELECTOR_NOT_ELIGIBLE` — failover-eligible and latchable — instead of `MODEL_BLOCKED`, which is
deliberately excluded from failover because every account of that tier hits it. Only the measured
account form is claimed now; plan/tier/subscription/workspace are not evidence about one account.

Test: `test/connect-selector-scope.test.js` → `an explicit tier wall stays MODEL_BLOCKED (account-only
branch does not preempt it)` (tier-wall + `/upgrade` → `MODEL_BLOCKED`; plan/workspace variants →
not `SELECTOR_NOT_ELIGIBLE`).

## 4. Red before (base `0c8b689`, same test file copied into a throwaway worktree)

```
$ node --import ./test/setup-env.mjs --test --test-name-pattern="late_old_selector_denial|selector_latch_requires_a_peer|explicit tier wall" test/connect-selector-scope.test.js
✖ an explicit tier wall stays MODEL_BLOCKED (account-only branch does not preempt it)
✖ late_old_selector_denial_must_not_override_new_credential_success
✖ selector_latch_requires_a_peer_admitted_by_scheduler_maintenance_filter
✖ selector_latch_requires_a_peer_admitted_by_scheduler_inflight_filter
ℹ tests 4  ℹ pass 0  ℹ fail 4

AssertionError: a plan/tier noun plus /upgrade is a tier wall, not evidence about one account
AssertionError: the old epoch's denial must not latch the NEW credential — it may still serve this selector
AssertionError: the only peer is in maintenance — latching A would empty the pool
AssertionError: the capped peer cannot take over, so latching A would leave no candidate
```

## 5. Green after (this branch)

```
$ node --import ./test/setup-env.mjs --test --test-name-pattern="late_old_selector_denial|selector_latch_requires_a_peer|explicit tier wall" test/connect-selector-scope.test.js
✔ an explicit tier wall stays MODEL_BLOCKED (account-only branch does not preempt it)
✔ late_old_selector_denial_must_not_override_new_credential_success
✔ selector_latch_requires_a_peer_admitted_by_scheduler_maintenance_filter
✔ selector_latch_requires_a_peer_admitted_by_scheduler_inflight_filter
ℹ tests 4  ℹ pass 4  ℹ fail 0

$ node --import ./test/setup-env.mjs --test test/connect-selector-scope.test.js
ℹ tests 21  ℹ suites 7  ℹ pass 21  ℹ fail 0
```

Regression runs (all green):

| command | result |
|---|---|
| `node --test test/connect*.test.js test/devin-connect*.test.js` (53 files) | `ℹ tests 1198  ℹ pass 1198  ℹ fail 0` |
| `node --test test/auth-*.test.js test/account-*.test.js test/rate-*.test.js test/chat-*.test.js test/handler-*.test.js` | `ℹ tests 228  ℹ pass 228  ℹ fail 0` |
| `node --test test/rate-risk.test.js test/connect-sticky-affinity.test.js test/connect-sticky-e2e.test.js test/connect-dimension-behaviour.test.js test/connect-catalog-delatch.test.js` | `ℹ tests 57  ℹ pass 57  ℹ fail 0` |
| `node --test test/connect-error-blame.test.js test/connect-dimension-guard.test.js test/connect-entitlement.test.js test/devin-connect-pool.test.js` | `ℹ tests 42  ℹ pass 42  ℹ fail 0` |

## 6. Limits / not run in this lane

* Full `npm test` / `npm run gate` — `[UNVERIFIED]` here; main agent runs the integration gate.
* Mutation harness (`npm run mutate`) — `[UNVERIFIED]`; no mutation spec anchors reference the changed
  lines (grep for `markSelectorIneligible` / `isSelectorIneligible` / `pruneRpmHistory` /
  `isCooledForRequest` / the classifier phrase across `test/mutations` and `test/*.json` returned no
  hits).
* `scripts/spec-baseline-check.mjs` — **pass**: `88 spec(s) measured, 0 drift, 0 untrustworthy`
  (139.56 s).
* Behaviour change note: the `not available for your account` variant and the plan/tier nouns no longer
  classify as `SELECTOR_NOT_ELIGIBLE`; only the measured phrase does. This is the brief's requested
  narrowing, not an oversight.

## 7. Reproduce

```
cd .../w70-latch
node --import ./test/setup-env.mjs --test test/connect-selector-scope.test.js
node --import ./test/setup-env.mjs --test test/connect*.test.js test/devin-connect*.test.js
node --import ./test/setup-env.mjs --test test/auth-*.test.js test/account-*.test.js test/rate-*.test.js test/chat-*.test.js test/handler-*.test.js
```

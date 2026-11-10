# ChatP2Identity — ReviewChatCore P2-1 + P2-2: Cascade/connect identity writes follow the account id

Lane: `ChatP2Identity` · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w97-chatp2a`
Branch: `fix/chat-p2-identity` · base: `af7badb` (`release/3.10.0`) · no push, no tag.
Report under fix: `evidence/ReviewChatCore.md` §P2-1, §P2-2 (audit of `src/handlers/chat.js` @ `8f7f19b`).

Scope taken: **P2-1 and P2-2 only**. P2-3/4/5 are `ChatP2Lifecycle` (w98-chatp2b); P2-6/P2-7 were
not assigned to either lane and are untouched here (peer-confirmed over `agent://`).

---

## 1. Defect

Every `mark*`/`report*`/`updateCapability` helper in `auth.js` resolves its account with
`accounts.find(a => a.apiKey === apiKey)` (`reportError` 4021, `reportSuccess` 4081,
`markRateLimited` 3609, `reportInternalError` 4298, `reportBanSignal` 4375, `reportDeadToken` 4328,
`updateCapability` 5251). The connect lane already resolves the **live** key from the immutable id
before each write (`currentApiKeyForId`, chat.js:2593, REF-1/REF-2) and drops credential-scoped
verdicts when the presented key is no longer current (`credentialEpochCurrent`, 2551-2556). The
Cascade arms and the connect dead-token arm still passed the **acquire-time snapshot**:

| site (base) | write | effect when the key rotates mid-flight |
|---|---|---|
| 5970-5971 | `reportSuccess`, `updateCapability(..., true)` | success reset + capability update dropped |
| 6102-6119 | `reportError`, `markRateLimited`, `reportInternalError`, `reportBanSignal`, `updateCapability(..., false)` | a genuine 429 cooldown dropped → the pool re-picks the throttled account (the #224 shape) |
| 7699-7700 | stream `reportSuccess`, `updateCapability(..., true)` | same as 5970 |
| 7925-7965 | stream `reportError`, `markRateLimited`, `reportInternalError`, `reportBanSignal`, `updateCapability(..., false)` | same as 6102 |
| 4316 / 4533 | `reportDeadToken(acct.apiKey)` | the `'d'` health event — the only record that the token came back dead — is dropped |

Rotation trigger is ordinary: dashboard token paste-over, or a connect-path `reLoginAccount` on the
same shared account (`account.apiKey` is rewritten in place, auth.js:2690-2695). The account serves
both backends.

## 2. Changes

| file | line (after) | change |
|---|---|---|
| `src/handlers/chat.js` | 5980-5983 | non-stream success: `liveApiKey = currentApiKeyForId(accountId, apiKey)`; `updateCapability(liveApiKey, …)` always; `reportSuccess(liveApiKey)` gated on `credentialEpochCurrent({id, apiKey}, apiKey)` |
| `src/handlers/chat.js` | 6118-6137 | non-stream failure: cooldown `markRateLimited(liveApiKey, …)` (account-level, ungated); `reportError` / `reportInternalError` / `reportBanSignal` on `liveApiKey` **gated** on the epoch; `updateCapability(liveApiKey, …, false)` ungated |
| `src/handlers/chat.js` | 7721-7724 | stream success: same split via `currentApiKeyForId(currentAccountId, currentApiKey)` |
| `src/handlers/chat.js` | 7952-7994 | stream failure: same split |
| `src/handlers/chat.js` | 4316, 4533 | `reportDeadToken(currentApiKeyForId(acct.id, acct.apiKey))` on both connect dead-token arms |
| `test/chat-p2-identity-rotation.test.js` | new, 12 tests | red-first behaviour tests (see §3/§4) |
| `test/session-reauth-hooks.test.js` | 60 | the wiring pin matches the new dead-token expression (still asserts the probe follows the verdict) |

No new env var, no config knob, no signature change, no new top-level helper: `currentApiKeyForId`
and `credentialEpochCurrent` already exist in this file and are used by `finalizeConnectAccount`.

### Why `reportSuccess` stays epoch-gated (and `markRateLimited` does not)

The report's fix shape says "keeping the credential-epoch split for the verdict-scoped arms". I
mirrored `finalizeConnectAccount` exactly (2593/2594, 2644/2646/2668, 2802-2807):

* **account-level, ungated** — `markRateLimited` (a 429 cooldown is a fact about the account's
  quota window) and `updateCapability` (a model-capability record; the report names capability
  updates as belonging to the id).
* **credential-scoped, gated** — `reportError`, `reportInternalError`, `reportBanSignal`,
  `reportSuccess`. An auth/ban verdict from a retired key must not charge the fresh one, and an
  old-key success does not prove the new key works (the finalizer's own comment, 2803-2806).

For the *success* arm the account-level half of the fix is `updateCapability` — it now lands by id.
`reportSuccess`'s reset lands on the next turn that succeeds with the live key. This is a deliberate
asymmetry-free choice: the connect lane gates the same call, and `errorCount` only drives eviction
(`auth.js:4035`), never selection order, so a deferred reset cannot demote the account in the pool.

### Non-goal (recorded, not a regression)

The Cascade arms do not replicate `finalizeConnectAccount`'s **removed-account** drop
(`getAccountInternal` + return, chat.js:2573-2579). P2-1 is scoped to rotation, and
`currentApiKeyForId(removedId, snapshot)` returns the snapshot, so a removed account behaves exactly
as before (lookup miss → no-op). A replacement created with the same synthetic key would still be
reachable by the fallback — same exposure as base, not introduced here.

## 3. Red before (base `af7badb`, source fix stashed, tests present)

```
$ git stash push -- src/handlers/chat.js
$ node --import ./test/setup-env.mjs --test test/chat-p2-identity-rotation.test.js
ℹ tests 12   ℹ suites 3   ℹ pass 6   ℹ fail 6   ℹ duration_ms 11807
✖ non-stream: a 429 that races the rotation still cools the account that failed
✖ non-stream: a success that races the rotation records the capability on the account
✖ stream: a 429 that races the rotation still cools the account that failed
✖ stream: a success that races the rotation records the capability on the account
✖ stream: the 'd' health event lands on the rotated account, not the snapshot
✖ non-stream: the 'd' health event lands on the rotated account, not the snapshot
```

Each failure is the intended one: `_modelRateLimits` / `capabilities` / `_health.dead` is empty on
the account that actually served the turn (`0 !== 1`, `actual: false`). Full log:
`evidence/p2id-red.log`.

The 6 passing tests on base are the deliberate epoch-discipline controls — they pin behaviour that
must survive the fix, on both arms: a 401 on the **current** credential still charges the account;
an old-key 401 does not charge the new one; an old-key success does not clear the new one's budget.

## 4. Green after (this branch)

```
$ node --import ./test/setup-env.mjs --test test/chat-p2-identity-rotation.test.js test/session-reauth-hooks.test.js
ℹ tests 17   ℹ suites 5   ℹ pass 17   ℹ fail 0   ℹ duration_ms 12352
```

Scenario coverage:

* **two accounts, A rotates mid-turn** — every test seeds A and B; the pool handout order is fixed
  by the test (`waitForAccount` → `acquireAccountByKey`), so A serves attempt 1 and B is the peer.
* **cooldown lands on A, not B** — non-stream and stream: A gets a model cooldown + throttle health
  event, B has none, and the peer completes the turn (`[DONE]` on the stream).
* **capability lands on A, not B** — non-stream and stream success after rotation:
  `capabilities[*] = {ok:true, reason:'success'}` on A, B untouched.
* **dead token lands on A, not B** — connect stream (`streamChatCompletion`) and non-stream
  (`toChatCompletion`) rotate A then throw `UNAUTHORIZED`; the failover hop completes the turn on
  the live credential, and A's health window carries exactly one `'d'` event while B carries none.
  The liveness probe is stubbed (`__setReloginDeps({checkSessionLiveness})`) so the test never
  reaches the network.

### Mutation check (the new gates are load-bearing, not decorative)

| mutation | tests that must fail | measured |
|---|---|---|
| drop `credentialCurrent` from `reportSuccess` on **both** arms | the two `old-key success` controls | 2 fail / 2 |
| drop `credentialCurrent` from `reportError` on **both** arms | the two `old-key auth failure` controls | 2 fail / 2 |

Both mutations were applied to the real file, the pattern-filtered tests run, then the source
restored (final `git diff --stat` unchanged at 63 lines). The id-resolution half needs no separate
mutation: §3 is exactly that mutation (base passes the snapshot) and it fails 6/6 targeted tests.

## 5. Regression runs

```
$ node --import ./test/setup-env.mjs --test test/chat*.test.js test/connect*.test.js test/auth*.test.js test/devin-connect*.test.js
ℹ tests 1323   ℹ suites 201   ℹ pass 1323   ℹ fail 0   ℹ duration_ms 54602
```
(`evidence/p2id-suites.log`; the report's base run was 1311 — the +12 are this lane's new tests.)

Full suite (`node scripts/run-tests.mjs`, 539 files; summary + both failure traces kept in
`evidence/p2id-full-failures.log`, the raw 2 MB log was not retained):

```
ℹ tests 6613   ℹ suites 1250   ℹ pass 6514   ℹ fail 2   ℹ skipped 97   ℹ duration_ms 333363
✖ with the knob OFF, the same scenario rotates to the substitute (default unchanged)
✖ a wait longer than the budget gives up and rotates rather than stalling
```

Both failures are in `test/sticky-queue-on-pin.test.js` and are **pre-existing load-sensitive
fixture races, not this lane**:

* that file never calls the changed code — it imports `chat.js` only for `__testing.waitForAccount`
  (verified: no `handleChatCompletions`/`streamResponse`/`nonStreamResponse` reference in it);
* it passes 26/26 standalone on this branch (20.7 s);
* under concurrent load (3 copies in parallel) the same two tests fail 3/3 runs with inflated
  durations (6.8–11.7 s vs 2.6–3.6 s) — `evidence/p2id-sticky-load-*.log`;
* **the same failure reproduces on base source** (`git stash` of `src/handlers/chat.js`), 2 runs:
  1× and 2× failures of the same two tests — `evidence/p2id-sticky-base-*.log`. Root cause is the
  fixture's wall-clock model: `blockOnRpm()` fills the 60 s RPM window stamped `now - 59.9 s`, so a
  slowed run lets entries age out of the window and the pinned account becomes selectable again
  (the assertion then sees A where it expected the substitute B).

The `evidence/p2id-*.log` files are local, untracked run artifacts; every counter they support is
quoted verbatim above, and the red/green commands are re-runnable from §6.

## 6. Reproduce

```
cd C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w97-chatp2a
node --import ./test/setup-env.mjs --test test/chat-p2-identity-rotation.test.js
node --import ./test/setup-env.mjs --test test/chat*.test.js test/connect*.test.js test/auth*.test.js test/devin-connect*.test.js
```

Red re-derivation: `git stash push -- src/handlers/chat.js` → run the first command → 6 failures →
`git stash pop`.

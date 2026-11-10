# Billing identity across credential rotation — review #3

Lane: `BillingIdentityFix` · Worktree `w62-billingid` · Branch `fix/billing-identity` · Base `0dea7e2` (release/3.10.0)
No push, no tag.

## Finding (GPT-6-Pro review #3, `evidence/GPT6ProReview.md:108-131`)

> API key 在请求过程中轮换，会让成功流请求漏记账号账本 … `auth.js:3042` reservation 保存取得账号时的 API key；`auth.js:2279` `setAccountTokens()` 可以合法替换账号当前 key；`chat.js:3983` 首次成功 streaming 路径用 reservation 中的旧 key 调用 `recordAccountSpend()`；`auth.js:3992` 按当前 key 查找账号；`:3995` 找不到便直接返回。

Reproduced by the reviewer: rotate the key mid-stream, finish with usage 12 → account request ring 0, `_totalSpend.requests` 0; non-stream was correct because it resolved the current key by account id.

Requirement: **the immutable `accountId` owns the ledger; the rotatable secret only authenticates the network call.** A late failure from an old credential epoch must not penalize the new epoch.

## Root cause

`recordAccountSpend(apiKey, …)` used `accounts.find(a => a.apiKey === apiKey)`. A request holds the acquire-time reservation; `setAccountTokens()` / a background re-login can replace `account.apiKey` in place before the turn completes. The lookup then misses, `recordAccountSpend` returns early, and the successful turn disappears from the account ledger (global token stats still move, so the two views disagree).

## Changes

### `src/auth.js`

- `recordAccountSpend(identity, usage, opts)` (`:4087`) now takes an **attempt identity**: `{ accountId|id, apiKey, attemptId|reservationTimestamp }`, or a bare apiKey for env-token / detached paths.
- `resolveSpendAccount()` (`:4066`) resolves by id first. **A supplied id is authoritative**: when it does not resolve, the key is not tried (a credential that outlived its account may have been reused elsewhere).
- `spendAttemptId()` (`:4080`) derives the attempt id from the reservation timestamp; `recordAccountRequest()` (`:4006`) stores it on the ring row as `attemptId` for provenance.
- String apiKey input remains supported, so the existing env-token/detached fallback behavior is unchanged.

### `src/handlers/chat.js`

All production spend sites now pass identity, not a credential:

| Path | Site | Identity |
|---|---|---|
| connect stream (first success) | `:4021` | the reservation object `a` |
| connect stream (re-login retry) | `:4061` | `{ accountId: a.id, apiKey: freshKey, attemptId: a.reservationTimestamp }` |
| connect non-stream | `:4371` | the reservation `acct` |
| Cascade non-stream | `:5944` | `{ accountId, apiKey }` (new `accountId` parameter threaded from `acct.id`) |
| Cascade stream | `:7619` | the reservation `acct` |
| Cascade stream, detached resume | `:7623` | `{ accountId: resumeBillingAccountId, apiKey: ownerKey }` |

Credential-epoch guard:

- `credentialEpochCurrent(acct, credentialKey)` (`:2533`) compares the credential an attempt presented with the account's live key (same epoch test auth.js uses for credit refreshes/catalog syncs).
- `finalizeConnectAccount()` (`:2540`) accepts `credentialKey` (the key a re-login retry actually presented) and gates **credential-scoped** verdicts on epoch currency: `reportError`, `reportInternalError`, `reportSuccess`, and `reLoginAccount`. Account-level cooldowns (`QUOTA_EXHAUSTED`, `RATE_LIMITED`, `CAPACITY`) still land on the live account — REF-2 behavior preserved.
- Both handler re-login recovery paths (`:4052` stream, `:4283` non-stream) skip re-login when the 401 came from a retired credential. The failover loop then re-acquires the account under its live key (or moves on) without minting a third key.
- Re-login retry finalize calls pass `credentialKey: freshKey`, so a retry on the freshly minted key is still scored normally.

### Test

`test/billing-identity-rotation.test.js` (new, 6 tests):
1. **Exact reviewer scenario** — stream mocked at `__setConnectDeps`; real `setAccountTokens()` rotates the key mid-stream; stream finishes with usage 12 → ring `total === 1`, `summary.totalTokens === 12`, `_totalSpend.requests === 1`, `_totalSpend.totalTokens === 12`, client gets `[DONE]`.
2. Late `UNAUTHORIZED` from the retired credential after rotation → `errorCount 0`, status `active`, slot released.
3. Control: the same 401 on the current credential → `errorCount 1` (guard is epoch-scoped, not a blanket suppression).
4. Handler-level stale 401 with `DEVIN_CONNECT_AUTO_RELOGIN=1` and a fake login → `windsurfLogin` never called, the rotated key is not overwritten, the request recovers on the live key, `errorCount 0`.
5. `recordAccountSpend({ accountId, apiKey: stale, attemptId })` → row lands on the account, `attemptId` recorded.
6. Unknown `accountId` + a key that resolves elsewhere → no row (id authoritative).

## Red-before (base `0dea7e2` + new test only)

```
node --import ./test/setup-env.mjs --test test/billing-identity-rotation.test.js
✖ a streaming turn that finishes after the key rotated still bills the account
  AssertionError: exactly one ledger row for the turn — 0 !== 1
✖ a late 401 from the retired credential does not charge the new epoch
  AssertionError: the retired credential's failure must not charge the new key — 1 !== 0
✖ a stale 401 does not trigger a re-login that would rotate the fresh key
  AssertionError: a failure from the retired credential must not re-login the account — 1 !== 0
✖ resolves by accountId even when the key snapshot is stale
  AssertionError: 0 !== 1
ℹ tests 6 · pass 2 · fail 4
```

## Green-after

```
node --import ./test/setup-env.mjs --test test/billing-identity-rotation.test.js
ℹ tests 6 · pass 6 · fail 0
```

Consolidated regression (spend, finalize/epoch, connect handler, detach billing):
```
node --import ./test/setup-env.mjs --test \
  test/billing-identity-rotation.test.js test/auth-total-spend.test.js \
  test/account-dirty-retry.test.js test/connect-rate-table-wiring.test.js \
  test/dashboard-account-requests.test.js test/strict-usage-total.test.js \
  test/cascade-stream-account-spend.test.js test/connect-error-blame.test.js \
  test/connect-relogin-refcount.test.js test/connect-abort-cooldown.test.js \
  test/connect-capacity-cooldown.test.js test/connect-dimension-behaviour.test.js \
  test/connect-dimension-guard.test.js test/devin-connect-stream-lifecycle.test.js \
  test/devin-connect-failover.test.js test/connect-sticky-e2e.test.js \
  test/session-reauth-hooks.test.js test/sticky-queue-on-pin.test.js \
  test/devin-connect-pool.test.js test/s4-r5.ladder.test.js \
  test/detached-registry.test.js test/cascade-detach-lazy-resume.test.js \
  test/cascade-turn-snapshot-v2.test.js
ℹ tests 258 · pass 258 · fail 0
```

Wider sweep (`test/billing-*`, `test/dashboard-*`, `test/account-*`, `test/auth-*`):
```
ℹ tests 691 · pass 689 · fail 2
✖ test/dashboard-escape-callsites.test.js (2) — pre-existing on base, verified below
```

Additional handler batches (all files importing `__setConnectDeps`): 57/57 and 89/89 pass.

## Pre-existing failures (verified on base `integrate3100` @ `0dea7e2`, not caused by this lane)

- `test/connect-token-usage.test.js`: 2/4 fail on base (source regexes still expect `recordTokenUsage(_sr?.usage)` without the second `reqModelName` argument).
- `test/dashboard-escape-callsites.test.js`: 2/5 fail on base.

## Not verified / handoffs

- `[UNVERIFIED]` Mutation harness (`scripts/mutate-verify*.mjs`) cannot run on this Windows box: `mutation-harness-utils.mjs` requires git at a POSIX absolute path (`/usr/bin/git`, …). Red-before above is the equivalent defect re-introduction.
- **Cross-lane handoff**: `test/mutations/detach-p1-soak.json` M8's anchor embeds the old detached-billing call. It was reverted from this lane per ownership; the integration/detach lane must update the anchor tail from `recordAccountSpend(ownerKey, usage);` to `recordAccountSpend({ accountId: resumeBillingAccountId, apiKey: ownerKey }, usage);` or the mutation harness will report a missing anchor. All four chat.js anchors were checked to match exactly once with that one-line update.
- ABA edge: the epoch test compares key values, not a monotonic generation counter. A rotation away from and back to the same key value during one attempt would read as current. The codebase already uses key equality for the same class of guard (`isCurrentConnectCatalogAttempt`, credit refresh); a generation counter is the architecture-level follow-up, not this stopgap.
- `recordRequest()`'s `accountCounts` dimension is still a credential-prefix display key (documented in `auth.js`); it was left unchanged because it is not the spend ledger and the finding is scoped to ledger attribution.

## Verdict

The exact reviewer scenario is red on base and green with the fix. The ledger is owned by `accountId`; a rotated credential cannot lose attribution, and a late failure from a retired credential no longer charges or re-rotates the new epoch.

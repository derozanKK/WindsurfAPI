# Detach deadline (GPT review F1) — fix evidence (lane DetachDeadlineFix, worktree w72-deadline)

Branch `fix/detach-deadline` from `0c8b689` (release/3.10.0). No push, no tag.
Committed as `fix(detach): gate resume commits on live claim ownership`.

## Verdict

The reviewer's repro is fixed: with 150 ms of claim budget and a first
trajectory read delayed 450 ms, the response no longer completes with full
content + DONE while `serve=0`. The read is bounded by the remaining request
budget, ownership is checked after the await and at the replay/terminal
boundaries, and `release()` refuses a claim past its deadline regardless of
which cleanup observed it first. A completed turn whose claim dies during the
post-loop metadata RPC is still billed by the entry's stable account id (the
330-token settlement), but it is not reported as a success.

## Changes

### `src/detached-registry.js`

| Location | Change |
|---|---|
| `:490` `owns(key, token)` | New live-ownership predicate. A claim past `entry.deadline` is deleted by `deadline` and returns false; the delete is identity-checked and idempotent, so timer/sweep order cannot change the outcome. |
| `:514` `release()` | Checks `entry.deadline <= now()` before `served`/`running` handling. Both states return false and count exactly one `evict.deadline`; `serve`/`re_detach` stay 0. |
| `:573` `evict()` | A claimed entry past its deadline is counted as `deadline` whatever cause the caller passed (`resume_miss`, `capacity`, …). This keeps counters comparable across interleavings. |
| header `:23` | Documents that ownership ends at the deadline even before a timer/sweep observes it, and that the first observer counts the deadline eviction exactly once. |

### `src/client.js`

| Location | Change |
|---|---|
| `:63` `detachedClaimLostError()` | Typed error (`name=DetachedClaimLostError`, `type=upstream_deadline_exceeded`, `detachedClaimLost=true`) shared with the handler. |
| `:1163` `readTimeoutMs()` | Remaining-budget clamp for the trajectory reads. Applied to the turn read (`:1190`), the inline read (`:1232`) and the final sweep (`:1576`); `undefined` (grpcUnary's 30 s default) when no route budget exists. |
| `:1171` poll sleep | Sleeps at most the remaining budget and re-checks the deadline after the sleep, so a poll cannot start after the budget ended. |
| `:1199` after-await check | Calls `resumeTurn.ownsClaim()` after every awaited trajectory read, before cursors are touched or a byte is replayed. |
| `:1578` final-sweep check | Same ownership check after the idle final sweep, before top-up content is consumed. |

### `src/handlers/chat.js`

| Location | Change |
|---|---|
| `:6991` `replayDetachedPrefix` | Ownership check at the replay write boundary; throws `detachedClaimLostError` before the first replayed byte. |
| `:7230` `resumeTurn.ownsClaim` | Live predicate supplied to the producer (`resumeClaim` + `detachedRegistry.owns`). |
| `:7554` `settleUsage()` | Extracted accounting helper: `buildUsageBody` + `recordTokenUsage` + `recordAccountSpend` by `resumeBillingAccountId` (stable identity, survives key rotation) + `noteBilled()`. Used by the normal success path and the lost-claim path. |
| `:7577` terminal gate | `release(...,{state:'served'})` result is captured. On false: settle usage, record the request as failed, send an `upstream_deadline_exceeded` error frame, end without finish/DONE/cache/pool. |
| `:7992` failure classification | A `detachedClaimLost` error keeps its own message instead of the generic ~240 s provider-deadline text. |
| `:8101`, `:8158` failure tail | `claimLost` suppresses the synthetic `finish_reason:"stop"` and the `[DONE]` sentinel even when content was already emitted. |

### `docs/DETACH-ROLLOUT.md`

The gate-1 accounting contract now names the one allowed `billed_detached !=
serve` case: a completed upstream turn whose claim ended at the request
deadline is billed by stable owner id but is not served. The rollback stop
condition points at that exception instead of treating every mismatch as a
billing regression.

## Tests

Required by the brief:

- `test/cascade-detach-lazy-resume.test.js:1198`
  `claim_deadline_during_delayed_first_trajectory_read_never_commits_success_without_ownership`
  — 120 ms claim, 450 ms first read, turn cap 0: `serve` 0, one `evict.deadline`,
  no `[DONE]`, no replayed growth, lease released; in-time control serves 1 and
  bills 330.
- `test/detached-registry.test.js:235`
  `claim_release_after_deadline_is_independent_of_cleanup_order`
  — loops `served`/`running` × sweep-first/release-first: every interleaving is
  false, `serve=0`, `re_detach=0`, exactly one `evict.deadline`.

Additional pins for the other two gates:

- `test/cascade-detach-lazy-resume.test.js:1264`
  `claim_evicted_during_first_trajectory_read_never_replays` — the claim is
  evicted while the first read is in flight; the post-await check stops the
  producer before any frozen prefix byte reaches the client.
- `test/cascade-detach-lazy-resume.test.js:1305`
  `claim_deadline_after_last_read_still_settles_usage_without_committing_success`
  — the reads finish in time, the metadata RPC outlives the deadline; `serve` 0,
  `billed_detached` 1, owner spend 330, no `[DONE]`.

Harness additions: `cascadeUpstream` gained `metadataDelayMs` and a
`respondLater` guard for cancelled streams (the bounded read cancels the RPC,
so the fake server must not respond on a closed stream).

## Red-before (source reverted, tests kept)

```
git stash push -- src/
node --import ./test/setup-env.mjs --test \
  --test-name-pattern="claim_deadline|claim_evicted_during|claim_release_after_deadline" \
  test/cascade-detach-lazy-resume.test.js test/detached-registry.test.js
```

```
✖ claim_deadline_during_delayed_first_trajectory_read_never_commits_success_without_ownership
    AssertionError: no success sentinel may be written for a claim the registry no longer owns
    actual: false, expected: true
✖ claim_evicted_during_first_trajectory_read_never_replays
    AssertionError: not one byte of the frozen prefix may be replayed without ownership
    actual: false, expected: true
✖ claim_deadline_after_last_read_still_settles_usage_without_committing_success
    AssertionError: no success sentinel after the claim deadline
    actual: false, expected: true
✖ claim_release_after_deadline_is_independent_of_cleanup_order
    AssertionError: served/release-first: release must refuse
    actual: true, expected: false
ℹ tests 4  ℹ pass 0  ℹ fail 4
```

Full log: `…/windsurfapi-autonomous-20261022/evidence/DetachDeadlineFix-red.log`.

## Green-after

```
node --import ./test/setup-env.mjs --test \
  test/cascade-detach-lazy-resume.test.js test/detached-registry.test.js \
  test/cascade-turn-snapshot-v2.test.js test/docs-consistency-guard.test.js test/s4-r4.test.js
ℹ tests 113  ℹ pass 113  ℹ fail 0  ℹ skipped 0
```

Full suite (final bytes):

```
npm test
ℹ tests 6435  ℹ suites 1206  ℹ pass 6339  ℹ fail 0  ℹ skipped 96  ℹ duration_ms 52156.7
EXIT 0
```

`test/smoke-matrix.test.js` (re-run after the mutation-anchor fix): 1/1 pass,
`SMOKE-MATRIX SUMMARY: 137/137 flows passed` (the first full-suite run failed
only because the `s4-r4.json` DONE anchor had moved; the docs family flow
`docs.guard-passes-with-self-tests` was the 1 failed flow).

The full suite ran on the final source bytes. The doc-only amend
(`docs/DETACH-ROLLOUT.md`) was re-verified afterwards by
`test/docs-consistency-guard.test.js` and a fresh `test/smoke-matrix.test.js`
run (both green).

Logs: `…/evidence/DetachDeadlineFix-green.log` (focused) and
`…/evidence/DetachDeadlineFix-full-suite.log` (full suite).

## Mutation-spec maintenance

- `test/mutations/detach-p1-lease-deadline-addendum.json`,
  `detach-p1-m11-addendum.json`, `detach-p1-soak.json`: `expectBaselinePass`
  55 → 59. The three listed test files now pass 59 tests (4 new).
- `test/mutations/s4-r4.json`: the "Independent DONE stage is disabled" anchor
  moved to `if (emittedClientPayload && !claimLost) writeRaw(...)`.
- All mutation anchors in the specs were checked for exactly one occurrence;
  the repo's `docs-consistency-guard` test passes. The mutation campaign itself
  was not executed on this Windows host (the harness needs a POSIX git).

## Residual notes / unverified

- No live language server or production detach was exercised; the tests use the
  real handler/producer and a scripted loopback LS.
- A read cancelled by the remaining budget has no server usage to settle, so it
  is not billed (same policy as an abort). The 330-token settlement is preserved
  for a turn that completed upstream before its claim died — pinned by the
  metadata-race test.
- The deadline tests use a real 120 ms timer; they passed in the red run, the
  focused green run, the full suite and the smoke matrix.

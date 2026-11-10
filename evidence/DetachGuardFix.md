# Detach D1/D2 — fix evidence (lane DetachGuardFix, worktree w63-detachguard)

Branch `fix/detach-guard` from `0dea7e2` (release/3.10.0). No push, no tag.
Committed as `fix(detach): bound claims by deadline/token and refuse tool turns`.
Final tree: 6 files, no foreign content (`git status --short` below).

```
 M docs/DETACH-ROLLOUT.md
 M src/client.js
 M src/detached-registry.js
 M src/handlers/chat.js
 M test/cascade-detach-lazy-resume.test.js
 M test/detached-registry.test.js
```

## Verdict

D1 and D2 are fixed and pinned red-before / green-after:

- **D1** — TTL is now an admission bound only. A claimed entry is owned by its
  token until `release` or the original request `deadline`; TTL sweep and
  `lookup` never delete a claim. Every eviction is identity-checked: a token
  for a claim, the entry object for a running entry. A bare key cannot delete a
  same-key successor (ABA).
- **D2** — the handler's delivery ledger (`collectedToolCalls`) is part of
  admission. A turn that delivered any tool call — native bridge, emulated
  `<tool_call>` markup, NLU recovery, or a tail lift — is refused by the
  producer and by `detachHandle.admit`; a resumed turn that delivered a call is
  dropped (`resume_miss`) instead of being re-frozen.

## D1 changes — `src/detached-registry.js`

| Location | Change |
|---|---|
| `:220` `#armTimer` | Identity check against the current entry. Running → `ttl` or `deadline` (whichever bound fired); claimed → `deadline` with `entry.token`. |
| `:240` `#delete` | Refuses to delete a non-current entry (no double byte-subtraction, no successor deletion). |
| `:264` `sweepExpired` | Claimed entries are skipped for TTL and only cleaned at `deadline` (`evict.deadline`). Running entries: `ttl` first, then `deadline`. |
| `:400` `lookup` | Claimed entries are returned past TTL; only a passed `deadline` cleans them. Running entries expire on TTL or deadline. |
| `:443` `claim` | Unchanged admission check (TTL + deadline) plus a deadline timer; JSDoc now states the ownership transfer. |
| `:481` `release` | Re-detach re-arms at `min(expiresAt, deadline)`; served release still requires the token. |
| `:530` `evict` | Signature `evict(key, cause, identity)`. Claimed → must match `entry.token`; running → must be the entry object. A stale token or bare key returns false. |
| `:339` `admit` | Timer arms at `min(ttlMs, deadline - now)`. |
| header `:9-22` | Ownership diagram and TTL-vs-deadline contract documented. |

Handler call sites now pass the identity (`src/handlers/chat.js`):
`:6836` `deadline`/`found`, `:6838` `ttl`/`found`, `:6844` and `:6859`
`resume_miss`/`found`, `:7093` `deadline`/token, `:7648` and `:7664`
`resume_miss`/token.

## D2 changes — `src/handlers/chat.js`, `src/client.js`

| Location | Change |
|---|---|
| `chat.js:6120` | `collectedToolCalls` moved above the detach handle (single delivery ledger for this request). |
| `chat.js:6121` | `turnDeliveredToolCalls()` = ledger non-empty. |
| `chat.js:6126` | `releaseResumeClaim(snapshot)`: a claim that survives an abort/throw is re-detached only when no tool call was delivered; otherwise evicted `resume_miss` with its token. |
| `chat.js:6143` | `detachHandle.hasToolCalls` exposed to the producer. |
| `chat.js:6149` | `admit` refuses `{ refused: 'tools' }` on its own authority (covers the resume re-detach path). |
| `chat.js:7640`, `:8024` | Abort catch and finally safety net use `releaseResumeClaim` instead of unconditional re-freeze. |
| `client.js:1109` | Producer skips detach when `detach.hasToolCalls()` — raw chunks cannot see emulated markup. |

## Docs

`docs/DETACH-ROLLOUT.md`: the rollback/leak checks now distinguish an unclaimed
entry past the 120s TTL (leak) from a live claim (bounded by the original
request deadline); `billed_detached` vs `serve` notes the deadline-boundary
caveat. The release note "lookup 不驱逐 claimed entry" is now true.

## Tests

New:
- `test/detached-registry.test.js`: R5b (claimed survives TTL sweep + lookup,
  release served), R5c (claim bounded by request deadline, `evict.deadline`),
  R7c (claim only evictable with its token), R7d (stale key/token cannot delete
  a same-key successor, ABA).
- `test/cascade-detach-lazy-resume.test.js`: T24 (handler-admitted entry,
  claimed, TTL sweep from another admission, release still served — the
  reviewer's D1 shape), T25 (emulated `<tool_call>` delivered then disconnect →
  `admit=0`, retry reaches upstream), T26 (resume delivers a tool call then
  disconnect → no re-detach, entry dropped, retry reaches upstream).
- T23 updated to the new contract: a claim past its own deadline is cleaned by
  that deadline, never by the second retry's TTL/resume-miss path.

## Red-before (source reverted, tests kept)

```
node --test --test-name-pattern "R5b|R5c|R7c|R7d" test/detached-registry.test.js
  ✖ R5b  AssertionError: TTL must not evict a claim (actual 1, expected 0)
  ✖ R5c  AssertionError: the deadline still cleans up a claim ... (actual 0, expected 1)
  ✖ R7c  AssertionError: a key-only evict must not drop a live claim (actual true, expected false)
  ✖ R7d  AssertionError: a bare key is not an identity (actual true, expected false)
  4 tests, 0 pass, 4 fail

node --test --test-name-pattern "T23|T24|T25" test/cascade-detach-lazy-resume.test.js
  ✖ T25  AssertionError: a turn that delivered a tool call must never enter
          the no-tool detach cache (actual 1, expected 0)
  ✖ T24  AssertionError: TTL is an admission bound: it must not evict a
          claimed entry (actual 1, expected 0)
  ✖ T23  AssertionError: the claim is cleaned by its own deadline (actual 0, expected 1)
  3 tests, 0 pass, 3 fail

node --test --test-name-pattern "T26" test/cascade-detach-lazy-resume.test.js
  ✖ T26  AssertionError: a tool-delivering resume must not be re-frozen
          (actual 1, expected 0)
```

Full logs: `evidence/DetachGuardFix-red-registry.log`,
`evidence/DetachGuardFix-red-handler.log`, `evidence/DetachGuardFix-red-T26.log`.

## Green-after

```
node --test test/detached-registry.test.js test/cascade-detach-lazy-resume.test.js \
  test/detach-soak.test.js test/detach-ls-pool-pressure.test.js \
  test/cascade-turn.test.js test/cascade-turn-snapshot-v2.test.js \
  test/cascade-turn-flag.test.js test/s4-r4.test.js test/s4-r6.test.js \
  test/stream-backpressure-drain.test.js test/cascade-abort-side-effects.test.js \
  test/dashboard-api.test.js
  ℹ tests 119  ℹ suites 24  ℹ pass 119  ℹ fail 0  ℹ skipped 0

node --test test/cascade-metadata-egress.test.js test/cascade-native-bridge.test.js \
  test/cascade-stream-account-spend.test.js test/cascade-reuse-default-copy.test.js \
  test/cascade-think-reroute.test.js test/cascade-timeout-invalidation.test.js
  ℹ tests 127  ℹ suites 21  ℹ pass 127  ℹ fail 0  ℹ skipped 0
```

Logs: `evidence/DetachGuardFix-green.log`,
`evidence/DetachGuardFix-green-adjacent.log`.

## Residual notes / unverified

- Full `npm test` gate not run in this worktree; the detach family plus the
  adjacent cascade/stream suites were run (246 tests). Main runs the release
  gate.
- `evictForAccount` and `beginDrain` still drop claimed entries by design
  (account removal / process shutdown). They are explicit global actions, not
  the TTL path; a later stale key-only evict cannot touch a successor.
- A claim finishing exactly at its `deadline` can still race the deadline timer
  (serve would miss while the turn is billed). The resumer's own poll window is
  clamped to the same deadline, so the window is the final few ms; the
  reviewer's D1 TTL case is eliminated.
- Process note: a shared `refs/stash` race with `AccountScopeFix` swapped
  working-tree files once. My three source files were restored from dangling
  stash commit `92ed3ec1`; `src/auth.js` and `src/devin-connect.js` were
  reverted here, and `grep -c SELECTOR_NOT_ELIGIBLE src/handlers/chat.js` = 0.
  `w60-accountscope` reverted my `src/client.js` / `src/detached-registry.js`.

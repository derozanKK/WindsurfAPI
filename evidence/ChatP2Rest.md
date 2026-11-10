# ChatP2Rest — ReviewChatCore P2-6 + P2-7: served-model attribution and the preflight admission conjunction

Lane: `ChatP2Rest` · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w99-chatp2c`
Branch: `fix/chat-p2-rest` · base: `c2edba5` (`release/3.10.0`, i.e. the P2-1/P2-2 and P2-4/P2-5 merges) · no push, no tag.
Report under fix: `evidence/ReviewChatCore.md` §P2-6, §P2-7.

Scope taken: **P2-6 and P2-7 only**. The `src/handlers/chat.js` hunks were announced to `Main` before editing;
P2-1…P2-5 are already merged at the base and were not touched.

---

## 1. P2-6 — the usage-attribution residue

The client-visible `model` field was already unified on `connectDisplayModel`
(`mapped ? reqModelName : connectParams.model`, chat.js:4024 after the change) on all three
surfaces. The residue was the **dashboard attribution**, which had three different sources:

| surface | attribution source before |
|---|---|
| connect stream success | `recordTokenUsage(_sr?.usage, reqModelName)` — the REQUESTED name |
| connect stream re-login retry | `recordTokenUsage(_sr3?.usage, reqModelName)` — the REQUESTED name |
| connect non-stream success | `recordTokenUsage(body.usage, body.model \|\| reqModelName)` — the SERVED name |
| both, via `finalizeConnectAccount` | `recordRequest(model: reqModelName)` — the REQUESTED name |

So on a degrade (`WINDSURFAPI_STRICT_MODEL=0`) or a router hop (`DEVIN_CONNECT_ASSIGN_MODEL=1`)
the same conversation's streamed turns and non-streamed turns landed in **different**
`tokensByModel` buckets, and neither matched the `modelCounts` request row that
`finalizeConnectAccount` writes for both. The Responses route had no independent usage record
(it runs this same chat handler), so its usage inherited whichever arm served it.

## 2. Change (P2-6)

| file | line (after) | change |
|---|---|---|
| `src/handlers/chat.js` | 4187-4191 | stream success records usage under `connectDisplayModel` (comment names the P2-6 split) |
| `src/handlers/chat.js` | 4233 | re-login retry records usage under `connectDisplayModel` |
| `src/handlers/chat.js` | 4564-4566 | non-stream fallback is `body.model \|\| connectDisplayModel` (adapter body already carries the served name; the fallback no longer falls back to the requested name) |
| `src/handlers/chat.js` | 4197-4514 | all **14** connect `finalizeConnectAccount` calls pass `model: connectDisplayModel` (success, abort, re-login, reclassified MODEL_BLOCKED, error, dead-token arms) |
| `src/handlers/chat.js` | 2574-2578 | `finalizeConnectAccount`'s `model` parameter documented as the ATTRIBUTION name (the contract the call sites now honour) |
| `test/connect-token-usage.test.js` | 64-70 | the source-level "result must be captured, not discarded" guard was keyed on `model: reqModelName`; updated to `connectDisplayModel` so it can still fire |

Cache-hit replays already used the stored `displayModel` (`_display` / `_nmodel`) and are
unchanged.

## 3. Verification (P2-6)

`test/chat-p2-attribution.test.js` (7 tests) runs the real handler with the connect client
stubbed and reads the dashboard state the way the UI does (`getStats().tokensByModel` /
`modelCounts`). It covers: stream degrade, non-stream degrade, stream≡non-stream one-bucket
equality, mapped alias on both transports, AssignModel router hop, and the Responses route on
both its paths (non-stream and stream).

**Red first.** The initial pre-fix run of the two new files failed exactly where expected (the
tail of that run):

```
test at test\chat-p2-attribution.test.js:<router hop>
  AssertionError [ERR_ASSERTION]:
    actual: [ 'adaptive' ], expected: [ 'claude-opus-4-8-medium' ]
test at test\chat-p2-preflight-admission.test.js:91:3
  ✖ fails fast with 429 when every entitled account is in maintenance (31004.0482ms)
    200 !== 429
test at test\chat-p2-preflight-admission.test.js:108:3
  ✖ fails fast when the selector is latched on A and the only peer is in maintenance (30786.7849ms)
    200 !== 429
test at test\chat-p2-preflight-admission.test.js:122:3
  ✖ fails fast when every entitled account is at its in-flight cap (30542.3902ms)
    200 !== 429
```

**Mutation re-derivation** (each mutation applied to the fixed tree, suite re-run, then
reverted; this is the exact pre-fix state per surface):

| mutation | result |
|---|---|
| stream usage → `reqModelName` (2 sites) | 3 pass / **4 fail** — stream degrade, one-bucket equality, router hop, Responses stream |
| `finalizeConnectAccount` model → `reqModelName` (14 sites) | 1 pass / **6 fail** — every request-row assertion; the mapped-alias case correctly survives (requested == served there by design) |
| preflight condition without the admission arm | 3 pass / **3 fail** — the three blocked-pool cases, each back to a ~30.5 s queue wait then a 200 |
| helper without the recovery-due branch | 7 pass / **1 fail** — the half-open-recovery case |

These mutations confirm the assertions are load-bearing, not tautologies: the non-stream anchor
survives mutation 1 (it was already served-named), the mapped-alias case survives mutation 2
(alias == display name), and the three regression guards survive mutation 3 (healthy peer,
empty pool, fully rate-limited pool) — which is exactly the intended shape.

## 4. P2-7 — preflight blind to maintenance / in-flight / latch

The fast-fail preflight asked only `isAllRateLimited(null, selector)` and
`isAllTemporarilyUnavailable(null, selector)`. Both model the cooldown and RPM dimensions and
are blind to the rest of the scheduler's admission predicate: account maintenance (held for a
background / language-server swap; live by default), the per-account in-flight cap
(`DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT`), and the selector latch. A pool blocked on one of
those passed the preflight, spent the full `QUEUE_MAX_WAIT_MS` (30 s) in
`acquireConnectAccount`, then acquired `null` — which the connect path cannot tell apart from
"no pool at all" and answers with the **un-accounted env token** (or a 401 `NO_TOKEN`). That is
the P0-2 conflation the preflight's own comment says "must NOT be conflated".

Measured pre-fix: each of the three blocked-pool cases returned **200 after ~30.5 s** (the queue
wait) instead of a 429.

## 5. Change (P2-7)

| file | line (after) | change |
|---|---|---|
| `src/auth.js` | 4547-4566 | new `isAllConnectAccountsUnavailable(selector)` — read-only, delegates to `isAdmittedForRequest` (the scheduler's own predicate) and returns the sibling `{ allUnavailable, retryAfterMs }` shape. Empty eligible set ("no pool to judge") reports available, preserving the env-token deploy |
| `src/auth.js` | 3953-3966 | `errorRecoveryDue(account, now)` split out of `maybeRecoverErrorAccount` so the preflight can model getApiKey's half-open recovery **without mutating**; the mutating wrapper is unchanged in behaviour |
| `src/handlers/chat.js` | 3844-3883 | preflight computes `adm` and folds it into the existing arm: `(throttled && !degradable) \|\| (!throttled && adm.allUnavailable)`. `throttled` cases are byte-identical to before (same message, same retry-after source, same counter); the admission case gets a message naming maintenance / in-flight cap / latch, `retryAfterMs = 30_000`, and the existing `pool_exhausted` counter (whose documented meaning is "rate-limited/unavailable") |

Two deliberate decisions:

- **Degraded serve cannot suppress the admission arm.** The old `degradable` flag exists so a
  fully-throttled pool can fall through to `pickDegradedFallback`. That fallback skips
  maintenance accounts and latched selectors, so it cannot serve a pool blocked on the
  admission dimensions; the condition keeps the old throttle-arm semantics exactly and adds the
  admission arm outside it.
- **Half-open recovery is modelled, not skipped.** `getApiKey` calls
  `maybeRecoverErrorAccount` before applying the predicate, so a pool whose remaining candidate
  is due for its half-open trial is not exhausted. Fast-failing there would be self-inflicted:
  the recovery only runs inside `getApiKey`, so the 429 would never let it happen. The trial is
  evaluated on a copy (`{ ...a, status: 'active' }`) — the helper still mutates nothing.

## 6. Verification (P2-7)

`test/chat-p2-preflight-admission.test.js` (8 tests), real handler, connect client stubbed, an
env token deliberately present so the pre-fix env-token fallback is observable:

- all accounts in maintenance → 429, retry-after set, **0 upstream calls**
- latch(A) + maintenance(B) → 429, 0 upstream calls
- every account at the in-flight cap → 429, 0 upstream calls
- one peer in maintenance → 200, served by the pooled account (no over-trigger)
- remaining peer DUE for half-open recovery → 200, served by the recovered account, which is
  really `active` afterwards
- errored peer still inside its recovery TTL → 429
- empty pool → 200 via the env token (deploy shape preserved)
- fully rate-limited pool → 429 with the precise cooldown (existing arm unchanged: 299 999 ms
  advertised as 300 s)

Red/mutation evidence is in §3 (the three blocked cases and the recovery branch each have a
mutation that turns them red and only them).

## 7. Suite runs

Repo runner contract (`node --import ./test/setup-env.mjs --test …`), worktree `w99-chatp2c`,
after all changes:

```
$ node --import ./test/setup-env.mjs --test test/chat*.test.js test/connect*.test.js test/auth*.test.js test/devin-connect*.test.js
ℹ tests 1346
ℹ suites 205
ℹ pass 1346
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 61940.8882
```
(log: `evidence/chat-p2-rest-suite.log`, git-ignored)

The report's merge-lane files plus the two breaker/reauth files that touch the split predicate:

```
$ node --import ./test/setup-env.mjs --test test/billing-identity-rotation.test.js test/model-tier-truth.test.js \
    test/cascade-detach-lazy-resume.test.js test/connect-removed-account.test.js \
    test/connect-selector-scope.test.js test/stats-account-id.test.js \
    test/breaker-tunable-hotswap.test.js test/session-reauth-state.test.js
ℹ tests 121
ℹ pass 121
ℹ fail 0
```

## 8. Boundaries / not taken

- **Post-queue null is not re-classified.** The report's alternative fix shape ("make the
  queue-timeout path distinguish 'pool exists but nothing selectable' from 'no pool'") was not
  taken. With the preflight now using the same conjunction, the only remaining way to reach
  `acquireConnectAccount → null` with a non-empty pool is a concurrent acquisition consuming the
  last selectable slot in the microtask between the preflight and `getApiKey`. Closing that
  needs a policy decision about the env-token exemption (an env token beside a pool is
  deliberately exempt from pool filtering — `test/connect-discovery-rebuild.test.js:174`), so it
  is out of this lane's scope.
- **429 vocabulary unchanged**: same `type: 'rate_limit_exceeded'`, no new `code`, no new metric
  key; only the admission case's message text differs.
- **`isAllTemporarilyUnavailable` / `isAllRateLimited` untouched**: they are used by the Cascade
  paths (chat.js:235-236, 5309-5310, 5581, 6282, 7317-7318, 8232-8233) where the
  maintenance/in-flight dimensions were not in scope.

## 9. Files

| file | status |
|---|---|
| `src/auth.js` | modified — `errorRecoveryDue` split, `isAllConnectAccountsUnavailable` |
| `src/handlers/chat.js` | modified — P2-6 attribution sites, P2-7 preflight arm |
| `test/chat-p2-attribution.test.js` | new — 7 tests |
| `test/chat-p2-preflight-admission.test.js` | new — 8 tests |
| `test/connect-token-usage.test.js` | modified — stale source-guard pattern refreshed |
| `evidence/ChatP2Rest.md` | this report |

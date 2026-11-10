# AccountScopeFix — reviewer #1: a model-level rejection must not be an account auth failure

Lane: `AccountScopeFix` · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w60-accountscope`
Branch: `fix/account-scope` · base: `0dea7e2` (`release/3.10.0`) · no push, no tag.

Upstream body under test: **"This model is no longer available for your account"**, delivered on
gRPC `permission_denied` / HTTP 401.

---

## 1. Defect, measured on the base commit

`classifyUpstreamError()` had no arm for this body, so the `401`/`permission_denied` arm claimed it
as `UNAUTHORIZED`. Every downstream consumer then applied ACCOUNT scope to a fact that is scoped to
one (account, selector) pair:

| step | base behaviour | why it is wrong |
|---|---|---|
| `finalizeConnectAccount()` | `reportError()` → `errorCount++` → `status='error'` at 3 (persisted) | three requests for ONE retired selector remove the account from rotation for EVERY model it can still serve |
| same arm | `reLoginAccount()` + handler `reportDeadToken()` / `requestReauthCheck()` | the session token was never dead; a live account is walked toward `reauth` |
| `isAccountFailoverError()` | `UNAUTHORIZED` / `MODEL_BLOCKED` both excluded | the request hops only through the DEAD-TOKEN path, which carries the penalties above; with no eligible peer it surfaces `401 "all accounts exhausted (dead session tokens)"` instead of the selector verdict |
| `isLastUsableAccount()` | compared tier buckets only | a same-tier peer that cannot serve the selector (catalog miss, operator blocklist, upstream verdict) counted as a fallback, so the sole account that COULD serve it lost the last-account exemption |

Measured on base (probe, only pre-existing APIs): classifier `UNAUTHORIZED`; after three rejections
`status=error, errorCount=3`; a later request for a paid selector that only that account could serve
returned `403 model_not_entitled` (pool blackout for that selector).

## 2. Changes

| file | site | change |
|---|---|---|
| `src/devin-connect.js` | `2305-2327` | new arm, **before** the tier-wall and 401 arms: `SELECTOR_NOT_ELIGIBLE` for `(this|the)? (model|selector) … (no longer|not) (available|entitled|enabled|offered) (for|to|on) your (account|plan|tier|subscription|workspace)`. `lc` is already lower-cased; the arm sits after CAPACITY/CONTENT_BLOCKED/QUOTA so those keep their narrower meanings |
| `src/auth.js` | `2012-2082` | selector-scoped latch: `isSelectorIneligible()` / `markSelectorIneligible()`, `_selectorIneligible` map, 30-min TTL, in-memory. Written ONLY when a peer could serve the selector for the next request (active + entitled + not latched + not cooled + RPM headroom) — otherwise the latch would convert the upstream's honest 403 into "pool exhausted" |
| `src/auth.js` | `3911-3921` | `isCooledForRequest()` skips a latched (account, selector) pair — the one gate every `getApiKey` path already consults |
| `src/auth.js` | `2812-2817`, `3329-3333` | `pickDegradedFallback()` and `acquireAccountByKey()` honour the latch too (degraded-serve must not re-send a refused request; a pinned re-acquire must not hand back a refused pair) |
| `src/auth.js` | `3668-3707` | `isLastUsableAccount(account, now, selector)` — a peer must also be entitled to (and not latched out of) the selector to disqualify the exemption. `selector = null` keeps the account-wide meaning byte-identical |
| `src/auth.js` | `3950`, `4196`, `770` | `reportError()` and `reportInternalError()` accept `{ selector }` and pass it to the exemption; `__isLastUsableAccount` seam takes the selector |
| `src/handlers/chat.js` | `2654-2672` | new `finalizeConnectAccount` arm: no `reportError`, no re-login, no dead-token/reauth path; only `markSelectorIneligible(apiKey, selector || model)` + `bumpConnect('selector_ineligible')` |
| `src/handlers/chat.js` | `631-633` | `isAccountFailoverError()` includes `SELECTOR_NOT_ELIGIBLE` (third scope, next to QUOTA/RATE_LIMITED; MODEL_BLOCKED stays excluded) |
| `src/handlers/chat.js` | `579-588` | `connectErrorToHttp('SELECTOR_NOT_ELIGIBLE')` → `403 model_not_available` (not 401) |
| `src/handlers/chat.js` | `4189-4193` | stream surface keeps `model_not_available` instead of collapsing to `upstream_error` |
| `src/handlers/chat.js` | `2674, 2693, 2708, 2724, 2744, 2747` | existing blame calls now pass `{ selector }` so the exemption is selector-aware |
| `src/devin-connect-metrics.js` | `28-38` | `selector_failover_hops` + `selector_ineligible` counters (the existing `quota_failover_hops` contract says "out of credit", so a selector hop must not be filed there); `bumpConnect` ignores unknown names, so the bump needed a real key |
| `src/handlers/chat.js` | `4181`, `4399` | the two failover-hop bumps pick the selector counter for `SELECTOR_NOT_ELIGIBLE` |
| `test/connect-selector-scope.test.js` | new, 17 tests | see §3/§4 |

No new env var, no runtime-config knob, no persistence: the latch is a 30-minute in-memory
observation that self-heals, and a restart re-probes once. (A knob would have forced a settings-UI
row + i18n keys for a value that can only ever affect one selector for one account.)

## 3. Red before (base `0dea7e2`)

Behavioural probe, using only APIs that exist on base:

```
RED1 classifier code = UNAUTHORIZED
RED2 after 3 rejections: status = error errorCount = 3 reauth = undefined
RED4 request status = 200 ... A.status = active   # hop happened, via the dead-token path:
                                                  # A was charged, and with no eligible peer the
                                                  # same path answers 401 "dead session tokens"
```

The suite run against base source (same file, only the missing `isSelectorIneligible` export
substituted by the base behaviour "never latched"):

```
ℹ tests 17   ℹ pass 5   ℹ fail 12
✖ the measured body is SELECTOR_NOT_ELIGIBLE, not UNAUTHORIZED
✖ the new code is failover-eligible, non-retryable, and not an auth HTTP surface
✖ leaves the account active with no error budget, cooldown, reauth or re-login
✖ latches the SELECTOR for that account only, and the latch self-heals
✖ does not latch when no peer could serve the selector
✖ skips the latched account for the rejected selector, keeps it for the others
✖ the pinned re-acquire path honors the latch too
✖ non-stream: serves from the eligible peer and never penalizes the rejecting account
✖ a paid Y keeps working after X rejections when only A can serve Y
✖ surfaces the honest 403 when no peer is eligible (no pool blackout)
✖ a same-tier peer that cannot serve the selector does not disqualify the account
✖ three auth errors for a selector the peer cannot serve keep the account in rotation
```

The five that pass on base are the deliberate non-regression guards (real 401 still `UNAUTHORIZED`,
MODEL_BLOCKED still excluded, stream dead-token failover, bad-token eviction, dead-token hop).

## 4. Green after (this branch)

```
$ node --import ./test/setup-env.mjs --test test/connect-selector-scope.test.js
ℹ tests 17  ℹ suites 6  ℹ pass 17  ℹ fail 0
```

Coverage of the brief's scenario, in test terms:

* **A rejected for X, healthy for Y; B eligible for Y** — `2.` + `3.`: 3× X-rejections leave
  `status='active'`, `errorCount=0`, no reauth, no cooldown, no `_modelRateLimits` entry; the latch
  is `{X}` only; `getApiKey(X)` never returns A, `getApiKey(Y)` still does.
* **a later Y request succeeds on A or B** — `4.`: after the X latch, a Y request is served; and the
  paid-Y case (`claude-opus-4-8-medium`, B free) is served by A, which base could not do at all.
* **failover must try a peer eligible for the selector** — `4.`: one hop `A → B` on the non-stream
  and the stream path; the second X request goes straight to B (A is not re-probed); with B's
  blocklist excluding X no hop is attempted and the honest `403 SELECTOR_NOT_ELIGIBLE` surfaces.
* **a real bad token still triggers the existing protection** — `6.`: 3× `UNAUTHORIZED` with an
  eligible same-tier peer flips the account to `status='error'`, and the dead-token failover still
  lands on the healthy peer.
* **`isLastUsableAccount` considers selector eligibility** — `5.`: a same-tier peer blocked for X
  does not disqualify A for X (exemption applies, A stays in rotation), while for Y the peer IS a
  fallback and the breaker trips.

Regression runs (all green): `connect-error-blame` (includes the structural guard that requires an
explicit blame decision for every emitted code — the new code is now in it), `devin-connect-failover`,
`devin-connect-breaker`, `connect-entitlement`, `devin-connect-pool`, `connect-dimension-guard`,
`auth-pool-selfheal`, `account-entitlement`, `devin-connect`, `session-reauth-hooks`,
`auth-*`/`account-*`/`sticky-*` (205 tests), `chat-*`/`dashboard-*`/`docs`/`i18n` batch (678 tests,
3 pre-existing red — see §5).

Full suite on this branch: `ℹ tests 6399  ℹ pass 6281  ℹ fail 23`.

## 5. Pre-existing red on base (NOT caused by this lane; verified by reverting this lane's three
files with `git diff > patch` + `git checkout --` + re-running, then re-applying the patch)

| test file | fails | reason |
|---|---|---|
| `test/secret-scan-untracked.test.js`, `secret-scan-cwd`, `secret-scan-links`, `review-secret-scan` | 16 | fixtures copy `scripts/secret-scan.mjs` without `scripts/secret-rules.mjs` → `ERR_MODULE_NOT_FOUND` |
| `test/release-signing.test.js` | 1 | whole-file failure on base |
| `test/connect-token-usage.test.js` | 2 | source assertions still expect the 1-arg call shape (`recordTokenUsage(r.out?.body?.usage)`), source has had a 2nd `model` arg for a while |
| `test/dashboard-escape-callsites.test.js` | 2 | `index.html` interpolations / stale `REVIEWED_NOT_SINKS` entries |
| `test/docs-consistency-guard.test.js` | 1 | `dashboard-connect-parity.json` mutation anchors `hits=0` |
| `test/smoke-matrix.test.js` | 1 | fails only because the docs guard above exits 1 (`docs.guard-passes-with-self-tests`) |

Base total for the same suite: `ℹ pass 6280  ℹ fail 24` (the extra one was
`session-reauth-hooks` — see §6). This lane changes no pre-existing failure into a pass or vice versa.

## 6. Notes / limits

* The latch is not persisted (in-memory, 30-min TTL). A restart re-probes the selector once. An
  operator "reset errors" does not clear it; it expires on its own.
* A live latch is not cleared by a later catalog refresh. Bounded by the TTL by design.
* `isSelectorIneligible` is checked in the four selection gates above; it is deliberately NOT folded
  into `isConnectSelectorAllowedForAccount()`/`hasConnectEntitledAccount()`, which answer the
  durable-entitlement question the preflight 403 and the dashboard render.
* `isAllRateLimited()` / `isAllTemporarilyUnavailable()` were left unchanged: they describe
  entitlement eligibility, and the end state for a fully-latched selector is the same 429.
* An early comment inside the new `finalizeConnectAccount` arm named `requestReauthCheck`
  literally; `session-reauth-hooks.test.js` asserts that identifier never appears anywhere in that
  function body, so the comment was reworded to "reauth-confirmation probe" (the guard is correct —
  it protects the invariant this lane also depends on).
* Worktree incident (recorded because it touched this lane's files, not the code): a `git stash
  pop` raced another lane's `git stash` on the repo-wide `refs/stash`. This lane's three files were
  restored from its own stash commit `63947e02` (diffstat identical to what was written), and
  DetachGuardFix's `src/client.js` + `src/detached-registry.js` were reverted from this worktree
  (`git checkout --`). Their stash commit is `92ed3ec1`; a patch copy of their diff is at
  `.../windsurfapi-autonomous-20261022/stash-recovery-foreign-w60.patch`. No further `git stash`
  was used in this lane.

## 7. Reproduce

```
cd .../w60-accountscope
node --import ./test/setup-env.mjs --test test/connect-selector-scope.test.js
node --import ./test/setup-env.mjs --test test/connect-error-blame.test.js test/devin-connect-failover.test.js test/devin-connect-breaker.test.js
npm test        # 6281 pass / 23 fail, all 23 pre-existing per §5
```

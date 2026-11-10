# ChatP2Lifecycle — P2-3 / P2-4 / P2-5 (chat-core review)

**Branch:** `fix/chat-p2-lifecycle` · **Worktree:** `.../windsurfapi-autonomous-20261022/w98-chatp2b`
**Base:** `af7badb` (`release/3.10.0`) · **Report:** `evidence/ReviewChatCore.md` (P2-3/P2-4/P2-5)
**Runner:** `node --import ./test/setup-env.mjs --test …` (the repo's own preamble; bare `node --test` is not the contract)
**Scope:** `src/handlers/chat.js`, `src/devin-connect-metrics.js`, three test files. No push/tag.

---

## P2-3 — residual transport-fault codes still charge the error budget

**Finding (report §P2-3):** `TRANSPORT_FAULT_CODES` is an enumeration, but the transport is
Node core `https.request` and surfaces the raw socket error. `EPROTO`, the `HPE_*` header/parse
family, and `ERR_SSL_*` are produced by Node itself — no literal in `devin-connect.js` names them —
so they fell through to the final `else reportError`, charged `errorCount`, and three in-window
faults flipped a healthy account to `status='error'` with persisted backoff.

**Change — deny-by-default, not another enumeration.** The blame chain is now an allow-list of
named verdicts; the final arm (`src/handlers/chat.js:2818-2849`) records a health-window event
(`reportInternalError`) and bumps a new `unclassified_fault` counter, never `reportError`.
`UNAUTHORIZED` is the one positively classified account fault and keeps its eviction. A bounded
once-per-code warning (`noteUnclassifiedConnectFault`, `chat.js:2536-2550`) names the code so the
gap is visible. Metric added at `src/devin-connect-metrics.js:83`.

**Tests** (`test/connect-error-blame.test.js`):
- new behavioural cases for `EPROTO`, `HPE_HEADER_OVERFLOW`, `HPE_INVALID_HEADER_TOKEN`,
  `ERR_SSL_WRONG_VERSION_NUMBER`, `ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE`, and an arbitrary
  `SOME_UNKNOWN_ACCOUNT_FAULT` — 4 calls each must leave `status='active'`, `errorCount=0`;
- the account-side case now uses the named `UNAUTHORIZED` fault (it must still evict);
- the structural guard was inverted: it now asserts the fallthrough contains no `reportError(`,
  does contain `reportInternalError(` + `unclassified_fault`, and that the UNAUTHORIZED arm still
  calls `reportError`.

**Red (before the fix):**
```
✖ EPROTO x4 keeps the account in rotation — 'error' !== 'active'
✖ HPE_HEADER_OVERFLOW x4 … (same)
✖ HPE_INVALID_HEADER_TOKEN x4 … (same)
✖ ERR_SSL_WRONG_VERSION_NUMBER x4 … (same)
✖ ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE x4 … (same)
✖ SOME_UNKNOWN_ACCOUNT_FAULT x4 … (same)
✖ the fallthrough is deny-by-default — the final fallthrough calls reportError …
```
**Green:** `tests 17 / pass 17 / fail 0`.

---

## P2-4 — checked-out cascade reuse entries dropped on early returns

**Finding (report §P2-4):** `poolCheckout` REMOVES the entry; only `poolCheckin` restores it, and a
removed entry is not TTL-healed. Four early `return`s skipped the restore (client abort, policy
block, IP burst, stream top-of-loop abort). Audit also found a fifth, unlisted path: the
non-stream **exhausted-pool admission fast-fail** returns with the checkout still held.

**Change.** One restore gate per path, extracted from the predicate the end-of-loop blocks already
used:
- non-stream `restoreCheckedOutReuse` (`chat.js:5193`) used by the exhausted-pool fast-fail
  (`5260`), the abort return (`5446`), policy block (`5459`), IP burst (`5486`), and the four
  existing end-of-loop arms (`5544`, `5555`, `5572`, `5577`). The rate-limit arm now also honors
  `reuseEntryDead` (the helper's gate), matching the documented "never restore a known-dead entry".
- stream `restoreCheckedOutReuse` (`chat.js:6757`, adds `!hadSuccess`) used by the top-of-loop
  abort (`7190`) and the `failureStage('pool-restore')` tail (`8212`).

**Abort distinction (audited, not blanket-restored).** The same 499 covers two shapes:
nonStreamResponse's post-call check (the turn COMPLETED, then the client left) now returns
`reuseEntryRestorable: true` (`chat.js:5959`), while the catch arm (abort INTERRUPTED the turn)
does not. Only the completed shape is restored; the interrupted shape keeps the #101 drop contract
(`test/cascade-abort-side-effects.test.js` stays green). The deadline/not_found classification was
moved above the abort branch (`chat.js:5412-5430`) so a 504 racing a disconnect is still dead.

**Tests** (`test/cascade-pool-restore-early-returns.test.js`, fake LS/client + real handler):
- completed-turn abort → pool size 1;
- interrupted abort → pool size 0 (control for the marker);
- `policy_blocked` → pool size 1 (status 451 preserved);
- IP-burst short-circuit → pool size 1 (429 + burst message asserted as precondition);
- exhausted-pool admission fast-fail → pool size 1 (429 + `账号队列耗尽`, checkout `hits` asserted);
- stream top-of-loop abort (disconnect during the retry backoff) → pool size 1, one upstream call.

**Red (before the fix):**
```
✖ client abort AFTER the upstream turn completed … 0 !== 1
✖ policy_blocked returns without losing the cascade … 0 !== 1
✖ IP-rate-limit burst short-circuit … 0 !== 1
✖ exhausted-pool admission fast-fail … 0 !== 1
✖ a disconnect during the retry backoff … 0 !== 1
✔ client abort that INTERRUPTED the turn still drops … (already correct)
```
**Green:** `tests 6 / pass 6 / fail 0` (and `cascade-abort-side-effects` 11/11,
`cascade-timeout-invalidation` 5/5).

---

## P2-5 — connect stream success writes with no delivery check

**Finding (report §P2-5):** the connect stream `r.kind === 'ok'` arm had no post-completion abort
check. `attemptStream` resolves normally when the client vanished inside the final-write window
(`send()` no-ops on a closed socket), so the handler still bound prompt-cache affinity, committed
the session-continuity pair, and seeded the response cache for a turn the client never received.

**Change.** The ok arm is now gated on `!abortController.signal.aborted` (`chat.js:4281-4334`).
The three delivery-dependent writes (`bindConnectSticky`, `commitConnectSession`, `cacheSet`) are
skipped for an undelivered turn with a log line; `terminalOk`/`lastOkSr` and the account-side
success in `finalizeConnectAccount` stay unconditional (the upstream turn ran and cost quota).
Same gate the Cascade path already applies to its commit/cache writes.

**Tests** (`test/connect-success-delivery-gate.test.js`, real handler + mocked
`streamChatCompletion`):
- control: a delivered turn commits (`commitKeys` 1), caches (`stores` 1), binds affinity (size ≥1);
- gate: disconnect inside the final window → `commitKeys` 0, `stores` 0, binding size 0.

**Red:** with the gate disabled (`if (false && …)`) the gate test fails
`an undelivered turn must not commit the pair-chain … 1 !== 0`; **green** with the gate:
`tests 2 / pass 2 / fail 0`.

---

## Regression run

```
$ node --import ./test/setup-env.mjs --test test/chat*.test.js test/cascade*.test.js \
    test/connect*.test.js test/conversation-pool.test.js test/v2087-pool-alias-checkin.test.js \
    test/devin-connect*.test.js test/auth*.test.js
```

`ℹ tests 1546 · pass 1546 · fail 0` (run twice: once before the deadline-ordering
restructure, once after — identical counters).

Focused re-runs after the final restructure:
- `test/connect-error-blame.test.js` → 17/17
- `test/cascade-pool-restore-early-returns.test.js` + `test/cascade-abort-side-effects.test.js`
  + `test/cascade-timeout-invalidation.test.js` → 22/22
- `test/connect-success-delivery-gate.test.js` → 2/2

## Notes / limits
- P2-1/P2-2 (identity) and P2-6/P2-7 are **not** in this lane; `src/handlers/chat.js` hunks were
  coordinated with `ChatP2Identity` (w97-chatp2a) and do not overlap.
- The new `unclassified_fault` counter is in-memory like every `devin-connect-metrics` counter;
  it is exposed automatically by `GET /dashboard/api/connect-metrics`.
- `[UNVERIFIED]`: no live upstream was contacted (tests run under the repo's network-deny preload).

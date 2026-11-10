# LogAccountIdFix — request-log account attribution + failed-attempt pricing

**Verdict: P1 and P2 fixed on `fix/log-account-id` at `f60423c` (base `ccf254a`, worktree `.../w95-logid`). Not pushed, not tagged.**

## 1. What was broken

- **P1:** every chat `recordRequest` call passed the presented credential (`apiKey` / `currentApiKey`), and `stats.js` stored `String(accountId).slice(0, 8)`. Every `devin-session-token$…` key starts with `devin-se`, so all connect accounts collapsed into one bucket and `stats.json` persisted a credential prefix.
- **P2:** `recordRequest` wrote the model's card/live price onto failed rows while `creditsTotal` charged successes only, so the log's cost column/summary over-reported by every failover, 429 and 500.

## 2. What changed

1. **Call sites pass the immutable id** — `src/handlers/chat.js`:
   - `:2809` `acct.id` (connect finalizer)
   - `:5934`, `:6083` `accountId` (non-stream; the caller passes `acct.id` at `:5291`)
   - `:7623`, `:7663`, `:8015` `currentAccountId` (stream success, lost-claim failure, exhausted retries)
   - `:6542` declares `currentAccountId`; `:7152` sets `acct.id` at admission; `:7157` uses the resume claim's pin id.
2. **One opaque ref at the stats boundary** — `src/dashboard/stats.js:208` `normalizeAccountRef` hashes any non-ref value with the existing `accountRef` helper (`acct-<8 hex>`, same shape as the DevIn panel) and passes an existing ref through. Used at:
   - `:400` per-account counters key
   - `:460` row `account`
   - `:805` read view (legacy rows)
   - `:216`/`:232` load and import scrub (`stats.js:310-315`, `:577`, `:606`).
   - A future caller passing a credential gets a distinct hashed bucket, not a leak and not a collapse.
3. **Failed attempts carry zero credit** — `stats.js:442` computes `requestCreditCost` only when `success`; the row stores the charged amount (`:460`). `success:false` remains the explicit failed flag. `creditsTotal`, `byModel.credits`, `byAccount.credits` and `summary.credits` now share one number.
4. **Comments updated** — `src/auth.js:4163` (per-account ring rationale) and `src/dashboard/index.html:6473` (`_renderOverviewRankings` label only; this lane does not touch the DevIn panel sections).

## 3. Red-first evidence

Test file: `test/stats-account-id.test.js` (8 tests).

**Before the fix** (`evidence/red-first.log`): 7 fail / 1 pass.

```
✖ keeps two accounts with the same credential prefix in distinct buckets
  two accounts must not collapse into one bucket — actual: 1, expected: 2
✖ stores the stable account id as an opaque ref, not a key prefix
✖ never re-derives a credential prefix for an auth1_ key
  'devin-se' does not match /^acct-[0-9a-f]{8}$/
✖ attributes a real connect finalize to the immutable id (two accounts, one prefix)
✖ scrubs a legacy persisted credential prefix on import and display
✖ charges zero on the row when the attempt failed — 6 !== 0
✖ passes an account id at every call site
  recordRequest must not receive the presented credential: model, !err, Date.now() - startTime, apiKey
```

**After the fix** (`evidence/green-new.log`): 8 pass / 0 fail.

Executed probe (`evidence/probes.log`):

```
items:      ["acct-25e9cc37","acct-93f1daa3","acct-0f328154"]
byAccount:  [{"account":"acct-0f328154","requests":1},
             {"account":"acct-25e9cc37","requests":1},
             {"account":"acct-93f1daa3","requests":1}]
creditsTotal: 6
rows:        [{"success":false,"status":500,"credit":0},
              {"success":true,"status":200,"credit":6}]
summary.credits: 6 byModel: 6 byAccount: 6
```

The old probe in the review returned `["auth1_CC","devin-se","devin-se"]` and `summary.credits = 12`; both are now fixed.

## 4. Verification

| Check | Result | Log |
|---|---|---|
| `node --import ./test/setup-env.mjs --test test/stats-account-id.test.js` | 8/8 pass | `evidence/green-new.log` |
| dashboard suites (review command + new test) | 654/654 pass | `evidence/dashboard-suites.log` |
| connect/handler suites (9 files) | 91/91 pass | `evidence/connect-suites.log` |
| focused stats/import/s4-r4 | 55/55 pass | `evidence/focused-final.log` |
| `npm test` (full) | **6587 tests, 6490 pass, 0 fail, 97 skipped** | `evidence/full-suite-final.log` |
| `node src/dashboard/check-i18n.js` | exit 0 | `evidence/gate-i18n.log` |
| `npm run check:copy` | exit 0 | `evidence/gate-copy.log` |
| `npm run check:ui` | exit 0 | `evidence/gate-ui.log` |
| `git diff --check` | clean | — |

The first full-suite run exposed one harness dependency: `test/s4-r4.test.js` executes the real failure continuation and its stub did not provide `currentAccountId`, so the `failureStage` wrapper logged an extra warning (4 tests, `2 !== 1`). Added the collaborator to the stub at `test/s4-r4.test.js:46`; rerun is green.

## 5. Notes / residuals

- **Legacy data:** `stats.json` rows and `accountCounts` keys written before this fix are normalized on load, on import, and at read. A pre-fix collapsed `devin-se` bucket becomes one hashed `acct-…` bucket; its real account split cannot be recovered because the old code discarded the id.
- **Display:** the request log, account filter, "By account" tab and overview rankings now show `acct-<8 hex>`; no email, key or credential prefix is stored or rendered.
- **Known flake observed once:** an intermediate full-suite run at this tip failed only `test/cascade-turn-flag.test.js` (poll-window counts, 6 vs 5 offsets). It passes 3/3 in isolation (`evidence/cascade-turn-flag-isolated.log`) and the final full-suite rerun is green. It is concurrency-sensitive and unrelated to stats/chat attribution (the sibling `StatsSumFix` lane recorded the same flake).
- **Not changed:** the bounded 500-row ring, the credits card's success-only rule, and the request-ring caller hashing. No push/tag.

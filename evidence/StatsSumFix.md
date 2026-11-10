# StatsSumFix — account totals vs per-account rows (352 vs 393)

Worktree: `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w91-statssum`
Branch: `fix/stats-sum` (from `d338b36`, release/3.10.0). Lane: StatsSumFix.
Scope: `src/dashboard/stats.js`, `src/dashboard/index.html` (stats aggregates only),
`src/dashboard/index-sketch.html` (account table note), i18n, two new test files, one
contract assertion in an existing stats test.

## Diagnosis — the 41 rows are structural, not lost

`recordRequest(model, success, ms, accountId)` increments `totalRequests` for every
row, but the per-account block only runs `if (accountId)`:

- `src/dashboard/stats.js:345-352` (base `d338b36`; cited as `:198-205` in 3.9.60) —
  no `accountId` → no `accountCounts` entry.
- Call sites that legitimately pass `null`: `src/handlers/chat.js:2561,2577,4039,4404,5022,6489`
  (global/unauthenticated/global-model paths) and the log-scope tests. These are
  requests the proxy served without an account identity, so they cannot be keyed to
  one.
- Not failures: failures with an `accountId` are counted in `accountCounts.errors`
  (`stats.js:351-352`). The fixture keeps 27 errors total and reconciles 22
  attributed + 5 unattributed.
- Not dropped ring keys: `accountCounts` is lifetime, independent of the 500-row
  `recentRequests` ring. In the request-log view both `summary` and `byAccount` are
  computed from the same filtered row set, so ring drops cannot create the delta.

So the delta is exactly the count of requests recorded without an account id
(41 in the live snapshot; 352 + 41 = 393). Model counts already summed to 393.

## Fix — one denominator, stated explicitly

Backend (`src/dashboard/stats.js`):

- `getStats()` now returns `accountAttribution: { total, attributed, unattributed }`,
  derived at read time from `totalRequests` and the sum of `accountCounts.requests`.
  Derived (not persisted) so pre-fix `stats.json` snapshots reconcile with no
  migration; for any state produced by `recordRequest` or by importing consistent
  snapshots, `attributed + unattributed === total`.
- `getRequestLog()` now returns an `unattributed` aggregate (`account: null`) built
  from rows with no account. `sum(byAccount.requests) + unattributed.requests ===
  summary.requests`, and the same holds for success/errors/tokens/credits.

UI:

- Main dashboard, stats → 聚合统计 → 按账号: a footnote under the table states
  "{{count}} of {{total}} requests in this window have no account attribution
  (global/unauthenticated paths). They are included in the log total and excluded
  from the account rows above." Hidden on the model/day tabs and when the remainder
  is zero. New keys `section.statsAgg.unattributedNote` in `en.json` and `zh-CN.json`.
- Sketch skin, 账号维度统计: the same remainder is printed under the account table
  from `accountAttribution`, so the lifetime total card and the account rows are no
  longer silently inconsistent.
- The footnote deliberately says "in this window": the account table is the
  request-log window (cap 500), while the headline cards are lifetime counters. That
  second denominator distinction is pre-existing and now labelled rather than hidden.

## Red-first evidence

`test/stats-attribution.test.js` seeds the live shape through the real recording
path: 200 + 100 + 52 attributed requests (20 + 0 + 2 errors) and 41 requests with
`accountId = null` → 393 total, 352 attributed, 41 unattributed.

Before the implementation (observed):

```
✖ derives the unattributed remainder from lifetime counters
  actual: undefined
  expected: { total: 393, attributed: 352, unattributed: 41 }
✖ reports the same remainder for the request-log window
  actual: undefined
  expected: { total: 393, attributed: 352, unattributed: 41 }
```

After:

```
▶ account attribution — the 352 vs 393 gap
  ✔ derives the unattributed remainder from lifetime counters
  ✔ reports the same remainder for the request-log window
  ✔ derives the remainder for pre-fix persisted snapshots too
  ✔ reports zero unattributed when every request carries an account
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

`test/dashboard-stats-attribution-render.test.js` executes the shipped
`_renderStatsAgg` (brace-sliced from `index.html`) against a DOM stub and asserts the
footnote shows `41` of `393` on the account tab, and is hidden on the model tab and
when the remainder is zero.

## Test-harness consequence

`test/dashboard-escape-callsites.test.js` keys its reviewed non-sink allowlist by
line number. Inserting the footnote markup and JS into `index.html` shifted 28
reviewed sites, so the allowlist line numbers were re-derived from the shipped file
(expressions and reasons unchanged; the guard's own "stale exemption" test is what
caught it). No new unescaped sink was introduced.

## Verification run

- Targeted: `node --import ./test/setup-env.mjs --test test/stats-attribution.test.js
  test/dashboard-stats-attribution-render.test.js test/stats-import.test.js
  test/dashboard-stats-log.test.js test/check-i18n.test.js test/dashboard-syntax.test.js
  test/dashboard-api.test.js test/dashboard-a11y.test.js`
  → `tests 78, pass 78, fail 0`.
- Full suite: `node scripts/run-tests.mjs` → `tests 6555, pass 6458, fail 0,
  skipped 97` (53.5 s). One earlier full run reported two timing flakes in
  `test/cascade-turn-flag.test.js` (poll-window counts); that file passes 8/8 in
  isolation and passed in the next full run, so it is concurrency-sensitive, not
  caused by this change (the change touches stats aggregation and dashboard
  templates only).

## Limits

- The 41 historical rows have no account id in the persisted state; no code can
  reconstruct which account (if any) served them. The fix reports them as
  unattributed instead of inventing an attribution.
- `accountAttribution` is a read-time view; `exportStats()` still exports only the
  raw counters. Imported snapshots with hand-edited inconsistent totals clamp
  `unattributed` at 0 rather than reporting a negative remainder.

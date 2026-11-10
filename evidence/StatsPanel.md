# StatsPanel — request-log rebuild for `#stats`

Worktree: `w80-stats` (from `19ff92e`, release/3.10.0). Lane: StatsPanel.
Scope: `#stats` section only in `src/dashboard/index.html` (markup 3854–3980 region, stats JS block, stats-only CSS), plus `src/dashboard/stats.js`, `src/dashboard/api.js`, `src/server.js`, i18n, and one test file. No other panel touched.

## What was built

### Backend — `GET /dashboard/api/stats/log`

New read-only endpoint (auth inherited from the dashboard API gate) over the persisted
per-request ring (`stats.recentRequests`, cap 500). Contract:

- Query: `from`, `to` (epoch ms), `model`, `account` (exact), `status` (numeric),
  `limit` (1–200, default 50), `offset` (>= 0).
- Response: newest-first `items[]` with
  `{ ts, model, account, status, success, ms, tokensIn, tokensOut, cacheRead, cacheWrite, credit }`,
  `total`, `limit`, `offset`, `hasMore`, `retention {stored, capacity}`,
  `filters {models, accounts, statuses}`, `summary`, `byModel`, `byAccount`, `byDay`.
- Every aggregate is computed from the **same filtered rows** as the table (one
  denominator). `tokensIn` = fresh input + cache read + cache write, so
  `tokensIn + tokensOut` reconciles with the lifetime token card.
- Existing `GET /stats` is untouched except additive per-row fields inside
  `recentRequests`; `getStats()` still returns all previous keys (`modelCounts`,
  `accountCounts`, `hourlyBuckets`, `tokenTotals`, `credits*`, `modelBilling`, …).

### Attribution (the non-obvious part)

`recordRequest` (attempt row) and `recordTokenUsage` (usage block) are called at
different depths and in **either order** depending on the route (Cascade stream,
connect non-stream, cache replay). A shared "last row" pointer would misattribute
tokens between concurrent requests, so `stats.js` now exposes an
`AsyncLocalStorage` scope:

- `withStatsScope(fn)` / `finalizeStatsScope(scope)` (stats.js).
- `startServer` wraps `route(req,res)` in one scope per HTTP request and stamps the
  real `res.statusCode` on the last attempt row.
- `recordRequest` consumes usage recorded earlier in the same scope;
  `recordTokenUsage` attaches to the current row or holds it as `pendingUsage`.
- Outside a scope (unit tests, direct handler calls) behaviour is unchanged and the
  row carries the success-derived 200/500.

### Frontend — `#stats`

- Existing KPI cards and time-series chart kept (chart range control now drives the
  log window too).
- New **Request log**: filters (model / account / status, populated from retained
  rows), table (time, model, account, status badge, latency, tokens in/out, cost),
  pagination (25/50/100/200, prev/next, `from-to / total`), retention label.
- New **Aggregates** tabs: by model / by account / by day, each with requests,
  success rate, errors, avg, p95, tokens in/out, cost. The model tab carries the
  existing FREE-promo badge from `/stats` `modelBilling`.
- Cost unit is Devin credits (no invented USD conversion). Log is labelled as
  "one row per upstream attempt" and "retaining latest N of 500".
- All new copy is in both `en.json` and `zh-CN.json`; `check-i18n.js` passes.

## Verification run

| Check | Command | Result |
|---|---|---|
| New backend/API tests | `node --test test/dashboard-stats-log.test.js` | 15/15 pass |
| Dashboard suite | `node --import ./test/setup-env.mjs --test test/dashboard-*.test.js` | 532/532 pass |
| Stats import/export | `node --test test/stats-import.test.js test/sec4-stats-import-prototype.test.js` | pass (included above run) |
| Syntax + a11y | `node --test test/dashboard-syntax.test.js test/dashboard-a11y.test.js` | 21/21 pass |
| i18n | `node src/dashboard/check-i18n.js` | all checks pass |
| startServer routes | `node --import ./test/setup-env.mjs --test test/o10-ring-class.test.js test/precontent-status-stream.test.js test/startserver-failover.test.js test/startserver-cancel.test.js test/startserver-harness-shapes.test.js test/request-id-body.test.js test/http-cache-control.test.js` | 58/58 pass |
| HMC real requests | scratch on `:19120`, `/v1/chat/completions` ×2 | both HTTP 200; log rows show `tokensIn 474/419`, `tokensOut 16/4`, `credit 0/6`, status 200 |

### Screenshots

- `StatsPanel-hmc-real.png` — **real data** on the HMC scratch instance after two live
  `swe-2-medium` / `claude-sonnet-4.6` calls: log rows with tokens and credits,
  by-model aggregate, FREE promo badge.
- `StatsPanel-local-fixture.png` — local UI fixture (seeded rows, clearly not production
  numbers) used to exercise 25-row pagination, filters, 3-day aggregates and the
  chart at a realistic density.

### Not run / caveats

- Full repo gate (`npm test`, 4.8k tests) not run in this lane; only the targeted
  suites above. `[UNVERIFIED]` for unrelated suites.
- Windows local instance could not reach upstream (no local accounts); real-request
  evidence comes from the HMC scratch instance.
- Log retention is the existing 500-row ring; older-than-ring requests are not in
  the table. The panel states this explicitly.
- `test/dashboard-escape-callsites.test.js` exemption line numbers were re-anchored
  to the new `index.html` line numbers (the guard is line-keyed by design).

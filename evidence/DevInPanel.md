# DevInPanel — one truthful Devin screen in the dashboard

Worktree: `w85-devinpanel` (branch `feat/devin-panel`, from `19ff92e`). Lane: DevInPanel.
Scope: a new `#devin` section in `src/dashboard/index.html` plus `src/dashboard/devin-panel.js`,
one dashboard route, i18n, tests and the smoke flow. The stats and theme sections were not touched.

## Goal

Expose the Devin surface the proxy can actually observe — sessions/trajectories, model
catalog/status, usage/quota, settings — in one screen, using only existing endpoints.
Anything the proxy cannot read is declared unavailable with a machine-readable reason;
nothing is rendered as a zero or an empty list that would read as a real measurement.

## What shipped

### Route — `GET /dashboard/api/devin/panel`

Auth is inherited from the dashboard gate (401 without it, verified). The response is an
in-process snapshot; opening the page makes no upstream call.

```json
{
  "ok": true,
  "generatedAt": 1760000000000,
  "runtime": {
    "uptimeSec": 3600, "startedAt": 1760000000000,
    "switches": [{ "key": "devinConnect", "value": true, "source": "config", "overridden": true }],
    "credentials": { "credStoreEnabled": true, "remoteCredStore": false, "writable": false },
    "langServer": { "running": true, "pid": 123, "port": 42100, "instances": 1, "ready": 1,
                    "activeRequests": 0, "totalRssBytes": 123456, "admission": { "...": 0 } },
    "detach": { "enabled": true, "entries": 0, "bytes": 0, "draining": false, "counters": { "admit": 0 } }
  },
  "sessions": {
    "sources": [
      { "id": "proxyTurns", "available": true, "scope": "process",
        "notes": ["billed_successes_only", "process_local"] },
      { "id": "cascadeTrajectories", "available": false, "reason": "ls_only", "rpcs": ["..."] },
      { "id": "acpSessions", "available": false, "reason": "not_tracked" }
    ],
    "turns": { "available": true, "scanned": 3, "totalAccounts": 3, "capped": false,
               "accountsWithTurns": 1, "retained": 2,
               "summary": { "totalTokens": 30, "credit": 2, "acu": 0.5, "lastTs": 0 },
               "window": { "ms": 3600000, "turns": 1, "totalTokens": 30, "credit": 2, "acu": 0.5 },
               "shown": 2, "items": [{ "ts": 0, "accountRef": "acct-…", "model": "swe-2",
                                       "promptTokens": 10, "completionTokens": 5,
                                       "totalTokens": 15, "credit": 1, "acu": 0.25 }] }
  },
  "quota": {
    "drought": { "active": false, "threshold": 20, "activeAccounts": 3, "knownAccounts": 3,
                 "quotaKnownAccounts": 3, "droughtAccounts": 0, "coverageMet": true,
                 "lowestWeeklyPercent": 80, "lowestDailyPercent": 90, "restrictEnabled": true,
                 "restrictionFailOpen": false, "freeTierModels": ["swe-2"] },
    "knobs": [{ "key": "cooldownMs", "value": 1800000, "override": null,
                "source": "env", "overridden": false }]
  }
}
```

`GET` only; a non-GET falls through to the normal 404. `Cache-Control: no-store` is set
because the snapshot is time-stamped and must not be replayed from a browser cache.

`runtime.switches` and `/runtime-env-status` now share one helper (`runtimeSwitchRows()` in
`api.js`) so the two can never report a different effective value or source for the same
switch. The PUT path keeps its whitelist and null-clears semantics; the panel itself is
read-only for switches and links to Settings for writes.

### Page — `#devin`

Sidebar entry under 用量, section `#p-devin`, six render methods in the shipped `App`
object (not a mirror implementation):

| Section | Source | What it shows |
|---|---|---|
| KPI strip | `/devin/panel` + `/models` + `/models/catalog` | transport + CLI mode, turns in the last hour, retained turns, free/unreachable models, catalog drift, drought verdict |
| 运行时 Runtime | `/devin/panel` | LS process/port/uptime, ready/instances, active requests, RSS, admission counters and last failure, detach-cache switch/entries/bytes/counters, credential-store presence (read-only) |
| 会话与轨迹 Sessions | `/devin/panel` | source table (available + two unavailable with reasons), merged billed turns with time, hashed account ref, model, prompt/completion, tokens, credits, ACU; totals and last-hour window |
| 模型目录与状态 Catalog | `/models`, `/models/catalog`, button `/models/reconcile` | reachability, free/billable/unknown tri-state, daily/weekly quota state, cost tier, promo end, stale-pricing count, live-vs-snapshot diff, on-demand reconcile result |
| 用量与配额 Quota | `/devin/panel`, button `/usage/orgs` | drought decision and inputs, free-tier list, fail-open warning, five quota/spend knobs; on-demand org-scoped ACU cards (deduped by org) |
| 设置 Settings | `/devin/panel`, `PUT /quota-config` | six effective switch values with source/override, five quota knobs with env-following vs config override, save path for the knobs |

The two reads that can reach upstream are explicit buttons, never on mount:

- `GET /models/reconcile` — local vs live vs snapshot counts, `partial`, `stale`, `degraded[]`.
- `GET /usage/orgs` — org-scoped ACU/usage; `refresh=1` only on a forced refresh.

### Truthfulness rules (the point of the lane)

| Situation | Rendering | Test |
|---|---|---|
| Cascade trajectories / ACP sessions not readable | `available:false` + `reason` (`ls_only`, `not_tracked`), never `[]` | unit + route + render + smoke |
| Proxy turns | labelled `billed_successes_only` + `process_local`; aborts/429s never appear | unit + render |
| Missing numeric field | `—`, never `0` | render |
| Live catalog not synced | drift KPI is `—` + “Live catalog not synced yet”, not `0` | render |
| Drought coverage below threshold | KPI says “Not assessed”, not “Clear” | render |
| Pool larger than the 500-account scan cap | “scanned N / M” + a note naming the cap | unit + render + route |
| Account identity in turns | `accountRef` hash only; no raw id, key or email in the body | route test asserts body does not contain them |
| Credential-store switches | presence booleans, `writable:false`; not accepted on PUT | unit + route |

## Verification

| Check | Command | Result |
|---|---|---|
| Panel builders | `node --test test/dashboard-devin-panel.test.js` | 21/21 pass |
| Shipped-template render guards | `node --test test/dashboard-devin-panel-render.test.js` | 29/29 pass |
| Route contract + shared switch rows | `node --test test/dashboard-devin-panel-routes.test.js` | 9/9 pass |
| Escape call-site guard | `node --test test/dashboard-escape-callsites.test.js` | 5/5 pass |
| Dashboard smoke (incl. new `devin-panel` flow) | `node --test test/dashboard-smoke.test.js` | 1/1 pass |
| Dashboard copy gate | `npm run check:copy` | pass |
| i18n catalogue | `node src/dashboard/check-i18n.js` | all checks pass |
| Full repo suite | `npm test` | 6502 tests, 6405 pass, 0 fail, 97 skipped, exit 0 |
| Local gate (declared platform skips) | `GATE_INERT_SKIP_PATHS="test/detach-ls-pool-pressure.test.js;test/detach-soak.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js;test/wire-byte-identity.test.js" npm run gate` | **PASS exit=0** |

The render tests execute the methods sliced out of the shipped `index.html`, so a change
that only edits a test mirror cannot pass them. The route tests call the real
`handleDashboardApi` with a fake response and a real account/ring, assert that the
raw account key and email never reach the body, and pin that opening the panel makes
zero `fetch` calls.

### Gate

```
PASS spec-static-check exit=0
PASS spec-baseline-check exit=0
PASS secret-scan exit=0
PASS test:release exit=0 — 6405 pass / 0 fail / 97 skip (528 files) — 6 inert file(s), 6 declared
PASS git diff --check exit=0
PASS git diff --cached --check exit=0
SKIP mutation EXECUTION — this incremental gate checks spec shape, anchors and baseline
     values, but does not run the mutants themselves; the Linux full-gate recipe runs the sweep.
INCREMENTAL GATE: PASS exit=0
```

The six declarations are the repo's deliberate platform/env gates: the POSIX-only
detach pool-pressure harness, the `DETACH_SOAK=1` 120 s soak, the live-credential
relogin suite, the mutation harness, the self-update untracked-safety suite and the
wire-byte-identity base-tree comparison. The first, undeclared run failed **only** on
that inert-file policy (`test:release` itself reported `6404 pass / 0 fail / 97 skip`);
it did not fail a test. With the declarations the gate is green.

## Research mapping

- **Q1 (§3.4, detached completion cache)** — the runtime card surfaces the detach registry
  (`enabled`, entries, bytes, admit/serve/re_detach) that already exists, so the two-week
  rollout can be observed from the same screen as the rest of the Devin state.
- **Q1 (§2 row 3, model catalog updater; §3.3, four-class quota)** — the catalog section
  shows the live-vs-snapshot diff and the price/quota tri-state; the quota section shows
  the drought decision, its coverage and the five knobs that shape it.
- **Q4 (G3, G5, G7 truthfulness)** — the account-pool review's core lesson (skipped work
  counted as success, KPIs that lie about their predicate) is applied here: unavailable
  sources carry reasons, missing values are dashes, unsynced catalogs are not zero drift,
  uncovered drought is not “clear”, and a capped scan says so.
- **Q4 (G21/G22, covered-but-unused data)** — per-account billed rings (`/accounts/:id/requests`)
  and the org-scoped ACU reader (`/usage/orgs`) are surfaced without new server state.
- Q1's larger absorption items (descriptor extraction, LS supply chain, detached cache
  implementation) are backend work and are deliberately not re-implemented in this lane.

## Files

| File | Change |
|---|---|
| `src/dashboard/devin-panel.js` | new; pure builders for runtime/turns/sources/quota/panel |
| `src/dashboard/api.js` | `GET /devin/panel`; shared `runtimeSwitchRows()` |
| `src/dashboard/index.html` | nav entry, `#p-devin` markup, six render methods, two on-demand loaders, quota save |
| `src/dashboard/i18n/en.json`, `zh-CN.json` | 174 `devin.*` keys (parity checked) |
| `scripts/dashboard-smoke.mjs`, `test/helpers/dashboard-smoke-upstream.mjs` | `devin-panel` smoke flow |
| `test/dashboard-devin-panel.test.js` | builder contract |
| `test/dashboard-devin-panel-render.test.js` | shipped-template render guards |
| `test/dashboard-devin-panel-routes.test.js` | route/auth/leak/cache contract |
| `test/dashboard-escape-callsites.test.js` | reviewed line numbers re-anchored to the new file |

## Not verified / limits

- **No live browser screenshot in this lane.** Rendering is verified by executing the
  shipped template methods and by the dashboard smoke flow; the visual layout was not
  re-measured in a browser. `[UNVERIFIED]` for pixel-level layout at 1440/720.
- **Cascade trajectories remain unread.** The proxy does not call the local-LS
  `GetAllCascadeTrajectories` / `GetCascadeTranscriptForTrajectoryId` RPCs, and a
  `DEVIN_CONNECT` deployment has no local LS. The panel states this; it does not guess.
- **ACP sessions remain untracked.** `devin acp` runs are not registered anywhere after
  the turn ends, so there is no honest session list to show.
- **Turn rings are process-local.** A restart starts a new window; the panel says so.
- **Scan cap.** At most 500 accounts (newest `lastUsed` first) are read per request; the
  response carries `totalAccounts`/`capped` and the UI names the cap when it bites.
- **ACU/reconcile are billable/cold-cache reads.** They only run when the operator presses
  the button; their copy says so.

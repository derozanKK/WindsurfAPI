STATUS: DONE

# Fix D1 + D6 — Host boundary on `/auth/*`/`X-Forwarded-Host`, and truthful self-update states

Baseline: `master` @ `2598299e58e291493984de988f7281dccff43e3d`.
Worktree: `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261026/w17x-FixD1D6`
(branch `fix/d1-d6-host-boundary-update-truth`). Evidence sources: `evidence/audit2/Server.md`
S01/S02 and `evidence/audit2/Update.md` P2-3/P2-6.

Owned files: `src/server.js`, `src/dashboard/api.js`, `src/dashboard/docker-self-update.js`,
`nginx.conf`, `deploy/update.sh` (read only — its health-gate/restore pattern was reused, not
modified), plus tests/docs below.

## D1 — `/auth/*` must share the dashboard Host boundary

### Defect (reproduced before the fix)

Two independent holes, both measured through a real `startServer()`:

1. `validateDashboardRequestHost()` accepted any non-loopback **client-supplied**
   `X-Forwarded-Host` whenever `TRUST_PROXY_X_FORWARDED_FOR=1` and an XFF header was present
   (`forwardedHostAllowed` short-circuited `DASHBOARD_ALLOWED_HOSTS`). The bundled nginx
   forwarded the client header untouched.
2. `/auth/*` had no Host validation at all. In documented open-local mode
   (`WINDSURFAPI_ALLOW_UNAUTHENTICATED=1` + empty `API_KEY` + `DASHBOARD_ALLOW_NO_AUTH=1`,
   loopback bind) `verifyAdminRequest()` authenticates from the loopback socket, which a
   DNS-rebinding page satisfies.

Red run of `test/dashboard-host-boundary.test.js` against `master` (tests copied into a
detached `master` worktree, product source untouched):

```
✖ rejects a rebinding Host on GET /auth/accounts without listing accounts
    actual: 200, expected: 403
✖ rejects an account-adding POST /auth/login with zero account delta
    actual: 200, expected: 403
✖ rejects an unallowlisted client-supplied X-Forwarded-Host on /dashboard/api/*
    actual: 200, expected: 403
✖ rejects /auth/* with an unallowlisted forwarded Host under proxy trust
    actual: 200, expected: 403
ℹ tests 9 / pass 5 / fail 4
```

The two `/auth/login` attacks returned `{"success":true,"account":{...},"total":1}` — i.e. a
real account row was added by an attacker-controlled Host.

### Fix

- `src/dashboard/api.js:421-446` — `validateDashboardRequestHost()` is now exported and applies
  `dashboardHostAllowed()` to the **effective** host (trusted forwarded host when configured,
  otherwise `Host`). The `forwardedHostAllowed` bypass is deleted; the comment now matches the
  code. A trusted proxy may still present the public name, but that name must be loopback, an
  explicit `DASHBOARD_ALLOWED_HOSTS` entry, or accepted by the existing public-bind rule.
- `src/server.js:520-529` — every `path === '/auth'` / `path.startsWith('/auth/')` request runs
  the same validator **before** the API-key gate, the brute-force counters, and any body read.
  A rejected Host therefore has zero account delta and cannot spend auth attempts.
- `nginx.conf:78-82` — the bundled proxy now overwrites `X-Forwarded-Host` with `$host`
  (defence in depth; the app no longer trusts a raw client value regardless).

### Green evidence

`node --import ./test/setup-env.mjs --test test/dashboard-host-boundary.test.js`

```
✔ D1: /auth/* Host boundary (open-local) (39.1ms)
✔ D1: trusted-proxy X-Forwarded-Host cannot bypass DASHBOARD_ALLOWED_HOSTS (29.8ms)
ℹ tests 9 / pass 9 / fail 0
```

Arms (all through real `startServer()` over raw `http.request`, so Host/XFH/XFF are verbatim):

| Arm | Expectation | Result |
|---|---|---|
| `GET /auth/accounts`, `Host: attacker.example`, open-local | 403 `ERR_DASHBOARD_HOST_REJECTED`, no `accounts` key, pool unchanged | pass |
| `GET /auth/accounts`, loopback Host | 200 + account list (control) | pass |
| `POST /auth/login` token, attacker Host + `Origin: attacker.example` + `text/plain` | 403, `getAccountCount().total` unchanged, no probe row | pass |
| `POST /auth/login`, loopback Host + `application/json` | 200, `success:true`, total +1 (control) | pass |
| `PUT /dashboard/api/settings/prefs`, trust on, allowlist `dashboard.internal.example`, attacker Host + `X-Forwarded-Host: attacker.example` | 403 | pass |
| same, sanitized proxy (`X-Forwarded-Host: dashboard.internal.example`, Origin agrees) | 200 `success:true` (control) | pass |
| same attack with `TRUST_PROXY_X_FORWARDED_FOR` unset | 403 | pass |
| `POST /auth/login`, trust on, unallowlisted XFH, real operator password supplied | 403, zero delta | pass |
| `GET /auth/accounts`, trust on, loopback Host + allowlisted XFH | 200 (sanitized-proxy control) | pass |

Regression suites re-run green: `test/dashboard-mutation-guard.test.js`,
`test/auth-admin-gate.test.js`, `test/account-add-proxy-ordering.test.js`,
`test/router-path-security.test.js`, `test/nginx-access-log.test.js` (36 + 3 tests, 0 fail).

Scope boundary: this does **not** claim password-protected remote deployments were
unauthenticated. The finding is the open-local operator surface and the proxy-trust bypass;
both now fail closed at the Host gate.

## D6 — `{ok:true}` must not mean only “restart/deployer started”

### Defect (reproduced before the fix)

Probe against `master` (real `handleDashboardApi` with a scheduler that declines the restart,
and the real `runDockerSelfUpdate` with injected detect/pull/request):

```
SOURCE_ROLLBACK_RESPONSE {"ok":true,"rolledBackTo":"fffffff"}
SOURCE_ROLLBACK_POINT_EXISTS false
SOURCE_ROLLBACK_JOURNAL_EXISTS false
DOCKER_RESULT {"ok":true,...,"message":"...deployer sidecar will recreate the container in ~8s."}
DOCKER_AUTOREMOVE true
DOCKER_CMD "sh -c set -e; sleep 8; docker compose ... up -d"
DOCKER_JOURNAL_EXISTS false
```

So: the rollback reset was reported as success and its retry point deleted even though nothing
would relaunch the gateway; the docker path reported success for a bare `up -d`, kept no
previous-image record, and auto-removed the only evidence of the deployer's outcome.

### Design

A durable journal is written **before** the mutating step and confirmed only by the next
process, using the same commit identity `/health` publishes.

States: `pending-restart` → `confirmed` (running commit matches) / `restart-not-scheduled` /
`restart-failed` / `failed` (`stash-failed`, `reset-not-verified`, `state-unknown`).
Docker: `pending-recreate` → `deployer-running` → `confirmed` (exit 0) / `rolled-back` (exit 1) /
`rollback-failed` (exit 2) / `recreate-failed` (exit 3) / `deployer-failed` (other) /
`unverified` (deployer evidence gone).

The rollback point is **not** deleted when the restart is scheduled; it is deleted only by
`reconcileSelfUpdateJournal()` when the running commit matches `expectedCommit`. If the commit
does not match, both the point and the journal stay, so the rollback is retryable and its
failure stays visible.

### Fix — source (git) path

- `src/dashboard/api.js:4340-4440` — journal read/write/update helpers, `commitsCorrespond()`,
  and exported `reconcileSelfUpdateJournal()` (confirmation deletes `self-update-before.json`
  /`.pending.json` only for `operation:'rollback'`).
- `src/dashboard/api.js:1515-1541` — rollback writes `pending-restart` + `phase:'pre-reset'`
  **before** the protective stash and `reset --hard`. A journal-write failure returns
  `ERR_UPDATE_JOURNAL_WRITE` while the worktree is still unmodified.
- `src/dashboard/api.js:1617-1680` — after the verified reset: `phase:'reset-verified'`, then
  schedule. Scheduler accepted → `{ok:true, state:'pending-restart', verified:false,
  restartScheduled:true, rollbackPointRetained:true, expectedCommit, rolledBackTo}`. Scheduler
  declined → `{ok:false, error:'ERR_RESTART_NOT_SCHEDULED', state:'restart-not-scheduled',
  restartScheduled:false, rollbackPointRetained:true, rolledBackTo}`. The point is never
  deleted here.
- Failure paths record `state:'failed'` + reason (`stash-failed`, `reset-not-verified`,
  `state-unknown`) so an attempted-but-not-applied rollback cannot read as a pending restart.
- The restart callback wraps `gracefulRestart()` in `Promise.resolve(...).catch(...)` and records
  `restart-failed`; `scheduleSelfUpdateRestart()` now has a `.catch` so a rejecting restart is
  logged instead of surfacing as an unhandled rejection (the previous code had no `.catch`).
- Update path (`api.js:1955-2027`) writes the same journal with `expectedCommit: actualHead` and
  returns `state:'pending-restart' | 'restart-not-scheduled' | 'unchanged'`, `verified`, and
  `restartScheduled` alongside `ok`. `ok:true` there means the verified Git mutation applied;
  the pending/verified fields say the restart is not yet proven.
- `/self-update/check` (`api.js:1366-1425`) reconciles both journals first and returns
  `selfUpdate` and/or `dockerSelfUpdate` in every branch (git, docker, unavailable, error).

### Fix — docker path

- `src/dashboard/docker-self-update.js:414-485` — `detectDockerSelfUpdate()` now also returns the
  running `imageId` (from inspect `.Image`) and the Compose `service`; missing/unsafe values make
  docker mode unavailable instead of starting a mutation with no rollback point.
- `docker-self-update.js:525-560` — the journal
  (`<DATA_DIR>/self-update-docker.json`) records `oldImageId`, `oldImageRef`, derived
  `<repo>:rollback` tag, project/service/self id **before** any pull. A write failure refuses the
  update. Pull/create/start failures update the journal to `state:'failed'` with the reason.
- `docker-self-update.js:590-665` — the deployer is created with `AutoRemove:false` and labels
  (`role`, `project`, `rollback-image`); the response is
  `{ok:true, state:'pending-recreate', verified:false, rollbackPoint:{imageId, imageRef,
  rollbackRef}, ...}`. It never claims health.
- `docker-self-update.js:704-757` — `buildDockerDeployerScript()` (the same pattern as
  `deploy/update.sh:454 health_gate()` / `:512 restore_image()`):
  `sleep 8` → `compose up -d` (exit 3 on failure) → health-gate via
  `compose exec -T <service> node -e fetch(/health)` (120 s / 3 s interval) → on failure
  `docker tag <oldId> <repo>:rollback` + `WINDSURFAPI_IMAGE=<repo>:rollback compose up -d
  --no-deps --no-build --force-recreate <service>` → second gate (exit 1 healthy, 2 unhealthy).
- `docker-self-update.js:759-841` — `reconcileDockerSelfUpdateState()` reads the journal, lists
  deployer containers by label, maps the exit code to the terminal state, writes it durably, then
  removes the consumed container. Running/absent evidence is reported as `deployer-running` /
  `unverified` — never rounded up to success.
- `api.js:4091-4093` — the in-process mutation lock is held for
  `DOCKER_DEPLOYER_WINDOW_MS` (delay + two health gates + margin) instead of 60 s, so a retry
  cannot race a deployer that is still recreating or rolling back.
- `docs/DOCKER-UPDATE.md:209-257` — documents the health gate, the journal/rollback point, the
  response states, and the git-path pending/confirmed contract.
- `.gitignore` ignores both runtime journals.
- `test/mutations/self-update-hotfix.json` — the three mutation anchors that pin the old source
  shape were updated to the new code (update lock handoff, rollback lock handoff, Docker
  `-f` replay), and `expectBaselinePass` moved 164 → 180 because the two suites gained tests.
  `node scripts/spec-static-check.mjs` and `node scripts/spec-baseline-check.mjs` both pass.
- Every edited file is LF (`.gitattributes` forces `*.js text eol=lf`; mutation anchors are
  byte-exact). CRLF written by the editor was normalized before the final gate.

### Green evidence

`node --import ./test/setup-env.mjs --test test/self-update-gate.test.js test/docker-self-update.test.js test/docker-oneclick-update.test.js`

- `self-update-gate.test.js`: 66 tests, 63 pass, 3 skipped (real-git fixtures), 0 fail. New
  cases:
  - scheduler declines → `ok:false`, `ERR_RESTART_NOT_SCHEDULED`, `state:'restart-not-scheduled'`,
    `restartScheduled:false`, `rollbackPointRetained:true`, `rolledBackTo` still returned;
    `self-update-before.json` **exists**, journal state `restart-not-scheduled`.
  - reset failure → `ERR_GIT_ROLLBACK_FAILED`, point kept, journal `state:'failed'`,
    `reason:'reset-not-verified'`, `phase:'pre-reset'` (evidence written before the destructive
    step).
  - scheduled restart → `ok:true`, `state:'pending-restart'`, `verified:false`, point kept,
    journal `phase:'restart-scheduled'`.
  - reconcile with running commit == expected → `state:'confirmed'`, point deleted.
  - reconcile with running commit != expected → stays `pending-restart`, point kept.
  - a `restart-failed` journal confirms after a later successful restart.
  - `/self-update/check` surfaces `selfUpdate.state:'confirmed'` and clears the point.
- `docker-self-update.test.js`: 41 pass / 0 fail. New coverage: journal written before create
  with the old image ID; `AutoRemove:false`; deployer labels; script contains the health gate,
  `:rollback` tag, force-recreate and exit codes 0/1/2/3; fail-closed `no-image-id` with no pull
  or create; durable `failed` journal on pull/start failure; exit-code → state table
  (0/1/2/3/9); running stays pending; missing evidence → `unverified`; no journal → no Docker API
  call.
- `docker-oneclick-update.test.js`: 11 pass / 0 fail, 13 skipped (the pre-existing `update.sh`
  integration cases remain POSIX-only). The four new hermetic deployer-script arms execute the
  real generated script against a fake `docker` CLI **on this Windows host**:
  - healthy first gate → exit 0, no rollback tag;
  - first gate fails → exit 1, `tag <oldId> <repo>:rollback`, rollback recreate carries
    `WINDSURFAPI_IMAGE=<repo>:rollback`;
  - both gates fail → exit 2;
  - recreate fails → exit 3, no image rollback.

Same probe on the fixed tree:

```
SOURCE_ROLLBACK_RESPONSE {"ok":false,"error":"ERR_RESTART_NOT_SCHEDULED",...,"state":"restart-not-scheduled","verified":false,"restartScheduled":false,"rollbackPointRetained":true,"expectedCommit":"ffff...","rolledBackTo":"fffffff"}
SOURCE_ROLLBACK_POINT_EXISTS true
SOURCE_ROLLBACK_JOURNAL_EXISTS true
DOCKER_RESULT {"ok":true,"state":"pending-recreate","verified":false,...,"rollbackPoint":{"imageId":"sha256:111...","imageRef":"windsurf-api:test","rollbackRef":"windsurf-api:rollback"},...}
DOCKER_AUTOREMOVE false
DOCKER_JOURNAL_EXISTS true
```

## Verification

| Command | Result |
|---|---|
| `node --import ./test/setup-env.mjs --test test/dashboard-host-boundary.test.js` | 9/9 pass |
| `node --import ./test/setup-env.mjs --test test/self-update-gate.test.js` | 66 tests, 63 pass, 3 skip, 0 fail |
| `node --import ./test/setup-env.mjs --test test/docker-self-update.test.js` | 41/41 pass |
| `node --import ./test/setup-env.mjs --test test/docker-oneclick-update.test.js` | 11 pass, 13 skip, 0 fail |
| `node --import ./test/setup-env.mjs --test test/self-update-untracked-safety.test.js test/self-update-docker.test.js test/self-update-ui-state.test.js test/v2145-hardening.test.js` | pass |
| `GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js;test/detach-soak.test.js;test/detach-ls-pool-pressure.test.js" npm run gate` | PASS exit=0 — 7044 pass / 0 fail / 97 skip (585 files), 6 inert files / 6 declared; `spec-static-check`, `spec-baseline-check`, `secret-scan`, `git diff --check`, `git diff --cached --check` all PASS |

The bare `npm run gate` on this Windows host reaches the same suite result but fails the
gate's inert-file census: six files execute no tests here (POSIX real-Git fixtures, an unarmed
live suite, and two platform soak suites). The declarations above are the project's documented
Windows invocation (release notes v3.141.592655); they accept those platform gates rather than
counting them as green.

## Not verified / boundaries

- No real Docker daemon, container recreate, or registry pull was exercised. The deployer script
  is proven against a fake `docker` CLI; `docker tag`/`compose exec` semantics are asserted from
  their argument shape only.
- No live upstream calls, no deploy, no tag, no release.
- The dashboard UI was not changed: it already polls `/health` for `expectedCommit` and shows
  “updating” rather than “updated” for docker mode. The new API `state` fields are additive.
- `test/docker-oneclick-update.test.js` still skips the pre-existing `deploy/update.sh`
  integration cases on Windows (unchanged); only the new hermetic deployer arms run there.
- The two `state` fields are additive; scripts that only inspect `ok` on `POST /self-update`
  keep working, but a rollback script that treats `ok:true` as “service is now running the old
  commit” must additionally check `/self-update/check` → `selfUpdate.state === 'confirmed'`.

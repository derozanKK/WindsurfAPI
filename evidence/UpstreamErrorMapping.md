# UpstreamErrorMapping — an upstream 4xx validator rejection is a 400, not a 503

**Worktree:** `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w117-upstreammap`
**Branch:** `fix/upstream-error-mapping`, based on master `f53cd7a`
**Date:** 2026-10-25 · **Not pushed, not tagged, not merged.**
**Wave artifacts (logs + probe):** `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/evidence/upstreammap-*.log`

Source of the defect: `evidence/AccountMatrix.md` §7.1 (four image probes, one upstream frame).

---

## 1. The defect and the exact site

The matrix sent an image to four models whose `/v1/models` row **omits** `supports_images`
(absent, not `false`). All four returned the identical 106-byte end-of-stream trailer:

| field | value |
|---|---|
| frame | 106 B, sha256 `f8f40e32fba9c2c7c1c121f21c0e2a502caf55d42ec5f249f7b25e1b4845268a` |
| decoded | `{"error":{"code":"invalid_argument","message":"an internal error occurred"}}` |
| proxy surface | `503` `{"error":{"message":"an internal error occurred","type":"api_error","code":"UPSTREAM_INTERNAL"}}` |

The upstream message happens to contain the words **"internal error occurred"**, and the
transient TEXT arm ran before any code-based arm — so an explicit `invalid_argument`
(permanent request-validator verdict) was read as a transient backend fault.

| # | Site (pre-fix) | Role | Consequence |
|---|---|---|---|
| 1 | `src/devin-connect.js:2558` — `if (/internal error occurred/i.test(lc))` | classifier; text arm claims the frame | `invalid_argument` is never consulted → `UPSTREAM_INTERNAL` |
| 2 | `src/handlers/chat.js:595` — `case 'UPSTREAM_INTERNAL': return { status: 503, … }` | HTTP mapping | permanent rejection surfaces as a retryable 503 |
| 3 | `src/handlers/chat.js:2771` — `else if (err.code === 'UPSTREAM_INTERNAL')` → `reportInternalError` | account blame | a caller looping on an unsupported image quarantines a healthy account (streak 2 → 120 s) |
| 4 | `src/devin-connect.js:2684` — `if (err.code === 'UPSTREAM_INTERNAL') return false` | retry gate | correct (non-retryable), but for the wrong verdict |

The same gRPC code is the measured verdict for a malformed native tool history (#273.1:
"502 invalid_argument / There is an issue with this request, please try a different
model."), so the defect is not image-specific — images are just the captured instance.

## 2. Change

| Site | Change |
|---|---|
| `src/devin-connect.js:2503` | `REQUEST_REJECTION_CODES = {invalid_argument, failed_precondition}` + `isRequestRejectionCode()` |
| `src/devin-connect.js:2583` | the `internal error occurred` TEXT arm now defers to an explicit 4xx-class code (`&& !isRequestRejectionCode(code)`) |
| `src/devin-connect.js:2683-2709` | new `REQUEST_REJECTED` verdict: keeps the upstream message, appends the capability hint (`supports_images` in `GET /v1/models`, the message/tool-shape alternative, the upstream code). Placed AFTER quota / capacity / content-policy / selector / tier / auth / rate-limit so every narrower verdict still wins |
| `src/devin-connect.js:2741` | `isRetryable` excludes `REQUEST_REJECTED` even in a 5xx shell |
| `src/handlers/chat.js:609` | `REQUEST_REJECTED` → `400 invalid_request_error` |
| `src/handlers/chat.js:2731-2737` | blame arm: no penalty, no cooldown, no re-login, `bumpConnect('request_rejected')` |
| `src/handlers/chat.js:4515-4517` | stream surface: `invalid_request_error` (not the retryable `upstream_error`) |
| `src/devin-connect-metrics.js:65` | new `request_rejected` counter |
| `src/devin-connect-models.js`, `src/devin-connect.js`, `src/handlers/chat.js` | comments that asserted the old classification ("trips UPSTREAM_INTERNAL and burns the account") corrected |

`failed_precondition` is intentionally claimed here too, but only after the narrower text
arms: the measured quota-dry body rides `failed_precondition` and must stay
`QUOTA_EXHAUSTED` (402), and capacity / content-policy / tier-wall text still wins.

## 3. Before / after, measured

Probe: `evidence/UpstreamErrorMapping-probe.mjs` replays the captured 106 bytes through the
REAL chain — `handleChatCompletions → toChatCompletion → chatWithRetry → streamChat →
StreamingFrameParser → classifyUpstreamError → connectErrorToHttp`. Only the socket is faked.

```bash
node --import ./test/setup-env.mjs evidence/UpstreamErrorMapping-probe.mjs
```

Before (`upstreammap-before-probe.log`, base `f53cd7a`):

```json
"frame": { "bytes": 106, "sha256": "f8f40e32fba9c2c7c1c121f21c0e2a502caf55d42ec5f249f7b25e1b4845268a" },
"image_rejection": {
  "upstream_hits": 1, "status": 503, "type": "upstream_transient_error",
  "code": "UPSTREAM_INTERNAL", "message": "an internal error occurred"
},
"transient_capacity": { "status": 503, "type": "capacity_error", "code": "CAPACITY" },
"transient_internal": { "status": 503, "type": "upstream_transient_error", "code": "UPSTREAM_INTERNAL" }
```

After (`upstreammap-after-probe.log`, this branch):

```json
"image_rejection": {
  "upstream_hits": 1, "status": 400, "type": "invalid_request_error",
  "code": "REQUEST_REJECTED",
  "message": "an internal error occurred [upstream rejected the request as invalid (invalid_argument): the selected model may not support this input — e.g. an image on a model whose /v1/models row omits supports_images — or the message/tool shape is unsupported. Check supports_images in GET /v1/models and retry with a capable model or request shape]"
},
"transient_capacity": { "status": 503, "type": "capacity_error", "code": "CAPACITY" },
"transient_internal": { "status": 503, "type": "upstream_transient_error", "code": "UPSTREAM_INTERNAL" }
```

Controls unchanged: the transient capacity 503 and the transient backend 500 (no code) both
stay 503; the rejection is **not** replayed (`upstream_hits: 1`).

## 4. Red-first

`test/connect-request-rejection.test.js` was written against the unfixed tree
(`upstreammap-red-tests.log`): **16 tests, 7 pass, 9 fail** — the 7 passes are the
precedence/transient controls that must not move. Failing before the fix:

```
✖ the §7.1 frame (invalid_argument + "internal error occurred") is REQUEST_REJECTED
✖ failed_precondition + the #273.1 "different model" body is REQUEST_REJECTED
✖ keeps the upstream message AND adds a capability hint naming supports_images
✖ is NOT retryable, even when delivered as a 5xx shell
✖ maps REQUEST_REJECTED to 400 invalid_request_error
✖ classifies the 106-byte trailer as REQUEST_REJECTED (not UPSTREAM_INTERNAL)
✖ image to an unknown-capability model returns 400 with the upstream message + hint
✖ the streaming surface carries invalid_request_error, not a retryable upstream_error
✖ counts the rejection without benching the account
```

After: **16/16 pass** (`upstreammap-targeted.log` also includes the affected suites).

## 5. Targeted and full suites

```
node --import ./test/setup-env.mjs --test \
  test/connect-request-rejection.test.js test/devin-connect-upstream-internal.test.js \
  test/connect-error-blame.test.js test/devin-connect-failover.test.js \
  test/devin-connect.test.js test/connect-abort-cooldown.test.js \
  test/connect-capacity-cooldown.test.js test/connect-dimension-behaviour.test.js \
  test/connect-dimension-guard.test.js test/connect-selector-scope.test.js \
  test/connect-image-capability-gate.test.js test/route-error-parity-behaviour.test.js \
  test/stream-error.test.js test/messages.test.js
ℹ tests 473   ℹ pass 473   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0
```

Full suite (`node scripts/run-tests.mjs`, `upstreammap-full.log`):

```
TEST_DISCOVERY 556 unique files
ℹ tests 6814   ℹ suites 1285   ℹ pass 6717   ℹ fail 0   ℹ cancelled 0   ℹ skipped 97   ℹ todo 0
exit=0
```

`test/connect-error-blame.test.js` gained `REQUEST_REJECTED` in its `REQUEST_SIDE` list
(3 rejections + a healthy peer keep the account in rotation).

## 6. Mutation re-pin

New spec `test/mutations/connect-request-rejection.json` (2 test files, baseline 34).

```
node scripts/spec-static-check.mjs
  specs: 95   mutations: 845   ✓ anchors unique, specs well-formed, baselines are positive integers

node scripts/spec-baseline-check.mjs connect-request-rejection.json
  ok connect-request-rejection.json: 34 pass + 0 approved skips = 34 [MEASURED_NO_SKIPS]
  1 spec(s) measured, 0 drift, 0 untrustworthy
```

Measured verdicts (`upstreammap-mutation.log`) — the harness refuses to run on Windows by
design (`mutation-harness-utils.mjs` requires POSIX git), so this ran on the documented
WSL bench: Ubuntu 24.04, node v24.21.0, clean clone of this branch.

```
baseline 34 pass / 0 fail
CAUGHT 5  RR-M1  the 'internal error occurred' TEXT arm reclaims an explicit invalid_argument
CAUGHT 5  RR-M2  the 4xx-class arm keeps the old UPSTREAM_INTERNAL verdict
CAUGHT 4  RR-M3  drop the capability hint from the client message
CAUGHT 1  RR-M4  claim only invalid_argument, let failed_precondition pass through
CAUGHT 1  RR-M5  re-admit a permanent rejection to the in-process retry loop
CAUGHT 2  RR-M6  map the rejection back to the reported 503 UPSTREAM_INTERNAL surface
CAUGHT 2  RR-M7  charge the account's error budget for a request rejection
CAUGHT 1  RR-M8  stream the rejection as a retryable upstream_error
CAUGHT 1  RR-M9  lose the rejection counter
all 9 mutation(s) behaved as expected; tree clean
```

## 7. Decisions and non-goals

- **The gRPC code outranks the message text** for the `internal error occurred` shape. The
  text arm still owns every body with no 4xx code (the measured transient backend fault).
- **`failed_precondition` is claimed late on purpose.** The quota-dry body carries that
  status; `QUOTA_EXHAUSTED` (402) must keep winning, and CAPACITY / CONTENT_BLOCKED /
  MODEL_BLOCKED / SELECTOR_NOT_ELIGIBLE still win on their own text.
- **A 4xx code in a 5xx HTTP shell is still a 400.** The code is the validator's verdict;
  a genuine 5xx with no 4xx code (`internal`, `unavailable`, bare 500) is unchanged at 503.
- **No account penalty.** The token is alive; the new arm records a health-window event and
  a counter only. This is the same treatment CONTENT_BLOCKED/UPSTREAM_ERROR already had.
- **No in-process replay.** `isRetryable` excludes the verdict even when a status ≥ 500
  rides along.
- **Client message keeps the upstream text verbatim** and appends the hint, so clients that
  log or match the upstream wording still see it. The hint deliberately avoids the
  messages.js leak markers, or an Anthropic client would receive the generic text.
- The stream surface carries `invalid_request_error`, so SDKs do not treat it as a
  retryable upstream error.

## 8. Not verified

- **No live upstream call.** The 106 bytes are replayed verbatim from the §7.1 capture under
  the egress-denied test harness. A live re-run of the four §7.1 rows would confirm the new
  surface end to end on a real account; it was not performed in this lane.
- **Windows full suite only** in this lane (6814/0/97). Linux/Node 22 matrix is the wave's
  separate lane. The mutation verdict ran on WSL node v24.21.0.
- **`/v1/messages` and `/v1/gemini` surfaces** inherit the mapping through their shared
  fallbacks (400 → `invalid_request_error` / `INVALID_ARGUMENT`); their own tests are green
  but no live client capture was taken for the new code.

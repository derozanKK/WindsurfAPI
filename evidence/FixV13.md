# FixV13 — native bridge history truth (V-13 / KH-034)

Lane `BRIDGE` · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w16x-FixV13`
Branch `fix/v13-native-history-truth` · base `b3877065` (master) · no push, no tag, no merge.

Every claim below was measured on this host; nothing is inferred from the audit text alone.
"before" = the audited baseline `b3877065` (a detached worktree at the same commit, probe in
`w16x-FixV13-red`), "after" = this branch.

---

## 0. Defect, as measured

`buildAdditionalStepsFromHistory` encoded **every** mapped assistant `tool_call` as a completed
`CortexTrajectoryStep` (`status = DONE = 3`), whether or not a matching `role:"tool"` result
existed. A missing result therefore reached the planner as "ran, empty output". A failed Bash was
worse: the observation was written into **both** `full_output` and `stdout`, and `exit_code` was
hard-coded to `0`, so a non-zero command was replayed as success. Separately:

- `chat.js` stripped **all** `role:"tool"` and `assistant.tool_calls` messages when the bridge was
  on. The bridge only converts mapped calls, so unmapped pairs and orphan results were dropped
  between the two paths (skipped by the bridge, then filtered out of the text history).
- `additional_steps` was rebuilt from the full caller history on every turn, so a **reused**
  cascade received observation steps it already held.

### Probe, before → after

`w16x-FixV13-red/.tmp-v13-probe.mjs` (baseline source, read-only) → the same probe against this
branch. Input: an assistant `Bash` call with no result; a `Bash` call whose result is
`Exit code: 2\nOutput:\nls: cannot access /nope`; and `buildAdditionalStep('run_command', …)`
without an observation.

| probe | before `b3877065` | after |
|---|---|---|
| unobserved call → number of steps | `1` | `0` |
| unobserved step status | `3` (DONE) | — (no step) |
| failed Bash → `exit_code` | `0` | `2` |
| failed Bash → duplicate `stdout` field (4) | `true` | `false` (only combined_output 21) |
| `buildAdditionalStep` without `observed` | buffer (DONE) | `null` |

```
before: {"unobserved_steps":1,"unobserved_status":3,"failed_exit_code":0,
         "duplicate_stdout_field":true,"direct_without_observation":true}
after:  {"unobserved_steps":0,"unobserved_status":null,"failed_exit_code":2,
         "duplicate_stdout_field":false,"direct_without_observation":false}
```

---

## 1. Changes

### `src/cascade-native-bridge.js`

- `buildAdditionalStep(kind, args, { observed })` — **requires** `observed === true` to stamp
  `CASCADE_STEP_STATUS_DONE`; otherwise returns `null`. Completion is now an explicit claim the
  caller must back with a result.
- `buildNativeToolHistory(messages, { reuse })` (new; `buildAdditionalStepsFromHistory` is the
  narrow wrapper) — one pass over the caller history that returns:
  - `steps`: encoded for mapped calls **only when a tool result exists**. `run_command` writes
    `full_output` (combined_output field 21) only, and `exit_code` from
    `parseObservationExitStatus()` — plain-text `Exit code: N` / `exited with code N` /
    bracketed forms, codex-style JSON `exit_code` / `metadata.exit_code`, and Anthropic's
    `is_error` / `[tool error]` prefix. A signalled failure with no numeric code is encoded `1`
    (proto3 would otherwise read an absent field as `0` = success). Unknown status without a
    failure signal leaves the field absent.
  - `emulationMessages`: the same history with bridge-owned call/result pairs removed and
    unmapped calls, lossy forward translations (apply_patch sentinel) and orphan tool results
    retained for the emulation normalizer.
  - `reuse: true` (cascade resumed) restricts `steps` to the **newest pending tool round** — the
    last assistant `tool_calls` message when every message after it is a `role:"tool"` result.
    Earlier rounds are already in the reused cascade's trajectory; a user-message tail yields
    zero steps. `reuse: false` (fresh cascade) keeps the full history and reports `deltaStart`,
    the index where that pending round begins, so the wire can slice the already-built list
    instead of encoding the history a second time. A unit assertion pins
    `full.steps.slice(deltaStart)` equal to `reuse: true`'s output.
- `test/mutations/cascade-native-bridge-gates.json` — `expectBaselinePass` 68 → **71** (three new
  tests) and the observation-overlay anchor re-indented to the new loop depth; the historical
  provenance paragraph is annotated, not rewritten.

### `src/handlers/chat.js`

- `buildNativeToolHistory` is computed once (line 5101); `emulationMessages` feeds
  `normalizeMessagesForCascade(..., { injectUserPreamble: false })` so unmapped/orphan history is
  folded into the text the planner sees instead of being deleted (line 5252).
- `nativeOpts` carries `deltaStart` (line 5291). Both wire call sites (`nonStreamResponse`
  line 6039, `streamResponse` line 7971) slice `additionalSteps` from `deltaStart` when the pool
  checkout returned a reusable cascade, so a resumed cascade only receives the delta. The NLU
  correction retry keeps the full list because it starts a fresh cascade (`reuseEntry: null`).

---

## 2. Red-first

Baseline commit `b3877065`, tests copied into `w16x-FixV13-red`:

```
$ node --import ./test/setup-env.mjs --test test/cascade-native-bridge.test.js
SyntaxError: The requested module '../src/cascade-native-bridge.js' does not provide an export
named 'buildNativeToolHistory'
ℹ tests 1   ℹ fail 1
```

```
$ node --import ./test/setup-env.mjs --test test/native-tool-routing.test.js
▶ native bridge history truth (V-13)
  ✖ V-13: the wire keeps unmapped history and sends the observed mapped step with its failure status
  AssertionError [ERR_ASSERTION]: the failed Bash keeps its non-zero exit_code on the wire
    actual: 0
    expected: 2
ℹ tests 29   ℹ pass 28   ℹ fail 1
```

The baseline probe above is the behavioral red for the unit-level assertions (the unit file itself
cannot load on baseline because the new export is the fix). Commit `c13dc1da` is the test-only red
commit; `4462021e` is the fix (the amended fix commit also carries the `deltaStart` control
assertion and the mutation-spec re-pin).

---

## 3. Targeted suites (after)

```
$ node --import ./test/setup-env.mjs --test test/cascade-native-bridge.test.js \
    test/v2070-issue-fixes.test.js test/native-tool-routing.test.js
ℹ tests 127   ℹ suites 26   ℹ pass 127   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
```

```
$ node --import ./test/setup-env.mjs --test test/cascade-abort-side-effects.test.js \
    test/cascade-detach-lazy-resume.test.js test/cascade-image-history.test.js \
    test/cascade-metadata-egress.test.js test/cascade-poll-truncation-terminal.test.js \
    test/cascade-pool-restore-early-returns.test.js test/cascade-reuse-default-copy.test.js \
    test/cascade-stream-account-spend.test.js test/cascade-think-reroute.test.js \
    test/cascade-timeout-invalidation.test.js test/cascade-turn-flag.test.js \
    test/cascade-turn-snapshot-v2.test.js test/cascade-turn.test.js \
    test/native-bridge-docs.test.js test/native-bridge-smoke.test.js \
    test/native-bridge-stats.test.js test/native-read-wrapper.test.js \
    test/startserver-cascade-1m.test.js
ℹ tests 160   ℹ suites 32   ℹ pass 160   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
```

## 4. Full suite (after)

`npm test` (`node scripts/run-tests.mjs` → every top-level test file), at code commit `4462021e`
with only the §0/evidence docs commit on top:

```
ℹ tests 7024   ℹ suites 1324   ℹ pass 6927   ℹ fail 0   ℹ cancelled 0   ℹ skipped 97   ℹ todo 0
EXIT=0
```

Two earlier runs were red, both for infrastructure reasons rather than assertions:

1. `docs-consistency-guard` read the mutation spec while the anchor edit was still in flight
   (`hits=0`); after the anchor re-indent that guard is 47/47.
2. After the `deltaStart` refactor the same guard's §0 freshness check refused `5d603c3d`
   ("predates 2 src/ change(s)") and the smoke matrix failed on that sub-check. §0 was backfilled
   to `4462021e`; both pass in the final run above.

The declared mutation baseline is measured, not copied:

```
$ node scripts/spec-baseline-check.mjs cascade-native-bridge-gates.json
ok cascade-native-bridge-gates.json: 71 pass + 0 approved skips = 71 [MEASURED_NO_SKIPS]
1 spec(s) measured, 0 drift, 0 untrustworthy
```

## 5. Mutation spec

`test/mutations/cascade-native-bridge-gates.json` now declares 71 baseline tests and the overlay
anchor matches the new source exactly once:

```
$ node -e "…split(anchor)…"   → 8 anchors, each hits=1
$ node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js
ℹ tests 47   ℹ pass 47   ℹ fail 0
```

Mutation verdicts: see §6 (WSL harness; the helper throws at import on native Windows).

## 6. Mutation run

The helper throws at import on native Windows (`/usr/bin/git` is not visible to the harness), so
the committed tree (`4462021e`) was exported as a git bundle and run in WSL Ubuntu-24.04 with
`/opt/node24/bin/node` v24.21.0, exactly as the spec's provenance paragraph requires. The clone was
clean (`DIRTY: 0`) and the harness materialized its own workspace.

```
$ git clone -q /mnt/c/.../v13-mutation.bundle /tmp/v13mut && cd /tmp/v13mut
$ /opt/node24/bin/node scripts/mutate-verify.mjs test/mutations/cascade-native-bridge-gates.json
HEAD: 4462021
DIRTY: 0
baseline: test/cascade-native-bridge.test.js
baseline 71 pass / 0 fail

  CAUGHT 3   partitionTools drops the default allowlist gate …                (pass=68 fail=3)
  CAUGHT 1   the OFF kill-switch stops being consulted …                      (pass=70 fail=1)
  CAUGHT 1   the all_mapped precondition is dropped …                         (pass=70 fail=1)
  CAUGHT 1   NATIVE_XML_BODY_MAX is raised past any plausible block …         (pass=70 fail=1)
  CAUGHT 1   partialFunctionCallsPrefixLength never holds a partial tag …     (pass=70 fail=1)
  CAUGHT 1   the non-stream parser keeps a dangling <function_calls> block …  (pass=70 fail=1)
  CAUGHT 1   an invoke for a tool the caller never declared is still converted (pass=70 fail=1)
  CAUGHT 2   the assistant→tool history overlay writes an empty observation … (pass=69 fail=2)
all 8 mutation(s) behaved as expected; tree clean
MUTATION_EXIT=0
```

The overlay mutation (the only anchor that moved with this fix) is still caught — now by both the
existing view_file observation test and the new reused-delta test, which is the two-failure count
above.

---

## 7. Residuals / limits (deliberate, named)

1. **Reuse delta assumes the cascade still exists.** If the client's resume is rejected upstream
   (expired cascade) it fresh-starts and rebuilds the *text* history, but only the delta steps
   were sent. This is the same contract the reuse path already has (on resume the client sends
   only the last turn); the normal fresh request has no pool hit and still receives the full
   history. Duplicating every old step on every normal resumed turn is the bug being fixed.
2. **Unobserved mapped calls stay out of the emulation text.** Only unmapped / lossy / orphan
   history is retained. A mapped call the bridge owns but cannot observe has no result to report,
   and on a reused cascade the planner already holds its own proposal; this matches the previous
   text filter for that pair.
3. **Exit status is parsed from client-owned text.** Formats outside the recognized set (and
   without `is_error` / `[tool error]`) leave `exit_code` absent; the previous behavior wrote `0`
   for every command. Adding formats is additive.
4. **`additional_steps` stat/log counts candidates, not the wire delta.** The log at request start
   runs before the pool checkout (which decides reuse), so it reports the full candidate list; the
   wire value is the delta. Stats semantics unchanged.

## 8. Non-goals honoured

- Reverse translators (`decode*` / `reverse*`), the activation gate and `nativeAllowlistNameForTool`
  untouched.
- `normalizeMessagesForCascade` untouched; it is reused with `injectUserPreamble: false` exactly
  as the bridge path already behaved (the proto section carries the unmapped tool definitions).
- No changes outside the named call-site ranges in `chat.js` (native history build, cascade-message
  construction, the two `cascadeChat` call sites).

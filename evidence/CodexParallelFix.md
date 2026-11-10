# CodexParallelFix — `parallel_tool_calls:false` is served, never refused

Lane: `CodexParallelFix` · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w110-codexparallel`
Branch: `fix/codex-parallel-tool-calls` · base: `451250a` (`master`) · no push, no tag, no merge.

---

## 1. The regression, restated

Codex CLI 0.164 sends `parallel_tool_calls:false` on **29/29** captured requests
(`evidence/ClientSandboxes.md` §3.1, §3.3 C1), always together with 11 tools and
`tool_choice:"auto"`. Wave 2 taught `responsesToChat()` to forward the field
(`src/handlers/responses.js`, F1) — correct in itself, the surface used to drop a
first-class Responses parameter. But the chat route's gate answered

```
400 invalid_request_error / code=unsupported_parameter / param=parallel_tool_calls
```

whenever `DEVIN_CONNECT_TOOL_CHOICE` was not `1`, which is the **shipped default**.
Codex surfaced `turn.failed` and exited 1: the client was unusable against v3.10.x
with default config. The gate shipped in `d31e760` (v3.10.0); the 3.9.60 baseline
never saw it.

The field was **silently dropped** before wave 2, which is why Codex worked then.
The regression is not "the field reaches the gate" — it is "the gate turns a
preference into a hard error".

## 2. Reproduction

`evidence/CodexParallel-probe.mjs` drives the real `handleResponses` and the real
chat handler; only the connect transport is stubbed (no bytes leave the box, no
account is touched).

```
node --import ./test/setup-env.mjs evidence/CodexParallel-probe.mjs
```

Before the fix (`451250a`, passthrough off — the shipped default):

```json
{"label":"codex-shape with parallel_tool_calls:false","status":400,"modelCalls":0,"error":{"code":"unsupported_parameter","param":"parallel_tool_calls"}}
{"label":"same request WITHOUT the field","status":200,"modelCalls":1}
{"label":"parallel_tool_calls:true","status":200,"modelCalls":1,"forwardedParallelToolCalls":true}
```

After the fix (same probe, same env):

```json
{"label":"codex-shape with parallel_tool_calls:false","status":200,"modelCalls":1,"forwardedParallelToolCalls":false,"hintIgnoredDelta":1}
{"label":"same request WITHOUT the field","status":200,"modelCalls":1,"hintIgnoredDelta":0}
{"label":"parallel_tool_calls:true","status":200,"modelCalls":1,"forwardedParallelToolCalls":true,"hintIgnoredDelta":0}
{"label":"codex-shape with parallel_tool_calls:false [switch ON]","status":200,"modelCalls":1,"forwardedParallelToolCalls":false,"hintIgnoredDelta":0}
```

and the once-per-process notice, verbatim:

```
[WARN] Chat[...]: DEVIN_CONNECT event=parallel_tool_calls_hint_ignored — caller asked for
parallel_tool_calls:false and the #11 passthrough is off (DEVIN_CONNECT_TOOL_CHOICE is not "1";
tag unconfirmed), so the request is served without the hint and the upstream may return several
calls per turn. Counted per request; logged once per process.
```

## 3. Decision memo — (a) honour by default vs (b) accept + warn + count

### What the wire evidence actually supports

| Question | Evidence | Verdict |
|---|---|---|
| Is `#11 disable_parallel_tool_calls` a **verified** upstream coordinate? | `src/devin-connect.js` header: "UNCONFIRMED COORDINATES … DECLARATION ORDER in someone else's .proto, not a wire capture". `docs/AUDIT-LEDGER.md:1728`: the five wire-coordinate switches (`#13`/`#12`/`#11`/`credit_cost ^14`/`Metadata #21`) are **all default-off**, to be unlocked by one paid capture. | **No.** Tag number and bool encoding are guesses. |
| Does emitting it work when an operator opts in? | `evidence/ClientSandboxes.md` §3.3 C1 observation: with the passthrough **on**, `gpt-6-luna-max` returned exactly one `custom_tool_call` in **24/24** tool-call responses. | Suggestive, **not proof**: a model can also choose one call unaided, and no capture shows the field on the wire. |
| Does *not* emitting it leave the hint inert? | `evidence/ToolMatrixLive.md` §8: 4/4 models returned two calls with `parallel_tool_calls:false`. Measured while the chat handler did not forward the field at all (`evidence/ToolChoiceFlag.md` §1), so it proves the *pre-wave-1* inertness, not that `#11` fails. | The default-off state is **untested against the wire**, in both directions. |

### Option (a): emit `#11` whenever the caller says `false`

Rejected **as a default**. It would put an unconfirmed tag into every Codex request
on every turn. The repo has already paid for this class of mistake once: pointing
`tool_choice` at `#1` produced **two** `#1` fields and let a 10-byte value overwrite
the ~800-byte `ClientMetadata` the upstream authenticates on — a silent "auth
failure" (`docs/HISTORY-LEDGER-2026-08-docs.md:34`). `#11` is exactly the same
epistemic position, and a wrong bool at a wrong tag is undetectable from the
response. "Looks like the right field" is not evidence, and the repo's standing rule
for unverified coordinates is default-off until a capture lands
(`docs/AUDIT-LEDGER.md:1728`: 不要因为「看起来该开」就改默认).

Note the asymmetry that decides it: if `#11` is **wrong**, option (a) corrupts the
request for every caller; if `#11` is right but off, option (b) merely leaves the
call count to the model — which is the behaviour every shipped version before
v3.10.0 had, and which Codex 0.164 demonstrably tolerates (it worked against 3.9.60).

### Option (b): serve, warn once, count — **chosen**

* The request is served: a preference never costs a turn.
* The drop is **not silent**: one structured WARN per process
  (`event=parallel_tool_calls_hint_ignored`, naming the switch) plus a per-request
  counter `parallel_tool_calls_hint_ignored` in `/connect-metrics`.
* The counter is the measurement that would justify calibrating `#11` later: a
  non-zero value means real clients ask for it, and the count is the denominator for
  any future live A/B (switch on/off) — the same "measure before flipping a wire
  coordinate" rule the other four switches follow.
* Warn **once**, not per request: Codex sends the hint on every turn, so a
  per-request WARN would be permanent noise on a request the proxy deliberately
  accepts. The counter carries the rate; the warn carries the explanation.
* No `errorCount`, no account-health effect: nothing failed, and a caller preference
  must never degrade a token's standing.

### What is kept

* `parallel_tool_calls:true` — unchanged (upstream default; no field, no warn, no count).
* Absent — unchanged.
* `DEVIN_CONNECT_TOOL_CHOICE=1` — the hint is still honoured natively (`#11` on the
  wire) and **not** counted, so the counter measures exactly the ignored subset.
* The `/v1/messages` F2 mapping (`tool_choice.disable_parallel_tool_use` →
  `parallel_tool_calls:false`) still carries the Anthropic spelling into the same
  field, and that surface is served too.
* No other 400 gate was touched. No handler produces `unsupported_parameter` any
  more — the parallel hint was its only producer (the two remaining mentions in
  `src/` are historical comments), so the Anthropic-side error remap that existed
  solely to reword it is deleted (clean cutover, not a shim).

This supersedes §2 of `evidence/ToolChoiceFlag.md` ("honour or refuse, never
ignore"). That memo's premise — "a correctness hint, so a 400 is the honest
refusal" — is refuted by the shipped-client evidence: Codex 0.164 is a client that
handles multiple calls perfectly well and still sends `false` on every request.

## 4. Changes

| File | Change |
|---|---|
| `src/devin-connect.js` | `isParallelToolCallsUnsupported` → `isParallelToolCallsHintIgnored`; the predicate is unchanged (`=== false && !switch`) so "counted as dropped" and "would not be emitted" stay the same condition. Doc comment rewritten: preference, never refused. |
| `src/handlers/chat.js` | the 400 return is replaced by `bumpConnect('parallel_tool_calls_hint_ignored')` + a once-per-process structured `log.warn`. Still inside the `devin_connect` short-circuit, still before the drought gate. Adds `__resetParallelToolCallsHintWarn()` (test seam, same family as `__setConnectDeps`). |
| `src/devin-connect-metrics.js` | new counter `parallel_tool_calls_hint_ignored` (process-lifetime, exported by `getConnectMetrics()`); documented as expected-non-zero, never an account-health signal. |
| `src/handlers/messages.js` | `PARALLEL_HINT_REFUSED_MESSAGE` and the `param === 'parallel_tool_calls'` remap deleted; `toAnthropicChatError` loses its now-unused `body` parameter. |
| `test/parallel-tool-calls-connect.test.js` | rewritten for the new policy: Codex-shaped responses request → 200 + model called + counter; absent/`true` unchanged; warn-once + counter-per-request; honoured-when-on (and not counted); `tool_choice` threading; Cascade route untouched; `/v1/messages` served. |
| `test/responses.test.js` | the "surfaces the chat route 400" case is replaced by "serves a Codex-shaped request when the passthrough is off" (same test count). |
| `test/drought-gate-reachability.test.js` | the removed `return` is no longer an accepted escape above the drought gate; the enumeration still guards the two that remain. |
| `test/mutations/parallel-tool-calls.json` | 10 mutations re-pinned to the new policy (the regression itself, silent drop, switch-blind predicate, missing counter, per-request warn, ungreppable warn, wire forwarding, both `connectParams` threadings, F2 mapping). `expectBaselinePass` re-measured to 12. |
| `test/mutations/retry-after-route-parity.json` | anchor repaired (`toAnthropicChatError(result)`), the call site the parameter removal changed. |
| `docs/ENV-SWITCHES.md:225` | the `DEVIN_CONNECT_TOOL_CHOICE` row now documents serve + warn + counter instead of the 400. |
| `docs/DEVIN-CONNECT-CUTOVER.md` §7 | known-limits entry: the hint is served but not honoured by default, with the log event and counter named. |
| `.env.example` | declares `DEVIN_CONNECT_TOOL_CHOICE` / `DEVIN_CONNECT_TOOL_CHOICE_TAGS` — the runbook mention would otherwise be undiscoverable from the file readers consult, which the prose-docs guard enforces. |
| `evidence/CodexParallel-probe.mjs` | re-runnable reproduction (§2). |

## 5. Verification

Logs cited below live in the lane evidence directory
`C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/evidence/`
(the `…/evidence/` prefix in this memo).

Acceptance command (brief), final tree (`5a5095b` + docs), plus the three focused
suites and the two guards this lane touches:

```
node --import ./test/setup-env.mjs --test test/responses.test.js test/chat*.test.js test/devin-connect*.test.js \
  test/parallel-tool-calls-connect.test.js test/drought-gate-reachability.test.js \
  test/retry-after-route-parity.test.js test/docs-consistency-guard.test.js \
  test/default-on-switch-registry.test.js
ℹ tests 1220   ℹ suites 164   ℹ pass 1220   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
```

(log: `…/evidence/w110-final-acceptance.log`; the brief's three patterns alone are
1144 pass / 0 fail — the remaining 76 are the focused suites and the two guards.)

Focused suites: `parallel-tool-calls-connect` 12/12, `drought-gate-reachability`
10/10, `retry-after-route-parity` 5/5.

Red-first: the new suite failed on `451250a` for the behavioural reason, not just a
missing seam — 4 failures, e.g.

```
✖ serves a Codex-shaped responses request (field + tools) and calls the model
  actual: 400, expected: 200
✖ accepts tool_choice.disable_parallel_tool_use instead of refusing it
  actual: 400, expected: 200
✖ warns once per process ... got 0 lines
```

Mutations (WSL, `node scripts/mutate-verify.mjs test/mutations/parallel-tool-calls.json`):
see §6.

## 6. Mutation results (WSL, Node v24.21.0, clone of `b8a7d24`)

`node scripts/mutate-verify.mjs test/mutations/parallel-tool-calls.json`
(log: `…/evidence/w110-mut-parallel.log`):

```
baseline 12 pass / 0 fail

  CAUGHT 4   REGRESSION: the 400 comes back for parallel_tool_calls:false
  CAUGHT 4   the drop goes silent again: the predicate never fires
  CAUGHT 1   the predicate ignores the passthrough switch
  CAUGHT 4   the counter is dropped
  CAUGHT 1   the warn fires on every request instead of once per process
  CAUGHT 1   the warn stops naming the event and the switch
  CAUGHT 1   streamChat stops forwarding the opt-in fields
  CAUGHT 5   the handler stops threading parallel_tool_calls into connectParams
  CAUGHT 1   the handler stops threading tool_choice
  CAUGHT 1   the /v1/messages F2 mapping is dropped

all 10 mutation(s) behaved as expected; tree clean
```

The first run of this spec **found a real gap**: `tool_choice` threading
SURVIVED, because replacing the old refusal test had dropped the only assertion on
it. The test was restored (commit `b8a7d24`), the baseline re-pinned 11 → 12, and the
mutation is caught now — recorded here because a mutation that survives is evidence
about the tests, and deleting it instead would have hidden the loss.

`node scripts/mutate-verify.mjs test/mutations/retry-after-route-parity.json`
(log: `…/evidence/w110-mut-retry-after.log`): anchor repaired after the
`toAnthropicChatError` signature change; `all 6 mutation(s) behaved as expected`
(5 caught, 1 documented survivor), baseline 5/5.

Specs whose test lists include this lane's acceptance files were re-measured for
baseline drift with `scripts/spec-baseline-audit.mjs` on `56f9fb8` (log:
`…/evidence/w110-baseline-audit.log`) — 13 specs, every one `1/1 match, 0 drifted,
0 untrustworthy`:

```
alias-resolver-systemic 57 · connect-catalog-hotfix 55 · cred-gcm-tag-length 21
credit-cost-top-level 197 · devin-connect-warning-cache 6 · reasoning-continuity 326
response-id-entropy-guard 60 · responses-post-tool-text-item 75
responses-stream-done-sentinel 62 · retry-rescue-budget-split 89
session-continuity-compaction-survival 50 · unary-body-bound 9 · usage-unknown-not-zero 65
```

`test/responses.test.js` kept its test count (the refusal case was replaced 1:1), which
is why none of the specs that sum it drifted. Only the two specs above needed
mutation runs, because only they anchor on text this lane changed.

## 7. What is NOT verified here

* **No live upstream turn.** Every 200 above is at handler level with the connect
  transport stubbed. Whether the upstream honours `#11` when the switch is on is
  still an unverified wire question (see §3) — this lane deliberately does not flip
  that default, so nothing about the live wire changed.
* **The real Codex CLI was not re-run** in this lane. The client-level PASS for
  0.164 with the switch on, and the 400 with it off, are the ClientSandboxes lane's
  captures (`evidence/ClientSandboxes.md` §3); this lane only removes the 400.
* **Counter is process-lifetime** by design (same as every other connect counter);
  a restart resets it, so a scraper must rate it, not treat it as a total.
* `evidence/ClientSandboxes.md` and `evidence/ToolMatrixLive.md` live in the parent
  checkout / lane evidence dir, not in this branch (they are untracked there).

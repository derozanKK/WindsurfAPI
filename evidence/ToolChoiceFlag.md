# ToolChoiceFlag — `parallel_tool_calls:false` is honoured or refused, never ignored

Lane: `ToolChoiceFlag` · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w92-toolchoice`
Branch: `fix/tool-choice-flag` · base: `d338b36` (`release/3.10.0`) · no push, no tag.

---

## 1. The live finding, restated

`evidence/ToolMatrixLive.md` §8 (measured 2026-10, main working tree): with the same
two-tool prompt and `parallel_tool_calls:false`, **4/4** DEVIN_CONNECT models still
returned both calls (`finish_reason:"tool_calls"`). The doc attributes it to
`DEVIN_CONNECT_TOOL_CHOICE` being unset.

That attribution is only half the defect. Reading the code on `d338b36`:

* `handlers/chat.js` contained **zero** references to `parallel_tool_calls` — the
  handler never read the field, so `connectParams` never carried it;
* `streamChat()` (`src/devin-connect.js:2846`) did not accept `parallelToolCalls` or
  `toolChoice` and did not pass them to `buildGetChatMessageRequest()`.

So the switch was inert **even when an operator set `DEVIN_CONNECT_TOOL_CHOICE=1`**:
the only code that emitted #11/#12 was reachable from unit tests calling the wire
builder directly, never from `/v1/chat/completions`. The `tool-choice-passthrough`
suite was green while the production route emitted neither field.

## 2. Decision — honour natively, or refuse; never serialise

`parallel_tool_calls:false` is a **correctness hint** ("emit at most one tool call
this turn"), not a style preference. A client that applies tool calls as side effects
cannot detect that the proxy dropped it.

Three candidate behaviours, and why two were rejected:

| Option | Verdict |
|---|---|
| **Serialise at the proxy** | Rejected. The upstream decides the call count inside one turn. Emitting only the first of N would discard work the model already performed, and the client would never learn the other calls existed — a worse silent failure than the one being fixed. |
| **Reject the parameter unconditionally (400)** | Rejected as the primary path: it would throw away the honourable configuration the repo already ships (`DEVIN_CONNECT_TOOL_CHOICE=1`, #11 `disable_parallel_tool_calls`), i.e. make a solvable request unsolvable. |
| **Honour when the wire field is enabled; 400 when it is not** | **Chosen.** The two honest states are "the hint reached the upstream" and "the caller is told it cannot". There is no third state where the proxy pretends. |

Scoping: the gate lives inside the `flow === 'devin_connect'` short-circuit. The
switch and the #11 tag are connect-only, so a Cascade request must never be refused
over a connect knob. The Cascade route keeps its previous behaviour; see §6.

## 3. Changes

| File:line | Change |
|---|---|
| `src/devin-connect.js:1173-1191` | `isParallelToolCallsUnsupported(parallelToolCalls, env)` — true only for the exact boolean `false` with `DEVIN_CONNECT_TOOL_CHOICE` not `'1'`. Mirrors the builder's own emission condition (`=== false`), so "refused" and "would be dropped" are the same predicate, not two copies that can drift. |
| `src/devin-connect.js:2846-2850` | `streamChat()` accepts `toolChoice` / `parallelToolCalls`. |
| `src/devin-connect.js:2914` | forwards both into `buildGetChatMessageRequest()` — the missing link that made the switch inert on the live route. |
| `src/handlers/chat.js:63` | imports the predicate. |
| `src/handlers/chat.js:3526-3552` | the gate: `400`, `type:'invalid_request_error'`, `code:'unsupported_parameter'`, `param:'parallel_tool_calls'`, message naming `DEVIN_CONNECT_TOOL_CHOICE=1`. Placed after model resolution and **before** the drought/capacity gate, so a permanent request-shape error is not masked by a transient 503 (a client told "retry later" would loop forever on a request that can never succeed). No account is acquired, no upstream turn is spent. |
| `src/handlers/chat.js:3817-3828` | `connectParams` carries `parallelToolCalls` and `toolChoice`. Both are inert unless the switch is on, so the default wire is unchanged. |
| `src/handlers/messages.js:146-167` | `toAnthropicChatError()` — the refusal restated in Anthropic vocabulary. `/v1/messages` maps `tool_choice.disable_parallel_tool_use` onto `parallel_tool_calls:false` (F2), so the raw chat.js message both names a field the caller never sent and contains the internal backend name, which `clientFacingMessage()` treats as a leak and replaces with the generic "Invalid request" — an opaque 400 the client cannot act on. Used by both error exits (`:1919`, `:1943`). |
| `test/parallel-tool-calls-connect.test.js` | new, 10 tests (§4). |
| `test/drought-gate-reachability.test.js:214-223` | registers the new pre-gate `return` as an accepted escape point with its reason — the repo's structural guard requires exactly that for any return above the drought gate. |
| `test/mutations/parallel-tool-calls.json` | 6 mutations (§5). |
| `test/mutations/retry-after-route-parity.json` | anchor repaired: it pointed at the exact expression the messages change replaced (the docs guard requires every anchor to match exactly once). |
| `docs/ENV-SWITCHES.md:225` | documents the 400 on the `DEVIN_CONNECT_TOOL_CHOICE` row. |

`tool_choice` was wired on the same switch: it sits in the same gate, the same wire
builder signature and the same inertness bug, and shipping `parallelToolCalls` alone
would have left the feature half-connected while the docs claim the switch forwards
both. No behaviour changes while the switch is off.

## 4. Red first

`node --test test/parallel-tool-calls-connect.test.js` **before** the implementation:
`tests 9 / pass 3 / fail 6`. The six red tests were the defect itself:

```
✖ rejects with 400 unsupported_parameter when the passthrough switch is off
✖ forwards parallel_tool_calls:false to the connect layer when the switch is on
✖ forwards tool_choice on the same switch (the other half of the same gate)
✖ accepts parallel_tool_calls:true — the upstream default needs no field
✖ emits #11 when the switch is on and the caller said false
✖ emits #12 for a non-default tool_choice when the switch is on
```

The three that were green on base are the invariants that must **not** change:
absent flag accepted, `true` accepted, and the default wire emitting neither #11 nor #12.

After the implementation: `tests 10 / pass 10 / fail 0`.

The tenth test — the `/v1/messages` vocabulary — is not part of the red count: it
guards the remap added in the second commit, and it fails exactly when the gate exists
without that remap (mutation 6), which is the regression it exists to catch.

What each side pins:

* **handler level** — `__setConnectDeps` captures `connectParams` with no network turn,
  so "the flag reached the connect layer" and "the rejection happened before any
  upstream turn" (`seen.length === 0`) are both observable.
* **wire level** — the real `streamChat` + `__setRequestImpl` transport seam captures
  the exact request bytes; the proto after the 5-byte frame header is parsed for
  #11/#12. This is the assertion that would have caught the original inertness.
* **route scope** — a Cascade-routed request with `parallel_tool_calls:false` must not
  come back `unsupported_parameter`.
* **protocol vocabulary** — the real `handleMessages` → `handleChatCompletions` chain
  must return a 400 that names `disable_parallel_tool_use` and is *not* the generic
  "Invalid request".

## 5. Mutation check

The repo's harness (`scripts/mutate-verify.mjs`) **cannot start on this Windows host**:
`scripts/mutation-harness-utils.mjs:16-21` hard-requires a POSIX `/usr/bin/git` and
throws `mutation harness requires git at a trusted absolute path` before reading the
spec. The six mutations were therefore run with the harness's own mechanism —
exact-once anchor replacement, suite run, restore from `HEAD:<file>` — and the spec is
committed in the harness's format so a Linux runner (HMC / CI) can execute it unchanged.

Baseline asserted at exactly 10 passing. All six were **CAUGHT**:

| Mutation | Result |
|---|---|
| gate removed (`return false`) — the live defect returns | CAUGHT (8 pass / 2 fail) |
| gate ignores the switch — the honourable path becomes unreachable | CAUGHT (9/1) |
| `streamChat` stops forwarding — switch inert on the live route again | CAUGHT (9/1) |
| handler stops threading `parallel_tool_calls` — accepted, then dropped one layer down | CAUGHT (8/2) |
| handler stops threading `tool_choice` — the other field stays inert | CAUGHT (9/1) |
| `/v1/messages` remap dropped — the refusal reaches an Anthropic client as the opaque "Invalid request" | CAUGHT (9/1) |

## 6. Residuals (explicitly out of scope)

* **Cascade / legacy / ACP routes** still ignore `parallel_tool_calls`. The ticket
  names the connect route; those backends expose no wire field and no switch, so a
  refusal there would cite a knob that cannot help them. If the finding is later
  reproduced on Cascade, the same predicate can be lifted to the top-level validation
  block — but then the message must stop naming a connect-only switch.
* **Non-boolean values** (`"false"`, `0`) are still ignored. The measured finding is
  the boolean; rejecting non-booleans is an `invalid_type` concern for the whole
  request schema, not this ticket.
* **`DEVIN_CONNECT_TOOL_CHOICE=1` itself remains opt-in and unconfirmed.** Enabling it
  writes tag #12/#11 from third-party declaration order; a wrong tag is decoded as a
  different field upstream. That risk is unchanged and documented in
  `docs/ENV-SWITCHES.md` — this change only makes the switch *reach* the wire.
* **No live re-probe.** The proof here is code-level: the field now reaches the wire
  under the switch, and the un-honourable case is a 400. Whether the upstream obeys
  #11 is exactly the unconfirmed-coordinate question the switch exists to answer, and
  it needs one paid capture.

## 7. Verification

```
$ node --test test/parallel-tool-calls-connect.test.js
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

```
$ node scripts/run-tests.mjs          # full suite, this worktree
TEST_DISCOVERY 533 unique files
ℹ tests 6558
ℹ pass 6461
ℹ fail 0
ℹ cancelled 0
ℹ skipped 97
exit=0
```

One cross-file flake observed once during an earlier full run
(`test/cascade-turn-flag.test.js` "both poll the same bounded windows", 6 vs 5 zeros);
it passes standalone on **both** this worktree and the untouched `integrate3100` base,
and the rerun above is clean — unrelated to this change, which touches no polling code.

Mutation run: see §5 / the commit message.

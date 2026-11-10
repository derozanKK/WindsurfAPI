# SweToolId — `swe-2-medium` client-visible tool-call id shape

Lane: `SweToolId` · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w93-sweid`
Branch: `fix/swe-tool-id` · base: `d338b36` (`release/3.10.0`) · no push, no tag.

---

## 1. Finding and source

Live matrix run (ToolMatrixLive §7; the probe lives in the wave's main tree): the Devin Connect upstream returns
`ChatToolCall.id` in its own dialect — `get_weather:0#<uuid>` for `swe-2-medium`:

```
swe: {"message":{"role":"assistant","content":null,"tool_calls":[{"id":"get_weather:0#62786027996b4c40886cc7262bdf7382", ...}]}}
     multi-parallel: get_weather:0#8ec9025e893c4f03900412b2a7fb2915, get_time:1#bc94259feb84474faffc448f505465c8
```

The adapter forwarded those ids verbatim (`devin-connect-openai.js`: `id: tc.id || fallback`).
They are legal JSON strings, but they are not the OpenAI `call_<opaque>` shape. The ACP / Devin
Local surface had the same gap: `special-agent.js` `openAiToolCalls()` passed the CLI's
`toolCallId` through verbatim.

## 2. Fix — one normalizer, applied at the two devin egress surfaces

`src/tool-ids.js:57-119` adds the shared mapping:

* `toClientToolCallId(rawId, fallback)` — ids already matching `^call_[A-Za-z0-9_-]+$` are
  identity; a non-conforming upstream id becomes `call_e1_<base64url(raw)>`; a missing id uses
  the caller's existing fallback (`call_<slot>_<base36 time>`, already conforming).
* `fromClientToolCallId(clientId)` — decodes only the versioned `call_e1_` form and only on a
  canonical base64url round-trip, so an id that merely looks like ours is never rewritten.
* `restoreUpstreamToolIds(messages)` — walks assistant `tool_calls[].id` and every
  `tool_call_id`, rewriting only ids this proxy minted; returns the original array when nothing
  changes (no allocation on the hot path).

Egress call sites:

* `src/devin-connect-openai.js:732` (non-stream `toChatCompletion`) and `:886-898` (stream
  `emitToolCalls`) — native **and** emulated calls go through `toClientToolCallId`. The stream
  path normalizes once *before* `collectedToolCalls.push`, so the emitted delta, the returned
  `result.toolCalls` (session-continuity commit / cache) and the client all agree on one id.
* `src/special-agent.js:534-547` (`openAiToolCalls`, both non-stream and `streamFromText`) — the
  ACP runner's raw `toolCallId` still keys `tool_call`/`tool_call_update` inside the pump; only
  the client projection is normalized.

## 3. Where internal correlation is kept

The upstream id is **not** lost; it is carried reversibly and restored at the wire boundary:

* `src/devin-connect-openai.js:251-260` — `withUpstreamToolIds(params)` is applied to
  `attemptParams` immediately before `streamChatImpl(callParams)` (`:389-402`), i.e. after all
  handler-side work (normalization for the prompt, session continuity, cache keys) and
  immediately before `devin-connect.js:2894` builds the proto.
* `devin-connect.js:1549-1594` then encodes the restored id into `#6 ChatToolCall{1:id}` and
  `#7 tool_call_id` — byte-identical to what the upstream issued, which is what the upstream saw
  before this change.
* The mapping is **stateless**: no process-global map, so a follow-up turn served by another
  worker or after a restart still restores the exact id. `call_e1_` is the encoding version.

Client-visible ids for the live fixture: `call_e1_Z2V0X3dlYXRoZXI6MCNhYmM` (and the same scheme
for the parallel batch) — both match `^call_[A-Za-z0-9_-]+$`.

## 4. Red first

New test file `test/devin-tool-id-shape.test.js` (10 tests) plus updated ACP expectations in
`test/devin-acp-tool-updates.test.js` (`tc1` → `toClientToolCallId('tc1')`, regex asserted).
Before the implementation both files failed to load:

```
test/devin-tool-id-shape.test.js:17
import { toClientToolCallId, fromClientToolCallId } from '../src/tool-ids.js';
SyntaxError: The requested module '../src/tool-ids.js' does not provide an export named 'fromClientToolCallId'
ℹ tests 1  ℹ pass 0  ℹ fail 1

test/devin-acp-tool-updates.test.js:8
import { toClientToolCallId } from '../src/tool-ids.js';
SyntaxError: The requested module '../src/tool-ids.js' does not provide an export named 'toClientToolCallId'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

An intermediate green attempt also exposed a real gap: the streaming delta was normalized but
`result.toolCalls` (session commit) still held the raw id — pinned by
`normalizes the live id on the streaming surface`, then fixed by normalizing before the push.

## 5. Green

```
node --import ./test/setup-env.mjs --test test/devin-tool-id-shape.test.js
ℹ tests 10  ℹ pass 10  ℹ fail 0

node --import ./test/setup-env.mjs --test test/devin-tool-id-shape.test.js test/devin-connect-openai.test.js test/devin-connect.test.js test/tool-ids.test.js
ℹ tests 311  ℹ pass 311  ℹ fail 0

node --import ./test/setup-env.mjs --test test/devin-acp-*.test.js test/special-agent-*.test.js
ℹ tests 132  ℹ pass 132  ℹ fail 0

node --import ./test/setup-env.mjs --test test/cline-compat-emit.test.js test/devin-connect-priming-recovery.test.js test/connect-*.test.js test/chat-orphan-guard.test.js test/issue-236-prose-tool-intent.test.js test/session-continuity.test.js
ℹ tests 293  ℹ pass 293  ℹ fail 0

node --import ./test/setup-env.mjs --test test/responses*.test.js test/messages*.test.js test/gemini*.test.js test/startserver-harness-shapes.test.js test/wire-byte-identity.test.js test/history-normalize.test.js
ℹ tests 403  ℹ pass 402  ℹ fail 0  ℹ skipped 1 (no WIRE_BASE_TREE baseline)

node --import ./test/setup-env.mjs --test test/tool-emulation*.test.js test/tool-ids.test.js test/tool-hygiene-kill-switch.test.js test/history-budget.test.js test/response-store*.test.js
ℹ tests 355  ℹ pass 355  ℹ fail 0
```

Full suite (`node scripts/run-tests.mjs`):

```
ℹ tests 6558  ℹ suites 1235  ℹ pass 6461  ℹ fail 0  ℹ cancelled 0  ℹ skipped 97
```

Mutation-spec static check (no source anchors drifted):

```
node scripts/spec-static-check.mjs
specs: 89   mutations: 791
✓ anchors unique, specs well-formed, baselines are positive integers
```

## 6. Notes / limits

* Already-conforming ids (GPT's `call_kJ0…`, Gemini's `call_2806457`, emulated `call_…`) are
  byte-identical to before. Claude's `toolu_…` and SWE's `name:index#uuid` are normalized.
* The reversible encoding makes the client id 5 + 4/3·N chars (65 for the live SWE id). This is
  deliberate: a hash + process map would lose the original after a restart or on a different
  worker, and the upstream native replay needs the original.
* No live upstream request was made in this lane (production `:18999` untouched). The claim
  "upstream accepts the restored id" is the pre-existing wire behavior — the restore reproduces
  exactly the id the upstream issued; only the client-visible value changed.

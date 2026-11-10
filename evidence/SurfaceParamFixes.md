# Lane SurfaceParamFixes — dropped request params on `/v1/responses` and Gemini

- Base: `0cae51b` (master, v3.10.1 + PR #281 + alias fixes merged)
- Branch: `fix/surface-param-truth`
- Worktree: `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w107-surfaceparams`
- Findings source: `evidence/DataAuditTools/findings.md` (F1, F2, F5, F4)
- No push, no tag, no merge.

## Verdict table

| Finding | Param | Verdict | Test file |
|---|---|---|---|
| F1 | `/v1/responses` `parallel_tool_calls` | **DONE** | `test/responses.test.js` (2 describes) |
| F2 | Gemini `generationConfig.candidateCount` | **DONE** | `test/gemini-candidate-count.test.js` |
| F5 | Gemini `generationConfig.topK` | **DONE** | `test/gemini-topk-passthrough.test.js` |
| F4 | `/v1/responses` `metadata` | **SKIPPED — needs store-schema work** (see below) | — |

Acceptance command (green, exit 0):

```
node --import ./test/setup-env.mjs --test test/responses.test.js test/gemini*.test.js test/response-store*.test.js
ℹ tests 313
ℹ suites 63
ℹ pass 313
ℹ fail 0
```

Full logs: `evidence/SurfaceParamFixes/green.log` (acceptance run) and
`evidence/SurfaceParamFixes/red.log` (same test files against the pre-fix `src/`).

## Red-first method

Tests were written first and run against `src/` with only the two source edits stashed
(`git stash push -- src/handlers/responses.js src/handlers/gemini.js`), so the red log is the
new tests failing on the unmodified base and nothing else:

```
ℹ tests 63
ℹ pass 54
ℹ fail 9
```

The 9 red failures, by fix:

```
✖ rejects candidateCount>1 with 400 INVALID_ARGUMENT naming candidateCount (non-stream)
    200 !== 400  — a candidateCount:2 request returned one candidate
✖ rejects candidateCount>1 on the streaming path too, before any byte is streamed
✖ maps topK onto the internal top_k next to top_p
    undefined !== 40
✖ carries top_k through handleGemini to the chat handler
    undefined !== 40
✖ forwards the field instead of dropping it
    undefined !== false
✖ hands parallel_tool_calls:false to the chat handler
    the chat gate must be able to see the hint
✖ surfaces the chat route 400 for parallel_tool_calls:false when the passthrough is off
    401 NO_TOKEN !== 400  — the hint was dropped, so the request ran past the gate to auth
✖ passes parallel_tool_calls:true through to the connect layer unchanged
✖ honours parallel_tool_calls:false when DEVIN_CONNECT_TOOL_CHOICE=1
```

The two positive-control assertions (`candidateCount:1` / no `candidateCount`, and
`topK` absent → no `top_k` key) pass in both states by design: they pin that the fix adds no
key the caller did not send.

## F1 — `/v1/responses` `parallel_tool_calls` (DONE)

**Defect.** `responsesToChat` built the chat body from an explicit allow-list and never read
`parallel_tool_calls`, so the chat route's gate (`src/handlers/chat.js:3593`) — 400
`unsupported_parameter` when the #11 passthrough is off, honoured when
`DEVIN_CONNECT_TOOL_CHOICE=1` — was unreachable from this surface. A client that moved
between the two OpenAI surfaces got different honesty for the same payload.

**Change.** `src/handlers/responses.js:665`:

```js
...(body.parallel_tool_calls != null ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
```

No second gate was written: the chat handler already owns the decision, and duplicating it
here would create two places to keep in sync.

**Tests (red → green).**
- `responsesToChat` forwards `false` / `true`, omits the key when absent.
- `handleResponses` hands the value to the chat handler (stub capture).
- With the real `handleChatCompletions` and `DEVIN_CONNECT=1` /
  `DEVIN_CONNECT_TOOL_CHOICE` unset: **400** `unsupported_parameter`, `param:
  parallel_tool_calls` (was 401 NO_TOKEN in red — the request ran past the gate).
- With `DEVIN_CONNECT_TOOL_CHOICE=1`: the value reaches
  `buildGetChatMessageRequest` as `parallelToolCalls:false` (captured at the
  `__setConnectDeps` seam) and the request completes 200.
- `true` is unchanged: reaches the connect layer as `true`, no 400.

## F2 — Gemini `generationConfig.candidateCount` (DONE)

**Defect.** `geminiToOpenAI` never read `candidateCount`, so the chat `n` gate
(`src/handlers/chat.js:3325-3340`) could never fire on this surface. `candidateCount:2`
returned 200 with a single candidate; a client sampling/voting across candidates read
`candidates[1..]` as `undefined`.

**Change.** `src/handlers/gemini.js:851-869` — refuse in `handleGemini` before
`geminiToOpenAI`, mirroring the chat rule `count != null && count !== 1`:

```js
const candidateCount = body?.generationConfig?.candidateCount;
if (candidateCount != null && candidateCount !== 1) {
  return geminiError(400, null,
    'This proxy only supports candidateCount=1. The upstream backend returns a single candidate per request; set generationConfig.candidateCount to 1 (or omit it).');
}
```

`geminiError(400, …)` emits the Gemini error shape
`{error:{code:400,message,status:'INVALID_ARGUMENT'}}`. Placed before the translator so it
covers **both** `:generateContent` and `:streamGenerateContent`, and before any model turn
(the test asserts the chat handler is never called and no stream handler is returned).

**Tests (red → green).** non-stream 400; streaming 400 with no `stream` handler; `count:1`
passes through with no `n` key; absent count untouched.

## F5 — Gemini `generationConfig.topK` (DONE)

**Defect.** `geminiToOpenAI` mapped `temperature`/`topP`/`maxOutputTokens` but dropped
`topK`, while `/v1/messages` forwards `top_k` and the DEVIN_CONNECT chat path consumes
`top_k` into `CompletionConfig.topK` (`src/handlers/chat.js:3974`). Gemini was the one
surface that never filled the field.

**Change.** `src/handlers/gemini.js:370`:

```js
...(gc.topK != null ? { top_k: gc.topK } : {}),
```

**Tests (red → green).** `geminiToOpenAI` maps `topK:40` → `top_k:40` alongside `top_p`;
omits `top_k` when absent; `handleGemini` carries `top_k` to the chat handler. The remaining
hop (`top_k` → `CompletionConfig.topK`) is already pinned by
`test/devin-connect-failover.test.js` “forwards temperature/top_p/top_k/max_tokens from the
request into connect params”.

## F4 — `/v1/responses` `metadata` (SKIPPED, documented)

**Why skipped.** The ticket allows this only if the store record already has a slot or the
change is ≤10 lines. Neither holds:

- `src/response-store.js:559-561` stores exactly
  `{messages, callerKey, model, status, incompleteReason, createdAt, lastAccess, bytes}` —
  no `metadata` slot. Zero `metadata` references in `src/handlers/responses.js` or
  `src/response-store.js`.
- Persisting it correctly is not a field add: `metadata` is caller-controlled and the
  store's byte bound (`MAX_ENTRY_BYTES` / `MAX_BYTES`) is computed from `messages` only
  (`putResponse`'s `approxBytes(kept)`), so an unbounded metadata object would be retained
  outside every existing limiter. A safe implementation needs OpenAI's documented limits
  (≤16 pairs, ≤512-char values) enforced at the boundary, the retained bytes counted, and
  the echo wired into `chatToResponse`, the stream translator's `responseBase`, `getResponse`
  and `storedResponseBody` — i.e. store-schema work.
- A POST-only echo was rejected as a half-fix: `GET /v1/responses/{id}` and
  `previous_response_id` chains would still lose the tag, contradicting the contract the
  findings' acceptance test describes.

**Follow-up shape** (for a lane that can take store-schema work): validate/bound metadata in
`handleResponses` → `putResponse(..., { metadata })` → return it in `getResponse` (deep-copied
via `copyStoredValue`) → echo in `chatToResponse` + `responseBase` + `storedResponseBody`,
and include its bytes in `approxBytes`/tenant accounting.

## Regression surface

- Acceptance: **313/313** (responses, all `gemini*`, all `response-store*`).
- Additional: `node --import ./test/setup-env.mjs --test test/responses*.test.js` — **173/173**
  (includes `responses-retrieve*`, `responses-chain-scope`, `responses-stream-*`, which read
  the same `responsesToChat` output).
- No changes to `src/handlers/chat.js`, `src/response-store.js`, or any other file.
- `[UNVERIFIED]` Live upstream behaviour was not probed from this lane; the fixes are
  translation-layer forwarding/gating pinned by the tests above, and the honoured F1 path is
  pinned at the connect-parameter seam (`__setConnectDeps`), not on a live account.

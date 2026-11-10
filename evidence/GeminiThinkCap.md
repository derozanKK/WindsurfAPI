# Lane GeminiThinkCap — `max_tokens` vs thinking (gemini-3-6-flash-medium)

- Base: `d338b36` (release/3.10.0), branch `fix/gemini-think-cap`
- Worktree: `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w90-gemcap`
- No push, no tag. Production `:18999` untouched; no live probe was run from this lane.

## Live finding (source of truth)

`evidence/ToolMatrixLive.md`, flag 2:

> **`gemini-3-6-flash-medium` `max_tokens` does not bound thinking.** `completion_tokens`
> 105 with `max_tokens:64`, and 271 with `max_tokens:128`, while the visible answer was a
> short string. `max_tokens:16` also leaked the thinking text into `content` with
> `finish_reason:"length"`. GPT shows the same overrun at 16 (32 > 16).
> **Flag: cap is advisory for reasoning tokens.**

## Root cause

The upstream counts thinking inside `completion_tokens` but does not bound thinking by the
requested cap. The proxy then decided the terminal state with:

- `src/devin-connect.js:2795` — `resolveFinishReason` upgraded a clean `stop` to `length`
  only on **strict equality** (`completion === cap`). Every overrun (`105 > 64`,
  `271 > 128`) missed that test, so the turn reported a clean `stop`: a budget overrun
  indistinguishable from a complete answer.
- `src/devin-connect-openai.js` — both adapters (`toChatCompletion`,
  `streamChatCompletion`) trusted the finish event's reason verbatim, so there was no
  cap check at the boundary where the OpenAI-shaped response is born (the shape all four
  protocol routes read).

The `max_tokens` value itself does reach the wire (`CompletionConfiguration #2`, fixed in
`completion-config-max-tokens-tag.test.js`); the defect is not a lost request field. It is
the terminal-state accounting.

## Fix

1. **`src/devin-connect.js`** — new exported `applyOutputCap(finishReason, usage, maxTokens)`:
   a clean `stop` becomes `length` when `completion_tokens >= cap`. Only `stop` is
   upgradeable (`tool_calls` / `content_filter` / `error` are stronger statements).
   `resolveFinishReason` now delegates its usage check to this one rule, so the wire layer
   and the adapters cannot drift. `DEVIN_CONNECT_STOP_REASON_MAP` operator overrides still
   win (checked before the helper is called).
2. **`src/devin-connect-openai.js`** — both adapters apply the rule at the terminal
   boundary using the caller's explicit cap (`params.completion.maxTokens`), so the
   contract holds even when the stream producer is injected/replaced (the fake-generator
   seam) or a future producer forgets it. A turn cut by the client's own stop sequence
   keeps `stop` (the Messages route's `_windsurf_stop_sequence` carrier depends on it).

### Why report, not enforce

The only exact token count is the upstream's, and it arrives on the terminal frame after
every delta has been delivered. The proxy has no tokenizer (chars/4 is an estimate), so
cutting the stream at the cap would drop delivered content mid-answer and could label a
complete answer truncated — the failure mode the paid stop-reason calibration comment
already warns about. `length` leaves every delivered delta intact and tells the client its
budget was exceeded. This is the "or" branch the brief allows.

The `max_tokens:16` "thinking leaked into `content`" shape is the documented
reasoning-only rescue (`toChatCompletion` / `streamChatCompletion` promotion), which exists
because strict clients error on an empty answer (#238). It is left in place; the honest
`length` now marks the turn as truncated instead of a clean completion.

## Red first

`test/gemini-think-cap.test.js` drives the real adapters through `__setStreamChatForTest`
with a fake generator that emits N thinking deltas, then a short answer, then a finish event
whose usage reports `completion_tokens = N + 1` under a smaller cap.

Red run before the implementation (missing export proves the test targets new behavior, then
the behavioral assertions fail):

```
$ node --test test/gemini-think-cap.test.js
SyntaxError: The requested module '../src/devin-connect.js' does not provide an export named 'applyOutputCap'
✖ test\gemini-think-cap.test.js
ℹ tests 1 / pass 0 / fail 1
```

## Green

```
$ node --test test/gemini-think-cap.test.js
▶ max_tokens vs thinking (live: gemini-3-6-flash-medium)
  ✔ non-stream: thinking overrun reports length and keeps every delivered token
  ✔ non-stream: the 128-cap / 271-token live shape reports length
  ✔ non-stream: a turn under the cap is still a clean stop (no false truncation)
  ✔ non-stream: landing exactly on the cap stays length (existing contract)
  ✔ non-stream: a stronger terminal state is never overwritten by the cap check
  ✔ stream: every delta is delivered before the terminal length frame (nothing dropped mid-chunk)
  ✔ stream: a turn under the cap still ends with stop
▶ applyOutputCap — the single cap rule shared by the wire and the adapter
  ✔ upgrades a clean stop when completion_tokens reaches or passes the cap
  ✔ never relabels a stronger state
  ✔ does nothing without a usable cap or usage
▶ resolveFinishReason — overrun is no longer invisible to the wire layer
  ✔ reports length when thinking pushes completion past the cap
  ✔ keeps the under-cap and equality behaviour
  ✔ an operator override still wins over the usage inference
  ✔ a stronger enum still wins
ℹ tests 14 / pass 14 / fail 0
```

Related suites (finish/usage/stop/adapter/Gemini translation):

```
$ node --test test/connect-usage-finish-calibration.test.js test/connect-stop-reason-map.test.js \
    test/devin-connect-openai.test.js test/gemini.test.js test/protocol-stop-sequences.test.js
ℹ tests 204 / pass 204 / fail 0 / cancelled 0 / skipped 0
```

Full suite:

```
$ npm test
ℹ tests 6562 / suites 1236 / pass 6465 / fail 0 / cancelled 0 / skipped 97
Wall time: 52.98 seconds
```

`node scripts/spec-static-check.mjs` → `✓ anchors unique, specs well-formed, baselines are
positive integers` (exit 0).
`node scripts/spec-baseline-check.mjs` → `89 spec(s) measured, 0 drift, 0 untrustworthy`
(exit 0).
`node scripts/secret-scan.mjs` → exit 0.
`git diff --check` → exit 0.

## Mutation check (both layers are load-bearing)

1. `applyOutputCap`: `completion >= cap` → `completion === cap` (the pre-fix comparison).
   Result: 5 of 14 tests fail — the overrun cases at 105/64, 271/128, 129/128, the stream
   terminal frame, and the adapter boundary. Equality/under-cap cases stay green, which is
   exactly the old blind spot.
2. Adapter application disabled in both `toChatCompletion` and `streamChatCompletion`
   (`if (false && !stopHit)`): 4 tests fail (all fake-generator overrun cases), while the
   `resolveFinishReason` unit cases stay green — the wire-layer fix alone does not satisfy
   the adapter contract the fake generator pins.

Both mutations were restored and the suite re-ran 14/14 green.

## Files

- `src/devin-connect.js` — `applyOutputCap` + `resolveFinishReason` uses it (`>=`).
- `src/devin-connect-openai.js` — terminal-boundary application in both adapters.
- `test/gemini-think-cap.test.js` — new red-first suite (14 tests).

## Unverified / out of scope

- No live re-probe of `gemini-3-6-flash-medium` (this lane has no account and the wave runs
  HMC scratch only). The overrun numbers are taken from `evidence/ToolMatrixLive.md`.
- Actual enforcement (cutting the stream at the cap) is deliberately not implemented; see
  "Why report, not enforce".
- `completion_tokens_details.reasoning_tokens` remains unemitted on the connect route
  (ToolMatrixLive flag 6) — separate finding, not this lane.

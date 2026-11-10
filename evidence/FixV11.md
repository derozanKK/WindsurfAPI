# FixV11 — over-limit tool-call drop is per-construct and chunk-invariant

Base: `b3877065` (master). Worktree:
`C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w16x-FixV11`
(branch `fix/v11-oversize-drop-state`). Node v24.19.0. No push, no tag.

Audit row: `evidence/audit/VERDICT.md` V-11 (P1) —
"Over-limit parser uses a single boolean drop state, making output chunk-dependent"
(`src/handlers/tool-emulation.js:1850-1930,2040-2050,2180-2200`).

## 1. Defect

`ToolCallStreamParser` abandoned an over-limit construct by setting one boolean,
`_oversizeDropped`, and guessing the terminator from the dialect
(`gpt_native ? '}' : '</tool_call>'`). Consequences, all reproduced before the
fix with `tmp/v11-probe.mjs` (whole-stream vs 3/7/1000/4096/65536/70000-byte and
random splits):

- 11/11 probe cases produced different output for the same bytes.
- The `<tool_call>` open marker leaked at EOF (`flush()` regurgitated it because
  `inToolCall` was still true).
- `<tool_result>` over-limit left `inToolResult` false with no drop state, so the
  matching `</tool_result>` leaked as prose; the body tail leaked at flush
  (up to ~4.4 KB of `Z` in the probe).
- `{"tool_code"}` / `{"name"}` blocks under `openai_json_xml` armed the drop but
  the shared handler only terminated on `</tool_call>`, so the block never ended
  and `flush()` emitted its raw tail (`"}}`, `\"`).
- `gpt_native` terminated on the first `}` even inside a string or a nested
  object, leaking `}}`; the kimi section-end marker leaked.
- The non-openai sentinel path only reached the limit check on a *later* feed, so
  a whole-stream 70 KB construct was parsed at flush while the same bytes fed in
  pieces were replaced by the placeholder.
- The XML/JSON caps measured the whole buffer, so a small valid call followed by
  70 KB of prose was dropped in one split and parsed in another.

## 2. Fix (`src/handlers/tool-emulation.js` only)

- Replaced the boolean with `_oversizeDrop`, a per-construct state:
  - `{ kind: 'tag', close, hold }` — swallow until this construct's literal
    terminator; retain only a possible split-prefix of it (`overLimitHoldTail`);
  - `{ kind: 'json', depth, inStr, escaped }` — swallow until the construct's
    own outermost brace closes (`advanceJsonBraceState`), so `}` inside strings
    or nested objects cannot end it early.
  `_oversizeDropped` remains as a getter over `_oversizeDrop` for existing
  tests/diagnostics.
- `_armOversizeDrop(kind, close, buffered)` resolves the terminator against the
  bytes already consumed; when the terminator is present it returns the bytes
  after it so they continue through the normal path. `_consumeOversizeDrop(delta)`
  does the same incrementally, so the result is a function of the byte stream.
- Cap decisions now measure the construct, not the buffer:
  `_consumeJsonBlock` (balanced-brace extent), `inToolCall` (`closeIdx`),
  `inToolResult` (`closeIdx`), and the non-openai sentinel branch
  (terminator extent). The sentinel branch now emits pre-sentinel text and
  reaches the verdict in the same `feed`, so a whole-stream construct cannot
  escape the cap until `flush()`.
- Each construct arms its own terminator: `<tool_call>` → `</tool_call>`,
  `<tool_result …>` → `</tool_result>`, kimi section → `<|tool_calls_section_end|>`,
  bare JSON → balanced braces. The dead `_oversizeDropped` check inside
  `inToolCall` was removed.
- `flush()` handles EOF explicitly: an over-limit construct that never
  terminated is discarded whole (no placeholder duplicate, no open marker, no
  body, no close-tag leak) and all block flags are reset.
- `test/mutations/s1-p4-prefix-tables.json` mutation 3 anchor follows the
  re-indented prefix-hold loop (semantics unchanged).

## 3. Red-first evidence

`test/tool-emulation-overlimit.test.js` gained a property suite: every case is
run whole and split at 3/97-byte, 997-byte, 4096-byte, 65536-byte, 1+65536,
65536, 65537 and a deterministic random split; aggregated `text` and
`toolCalls` must be identical, and forbidden markup must not appear.

Before the fix (test file with 15 property cases):

```
node --import ./test/setup-env.mjs --test test/tool-emulation-overlimit.test.js
ℹ tests 27
ℹ pass 12
ℹ fail 15      # every property case; the two controls passed
```

Probe before: `11/11 cases chunk-dependent` (`tmp/probe-before.log`).
Probe after: `0/11 cases chunk-dependent` (`tmp/probe-after.log`).

After the fix:

```
node --import ./test/setup-env.mjs --test test/tool-emulation-overlimit.test.js
ℹ tests 31
ℹ pass 31
ℹ fail 0
```

## 4. Controls (legitimate behavior preserved)

- All 10 pre-existing over-limit tests still pass, including B1 (no zombie
  `inToolCall`), B3 (bounded buffer: 0 bytes while dropping), M1 (`{"name"}`
  sentinel) and "small complete call still parses".
- B2 was updated from `"}}` to `}}`: the old tail only terminated the heuristic
  "first `}`" state; the JSON-aware terminator is the construct's own balanced
  braces, which the test name and intent already described.
- A small unclosed `<tool_call>` is still regurgitated at EOF (control test).
- A small valid call followed by 70 KB of prose is parsed for
  `openai_json_xml` bare JSON, `<tool_call>`, `{"tool_code"}` and `glm47`, for
  every split (control tests).
- `test/s1-p4-prefix-tables.test.js` (source-level feed equivalence against the
  frozen baseline across 4 dialects × parse toggles × parse modes and every
  single-cut split) passes unchanged.

## 5. Suite evidence

Targeted (`tool-emulation*`, `s1-p4-prefix-tables`, `swe-streaming-toolcall`,
`tool-args-split-assembly`, `tool-call-from-thinking`, `tool-preamble*`,
`wire-byte-identity`):

```
node --import ./test/setup-env.mjs --test test/tool-emulation*.test.js \
  test/s1-p4-prefix-tables.test.js test/swe-streaming-toolcall.test.js \
  test/tool-args-split-assembly.test.js test/tool-call-from-thinking.test.js \
  test/tool-preamble-*.test.js test/wire-byte-identity.test.js
ℹ tests 281
ℹ pass 280
ℹ fail 0
ℹ skipped 1
```

Full suite (`node scripts/run-tests.mjs`, exit 0, `tmp/full2.log`):

```
TEST_DISCOVERY 574 unique files
ℹ tests 7041
ℹ suites 1323
ℹ pass 6944
ℹ fail 0
ℹ skipped 97
ℹ cancelled 0
ℹ duration_ms 74441.8524
```

`test/docs-consistency-guard.test.js` (mutation anchor + smoke matrix docs
family) passes with the updated `s1-p4-prefix-tables.json` anchor.

## 6. Residual / not changed

- `<tool_result>` over-limit bodies are still dropped silently (no placeholder),
  matching the pre-existing product decision; the close tag no longer leaks and
  the bytes after it are preserved.
- An over-limit construct whose terminator never arrives is discarded at EOF;
  this is the defined behaviour, and it is now identical for every split.
- `_oversizeDropped` remains readable as a getter; no production caller reads it.

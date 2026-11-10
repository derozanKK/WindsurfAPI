# ChatToolGate — refuse hosted / server-executed tool types on `/v1/chat/completions`

**Status:** implementation + tests green in the lane worktree. No push, tag or merge.
**Finding:** `evidence/DataAuditTools/findings.md` F3 — the chat surface accepted
`{type:'web_search'}` / `{type:'code_interpreter'}` / … with a 200 and no tool, while
`/v1/responses` refused the same payload with a 400.
**Baseline:** `0cae51b` (master, v3.10.1 + PR #281 + alias fixes).
**Worktree:** `w106-chattoolgate`, branch `fix/chat-server-side-tool-gate`.

---

## 1. What changed

| File | Change |
|---|---|
| `src/server-side-tools.js` (new) | The v3.10.1 predicates moved out of `responses.js`: `UNBRIDGED_SERVER_SIDE_TYPES`, `isServerSideToolType` (dated-snapshot aware), `isHostedSearchType` (versioned family), `forEachTool` (walks `tools`/`children`/`functions`/`items` namespace children), both Responses error factories, plus `firstUnsupportedServerToolType` and the chat error factory. |
| `src/handlers/responses.js:17-23` | Imports the predicates/factories instead of defining them. No behaviour change: the Responses gates, messages and codes are byte-identical (`serverSideToolUnsupported` / `hostedSearchUnsupported` moved verbatim). |
| `src/handlers/chat.js:25,3155-3195` | Admission gate at the top of `_handleChatCompletionsInner`, before prompt assembly, cache/account work and any upstream call. Refuses the first hosted/server-executed type with `400`, `type=invalid_request_error`, `code=unsupported_server_side_tool`, `param=tools`. Also logs non-function tool types that the lenient path drops (previously silent). |
| `test/chat-hosted-tool-gate.test.js` (new) | 9 tests: 8 server types × {non-stream, stream}; 8 dated snapshots; 4 hosted/versioned types; namespace children under all four keys; mixed function+server tool; `function`/`custom` `apply_patch` controls; unknown-type log. |
| `evidence/ChatToolGate-probe.mjs` (new) | Real `handleChatCompletions`, DEVIN_CONNECT route, stubbed connect deps, env-token-only deploy. Prints status/code/param/upstream-hit count per payload. |

### Admission semantics

- **Shared predicate, one set.** The chat gate calls `firstUnsupportedServerToolType`
  from `src/server-side-tools.js`; the set and the dated-snapshot stripping are the
  same code `/v1/responses` runs, so the two surfaces cannot drift.
- **Both families, one chat code.** On the chat surface a hosted (`web_search*`) or
  server-executed type is refused with `code=unsupported_server_side_tool` (the lane
  brief pins that code for both families). The message still distinguishes them:
  hosted names the `web_search` function-tool workaround, server-executed names the
  rejected 8-type set and the `function` workaround.
- **Only `tool.type` decides.** `{type:'function', function:{name:'apply_patch'}}`
  and `{type:'custom', name:'apply_patch'}` pass admission and keep the historical
  200; the function form still reaches the upstream tool preamble (test asserts it).
- **Unknown junk types keep the old 200**, but are no longer silent: the gate logs
  `dropping unknown tool type <type>`; `custom` (known, but not executed here) logs
  at info. This is the "if silent, add the log" half of the brief — the red probe
  below proves there was no type-naming log line before.
- **Wire builder untouched.** `devin-connect.js:1740` still filters non-function
  ToolDefs as defence in depth; this change only decides admission.
- **`tool_choice` is not re-gated on chat.** The brief scopes the refusal to a
  request *declaring* a tool; chat's `tool_choice` shapes are unchanged.

---

## 2. Red evidence (baseline `0cae51b`, before the change)

Command (run in a clean `0cae51b` worktree with this probe copied in):

```
node --import ./test/setup-env.mjs evidence/ChatToolGate-probe.mjs
```

Full log: `evidence/ChatToolGate-red.log` (46 rows, exit 0).

Summary, from the log: **46/46 rows status 200 or STREAM-200, 46/46 `hits=1`,
46/46 `typeNamedLogs=0`, 46/46 `toolTextUpstream=false`.** The model ran, the tool
never reached the wire, and no log line named the type.

| # | row | status | code | param | hits | type-named log | tool text upstream |
|---|---|---|---|---|---|---|---|
| 1 | tools file_search | 200 | - | - | 1 | 0 | false |
| 2 | tools file_search stream | STREAM-200 | - | - | 1 | 0 | false |
| 3 | tools computer_use_preview | 200 | - | - | 1 | 0 | false |
| 4 | tools computer_use_preview stream | STREAM-200 | - | - | 1 | 0 | false |
| 5 | tools mcp | 200 | - | - | 1 | 0 | false |
| 6 | tools mcp stream | STREAM-200 | - | - | 1 | 0 | false |
| 7 | tools code_interpreter | 200 | - | - | 1 | 0 | false |
| 8 | tools code_interpreter stream | STREAM-200 | - | - | 1 | 0 | false |
| 9 | tools image_generation | 200 | - | - | 1 | 0 | false |
| 10 | tools image_generation stream | STREAM-200 | - | - | 1 | 0 | false |
| 11 | tools local_shell | 200 | - | - | 1 | 0 | false |
| 12 | tools local_shell stream | STREAM-200 | - | - | 1 | 0 | false |
| 13 | tools shell | 200 | - | - | 1 | 0 | false |
| 14 | tools shell stream | STREAM-200 | - | - | 1 | 0 | false |
| 15 | tools apply_patch | 200 | - | - | 1 | 0 | false |
| 16 | tools apply_patch stream | STREAM-200 | - | - | 1 | 0 | false |
| 17 | tools file_search_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 18 | tools file_search_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 19 | tools computer_use_preview_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 20 | tools computer_use_preview_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 21 | tools mcp_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 22 | tools mcp_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 23 | tools code_interpreter_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 24 | tools code_interpreter_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 25 | tools image_generation_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 26 | tools image_generation_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 27 | tools local_shell_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 28 | tools local_shell_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 29 | tools shell_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 30 | tools shell_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 31 | tools apply_patch_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 32 | tools apply_patch_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 33 | tools web_search | 200 | - | - | 1 | 0 | false |
| 34 | tools web_search stream | STREAM-200 | - | - | 1 | 0 | false |
| 35 | tools web_search_preview | 200 | - | - | 1 | 0 | false |
| 36 | tools web_search_preview stream | STREAM-200 | - | - | 1 | 0 | false |
| 37 | tools web_search_preview_2025_03_11 | 200 | - | - | 1 | 0 | false |
| 38 | tools web_search_preview_2025_03_11 stream | STREAM-200 | - | - | 1 | 0 | false |
| 39 | tools web_search_2025_08_26 | 200 | - | - | 1 | 0 | false |
| 40 | tools web_search_2025_08_26 stream | STREAM-200 | - | - | 1 | 0 | false |
| 41 | namespace tools child code_interpreter | 200 | - | - | 1 | 0 | false |
| 42 | namespace children child mcp | 200 | - | - | 1 | 0 | false |
| 43 | function apply_patch (control) | 200 | - | - | 1 | 0 | false |
| 44 | custom apply_patch (control) | 200 | - | - | 1 | 0 | false |
| 45 | unknown banana | 200 | - | - | 1 | 0 | false |
| 46 | unknown banana stream | STREAM-200 | - | - | 1 | 0 | false |

Red test run (same baseline, before the gate):

```
node --import ./test/setup-env.mjs --test test/chat-hosted-tool-gate.test.js
```

`evidence/ChatToolGate-test-red.log`: `tests 9 / pass 2 / fail 7`. The two passing
tests are the `function`/`custom` `apply_patch` controls (unchanged behaviour); the
seven gate/log tests fail, first assertion
`file_search stream=false must be refused before the model call` (actual 200).

---

## 3. Green evidence (after the change)

Probe (same command, same stub):

| # | row | status | code | param | hits | type-named log | tool text upstream |
|---|---|---|---|---|---|---|---|
| 1 | tools file_search | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 2 | tools file_search stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 3 | tools computer_use_preview | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 4 | tools computer_use_preview stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 5 | tools mcp | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 6 | tools mcp stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 7 | tools code_interpreter | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 8 | tools code_interpreter stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 9 | tools image_generation | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 10 | tools image_generation stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 11 | tools local_shell | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 12 | tools local_shell stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 13 | tools shell | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 14 | tools shell stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 15 | tools apply_patch | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 16 | tools apply_patch stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 17 | tools file_search_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 18 | tools file_search_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 19 | tools computer_use_preview_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 20 | tools computer_use_preview_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 21 | tools mcp_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 22 | tools mcp_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 23 | tools code_interpreter_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 24 | tools code_interpreter_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 25 | tools image_generation_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 26 | tools image_generation_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 27 | tools local_shell_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 28 | tools local_shell_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 29 | tools shell_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 30 | tools shell_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 31 | tools apply_patch_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 32 | tools apply_patch_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 33 | tools web_search | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 34 | tools web_search stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 35 | tools web_search_preview | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 36 | tools web_search_preview stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 37 | tools web_search_preview_2025_03_11 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 38 | tools web_search_preview_2025_03_11 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 39 | tools web_search_2025_08_26 | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 40 | tools web_search_2025_08_26 stream | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 41 | namespace tools child code_interpreter | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 42 | namespace children child mcp | 400 | unsupported_server_side_tool | tools | 0 | 1 | false |
| 43 | function apply_patch (control) | 200 | - | - | 1 | 0 | false |
| 44 | custom apply_patch (control) | 200 | - | - | 1 | 1 | false |
| 45 | unknown banana | 200 | - | - | 1 | 1 | false |
| 46 | unknown banana stream | STREAM-200 | - | - | 1 | 1 | false |

Counts from the log: **42/42 gate rows are 400 + `unsupported_server_side_tool` +
`param=tools` + `hits=0`** (20 types × 2 stream modes + 2 namespace rows);
the 4 lenient rows stay 200/STREAM-200 with one upstream call each.

`toolTextUpstream=false` on the control rows is the probe's hard-coded
`code_interpreter` search, not a claim about `apply_patch`; the function control's
forwarding is asserted by the test (`upstream.lastParams.messages` contains
`apply_patch`).

### Test evidence

Acceptance command (the brief's set; globs expanded by the shell):

```
node --import ./test/setup-env.mjs --test test/responses.test.js test/chat*.test.js test/devin-connect*.test.js
```

`evidence/ChatToolGate-test-green.log`: **tests 1131 / pass 1131 / fail 0**,
exit 0 (`duration_ms 25887`).

Additional adjacent suites (same tree):

| Command | Result |
|---|---|
| `node --import ./test/setup-env.mjs --test test/responses*.test.js` | 170 pass / 0 fail |
| `node --import ./test/setup-env.mjs --test test/messages*.test.js test/gemini*.test.js` | 228 pass / 0 fail |

`node --check` on the three source files and the new test: clean.

---

## 4. Reproduce

```bash
# from the lane worktree
node --import ./test/setup-env.mjs --test test/chat-hosted-tool-gate.test.js
node --import ./test/setup-env.mjs evidence/ChatToolGate-probe.mjs
```

The probe uses `test/setup-env.mjs`'s temp `DATA_DIR` and network-deny preload;
`__setConnectDeps` stubs the connect client, so no account, credential or byte
leaves the box. `DEVIN_CONNECT=1` + `DEVIN_CONNECT_TOKEN` is a single-token
deploy (no pool); the gate runs before either is read.

## 5. Limits

- No live upstream call was made (network-deny preload), so this proves admission
  and the absence of a model call, not upstream tool behaviour.
- The hosted-search family on chat returns the lane-mandated
  `unsupported_server_side_tool` code, not the Responses-only
  `unsupported_hosted_tool`; the messages differ so the caller still learns which
  family it hit. If cross-surface code uniformity is preferred later, the code
  lives in one factory (`src/server-side-tools.js:104`).
- `custom` tool execution on the chat surface is still F10 (dropped, now logged);
  this lane only refuses the types that ask the server to execute something.

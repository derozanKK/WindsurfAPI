# ClaudeCompatGaps — Claude Code 2.1.306 (CL1–CL3)

**Lane:** ClaudeCompatGaps · worktree `w111-claudegaps` · branch `fix/claude-2-1-306-gaps`
from `451250a` (v3.10.1) · 2026-10-25
**Source evidence:** `evidence/ClientSandboxes.md` §4 (real Claude Code 2.1.306 against a
scratch DEVIN_CONNECT instance; 11 `/v1/messages?beta=true` exchanges, 0 wire violations) and
its redacted capture `…/evidence/ClientSandboxes/captures/capture-clients.jsonl`
(sha256 `58a0808443852a03107379cb45c4f01181a6938d48095379fd147e12dc2495f4`).
**Product files changed:** `src/handlers/messages.js`, `src/handlers/cc-compat.js` (counters).
**Tests:** `test/cc-claude-2-1-306.test.js` (new), `test/cc-compat.test.js` (stats shape).

## Verdicts

| Gap | Verdict | Where |
|---|---|---|
| **CL1** thinking `signature:""` | **Documented + pinned** — intended #278 behaviour, empty string is what the real client accepts; a real signature cannot be produced (upstream never emits one) | `test/cc-claude-2-1-306.test.js` CL1 block |
| **CL2** `context_management` | **Fixed for the documented subset** (`clear_thinking_20251015`, all valid `keep` values) **+ 400 `unsupported_parameter`** for `clear_tool_uses_20250919` and unknown edit types; malformed shapes → 400 `invalid_request_error` | `messages.js:477-541`, `messages.js:572-575` |
| **CL3** `defer_loading` | **Fixed** for the captured shape (schema-less placeholder dropped = honored) **+ counted/logged** `tool_defer_loading_ignored` for schema-bearing deferred tools (upstream has no tool-loading protocol) | `messages.js:942-978`, `messages.js:998-1008`, `cc-compat.js:50-64,164-175` |

## CL1 — thinking `signature:""` is intended (#278), and `""` is accepted

**Verification that this is the intended #278 behaviour.** Issue #277 (Grok Build aborts the
stream with `missing field 'signature'`) was fixed by PR #278, commit `b60ec3d`
(`fix(messages): always include signature on thinking blocks`). The commit message is explicit:
Grok Build deserializes `ContentBlock::Thinking` with a required `signature: String`, so a
missing key fails the response while `""` parses; the streamed `content_block_start` previously
carried no key at all. An earlier commit (`7d72818`) had made the opposite assumption and
omitted the empty signature — #278 reverted that deliberately. The current code and its comments
(`messages.js:1100-1108`, `messages.js:1358-1364`) encode exactly that contract.

**Verification that the real 2.1.306 client accepts `""`.** Re-derived from the capture (11/11
Claude exchanges, all HTTP 200):

```
$ python - <<'EOF'   # over evidence/ClientSandboxes/captures/capture-clients.jsonl
claude exchanges 11 statuses [200]
thinking starts with exact shape 7   # {"type":"thinking","thinking":"","signature":""}
signature_delta 0
EOF
```

Every one of the 7 thinking starts is byte-identical to
`{"type":"thinking","thinking":"","signature":""}`, no `signature_delta` follows, and the client
replayed the block and stayed 200 on every turn. So `""` is not merely tolerated — it is the
shape the client actually consumed in this run.

The replay is visible in later requests: 6 of the 11 captured request bodies carry assistant
thinking blocks, and every one has `signature:""` (5 distinct blocks across exchanges 38, 39,
40, 46, 48, 49; 129–240 thinking chars each), with the next response 200 each time. A client
that validated the signature would have failed here, not on the next request.

**Why we cannot produce a real signature.** Anthropic's `signature` is opaque encrypted thinking
state that only Anthropic's own servers can mint and verify. Our upstream (Cascade / DEVIN
CONNECT candidate #9) never emits one (`reasoning_signature` is absent in every captured
response). Fabricating a value would be worse than `""`: a client that validates signatures
would reject a forged one, and a client that replays it would send garbage upstream. The
forward-compat path stays: if the upstream ever supplies `delta.reasoning_signature` /
`message.reasoning_signature`, it is forwarded verbatim (pinned by the third CL1 test).

**Test (pins the exact wire shape).** `test/cc-claude-2-1-306.test.js`:
- stream start block key set is exactly `['signature','thinking','type']` with `signature:""`;
- non-stream thinking block deep-equals `{type:'thinking',thinking:'thought',signature:''}`;
- a real upstream `reasoning_signature` still rides `signature_delta` immediately before
  `content_block_stop`.

**Residual (not changed, documented):** `thinking.display` is still read nowhere in `src/`, so
`display:"omitted"` would still stream thinking text. 2.1.306 sends `display:"updates"` on
11/11 requests; honoring `omitted` is a separate outbound-suppression change and was not part
of this ticket's CL1 signature gap.

## CL2 — `context_management` is no longer dropped

**Client shape (11/11 requests, identical):**

```json
"context_management": {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]}
```

**Decision.** 400-ing the observed request would make Claude Code 2.1.306 unusable (it sends
this on every turn — the same failure mode as Codex gap C1), so the observed edit is supported
rather than refused. `anthropicToOpenAI` already drops every incoming assistant thinking block
before forwarding (upstream cannot consume them: no real signature, K2 family ignores the
candidate tag), so `clear_thinking_20251015` is satisfied by the existing translation for any
valid `keep` (`"all"`, `"none"`, `{type:"thinking_turns",value:N}`). A real pruning request
(`keep != "all"`) is logged so the substitution is visible.

`clear_tool_uses_20250919` is **refused** with HTTP 400:

```json
{"type":"error","error":{
  "type":"invalid_request_error",
  "message":"context_management edit type \"clear_tool_uses_20250919\" is not supported by this proxy. Supported: clear_thinking_20251015. Remove the unsupported edit from context_management.edits (or disable context editing in the client) and retry.",
  "param":"context_management.edits[0].type",
  "code":"unsupported_parameter"}}
```

Reason: token-triggered pruning of `tool_use`/`tool_result` pairs is a server-side edit with no
upstream counterpart. Accepting it while forwarding the full history would silently ignore the
context bound the caller relies on — exactly the failure this gap is about. Unknown/future edit
types take the same 400 path (forward-compatible in the "fail loudly" direction). Malformed
shapes (`context_management` not an object, `edits` not an array, missing `type`, bad `keep`)
are 400 `invalid_request_error`.

`context_management` is not forwarded upstream (it is an Anthropic-side directive implemented by
this bridge), and no internal carrier is added.

## CL3 — `defer_loading` is honored where it is meaningful, counted everywhere else

**Client shape (capture id 37, 15 tools, 66,829 request bytes):**

```json
{"name":"DeferredToolPlaceholder",
 "description":"Reserved placeholder that keeps deferred tool loading active; never call this tool.",
 "input_schema":{"type":"object","properties":{}},
 "defer_loading":true}
```

Only this one tool is deferred (204 B compact / 214 B pretty). `ToolSearch` (1,491 B) is an
ordinary callable tool. The 42,268 B tool payload in `ClientSandboxes.md` is the **whole** tool
list, not the deferred subset: honoring this placeholder saves 204 B per request, not 42 KB.
Re-derived from the redacted capture with compact JSON: 42,252 B of 66,006 B (64.0%), placeholder
204 B; the recorded body was 66,829 B before redaction shortened `metadata.user_id`.

**Decision.**

1. A deferred tool with **no declared parameters** (`properties` and `required` both empty) is
   dropped from the forwarded list: there is nothing to load, and the client marks it "never
   call this tool". This is `defer_loading` honored, counted as `toolDeferLoadingHonored`.
2. A deferred tool **with a schema** is forwarded in full and counted as
   `toolDeferLoadingIgnored`, with one structured log line per request:
   `messages: tool_defer_loading_ignored count=N tools=[…] — upstream has no tool-loading
   protocol; schemas forwarded so the tools stay callable`. Rationale: the upstream has no
   tool-loading protocol we can speak. `devin-connect.js:636,699` documents proprietary
   `custom_tool`/`defer_loading` ToolDef tags whose field numbers are uncalibrated; emitting one
   risks a broken frame. Dropping the schema instead would make the tool permanently
   uncallable, because a `ToolSearch` result is text in a tool_result, not a declaration the
   upstream model can invoke. Forwarding keeps the tool working; the counter keeps the fidelity
   deviation visible.
3. `defer_loading` is never forwarded (the OpenAI-shaped tool has no slot for it).

The counters are process-wide and exposed through `getCcCompatStats()` (already surfaced by the
dashboard diagnostics endpoint); the ignored counter is logged under the literal key
`tool_defer_loading_ignored`. A deferred tool that loses the duplicate-name dedupe is not
double-counted as ignored (it is reported by the existing duplicate log).

## Verification

**Red-first (src stashed, new tests only):**

```
$ git stash push -- src/handlers/messages.js src/handlers/cc-compat.js
$ node --import ./test/setup-env.mjs --test test/cc-claude-2-1-306.test.js
✔ CL1 thinking signature wire shape (Claude Code 2.1.306)
✖ CL2 context_management (Claude Code 2.1.306)
✖ CL3 defer_loading (Claude Code 2.1.306)
ℹ tests 12
ℹ pass 6
ℹ fail 6
```

The 6 failures are the 3 CL2 rejection tests and all 3 CL3 tests (CL1 is a pin of existing
intended behaviour, so it is green before and after; CL2's acceptance and no-forwarding tests
are green too, because the field was ignored rather than rejected).

**Green (acceptance glob):**

```
$ node --import ./test/setup-env.mjs --test test/messages*.test.js test/cc*.test.js
ℹ tests 141
ℹ pass 141
ℹ fail 0
```

**Full suite (worktree, same tree):**

```
$ node scripts/run-tests.mjs
ℹ tests 6725
ℹ suites 1267
ℹ pass 6628
ℹ fail 0
ℹ skipped 97
```

Four full-suite runs after the final code state were green (two before the dedupe-count
refactor, two after); one earlier run reported a single failure that did not reproduce and whose
output was not captured, so it stays unattributed. The new test file ran 30/30 green in a loop,
so the flake is not in this lane's tests.

## Not verified / limits

- The capture is a single Windows Claude Code 2.1.306 configuration. A client that sends
  `clear_tool_uses_20250919` (or a future edit type) now receives the 400 above; that path has
  no live-client capture, only unit tests.
- `clear_thinking_20251015 keep:"all"` is accepted while the bridge forwards **no** thinking
  history (stricter than the literal edit). This is pre-existing upstream-driven behaviour, not
  introduced here; it is documented rather than silently claimed as exact.
- A schema-bearing deferred tool is not exercised by the real client in this capture (the only
  deferred tool is the placeholder); its forward+count path is unit-tested, not live-tested.
- Real-signature forward-compat (`reasoning_signature`) is unit-tested only — no upstream
  response in the capture carried one.
- No mutation testing was run (WSL-only in this repo, not required by this ticket).

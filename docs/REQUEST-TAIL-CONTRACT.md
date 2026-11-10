# Request-Tail Contract

**Status:** decided policy — the maintainer's call, settled with PR #274. Both local 400s described
below stay exactly as they are. This file is the written reasoning so the question is not re-litigated;
`test/request-tail-contract.test.js` and `test/mutations/request-tail-contract.json` are the
machine-checkable half.
**Audience:** whoever is about to "fix" a request-tail rejection, or the per-surface difference
between how the surfaces handle one.
**Measured:** 2026-10-07 against `master` @ `df9d429` (worktree `.claude/worktrees/tail-contract`).
The guard and converter line numbers below are re-derivable with the commands in
[§6](#6-where-this-is-pinned); every other line number was hand-checked against the same tree on the
same date.
**Re-measured:** 2026-10-16 against `master` @ `d3f0490` — the §2 stage table carries those
coordinates (the merges in between pushed the chat.js sites by 4–9 lines). The guard block
(`:2994-3033`), the delegation lines and the §3 converter chains were **unchanged**, so their
2026-10-07 coordinates still hold.

## 1. The rule

A request's **tail** decides whether it is forwarded. Both rejections happen locally, in the shared
chat layer, before any backend, account, or cache is touched.

| tail shape | what the product does | why (measured, not stylistic) |
|---|---|---|
| ends on `user` / `tool` / `function` (trailing `system` messages are ignored) | forwarded — the normal shape | the shape the upstream actually answers |
| last non-system turn is **`assistant`** — content-independent, including the Anthropic "prefill" half-sentence | `400 invalid_request_error`, `param: "messages"`, *"The conversation must end with a user message or a tool result."* | `8334cea` moved the check into the shared layer and measured that an assistant-terminated conversation is **not supported upstream**: it comes back `UPSTREAM_INTERNAL`, and "two consecutive of those quarantine the account for 120s" (`src/handlers/chat.js:2971-2973`). Serving these shapes is not a missing feature — it is a way to get the caller's account quarantined. |
| the **newest user turn anywhere** is empty — trims to zero text bytes (`""`, `[]`, whitespace-only text part) | `400 invalid_request_error`, `param: "messages"`, *"The last user message has empty content."* | `79cd990` (fix #28) measured it with the OpenClaw probe, scenario #14: `{role:"user", content:""}` was "answered against the system prompt as if it were the prompt, producing nonsense"; the fix was this 400, "before any upstream call". |

Three properties of the empty-user row — all pinned by tests, because each surprises people:

- It fires on the newest user turn **anywhere in the array**, not only on the tail. An agent loop
  that appends an empty user turn and then a tool result still gets the 400.
- "Empty" means **pure-text** empty. `image_url` / file / audio parts count as content (that scope
  was chosen in `79cd990`); an image-only turn is not rejected by this check.
- The assistant-tail check runs **first**: a conversation violating both reports *"must end with a
  user message…"*.

## 2. Where it is enforced

One block: `src/handlers/chat.js:2994-3033` (assistant-tail check `:2994-3009`, empty-user check
`:3010-3033`), inside `_handleChatCompletionsInner` (`:2890`). It returns **before**:

| stage | first reached at |
|---|---|
| connect-path stream branch (`if (stream)`) | `chat.js:3663` |
| default-path stream branch (`if (stream)`) | `chat.js:4539` |
| backend selection (`selectBackend`) | `chat.js:3226` |
| account acquisition (`acquireConnectAccount` / `waitForAccount`) | `chat.js:3521` / `:4704` |
| response cache (first `cacheGet`) | `chat.js:4587` |

Every surface delegates into this function: `/v1/chat/completions` (`src/server.js:610`),
`/v1/completions` (`src/handlers/completions.js:97`), `/v1/responses`
(`src/handlers/responses.js:1436`), `/v1/messages` (`src/handlers/messages.js:1657`), Gemini
(`src/handlers/gemini.js:768`). No surface can bypass the checks, and a rejected request never
touches a backend, an account, or the cache.

## 3. The per-surface difference — documented, not endorsed

The guard is shared; the input is not. The Anthropic and Gemini converters normalise turns
*before* delegating, and a turn that yields **no text / image / tool part** is dropped on the way
in: the per-turn push chains in `anthropicToOpenAI` (`src/handlers/messages.js:741-753`) and
`geminiToOpenAI` (`src/handlers/gemini.js:235-247`) have no final `else`. The textless variants of
**both rejected shapes** are therefore **served** on `/v1/messages` and Gemini, while
`/v1/chat/completions` and `/v1/responses` reach the guard and get the 400s — the Responses
converter keeps a zero-length content array empty, so predicate B fires there too. (It used to
stringify `[]` into the two-character junk string `"[]"`, which slipped past the guard until the
2026-10-07 review; fixed and pinned in `test/request-tail-contract.test.js`.)

The boundary is by *yield*, not by emptiness, and it is exact: on the Anthropic surface a
`content: ''` string is materialised as an empty-content message and still receives the same 400;
on Gemini `parts: [{text: ''}]` does too. Only a turn producing no parts at all is dropped.

This difference is **documented, not endorsed**. Each side has its own rationale — the converters
are normalisers (a turn with nothing in it carries nothing to forward), the guard is a class
rejection at the shared layer — but neither is derived from the other, and a future unification
needs its own evidence:

- if the converters stop dropping, currently-served shapes start returning 400;
- if the shared layer adopts a converter-style drop, the guard loses its class check and the
  requests it exists to keep away from the upstream reach it again.

Either move reds the tests in §6 — make the argument with a measurement, not by editing a pin.

## 4. What is deliberately NOT promised

Nothing here constrains the tail of `/v1/completions`. `handleCompletions`
(`src/handlers/completions.js:64`) refuses `stream` (`:72`), rejects a blank prompt with its own
400 (`param: "prompt"`, `completions.js:83-88`) and synthesises exactly one non-empty `user` turn
from `prompt` (`completions.js:100`). It cannot produce an assistant tail or an empty newest user
turn, so neither rule above applies. Do not extend this contract there by analogy; that route has
nothing to decide.

## 5. How to change it

The current rule is a **measurement, not a preference**. What would have to exist first:

1. **An upstream that can serve the shape without quarantining the account, measured.** For the
   assistant tail that means the `8334cea` class of probe (live: it returned `UPSTREAM_INTERNAL`
   and account penalties, not an answer). For the empty user turn, evidence that the model answers
   sensibly instead of "against the system prompt as if it were the prompt" (the `79cd990`
   scenario-#14 probe).
2. **The policy call, recorded.** PR #274's consumer evidence is about a client wanting the shape;
   it is not evidence about the upstream, and the maintainer has ruled the choice is his. Bring the
   measurement, not the demand.
3. **Update all pins together** — the guard block, `test/request-tail-contract.test.js`, and
   `test/mutations/request-tail-contract.json` — and say what changed the measurement. A guard
   whose tests must be edited to keep passing is exactly the failure this contract exists to
   prevent.

## 6. Where this is pinned

| what | where |
|---|---|
| the pre-existing tail-assistant 400 on the chat surface | `test/responses-chain-scope.test.js:106-137` |
| empty-user shapes (including the tool-tail case), the streaming refusals, the predicate order, the Anthropic/Gemini drop difference, the with-text boundary, and the Responses surface's empty-array 400 | `test/request-tail-contract.test.js` |
| mutants that must red that file | `test/mutations/request-tail-contract.json` |
| the shared layer forwards orphan `tool` / `function` results instead of sweeping them (PR #274 M1: a re-added `repairUnanswerableMessages`-style pre-pass reds it; the PR's own pins call `normalizeMessagesForCascade` directly and cannot see a pre-pass above it) | `test/chat-orphan-guard.test.js` |

Provenance, 2026-10-07, `master` @ `df9d429`:

- guard and converter line numbers: `grep -n 'ANSWERABLE_ROLES\|trimmedBytes === 0' src/handlers/chat.js`
  and `grep -n 'textParts.length' src/handlers/messages.js src/handlers/gemini.js`
- §2 stage rows (first occurrences): `grep -n 'await acquireConnectAccount(\|selectBackend({ modelInfo })\|await waitForAccountFn(\|const cached = cacheShareable\|if (stream)' src/handlers/chat.js`
  （2026-10-16 @ `d3f0490` 用同一条命令重导过：3663 / 4539 / 3226 / 3521 / 4704 / 4587；
  其余各组坐标在同一天重跑后未变）
- surface delegation lines: `grep -n '|| handleChatCompletions' src/handlers/completions.js src/handlers/responses.js src/handlers/messages.js src/handlers/gemini.js`
  and `grep -n 'handleChatCompletions(body' src/server.js`
- §4 completions numbers: `grep -n 'Streaming is not supported\|promptToText(body.prompt)\|messages: \[{ role' src/handlers/completions.js`
- behaviour and counts: `node --import ./scripts/mutation-network-deny.mjs --import ./test/setup-env.mjs --test --test-force-exit test/request-tail-contract.test.js`
  → 17 pass / 0 fail; `node scripts/spec-baseline-check.mjs request-tail-contract.json` →
  `17 pass + 0 approved skips = 17 [MEASURED_NO_SKIPS]`
- commits: `git log --oneline -1 8334cea` and `git log --oneline -1 79cd990`

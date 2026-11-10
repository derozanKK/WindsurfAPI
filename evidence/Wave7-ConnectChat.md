# Wave 7 — Connect chat P2 fixes (P2-1, P2-2, P2-3, P2-5)

**Branch:** `fix/connect-chat-p2` (worktree `w121-connectp2`), based on `cf27abd`.
**Scope:** the four reproduced findings in `evidence/KimiWaveReview.md` that are not
owned by the support-bundle or auth-truth lanes.
**Status:** all four fixed with red-first tests; targeted suites green; full suite
0 failures.

Commits (author `dwgx`, no AI attribution):

| commit | content |
|---|---|
| `8b34510` | P2-5 — explicit validator code outranks the 401/403 auth shell |
| `871a6ac` | P2-1 — tool-result ordering repaired on the native no-tools path |
| `21b527d` | P2-3 — refuse an image-only last turn after the capability strip |
| `efaa471` | P2-2 — gate images on the serving account's `supports_images` |
| `ff355d8` | mutation specs re-pinned + new mutants |
| `b2b396a` | P2-3 refinement — refuse only a terminal emptied user turn |

---

## P2-1 — #273 repair bypassed when no tools are declared

**Defect.** `src/handlers/chat.js:3869-3872` (pre-fix) chose
`interleaveParallelToolMessages` whenever `emulateTools` was false. The #273 repair
(`orderToolResultsAfterCalls`) ran only inside `normalizeMessagesForCascade` under
`nativeStructured`, which requires declared tools. `nativeToolCall` defaults on and
`connectParams.nativeToolCall` is independent of `tools`, so the builder still emitted
native #6/#7 and a reversed pair reached the wire as `[1,4,2,1]`.

**Fix.** `src/handlers/chat.js:3856-3884`: the no-tools branch now runs
`orderToolResultsAfterCalls(messages)` before `interleaveParallelToolMessages` whenever
`nativeFlag` is on. The tools branch is unchanged (the normalizer already repairs);
the text-emulation branch keeps its bytes.

**Red-first.** New `H4-T8` in `test/wire-h4-tool-pair-order.test.js:222` drives the real
handler with no `tools`, a reversed pair, and asserts both the handler history and the
encoded wire roles.

```
node --import ./test/setup-env.mjs --test test/wire-h4-tool-pair-order.test.js
  ✖ H4-T8: with NO tools declared, a reversed pair still reaches the wire call-first
  AssertionError: the no-tools native history must be repaired before the wire
    [ 'user', 'tool', 'assistant', 'user' ]
```

**Green.** After the fix the same command reports `tests 8, pass 8, fail 0`, and H4-T8
asserts wire roles `[1,2,4,1]` with call id `c1` before result id `c1`.

---

## P2-2 — `supports_images` read from the pool union, not the serving account

**Defect.** `src/handlers/chat.js:3719-3728` (pre-fix) read
`getConnectSelectorImageCapability(selector)`, backed by the first-writer-wins pool
union (`src/auth.js:1406-1421`). With account A `true` and B `false` for one selector,
A's bit governed both: B got an image it declared unsupported, or A's valid image was
stripped — depending only on catalog sync order.

**Fix.**
- `src/auth.js:1419-1453`: new `getConnectSelectorImageCapabilityForAccount(accountId,
  selector)` reads `_connectCatalogRowsByAccount` for the serving account and is
  three-state (`true`/`false`/`null`). Unknown (no synced rows, no row, silent row)
  returns `null` and forwards.
- `src/handlers/chat.js:4038-4110`: the image gate moved after
  `acquireConnectAccount` so it can use `ccAcct.id`. It strips BOTH `messages` (the
  caller-shaped history) and `connectMessages` (the normalized array that rides the
  wire), and logs the account. The env-token fallback has no pooled account and keeps
  the union.

**Red-first.** New `test/connect-image-capability-account.test.js` drives real
per-account catalog syncs (`fetchConnectCatalog` seam → `_connectCatalogRowsByAccount`
→ union) and the real handler with a mocked upstream, pinning the serving account via
the connect sticky slot. Both orders are covered.

```
node --import ./test/setup-env.mjs --test test/connect-image-capability-account.test.js
  ✖ order A(true) then B(false): the union says true, B is still stripped
    AssertionError: B declared supports_images=false; A's union true must not forward an image to B
    actual: 1, expected: 0
  ✖ order B(false) then A(true): the union says false, A is still forwarded
    AssertionError: A declared supports_images=true; B's union false must not strip A's image
    actual: 0, expected: 1
```

The two remaining cases (silent row, no synced rows) failed on the parent only because
the per-account API did not exist yet; they pin the unknown→forward rule on the fixed
tree.

**Green.** `tests 4, pass 4, fail 0`. The tests also assert the union carries the
OPPOSITE bit in each direction, so a regression to the union cannot pass.

---

## P2-3 — stripping an image-only last turn encoded an empty user frame

**Defect.** The pre-dispatch answerability guard runs before stripping and counts a
non-text part as content. `supports_images:false` then stripped an image-only last
user turn to `content: []`, and the handler returned 200; the builder encoded an empty
user frame (consecutive user turns can merge it away, leaving a stale earlier prompt).

**Fix.** `src/handlers/chat.js:4083-4110`: after stripping, the terminal
non-system message of the wire history is re-tested with `hasAnswerableUserContent`
(`chat.js:1425-1441`). If the conversation ends on a user turn that is now empty, the
handler refunds/releases any acquired account and returns a clear
`400 invalid_request_error` with `code:'image_only_turn_unsupported'` naming
`supports_images`. The dropped blocks are still counted in
`images_dropped_capability` and a warn names the refusal.

The check is deliberately terminal-only (`b2b396a`): an earlier image-only user turn
emptied by the strip must NOT turn a tool-result continuation
(`user(image) -> assistant(tool_call) -> tool(result)`) into a 400. That control case
is pinned in the same suite.

**Red-first.** New case in `test/connect-image-capability-gate.test.js:230`:

```
node --import ./test/setup-env.mjs --test test/connect-image-capability-gate.test.js
  ✖ refuses an image-only last turn with a clear 400 instead of an empty user frame
  AssertionError: {"id":"chatcmpl-w4",...}
  200 !== 400
```

**Green.** `tests 10, pass 10, fail 0`; the test also asserts zero upstream hits, the
error type/param, and the counter delta. The tool-result control case asserts 200, one
upstream call, and that the tool result survives.

---

## P2-5 — HTTP 401/403 outranked an explicit validator code

**Defect.** `src/devin-connect.js:2673-2677` (pre-fix) matched `status === 401 || status
=== 403` before the explicit `invalid_argument` / `failed_precondition` arm at `:2701`.
The measured §7.1 trailer (`{"error":{"code":"invalid_argument","message":"an internal
error occurred"}}` in a 401/403 shell) was classified `UNAUTHORIZED`: the account was
charged and a re-login started for a token that was never dead.

**Fix.** `src/devin-connect.js:2670-2716`: the REQUEST_REJECTED arm now runs before the
auth-shell arm. A real auth failure (no code, or `permission_denied` /
`unauthenticated`) still reaches UNAUTHORIZED. The narrower quota/content/capacity text
arms keep their precedence; the 429 arm is unchanged.

**Red-first.** New cases in `test/connect-request-rejection.test.js:206`:

```
node --import ./test/setup-env.mjs --test test/connect-request-rejection.test.js
  ✖ an explicit validator code wins over a 401/403 auth shell
  AssertionError: invalid_argument in a 401 shell is the request validator, not a dead token
  + 'UNAUTHORIZED'
  - 'REQUEST_REJECTED'
```

The control case (no code / auth code → UNAUTHORIZED) passed before and after.

**Green.** `tests 18, pass 18, fail 0`.

---

## Targeted suites

```
node --import ./test/setup-env.mjs --test \
  test/connect-image-capability-gate.test.js \
  test/connect-image-capability-account.test.js \
  test/wire-h4-tool-pair-order.test.js \
  test/connect-request-rejection.test.js \
  test/connect-catalog-delatch.test.js \
  test/connect-sticky-affinity.test.js
ℹ tests 66
ℹ pass 66
ℹ fail 0
ℹ skipped 0
```

## Full suite

```
npm test
TEST_DISCOVERY <all top-level test files>
ℹ tests 6841
ℹ suites 1289
ℹ pass 6744
ℹ fail 0
ℹ cancelled 0
ℹ skipped 97
ℹ todo 0
```

(The first full run on this branch failed only `docs-consistency-guard` because §0
still named `b91ed8e` and our src commits postdated it. §0 now names this branch's tip
with the real master tip recorded alongside; the guard is green.)

## Mutation specs

`scripts/mutate-verify.mjs` still refuses to start on this host (it requires a trusted
POSIX Git absolute path; see the Kimi review note). The three changed specs were
re-pinned by measurement with the structured baseline checker, and every new/changed
mutant was applied in place and measured to fail its suite, then restored with
`git checkout HEAD -- <file>`:

```
node scripts/spec-baseline-check.mjs \
  connect-image-capability-gate.json wire-h4-tool-pair-order.json \
  connect-request-rejection.json
ok connect-image-capability-gate.json: 14 pass + 0 approved skips = 14 [MEASURED_NO_SKIPS]
ok connect-request-rejection.json: 36 pass + 0 approved skips = 36 [MEASURED_NO_SKIPS]
ok wire-h4-tool-pair-order.json: 8 pass + 0 approved skips = 8 [MEASURED_NO_SKIPS]
3 spec(s) measured, 0 drift, 0 untrustworthy
```

New/changed mutants (all anchors verified unique; all caught):

| mutant | defect reintroduced | caught by |
|---|---|---|
| W4-M3 | strip silently, no counter | `connect-image-capability-gate` (counter assertions) |
| W4-M4 | strip without the operator warn | same (warn assertion) |
| W4-M9 | serve the emptied image-only turn | P2-3 400 test (`200 !== 400`) |
| W4-M12 | refuse on ANY emptied user turn (breaks tool-result continuations) | P2-3 tool-result control test (`400 !== 200`) |
| W4-M10 | gate on the pool union | P2-2 both orders + unknown test |
| W4-M11 | per-account lookup falls back to the union | P2-2 unknown/no-rows test |
| H4-M7 | no-tools native branch skips the repair | H4-T8 (`[user,tool,assistant,user]`) |
| RR-M10 | 401/403 shell outranks the explicit code | P2-5 precedence test |
| RR-M11 | bare 401/403 stops being UNAUTHORIZED | P2-5 control test |

The pre-existing mutants in those specs were anchor-checked (exactly one match each);
their anchors did not move except W4-M3/W4-M4, which were re-pinned above.

## Observations (not in scope)

- The response cache key is body+caller and is not account-aware. With per-account
  capability, a cached answer produced with images stripped can be replayed for a
  later request that would have been served by a vision-capable account. This is a
  consistency/cost observation, not a credential or wire-shape defect, and no finding
  in the review covers it. The new tests use distinct callers so the cache cannot hide
  the gate.
- The union lookup remains the `/v1/models` advertisement source and the env-token
  fallback; only the request gate is per-account.

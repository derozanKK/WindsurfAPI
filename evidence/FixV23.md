# FixV23 — trimming must never splice tool-call JSON, and must never drop turns silently

Base `b3877065` (master). Worktree
`C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w16x-fixv23`,
branch `fix/v23-argument-integrity`. Red worktree `…/w16x-fixv23-red`, detached at
`b3877065`, with only the new test file added (removed after the log was captured;
recreate with `git worktree add --detach <path> b3877065` plus a copy of
`test/response-store-argument-integrity.test.js`). Node v24.19.0. No push, no tag.

Branch commits: `6667635c` (source fix + tests + this file) and `18b40e92`
(docs-only §0 backfill; the docs freshness guard requires §0 to name the last
`src/` commit, and a commit cannot name itself — same pattern as `b3877065`).

Audit row: `evidence/audit/VERDICT.md:52` V-23 (A21), P2, accepted. Cited snapshot
lines `src/response-store.js:331-352,440,512-521` correspond to `entryFixedBytes` /
`truncateMessages` / `capEntryBytes` + `trimContentToFit` in this base; the two
behaviours below are what those ranges name.

## Defect

Two independent failures in the same history-trimming path:

1. **Spliced tool arguments.** `trimContentToFit` walked every string that was not
   in `UNSHRINKABLE_KEYS` and cut it with
   `current.slice(0, keep) + TRUNCATION_MARKER`. `tool_calls[i].function.arguments`
   (Chat shape) and `function_call.arguments` (Responses shape) are JSON DOCUMENTS,
   so a valid document became
   `{"path":"/tmp/a","content":"xxxx[... truncated by the response store ...]"`
   — unparseable. The next chained turn replays the stored assistant message
   verbatim, so the upstream received a tool call whose arguments no parser accepts,
   and nothing in the stored history said the payload had been rewritten.
2. **Silent turn drops.** `truncateMessages` (the `RESPONSE_STORE_MAX_MESSAGES`
   limiter) dropped every turn past the cap and returned `[...head, ...tail]` with
   no notice and no log. A model handed that list sees a conversation that begins
   mid-stream and cannot tell earlier turns existed — the silent-wrong-answer mode
   this module exists to remove, one layer up.

Measured before the fix (`evidence/FixV23/red.log`, base + new test file only) at
`RESPONSE_STORE_MAX_BYTES=400k` (`MAX_ENTRY_BYTES = 102400`):

```
200KB JSON arguments  -> stored ~50KB JSON prefix + plain-text marker; JSON.parse threw
501 messages          -> stored 400 messages, zero notices anywhere
```

## Fix — `src/response-store.js`

- `ARGUMENTS_TRUNCATION_JSON` (`:636`) and `looksLikeJsonDocument` (`:645`): a
  JSON-shaped `arguments` string is treated as a DOCUMENT, not prose. The detector
  is a first-non-space-byte test (`{` / `[`), deliberately not `JSON.parse`: the
  string can be megabytes and every trim pass would re-pay the parse.
- `shrinkableSlots` (`:696-699`) tags those slots `json: true` and applies the
  replacement-length floor of the replacement actually used, so a "truncation" can
  never grow the value.
- `trimContentToFit` (`:765-789`) replaces the WHOLE value with
  `{"__truncated__":"[... tool call arguments truncated by the response store to
  stay within RESPONSE_STORE_MAX_BYTES ...]"}`. Valid JSON in, valid JSON out; the
  call keeps `id` and `function.name`, so its tool result still pairs. A non-JSON
  `arguments` payload (never parseable) keeps the cheaper prefix cut. A progress
  check (`:783`) turns any future non-shrinking candidate into a rejected write
  instead of a loop.
- `droppedTurnsNotice` (`:467`) / `prependNotice` (`:481`) centralise the notice
  text and its copy-on-write prepend; `truncateMessages` (`:502-537`) now attaches
  it at the seam and logs a warning. When the seam message is also the LAST message
  (a huge system block leaves one turn of tail budget), the notice goes on the last
  surviving head message instead, so the newest turn stays byte-identical — the
  existing `response-store.test.js` assertions pin that.
- `capEntryBytes` (`:597-614`) reuses the helpers; byte-stage behaviour is
  unchanged.

The notice wording deliberately still matches
`handlers/responses.js:1700`'s strip regex
(`^\[\.\.\. \d+ earlier message\(s\) dropped by the response store[^\]]*\]\n\n`),
so gateway bookkeeping can never be served back as model output — no handler change
was needed. Each limiter reports the turns IT dropped; in the combined case (count
then bytes) the surviving notice is the byte stage's, which is documented in the
function comment rather than silently over-claimed.

The FIX-QUEUE suggested the name
`it('byte trimming never splices function.arguments; the whole call is dropped with
a visible marker')`. The verdict allows "drop/compact the whole item"; this fix
compacts the whole `arguments` value (drop would orphan the paired `tool` result,
because `capEntryBytes` cannot drop the assistant call and its result together).
The invariant — never splice argument JSON, always leave a visible marker, reject
rather than store over-cap — is what the tests pin.

## Red-first tests — `test/response-store-argument-integrity.test.js` (10 tests)

```
V-23 structured tool arguments are never spliced
  ✔ byte trimming replaces the whole arguments value with valid JSON, never a prefix
  ✔ a Responses-shaped function_call item is compacted the same way
  ✔ small valid JSON arguments are stored byte-identical            (control)
  ✔ a non-JSON arguments payload is still prefix-truncated with the marker (control)
V-23 dropped turns carry a visible notice
  ✔ a conversation over RESPONSE_STORE_MAX_MESSAGES records what was dropped
  ✔ never rewrites the newest turn to make room for the notice
  ✔ joins parts-array content as a text block instead of flattening it
  ✔ does not mutate the caller's conversation
  ✔ a conversation at the cap is stored without a notice             (control)
  ✔ when the byte ceiling also binds, the stored conversation still carries a notice
```

Red at base (`evidence/FixV23/red.log`, red worktree at `b3877065` + this test file
only): **5 fail / 5 pass, EXIT=1**

```
✖ byte trimming replaces the whole arguments value with valid JSON, never a prefix
✖ a Responses-shaped function_call item is compacted the same way
✖ a conversation over RESPONSE_STORE_MAX_MESSAGES records what was dropped
✖ never rewrites the newest turn to make room for the notice
✖ joins parts-array content as a text block instead of flattening it
ℹ tests 10  ℹ pass 5  ℹ fail 5
```

Green after the fix (`evidence/FixV23/green-v23.log`): **10/10, EXIT=0**.

## Mutation checks

`npm run mutate` cannot execute on this Windows host:
`scripts/mutation-harness-utils.mjs` throws
`mutation harness requires git at a trusted absolute path` at import time (it only
accepts POSIX git paths). So the new guards were mutation-checked by hand: apply the
mutation, run the new suite, restore, re-verify. Each log is under
`evidence/FixV23/mutation-*.log`; every run ended EXIT=1.

| # | Mutation | Result |
|---|----------|--------|
| M1 | JSON slot cut with `slice + TRUNCATION_MARKER` again (the original defect) | 2 fail / 8 pass — exactly the two JSON-integrity tests |
| M2 | count-trim returns `out` with no notice | 3 fail / 7 pass — the three notice tests |
| M3 | seam always `head.length` (notice rewrites the newest turn) | 1 fail / 9 pass — "never rewrites the newest turn" |
| M4 | `prependNotice` writes through the caller's message object | 1 fail / 9 pass — "does not mutate the caller's conversation" |

After restoring all four: 206/206 targeted tests and 47/47 docs-guard tests green,
`git diff --stat` back to `1 file changed, 129 insertions(+), 23 deletions(-)`.

The new progress check (`:783`) is a belt-and-suspenders guard: the slot floor
already guarantees a shorter replacement, so no mutation of it is observable —
recorded here rather than claimed as covered.

## Targeted suites

```
node --import ./test/setup-env.mjs --test \
  test/response-store-argument-integrity.test.js test/response-store*.test.js \
  test/s4-r6.test.js test/responses-retrieve-contract.test.js \
  test/responses-retrieve-delete.test.js test/responses-chain-scope.test.js \
  test/responses-stale-answer-and-store-refusal.test.js
EXIT=0  ℹ tests 233  ℹ pass 233  ℹ fail 0  ℹ skipped 0
```

Log: `evidence/FixV23/targeted.log`.

## Full suite

```
npm test
TEST_DISCOVERY 575 unique files
EXIT=0  ℹ tests 7030  ℹ pass 6933  ℹ fail 0  ℹ cancelled 0  ℹ skipped 97
```

Log: `evidence/FixV23/full-suite.log` (final HEAD `18b40e92`).

Two blockers were hit on the way there, both recorded rather than smoothed over:

1. The first full run failed only `docs.guard-passes-with-self-tests` because a
   comment I added quoted the mutation-spec anchor
   `current.slice(0, keep) + TRUNCATION_MARKER` a second time, and
   `test/docs-consistency-guard.test.js` requires every spec anchor to appear
   exactly once (`mutation anchors that do not match exactly once`). The comment was
   reworded; no mutation spec changed.
2. The first full run AFTER committing failed only the §0 freshness assertion —
   `§0 master SHA 5d603c3d… predates 1 src/ change(s); update §0 to HEAD` — which is
   structural for any `src/` commit. `18b40e92` backfills §0 to `6667635c`; the
   guard is 47/47 and the suite is green at `18b40e92`.

## Out of scope (observed, not changed)

- No mutation spec was added: the harness cannot run on this host, so an
  `expectBaselinePass` value could not be measured and a guessed one would break the
  Linux harness. Existing specs' anchors are validated by the docs guard (47/47).
- A middle-drop boundary can still keep a `tool` result whose assistant `tool_call`
  was dropped (an orphaned result). That is a pre-existing pairing risk in
  `capEntryBytes`/`truncateMessages`, not the argument-splicing or silent-drop
  defect V-23 names.
- `src/_bundle.cjs` is generated and gitignored (`npm run build:bundle`); it was not
  rebuilt or committed.

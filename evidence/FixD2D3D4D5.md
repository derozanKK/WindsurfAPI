# FixD2D3D4D5 — Connect stream schema validation, fresh-fallback tool history, cache-replay accounting, generator offset

Baseline: `2598299e` (`git rev-parse HEAD` in the lane worktree at start).
Lane branch: `fix/d2-d3-d4-d5`, worktree
`C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261026/w17x-d2d3d4d5`.
Direction rows: `evidence/DIRECTION.md` D2, D3, D4, D5.

Every Node command below uses `test/setup-env.mjs`; bare `node --test` was never run
(it can rewrite the operator `runtime-config.json`).

## Red-first proof (final test files against baseline source)

The four test files were run against the unmodified `2598299e` source
(`git stash push -- src/`, run, `git stash pop`):

```
$ node --import ./test/setup-env.mjs --test test/structured-output-schema.test.js \
    test/cascade-native-history-delta.test.js \
    test/cache-replay-usage-accounting.test.js \
    test/cascade-generator-offset.test.js
ℹ tests 24
ℹ suites 8
ℹ pass 15
ℹ fail 9
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The 9 failures are the new arms; the 15 passes are the pre-existing arms plus the
legitimate-behaviour controls (a conforming Connect stream, a fresh cascade, a
valid-usage offset window, a failed-metadata read). Each failure names the audited
defect:

| Row | Failing arm on baseline | Baseline observation |
|---|---|---|
| D2 | `invalid then valid: the bad turn is a typed failure that is neither cached nor committed` | `expected one typed error frame, got [role chunk, content chunk {"answer":"twelve"}, finish_reason:"stop", …]` — the non-conforming payload reached the client as a completed turn and was cached/committed |
| D3 | `control: an ordinary reuse sends only the newest round` | `actual: [3], expected: [1]` — the client had no way to apply the delta index |
| D3 | `a rejected resume re-sends the full history on the fresh restart` | `actual: 3, expected: 1` for the first send — the send was already fixed at "full", so the fallback could not change |
| D4 | `non-stream: the hit adds no tokens, no credits and no account spend` | `actual: 16, expected: 8` — the cache hit doubled the upstream token ledger |
| D4 | `stream: the replay adds no tokens, no credits and no account spend` | `actual: 16, expected: 8` — same on the stream replay |
| D4 | `charges the credit card only for a turn that ran upstream` | `actual: 8, expected: 4` — a cache-served row charged the credit card again |
| D5 | `the parser keeps the record count when no record carries usage` | `actual: null` — `parseGeneratorMetadata` discarded `entryCount` |
| D5 | `no-usage records still advance the window: the next reuse asks from 2, not 0` | `actual: null, expected: 2` — the turn emitted no offset, which the pool turned into 0 |
| D5 | `the pool keeps an unknown window start unknown instead of record 0` | `actual: 0, expected: null` — `checkin()` coerced the unknown offset |

D3 note on the numbers: the audited baseline measured 3/1/1 field-9 steps because
`chat.js` sliced the list to the delta *before* calling `cascadeChat`. The fix moves
that decision into `cascadeChat` (the only place that knows a resume was rejected), so
the contract the test pins is 3 (fresh) / 1 (ordinary reuse) / 1 then 3 (expired
resume → fresh restart). On the baseline source the client cannot honour either half,
which is what the two red arms show.

## What changed

### D2 — Connect stream schema validation (`src/handlers/chat.js`)

`structuredOutputViolation()` was only reached on the non-stream Connect arm and the
buffered Cascade arm. The Connect **stream** arm passed the adapter's frames straight
through and then committed success, so a `response_format: json_schema` request could
receive non-conforming JSON with `finish_reason: 'stop'`, be cached, and be committed
to session continuity.

- `attemptStream` now buffers the adapter's frames when the request carries a JSON
  Schema (`schemaFrames` / `sink`), for both the first attempt and the re-login replay
  (the replay clears the buffer instead of appending). `emitted` therefore stays false
  until the flush, so pre-flush re-login and account failover remain safe.
- In the `ok` arm, after the existing delivery gate: the client-visible payload
  (`delivered ?? content`) is validated. On a violation the turn closes with one
  `STRUCTURED_OUTPUT_NOT_CONFORMING` error frame, `terminalOk` is forced false (so no
  `[DONE]`), and the code `break`s **before** `bindConnectSticky`, the session commit
  and the cache write. Usage and per-account spend were already recorded inside
  `attemptStream` — the upstream turn really ran, only its answer is unusable (same
  rule as the Cascade arm).
- A turn that delivered tool calls has no JSON payload to judge and keeps its normal
  terminal (parity with the Cascade arm's `wantJson && accText` guard).
- Conforming frames are released in their original order through the same sequential
  writer, so a conforming stream is unchanged.

### D3 — reuse→fresh must carry the full mapped tool history (`src/client.js`, `src/handlers/chat.js`)

`chat.js` pre-sliced `additionalSteps` to `deltaStart` whenever a reuse entry existed.
When the LS rejected the resume and the client restarted fresh, `rebuildFullHistoryText()`
restored the text history but the replacement trajectory still received only the delta,
so the planner reasoned from tool observations it could not see.

- `cascadeChat` now accepts `additionalStepsFrom` and decides per send:
  `effectiveAdditionalSteps()` slices only while `resumedTrajectory` is true.
  `resumedTrajectory` is set when `openCascade()` actually resumes a cascade id and is
  cleared when the expired-resume recovery nulls the reuse entry.
- Both handler call sites (non-stream `:6189-6190`, stream `:8086-8087`) now pass the
  full list plus `deltaStart`.

### D4 — cache-replay usage accounting (V-27) (`src/handlers/chat.js`, `src/dashboard/stats.js`)

Both Connect replay arms called `recordTokenUsage()` with the cached usage and
`recordRequest()` as an ordinary success. No upstream turn ran, yet every hit re-added
the token block and re-charged the model's credit cost.

- `recordRequest(model, success, durationMs, accountId, { cacheServed: true })` skips
  the credit computation and stamps `cacheServed: true` on the row; the request is
  still counted as served traffic.
- The stream replay (`:4519-4526`) and non-stream replay (`:4961-4963`) pass the flag
  and no longer call `recordTokenUsage`. The cached `usage` still rides the client's
  response body/frames — it describes the replayed answer, not a second upstream turn.
  Per-account spend was already untouched on this path and stays that way (asserted).

### D5 — generator offset must not reset to 0 (`src/windsurf.js`, `src/client.js`, `src/conversation-pool.js`)

`parseGeneratorMetadata()` returned `null` as soon as no record carried a usage block,
discarding `entryCount`; the client then emitted `generatorOffset: null`, and
`conversation-pool.checkin()` coerced that to `0`. The next resume asked the metadata
RPC for the whole cascade and billed every earlier turn again (measured `[0,0]` vs the
valid-usage control `[0,1]`).

- `parseGeneratorMetadata()` now returns the record count whenever records exist, with
  `hasUsage` saying whether the token figures are real. `null` remains "no records".
- `client.js` resume snapshot: `?.entryCount || 0` replaced by an explicit
  `Number.isInteger(...)` check plus `generatorOffsetKnown`; an unreadable offset stays
  unknown and the turn abstains (warn log) instead of asking from 0.
- `client.js` end-of-turn: `serverUsage` is only set when `hasUsage` is true (so the
  step-level fallback still runs), while `chunks.generatorOffset` advances by
  `metaResult.entryCount` when the start is known, else `null`.
- `conversation-pool.checkin()` keeps a non-finite `generatorOffset` as `null`
  ("unknown"), which the client's `Number.isInteger` check re-derives on the next
  resume. `stepOffset`'s existing 0 default is unchanged (not part of this row).

## Verification

Targeted suites (cascade + connect + billing stats):

```
$ node --import ./test/setup-env.mjs --test test/cascade-*.test.js test/connect-*.test.js test/billing-stats-*.test.js
ℹ tests 499
ℹ suites 112
ℹ pass 499
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

Per-row proof files (green after the fix):

```
$ node --import ./test/setup-env.mjs --test test/structured-output-schema.test.js
ℹ tests 12  ℹ pass 12  ℹ fail 0

$ node --import ./test/setup-env.mjs --test test/cascade-native-history-delta.test.js
ℹ tests 4   ℹ pass 4   ℹ fail 0

$ node --import ./test/setup-env.mjs --test test/cache-replay-usage-accounting.test.js
ℹ tests 3   ℹ pass 3   ℹ fail 0

$ node --import ./test/setup-env.mjs --test test/cascade-generator-offset.test.js
ℹ tests 5   ℹ pass 5   ℹ fail 0
```

Full suite (`npm test` → `node scripts/run-tests.mjs`, 587 discovered files):

```
$ node scripts/run-tests.mjs
TEST_DISCOVERY 587 unique files
ℹ tests 7126
ℹ suites 1350
ℹ pass 7029
ℹ fail 0
ℹ cancelled 0
ℹ skipped 97
ℹ todo 0
exit=0
```

One harness needed a one-line accommodation: `test/s4-r5.ladder.test.js` extracts the
`attemptStream` source and evaluates it against an injected dependency bag, so the new
`jsonSchema` closure dependency is now passed as `null` there (the ladder pins failover,
i.e. the no-schema arm). Without it the extracted block threw `ReferenceError:
jsonSchema is not defined`; the file is green again (8/8 for `s4-r5*.test.js`).

Project gate (`npm run gate`):

```
$ npm run gate
PASS spec-static-check exit=0
PASS spec-baseline-check exit=0
PASS secret-scan exit=0
PASS test:release exit=0 — 7029 pass / 0 fail / 97 skip (587 files) — 6 inert file(s), 6 declared
PASS git diff --check exit=0
PASS git diff --cached --check exit=0
INCREMENTAL GATE: PASS exit=0
```

The first gate invocation (without `GATE_INERT_SKIP_PATHS`) failed only the inert-file
declaration check, not a test: `detach-ls-pool-pressure` (needs a POSIX shebang fake LS),
`detach-soak` (`DETACH_SOAK=1` opt-in), `devin-connect-relogin-live` (real credentials),
`mutate-verify-harness` + `self-update-untracked-safety` (real-Git fixture at a trusted
POSIX path), `wire-byte-identity` (needs `WIRE_BASE_TREE`). All six self-skip on this
Windows host for reasons that predate and are unrelated to this diff; the rerun declares
them, which is what `GATE_INERT_SKIP_PATHS` exists for. No test failed in either run.

## Boundaries

- No live-upstream, paid-account, Docker, deployment or registry action was performed.
  The Connect arms use the handler's own dependency seam (`__setConnectDeps`) and the
  Cascade arms a fake language server over the real `cascadeChat`.
- D2 validates the payload the *client would see*; the adapter still writes deltas as
  they arrive, so the fix buffers them for schema-constrained requests only. Requests
  without `response_format: json_schema` keep the unbuffered, backpressure-aware path.
- D3 changes the client/handler contract (`additionalStepsFrom`). No other caller of
  `cascadeChat` exists in the tree (checked with grep); a caller that passes
  `additionalSteps` without the new index keeps the old "full list" behaviour.
- D5 does not change `stepOffset`'s null→0 default; that is the polling cursor, not the
  billing window, and is outside this row.

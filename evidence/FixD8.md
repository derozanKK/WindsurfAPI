# FixD8 — drain propagation through the Messages and Gemini translators

Status: **DONE** (targeted + full suite green in this worktree; no live-upstream probe).
Baseline: `2598299e58e291493984de988f7281dccff43e3d` (`git rev-parse HEAD` at worktree creation).
Worktree: `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261026/w17x-FixD8`
Branch: `fix/d8-translator-backpressure`.

## 1. Defect (measured on the baseline)

`chat.js` owns the bounded writer and returns its promise from `send`, so the
Connect adapter (`devin-connect-openai.js`, `await send(...)`) and the Cascade poll
loop (`src/client.js`, `await onChunk(...)` + `holdChunkBoundary()` in `chat.js:7528`)
both stop at a chunk boundary the socket has not accepted. On the translated routes
that writer wraps `createCaptureRes`, and the seam dropped both halves of the signal:

* `AnthropicStreamTranslator.send()` / `GeminiStreamTranslator.writeFrame()` wrote to
  the real `res` and discarded its verdict (`messages.js:1402-1406`,
  `gemini.js:487-497` before this change);
* `createCaptureRes.write()` returned a constant `true` and registered no `drain`
  listener on the real response (`messages.js:2040-2067`, `gemini.js:773-783`).

Measured on the baseline with the tests below: the whole turn was written into a
socket that had already returned `false` — Messages 7 frames instead of 4, Gemini 3
frames instead of 1 (`evidence/FixD8/red-cascade-arms.log`), and the Connect producer
delivered every frame (`evidence/FixD8/red-baseline.log`). Returning the verdict
WITHOUT forwarding `drain` is the invalid half-fix: both drain arms then park until
`WINDSURFAPI_MAX_DRAIN_MS` (120 s) — proven by the mutation log below.

## 2. Fix — two halves, both required

Both translators now own one abort-aware bounded writer over the REAL response
(`src/stream-writer.js`, the repo's single writer implementation), mirroring the
working Responses reference (`responses.js:923-946,1651-1684`):

| Half | messages.js | gemini.js |
|---|---|---|
| bounded writer on the real `res` (+ `egressOk`, timeout log only — teardown stays with chat.js's writer) | `17`, `1401-1417`, `1419-1422` | `28`, `484-500`, `502-505` |
| frame writes return the real verdict (`send` / `writeFrame` / `finish` / `error`) | `1424-1429` | `507-518`, `686-689`, `709-716` |
| `feed()` reports `egressOk` after the chunk | `1993-1999` | `723-729` |
| capture res forwards the real socket's `drain`/`error` | `2028-2035` | `761-768` |
| capture res returns `translator.egressOk` (not `true`) | `2067-2071` | `779-783` |
| disconnect settles the translator wait and refuses further bytes (`writer.dispose()`) | `2084-2091` | `792-797` |

Chain after the fix: producer `await send` → chat writer → `captureRes.write` →
translator feed → translator writer → real `res.write()===false` → translator wait
armed → `captureRes.write` returns `false` → chat writer wait armed → producer parked.
Real socket `drain` → translator wait settles AND the forwarded `drain` settles the
chat wait → producer resumes. The accepted frame is never resent (the writer holds one
outstanding wait and no queue). Close/disconnect fires `captureRes`'s `close`, which
settles the chat wait and aborts the upstream turn; `dispose()` settles the
translator wait and suppresses post-disconnect terminal frames.

Test fixture update: `test/mutations/terminal-event-guard.json:35` — the documented
SURVIVOR anchor moved from `if (this.res.writableEnded) return;` to
`return true;` (same guard, new return value). The docs guard requires every anchor to
match exactly once (`test/docs-consistency-guard.test.js`).

## 3. Tests

### 3.1 Connect producer (`test/connect-stream-backpressure-drain.test.js:362-511`)

Real `streamChatCompletion` adapter (only the upstream transport scripted via
`__setStreamChatForTest`); the scripted generator logs every pull, so "the producer
stopped" is observed directly, not inferred.

* Messages: `write()===false` on the first `content_block_delta` → exactly 4 frames,
  handler still parked, generator stopped before the terminal event, at most one
  waiter; `drain` → `ALPHA`,`BETA` each exactly once, one `message_stop` last.
* Messages close: client vanishes while parked → handler settles within 2 s, zero
  further bytes, producer not driven past the held callback, no `message_stop`.
* Gemini: `write()===false` on the opening array frame → exactly 1 frame, parked;
  `drain` → the body parses as one array, text `ALPHABETA` once, one `STOP` terminal.
* Gemini close: same settle/no-byte assertions.
* Controls (fast reader): whole turn delivered, no `false` verdict, no waiter left.

### 3.2 Cascade producer (`test/stream-backpressure-drain.test.js:615-698`)

Same translator seam driven by a producer that awaits `onChunk` exactly like the
shipped poll loop (that loop's await is pinned by the real-`cascadeChat`-vs-fake-LS
describe above it). Messages/Gemini stop at the refused frame (`chunksProduced===1`,
`completed===0`), resume on `drain` with the delta exactly once and `completed===1`;
close settles with no further bytes.

### 3.3 Red-first (baseline src, tests unchanged)

Raw run logs are local artifacts in this worktree under `evidence/FixD8/*.log`
(`*.log` is gitignored repo-wide); the committed evidence is this report plus the
summary/skip files. Reproduce the red arms with
`git checkout HEAD~1 -- src/handlers/messages.js src/handlers/gemini.js`, run the two
`--test-name-pattern="D8"` commands, then `git checkout HEAD -- src/handlers/…`.
The half-fix mutation is the same tree with the two `realRes.on('drain', …)` lines
deleted.

* `evidence/FixD8/red-baseline.log` — 6 tests: **2 pass (both controls), 4 fail**:
  `production must stop at the false frame, got [...]` (whole turn written), and the
  two close arms (handler/bytes advanced past the parked frame).
* `evidence/FixD8/red-cascade-arms.log` — 3 tests: **0 pass, 3 fail**:
  `the translated stream stops at the false frame, got 7` (Messages) and `got 3`
  (Gemini).

### 3.4 Half-fix mutation (verdict returned, `drain` forward deleted)

`evidence/FixD8/mutation-no-drain-forward.log` — 6 tests: 4 pass, **2 fail**:
`the Messages handler after drain did not settle within 2000ms` and the Gemini twin.
This is the brief's invalid half-fix: the producer parks on a signal no one emits.
Close and control arms still pass, so the two halves are independent and both needed.

## 4. Verification run in this worktree

```
node --import ./test/setup-env.mjs --test test/connect-stream-backpressure-drain.test.js \
  test/stream-backpressure-drain.test.js test/messages.test.js test/gemini.test.js
→ tests 179, pass 179, fail 0  (evidence/FixD8/targeted.log)

node --import ./test/setup-env.mjs --test test/*.test.js
→ tests 7121, suites 1348, pass 7024, fail 0, cancelled 0, skipped 97
  (evidence/FixD8/full-suite.summary.txt)
```

The 97th skip vs the 96 of the same bytes run in the shared tree
(`evidence/FixD8/full-suite-shared-tree.summary.txt`) is the wire-identity test
`the default path emits the same complete request bytes as the last release`, skipped
here only because this worktree has no `WIRE_BASE_TREE` checkout; it is environmental,
not a test this change touches (`evidence/FixD8/skip-main.txt` vs `skip-worktree.txt`).

## 5. Boundaries — not claimed

* No real TCP socket: the slow reader is a controlled writable (EventEmitter) that
  reports `false` once and emits `drain` later, driven through the shipped handlers.
  This is the same fixture contract as the existing SEED-C2 / V-08 arms.
* No live-upstream, no real Claude/Gemini client, no deployment run.
* Half-open timeout behaviour on these two routes still belongs to `chat.js`'s writer
  (typed `DRAIN_TIMEOUT` + upstream abort); the translators only latch and log.
* No performance measurement of the added writer state.
* The repo's mutation harness (`scripts/mutate-verify.mjs`) is POSIX-only — it
  requires git at a hardcoded absolute path (`scripts/mutation-harness-utils.mjs:15-19`)
  and exits 1 on this Windows host. The anchor change is validated by
  `test/docs-consistency-guard.test.js` (47/47) and the full suite; the documented
  SURVIVOR claim for that anchor is **[UNVERIFIED]** on this host.

## 6. Files changed

```
src/handlers/messages.js                         +48 -3   (writer, verdict, drain forward, dispose)
src/handlers/gemini.js                           +55 -12  (same)
test/connect-stream-backpressure-drain.test.js   +236 -2  (Messages/Gemini arms + controls)
test/stream-backpressure-drain.test.js           +96 -0   (Cascade-producer arms)
test/mutations/terminal-event-guard.json         +1 -1    (anchor follows the new return value)
evidence/FixD8.md + evidence/FixD8/*.summary.txt|*.txt  (this report and committed summaries;
                                                          raw *.log runs stay local, gitignored)
```

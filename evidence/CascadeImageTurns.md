# DataAuditContent #1 — Cascade replayed-history images

Branch `fix/cascade-image-turns` (worktree `w108-cascadeimages`), base `451250a`.
Commits: `747a6c0` (fix), `34f8e1a` (mutation spec).

## 1. Wire-capability finding (read from the builders, not guessed)

`buildSendCascadeMessageRequest` — `src/windsurf.js:348`:

| field | shape | what it means for history |
|---|---|---|
| 1 | `cascade_id` (string) | — |
| 2 | `TextOrScopeItem{text=1}` (`src/windsurf.js:354-355`) | the **entire replayed history is ONE string** |
| 3 | metadata | — |
| 5 | cascade_config (`planner_mode` etc.) | DEFAULT(1) enables vision; NO_TOOL(3) suppresses the tool section |
| 6 | **`repeated ImageData{base64_data=1, mime_type=2}`** (`src/windsurf.js:382-391`) | a **flat, message-level list** — no turn index, no per-message slot |
| 9 | `repeated CortexTrajectoryStep` | native-bridge tool steps only; carries no images |

**Conclusion.** The wire has *no per-history-message image field*. An image cannot be
attributed to a turn by the proto — but field 6 is repeated, so **every** image can ride the
same message. Before this change only the newest turn was run through `extractImages`
(`src/client.js:897/910/956` pre-fix), so an image from turn `1..n-1` reached the model as the
literal placeholder `[Image omitted from text history]` (`src/client.js:166`) with **no counter
and no log line anywhere**.

PDFs: a `document` / `file` block never produces a field-6 entry in `extractImages` — it is
converted to text (current turn) or falls back to the placeholder (history). A PDF therefore
cannot be "attached" as an image; its only channel is extracted text, and the history path
counts it as a dropped attachment when its turn is not processed.

## 2. Decision

Carry images for **every replayed turn** (not only the last), bounded, with the text carrying a
numbered marker per attached image so the model can tell them apart — and count + log every
attachment that does not make it. Never silent.

Numbering: the current turn's images keep positions `1..k` exactly as before; history images
follow in chronological order (`k+1..`), and the marker in each replayed turn names the ordinal
of the image it refers to. Field 6 keeps insertion order, so marker `#k` is the k-th image the
model sees.

## 3. Change

| file | what |
|---|---|
| `src/client.js:290-493` | wire-capability comment, `CASCADE_MAX_HISTORY_IMAGES` / `CASCADE_MAX_HISTORY_IMAGE_BYTES`, `buildCascadeHistoryEntries` (old `buildCascadeHistoryLines`, same truncation rule), `renderCascadeHistoryLines`, `reportCascadeImageHistoryDrops`, `buildCascadeMultiTurnPrompt` |
| `src/client.js:1081` | fresh multi-turn path uses the shared builder + vision gate |
| `src/client.js:1133` | post-resume rebuild uses the **same** builder (a rebuilt history carries exactly what a fresh one would) |
| `src/cascade-image-metrics.js` (new) | `cascade_image_history_attached` / `cascade_image_history_dropped`, process-lifetime |
| `src/dashboard/api.js:2166` | `/connect-metrics` → `cascadeImages` (and reset on DELETE) |
| `docs/ENV-SWITCHES.md:249-250` | both switches documented (the docs guard reads this file) |
| `test/cascade-image-history.test.js` (new) | 9 tests against a fake LS that decodes the real proto |
| `test/mutations/client-history-coverage.json` | 4 anchors re-pinned to the new builder |
| `test/mutations/cascade-image-history.json` (new) | 8 mutations over the new path |

Guards are unchanged: history images go through `extractImages` → `pushImage` →
`maybeShrinkImage` and `fetchImageUrl`, i.e. the same SSRF / 5 MB / MIME / decode / re-encode
pipeline as the current turn.

Bounds: `CASCADE_MAX_HISTORY_IMAGES` (default **4**) and `CASCADE_MAX_HISTORY_IMAGE_BYTES`
(default **1.6 MB** = 4 × the 400 KB re-encode target). Newest turn wins; `0` disables history
images explicitly (the pre-fix behaviour, still counted).

Drop reasons in the structured line: `cap`, `bytes`, `truncated` (turn dropped by the history
budget), `no_vision` (NO_TOOL planner mode never renders field 6 — see limitations).

```
cascade_image_history_dropped count=1 (cap=1 bytes=0 truncated=0 no_vision=0) turns=5 attached=1 — SendUserCascadeMessage carries images only as one flat message-level list (field 6), so these could not be replayed with their turn
```

## 4. Evidence

### 4.1 Red first (the test fails on `451250a`)

```
$ git stash push -- src/client.js src/dashboard/api.js
$ node --import ./test/setup-env.mjs --test test/cascade-image-history.test.js
  ✖ carries an image from turn 1 of a 3-turn history instead of a placeholder
  ✖ keeps the current turn image first and numbers the historical one after it
  ✖ bounds history images newest-first and counts what it dropped
  ✖ honours CASCADE_MAX_HISTORY_IMAGES=0 as the explicit opt-out, still counted
  ✖ counts history images dropped because a truncated turn is not replayed at all
  ✖ carries the same history image when a resumed cascade is rebuilt from scratch
  ✖ does not attach history images when the planner runs without vision, and counts them
ℹ tests 7   ℹ pass 0   ℹ fail 7
$ git stash pop
```

The two tests added later for the inner checks are **not** red-first: both pass on `451250a`.
They close the verifier's mutant-survivor finding — removing either inner condition left the
original seven green. Their value is mutation coverage (§4.6), not a pre-fix failure.

### 4.2 Green after the fix

```
$ node --import ./test/setup-env.mjs --test test/cascade-image-history.test.js
ℹ tests 9   ℹ pass 9   ℹ fail 0
```

### 4.3 Acceptance matrix (brief's command)

```
$ node --import ./test/setup-env.mjs --test test/client*.test.js test/cascade*.test.js
ℹ tests 280   ℹ suites 53   ℹ pass 280   ℹ fail 0   ℹ skipped 0
```

### 4.4 Wire tests (unchanged, no documented reason needed)

```
$ node --import ./test/setup-env.mjs --test test/wire*.test.js test/dashboard-api.test.js test/review-history-coverage.test.js
ℹ tests 56   ℹ pass 54   ℹ fail 0   ℹ skipped 2   (both skips are the POSIX-git release-gate fixtures)
```

`test/review-history-coverage.test.js` (the truncation/coverage wire contract) passes unchanged:
`firstIncluded` is computed by the same rule as before.

### 4.5 Full suite

```
$ node scripts/run-tests.mjs
ℹ tests 6720   ℹ pass 6623   ℹ fail 0   ℹ skipped 97      (exit 0)
```

### 4.6 Mutation checks

`scripts/mutate-verify.mjs` requires POSIX git at `/usr/bin/git` and cannot run on the Windows
host; WSL has git but no Node, so these specs were driven by a throwaway independent runner.
The cascade run below applies each anchor in a disposable copy of the worktree, runs the
spec's `tests[]` there, and restores the pristine copy; the Owner checkout is never a mutation
target.

```
client-history-coverage.json   baseline pass=14 fail=0 (spec expects 14)
  OK fail=2 :: GPT-08: the rebuilt history stops updating its coverage …
  OK fail=1 :: Rebuild budget changes and its decoded wire suffix regresses
  OK fail=4 :: GPT-08: the coverage count stops matching the truncation rule it reports
  OK fail=2 :: GPT-08: the rebuilt history is sent newest-first
ALL MUTATIONS BEHAVED

cascade-image-history.json     baseline pass=9 fail=0 (spec expects 9)
  OK fail=5 :: history images are extracted and counted but never reach field 6
  OK fail=6 :: the drop counter stops counting (log only, metric stays zero)
  OK fail=1 :: the image-count cap is ignored
  OK fail=1 :: the per-turn count cap is ignored, so one turn overruns the image budget
  OK fail=1 :: the byte cap inside a turn is ignored, so an oversized history image rides the wire
  OK fail=1 :: the vision gate is ignored …
  OK fail=1 :: images whose turn got truncated are no longer counted as dropped
  OK fail=2 :: marker numbering ignores the current turn …
ALL MUTATIONS BEHAVED
```

### 4.7 Smoke matrix

The first full-suite run failed `docs` (1/2) because the two new switches were undocumented;
after `docs/ENV-SWITCHES.md` was updated:

```
$ node --import ./test/setup-env.mjs --test test/smoke-matrix.test.js
ℹ tests 1   ℹ pass 1   ℹ fail 0      (137/137 flows, 24/24 families)
```

## 5. Limitations and deliberate choices

1. **No per-turn attribution on the wire.** Field 6 is a flat list. The marker text
   (`[Image #3 attached to this request — from an earlier turn]`) is the only attribution
   channel; it names the ordinal, and field 6 order matches it. A model that ignores the
   markers still sees all the images, in order.
2. **NO_TOOL planner mode** (a `toolPreamble` is present and the native bridge is off) does not
   render field 6 (`src/windsurf.js:367`: `forceDefault` is true for vision only when no
   preamble is present). With a `toolPreamble` set, `forceDefault` stays false regardless of
   `images`, so attaching history images there would add bytes the model never sees — it would
   NOT flip planner mode behind the caller's back. They are **not** attached and are counted
   as `no_vision`. Current-turn images keep the pre-existing behaviour in that mode (they were
   already attached there).
3. **PDFs in history** stay text-channel only. A turn that produced no field-6 image keeps its
   plain `contentToString` body, i.e. the placeholder, and the attachment is counted.
4. **Marker bytes are wrapper text**, outside the history budget — the same class as the
   conversation intro, the `<human>` section and the truncation note (bounded by 4 × ~70 B).
5. **One counted build per request.** The fresh path and the rebuild path are mutually
   exclusive: a resume attempt reuses the live trajectory and never calls the history builder,
   and the rebuild runs the builder at most once (`historyRebuilt`). The attached/dropped
   counters therefore count the rebuilt payload once — not both wire attempts. Pinned by the
   rebuild test (`cascade_image_history_attached === 1`).
6. **Remote URL images in history** are fetched again on each request that replays them (same
   as the current turn always did). Extraction stops as soon as the caps are exhausted, so an
   old URL image is never fetched only to be dropped.
7. Only `user` / `assistant` turns are in `convo` at all (`role: 'tool'` messages were already
   excluded before this change); images inside assistant turns are included when present.

STATUS: DONE

# Evidence gate — concurrency and live-model reports

**Target:** release tag-target `0ef5067f19a8a13a39d826bc01bff0c0e991489c`.
**Scope:** the five assigned files only. This audit recomputes report arithmetic and compares claims
with the acceptance plan and retained raw artifacts; it does not rerun paid/live model calls, the
24-second concurrency suite, or the 120-second soak. Historical source commit `c62b5be7` is the
base of both live-model reports and the operational concurrency report, not the tag target.

## Overall verdict

**PASS WITH CORRECTIONS — evidence supports bounded claims, not full R1–R16 acceptance on the
release tree.** The headline live-model coverage and operational concurrency arithmetic largely
recompute. LiveModelsB has a material replay/re-probe overstatement and small denominator/budget
errors. ConcurrencyHermetic reports its Windows skips honestly, but its unexecuted POSIX bodies do
not implement the complete R10/R11 contracts, R15 is missing its detach-composition arm, and its
test commit is not in the tag-target ancestry. TEST-PLAN itself is a coherent specification whose
binary gate remains unmet.

| File | Verdict | Bottom line |
|---|---|---|
| `Concurrency.md` | **SUPPORTED WITH MINOR CORRECTIONS** | 626 = 385 + 220 + 21 recomputes exactly. It is a valid bounded operational matrix, not the hermetic gate. Two narrative claims are inaccurate. |
| `ConcurrencyHermetic.md` | **INCOMPLETE / NOT RELEASE-TREE ACCEPTANCE** | 58 = 56 pass + 2 skip and 42/42 executed iterations agree with the log. The full gate is 14/16 rows and 42/48 iterations at most; R10/R11 remain unrun and their drafted bodies are incomplete; R15 lacks the required detach arm. |
| `TEST-PLAN.md` | **VALID SPECIFICATION; GATE NOT MET** | The 16-row × 3 = 48-iteration algebra and no-skip rule are explicit. It must not be read as results. The later evidence does not satisfy all mandatory requirements. |
| `LiveModelsA.md` | **SUPPORTED WITH MINOR QUALIFICATIONS** | 396 calls, 189×2 matrix coverage, 240-catalog split, all-200 status, and usage identities recompute. The 201 denominator is correctly scoped, not total usage coverage. Nine catalog ids were not probed. |
| `LiveModelsB.md` | **SUBSTANTIVE COVERAGE SUPPORTED; CLAIM CORRECTIONS REQUIRED** | 42×2, 28 non-200 classification counts, image/long-context results and 122 usage identities recompute. Replay/probe narrative is overbroad; stream/budget wording needs correction. |

## 1. `Concurrency.md` — SUPPORTED WITH MINOR CORRECTIONS

### Recomputed support

- The outcome table at `Concurrency.md:103-116` sums independently to **626 requests, 385 done,
  21 typed errors and 220 client aborts**; this matches `:3-7,118-123`. Typed errors are
  5 `DRAIN_TIMEOUT` + 10 `RATE_LIMITED` + 6 `CAPACITY`; aborts are 100 + 100 + 10 + 10.
- Raw run-3 `D:/tmp/wa-conc-run/results-run3.json` exists and its SHA-256 matches the report's
  `9fed9c8c…d1f` entry. It contains 14 scenarios, 385 own-marker-exactly-once completions,
  zero foreign-marker counts and zero unexpected transport counters. The 19-file subset and full
  suite counts are arithmetically consistent (`Concurrency.md:35-37`: 7,175 = 7,078 + 97).
- The report correctly limits itself at `:265-288,335-343`: one fake LS serializes upstream work;
  reconnect means fresh-request/capacity recovery, not same-body detach; queue depth, account
  `_inflight`, real TCP behavior and the R1–R16 gate are not proven. No later hermetic result is
  silently backdated into this historical file.

### Mismatches / corrections

1. **Latency spread is understated.** `Concurrency.md:241-242` says “up to ~28%,” but the table's
   reconnect p95 values are 159.0, 250.1 and 250.1 ms (`:237`), a **36.4%** max-to-min spread.
   All other listed p50/p95 spreads are ≤28%; say “up to ~36%” or exclude reconnect explicitly.
   This does not change the identical outcome counts.
2. **The 626-body marker statement is stronger than the retained artifact proves.**
   `Concurrency.md:149-156` says zero foreign markers “in any of the 626 bodies (including
   aborted bodies),” but raw samples retain no response bodies or marker arrays; they retain only
   aggregate `foreignMarkers` and `ownMarkerExactlyOnce`. The 100 disconnect bodies are empty.
   The supportable statement is **385/385 completed responses checked with their own marker once,
   and the harness's aggregate foreign-marker counter is zero**. The report's final wording at
   `:335-339` is the better formulation.
3. **Non-client 401 traffic is disclosed, not hidden.** `Concurrency.md:269-274` records 61/16/14
   unauthenticated 401 vendor-sync responses. These are outside the 626 client-request accounting
   and are correctly called a harness-isolation gap, not converted into model-call success.

## 2. `ConcurrencyHermetic.md` — INCOMPLETE / NOT RELEASE-TREE ACCEPTANCE

### Recomputed support

- The retained `logs/concurrency-hermetic.log` ends with **58 tests, 56 pass, 0 fail, 2 skipped**;
  the report's decomposition at `ConcurrencyHermetic.md:29` is exact: 14 row parents + 42
  iteration subtests + 2 skipped POSIX tests = 58.
- The report consistently says **42/42 executed row-iterations, R10/R11 = six iterations NOT RUN**
  (`:44-45,67-68,75,151-162`). The companion log confirms **228 = 226 pass + 2 skip**, and the
  soak log confirms **9/9** with a real-TTL wait above 120 seconds. These results do not turn the
  two skips into passes.
- The mutation gate is explicitly **NOT RUN** (`:164-179`), and the draft is explicitly an
  assertion-level suite self-check rather than the production-defect mutations required by
  `TEST-PLAN.md:149`. This is honest reporting, not a 16/16 mutation pass.

### Blocking acceptance mismatches

1. **The evidence is on a side branch, not the tag target.** `ConcurrencyHermetic.md:7` identifies
   commit `5b42c8a3`, based on `12aebfcb`. Local ancestry checks give
   `git merge-base --is-ancestor 5b42c8a3 HEAD` = false, while `12aebfcb` is an ancestor of the
   target. `git ls-tree HEAD` contains neither `test/concurrency-stream-flow.test.js` nor
   `test/mutations/concurrency-stream-flow.json`. Therefore the green log is valid for that side
   branch only; it cannot certify `0ef5067f` unless the suite is integrated and rerun there.
2. **R10's unrun POSIX body does not implement the full plan.** `TEST-PLAN.md:100` requires two
   non-default live streams plus the separate existing default+A three-abort fixture. The drafted
   body at `D:/tmp/wf-concurrency/test/concurrency-stream-flow.test.js:1895-1947` instead occupies
   default+A, uses pin operations rather than two live streams, and has no three-abort companion
   in the same required row. Its green arm also releases A only after the red timeout, rather than
   demonstrating release before the 200 ms deadline in a separate green arm. POSIX execution would
   not by itself establish the specified R10 row.
3. **R11's unrun POSIX body explicitly omits the decisive resume.** The plan at `TEST-PLAN.md:101`
   requires default+A → live B evicts idle A → stop all → restore B, same-body retries, and
   same-generation/generation-change/dead-cascade controls. The body at
   `concurrency-stream-flow.test.js:1950-1985` skips the live-B eviction and same-body retry,
   saying those are covered elsewhere. It also is not nested in the three-iteration harness.
   The evidence's 0/3 is correct, but the file must not be presented as merely needing a host flip
   to complete R11.
4. **R15 lacks the separately required detach-composition arm.** `TEST-PLAN.md:104` requires an
   expired detach resume combined with full native history. The implementation notes at
   `ConcurrencyHermetic.md:91` cover four direct recoveries and one handler recovery; the explicit
   boundary at `:180` admits that no registry-TTL detach variant ran. Calling the parent R15
   “PASS” at `:49,70` therefore means only the implemented subset passed, not the entire R15
   acceptance row.
5. **Consequence for totals:** even accepting the other reported subarms, the full binary gate is
   **not green**. At most 14/16 row parents and 42/48 planned iterations executed, and R15 is only
   partially covered against the written plan. R10/R11 are six `[UNVERIFIED]` iterations and the
   production-defect mutation gate is also `[UNVERIFIED]`.

## 3. `TEST-PLAN.md` — VALID SPECIFICATION; GATE NOT MET

- The file labels itself **PRE-RESULTS SPECIFICATION** at `TEST-PLAN.md:3`; every proposed result
  is `[UNVERIFIED]` until executed. There is no results-to-pass laundering in this file.
- Its acceptance algebra is internally consistent: 16 rows × 3 iterations = **48** (`:67,82`),
  R10/R11 require explicit POSIX execution (`:59,68`), and skipped/todo/cancelled rows cannot be
  counted as passes. The final binary rule at `:190` additionally requires companions, POSIX
  pressure and the opt-in real-TTL soak.
- The required verdict format at `:82` asks for per-row×iteration counters, not merely parent test
  pass/fail. ConcurrencyHermetic supplies a useful per-iteration PASS table and per-row measured
  summaries, but not one full counter record per iteration. This is an evidence-format shortfall,
  separate from the more substantive R10/R11/R15 gaps above.
- The production-defect mutation requirement at `:149` remains unmet. The assertion self-mutation
  draft disclosed by ConcurrencyHermetic is not a substitute.
- **No plan-text arithmetic mismatch found.** The mismatch is between the plan's mandatory gate
  and the later evidence, not inside the plan.

## 4. `LiveModelsA.md` — SUPPORTED WITH MINOR QUALIFICATIONS

### Raw recomputation

- Retained files contain exactly **391 + 4 = 395 rows**, plus the separately described smoke call =
  **396 model calls** (`LiveModelsA.md:19,52-64,431-432,463-464`). Their SHA-256 values match the
  report. All 395 retained rows are HTTP 200.
- The 395 rows decompose as 189 plain + 189 stream + 12 feature + 1 reasoning-stream +
  3 stream-usage + 1 reasoning-effort. The matrix contains **189 distinct models** with both modes.
- Captured `models.json` has 240 rows and recomputes to claude 68 + gpt 104 + gemini 17 = **189**;
  deepseek 8 + glm 12 + grok 8 + kimi 5 + swe 9 = **42**; muse 6 + nemotron 3 = **9 uncovered**.
  Thus `189 + 42 + 9 = 240` at `:83-86` is correct. This is 231/240 catalog ids probed across the
  two briefs, **not every catalog model**.
- All **205 retained usage-bearing 200s** satisfy both identities: 201 in the primary usage
  analysis plus the 3 opt-in stream-usage rows plus `reasoning_effort`. The separately listed
  stream values also pass. The report's “201/201” at `:356-367` is correctly scoped to
  189 plain + 12 non-stream features; it does not claim that only 201 calls carried usage.

### Qualifications / mismatches

1. **No numerical headline mismatch found.** The “0 non-200” claim is bounded to this account,
   window and one attempt per row (`:21-24,449-458`); it is not a global absence claim.
2. **Do not flatten feature coverage into all-model coverage.** The 189-model matrix is plain +
   stream only; tools, image and reasoning are one representative per family (`:450-451`). The
   nine muse/nemotron ids remain explicitly unprobed (`:83-86`).
3. **Usage and reasoning gaps remain visible.** `completion_tokens_details.reasoning_tokens` is
   absent, matrix stream usage is opt-in, and the claude one-character reasoning/content equality
   is only an observation (`:369-410`). None is silently marked verified.

## 5. `LiveModelsB.md` — SUBSTANTIVE COVERAGE SUPPORTED; CORRECTIONS REQUIRED

### Raw recomputation

- Raw artifacts contain **154 calls = 151 measured + 3 smoke**, exactly matching
  `LiveModelsB.md:5-6,52`. The 151 measured calls split into **123 HTTP 200 + 28 non-200**.
  The non-200 counts are 24×400 + 2×503 + 1×429 + 1×403, matching `:19,21-37`.
- The 42-model × plain/stream matrix is complete: **84/84 HTTP 200**. Tools are 20/20 valid,
  pass-2 images are six positive 200/Green responses plus four negative 400s, and 11 successful
  long-context calls contain the needle. The 13 absent-id controls are present exactly once.
- All **122 raw 200 responses carrying usage** pass the two accounting identities. The usage count
  is valid; it is not a count of all 123 successful measured calls.
- The two Grok exact-answer exceptions are disclosed at `:138-141`, so “every model gets plain and
  stream” means HTTP/transport success, not exact marker success on 84/84.

### Mismatches / corrections

1. **“Every non-200 was re-probed” / “all 28 re-probed” is false as written.**
   `LiveModelsB.md:21,69-71` makes that universal claim, but the tables show the 13 absent-id
   controls only once each (`:431-432`); raw artifacts contain 2 in main + 10 in absent2 + 1
   entitlement = 13, not repeat pairs. Only the four positive-model 1-bit image 400s have direct
   pass-2 counterparts; negative controls were repeated across the two fixture passes, and the
   429/two 503s have later successful probes. Correct wording: **all 28 were classified; transient
   and encoding-sensitive rows had follow-up evidence; the 13 admission controls were each probed
   once, not all re-probed.**
2. **Replay uniqueness is understated and its denominator is unexplained.** `:53` says 141/141
   distinct `x-request-id`; raw artifacts show request ids on **151/151 measured responses**, all
   distinct. If 141 is intended to cover only the original process before restart, name that
   denominator; otherwise use 151/151. This is a conservative count, not a false uniqueness claim.
3. **Stream denominators need precise scoping.** Raw artifacts contain **54 successful measured
   streams plus one 400 image stream** (55 measured streams total; one additional smoke stream is
   outside the dataset). Of the 54 successful streams, 53 carry usage and seq 206 intentionally
   does not. Thus the `54/54` shape result at `:15` and `53/54` at `:413-414` are correct only for
   successful measured streams. The independent verifier that includes smoke sees 56 successful
   streams total, 54 with usage, and two intentional no-usage cases (seq 206 and smoke); that does
   not contradict the measured denominator once it is named.
4. **The budget is stale.** `:82` says **144 calls**, but the actual total is 154 and the recorded
   dataset is 151. Replace 144 with 154 total calls (or 151 recorded probes), both still under 400.
5. **Transient wording is too causal.** `:32-37,471-478` correctly labels the two 503s and one 429
   transient with successful follow-ups, but non-reproduction in LiveModelsA cannot by itself prove
   “rather than a code path.” The bounded conclusion is **not reproduced in that sibling window;
   code-path causality remains unproven**. This does not alter their transient classification.
6. **Catalog boundary is correct and must remain visible:** the two lanes cover 231/240 ids; nine
   muse/nemotron ids were not probed (`:479-483`). Production's 270-row catalog is a separate
   snapshot and must not be used as the denominator for this 240-row run.

## Release-use conclusion

- **Live-model evidence:** usable after the LiveModelsB wording corrections. It supports the
  measured 240-catalog split and the named feature probes, not universal model/variant quality,
  every catalog id, all error paths, or the release tree's live behavior.
- **Concurrency operational evidence:** usable with the two narrative corrections. It supports
  client-facing concurrency and bounded cleanup under the documented fake-LS topology.
- **Hermetic acceptance:** **open**. Integrate the suite onto the release tree, complete the actual
  R10/R11 scenarios and R15 detach arm, rerun all 48 iterations plus companions/soak, and run the
  required production-defect mutation gate. Until then report `[UNVERIFIED]`, not PASS.

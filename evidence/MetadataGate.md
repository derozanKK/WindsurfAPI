# MetadataGate — `/v1/responses` metadata echo/persist + incremental gate baseline check

Branch `fix/responses-metadata-and-gate` from `451250a`, worktree
`…/windsurfapi-autonomous-20261022/w109-metadata-gate`.

Status: implementation complete; acceptance commands run and quoted below. The
`npm run gate` run is quoted in "Gate" with its own log at
`evidence/MetadataGate/gate-incremental.log`.

---

## Item 1 — `/v1/responses` metadata (DataAuditTools F4)

### Defect

`responsesToChat` never read `metadata`, and `chatToResponse` / the store had no
slot for it. Measured at `451250a`:

```
$ grep -rn "metadata" src/handlers/responses.js | head
(no output)
$ grep -rn "metadata" src/response-store.js | head
(no output)
```

So a client that tags a request (`metadata: {trace_id, tenant}`) got a 200 with
the tag silently dropped, and a later `GET /v1/responses/{id}` could not report
it either.

### Change

- `src/handlers/responses.js`
  - `normalizeResponseMetadata()` (exported): validates the OpenAI contract —
    flat map, ≤16 pairs, keys ≤64 chars, string values ≤512 chars — and throws a
    `400 invalid_request_error` with `param: 'metadata'` on violation. `null` and
    `{}` mean "no metadata" (so POST and GET agree). Values are never logged.
  - `responsesToChat` carries the validated copy as `__responseMetadata`;
    `handleResponses` strips it before the upstream call (it is not a chat
    parameter) and uses it for the echo and the store commit.
  - `chatToResponse(..., metadata)` and `ResponsesStreamTranslator` echo it on the
    response object — non-stream body and every streamed `response.*` frame —
    only when the caller sent it.
  - `storedResponseBody` echoes `entry.metadata` on retrieval.
- `src/response-store.js`
  - New bounded `metadata` slot: `boundMetadata()` keeps ≤16 own string pairs,
    ≤64-char keys, ≤512-char values, drops anything else (defence in depth — the
    HTTP boundary already rejects), skips `__proto__` (the generic copy-on-read
    walk would rewrite the prototype).
  - `metadataBytes()` is added to the entry's `bytes`, so the slot is charged to
    the tenant byte share and the global budget like every other retained byte.
  - `getResponse()` returns a copy (`copyStoredValue`) or `null`.

### Tests (written first, red before the implementation)

Red run, before the implementation (the store tests reported `metadata` as
`undefined` where the test expects `null`, and the byte test reported
`metadata must be metered: 74 vs 74`; the bounded-slot test threw on
`Object.entries(undefined)`):

```
$ node --import ./test/setup-env.mjs --test test/response-store-metadata.test.js
  + actual - expected
  + undefined
  - null
✖ counts metadata bytes against the store budget
  AssertionError: metadata must be metered: 74 vs 74
✖ bounds the whole slot by bytes, not only by pair count
  TypeError: Cannot convert undefined or null to object
$ node --import ./test/setup-env.mjs --test --test-name-pattern="metadata" test/responses.test.js
ℹ tests 12  ℹ pass 7  ℹ fail 5
  ✖ echoes request metadata on the response object
  ✖ echoes metadata on the streaming response object
  ✖ preserves metadata through previous_response_id and GET /v1/responses/{id}
  ✖ rejects metadata that violates the OpenAI contract with a 400 naming the field
  ✖ accepts the contract maximum and echoes it unchanged
```

Green, acceptance command:

```
$ node --import ./test/setup-env.mjs --test test/responses.test.js test/response-store*.test.js
ℹ tests 207  ℹ suites 41  ℹ pass 207  ℹ fail 0  ℹ skipped 0
```

Coverage: echo (non-stream + streaming), absence stays absent, no leak into the
upstream chat body, persistence across `previous_response_id` **and** the later
`GET`, `{}`/`null` treated as absent, contract-maximum accepted, six contract
violations rejected with `param: 'metadata'`, store round-trip / refresh / copy /
foreign-caller isolation / key-count cap / key-length cap / value-length cap /
non-string drop / byte metering / derived byte bound.

### Mutation pins re-measured (test count moved +8)

```
$ node scripts/spec-baseline-check.mjs response-id-entropy-guard.json responses-post-tool-text-item.json responses-stream-done-sentinel.json usage-unknown-not-zero.json
ok response-id-entropy-guard.json: 68 pass + 0 approved skips = 68 [MEASURED_NO_SKIPS]
ok responses-post-tool-text-item.json: 83 pass + 0 approved skips = 83 [MEASURED_NO_SKIPS]
ok responses-stream-done-sentinel.json: 70 pass + 0 approved skips = 70 [MEASURED_NO_SKIPS]
ok usage-unknown-not-zero.json: 73 pass + 0 approved skips = 73 [MEASURED_NO_SKIPS]
4 spec(s) measured, 0 drift, 0 untrustworthy
```

Pins moved by measurement, not arithmetic: 60→68, 75→83, 62→70, 65→73 — each
exactly +8, the eight `test/responses.test.js` metadata tests added by this
change.

---

## Item 2 — the gate's baseline check measures, scoped and full

### What was wrong at `451250a`

`scripts/spec-baseline-check.mjs` already executed each spec's test list and
compared `pass + approved skips` with `expectBaselinePass`, so the measurement
existed. The remaining defects were scope and wording:

1. **Scope.** `selectSpecs` widened to EVERY spec whenever any `src/`, `scripts/`
   or test-helper file changed — i.e. on nearly every branch. That is the full-set
   cost (~100s) paid on the fast path, and it is still not the selection that sees
   pin drift: a pin drifts when its own covered tests move. The release side had
   no full mode wired at all (`--all` existed; nothing invoked it).
2. **Wording.** Drift printed a bespoke line instead of the sentence the mutation
   harness refuses a run with, so the two readers of the same fact disagreed.

### Change

- `scripts/spec-baseline-check.mjs`
  - Incremental default: measure exactly the specs whose spec JSON or `tests`
    files are in the diff (`git diff base...HEAD`, `HEAD`, untracked). A
    synchronized checkout (no diff) still measures everything.
  - `--all`: every spec — the release scope.
  - Drift now prints the harness sentence:
    `baseline pass=N but spec expects M. Either the suite changed or the spec is stale — both are worth knowing before trusting any verdict below.`
    (the approved-skip breakdown is appended only when this platform skipped
    something).
- `scripts/local-gate.mjs`
  - `gateSteps({release})` (exported): incremental passes no flag, release passes
    `--all`; `parseGateArgs` accepts `--release`/`--all` and fails closed on
    anything else; the summary names the scope (`INCREMENTAL GATE` /
    `RELEASE GATE`).
- `package.json`: `"gate:release": "node scripts/local-gate.mjs --release"`.
- `.github/workflows/release.yml`: a release step
  `node scripts/spec-baseline-check.mjs --all` before `npm run test:release` — a
  tag checkout has no diff to scope by, so the release gate is the full one.

### Tests

`test/local-gate.test.js` (new): step wiring for both scopes, CLI parsing,
release-workflow wiring, `gate:release` wiring, and three subprocess runs of the
REAL gate against a disposable fixture:

- incremental passes no `--all`, release passes `--all` (recorded argv);
- a pin drifted 1→2 makes the gate `FAIL spec-baseline-check exit=1` with
  `baseline pass=1 but spec expects 2. Either the suite changed or the spec is
  stale…`, and **restoring the pin passes again** (not a one-way latch);
- the release scope measures a spec the diff never touched.

```
$ node --import ./test/setup-env.mjs --test test/mutate-verify-harness.test.js test/local-gate*.test.js
ℹ tests 34  ℹ suites 8  ℹ pass 7  ℹ fail 0  ℹ skipped 27
```

The 27 skips are `test/mutate-verify-harness.test.js`'s own declared platform
gate on this host (it needs the POSIX git fixture; it is in the repo's
`GATE_INERT_SKIP_PATHS` declaration for Windows), not a silent pass — `fail 0`.

### Proof against the real repository (not only a fixture)

A real pin was drifted in this worktree and the real change-scoped check was run,
then restored:

```
$ # responses-post-tool-text-item.json 82 -> 83
$ node scripts/spec-baseline-check.mjs
ok response-id-entropy-guard.json: 67 pass + 0 approved skips = 67 [MEASURED_NO_SKIPS]
DRIFT responses-post-tool-text-item.json: baseline pass=82 but spec expects 83. Either the suite changed or the spec is stale — both are worth knowing before trusting any verdict below.
ok responses-stream-done-sentinel.json: 69 pass + 0 approved skips = 69 [MEASURED_NO_SKIPS]
ok usage-unknown-not-zero.json: 72 pass + 0 approved skips = 72 [MEASURED_NO_SKIPS]
4 spec(s) measured, 1 drift, 0 untrustworthy
DRIFTED_EXIT=1
$ git checkout -- test/mutations/responses-post-tool-text-item.json   # restore
$ node scripts/spec-baseline-check.mjs
4 spec(s) measured, 0 drift, 0 untrustworthy      # SCOPED_EXIT=0
```

(The numbers in that block are the pins as they stood at that moment — before the
eighth metadata test was added and re-measured; the final pins are the ones quoted
in Item 1.)

### Suite regression the first full gate run caught (and the repair)

The first full `npm run gate` on this branch reported 4 failures, all in
`test/s4-r6.test.js`:

```
✖ R6 two already-read histories and subsequent reads have independent object graphs
  ReferenceError: metadataBytes is not defined
```

That file does not import the store — it extracts `putResponse` / `getResponse`
by TEXT and evaluates them with an injected dependency object, so a new internal
call is an undefined name until the harness is told about it. The repair injects
the three metadata caps as deps and extracts `boundMetadata` / `metadataBytes`
exactly like the existing `copyStoredValue` case. Re-run:

```
$ node --import ./test/setup-env.mjs --test test/s4-r6.test.js
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

(`test/s4-r6.test.js` is unchanged in COUNT, so `s4-r6.json`'s pin of 4 stands.)

---

## Gate

`npm run gate` on this branch (full log at
`evidence/MetadataGate/gate-incremental.log`; `*.log` is gitignored, so that file
is worktree-local — the summary below is the record):

```
$ GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js;test/detach-soak.test.js;test/detach-ls-pool-pressure.test.js" npm run gate
=== spec-static-check ===
=== spec-baseline-check ===
5 spec(s) measured, 0 drift, 0 untrustworthy
=== secret-scan ===
=== test:release ===
=== git diff --check ===
=== git diff --cached --check ===
=== Local gate summary ===
PASS spec-static-check exit=0
PASS spec-baseline-check exit=0
PASS secret-scan exit=0
PASS test:release exit=0 — 6643 pass / 0 fail / 97 skip (549 files) — 6 inert file(s), 6 declared
PASS git diff --check exit=0
PASS git diff --cached --check exit=0
SKIP mutation EXECUTION — this gate checks spec shape, anchors and baseline values, but does not run the mutants themselves; the Linux full-gate recipe runs the sweep.
INCREMENTAL GATE: PASS exit=0
```

Two things in that output are the change working:

- `spec-baseline-check` measured **5** specs (the four `test/responses.test.js`
  specs plus `s4-r6`, whose test file this branch touched) with **0 drift** —
  change-scoped, not the 91-spec full set the old `src/` widening would have paid
  for on this diff.
- The inert census is a HOST declaration, not a repo default: the first clean
  suite run (`6643 pass / 0 fail / 97 skip`) failed the gate on two undeclared
  files, `test/detach-soak.test.js` (`DETACH_SOAK=1` soak) and
  `test/detach-ls-pool-pressure.test.js` (`ensureLs needs to spawn a POSIX
  shebang fake LS`). Both are deliberate platform/env gates; declaring them is
  the documented mechanism (`GATE_INERT_SKIP_PATHS`, no default by design).

## Residual notes

- The incremental gate is now genuinely scoped, so a pin moved by a change no
  spec's test list names is caught by the release gate (`--all`, wired into
  `release.yml`), not by `npm run gate`. That is the trade the ticket asked for
  and it is written down in both scripts.
- `npm run mutate` (the mutation harness itself) is POSIX-git-only and was not run
  on this Windows host; the pins were measured with the same counting semantics
  the harness uses (`pass` from structured runner events, approved skips only).
- The store's metadata caps are defence in depth: the HTTP boundary rejects a
  violating map with a 400 before it can reach `putResponse`.

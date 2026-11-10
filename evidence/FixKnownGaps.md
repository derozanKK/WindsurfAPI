# FixKnownGaps — known alias / dialect / image-scheme gaps, red-first

Lane: `FixKnownGaps` (production) · worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w103-aliasfix`
Branch: `fix/known-alias-dialect-gaps` · base: `b00b3b9` (master, v3.10.1) · no push, no tag, no merge.

Every gap below was reproduced on `b00b3b9` first (probe or failing test), fixed, then re-measured on
the same probe. The probe is `../probe-alias-dialect.mjs` (read-only: it imports the tree's `src/`
and stubs `http(s).get` in memory; no socket, no DNS, no writes). "before" = `D:/Project/WindsurfAPI`
at `b00b3b9`, "after" = this worktree.

---

## 0. Probe, before → after

| probe | before (`b00b3b9`) | after | gap |
|---|---|---|---|
| `resolveConnectSelector('swe-2-0-medium')`, cold | `{selector:'swe-1-6-slow',mapped:false}` | `{selector:'swe-2-medium',mapped:true}` | 1 |
| `resolveConnectSelector('swe-2-0-high')`, cold | `{selector:'swe-1-6-slow',mapped:false}` | `{selector:'swe-2-high',mapped:true}` | 1 |
| `resolveConnectSelector('swe-2-0-max')`, cold | `{selector:'swe-1-6-slow',mapped:false}` | `{selector:'swe-2-max',mapped:true}` | 1 |
| same three, live catalog (targets present, `swe-1-6-slow` absent) | `{selector:null,mapped:false}` | `mapped:true` on the right tier | 1 |
| `resolveConnectSelector('swe-2-0')` (control, row already existed) | `{selector:'swe-2-medium',mapped:true}` | unchanged | 1 |
| `resolveConnectSelector('gpt5-6-luna')`, cold | `{selector:'swe-1-6-slow',mapped:false}` | `{selector:'gpt-5-6-luna-medium',mapped:true}` | 2 |
| `resolveConnectSelector('gpt5.6-luna')` (control, row already existed) | `{selector:'gpt-5-6-luna-medium',mapped:true}` | unchanged | 2 |
| `pickToolDialect('zhipu/glm-5.1','zhipu')` | `glm47` | `gpt_native` | 3 |
| `pickToolDialect('zhipu/glm-5.1',null)` | `openai_json_xml` | `gpt_native` | 3 |
| `pickToolDialect('moonshot/kimi-k2',null)` | `openai_json_xml` | `kimi_k2` | 3 |
| `pickToolDialect('anthropic/claude-sonnet-4.6',null)` | `openai_json_xml` | unchanged | 3 (no Claude family rule) |
| `pickToolDialect('openai/gpt-5-4-medium',null)` | `openai_json_xml` | `gpt_native` | 3 (matches bare `gpt-5-4-medium`) |
| `pickToolDialect('x/y/glm-5.1',null)` | `openai_json_xml` | unchanged (one strip only) | 3 |
| `pickToolDialect('foo/bar/baz',null)` | `openai_json_xml` | unchanged | 3 |
| `extractImages([{type:'image_url',url:'HTTPS://…'}])` | `dialed:0, images:0` (silent skip) | `dialed:1` (fetch) | 4 |
| `extractImages([{type:'image_url',url:'HTTP://…'}])` | `dialed:0`, **no warning** (silent skip) | `dialed:0` + `Image URL rejected: plaintext http (img.example.test)` | 4 |

Raw probe output is quoted per gap below.

---

## 1. `swe-2-0-medium` / `-high` / `-max` — FIXED

**Defect.** `SELECTOR_MAP` carried `swe-2-0` (→ `swe-2-medium`) and the dotted
`swe-2.0-{medium,high,max}`, but not the dashed effort spellings. Measured on base: cold start
degrades to the free selector; a live catalog with the real `swe-2-*` rows and no `swe-1-6-slow`
returns `{selector:null,mapped:false}` → handler answers `model_not_found` for a model the account
can call.

```
resolveConnectSelector(swe-2-0-medium)   {"selector":"swe-1-6-slow","mapped":false}
live resolveConnectSelector(swe-2-0-high){"selector":null,"mapped":false}
```

**Change.** `src/devin-connect-models.js:149-151` — three rows onto `swe-2-medium` / `swe-2-high` /
`swe-2-max`. Targets verified present in `src/data/devin-catalog-snapshot.json` before writing
(`swe-2-medium PRESENT / swe-2-high PRESENT / swe-2-max PRESENT`, 233-model snapshot); the
unsuffixed `swe-2-0` target was already the same. No target was absent, so nothing was left out.

**Red-first.** `9034d50` (test only):

```
ℹ tests 27   ℹ pass 26   ℹ fail 1
AssertionError [ERR_ASSERTION]: swe-2-0-medium
  actual:   { mapped: false, selector: 'swe-1-6-slow' }
  expected: { mapped: true,  selector: 'swe-2-medium' }
```

**Fix.** `81753eb` → same command `ℹ tests 27 ℹ pass 27 ℹ fail 0`.

---

## 2. `gpt5-6-luna` (compact prefix, no dash after `gpt`) — FIXED

**Defect.** Three Luna spellings were mapped (`gpt-5.6-luna`, `gpt-5-6-luna`, `gpt5.6-luna`); the
fourth — compact prefix *and* dashed minor — missed every lookup.

```
resolveConnectSelector(gpt5-6-luna)        {"selector":"swe-1-6-slow","mapped":false}
live resolveConnectSelector(gpt5-6-luna)   {"selector":null,"mapped":false}
```

**Target check.** `gpt-5-6-luna-medium` is `PRESENT` in the snapshot; the bare `gpt-5-6-luna` and
`gpt-5.6-luna` are not selectors (they are family aliases), so the alias points at the `-medium`
tier, exactly like its three siblings. The brief's "check whether `gpt-5-6-luna` / `gpt-5.6-luna`
exist as selectors" answer: **they do not exist as selectors; they exist as aliases already in the
map**, and the real target `gpt-5-6-luna-medium` does exist — so the alias was added.

**Map invariant (whole table, after the change).** Every one of the 121 `SELECTOR_MAP` rows resolves
to a selector that is either in the 233-model snapshot or catalog-independent:

```
map rows: 121  snapshot: 233
aliases whose target is absent from the snapshot: 0
```

**Change.** `src/devin-connect-models.js:163`.

**Red-first.** `9eea1d6`:

```
ℹ tests 28   ℹ pass 27   ℹ fail 1
AssertionError [ERR_ASSERTION]: gpt5-6-luna
  actual:   { selector: 'swe-1-6-slow', mapped: false }
  expected: { selector: 'gpt-5-6-luna-medium', mapped: true }
```

**Fix.** `d18fe0c` → `ℹ tests 28 ℹ pass 28 ℹ fail 0`.

---

## 3. Provider-prefixed dialect — FIXED

**Defect.** `resolveConnectSelector` strips one leading `provider/`
(`src/devin-connect-models.js:492` `.replace(/^[a-z]+\//, '')`), so `zhipu/glm-5.1` routes to
`glm-5-2`; `pickToolDialect` matched the RAW name, so the same request was taught `glm47` markup —
the markup the v2.0.72 probe proved GLM 5.x ignores. The consequence is the silent one: plain-text
answer, no tool call, client waits.

**Reachability (matters for severity).** On the DEVIN_CONNECT path the prompt preamble is built from
`reqModelName` (raw) — `src/handlers/chat.js:3716` and `:3736` — while the response parser is
constructed from `params.model`, which is the RESOLVED selector (`src/handlers/chat.js:3888`,
`src/devin-connect-openai.js:661`, `:884`). So a prefixed name produced a **prompt/parser
dialect mismatch**, not just a suboptimal prompt. After this fix both sides agree:

```
pickToolDialect('zhipu/glm-5.1', …) = gpt_native      # prompt, raw name
pickToolDialect('glm-5-2', …)       = gpt_native      # parser, resolved selector
```

**Change.** `src/handlers/tool-emulation.js:364` — strip `^[a-z][a-z0-9_-]*/` once, after lowercasing,
before every family check. Provider-argument precedence is untouched (the `normalizedProvider`
tests still come first and still win).

**Red-first.** `b0d013d`:

```
ℹ tests 20   ℹ pass 19   ℹ fail 1
AssertionError [ERR_ASSERTION]: prefixed GLM with the provider argument still gets the GLM family dialect
  actual: 'glm47'   expected: 'gpt_native'
```

**Fix.** `c322c9f` → `ℹ tests 109 ℹ pass 109 ℹ fail 0` over the three tool-emulation suites
(`tool-emulation-gpt-native`, `tool-emulation`, `swe-streaming-toolcall`).

---

## 4. Uppercase `HTTP://` in `extractImages` — FIXED

**Defect.** `url.startsWith('https://') || url.startsWith('http://')` on the `image_url` branch.
Schemes are case-insensitive (RFC 3986 §3.1) and `new URL()` normalizes them anyway, so the only
effect of the case-sensitive test was to SKIP the block: no fetch, no warning, no trace.

```
before: extractImages(image_url HTTPS://…) {"dialed":0,"result":"images=0"}
        extractImages(image_url HTTP://…)  {"dialed":0,"result":"images=0"}   (no warn line)
after:  extractImages(image_url HTTPS://…) {"dialed":1,"result":"still-pending"}   # fetch started
        extractImages(image_url HTTP://…)  {"dialed":0,"result":"images=0"}
          [WARN] Image URL rejected: plaintext http (img.example.test) — set WINDSURFAPI_ALLOW_HTTP_IMAGES=1 to allow it
          [WARN] Image fetch failed: Image URL must use https (plaintext http is rejected; …)
```

**Change.** `src/image.js:753` — `/^https?:\/\//i`. The plaintext gate is unchanged
(`validateImageUrl`, `src/image.js:505`): uppercase HTTP is now *rejected* by the https-only rule
instead of being skipped, which is the semantics the gate is supposed to have.

**Red-first.** `6de1a02`:

```
ℹ tests 11   ℹ pass 9   ℹ fail 2
✖ fetches an uppercase-scheme HTTPS image_url instead of skipping the block
  AssertionError: the scheme test must be case-insensitive   actual: 0  expected: 1
✖ rejects an uppercase-scheme HTTP image_url through the plaintext gate
  AssertionError: uppercase HTTP must hit the https-only rejection, not be silently skipped
  actual: ''  expected: /plaintext http/i
```

**Fix.** `190d3d0` → `ℹ tests 42 ℹ pass 42 ℹ fail 0` over the four image/remote-image suites.

**Note on the brief's "two call sites".** There is exactly ONE scheme test in `extractImages` at
`b00b3b9`; repo-wide there is only one `startsWith('https://')` in `src/`:

```
$ grep -rn "startsWith('https://')|startsWith(\"https://\")|startsWith('http://')" --include=*.js .
.\src\image.js:753:        } else if (url.startsWith('https://') || url.startsWith('http://')) {
```

The second URL shape in `extractImages` — `{type:'image', source:{type:'url'}}` — has no scheme
gate at all (it calls `fetchImageUrl` directly), so uppercase works there both before and after.
Both shapes and both cases are covered by the new tests; the `image` shape is the control that the
fix does not double-gate.

---

## 5. Mutation coverage — FIXED

**Defect.** `test/mutations/remote-image-inline.json` ran only `test/connect-remote-images.test.js`
(baseline 17), so the https-only plaintext gate and the `extractImages` scheme handling that this
fetch path depends on could regress without failing the mutation run.

**Change.** `test/mutations/remote-image-inline.json:2-6` — added `test/image-http-gate.test.js`,
`expectBaselinePass` 17 → **28** (17 + 11), measured by running the suite:

```
$ node --import ./test/setup-env.mjs --test test/connect-remote-images.test.js test/image-http-gate.test.js
ℹ tests 28   ℹ pass 28   ℹ fail 0   ℹ skipped 0   ℹ todo 0
```

**Run (WSL, `Ubuntu-24.04`, node v24.21.0 at `/opt/node24/bin/node`), commit `a5e628c`, clean tree:**

```
baseline: test/connect-remote-images.test.js test/image-http-gate.test.js
baseline 28 pass / 0 fail

  CAUGHT 4  a failed fetch is treated as 'nothing changed' …  (pass=24 fail=4)
  CAUGHT 1  the result-side content-type check is dropped …    (pass=27 fail=1)
  CAUGHT 1  streamChat stops resolving remote images …         (pass=27 fail=1)
all 3 mutation(s) behaved as expected; tree clean
EXIT=0
```

**Why a bundle instead of the worktree path.** Windows git writes `gitdir: D:/Project/…` into the
worktree's `.git` file; under WSL that resolves relative to the cwd, so `git` reports
`fatal: not a git repository: …/D:/Project/WindsurfAPI/.git/worktrees/w103-aliasfix` and the harness
refuses (dirty-tree preflight crashes). The harness already materializes its own disposable clone,
so the branch was exported with `git bundle create … HEAD` and cloned inside WSL; HEAD there is
`a5e628c`, identical to this worktree, and `git status --porcelain` was empty before the run.

---

## 6. Acceptance suite

```
$ node --import ./test/setup-env.mjs --test test/devin-connect-models.test.js \
    test/tool-emulation-gpt-native.test.js test/image-img1-base64.test.js \
    test/image-img2-bound.test.js test/image-http-gate.test.js test/connect-remote-images.test.js
ℹ tests 90   ℹ suites 15   ℹ pass 90   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
```

Every run used the single-file form (`node --import ./test/setup-env.mjs --test <files>`), never a
bare `node --test`.

## 7. Commits (base `b00b3b9`)

| commit | what |
|---|---|
| `9034d50` | test: dashed swe-2.0 effort spellings (red) |
| `81753eb` | fix: `swe-2-0-{medium,high,max}` → their swe-2 tiers |
| `9eea1d6` | test: compact `gpt5-6-luna` (red) |
| `d18fe0c` | fix: compact `gpt5-6-luna` |
| `b0d013d` | test: provider-prefixed dialect (red) |
| `c322c9f` | fix: strip one provider prefix in `pickToolDialect` |
| `6de1a02` | test: uppercase scheme in `extractImages` (red) |
| `190d3d0` | fix: `/^https?:\/\//i` in `extractImages` |
| `a5e628c` | test(mutations): cover the image http gate, baseline 17 → 28 |

The four red commits are intentionally non-green commits in the branch history (that is the
red-first evidence); each is immediately followed by its fix.

## 8. Non-goals honoured

- `glm-5-10` boundary untouched (`src/handlers/tool-emulation.js:389`
  `/^glm-5-(?:1|[2-9])(?:-|$)/` unchanged; `glm-5-12` / `glm-5-1x` still `glm47`, pinned by the
  existing test). Known limitation, not a regression: a hypothetical `glm-5-10` minor stays on
  `glm47`.
- `src/dashboard/model-access.js` untouched.
- No push, no tag, no merge.

## 9. Residuals found, NOT fixed here (wave-2 candidates)

1. **`resolveConnectSelector` strips a narrower provider class than `pickToolDialect` now does.**
   Resolver: `/^[a-z]+\//` (`src/devin-connect-models.js:492`); dialect: `/^[a-z][a-z0-9_-]*\//`.
   A hyphenated provider id (`z-ai/glm-5.1`, OpenRouter style) is therefore stripped by the dialect
   but not by the resolver → the name still degrades, now with a `gpt_native` prompt. Same function
   family, different file, outside this brief's named scope. P2.
2. **`data:` scheme test in `extractImages` is still case-sensitive** (`src/image.js:734`,
   `url.startsWith('data:')`). `DATA:image/png;base64,…` is silently skipped, the same defect class
   as gap 4, two lines above it. Not named in the brief; left alone deliberately. P3 (clients emit
   lowercase data URLs).
3. **Compact `gpt5*` spellings get an `openai_json_xml` prompt while their resolved selector gets
   `gpt_native`** (prompt from the raw name at `chat.js:3716`, parser from `selector` at
   `chat.js:3888`). Pre-existing for `gpt5.6-luna` since #244, now also for `gpt5-6-luna`. Measured
   impact is low, not a silent loss: the `gpt_native` parser salvages the JSON body the XML wrapper
   teaches —

   ```
   parseToolCallsFromText('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
     {modelKey:'gpt-5-6-luna-medium', route:'devin_connect'}) → toolCalls ["bash"]
   ```

   Left as-is (P3) rather than widening the GPT family regex in the same commit as the alias fix.

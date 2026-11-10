# Alias resolver systemic fix — S2 / S3 / S4 / S5 / S7 + P2-1 / P2-2

- worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w105-aliasresolver`
- branch `fix/alias-resolver-systemic`, base `0cae51b` (master: v3.10.1 + PR #281 + alias fixes)
- source: `evidence/DataAliasMatrix/alias-matrix.md` §S2–§S7 + verifier P2-1 / P2-2 / P3-d
- files: `src/devin-connect-models.js`, `src/handlers/tool-emulation.js`,
  `test/devin-connect-models.test.js`, `test/tool-emulation-gpt-native.test.js`,
  `test/mutations/alias-resolver-systemic.json`, `test/mutations/connect-catalog-hotfix.json` (baseline)
- raw logs (outside the repo): `evidence/AliasResolverFix-logs/`
- not pushed, not tagged, not merged.

## Verdict

| item | defect | fix | verdict |
|---|---|---|---|
| **S3** | provider strip `/^[a-z]+\//` cannot match `x-ai/`, `z-ai/` → every hyphenated-prefixed spelling failed every lookup | widen to `/^[a-z0-9][a-z0-9-]*\//`, still one segment | **fixed, mutation-caught** |
| **S4** | compact `gpt5.x` / `gemini3.x` spellings have no map rows → resolve to nothing | split the compact version at its separator before the map lookup; no rows added | **fixed, mutation-caught (incl. over-reach)** |
| **S5** | enum test ran on the RAW name → lowercase / prefixed `MODEL_*` matched neither path | test the enum shape on the normalized key, look the UPPERCASE form up, keep the catalog existence gate | **fixed, mutation-caught (incl. gate removal)** |
| **S2** | family regexes tested the literal spelling → dotted and compact names missed their family | collapse dots + split the compact version once at the top of `pickToolDialect`, every family rule tests that key | **fixed, mutation-caught** |
| **S7** | `swe-1-5` → `MODEL_SWE_1_5_SLOW` but the alias got `kimi_k2` and its own target `openai_json_xml` | read the two SWE-1.5 enums into the family spelling | **fixed, mutation-caught — direction is an inference, see below** |
| **P2-2** | the dialect prefix strip was wider than the resolver's (accepted `_`) → a dialect for a name the resolver degrades | use exactly the resolver's rule | **fixed, mutation-caught** |
| **P2-1** | comment claimed the prefix never changes the upstream model | corrected; the asymmetry is pinned by a test | **documented, not changed** |
| residue | bare `grok-4-5` / `inkling` 400 while siblings work | add the two bare aliases (`-medium` targets exist in the snapshot) | **fixed, mutation-caught** |

## Probe: before → after

Before = base `0cae51b` (`node --input-type=module` probe, `warnOnFallback:false`); after = branch HEAD.

| class | spelling | before | after |
|---|---|---|---|
| S3 | `x-ai/grok-4-5-low` | `{swe-1-6-slow, mapped:false}` | `{grok-4-5-low, mapped:true}` |
| S3 | `z-ai/glm-5.1` | `{swe-1-6-slow, mapped:false}` | `{glm-5-2, mapped:true}` |
| S3 | `x/y/glm-5.1` (control) | `{swe-1-6-slow, mapped:false}` | unchanged (single strip) |
| S3 | `xai/grok-4-6` (control) | `{grok-4-6-medium, mapped:true}` | unchanged |
| S4 | `gpt5.5` | `{swe-1-6-slow, mapped:false}` | `{gpt-5-5-low, mapped:true}` |
| S4 | `gpt5.4` | `{swe-1-6-slow, mapped:false}` | `{gpt-5-4-medium, mapped:true}` |
| S4 | `gpt5.4-mini` | `{swe-1-6-slow, mapped:false}` | `{gpt-5-4-mini-medium, mapped:true}` |
| S4 | `gemini3.5-flash` | `{swe-1-6-slow, mapped:false}` | `{gemini-3-5-flash-medium, mapped:true}` |
| S4 | `gpt5.6-luna` / `gpt5-6-luna` (already mapped) | `{gpt-5-6-luna-medium, mapped:true}` | unchanged |
| S4 | `claude5` (family shorthand) | `{claude-sonnet-5-medium, mapped:true}` | unchanged |
| S5 | `openai/MODEL_GPT_5_2_LOW` | `{swe-1-6-slow, mapped:false}` | `{MODEL_GPT_5_2_LOW, mapped:true}` |
| S5 | `model_gpt_5_2_low` | `{swe-1-6-slow, mapped:false}` | `{MODEL_GPT_5_2_LOW, mapped:true}` |
| S5 | `MODEL_GPT_5_2_LOW` (verbatim) | `{MODEL_GPT_5_2_LOW, mapped:true}` | unchanged |
| S5 | `openai/model_gpt_9_9_ultra` (unknown) | `{swe-1-6-slow, mapped:false}` | unchanged (fails closed) |
| S2 | `gpt.5.5.low` | `openai_json_xml` | `gpt_native` |
| S2 | `gpt5.6-luna` | `openai_json_xml` | `gpt_native` |
| S2 | `swe.1.5` | `openai_json_xml` | `kimi_k2` (same as `swe-1.5`) |
| S2 | `claude.opus.4.8` | `openai_json_xml` | unchanged |
| S2 | `kimi.k2` | `openai_json_xml` | `kimi_k2` (same as `kimi-k2`) |
| S2 | `glm-5.12` / `glm-5-12` | `glm47` | unchanged |
| S7 | `swe-1-5` | `kimi_k2` (target: `openai_json_xml`) | `kimi_k2` (target: `kimi_k2`) |
| S7 | `MODEL_SWE_1_5_SLOW` | `openai_json_xml` | `kimi_k2` |
| S7 | `swe-1-5-fast` | `kimi_k2` (target: `openai_json_xml`) | `kimi_k2` (target: `kimi_k2`) |
| S7 | `MODEL_SWE_1_5` | `openai_json_xml` | `kimi_k2` |
| S7 | `swe-1-6-slow` / `swe-1-7-lightning` | `openai_json_xml` | unchanged |
| P2-2 | `foo_bar/glm-5.1` | `gpt_native` (resolver: degrade) | `openai_json_xml` |
| P2-2 | `9lives/glm-5.1` | `gpt_native` | unchanged |
| residue | `grok-4-5` | `{swe-1-6-slow, mapped:false}` | `{grok-4-5-medium, mapped:true}` |
| residue | `inkling` | `{swe-1-6-slow, mapped:false}` | `{inkling-medium, mapped:true}` |

## Red → green

Command (every run): `node --import ./test/setup-env.mjs --test <files>` — never bare `node --test`.

| step | log | result |
|---|---|---|
| red, first 6 tests (S3, S4, S5, P3-d, S2, P2-2) | `AliasResolverFix-logs/red.log` | 55 tests, 49 pass, **6 fail** — exactly the six new tests |
| red, + S7 and residue tests | `AliasResolverFix-logs/red-s7.log` | 57 tests, 54 pass, **3 fail** (S7, residue, P3-d extended) |
| green, unit | `AliasResolverFix-logs/green-unit.log` | 57 / 57 |
| green, acceptance (6 files from the brief) | `AliasResolverFix-logs/green-acceptance.log` | **167 / 167**, 0 skipped |
| green, every test file importing the resolver or dialect (22 files) | `AliasResolverFix-logs/green-affected.log` | **720 / 720** |
| green, full suite (`node scripts/run-tests.mjs`) | `AliasResolverFix-logs/full-suite-rerun.log` | **6692 tests, 6595 pass, 0 fail, 97 skipped** |
| full suite, first run at HEAD | `AliasResolverFix-logs/full-suite.log` | 6692 tests, 6593 pass, **2 fail** — both in `test/cascade-turn-flag.test.js` (poll-window counts), a file that does not import either changed module and passes 3/3 in isolation; the rerun above is green. Recorded as a pre-existing timing flake, not attributed to this lane. |
| after-probe table | `AliasResolverFix-logs/after-probe.log` | the "after" column above |

The P2-1 test is green on both sides by design: it pins current behaviour, it does not fix it.

The acceptance and affected-suite runs were repeated at the final HEAD (`ddcd57e`). The full-suite runs
were taken at `0476e18`; every later commit touches only test assertions, the evidence file and the
mutation spec — no `src/` bytes changed after that run.

## S7 — why this direction (and what is not proven)

The matrix's "dialect it needs" column is derived from `pickToolDialect(resolves-to)`, so for S7 it is
circular: it says `swe-1-5` needs `openai_json_xml` only because the enum currently gets that. Nothing
in the repo measures the protocol of `MODEL_SWE_1_5_SLOW` directly. The only production observation is
the code comment's own: SWE-1.5/1.6/1.7 emit Kimi section tokens (2026-08-07), and `swe-1-5` is the
spelling that observation would have used. The lane therefore preserves the alias's observed dialect and
makes the enum agree, rather than the reverse. `_SLOW` on the enum is read as the slow **mode** of
SWE-1.5 (models.js: enum 377, UID `MODEL_SWE_1_5_SLOW`), not as the distinct deployment selector
`swe-1-6-slow`, which the exclusion still covers.

This is an **inference, not a live measurement**: no account probe was run in this lane. If a live probe
later shows `MODEL_SWE_1_5_SLOW` emitting `openai_json_xml`, the fix must move to the other side
(`swe-1-5` → `openai_json_xml`) and the comment here is the pointer to that decision.

## P2-1 — the prefix CAN change the upstream model

`resolveConnectSelector` consults `SELECTOR_MAP` on the RAW name before any normalization, so a dotted
MAP KEY with a curated target is reachable only in its unprefixed spelling:

| spelling | resolves to |
|---|---|
| `claude-sonnet-4.6` | `claude-sonnet-4-6-thinking` (curated map target) |
| `anthropic/claude-sonnet-4.6` | `claude-sonnet-4-6` (base catalog selector) |

The comment in `tool-emulation.js` now states this instead of claiming the prefix never changes the
model, and the pair is pinned by `pins the known prefix asymmetry for a dotted family alias (P2-1)` so a
future fix cannot move it silently. Resolver behaviour for this case is deliberately unchanged in this
lane.

## Mutation verification (WSL, `/opt/node24/bin/node` v24.21.0)

Source: a clone of `D:/Project/WindsurfAPI` checked out at this branch (`~/w105-mut`); the harness
materializes its own disposable workspace and refuses a dirty tree. The Windows worktree cannot be used
directly — its `.git` file holds a Windows absolute path that Linux git cannot resolve.

Specs touching `src/devin-connect-models.js` or `src/handlers/tool-emulation.js`:

| spec | mutations | exit |
|---|---|---|
| `test/mutations/alias-resolver-systemic.json` (**new**) | 12 | 0 |
| `test/mutations/connect-catalog-hotfix.json` | 26 | 0 |
| `test/mutations/devin-connect-warning-cache.json` | 4 | 0 |
| `test/mutations/interleave-parallel-tool-history.json` | 3 | 0 |
| `test/mutations/preamble-skip-discarded-tier.json` | 12 | 0 |
| `test/mutations/s1-p4-prefix-tables.json` | 4 | 0 |
| `test/mutations/schema-ref-fanout-budget.json` | 19 | 0 |
| `test/mutations/wire-h2-orphan-scope.json` | 5 | 0 |
| `test/mutations/wire-h3-reasoning-policy.json` | 11 | 0 |

Baseline re-pin: `connect-catalog-hotfix.json` expected 47 but reported **49 at `0cae51b`** — already
stale by 2 before this lane — and **55** with the six new resolver tests. Re-pinned to 55 (numbers
only, no mutation changed).

The new spec covers each fix plus its over-reach: S3 strip reverted; S4 split removed; S4 split without
the required `.`; S5 raw-name enum test; S5 existence gate dropped; S2 dot collapse removed; S2 compact
split removed in the dialect; S2 Kimi SKU check reverted to the literal spelling; S7 enum mapping
removed; P2-2 strip widened; `grok-4-5` row removed; `inkling` row removed — 96 mutations across the
nine specs, all as expected. The first run of the over-reach mutation **survived** — the raw map lookup
shields the exact lowercase key, so `claude5` never reaches the normalization step. Added the uppercased
`Claude5` assertion (verified to resolve at base) and the mutation is now caught.

## Out of scope / not done

- The connect handlers still pass the RAW request name and `provider: null` to `pickToolDialect`
  (`src/handlers/chat.js:3716`, `src/devin-connect-openai.js:661/699/884/1034`). Choosing the dialect from
  the RESOLVED selector + catalog provider is the matrix's preferred fix for S1/S2/S7; it is a
  handler-level change outside this lane's file scope and is not attempted here.
- S1 (prefix survives into the dialect picker) is only mitigated by the strip, not solved by resolving
  the selector.
- No live account probe was run: every resolution claim above is against the committed snapshot
  (`src/data/devin-catalog-snapshot.json`, `_count 233`) and the live-set seams set explicitly in tests.

STATUS: DONE

# FixD10 — docs truth: env switches, Connect maps, acceptance arithmetic

Tree: `master` `2598299e` (worktree
`C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261026/w17x-FixD10`,
branch `fix/d10-docs`). Docs-only: no source or test file was edited. The shared
tree's in-flight D8 edits were left untouched; this work was moved to its own
worktree before verification.

## 1. What was wrong, what changed

Every corrected claim below cites the code line that decides it. Line numbers are
on `2598299e`.

| # | File | Old claim (wrong) | Corrected claim | Code evidence |
|---|---|---|---|---|
| 1 | `docs/ENV-SWITCHES.md:3-9,359-366` | 三前缀开关 164 / 168；`.env.example`+README 81，本文 83 | **181**；91 + 90. The old 5-form script counts 172; the 9-name gap is `csvListEnv`/`csvSetEnv` (7 bridge gates) + `env?.NAME` (2 request budgets) | `src/cascade-native-bridge.js:127-134`; `src/request-budget.js:46,48` |
| 2 | `docs/ENV-SWITCHES.md:192` | `LS_PER_PROXY_USER` default = every proxy user gets its own LS | Default is **sticky-username auto-detection**; a plain username shares the LS; `=1` forces per distinct username, `=0` disables | `src/langserver.js:222` (`STICKY_USER_RE`), `:248-255` (decision) |
| 3 | `docs/ENV-SWITCHES.md:210` | `STABLE_DEVICE` is a fixed fingerprint **seed** | It is a boolean gate, `=== '1'`. The seed is server-minted per account and persisted; an env-supplied seed is ignored | `src/auth.js:1199`, `:1208` |
| 4 | `docs/ENV-SWITCHES.md:124` | Remote cred store still requires a loopback peer | Default path = local bind **and** loopback peer; `=1` bypasses the loopback/bind check for any authenticated peer | `src/dashboard/api.js:889-895` |
| 5 | `docs/DEVIN-CONNECT-CUTOVER.md:480-533`; `.env.example:427-436` | "Every other value maps to `stop`"; `3→length`/`5→content_filter` retired; example `5=content_filter`; `.env.example` `8=content_filter` | Full 0–13 map: 3→length, 5→length, 8→stop, 11→content_filter, 13→error; unknown/non-numeric → stop; override targets limited to stop/length/tool_calls/content_filter; examples corrected to `1=stop,13=stop` | `src/devin-connect.js:2884-2899` (table), `:2920-2938` (overrides), `:2927` (allowed targets), `:2994-3002` (fallback) |
| 6 | `.env.example:418-423` | AssignModel "inferred defaults" `asg_model_uid=1, asg_jwt=2`, no `req_cascade_id` | Post-`86d5543` set: `req_model_uid=2, req_cascade_id=3, resp_assignment=1, asg_model_uid=2, asg_jwt=1, asg_harness=3`; old set called out as wrong | `src/devin-connect-catalog.js:521-527` |
| 7 | `docs/ENV-SWITCHES.md:206` | `PROTO_TRACE_STRINGS` read at `proto-trace.js:814`; one `<redacted>` placeholder | Read at `:816`; placeholders are `<redacted-secret>` / `<redacted-email>` / `<redacted-token>` | `src/proto-trace.js:816`, `:50-54` |
| 8 | `docs/ENV-SWITCHES.md:263` | `TOOL_DESC_MAX` is an active length cap | Currently inert: `capToolDescription` is no longer called by `encodeToolDef`; retained as an escape hatch | `src/devin-connect.js:948-961` |
| 9 | `docs/ENV-SWITCHES.md:154-155` | Stats/decision caps mention only the ≤0 fallback | Hard upper clamps are 2000 and 200 | `src/native-bridge-stats.js:32-36`, `:58-62` |
| 10 | `docs/ENV-SWITCHES.md:169` | Detach limits: TTL 120 s / 8 / 2 / 4 MiB | Adds the **32 MiB global total** cap | `src/detached-registry.js:51-54` |
| 11 | `docs/ENV-SWITCHES.md:241` | Prompt-cache family = `gpt-6-{luna,sol,astra}`, `gpt-6-1-sol` | Regex also admits `gpt6*`, `gpt-6-1-*`, `gpt6.1-*` for luna/sol/astra | `src/devin-connect.js:1482` |
| 12 | `docs/ENV-SWITCHES.md:135,149,152-153` | `TOOL_HYGIENE` attributed to three handlers; 5 bridge gates only abbreviated | Read site is `tool-ids.js:301` (handlers import it); full names for `TOOLS`/`MODELS`/`PROVIDERS`/`ROUTES`/`CALLERS`/`API_KEYS`/`ACCOUNTS`/`WEBFETCH_AUTO_APPROVE_ORIGINS` | `src/tool-ids.js:301`; `src/cascade-native-bridge.js:127-134,156-163,176-200` |
| 13 | `docs/ENV-SWITCHES.md:270,273` | `CASCADE_MAX_WAIT_MS` README refs 642/542; `MAX_DRAIN_MS` attributed to `handlers/chat.js` | README refs 745/630; resolver is `stream-writer.js:32` (shared writer) | `README.md:745`, `README.en.md:630`; `src/stream-writer.js:32` |
| 14 | `docs/DEVIN-CONNECT-CUTOVER.md:101` | Password auto-store at `src/auth.js:1495-1500` | `src/auth.js:1981` | `src/auth.js:1981` |
| 15 | `docs/DEVIN-CONNECT-CUTOVER.md:392` | AssignModel defaults cited without a code anchor | Added `ASSIGN_TAGS_DEFAULT` (`devin-connect-catalog.js:521-527`) | `src/devin-connect-catalog.js:521-527` |
| 16 | `docs/DEVIN-CONNECT-CUTOVER.md:629` | Runbook showed the legacy positional `TOOL_DEF_TAGS="10,1,2,3"` | Named form `outer=10,name=1,description=2,parameters=3`; positional is back-compat only and must be exactly 4 numbers | `src/devin-connect.js:776-794` |
| 17 | `evidence/ACCEPTANCE-20261026.md` | 批 1 "10 个 P1 根因"; no per-row matrix | **4 P0 + 18 P1 + 5 P2**; 批 1 = **4 P0 + 9 P1**, 批 2 = **9 P1 + 4 P2**, **V-27 open**; 27-row V-ID/severity/evidence matrix | `evidence/audit/VERDICT.md` severity table; commits/tests per row |
| 18 | `evidence/REQUIREMENTS-LEDGER.md` | R11 "19 项 P1"; batch 2 list mixes P1 and P2 | **18/18 P1**; batch 1 = 4 P0 + 9 P1, batch 2 = 9 P1 + 4 P2; V-23/24/25/26 labeled P2; V-27 open | `evidence/audit/VERDICT.md`; `ACCEPTANCE-20261026.md` §1 |

The census numbers in #1 were re-derived on this tree, not copied: the doc's own
(now widened) script prints **181**; the four reader-facing docs cover all 181
(91 in `.env.example` + README, 90 in `ENV-SWITCHES.md`). The five previously
abbreviated names are now written in full, so a `grep -F` check also finds them.
The guard itself still scans only five access forms
(`test/docs-consistency-guard.test.js:513-524`) and is blind to the 9 helper /
`env?.` reads; the doc now says so instead of treating a green guard as proof.

## 2. Acceptance arithmetic (the corrected ledger)

| Severity | Rows | V-IDs |
|---|---:|---|
| P0 | 4 | V-01, V-02, V-03, V-04 |
| P1 | 18 | V-05 … V-22 |
| P2 | 5 | V-23, V-24, V-25, V-26, **V-27 (open)** |

- 批 1 (`b3877065`): V-01/02/03/04 (P0) + V-05/06/07/09/15/16/19/20/22 (P1) = **13**.
- 批 2 (`2598299e`): V-08/10/11/12/13/14/17/18/21 (P1) + V-23/24/25/26 (P2) = **13**.
- Open: **V-27** (P2). `evidence/audit/FIX-QUEUE.md:76` still queues a real
  cache-replay accounting test; no such test exists yet.

The per-row matrix with commit, evidence file, and proving test is
`evidence/ACCEPTANCE-20261026.md` §1. It distinguishes "merged" from "boundary not
closed": V-04 (`/auth/*`, forwarded Host — D1), V-08 (Messages/Gemini — D8),
V-10 (Connect stream — D2), V-13 (reuse→fresh fallback — D3). Those are not counted
as fully closed just because their original test is green.

## 3. Verification

Docs guard (the assignment's named gate), run in the worktree on clean `master`
plus these edits:

```
$ node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js
ℹ tests 47
ℹ suites 9
ℹ pass 47
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Census (extracted verbatim from the edited doc and executed):

```
$ python <extracted ENV-SWITCHES script>
181
```

Coverage re-derivation: `total 181; undocumented in four docs []`;
`env+readme 91`; `doc-only 90`.

Diff hygiene: `git diff --check` → clean.

## 4. Residuals (explicitly not claimed)

- **README `LS_PER_PROXY_USER` bullet** (`README.md:646`, `README.en.md:548`) still
  says every proxy gets its own LS. It is outside this assignment's five-file
  target; the authoritative row in `ENV-SWITCHES.md:192` is now correct.
- **32 switches outside the three prefixes** (P2-7 in `evidence/audit2/Docs.md`)
  remain undocumented in reader-facing docs. The guard does not cover those
  prefixes; adding all 32 rows is a separate docs expansion, not a correction of a
  false instruction.
- **README/i18n P3 rows** (model counts 73/22, "two APIs", dashboard panel table,
  63 dead i18n keys, sketch-skin gate) are untouched — outside the target files.
- **`docs/HANDOFF-2026-10-15.md:20-33`** was checked against
  `git rev-list -n1 v3.141.592655` (= `c60d7469`) and the commit graph: its release
  statements are true for the last release. It does not claim the two fix batches
  are released, so no edit was made; the release truth is stated in
  `ACCEPTANCE-20261026.md` §4 (tag `v3.141.592655`, master 34 commits past it,
  `3.141.592656` does not exist).
- **No release/tag/deploy**: the batch-1 recommendation to cut `3.141.592656` is
  recorded as a recommendation only. V-10/V-13 and D1–D5 remain open; the 96-spec
  mutation sweep is still pending in `evidence/audit2/MatrixFinal.md`.

# Wave 4 — model-table truth (#159 behavior, #149 policy)

**Worktree:** `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w113-freemodels`
**Branch:** `fix/free-model-truth`, based on master `c6bed61`
**Date:** 2026-10-25 · **Not pushed, not tagged, not merged.**
**Wave artifacts (logs + this memo):** `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/evidence/`

Source of the two gaps: the HistoryGapAudit report (`gaps.md`) §C1-01 (#149) and §C1-02 (#159).

---

## 1. #159 — `reason:'success'` was not an available signal (behavior fix)

### What the issue actually says

`#159` body (tuzhu1020, 2026-05-10) already contains the line-level diagnosis and the
proposed fix: `getAvailableModelsForAccount` accepted only `reason === 'user_status'`,
while the account's `glm-5.1` capability was `ok: true, reason: "success"` — so the model
was absent from `availableModels`, the pool looked like it had no account for it, and the
request was answered `probe_pending`. The closure comment ("没给任何细节") did not engage
with the body.

### Root cause in the tree (both gates, not one)

| Site | Before | Consequence |
|---|---|---|
| `getAvailableModelsForAccount` (`src/auth.js`, pre-fix :2153-2173) | pushed only `cap.reason === 'user_status' && cap.ok === true`, and only for enum-keyed models | a model that had just answered (`success`) disappeared from `availableModels`; UID-only models (`glm-5.1`, `enumValue: 0`) never entered it even with `user_status` |
| `isModelAllowedForAccount` (`src/auth.js`, pre-fix :1947-1970) | trusted only `user_status` / `not_entitled`, else fell back to the static tier table | for a free account the fallback is one model, so a working `success` model was denied routing |

`availableModels` is not cosmetic: `src/handlers/chat.js:5072` gates the whole pool on
`(a.availableModels || []).includes(routingModelKey)`, then answers 403
`probe_pending` / `model_not_entitled` when no account lists the model. That is the
user-visible failure in #159.

`_discoveredFreeModels` (`src/models.js:867`) is process-local and never persisted, so
after a restart the tier table is back to `['gemini-2.5-flash']` even for a model that had
already succeeded. The persisted `capabilities` map is the only durable evidence — which
is why the fix belongs in the capability gates, not in the base table.

### Change

- One shared positive set, `AVAILABLE_CAPABILITY_REASONS = {'user_status','success'}`,
  read by **both** gates so they cannot drift again.
- `isModelAllowedForAccount`: `not_entitled` stays the authoritative negative; `success`
  joins the authoritative positive arm; the cloud-catalog gate and the operator blocklist
  still outrank both.
- `getAvailableModelsForAccount`: a positive verdict now counts for **every** catalog entry
  (enum-keyed or not) and outranks the tier table, exactly like the routing gate. Entries
  with no verdict keep the old fallback (tier table; for UID-only models that is the only
  source, since GetUserStatus returns allowlists by enum).

### Sibling `user_status` checks — grepped, and why each is unchanged

`grep -rn "user_status" src/` (excluding `_bundle.cjs`):

| Site (branch head) | Role | Decision |
|---|---|---|
| `src/auth.js:1975` | routing gate | **changed** (above) |
| `src/auth.js:2183` | list gate | **changed** (above) |
| `src/auth.js:5479` / `:5485` | GetUserStatus writers | unchanged — they produce the reasons, they do not read them |
| `src/auth.js:5482` | `prev.reason !== 'success'` guard in the negative arm | unchanged — it already preserves a validated success on purpose ("can happen if allowlist is cascade-only while the model was reached via legacy endpoint") |
| `src/auth.js:5631` | canary-probe **scheduler**: skip a model GetUserStatus already classified | unchanged, deliberately — this decides whether to spend a billable probe, not whether the model is available. Skipping re-probes on `success` would hide a model that later stopped working |
| `src/dashboard/devin-cards.js:231-232` | display mapping (`not_entitled` badge) | unchanged — reads `cap.ok === false`, not an availability gate |
| `test/*` | fixtures | extended in `test/account-entitlement.test.js` |

### Measured before/after

Runtime probe, same shape as the audit's, run in a throwaway worktree at `c6bed61` (pre-fix)
and in this worktree (post-fix):

```bash
WINDSURFAPI_IGNORE_CLOUD_FILTER=1 node --import ./test/setup-env.mjs --input-type=module -e '
process.env.WINDSURFAPI_IGNORE_CLOUD_FILTER="1";
const {getAvailableModelsForAccount,isModelAllowedForAccount}=await import("./src/auth.js");
const mk=(caps)=>({id:"p",apiKey:"k",tier:"free",userStatusLastFetched:1,capabilities:caps});
for (const [label,caps] of [
  ["success/glm-5.1",{"glm-5.1":{ok:true,reason:"success"}}],
  ["user_status/glm-5.1",{"glm-5.1":{ok:true,reason:"user_status"}}],
  ["not_entitled/gemini-2.5-flash",{"gemini-2.5-flash":{ok:false,reason:"not_entitled"}}],
]) {
  const a=mk(caps); const key=Object.keys(caps)[0];
  console.log(label, "available="+getAvailableModelsForAccount(a).includes(key), "allowed="+isModelAllowedForAccount(a,key));
}'
```

| capability | before (`c6bed61`) | after (branch head) |
|---|---|---|
| `glm-5.1 {ok:true, reason:'success'}` | `available=false allowed=false` | `available=true allowed=true` |
| `glm-5.1 {ok:true, reason:'user_status'}` | `available=false allowed=true` (list ≠ routing) | `available=true allowed=true` |
| `gemini-2.5-flash {ok:false, reason:'not_entitled'}` | `available=false allowed=false` | `available=false allowed=false` (unchanged) |

`glm-5.1` is `enumValue: 0` (`src/models.js:389`), so GetUserStatus cannot classify it —
`success` is its only evidence path. The third row pins that the fix did not turn
`not_entitled` into a positive.

Red-first: with only the new tests applied to `c6bed61`'s source,
`node --import ./test/setup-env.mjs --test test/account-entitlement.test.js` was
**14 tests / 10 pass / 4 fail**; the four failures were exactly the new #159 cases
(`lists a success-reason model`, `routes a success-reason model`, `lists a UID-only
user_status model`, `list and routing agree`). After the fix: **14/14**.

New tests (`test/account-entitlement.test.js`, `describe('#159 — a measured success is an
available signal')`):

1. `lists a success-reason model in availableModels`
2. `routes a success-reason model`
3. `lists a UID-only user_status model instead of only routing it`
4. `keeps the list and the routing gate in agreement across capability reasons`
   (six capabilities covering `user_status` ok/denied, `success`, `not_entitled`,
   `model_error`, and a UID-only `model_error`)
5. `does not let an authoritative negative leak in through the tier table`

---

## 2. #149 — should `glm-4.7` + `kimi-k2` join `FREE_TIER_BASE`? **No.**

### The claim under test

#149 closure reason (dwgx, 2026-05-08):
> Free 账号 Windsurf 上游只给 gemini-2.5-flash、glm-4.7、kimi-k2 这几个模型的权限。
> 这不是 proxy 限制，是 Windsurf 的 free tier 策略。

Tree at `c6bed61`: `FREE_TIER_BASE = ['gemini-2.5-flash']` (`src/models.js:853`), plus
`_discoveredFreeModels`, filled by `registerDiscoveredFreeModel()` after one successful
call. The audit read that as "closure claim vs. tree" inconsistency.

### Evidence for a three-model free tier

- #81 (gcs1230, 2026-04-27): free accounts run `glm-5.1` and `kimi-k2.6` in the official
  client, with screenshots; "稍微调整了下就实现了".
- #86: several users run `glm-5.1` on free accounts (tool-call problems, not entitlement).
- #42 (LuckerYan): lists the models a free account reached — `glm-5.1`, `kimi-k2-6`,
  `swe-1.6`, `swe-1.6-fast`, `swe-1.5`.
- #155 maintainer comment (2026-05-09): free Cascade accounts can use
  `gemini-2.5-flash / glm-4.7 / kimi-k2`.

So free accounts *can* have GLM/Kimi. That is not in dispute.

### Evidence against encoding it as a static base table

1. **The base table was deliberately narrowed, after measurement.** `git show 4b72ecd`
   (v2.0.0, 2026-04-24): `FREE_TIER_BASE` went from
   `['gpt-4o-mini', 'gemini-2.5-flash']` to `['gemini-2.5-flash']`, commit message
   "FREE_TIER_BASE updated to gemini-2.5-flash only". Re-adding two models would reverse a
   measured decision with a comment.
2. **The maintainer's own #155 answer attributes the three-model list to probing**, not to
   the table: "（v2.0.92 自动探测）" and "如果只显示 1 个，点那个号右边的 Probe 按钮重新探测".
3. **The reporter's measurement in #149 contradicts a static guarantee.** lis216,
   2026-05-09: "windsurf上登录是有gml-5.1这些 而且你探测出是FREE是只有gemini-2.5-flash
   其他都没有 只有一个". On his account the probe found one. `glm-4.7` (enum **417**) and
   `kimi-k2` (enum **323**) are enum-keyed, so a `GetUserStatus` allowlist that contained
   them would have written `user_status` for them and the list would have shown three. It
   did not — the list is account-dependent.
4. **The static base is not the mechanism that supplies them.** Both keys are enum-keyed,
   so `cascade_allowed_models_config` (via GetUserStatus) is authoritative per account;
   UID-only models are supplied by a successful call. A static entry would only fire for
   accounts the upstream did *not* entitle — advertising a model that then fails upstream
   (`permission_denied`, surfaced as 529) instead of a clean 403. The tree already carries
   this lesson for the connect namespace: `src/auth.js:2001` — "Returning true
   unconditionally made discovery synthesize it as reachable+free, i.e. the one selector
   the dashboard called free was the one that could not run."
5. **The user-visible complaint was #159, not the table.** A probed, working model was
   dropped from `availableModels` and from routing (fixed in §1). With that fix, persisted
   capabilities keep discovered models across restarts — which `_discoveredFreeModels`
   (process-local, never persisted) never could.

### Decision

`FREE_TIER_BASE` stays `['gemini-2.5-flash']`. Instead:

- `test/free-tier-cold-start.test.js` pins the actual cold-start contract:
  the static free table is exactly `['gemini-2.5-flash']`; `glm-4.7` / `kimi-k2` are
  absent and must stay enum-keyed; a free account with no probe and no capabilities lists
  exactly the base table; discovery is the growth path.
- `src/models.js` documents the decision next to the constant (why one model, what supplies
  the rest, and that a guess here converts a 403 into an upstream 529).
- `README.md` (blockquote + FAQ) and `README.en.md` state the cold-start floor explicitly,
  so "my free token only shows gemini-2.5-flash" reads as expected behaviour rather than a
  bug. `docs-consistency-guard.test.js`: 44/44 after the edit.

### Corrected closure wording (for the maintainer to post on #149 — this branch does not edit GitHub)

> Free 账号能用的模型不是静态三个，而是**按账号探测**出来的：`gemini-2.5-flash` 是冷启动
> 静态基表；其余（如 `glm-4.7`、`kimi-k2`、`glm-5.1`）由 GetUserStatus 的 per-account
> allowlist（enum 键模型）或一次成功调用（UID-only 模型）发现，写进该账号的
> `availableModels`。新号只显示 1 个属正常；dashboard 点 Probe 会补齐。Probe 后仍只有
> 一个，说明该账号上游确实只 entitl 了 `gemini-2.5-flash`。
>
> The proxy does not hard-code three free models. It ships one cold-start model and
> discovers the rest per account; a fresh account showing one model is expected.

---

## 3. Mutation specs — re-pinned by measurement

Specs whose `file` is `src/auth.js` or `src/models.js` (the two files this branch edits):

```
$ node scripts/spec-baseline-check.mjs connect-catalog-hotfix.json dashboard-connect-parity.json \
    rate-limit-history.json s4-r3.json shard-tied-prefix.json sticky-collapse-bypass.json \
    sticky-queue-on-pin.json strict-usage-total.json web-search-exposure.json model-capability-data.json
ok connect-catalog-hotfix.json: 56 pass + 0 approved skips = 56 [MEASURED_NO_SKIPS]
ok dashboard-connect-parity.json: 49 pass + 0 approved skips = 49 [MEASURED_NO_SKIPS]
ok model-capability-data.json: 12 pass + 0 approved skips = 12 [MEASURED_NO_SKIPS]
ok rate-limit-history.json: 4 pass + 0 approved skips = 4 [MEASURED_NO_SKIPS]
ok s4-r3.json: 6 pass + 0 approved skips = 6 [MEASURED_NO_SKIPS]
ok shard-tied-prefix.json: 21 pass + 0 approved skips = 21 [MEASURED_NO_SKIPS]
ok sticky-collapse-bypass.json: 5 pass + 0 approved skips = 5 [MEASURED_NO_SKIPS]
ok sticky-queue-on-pin.json: 26 pass + 0 approved skips = 26 [MEASURED_NO_SKIPS]
ok strict-usage-total.json: 17 pass + 0 approved skips = 17 [MEASURED_NO_SKIPS]
ok web-search-exposure.json: 7 pass + 0 approved skips = 7 [MEASURED_NO_SKIPS]
10 spec(s) measured, 0 drift, 0 untrustworthy
```

Anchor/shape check: `node scripts/spec-static-check.mjs` →
`specs: 92  mutations: 822  ✓ anchors unique, specs well-formed, baselines are positive integers`.

No spec's `tests` list contains `test/account-entitlement.test.js` or
`test/free-tier-cold-start.test.js`, so the five added tests change no `expectBaselinePass`.
No spec anchors inside the edited regions (`grep` for `user_status|capabilities|
getAvailableModelsForAccount|isModelAllowedForAccount|FREE_TIER` over `test/mutations/*.json`
→ 0 hits), so no anchor needed re-pointing.

**Catch counts are `[UNVERIFIED]` on this host.** `node scripts/spec-baseline-audit.mjs`
aborts here with `mutation harness requires git at a trusted absolute path` — the harness
only trusts POSIX git (`scripts/mutation-harness-utils.mjs:11-19`). Mutant execution is the
HMC/Linux sweep's job; on Windows only spec shape, anchors and baseline counts are
measurable, which is what the rows above are.

No new spec was added for these two functions: a spec whose `expectCaught` values cannot be
executed on this host would assert unverified behaviour, which is the failure mode the spec
directory exists to prevent. The behaviour is pinned by the unit tests instead; adding a
spec is a follow-up for an HMC run.

---

## 4. Test evidence

### Targeted (this branch, `node --import ./test/setup-env.mjs --test …`)

14 files / **208 tests / 208 pass / 0 fail / 0 skipped**, exit 0
(wave artifact `Wave4-targeted.log`):

```
test/account-entitlement.test.js
test/free-tier-cold-start.test.js
test/cloud-catalog-filter.test.js
test/probe-pending-gating.test.js
test/dashboard-devin-cards.test.js
test/dashboard-api.test.js
test/connect-cost-tier-free-list.test.js
test/issue-258-free-fallback.test.js
test/tier-unknown-optimistic.test.js
test/drought-connect-namespace.test.js
test/drought-restrict-premium.test.js
test/dashboard-models-connect-parity.test.js
test/model-capability-data.test.js
test/docs-consistency-guard.test.js
```

```
ℹ tests 208
ℹ pass 208
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

### Full suite

`node scripts/run-tests.mjs` (552 files) — result in §5 below
(wave artifact `Wave4-full-suite.log`).

---

## 5. Full-suite result

`node scripts/run-tests.mjs` (exit 0, 53.6 s; wave artifact `Wave4-full-suite.log`):

```
TEST_DISCOVERY 552 unique files
ℹ tests 6780
ℹ suites 1275
ℹ pass 6683
ℹ fail 0
ℹ cancelled 0
ℹ skipped 97
ℹ todo 0
ℹ duration_ms 53577.5934
```

Reconciliation with the last recorded full run (release notes v3.141.592654: 551 files /
6,771 tests / 6,674 pass / 97 skipped): **+1 file** (`test/free-tier-cold-start.test.js`),
**+9 tests / +9 pass** (4 cold-start pins + 5 #159 cases), skips unchanged at 97.

---

## 6. Files changed

| File | Change |
|---|---|
| `src/auth.js` | shared `AVAILABLE_CAPABILITY_REASONS`; `success` accepted by both gates; list gate gives a capability verdict precedence for every catalog entry |
| `src/models.js` | comment at `FREE_TIER_BASE` recording the #149 decision (one model, why, what supplies the rest) |
| `test/account-entitlement.test.js` | +5 #159 tests (red-first: 4 failed on the pre-fix source) |
| `test/free-tier-cold-start.test.js` | new — 4 cold-start pins for #149 |
| `README.md`, `README.en.md` | cold-start floor stated in the free-model answer (blockquote + FAQ) |
| `evidence/Wave4-Models.md` | this memo |

Commits: `001c8ca fix(auth): accept a measured success as an available-model signal`,
`9bb0bf8 test(models): pin the free-tier cold-start table and record the #149 decision`.

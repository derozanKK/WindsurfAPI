# Wave 7 — auth truth: success freshness + billed-history reservation

Lane: `AuthTruthP2` · Worktree `w122-authtruth` · Branch `fix/auth-truth-p2` · Base `cf27abd` (master)
No push, no tag, no merge.

## Findings (wave review, `evidence/KimiWaveReview.md`)

### P2-4 — a historical `success` defeats current entitlement indefinitely

`reason:'success'` outranked the tier table and the current allowlist with no
freshness/tier boundary. `lastCheck` was persisted but never read by the gates,
and `fetchUserStatus` deliberately preserved a prior success when the refreshed
allowlist omitted that enum. Reproduced by the reviewer with
`{tier:'free', userStatusLastFetched:<now>, capabilities:{'claude-opus-4.6':
{ok:true,reason:'success',lastCheck:1}}}`: both `isModelAllowedForAccount` and
`getAvailableModelsForAccount` returned true, so a downgraded/trial-expired
account kept listing and routing a premium model the upstream no longer
entitled.

### P2-6 — a failure burst evicts the billed window and zeroes its summary

Failed attempts and billed rows shared the 100-row ring (`ACCOUNT_REQUEST_CAP`).
One billed row (5 prompt + 3 completion, credit 2, ACU 1) followed by 100 failed
rows yielded `{total:100, billed:0, failed:100, summary:{requests:0,
totalTokens:0, credit:0, acu:0}}` — the dashboard read as "this account served
nothing".

## Changes

### `src/auth.js` — one capability verdict for both gates

- `capabilityVerdict(account, modelKey)` (`:1954`) replaces the old
  `AVAILABLE_CAPABILITY_REASONS` set. It returns `true` (positive), `false`
  (authoritative negative) or `null` (no verdict → tier table):
  - `not_entitled` → false (both gates; previously the list gate let a UID-only
    `not_entitled` fall through to the Pro tier table).
  - `user_status` → `cap.ok === true`.
  - `success` → positive only while `lastCheck >= userStatusLastFetched`, i.e.
    the measurement is at least as new as the account's last authoritative
    snapshot. A stale success is a denial for enum-keyed models (the newer
    snapshot omitted them authoritatively) and falls back to the tier table for
    UID-only models (GetUserStatus cannot classify those).
- `isModelAllowedForAccount` (`:2003`) and `getAvailableModelsForAccount`
  (`:2211`) now consume that single verdict, preserving the #159 invariant that
  the list and the routing decision cannot disagree.

### `src/auth.js` — a refreshed denial supersedes an older success

`fetchUserStatus` (`:5581`) now writes `not_entitled` for every enum model the
refreshed allowlist omits, instead of preserving a prior `success`. A call that
succeeds *after* the snapshot still re-establishes `success` through
`updateCapability()` (its `lastCheck` is newer), so the denial is not a
permanent tombstone.

### `src/auth.js` — billed rows own the request-history window

`recordAccountRequest` (`:4279`) keeps the 100-row bound but changes eviction
order:
- incoming billed row → evict the oldest **failed** row; if every slot is
  billed, evict the oldest billed row;
- incoming failed row → evict the oldest failed row; if every slot is billed,
  drop the incoming failure instead of displacing a billed row.

A failure can therefore never evict a billed row. `total`, `billed`, `failed`,
`capacity` and the billed `summary` contract are unchanged; the summary is still
recomputed over survivors.

## Tests (red-first)

New/updated:

- `test/account-entitlement.test.js` — P2-4 block: stale success + fresh
  snapshot → neither listed nor routed (exact reviewer shape); success after the
  snapshot → listed and routed; no snapshot → success still trusted; refreshed
  `not_entitled` outranks the Pro tier table in both gates. The #159 fixtures
  now use a success newer than their snapshot.
- `test/userstatus-teams-tier-log.test.js` — executes the real `fetchUserStatus`
  body: a refreshed allowlist omitting a previously-successful enum writes
  `not_entitled`.
- `test/dashboard-account-requests.test.js` — one billed row + 100 failures →
  `billed:1`, summary byte-for-byte unchanged; a failure into a full billed
  window is dropped; a new billed row evicts the failure first.
- `test/mutations/auth-truth-p2.json` — three negative controls (freshness
  boundary removed; refreshed denial preserves success; old shared eviction
  order), anchors verified unique by `test/docs-consistency-guard.test.js`.

Red-before (base + tests only; `node --import ./test/setup-env.mjs --test …`):

```
test/account-entitlement.test.js         ℹ tests 18  ℹ pass 16  ℹ fail 2
  ✖ does not list or route a success older than the latest GetUserStatus snapshot
  ✖ lets a refreshed not_entitled supersede an older success even on a Pro tier
test/userstatus-teams-tier-log.test.js   ℹ tests 7   ℹ pass 6   ℹ fail 1
  ✖ writes not_entitled over a success the refreshed allowlist omits
    actual:   { ok: true, reason: 'success' }
    expected: { ok: false, reason: 'not_entitled' }
test/dashboard-account-requests.test.js  ℹ tests 15  ℹ pass 12  ℹ fail 3
  ✖ a failure burst cannot evict the billed window or zero its summary
  ✖ drops an incoming failure rather than evicting a billed row from a full billed window
  ✖ a newer billed row evicts the oldest failure before any billed row
```

Green-after:

```
test/account-entitlement.test.js         ℹ tests 18  pass 18  fail 0
test/userstatus-teams-tier-log.test.js   ℹ tests 7   pass 7   fail 0
test/dashboard-account-requests.test.js  ℹ tests 15  pass 15  fail 0
```

Related suites (entitlement/list/ring consumers), all green:

```
billing-identity-rotation, cloud-catalog-filter, connect-entitlement,
connect-rate-table-wiring, dashboard-devin-cards-render,
dashboard-devin-panel-routes                                  ℹ tests 82  fail 0
free-tier-cold-start, langserver-resource, probe-canary-optin,
s4-r3, probe-pending-gating, tier-unknown-optimistic          ℹ tests 50  fail 0
dashboard-devin-panel, dashboard-devin-read, dashboard-account-kpi,
dashboard-account-query, dashboard-api                        ℹ tests 84  fail 0
docs-consistency-guard (mutation anchors)                     ℹ tests 47  fail 0
```

## Full suite

`node scripts/run-tests.mjs` on the final bytes:

```
ℹ tests 6840
ℹ suites 1290
ℹ pass 6743
ℹ fail 0
ℹ cancelled 0
ℹ skipped 97
ℹ todo 0
ℹ duration_ms 54116.0216
```

## Mutation check

The repo's mutation harness (`scripts/mutate-verify.mjs`) requires git at a
trusted absolute POSIX path and refuses to run on this Windows box. The three
layers were mutation-checked by hand instead: back up `src/auth.js` (sha256
`9701ff61…ce9e`), apply the spec's replacement, run the targeted suite, restore
the backup, verify the sha256, re-run.

| Mutation (spec `test/mutations/auth-truth-p2.json`) | Result |
|---|---|
| freshness boundary removed (`if (true) return true;`) | CAUGHT — `account-entitlement` 17/18, stale-success test fails |
| refreshed denial preserves the old success | CAUGHT — `userstatus-teams-tier-log` 6/7, supersession test fails |
| shared eviction order restored (`ring.splice(0, 1)`) | CAUGHT — `dashboard-account-requests` 12/15, all three eviction tests fail |

After restore: sha256 matches the backup and the three files pass 40/40.

## Residual

- `_discoveredFreeModels` is process-global: a `success` measured while an
  account was `free`/`unknown` permanently widens the free tier table for every
  account. That is pre-existing discovery behavior, not this finding's
  `capabilities.success` path (a Pro/trial success is not registered because
  `updateCapability` only registers free/unknown tiers). Not changed here.
- A success on a UID-only model that is newer than the last snapshot remains
  trusted until the next snapshot; that is the intended live-evidence window.

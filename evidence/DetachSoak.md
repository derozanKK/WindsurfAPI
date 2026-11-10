# DetachSoak — §6.7 mutation table + local fake-upstream soak

- **Base:** `d4498954d5f219393908f2dc15f4f53640258d8d` (tree `5a224c9ba450b827291e347432fee83bb727db5d`), fetched fresh from `origin`.
- **Host:** HMC, Linux 6.12.111 (x86_64), Node **v24.21.0**, git 2.47.3; clone `/tmp/w41-detachsoak`.
- **Product source:** unmodified `d449895`. Every change in the clone is tests/harness only:
  - `test/mutations/detach-p1-soak.json` — the §6.7 table spec (not present at `d449895`).
  - `test/mutations/detach-p1-m11-addendum.json`, `detach-p1-lease-addendum.json`, `detach-p1-lease-deadline-addendum.json` — isolated mutant runs.
  - `test/cascade-detach-lazy-resume.test.js` — added **T7b** (path-sanitize assertion) and **T20** (resume-deadline lease release); proposed test patches.
  - `test/detach-soak.test.js` — local fake-upstream soak harness.
- **Logs:** `/tmp/detach-mutate.log` (raw table, baseline 42), `/tmp/detach-mutate-final44.log` (final table, baseline 44), `/tmp/detach-m11.log`, `/tmp/detach-lease.log`, `/tmp/detach-lease-deadline.log`, `/tmp/detach-soak.log`.

## 1. Baseline

```bash
cd /tmp/w41-detachsoak
WINDSURFAPI_SKIP_DOTENV=1 node --import ./test/setup-env.mjs --test \
  test/cascade-turn-snapshot-v2.test.js test/detached-registry.test.js \
  test/cascade-detach-lazy-resume.test.js
# unpatched d449895: tests 42 / pass 42 / fail 0
# after T7b + T20:   tests 44 / pass 44 / fail 0
```

## 2. Local soak (fake upstream)

```bash
cd /tmp/w41-detachsoak
WINDSURFAPI_SKIP_DOTENV=1 node --import ./test/setup-env.mjs \
  --test test/detach-soak.test.js
# tests 9 / pass 9 / fail 0 / duration 127035.8 ms
```

Harness: real `handleChatCompletions` + real `cascadeChat` against a scripted
loopback HTTP/2 LS; a response double closes the client socket at a chosen
write. `CASCADE_MAX_WAIT_MS=200000` so the real 120 s entry timer is the
expiry path, not the request deadline.

| Scenario | Trap | Result |
|---|---|---|
| SOAK-1 (10 cycles) | claim/resume/lease/billing | PASS — 10 admits, 10 serves, one `StartCascade` and one `SendUserCascadeMessage` per cycle, prefix exactly once, **330 tokens billed once per cycle**, `activeRequests` max 1 and 0 after each request, entries/bytes 0 |
| SOAK-2 (121 s) | real unref'd TTL timer | PASS — entry evicted by the timer (`evict.ttl +1`), no lease held, retry reached upstream (`startCalls +1`), nothing resumed |
| SOAK-3a | per-caller cap | PASS — 2nd detach evicted the oldest running entry (`evict.capacity +1`); evicted retry went upstream; surviving entry still resumed |
| SOAK-3b | entry cap + claimed protection | PASS — cap evicted only the running entry; a claimed entry forced `over_entries` and survived |
| SOAK-3c | byte cap | PASS — `refuse.over_bytes +1`, no entry, no truncation state, retry reached upstream |
| SOAK-4 (3 cycles) | abort during prefix replay (F22) | PASS — `re_detach +1`, `serve +0`, TTL unchanged, snapshot held the full answer, final retry served with prefix/growth exactly once and billed once (330) |
| SOAK-5 (3 races) | concurrent identical retries | PASS — `claim.ok +1` / `claim.busy +1` per race, one serve, `billed_detached +1` (the busy retry billed its own upstream turn, not the owner branch), leases returned to 0 |
| SOAK-6 | over-bill / wrong-account bill | PASS — seeded multi-turn cascade at `generatorOffset=7`: metadata RPC asked offset **7**, owner billed **110**, retry account **0**, `billed_detached +1` |
| SOAK-7 | account removal + drain | PASS — `removeAccount` evicted the entry (`evict.account_removed +1`), drain evicted it and refused admission, both retries reached upstream, `draining` reset, bytes 0 |

Positive controls are in every scenario (an `admit`/`serve`/`claim` assertion
before each negative), so "no entry" is not a vacuous pass. Log corroboration:
21 `detached turn CLAIMED` lines (10 SOAK-1 + 1 SOAK-3a + 6 SOAK-4 + 3 SOAK-5 +
1 SOAK-6), 25 × `usage in=300 out=30` (330 tokens) plus 1 × `in=100 out=10`
(110 tokens), 28 client-disconnect aborts, and no test failures. The only
warnings are the expected `NETWORK_STUB_MISS` model-catalog fetches from
`test/setup-env.mjs`'s network stub.

## 3. Contract preservation (detach off)

```bash
WINDSURFAPI_CASCADE_TURN=1 WINDSURFAPI_SKIP_DOTENV=1 node --import ./test/setup-env.mjs --test \
  test/cascade-turn.test.js test/cascade-turn-flag.test.js \
  test/cascade-abort-side-effects.test.js test/cascade-stream-account-spend.test.js \
  test/cascade-timeout-invalidation.test.js
# tests 31 / pass 31 / fail 0

WINDSURFAPI_CASCADE_TURN=1 WINDSURFAPI_SKIP_DOTENV=1 node --import ./test/setup-env.mjs --test \
  test/cascade-native-bridge.test.js test/cascade-metadata-egress.test.js \
  test/cascade-think-reroute.test.js test/cascade-reuse-default-copy.test.js
# tests 119 / pass 119 / fail 0
```

## 4. §6.7 mutation table

No runnable spec existed at `d449895` (`test/mutations/` had no detach spec), so
the spec was authored from the design table and the **actual** implementation
anchors. Every anchor was verified to match exactly once before the run.

```bash
cd /tmp/w41-detachsoak
node scripts/mutate-verify.mjs test/mutations/detach-p1-soak.json --keep-going
```

- **Raw run** (unpatched test file, baseline 42, every mutant expected CAUGHT):
  **11 CAUGHT, 2 SURVIVED** (M9a, M11); exit 1.
- **Final run** (T7b + T20 landed, baseline 44, M9a declared an equivalent
  mutant): **12 CAUGHT + 1 SURVIVED-as-expected**; exit 0; tree clean after
  every mutation.

| Design row | Mutant (anchor) | Verdict | Caught by |
|---|---|---|---|
| cursor completeness | M1: drop `generatorOffset` from `snapshot()` (`src/cascade-turn.js:386`) | **CAUGHT 8** | T3, T5/T7, T13 (+5; reporter truncates) |
| cursor validity | M2a: drop the mid-batch guard in `snapshot()` (`src/cascade-turn.js:366-371`) | **CAUGHT 1** | S5 |
| cursor validity | M2b: drop the `consumedThrough` guard in `admit()` (`src/detached-registry.js:290`) | **CAUGHT 1** | "refuses a snapshot without the v2 consumed pointer" |
| tenancy | M3: `detachedKey` ignores the caller scope (`src/detached-registry.js:102`) | **CAUGHT 1** | R1 |
| single writer | M4: delete the `claim` CAS (`src/detached-registry.js:377-379`) | **CAUGHT 3** | R4, R9, T14 |
| lease (design: begin at detach) | design layer absent; re-anchored to **M5b**: resume takes no `beginLsUse` (`src/handlers/chat.js:6800`) | **CAUGHT 2** | T5/T7, T11 |
| lease (design: end at claim/evict) | re-anchored to **M6**: client `finally` drops `releaseLease` (`src/client.js:1748`) | **CAUGHT 3** | T5/T7, T11, T14 |
| lease (claim-failure release) | **M6b**: delete `endLsUseFn` on the busy/expired claim branch (`src/handlers/chat.js:6818`) | **CAUGHT 1** | T14 |
| lease (resume-deadline release) | **M6c**: delete `endLsUseFn` when the claim loses its deadline (`src/handlers/chat.js:7043`) | **CAUGHT 1** | T20 |
| lease (ignore `leaseHeld`) | M7: always acquire a second lease (`src/client.js:725`) | **CAUGHT 6** | T5/T7, T3, T11, T14 (+2) |
| billing | M8: delete the `resumeBillingAccountId` owner branch (`src/handlers/chat.js:7534`) | **CAUGHT 2** | T5/T7, T3 |
| eligibility | M9a: delete the tool-chunk scan (`src/client.js:1104`) | **SURVIVED (equivalent)** | none — the `toolCalls.length` guard independently refuses |
| eligibility | M9b: delete both tool guards | **CAUGHT 1** | T4 |
| cause | M10: classify `shutdown` as `client_gone` (`src/handlers/chat.js:6273`) | **CAUGHT 1** | T8 |
| replay | M11: replay via raw `send`, bypassing `onChunk` (`src/handlers/chat.js:6832-6833`) | raw run **SURVIVED**; with T7b **CAUGHT 1** | T7b |

Isolated addenda (same command shape, one mutant each):

```bash
node scripts/mutate-verify.mjs test/mutations/detach-p1-m11-addendum.json
# baseline 43; CAUGHT 1 — T7b
node scripts/mutate-verify.mjs test/mutations/detach-p1-lease-addendum.json
# baseline 43; CAUGHT 1 — T14 (M6b)
node scripts/mutate-verify.mjs test/mutations/detach-p1-lease-deadline-addendum.json
# baseline 44; CAUGHT 1 — T20 (M6c)
```

### Per-design-row verdict

1. **PASS** — cursor completeness (M1).
2. **PASS** — cursor validity (M2a + M2b). Note: the design names T2 here, but T2
   is a pre-content abort and never reaches `snapshot()`/`admit()`; S5 and the
   registry test are the real guards. T2 still passes, as it must.
3. **PASS** — tenancy (M3/R1). T6 also stays green because `lookup()` checks the
   caller scope independently; the key and the lookup are two gates.
4. **PASS** — single writer (M4/R4/T14/R9).
5. **PASS (re-anchored)** — lease. The design's "lease held by the entry" was
   superseded by the implementation: the registry header says an entry pins no
   lease, and T11 asserts exactly that. Five lease mutants (M5b, M6, M6b, M6c,
   M7) cover acquire, normal release, claim-failure release, deadline release
   and double-acquire; all are caught.
6. **PASS** — billing (M8/T5/T3).
7. **PASS with an equivalent mutant** — eligibility. M9a survives because every
   `nativeToolCall`/`nativeToolResult` chunk is also pushed to `toolCalls` in the
   same branch (`src/client.js:1348`), so the second guard independently refuses
   the turn. Removing both (M9b) is caught by T4. The required behavior (never
   admit a tool/native turn) is pinned.
8. **PASS** — cause (M10/T8).
9. **FAIL on unmodified d449895, PASS with the proposed T7b patch** — replay.
   T5/T7 only counted the prefix; a raw `send` produced the same bytes, so the
   mutation survived. The design explicitly requires "T7 + a path-sanitize
   assertion". T7b was added (test-only) and catches the mutant: the fake prefix
   contains `/tmp/windsurf-workspace/secret.js`, the snapshot stores the raw
   chunk, and the resumed body must contain `<workspace>` and not the raw path.

## 5. Findings

1. **The promised mutation spec was missing.** The design says the runnable
   `scripts/mutate-verify.mjs` spec is produced with the implementation commit,
   but `d449895` contains no detach spec under `test/mutations/`. The spec used
   here is harness-only and is part of the evidence.
2. **The design's lease model is stale.** §6.4 T11 and §7.2's P1 "LS pool
   starvation" row assume the entry holds `beginLsUse` for 120 s. The
   implementation deliberately holds **no** entry lease; the resume request
   acquires one for its own lifetime and releases it in `cascadeChat`'s
   `finally` (plus the claim-failure and deadline paths, now pinned by T14/T20).
   T11 pins the implemented behavior (`activeRequests` 0 while detached, max 1
   during the resume, 0 after). This is safer for LS starvation but must be
   reconciled in the design and signed off before default-on.
3. **M11 was a real test gap, now closed by T7b.** Without T7b, a replay that
   bypassed `onChunk` would leak raw server paths and still pass the suite. T7b
   is a proposed test patch, not a product change.
4. **M9a is an equivalent mutant, not a gap.** The chunk scan and the
   `toolCalls.length` guard are redundant by construction. M9b is the true layer
   removal and T4 catches it.
5. **Design "must fail" columns are imprecise for T2/T6.** Both stay green under
   their respective mutants because a second, independent gate still refuses the
   turn. The behavior is covered by S5/registry (cursor) and R1 (key); T2/T6 are
   not the tests that drive those layers. No assertion was weakened.
6. **Residual (not in the design table):** the resume-deadline lease release was
   uncovered by T1–T19; T20 now pins it and M6c catches its removal. The soak
   does not exercise a real LS reap/restart while detached; T12 covers the
   generation mismatch only.

## 6. Go/no-go on default-on

**NO-GO.**

The local evidence is green: 12/13 mutants caught with one documented equivalent,
9/9 soak scenarios pass, and the 150-test contract subset is green. But the
design's own §7.4 gate is not met:

| Gate | Status |
|---|---|
| 1. Two weeks of `serve/admit` counters in one deployment | **NOT MET** — no deployment data; default is off |
| 2. T11 + N-instance capacity test (no `ls_pool_exhausted` for a live request) | **PARTIAL** — T11 passes; the N-instance pressure test was not run |
| 3. T3 + T5 (one-record bill, owner account) | **MET** — mutation table and SOAK-6 |
| 4. T4/T6/T8 + the mutation table fully caught | **MET with caveats** — T4/T6/T8 pass; M9a is equivalent; M11 needs T7b landed |
| 5. Maintainer sign-off on the amended abort clause | **NOT MET** |
| 6. Live soak: 60 s detach, identical retry, byte-identical answer | **NOT MET** — this lane used a fake upstream only |
| 7. Rollback path (unset env, restart; entries are memory-only) | **MET structurally** — drain evicts, no persistence in the registry |

Additional blockers before flipping the switch:

- Land T7b (or an equivalent sanitization guard); otherwise M11 is uncaught.
- Reconcile the design's lease/T11/starvation text with the implementation and
  re-sign §6.5/§7.4.
- Run the N-instance capacity test and the live 60 s soak.
- Do not tag or call the default-on decision "verified" on this lane alone.

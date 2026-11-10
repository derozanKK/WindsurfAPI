# RELEASE GATE — 3.141.592656

**Decision: BLOCKED**

**Audited tag-target candidate:** `0ef5067f19a8a13a39d826bc01bff0c0e991489c`
(tree `e6a5e35718a7ab06bd9d51271ec6da4921e4ad78`).
**B01:** `cd5666ff1aabb527ab93fdf3c3b46a65f173b1c2`
(tree `f6b0d50ab8eabc66eb43a64bf7f133aa878f5c49`).

The B02–B05 counters, skip accounting, retained-log sizes/hashes, V ledger, package versions,
release scope, and B01-to-candidate `src/` / `test/` identity all reconcile. The blocker is one
current-version-surface identity mismatch in HANDOFF §0.

## 1. Blocking discrepancy

| Surface | Claimed | Source of truth | Disposition |
|---|---|---|---|
| `docs/HANDOFF-2026-10-15.md` §0, `master` | `cd5666ff` | `master`, `origin/master`, and `HEAD` all resolve to `0ef5067f19a8a13a39d826bc01bff0c0e991489c`; `cd5666ff` is its parent | **MISMATCH — correct before tagging** |

`ReleaseReport-3.141.592656.md` correctly calls `0ef5067f` the final tag target and
`cd5666ff` B01. HANDOFF §0's product-tag sentence also correctly describes the docs-only tag
target; its separate `master` line is the stale entry.

**Clear condition:** correct §0 to the actual master/tag-target commit, preserving B01 as the
certification commit. If this creates a new docs-only commit, make that new commit the tag target,
update target references, recheck B01-to-target `src/` / `test/` identity, rerun B05 on the
resulting tree, and record the new final B05 log hash. Do not tag the tree while §0 still names
B01 as current master.

## 2. B01–B05 source reconciliation

All counters below were independently read from the named retained logs. SHA-256 and byte sizes
were recomputed locally; every declared digest and declared size matches.

| Row | Reconciled result | Named source / verification |
|---|---|---|
| B01 | Version commit `cd5666ff`; parent `12aebfcb`; tree `f6b0d50ab8eabc66eb43a64bf7f133aa878f5c49` | Git object/ancestry check: PASS |
| B02 | exit 0; **590/590 files; 7,194 tests; 7,189 pass; 0 fail; 5 skip; 0 cancelled** | `B02-node22-cd5666ff.log`: `TEST_SHARD_SUMMARY`, `Suite`, `EXIT=0`; 6,373,344 B; SHA-256 `0c2b1d8bf81f71d70aaf908c0017b53d360da4d14d75cb285158325da69239da` |
| B03 | exit 0; **97/97 specs; 862 mutations = 845 CAUGHT + 17 declared SURVIVED; 0 unexpected; 0 baseline drift; 0 untrustworthy** | `B03-mutation-sweep-cd5666ff.log`: 97 OK verdicts, normalized outcome census 845/17, `VERDICT coverage: 97/97; exit=0`; 340,449 B; SHA-256 `94477f8095bfa72a21cba88842d3d115199ba187141e1caf03bfc5898327b0a7` |
| B03 manifest | **97 discovered / 97 selected**, shard 0/1 | `B03-manifest-cd5666ff.json`; SHA-256 `160d6caa722d961af57d0964fb5ebc45e9a7fd72edeb2469e2306542adc7c2d8` |
| B03 verdicts | **97 unique OK records, all exit=0** | `B03-verdicts-cd5666ff.log`; SHA-256 `c1fcc6c78d02f83ac8873f4d04732f44fd3d377f5dd2f4bec39c1cd03268d798` |
| B04a | PASS, exit 0; **590/590 files; 7,193 tests; 7,097 pass; 0 fail; 96 skip; 0 cancelled; 5 inert files / 6 declared**; unused declaration `test/wire-byte-identity.test.js` | `B04a-windows-gate-cd5666ff.log`: runner and local-gate summaries; 3,592,991 B; SHA-256 `edbb91c39df7e2c0ea4faff5177619f6baa8a8e08b14c45024bdab1fe1751f5e` |
| B04b | exit 0; **590/590 files; 7,194 tests; 7,189 pass; 0 fail; 5 skip; 0 cancelled** | `B04b-node24-cd5666ff.log`: `TEST_SHARD_SUMMARY`, `Suite`, `EXIT=0`; 6,373,293 B; SHA-256 `5a1479686406009156879cb2f91b70f6ed2e46117fb896d4311138c33d1dc216` |
| B04c | exit 0; **270 compared / 270 expected / 270 byte-identical; 0 expected entries; 0 unexpected** | `B04c-wire-cd5666ff.tap.log`: provenance and comparison records; 12,527 B; SHA-256 `10013ffad21afa064f695f537768a337f655394357ab233a5f8917bed92a9d63` |
| B05, B01 | exit 0; **47 tests / 47 pass / 0 fail; 9 suites** | `B05-docs-guard-preB.log`; SHA-256 `59e0af36ca552c5e9a29031911349aeedf81e988b5c1f3846bb1c6b9a349857e` |
| B05, final candidate | exit 0; **47 tests / 47 pass / 0 fail; 9 suites** | `B05-docs-guard-final-0ef5067f.log`; SHA-256 `7a3889be283f03c3172f1317a903219d4931a848146b8ffbb6407a60a93cb174` |

Additional reconciliation:

- B02/B04b counted skips are exactly **4 Windows-only `icacls` + 1 unconfigured wire test**.
  `detach-soak` and `devin-connect-relogin-live` are suite-level skips with zero counted tests,
  not extra members of the five-test skip total.
- B04a separately reports PASS for spec-static, spec-baseline, secret-scan, `git diff --check`,
  and `git diff --cached --check`. Its mutation execution is intentionally skipped and supplied
  by B03.
- B04c records `tested_head=cd5666ff…`, `base_head=c60d7469…`, clean tested/base trees, and
  `tag_ref_verified:true`. The previous annotated tag peels to
  `c60d746985f0feffe5d29ff13773f4bfbdf9aa5b`.
- Static corpus recount agrees with B03: **97 JSON specs, 862 mutations, 17
  `expectCaught:false`, 845 expected catches**. The new
  `cascade-final-sweep-deadline.json` has seven arms.
- These are audits of retained logs, not fresh executions on HMC. B04c embeds the exact tested
  SHA. B02/B04b do not emit `process.version`; their Node 22.23.4/24.21.0 runtime labels are
  package attestations rather than independently recoverable version lines in those logs. This
  is not a counter mismatch.

## 3. Version and release surfaces

| Surface | Verified value / result |
|---|---|
| `package.json` | `3.141.592656` |
| `package-lock.json` | top-level and `packages[""]` versions both `3.141.592656`; lockfileVersion 3 |
| `CHANGELOG.md` | current row `v3.141.592656`; 216 release-note links/files; actual file count 216 |
| HANDOFF §0 | product tag/package version `3.141.592656`: PASS; current master SHA: **BLOCKER above** |
| Release notes | `docs/releases/RELEASE_NOTES_3.141.592656.md` exists at the exact workflow-required name |
| `docs/UNVERIFIED.md` | 216 scanned files, 88 register bullets, 2 verified, 86 still missing; release report's 88-bullet claim matches |
| New-tag state | local `git tag --list v3.141.592656` and remote tag query are empty: consistent with “no tag” |
| Prior tag | `v3.141.592655` is annotated and peels to `c60d746985f0feffe5d29ff13773f4bfbdf9aa5b` |

The release-note scope also matches Git: `v3.141.592655..12aebfcb` is **53 commits / 148 files,
18,533 insertions / 1,884 deletions**. The reported F2/F3 merge from `c62b5be7` to `12aebfcb`
contains two commits, seven files, and **+1,021 / −74**.

The CHANGELOG's “214 tags” is explicitly dated 2026-10-23, not a current-tag assertion; the
present local count of 225 is therefore not treated as a contradictory release counter.

## 4. V ledger

**PASS — exactly 27 matrix rows, V-01 through V-27, each exactly once, in order, with no duplicate
or missing ID.** Row-by-row severity comparison against the supplied
`evidence/audit/VERDICT.md` found zero mismatches:

- V-01…V-04: **4 P0**.
- V-05…V-22: **18 P1**.
- V-23…V-27: **5 P2**.
- Total: **27 = 4 + 18 + 5**.

The supplied `evidence/audit/VERDICT.md` is an untracked Owner evidence file, not a blob in the
candidate commit. The arithmetic source is nevertheless present locally and was compared row by
row; the 27-row matrix itself is tracked in the candidate.

## 5. Tag-target versus B01 source/test identity

**PASS.** `git diff --exit-code cd5666ff..0ef5067f -- src/ test/` is empty.

The complete delta contains exactly four documentation files:

1. `docs/HANDOFF-2026-10-15.md`
2. `docs/releases/ACCEPTANCE_3.141.592656.md`
3. `evidence/ACCEPTANCE-20261026.md`
4. `evidence/REQUIREMENTS-LEDGER.md`

The candidate is the direct child of B01; B01's parent is `12aebfcb`. The report's tree IDs also
match: `12aebfcb` = `2ced1a2f77225d6522e8fa78000d36dd8f74f666`, B01 =
`f6b0d50ab8eabc66eb43a64bf7f133aa878f5c49`, candidate =
`e6a5e35718a7ab06bd9d51271ec6da4921e4ad78`. `src/` at B01 also matches `c8bfbace`.
Tracked working-tree changes are absent; untracked Owner evidence/log files remain outside the
candidate tree as the report states.

## 6. Gate boundary

This decision concerns pre-tag certification only. It does **not** certify a tag, hosted release
workflow, signed assets, live upstream/LS/client behavior, real Docker/deployment, rollback, or
production go-live. B06/B07 and the disclosed `[UNVERIFIED]` boundaries remain later-phase work;
the unverified Node `>=22.13.0` floor and design-only D9 are not silently treated as certified.

**Final disposition: BLOCKED solely on the stale HANDOFF §0 master identity. No B01–B05 counter,
V-row count/severity, log size/hash, release-scope count, or source/test identity mismatch was
found.**

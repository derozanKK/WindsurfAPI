# FINAL RE-AUDIT — 9115ebe7 / 3.141.592656

**Verdict: TAG-READY (pre-tag only).** This report supersedes the target-specific BLOCKED verdict in
`GATE-RELEASE.md` and records the HONEST re-audit required by `GATE-RISK.md`. It does not certify
release assets, production deployment, live upstream behavior, or the accepted residual risks.

Audited commit: `9115ebe7183f9460df8fcce8520a0365f856ba9f`; tree
`d0fbf01aa6af3c419265ae5a52302710748c4306`. `HEAD`, `master`, and `origin/master` all resolved to
this SHA during the audit. Tracked working-tree changes were absent before and after testing;
untracked Owner evidence was retained. No tag or release was created.

## 1. Gate adjudication

| Row | Result | Evidence |
|---|---|---|
| B00a / F2 | **CLOSED for tested mechanisms** | Fresh target-tree F2/F3 run: 18/18 pass. Both final-sweep arms mark text and terminal state; stream/non-stream success, true-empty 502, and modified-text no-duplication controls passed. Red-first evidence remains `FixF2F3.md`: F2 9 tests/5 fail before fix. |
| B00b / F3 | **CLOSED for tested mechanisms; no waiver needed** | Same 18/18 run: warmup, StartCascade, Send/retry, poll remainder, recovery, and detach deadline controls passed, including fast-send and long-output controls. Red-first: 8 tests/5 fail before fix. |
| B01 | **PASS** | `package.json` and both lockfile version surfaces = `3.141.592656`; current CHANGELOG row and required release notes exist. Local and remote queries found no `v3.141.592656` tag. Prior annotated tag peels to `c60d746985f0feffe5d29ff13773f4bfbdf9aa5b`. |
| B02 | **PASS on B01; source/test-identical target** | Retained Node 22.23.4 log: 590/590 files, 7,194 tests, 7,189 pass / 0 fail / 5 skip, exit 0. Hash `0c2b1d8bf81f71d70aaf908c0017b53d360da4d14d75cb285158325da69239da` recomputed. Node version is the run attestation; the log itself does not print `process.version`. |
| B03 | **PASS on B01; source/test-identical target** | 97/97 specs OK; static recount = 862 mutations, 845 expected catches + 17 declared survivors; zero unexpected/drift/untrustworthy. Log hash `94477f8095bfa72a21cba88842d3d115199ba187141e1caf03bfc5898327b0a7`; verdicts `c1fcc6c78d02f83ac8873f4d04732f44fd3d377f5dd2f4bec39c1cd03268d798`; manifest `160d6caa722d961af57d0964fb5ebc45e9a7fd72edeb2469e2306542adc7c2d8`, all recomputed. |
| B04a | **PASS freshly on 9115ebe7** | `npm run gate` with the established six `GATE_INERT_SKIP_PATHS` declarations: 590/590 files, 7,193 tests, 7,097 pass / 0 fail / 96 skip / 0 cancelled; 5 inert / 6 declared. spec-static, spec-baseline, secret-scan, and both diff checks PASS; mutation execution is separately covered by B03. Retained `logs/B04a-windows-gate-9115ebe7.log`, 3,593,002 B, SHA-256 `885719e8f8050f7f2335d56bb4271bd569958c3762113d5aa3a6c5acd69e5e83`. |
| B04b | **PASS on B01; source/test-identical target** | Retained Node 24.21.0 log: 590/590 files, 7,194 tests, 7,189 pass / 0 fail / 5 skip, exit 0. Hash `5a1479686406009156879cb2f91b70f6ed2e46117fb896d4311138c33d1dc216` recomputed. Same runtime-attestation caveat as B02. |
| B04c | **PASS on B01; source/test-identical target** | Externally selected clean `v3.141.592655` baseline; tested tree clean; `tag_ref_verified:true`; 270 compared / 270 expected / 270 byte-identical / 0 expected or unexpected diffs. Hash `10013ffad21afa064f695f537768a337f655394357ab233a5f8917bed92a9d63` recomputed. |
| B05 | **PASS freshly on 9115ebe7** | Docs guard 47/47, 9 suites, exit 0; separate combined F2/F3 + docs + register run 72/72. Retained `logs/B05-docs-guard-final-9115ebe7.log`, 5,072 B, SHA-256 `0192d7627da3d84fd055bd3879b190ad1b491b3b4c604446db76909057152eac`. |

B01-to-target identity was directly verified with `git diff --exit-code cd5666ff..9115ebe7 -- src/
test/`: empty. Three intervening commits are documentation-only. The six-file delta is HANDOFF,
UNVERIFIED, release notes, acceptance addendum, and two historical-ledger reconciliations. Thus the
B01 product/runtime/wire/mutation evidence applies to unchanged product and test inputs; the changed
documentation inputs were rerun directly on the target.

## 2. Requirements and disclosures

- Independently counted the release acceptance matrix: **27 unique rows, V-01…V-27 exactly once,
  4 P0 + 18 P1 + 5 P2**, matching the authoritative ledger. D1–D8/D10 evidence and scoped closures
  are present; D9 remains explicitly design-only and accepted as non-blocking under the stated policy.
- HANDOFF §0 now names `0f63592d`, the direct parent whose only descendant is the disclosed §0
  backfill. This resolves the old B01/master mismatch without a self-referential SHA.
- GATE-RISK Fixes A–C are present: narrowed D/F2/F3 scope, qualified V-row closure, and the complete
  residual-P2 block (F5, S03, historical key, L1/L2, F4, ACP-1/2, Update P2-5, G5, C1, W1).
  `docs/UNVERIFIED.md` regenerates byte-for-byte and includes the new disclosures. Re-audit: **HONEST**.
- Older gate reports remain historical: their target SHAs and counters are superseded here, not
  rewritten. `ReleaseReport-3.141.592656.md` still names `0ef5067f`; this report binds the final
  target to `9115ebe7` and supplies the requested final-tree evidence.

## 3. Boundaries after tagging

- **B06 remains required before accepting/deploying assets:** create the annotated tag at this exact
  SHA, require release CI success, and independently verify every expected asset, hash, and signature.
- **B07 remains required before production go-live:** backup, verified deployment, health/model/chat
  smoke, and exercised rollback/restore. None was performed here.
- Live upstream/LS/clients, real Docker/deployment, Node `>=22.13.0` floor, D9, and disclosed P2/P3
  risks are not certified. Their acceptance/non-blocking status must not be rewritten as fixed.
- The separate `test/concurrency-stream-flow` branch is not part of this RC. Its Windows report has
  R10/R11 NOT RUN and its mutation gate NOT RUN; it is not silently counted as a green release gate.
  This lane is outside the enumerated B00–B05 pre-tag rows and does not change this scoped verdict.

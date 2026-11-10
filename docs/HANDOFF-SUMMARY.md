STATUS: DONE

> 当前一份是 [HANDOFF-2026-10-15.md](HANDOFF-2026-10-15.md) · [返回索引](README.md)。本页是 2026-10-26 的最终交接摘要，不取代活头。

# HANDOFF SUMMARY — 2026-10-26

One-page final handoff for the 2026-10-26 session. It records what was delivered, where the tree
stands, what remains open, and the exact command that verifies each claim. Historical detail stays
in the dated evidence files; this page is the index to them.

## Delivered

- **Versions.** `v3.141.592654` and `v3.141.592655` were released and deployed during the
  session; `v3.141.592656` (annotated `19ed5b8c` → `9115ebe7`) shipped with 10 assets and cosign
  verification, and was deployed to HMC. `v3.141.592657`（2026-10-26 发布，tag `v3.141.592657` → `a7d2e33f`） is the D9 patch prepared
  on top of master `f6b843fe` (release commit `5afb7ace`; certification commit `a7d2e33f`).
  `v3.141.592658`（2026-10-30 发布）is the next patch: Gemini 原生 ToolDefs 的 `type` 数组降为
  `anyOf`，加上默认关闭的签名 thinking 回放（`DEVIN_CONNECT_REPLAY_SIGNED_THINKING=1`）。发布提交
  以 `git rev-parse 'v3.141.592658^{commit}'` 为准，父提交 `18879611`（combined `release/next-pr282`
  tip，base `c5564f9a`）；逐项计数见 `docs/releases/ACCEPTANCE_3.141.592658.md`。
- **Fixes.** The second audit's 27-row V ledger is closed for its tested mechanisms (4 P0 + 18 P1
  + 5 P2), the D1–D8/D10 follow-up wave landed, F2 (final-sweep false `EMPTY_RESPONSE`) and F3
  (route budget starting after warmup/Send) are fixed with red-first tests, and the last-tick
  `cascade-turn-deadline` flake is classified as a route deadline (5 ms tolerance). D9's
  implementable controls also landed; its policy residuals are listed below.
- **Audits.** `evidence/audit2/` (Transport / Update / Server / Cascade / Docs) produced
  `FINAL-VERDICT.md`, `GATE-EVIDENCE.md`, `GATE-RISK.md` and the 9115ebe7 re-audit; `D9-GATE.md`
  separates load-bearing controls from theater and records the residual Owner-channel risk.
- **Tests.** Final-tree Windows gate **7,146 pass / 0 fail / 102 skip (593 files)**; Linux Node 24
  and Node 22 each **7,244 pass / 0 fail / 5 skip (593 files)**; wire **270/270 byte-identical,
  0 diffs** against `v3.141.592656`. B03 used the Owner-approved reduced path
  (`spec-baseline-check --all`: 97 specs, 0 drift) for the release gate; the full mutation sweep was
  run post-release: **97/97 specs, 863 mutations = 846 caught + 17 declared survivors, 0 unexpected,
  0 drift, 0 untrustworthy**. Per-run hashes are in `docs/releases/ACCEPTANCE_3.141.592657.md` §3.
- **D9 supply chain.** BannerLock (commit + per-file sha256 lock, fail-before-import, 45 workflow
  `uses:` SHA-pinned), DockerSign (cosign-signed image digest, digest-pinned deploy, `--no-build`)
  and SourceAttest (`release-attestation.json` verified before Git mutation; `warn` default,
  `required` opt-in) are implemented and covered by hermetic tests. B06 已用真实 release `40274593446` 验证：GHCR image digest
  `sha256:cd2c6b7ebbaaa909ca19ed11e1dd928b37e21706379e19534a2764d643b526a1` 的 cosign verify OK、
  `image-digest.txt` / `release-attestation.json` bundle 验证 OK、14 assets 齐全；真实 Docker daemon
  pull/recreate/rollback 仍 `[UNVERIFIED]`。
- **Documentation.** `docs/DOC-MAP.md` now covers the D9/release-gate evidence; the two READMEs,
  `docs/README.md`, `docs/ENV-SWITCHES.md` and `docs/review.html` were recounted; `CONTRIBUTING.md`
  carries the six-path Windows inert recipe. The tree has 218 release-note files and 228 git tags
  at this snapshot.

## Current state

- `v3.141.592658`（2026-10-30 发布）; source baseline = `18879611` (combined `release/next-pr282`
  tip over `c5564f9a`), release commit = the tag target (`git rev-parse 'v3.141.592658^{commit}'`).
  `v3.141.592657`（tag `v3.141.592657` → `a7d2e33f`） remains the previous release: source baseline
  `f6b843fe`, release commit `5afb7ace`, certification commit `a7d2e33f`.
- D9 is **not fully closed**: source OTA and every release signature still trust the single
  Owner's tag/account authority. `environment: release` with an independent reviewer, or an
  offline signing root, is still an Owner decision (`evidence/final/D9-GATE.md` §3).
- The live public handoff remains `docs/HANDOFF-2026-10-15.md`; this summary is archived against
  it. The machine-readable counts live in the acceptance appendix, not here.

## Open items

1. **Tag / publish / deploy `v3.141.592657`** — DONE: tag `v3.141.592657` → `a7d2e33f`;
   release CI `40274593446` success; 14 assets verified with cosign; HMC deployed 3.141.592657 with
   timestamped backup `/opt/windsurf-api.prev24-20261026T053115Z` and an exercised rollback drill.
2. **D9 policy items (Owner).** M0 (verify tag ruleset / phishing-resistant MFA / least-privilege
   tokens), an independent release approver or offline root, and the `environment: release`
   decision. Without them D9's residual risk is accepted, not eliminated.
3. **Detach default-on remains NO-GO.** HMC runs `DEVIN_CONNECT=1`, where detach is admitted only
   on Cascade flow, so the two-week gate-1 counters stay at zero; the Owner must decide whether to
   test on a Cascade-capable traffic source (`docs/DETACH-ROLLOUT.md` §2.3–2.4).
4. **Hub patches P1/P2/P3** (first-byte account switch, per-slot cap pass-through,
   `account_max_concurrent≈6`) live in the private ops tree and were not applied here.
5. **Four issue drafts remain unsent** (#149 / #272 / #236 / #273); batch external actions need
   Owner approval.
6. **Seven published commits are authored `w110`** and were not rewritten (rewriting needs a
   force-push and new SHAs).
7. **Client residuals:** C2 `reasoning.encrypted_content`, C3 `text.verbosity`, F5 custom-tool
   input streaming and #273.2 reasoning frames still need a real Devin client capture.
8. **Live/deployment boundaries:** real upstream, real LS, real Docker daemon and paid/Enterprise
   paths remain `[UNVERIFIED]`; the concurrency-hermetic R10/R11/R15 rows remain open and
   `test/concurrency-stream-flow` @ `5b42c8a3` is not merged. The `>=22.13.0` Node floor itself is
   untested (only 22.23.4 and 24.21.0 were run).
9. **P3 documentation debt:** README model-count / dual-API wording, 63 dead i18n keys and 32
   out-of-prefix env switches were explicitly deferred, not fixed.

## Verify

```bash
# Version / tag / tree identity
git rev-parse HEAD
git tag -l 'v3.141.592657'
git rev-parse 'v3.141.592657^{commit}'        # must equal a7d2e33f

# Final-tree gates (Windows PowerShell or Git Bash; 6 inert declarations)
GATE_INERT_SKIP_PATHS="test/wire-byte-identity.test.js;test/devin-connect-relogin-live.test.js;test/mutate-verify-harness.test.js;test/self-update-untracked-safety.test.js;test/detach-soak.test.js;test/detach-ls-pool-pressure.test.js" npm run gate
npm run test:release
node scripts/spec-static-check.mjs             # 97 specs / 863 mutations, anchors unique
node scripts/mutation-sweep.mjs                # POSIX host; 97/97 specs, 0 drift

# Docs
node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js
node scripts/unverified-register.mjs && git diff --exit-code -- docs/UNVERIFIED.md
git diff --check

# D9 controls
node --import ./test/setup-env.mjs --test test/banner-workflow-pins.test.js
node --import ./test/setup-env.mjs --test test/docker-self-update.test.js test/docker-oneclick-update.test.js
node --import ./test/setup-env.mjs --test test/release-attestation.test.js test/self-update-attestation.test.js
node scripts/verify-release-assets.mjs <download-dir>   # needs cosign; after the tag exists

# Evidence index
sed -n '1,120p' evidence/final/D9-GATE.md
sed -n '1,80p'  evidence/final/BannerLock.md
sed -n '1,80p'  evidence/final/DockerSign.md
sed -n '1,80p'  evidence/final/SourceAttest.md
```

**Status: DONE.** The documentation set is current for the 2026-10-26 tree; the only post-docs
gate is the tag → release CI → HMC deployment chain (B06/B07), which is owned by the release flow.

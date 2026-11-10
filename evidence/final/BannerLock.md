# BannerLock — D9 §6(c) commit-pinned, hash-verified banner generator

**STATUS: DONE.** `banner.yml` no longer executes whatever `dwgx/DWGX@main` serves at
run time. It fetches four Python files from a 40-hex commit pinned in
`repo-kit.lock.json`, verifies every byte against a per-file sha256, and writes nothing
unless all four match. The workflow wiring and the verifier's refusal path are covered by
`test/banner-workflow-pins.test.js`, written red-first.

Scope: this closes only the `banner.yml` leg of D9 §6 (`evidence/D9-TRUST-DESIGN.md`). It makes no
claim about the separate Policy T work on source OTA or Docker image signing.

- Baseline: `55a96d08` (`git rev-parse HEAD` when the change was made).
- Worktree: `D:/Project/WindsurfAPI-w18x-bannerlock` (branch `w18x-bannerlock`).
- Date: 2026-10-26.
- Files: `repo-kit.lock.json` (new), `scripts/fetch-repokit.mjs` (new),
  `.github/workflows/banner.yml` (rewritten fetch step + action pins), the other four
  workflows (action pins / read-only token), `test/banner-workflow-pins.test.js` (new),
  `.gitignore` (allowlist for the new script).

## 1. `repo-kit.lock.json`

Pinned commit: `0b44ea0168cf04654683812d6d3d7e64e5f3acf8` — the last commit in
`dwgx/DWGX` that touched any of the four generator files (2026-10-02). At verification
time `origin/main` was `978b2eb29f489022d23941a999ac8e5aa09fc233`; `git diff
0b44ea01..origin/main -- repo-kit/{build,styles,styles_ink,ink}.py` was empty, so the pin
is both content-addressed and still the current reviewed bytes.

| File | sha256 | Bytes |
|---|---|---|
| `build.py` | `8ce8898abe22f3bc2c331094442321dac2f5eabafff72335cf87224410ff2f00` | 16,190 |
| `styles.py` | `2d910c51bfb0189257d0cdde3ed01b6b598c632705d992ed7b3cc7afa6bc06cf` | 20,846 |
| `styles_ink.py` | `43352cc6a2c2c0da2e9df5a53bed4ef5ed29b1ca047a1a5ec1e3e7628bf8bdd7` | 18,665 |
| `ink.py` | `8e281003755c0289e970458304727779c29f17459d2582c929e8ab7131eab559` | 27,052 |

A live fetch from
`https://raw.githubusercontent.com/dwgx/DWGX/0b44ea0168cf04654683812d6d3d7e64e5f3acf8/repo-kit/…`
on 2026-10-26 reproduced all four hashes exactly; `python -c "import build"` from the
fetched directory printed `generator ok, theme ink`.

## 2. `scripts/fetch-repokit.mjs`

No dependencies; Node's built-in `fetch`, `crypto` and `fs/promises`. Interface:

```
node scripts/fetch-repokit.mjs --dest <dir> [--lock <file>] [--base <url|dir>]
```

- `--lock` defaults to `<repo>/repo-kit.lock.json`, independent of the caller's cwd.
- `--base` defaults to `https://raw.githubusercontent.com/dwgx/DWGX/<commit>/repo-kit`;
  tests pass a `file://` URL (or a plain directory) so they never touch the network.
- The lock must be a JSON object with a 40-hex lowercase `commit` and a `files` map naming
  **exactly** `build.py`, `styles.py`, `styles_ink.py`, `ink.py`, each a 64-hex sha256.
  A branch name, abbreviated SHA, extra file, missing file or malformed hash exits 1
  before any fetch.
- Every file is fetched and hashed **in memory**. Only after all four match does the
  script build the complete set in a fresh staging directory and replace `--dest`
  wholesale, so the destination contains exactly the four verified files — a leftover
  `tomllib.py` or `build/` package cannot shadow a stdlib import. Any failure after
  `--dest` is known removes the destination directory itself (fail closed), so a
  mismatch leaves no `build.py` and no importable `build/` package or `build.pyc` even
  when a previous run left them there.
- Any non-200, read error, missing upstream file, extra lock entry or hash mismatch exits
  1 with the failing file named on stderr. There is no `continue-on-error` and no fallback
  to `main`.

## 3. Workflow changes

`banner.yml`:

- The `curl` loop against `raw.githubusercontent.com/dwgx/DWGX/main/repo-kit` is gone.
  The step is now `fetch and verify generator`:
  `node scripts/fetch-repokit.mjs --dest /tmp/repokit`, followed by the existing
  `python -c "import … import build"` probe and then `render`. The verifier step
  precedes `render` and `commit`, and the verifier command precedes the import probe,
  so "verify → import" is mechanical.
- `contents: write` is retained because the `commit` step still pushes a bot commit.
  `star-history.yml` keeps it for its push; `release.yml` keeps it only on the `release`
  job that uploads assets. `baseline-audit.yml` was already `contents: read`; `ci.yml`
  now declares `contents: read` explicitly instead of relying on the repository default.

Every `uses:` in `.github/workflows/*.yml` is pinned to a 40-hex commit:

| Action | Pin |
|---|---|
| `actions/checkout` v5 | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` |
| `actions/checkout` v4 | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-python` v5 | `a26af69be951a213d495a4c3e4e4022e16d87065` |
| `actions/setup-node` v5 | `a0853c24544627f65ddf259abe73b1d18a591444` |
| `actions/setup-node` v4 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` v4 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `actions/upload-artifact` v6 | `b7c566a772e6b6bfb58ed0dc250532a479d7789f` |
| `actions/download-artifact` v7 | `37930b1c2abaa49bbe596cd826c3c89aef350131` |
| `docker/setup-buildx-action` v4 | `f87e5991a6d7451dcb8d9637bfbc97413f497069` |
| `docker/login-action` v4 | `81c6f93d4bc991e510b342a00b419b3bb4efc5c6` |
| `docker/metadata-action` v6 | `dc802804100637a589fabce1cb79ff13a1411302` |
| `docker/build-push-action` v7 | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` |
| `softprops/action-gh-release` v3 | `efb35369e0ad2afab669f228072c1b0d510eae64` |

`sigstore/cosign-installer` was already pinned at `6f9f17788090df1f26f669e9d70d6ae9567deba6`
(v4.1.2) and is unchanged.

## 4. Tests and evidence

Command: `node --import ./test/setup-env.mjs --test test/banner-workflow-pins.test.js`

**Red first.** The final test file, run against a `git archive HEAD` snapshot (no lock, no
verifier, unpinned workflows), failed 12/12:

```
ℹ tests 12
ℹ pass 0
ℹ fail 12
```

**Green.** After the implementation:

```
ℹ tests 12
ℹ pass 12
ℹ fail 0
```

The twelve assertions cover: lock shape (40-hex commit, exactly four 64-hex hashes);
every `uses:` in all workflows pinned to 40 hex; `banner.yml` has no
`raw.githubusercontent.com`, runs the verifier, and does so before `import build`;
matching bytes write all four files; a 206 response is refused as non-200; an extra
`tomllib.py` / `build/` package in a reused destination is removed by the wholesale
replacement; tampering the **last** file exits 1 with no `build.py` and no destination
directory (proving verification completes before the first write, not per-file); the
whole destination is removed when verification fails, including a seeded `build/`
package and `build.pyc`; `commit: "main"` exits 1 before fetching; malformed lock JSON
exits 1; a missing upstream file exits 1; an extra locked file exits 1.

Additional checks on 2026-10-26:

| Check | Result |
|---|---|
| `npm test` (full suite in this worktree) | 7,206 tests: 7,109 pass, 0 fail, 97 skipped |
| `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | 47/47 pass |
| `test/release-workflow.test.js` + `test/release-signing.test.js` + `test/local-gate.test.js` | 29 pass, 2 POSIX-only skips, 0 fail |
| `node scripts/spec-static-check.mjs` | 97 specs / 863 mutations, anchors unique |
| `node scripts/secret-scan.mjs` | exit 0 |
| `git diff --check` | exit 0 |
| live `fetch-repokit.mjs --dest <temp>` against the pinned commit | exit 0, four hashes match §1 |

## 5. Residual boundaries

- **`[UNVERIFIED]` GitHub runs `banner.yml` exactly as written.** The test is hermetic and
  proves the file's ordering and the script's refusal behaviour; it cannot observe a
  hosted runner. D9 §6.3's rollout still applies: the first post-merge run must be a
  watched `workflow_dispatch`.
- **Lock updates are reviewed source changes.** A legitimate upstream generator change
  requires updating `repo-kit.lock.json` (commit + hashes) in a normal PR; the workflow
  will keep failing closed until it does.
- **Only §6(c) is covered here.** Source OTA attestation and image/helper digest signing
  are separate Policy T surfaces; nothing in this document verifies them.

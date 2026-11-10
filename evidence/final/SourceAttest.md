# D9 — Source OTA attestation

Status: **implemented; targeted suites green; full suite 7,124 pass / 0 fail.**
Date: 2026-10-26. Worktree: `D:/Project/WindsurfAPI-w18x-sourceattest`,
branch `w18x-sourceattest` at commit `cbb7a781`, based on HEAD `55a96d08`. This is a dedicated worktree;
the shared tree carries other D9 slices (banner lock, Docker digest) and was not used
for the full-suite run.

## 1. What this slice adds

| # | Deliverable | File |
|---|---|---|
| 1 | Release attestation generator (tag, commit, tree, asset SHA-256s) and cosign `sign-blob` in the release job; both files attached to the GitHub Release; release job also attaches DockerSign's `image-digest` artifact (`image-digest.txt` + bundle) | `.github/workflows/release.yml`, `scripts/generate-release-attestation.mjs` |
| 2 | Shared verifier: parse/validate the statement, require tag/commit equality, verify the `.sigstore.json` bundle with the pinned release identity | `src/release-attestation.js`, `scripts/verify-release-attestation.mjs` |
| 3 | Dashboard `/self-update` selection gate before any mutation target is returned | `src/dashboard/api.js` (`verifySelectedReleaseAttestation`, called from `releaseUpdateState`) |
| 4 | `update.sh` gate before stash/reset/merge/restart | `update.sh` |
| 5 | Hermetic tests (red first) | `test/release-attestation.test.js`, `test/self-update-attestation.test.js`, `test/release-workflow.test.js` |
| 6 | Documented switch and trust boundary | `.env.example`, `docs/ENV-SWITCHES.md`, `docs/RELEASE-SIGNING.md`, `README.md`, `README.en.md` |

The attestation is deliberately **additive**: it is a new release asset, not a new
key or secret. No on-disk format, database, or service state is migrated.

## 2. Attestation format

`release-attestation.json` is canonical JSON (fixed field order, asset names sorted)
so the same bytes produce the same signature payload:

```json
{
  "schema": 1,
  "repository": "dwgx/WindsurfAPI",
  "tag": "v3.141.592656",
  "commit": "<40/64-hex commit the tag peels to>",
  "tree": "<40/64-hex tree of that commit>",
  "assets": {
    "SHA256SUMS": "<64-hex>",
    "windsurfapi-macos-arm64": "<64-hex>",
    "windsurfapi-macos.zip": "<64-hex>",
    "windsurfapi-windows.zip": "<64-hex>",
    "windsurfapi.exe": "<64-hex>"
  }
}
```

`release-attestation.json.sigstore.json` is the cosign bundle produced by
`cosign sign-blob --bundle …`. The signer is the same keyless workflow identity
already pinned by `scripts/verify-release-assets.mjs`:

- identity regexp: `^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$`
- issuer: `https://token.actions.githubusercontent.com`

The release job signs the attestation **after** `SHA256SUMS` exists and **before**
`softprops/action-gh-release` uploads the assets. `SHA256SUMS` stays the last entry
in the `files:` block, so the existing manifest tests keep their anchor.

## 3. Verification policy

Both surfaces call the same module (`src/release-attestation.js`):

| Condition | `warn` (default) | `required` |
|---|---|---|
| Attestation present, tag/commit match, bundle verifies | proceed (`verified`) | proceed (`verified`) |
| Attestation present, tag or commit **mismatch** | **refuse** (`ERR_RELEASE_ATTESTATION_MISMATCH`) | **refuse** |
| Attestation present, bundle present, cosign exits non-zero | **refuse** (`ERR_RELEASE_ATTESTATION_INVALID`) | **refuse** |
| Attestation present, bundle missing | warn (`unsigned`), commit binding still enforced | **refuse** (`ERR_RELEASE_ATTESTATION_UNSIGNED`) |
| Attestation missing / fetch 404 / network failure | warn (`missing` / `unavailable`), update proceeds | **refuse** (`ERR_RELEASE_ATTESTATION_MISSING` / `UNAVAILABLE`) |
| cosign binary missing (`ENOENT`) | warn (`cosign-unavailable`), update proceeds | **refuse** (`ERR_COSIGN_UNAVAILABLE`) |
| Invalid `WINDSURFAPI_UPDATE_ATTESTATION` value | refuse (`ERR_RELEASE_ATTESTATION_MODE`) | refuse |

The switch is `WINDSURFAPI_UPDATE_ATTESTATION` (`warn` default, `required` opt-in).
`WINDSURFAPI_ATTESTATION_DIR` optionally points at a pre-staged directory holding
both files (air-gapped hosts / forks). The dashboard only downloads from the
canonical `dwgx/WindsurfAPI` release when `git remote get-url origin` parses to that
repository; every other origin is treated as "no attestation available" and follows
the mode above. A present-but-invalid attestation is never downgraded to a warning.

### Dashboard (`src/dashboard/api.js`)

`releaseUpdateState()` calls `verifySelectedReleaseAttestation(release)` immediately
after `latestReleaseTag()` has materialized the tag object and proven it is an
ancestor of `origin/<branch>`. The verified `release.commit` is the same value that
becomes `releasedCommit` / `targetCommit`; no second resolution is performed. A
throw propagates out of `releaseUpdateState()`:
- `/self-update/check` returns `{ok:false, error: <code>}` (existing failure shape);
- `POST /self-update` returns `{ok:false, error: <code>, message}` before the
  rollback point is written, before `merge --ff-only` / `reset --hard`, and before
  any restart is scheduled.

### `update.sh`

The script resolves the release tag exactly as before, computes
`MUTATION_TARGET`, then runs:

```bash
node scripts/verify-release-attestation.mjs --tag "$LATEST_TAG" \
  --commit "$RELEASE_COMMIT" --mode "$ATTESTATION_MODE" ...
```

before the stash / `reset --hard` / `merge --ff-only` block and before `[2/5]`
(service stop). A non-zero verifier exit is fatal. In `warn` mode a missing
verifier or `node` logs a warning and continues; in `required` mode it refuses.
`WINDSURFAPI_UPDATE_FORCE=1` (the existing explicit untagged-head escape hatch)
skips the tag check because it does not install a tag.

## 4. Red first

The test files were written before `src/release-attestation.js` existed. Both
targeted runs failed at module resolution (the new production module was absent):

```
$ node --import ./test/setup-env.mjs --test test/release-attestation.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/release-attestation.js'
ℹ tests 1  ℹ pass 0  ℹ fail 1

$ node --import ./test/setup-env.mjs --test test/self-update-attestation.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/release-attestation.js'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

Full logs: `evidence/final/SourceAttest/red-unit.log` and `red-api.log`. These
were captured before the change was moved to the dedicated worktree, so the log
paths name the original checkout; the test files are identical.
After the module and gates were implemented the same files pass (below). The
mutation of the gate itself is covered by the mismatch/unsigned/invalid arms: each
arm asserts that the fake git argv log contains **no** `merge --ff-only` and **no**
`reset --hard`, and that no rollback point was written.

## 5. Green — targeted

Windows Node v24.19.0:

| Command | Result |
|---|---|
| `node --import ./test/setup-env.mjs --test test/release-attestation.test.js` | 20 tests, 19 pass, 0 fail, 1 POSIX-only skip |
| `node --import ./test/setup-env.mjs --test test/self-update-attestation.test.js` | 11 tests, 6 pass, 0 fail, 5 POSIX-only skips |
| `node --import ./test/setup-env.mjs --test test/release-workflow.test.js test/release-signing.test.js` | 47 tests, 44 pass, 0 fail, 3 POSIX-only skips |
| `node --import ./test/setup-env.mjs --test test/self-update-gate.test.js` | 66 tests, 63 pass, 0 fail, 3 skips |
| `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | 47 pass, 0 fail |

WSL2 Linux Node v24.21.0 (POSIX arms actually execute):

| Command | Result |
|---|---|
| `node --import ./test/setup-env.mjs --test test/release-attestation.test.js` | **20 tests, 20 pass, 0 fail, 0 skip** (real cosign spawn arm included) |
| `node --import ./test/setup-env.mjs --test test/self-update-attestation.test.js` | **11 tests, 11 pass, 0 fail, 0 skip** (5 real-Git `update.sh` arms included) |
| `node --import ./test/setup-env.mjs --test test/update-script-release-target.test.js` | **47 tests, 47 pass, 0 fail** (existing `update.sh` behavior unchanged) |

The WSL `update.sh` arms prove, against a real temporary origin/checkout:

1. matching signed attestation → update proceeds, `HEAD == release commit`;
2. mismatched attested commit → exits non-zero before `[2/5]`, `HEAD` stays at the
   before-commit;
3. missing attestation + `required` → exits non-zero before `[2/5]`, `HEAD` unchanged;
4. missing attestation + `warn` → exits 0, warning printed, update reaches the
   release commit;
5. bad cosign signature + `required` → exits non-zero before `[2/5]`, `HEAD` unchanged.

## 6. Green — full suite

Command (Windows Node v24.19.0, dedicated worktree, `npm run test:release` =
`node scripts/run-test-shard.mjs 0 1`):

```
cd D:/Project/WindsurfAPI-w18x-sourceattest
npm run test:release
```

Result: **592/592 files measured, 7,227 tests, 7,124 pass, 0 fail, 103 skip,
exit 0.** Full log: `evidence/final/SourceAttest/full-suite-win.log`. The 103 skips are the documented Windows unix-git/live-fixture skips
(96 baseline + 7 POSIX-only arms added by this slice: the real-cosign spawn in
`release-attestation.test.js` and the five real-Git `update.sh` arms plus one
`release-signing` POSIX arm).

A WSL2 run was also attempted against this worktree, but Git refuses the
Windows-created `.git` worktree pointer (`gitdir: D:/Project/...`) when the
checkout is read through `/mnt/d`; the resulting 14 failures were all
`fatal: not a git repository` from that path mismatch, not product assertions.
The POSIX arms that matter were run separately in WSL (section 5) and are green.

## 7. What this does and does not prove

**Proves:** the release workflow emits a signed statement binding the tag to the
peeled commit, tree and asset bytes; the dashboard and `update.sh` refuse a
present-but-mismatched attestation before any Git mutation; a missing attestation
is fatal only in `required` mode; and the default `warn` path keeps an existing
install updating. All negative arms are hermetic (fake git argv log + fake cosign;
no network, no registry).

**Does not prove:** that a real Fulcio certificate validates against the Sigstore
TUF root — that is cosign's own tested path (`test/release-signing.test.js`) and is
`[UNVERIFIED]` until the first real tag release. It also does not prove human
approval: the Fulcio SAN is minted from `job_workflow_ref`, so anyone who can push a
`v*` tag can obtain a validly signed attestation. Tag protection and a review-gated
release environment are the separate controls that make that a two-step attack.

**Rollout:** the default is `warn`, so installing this release does not require
cosign on existing hosts. Operators who want enforcement set
`WINDSURFAPI_UPDATE_ATTESTATION=required` (or `--mode required` for the CLI) after
staging the attestation or installing cosign. **Rollback:** revert the commit that
adds `src/release-attestation.js` and the two call sites; attestations are additive
release assets, so there is no state to unwind.

## 8. Manual verification

```bash
# From a release download directory:
cosign verify-blob \
  --bundle release-attestation.json.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  release-attestation.json

# Verify the statement against the tag/commit you intend to install:
node scripts/verify-release-attestation.mjs \
  --tag v3.141.592656 \
  --commit "$(git rev-parse 'v3.141.592656^{commit}')" \
  --dir /path/to/download \
  --mode required

# Inspect the recorded asset hashes:
node -e 'const a=require("./release-attestation.json"); console.log(a.tag, a.commit, a.tree, a.assets)'
```

STATUS: DONE

# D9 — One trust policy for OTA and CI-executed code

Baseline: `2598299e58e291493984de988f7281dccff43e3d` (`git rev-parse HEAD`, verified).
Design only: **no product, test, or workflow file was edited for this document.** Every line number
below was read on that commit. Claims about upstream behaviour (Docker Engine API, Fulcio, cosign)
are cited to a primary source and are not executed here; they are marked where they matter.

**The question, in one line.** What exact reviewed digest / signature / workflow identity authorises
code that OTA or CI executes, and is that same identity checked *before* the privileged operation?

**A satisfying answer** is a single policy that (i) names the verification point per surface,
(ii) names what happens when verification fails, (iii) has a rollout that does not brick an existing
install, and (iv) has a hermetic test that fails if an unsigned artifact can still reach
`git merge` / `docker containers/create` / `python build.py`.

---

## 1. What is verified today

| Surface | Trust anchor today | Cryptographic check before the privileged call | Evidence |
|---|---|---|---|
| Source OTA (dashboard `/self-update`) | "whoever can push a `v*` tag to `origin`" + TLS + the configured remote | **none** | `src/dashboard/api.js:4455-4475` selects by `ls-remote`; `:4419-4443` proves object↔peeled correspondence; `:4445-4453` proves ancestry; `:1731` then `git merge --ff-only` |
| Source OTA (shell) | identical | **none** | `update.sh:402-540` same selection; `:618` `git reset --hard`; `:630` `git merge --ff-only` |
| Docker OTA (dashboard one-click) | "whoever can push to GHCR" + the *mutable tag the running container was created from* | **none** — pull by tag, no digest, no signature | `src/dashboard/docker-self-update.js:272` (`fromImage=${encodeURIComponent(image)}`), `:34` (`docker:24-cli`), `:489-510` (deployer with `docker.sock`) |
| Docker OTA (shell) | `--tag`/`--image`, default `:latest` | **none** | `deploy/update.sh:521` restores by image ID on failure, but the *new* image is pulled by tag |
| Release **assets** | cosign keyless, GitHub OIDC | **yes**, but only when a human runs `scripts/verify-release-assets.mjs` | `.github/workflows/release.yml:407-448`; `scripts/verify-release-assets.mjs`; `docs/RELEASE-SIGNING.md` |
| Release **image** | — | **none; the image is never signed** | `release.yml:73-80` — the `docker` job has `contents: read`, `packages: write`, and no `id-token: write`, so it cannot obtain a Fulcio certificate at all |
| CI executing fetched code (`banner.yml`) | whatever is at `dwgx/DWGX@main` **at run time**, executed with `contents: write` | **none** | `banner.yml:43` (`.../main/repo-kit`), `:44-46` (`curl`), `:51` (`import build`), `:72` (`git push`), `:23` (`contents: write`) |

The asymmetry is the finding: the project already has a working keyless-signing pipeline and a
verifier for the artifacts that **nothing installs automatically**, and has **no** signature at all on
the three paths that do install automatically. `docs/RELEASE-SIGNING.md` says this out loud
("These paths do not download GitHub Release assets, so the cosign signatures do not cover them")
and the audit's P2-1/P2-2/P2-4 are the consequence.

A repo-wide grep for `verify-tag|verify-commit|allowedSigners|gpg-format` across `*.js|*.mjs|*.sh|*.yml`
(excluding `.agent/`, `evidence/`, `.claude/`) returns **zero hits**: no tag signature has ever been
checked, and there is no allowed-signers file to check one against.

---

## 2. The three candidate mechanisms, compared

### 2.1 Signed tag verification with a pinned key (GPG or SSH signing)

`git verify-tag --raw <tag>` against a reviewed `release-allowed-signers` file, at
`latestReleaseTag()` and in `update.sh` before the merge.

- **Covers:** source OTA only. Says nothing about the image and nothing about `banner.yml`.
- **New trust material:** a signing key plus its public half, which must reach every deployment
  *before* the first enforced update. There is no mechanism in the tree today to ship or rotate it.
- **Failure mode:** fail-closed on a host that lacks the key. That is every existing installation on
  the day the check lands, which is exactly why `docs/RELEASE-SIGNING.md` recorded it as "intentionally
  not wired".
- **What it adds over cosign:** verification does not depend on Sigstore/Fulcio/Rekor availability,
  and the anchor is a key a human holds rather than an OIDC identity a workflow can mint.
- **What it does not add:** protection against a compromised maintainer account that can push a tag
  *and* hold the key. Same limitation as cosign.

### 2.2 cosign keyless (the mechanism already in the tree)

- **Covers:** source OTA (via a signed statement binding tag→commit), docker OTA (image signed by
  digest), and it is already the anchor for release assets.
- **Identity is already pinned and already tested.** `scripts/verify-release-assets.mjs`
  (`DEFAULT_IDENTITY_REGEXP`, `DEFAULT_OIDC_ISSUER`) and `test/release-signing.test.js` fail if the
  script and `docs/RELEASE-SIGNING.md` drift. Adding a second artifact type reuses the same SAN.
- **New trust material:** none. No key, no secret, no distribution step.
- **Cost:** a `cosign` binary at each *verification* point (single static binary; `runCosignCommand`
  already supports an explicit path and returns a typed error on `ENOENT`).
- **Critical property to state plainly:** the SAN is built from the OIDC `job_workflow_ref` claim —
  sigstore/Fulcio documents this as "GitHub Actions uses the `job_workflow_ref` as its SAN"
  (`sigstore/fulcio/docs/oidc.md`, "Case study: GitHub Actions"). For this repo that yields exactly
  `https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/vX.Y.Z`, which is the
  string already in `docs/RELEASE-SIGNING.md`. **Consequence:** anyone who can push a `v*` tag can
  obtain a *validly signed* artifact. The signature attests "this workflow ran on this tag", not
  "a human approved". `docs/RELEASE-SIGNING.md` already says this. A signature policy that does not
  also gate *who can mint the identity* therefore buys provenance, not authorisation.
  `[INFERENCE]` Adding `environment: release` does not change that SAN (an environment changes the
  `sub` claim, not `job_workflow_ref`), so the identity string operators pin stays stable while the
  ability to mint it becomes approval-gated. That is the property the design leans on.

### 2.3 Pinned workflow SHAs

- **Covers:** `banner.yml` (the fetched generator) and, as a side effect, every action used by CI and
  release (`P3-8`). Does **not** cover OTA at all.
- **New trust material:** none — a commit SHA is content-addressed; a `sha256` in a reviewed lock file
  is the integrity check on top.
- **Cost:** a Dependabot/renovate loop to keep ~40 `uses:` references current. No operator action,
  no runtime dependency, no failure mode for existing installs.

### 2.4 Scorecard

| Criterion | GPG tag + pinned key | cosign keyless | Pinned SHAs |
|---|---|---|---|
| Source OTA | yes | yes (attestation) | no |
| Docker OTA | no | yes (image + digest) | helper image only |
| CI fetched code | no | no | yes |
| New long-lived secret | **yes** | no | no |
| Must reach every install before it works | **yes** | no (boundary-gated) | no |
| Breaks an existing install on day 1 | **yes** | no, with an operator-pin escape | no |
| New runtime dependency | gpg (usually present) | cosign (not present today) | none |
| Reuses something already pinned + tested here | no | **yes** | no |
| Blast radius (1 = smallest) | 5 | 3 | 1 |
| Can it be combined with the others? | mutually exclusive with 2.2 for the source path | — | yes, orthogonal |

`gpg` is usually installed; `cosign` is not. That is the one real cost of 2.2 and it is why the
policy below keeps a human-pinned fallback.

---

## 3. Recommended policy — **Policy T: "no mutable reference is an execution target"**

> **An OTA or CI action may only target an immutable content address, and that address is authorised
> either by a cosign bundle from the pinned release identity or by the operator supplying it verbatim.
> A tag, a branch, and `latest` are lookup keys, never targets.**

Four rules, each mechanically checkable:

| # | Rule | Applies to |
|---|---|---|
| **T1** | The execution target is a content address: 40-hex commit SHA (source), `sha256:` manifest digest (image), commit SHA + file `sha256` (fetched CI code). | a, b, c |
| **T2** | The address is authorised by exactly one of: **(attested)** a cosign bundle whose identity matches `^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$` with issuer `https://token.actions.githubusercontent.com`, and whose signed statement names that same address; or **(operator-pinned)** the address appears verbatim in the operator's invocation or in reviewed source. | a, b |
| **T3** | Missing verification material is a refusal, never a fallback. No environment variable disables verification for a release above the boundary. | a, b, c |
| **T4** | Only an approval-gated job can mint the identity: `environment: release` with required reviewers on the job that signs, plus a tag ruleset so only the Owner can create `v*`. | a, b |

**Why this is the smallest blast radius.** It introduces no key, no secret, and no distribution step
(against 2.1). It reuses an identity, a regexp, a verifier and a test that already exist and are
already kept in sync by `test/release-signing.test.js`. It is boundary-gated so the *current* upgrade
still works on every existing install, and it keeps an operator-pinned escape hatch for air-gapped
hosts, forks, and self-hosted git origins — the escape hatch is a human decision, not a bypass switch.
Only the `banner.yml` half (2.3) is inert: no runtime, no operator action, no failure mode.

Policy T is 2.2 + 2.3, so its blast radius is **3**, the cosign item; the SHA half is **1** and adds no
new failure mode. GPG scores **5** for one of the three surfaces. If the Owner rejects the cosign half
outright, the policy degrades to 2.3 alone (radius 1) and closes only `banner.yml` — which is a real,
defensible outcome, but it leaves P2-1/P2-2 exactly as they are.

**Why not GPG.** It solves one of the three surfaces, adds a key that must be distributed to every
deployment before the first enforced update, and buys nothing against the threat that actually
matters most (a compromised maintainer account, which can hold the key too). Its one genuine
advantage — no dependency on Sigstore — is not worth bricking every existing install.

**What Policy T does not stop, stated up front.** A compromised maintainer account that can push a
`v*` tag *and* approve the `release` environment deployment. No signature scheme in this list stops
that; only T4 makes it a two-step attack with a human in it, and only tag protection + environment
review make it visible. Reproducible-build substitution is also out of scope: the signature covers the
bytes produced, not their correspondence to the source tree.

---

## 4. (a) Source OTA

### 4.1 Exact verification point

**Point A1 — selection.** In `latestReleaseTag()` (`src/dashboard/api.js:4455`), after
`materializeRemoteReleaseTag()` (`:4419`) and the ancestry check (`:4445`), and before the candidate is
returned as the update target. A new `verifyReleaseAttestation({ tag, commit, originUrl, cosign })`
decides:

```
originUrl is not github.com/dwgx/WindsurfAPI  → operator-pinned only:
    WINDSURFAPI_UPDATE_COMMIT === commit ? ok : ERR_RELEASE_UNATTESTED
canonical origin → fetch (or read a pre-staged) release-attestation.json + .sigstore.json for `tag`
    → run cosign verify-blob --bundle … --certificate-identity-regexp <pinned> --certificate-oidc-issuer <pinned>
    → parse statement, require:
         statement.tag         === tag
         statement.commit      === commit            (the peeled commit, not the tag object)
         statement.workflow_ref === dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/<tag>
         statement.repository  === dwgx/WindsurfAPI
    → ok
```

The attestation is a new release asset produced by the workflow that already signs five blobs:
`release.yml:415-448` gains one entry in its `for f in …` loop and one line in `files:`
(`:458-466`). The statement is canonical JSON — no new signature mechanism, no new verifier.

**Point A2 — the mutation.** `src/dashboard/api.js:1731` (`git merge --ff-only targetState.targetCommit`)
and `:1729` (`git reset --hard resetTarget`); `update.sh:618` / `:630`. The mutation consumes the
*verified* commit and adds one assertion before the call:

```js
if (targetCommit !== verifiedCommit) throw makeSelfUpdateError(ERR_RELEASE_ATTESTATION_MISMATCH, …);
```

No second network call, no new window: the attestation is bound to `(tag, commit)` and the mutation
targets `commit`; the existing object↔peeled re-check at `:4426-4440` already closes the fetch race.
`update.sh` gets the same check as a one-shot `node scripts/verify-release-attestation.mjs --tag …
--commit … --dir …` before `[2/5]`.

### 4.2 Failure behaviour

| Condition | Code | What happens |
|---|---|---|
| No bundle, fork/self-hosted origin with no operator pin | `ERR_RELEASE_UNATTESTED` | HTTP 200 `{ok:false, error, message}` (the existing failure contract, `api.js:1884-1888`); no mutation; no rollback point written; `mutationLockHandedOff` stays `false` so the lock is released |
| `cosign` absent (`ENOENT`) | `ERR_COSIGN_UNAVAILABLE` | same; message names the install URL and `--cosign` |
| cosign exits non-zero | `ERR_RELEASE_ATTESTATION_INVALID` | same |
| Statement names another tag/commit/workflow | `ERR_RELEASE_ATTESTATION_MISMATCH` | same |
| Attestation fetch fails (network) | `ERR_RELEASE_ATTESTATION_UNAVAILABLE` | same — **not** a silent downgrade to the unsigned path |

`/self-update/check` reports the same code, so the UI must not offer "Update" as available.
`update.sh` exits `1` before any fetch beyond the tag object and prints the exact
`cosign verify-blob` command the operator can run by hand.

The response shape already exists (`api.js:1884-1891` returns `{ok:false, error, message}`), so no
client contract changes.

### 4.3 Rollout and rollback

1. **Release N** publishes `release-attestation.json` + `.sigstore.json` and ships
   `verifyReleaseAttestation` with a hardcoded `ATTESTED_FROM = 'vN'`.
2. `compareStableReleaseTags(tag, ATTESTED_FROM) <= 0` → **legacy path, unchanged**: an install on any
   older release can still install `vN` without cosign. Nothing breaks.
3. `> ATTESTED_FROM` → attested or operator-pinned only. The first verified hop is therefore
   `vN → vN+1`, and every hop after it is verified. This is the whole reason the boundary is a
   constant in code and not an operator setting: an operator-settable boundary is a downgrade switch.
4. Operator-pinned form for forks and air-gapped hosts: `WINDSURFAPI_UPDATE_COMMIT=<40hex>` (new),
   checked against the selected tag's peeled commit. It is *not* a bypass — the human chose the SHA.

**Rollback of the policy itself:** revert the commit that adds `verifyReleaseAttestation` and the
`ATTESTED_FROM` constant. Attestations are additive release assets; there is no state to migrate and
no on-disk format to unwind. A policy regression is therefore a one-commit revert, which is the
property that makes this cheap to try.

### 4.4 Hermetic test — `test/self-update-attestation.test.js` (new)

Built on the seams that already exist in `test/self-update-gate.test.js`: `setGitExecFileForTest`
(`:103`), `setRollbackPointWriterForTest`, `setSelfUpdateRestartSchedulerForTest`,
`setSelfUpdateSupervisorDetectorForTest`, plus a new `setReleaseAttestationVerifierForTest` mirroring
`setDockerSelfUpdateForTest`. A fake `cosign` executable in a temp dir (the pattern
`test/release-signing.test.js` already uses) provides the real `spawnSync` path; no network.

**Red arms — the property under test is "unsigned cannot reach merge":**

1. no bundle present → `ok:false` / `ERR_RELEASE_UNATTESTED`, and the fake git argv log contains
   **no** `merge --ff-only` and **no** `reset --hard`;
2. bundle signed for a different commit → `ERR_RELEASE_ATTESTATION_MISMATCH`, same argv assertion;
3. fake cosign exits 1 → `ERR_RELEASE_ATTESTATION_INVALID`, same argv assertion;
4. fake cosign absent from `PATH` → `ERR_COSIGN_UNAVAILABLE`, same argv assertion;
5. in every red arm: `rollbackPointWriter` was never called, `restartScheduler` was never called, and
   `git rev-parse HEAD` is unchanged.

**Green control (proves the gate is not a blanket refusal):** a fake cosign that exits 0 plus a
statement whose `tag`/`commit` match → `ok:true` and the merge argv contains exactly the verified SHA.

**Boundary control:** tag `vN` (at/below `ATTESTED_FROM`) with no bundle → `ok:true`, legacy path.
This is the arm that proves the rollout does not brick old installs.

What this test does **not** prove: that a real Fulcio certificate validates. That is cosign's job and
is covered by `test/release-signing.test.js` for blobs; an end-to-end `cosign verify-blob` against a
recorded fixture bundle needs the TUF root and is marked `[UNVERIFIED]` here.

Gate: `node --import ./test/setup-env.mjs --test test/self-update-attestation.test.js`

---

## 5. (b) Docker OTA

Two artifacts execute here, and today neither is addressed by content:

- the **app image**, pulled by whatever tag the running container was created from
  (`docker-self-update.js:272`, `docker-compose.yml:10` default `:latest`);
- the **deployer helper** `docker:24-cli` (`docker-self-update.js:34`), run with the host
  `docker.sock` mounted (`:505-508`) — i.e. host root.

### 5.1 Exact verification points

**Point B1 — resolve, don't pull.** Before `/images/create`, resolve the tag to a digest through the
daemon's registry-metadata endpoint: `GET /distribution/<repo>:<tag>/json` returns
`{Descriptor:{digest}}` without downloading layers. Moby's `client.DistributionInspect` puts the whole
reference in the path (`"/distribution/"+imageRef+"/json"`) and sends no query parameters, so the tag
belongs in the path segment, not in `?tag=`. The tag is now only a lookup key.

**Point B2 — authorise the digest**, before any pull:

```
attested:      read image-digest.txt + .sigstore.json for the selected release
               cosign verify-blob with the same pinned identity/issuer
               require statement.digest === resolvedDigest
operator-pin:  WINDSURFAPI_IMAGE / --image literally contains "@sha256:<64hex>"
otherwise:     refuse
```

**Point B3 — pull by digest, in the API's own shape.** `dockerPull()` must emit
`fromImage=<repo-name>&tag=sha256:<64hex>`. Moby's client documents the reason verbatim:
"the docker 'server' api expects digests to be sent as tags" (`client/image_pull.go`,
`getAPITagFromNamedRef`). Sending `fromImage=repo@sha256:…` is **not** the API's shape and must not be
assumed to work. After the pull, re-read the image (`GET /images/<ref>/json`) and require
`RepoDigests` to contain the requested digest — a mirror that serves different bytes for a digest
fails here.

**Point B4 — the deployer.** `DEPLOYER_IMAGE` becomes `docker:24-cli@sha256:<digest>` (reviewed
constant, updated only by a commit), and the deployer command at `:491-497` gains `--no-build`.

> `--no-build` is not cosmetic. `docker-compose.yml:11-19` defines `build:` for the app service, and
> the deployer currently runs a bare `docker compose … up -d` (`:491-497`). If the pinned image is not
> present locally, Compose can **build from the checkout on disk** — executing source that no policy
> in this document has looked at. `deploy/update.sh` already uses `--no-build` everywhere
> (`:521`, `:636-697`); the in-container path is the one that forgot.

**Point B5 — before create.** `POST /containers/create` (`:489`) is reached only after B1–B3 succeed.

### 5.2 Failure behaviour

| Condition | `reason` | What happens |
|---|---|---|
| Ref has no digest and no attestation | `image-mutable-ref` | `{ok:false}`, no pull, no create, running container untouched, lock released |
| Resolved digest ≠ attested digest | `image-digest-mismatch` | same; the mismatch is logged with both digests |
| cosign absent / non-zero | `cosign-unavailable` / `image-unattested` | same |
| Pull returns a terminal record but `RepoDigests` lacks the digest | `image-digest-unconfirmed` | same |
| Deployer image ref is not digest-pinned | `deployer-unpinned` | same (a source-invariant check; should be unreachable) |

The route already returns `{mode:'docker', ...result}` (`api.js:1870-1875`), so `ok:false` reaches the
UI without a contract change. The eight-second deployer window is never opened on failure.

### 5.3 Rollout and rollback

1. **Release N:** `release.yml` `docker` job gains `id: build` on the build step (`:123`), a
   `cosign sign --yes ghcr.io/dwgx/windsurf-api@${{ steps.build.outputs.digest }}` step, and
   `id-token: write` in its `permissions` block (`:78-80`). The digest output is a documented output of
   `docker/build-push-action` (`outputs: imageid, digest, metadata`); the step has no `id:` today, so
   one must be added. Publish `image-digest.txt` + `.sigstore.json` next to `SHA256SUMS`.
2. **Release N+1** ships B1–B5 with the same `ATTESTED_FROM` boundary. Operators on `:latest` keep the
   one-click UX: `latest` is resolved to a digest and then checked against the signed digest. Operators
   who cannot reach GitHub pin `WINDSURFAPI_IMAGE=repo@sha256:…` and skip the attestation step.
3. `deploy/update.sh` keeps `--tag` but resolves it to a digest with
   `docker buildx imagetools inspect` and verifies; `--image` must be digest-pinned. `--tag latest`
   becomes an error with the digest hint.

**Rollback:** `deploy/update.sh --rollback` restores by **image ID** (`restore_image`, `:512-527`;
`read_rollback_point` at `:327-333` already validates `^sha256:[0-9a-fA-F]{64}$`), which is
content-addressed and unaffected by this policy.
Reverting the code restores tag pulls; no state migration.

### 5.4 Hermetic test

**`test/docker-self-update.test.js` (extend — injected `request`/`pull`, no daemon):**

1. tag-only ref → `pull` is **never** called and `POST /containers/create` count is `0`;
2. `GET /distribution/.../json` returns digest D1, attestation names D2 → `reason:'image-digest-mismatch'`,
   create count `0`;
3. fake cosign exit 1 → `reason:'image-unattested'`, create count `0`;
4. **control:** D1 attested → `pull` receives the digest form, `/images/create` path matches
   `/fromImage=[^&]+&tag=sha256%3A[0-9a-f]{64}$/`, create is called with `Image` = the digest ref and
   the compose `Cmd` contains `--no-build`;
5. static source invariants (the file already reads `MOD`/`API` as text): `DEPLOYER_IMAGE` matches
   `/@sha256:[0-9a-f]{64}$/`, and the deployer `Cmd` string contains `--no-build`.

**`test/docker-oneclick-update.test.js` (extend — real `deploy/update.sh`, fake `docker`/`cosign` on
`PATH`, POSIX only, same harness that already runs the script against a fake daemon):**

6. fake `docker` reports `--tag latest` → script exits non-zero, no `compose up`, no `docker tag`;
7. fake `cosign` exit 1 with a digest pin → same refusal;
8. **control:** digest pin + fake cosign exit 0 → the fake docker log shows `pull repo@sha256:…` followed
   by `compose up -d --no-deps --no-build --force-recreate`, then the `/health` probe.

Gates: `node --import ./test/setup-env.mjs --test test/docker-self-update.test.js` and
`node --import ./test/setup-env.mjs --test test/docker-oneclick-update.test.js`.

---

## 6. (c) CI executing fetched code — `banner.yml`

### 6.1 Exact verification point

Today: `banner.yml:43-51` fetches four `.py` files from `dwgx/DWGX@main` and **imports one of them**
with `contents: write` (`:23`) and a `git push` (`:72`). The mutable branch is the whole vulnerability:
a push to the *other* repository is a push to this one, and the resulting commit looks like a routine
bot commit.

Design:

1. **`repo-kit.lock.json`** (new, repo root, reviewed like source):
   ```json
   { "commit": "<40-hex>", "files": { "build.py": "<64-hex>", "styles.py": "…",
     "styles_ink.py": "…", "ink.py": "…" } }
   ```
   The commit SHA in the URL is the immutability (`raw.githubusercontent.com/.../<sha>/...` cannot
   change); the `sha256` is the integrity check on the exact bytes and catches a compromised CDN.
2. **`scripts/fetch-repokit.mjs`** (new, no dependencies): reads the lock, refuses a `commit` that is
   not 40 hex, fetches each file from the pinned commit, hashes it, and writes **only** on an exact
   match. Any mismatch, missing file, extra file, or non-200 → exit 1 and leave `--dest` without a
   `build.py`.
3. **`banner.yml`**: replace the `curl` loop with `node scripts/fetch-repokit.mjs --dest /tmp/repokit`;
   the `python -c "import build"` probe and the `render` step stay where they are, so the ordering
   "verify → then import" is mechanical.
4. **Pin the actions:** `actions/checkout@v5` (`:33`) and `actions/setup-python@v5` (`:35`) become
   40-hex SHAs. This is also the `P3-8` half of the finding and applies to all five workflows
   (~40 `uses:` references).
5. **Token scope (Owner's choice, see §8):** keep `contents: write` for the bot commit, or move to
   `contents: read` + `pull-requests: write` and let a review gate the banner commit. The pinning in
   (1)–(3) removes the *remote code execution*; the token scope only reduces the *consequence* if the
   pinned bytes are reviewed carelessly.

### 6.2 Failure behaviour

The fetch script exits non-zero → the step fails → `render` and `commit` never run → **no push**.
A hash mismatch never leaves a partially-written file behind, so a later step cannot import it even
if someone reorders the workflow later. No `continue-on-error`, no fallback to `main`.

### 6.3 Rollout and rollback

One PR: lock file + script + workflow edit + action pins. First run after merge is a watched
`workflow_dispatch` (the workflow's own header already documents that discipline for the schedule).
Rollback is `git revert` of that PR; no state, no runtime, no operator action.

### 6.4 Hermetic test — `test/banner-workflow-pins.test.js` (new)

1. **Static, whole repo:** every `uses:` in `.github/workflows/*.yml` matches `/@[0-9a-f]{40}(?:\s|$)/`.
   This fails today for ~40 references and therefore lands *with* the pinning commit.
2. **Static, banner:** `banner.yml` contains no `raw.githubusercontent.com` literal, runs
   `scripts/fetch-repokit.mjs`, and the script step's index is lower than the `python` step's index
   (ordering assertion, same technique `test/release-workflow.test.js` uses on `release.yml`).
3. **Behavioural, hermetic:** run `scripts/fetch-repokit.mjs` with an injected fetcher (`--base
   file://…` or an injected `fetch`) serving (a) bytes that do not match the lock → exit 1 and no
   `build.py` in `--dest`; (b) matching bytes → exit 0, all four files written; (c) a lock whose
   `commit` is `main` → exit 1 before any fetch.

That is the strongest available proof for a GitHub-hosted workflow: the test proves the *ordering and
the pin* in the file that actually runs, and the script's negative arm proves a tampered byte never
reaches the directory `python` imports from. It cannot prove GitHub runs the workflow as written —
that is `[UNVERIFIED]` until the first watched dispatch.

Gate: `node --import ./test/setup-env.mjs --test test/banner-workflow-pins.test.js`

---

## 7. One table for the whole policy

| Surface | Target today | Target under Policy T | Verified at | Hermetic proof that unsigned cannot proceed |
|---|---|---|---|---|
| Source OTA (dashboard) | `v*` tag → peeled commit | commit SHA + signed `release-attestation.json` | `api.js:4455` selection; `:1731`/`:1729` assertion | `test/self-update-attestation.test.js` — no `merge`/`reset` argv, no rollback point, no restart |
| Source OTA (`update.sh`) | same | same | `update.sh:618`/`:630` after `verify-release-attestation.mjs` | same test file, shell arm |
| Docker OTA (dashboard) | mutable tag, `docker:24-cli` | `sha256:` digest + signed `image-digest.txt`; helper digest-pinned; `--no-build` | `docker-self-update.js:272` (pull), `:489` (create) | `test/docker-self-update.test.js` — zero `containers/create` |
| Docker OTA (`deploy/update.sh`) | `--tag`/`:latest` | `--tag` resolved then verified; `--image` must be digest | `deploy/update.sh` preflight | `test/docker-oneclick-update.test.js` — no `compose up` on refusal |
| CI (`banner.yml`) | `dwgx/DWGX@main` | pinned commit + `sha256` lock | `scripts/fetch-repokit.mjs` before `import build` | `test/banner-workflow-pins.test.js` — exit 1, no file written |
| Release assets | cosign keyless (works) | unchanged | `scripts/verify-release-assets.mjs` | `test/release-signing.test.js` (exists) |

---

## 8. What the Owner must approve

Each item is a decision, not an implementation detail. Ranked by how much they change the operating
model.

1. **`environment: release` with required reviewers on the `release` job** (and on the docker signing
   job). *Cost:* one human click per release; a tag push alone can no longer publish or sign.
   *Benefit:* this is the only item in the whole design that raises the bar against a compromised
   maintainer account, because it is the only one that gates who can mint the Fulcio identity.
   Without it, cosign buys provenance and nothing else — and `docs/RELEASE-SIGNING.md` already says so.
2. **Tag protection:** a repository ruleset so only the Owner can create or delete `v*` tags.
   Same rationale, cheaper to enforce.
3. **`id-token: write` on the `docker` job + image signing by digest**, adding two published assets
   (`image-digest.txt`, `release-attestation.json`, each with a `.sigstore.json`). Changes the public
   artifact list; `docs/RELEASE-SIGNING.md` and `test/release-signing.test.js` must change in the same
   commit (the test already enforces that the doc and the script agree).
4. **The boundary version `ATTESTED_FROM`** — the exact tag after which verification is mandatory.
   This is the one-way door for operators: after it, an update needs `cosign` or an operator-pinned
   digest. Choosing it is an Owner decision because it decides when the friction starts.
5. **`cosign` becomes a documented prerequisite for *verified* OTA** (source + host docker). One static
   binary; `--cosign <path>` and `COSIGN_PATH` supported; the error message names the install URL.
6. **Digest-pin `docker:24-cli`** — pick and review one digest — and add `--no-build` to the deployer
   command. The second half is a one-word change with a real security consequence (§5.1).
7. **`banner.yml` token scope:** keep `contents: write` (pinned generator only, smallest change) or
   move to PR-based (`pull-requests: write`, a review per banner refresh). Both are defensible; the
   PR route costs a review on a cosmetic asset.
8. **Whether `docker-compose.yml` keeps `:latest` as its default.** Recommended: yes for a human
   `docker compose up`, with the *updater* never treating it as a target. Recorded here so the
   decision is explicit rather than accidental.

Not required from the Owner: any new key, any secret, any registry write, any tag move. Nothing in
Policy T needs an out-of-band credential.

---

## 9. Implementation order (when this is approved)

1. `banner.yml` pins + lock + test — inert, zero runtime risk, closes P2-4 first.
2. `release.yml`: action SHA pins, `id: build`, image signing, two new assets, `environment: release`.
3. `scripts/verify-release-attestation.mjs` + `test/self-update-attestation.test.js` (red first).
4. `api.js` A1/A2 + `update.sh` mirror, `ATTESTED_FROM` set to the release that shipped step 2.
5. `docker-self-update.js` B1–B5 + `deploy/update.sh` digest resolution + both test files.
6. Docs: `docs/RELEASE-SIGNING.md`, `docs/DOCKER-UPDATE.md`, `docs/releases/README.md` — the same
   commit as the code, because `test/release-signing.test.js` asserts they agree.

**Non-goals.** No live registry, no live deploy, no tag move, no key generation, no change to
`install-ls.sh` (already hash-pinned against `ls-pins.json`), no change to the release-asset signing
that already works.

---

## 10. Verification boundary

- **No test, build, or workflow was executed for this document.** Every line number is from a read of
  `2598299e`; no command was run against a registry, a Docker daemon, or GitHub.
- **Verified against primary sources (not executed here):** Fulcio builds the GitHub Actions SAN from
  `job_workflow_ref` (`sigstore/fulcio/docs/oidc.md`); the Docker CLI/moby client sends a digest pull
  as `fromImage=<name>&tag=sha256:<digest>` (`moby/moby client/image_pull.go`, with the explicit
  comment that the server API expects digests as tags); `GET /distribution/<ref>/json` returns the
  registry digest without pulling (`moby/moby client/distribution_inspect.go`);
  `docker/build-push-action` exposes a `digest` output.
- **`[INFERENCE]`:** that adding `environment: release` leaves the Fulcio SAN unchanged (it changes
  `sub`, not `job_workflow_ref`). If that is wrong, the pinned identity string changes and
  `DEFAULT_IDENTITY_REGEXP`, the doc, and the test must move together — treat it as a trust-root change
  and verify on the first environment-gated tag before publishing the identity in the docs.
- **`[UNVERIFIED]`:** a real `cosign verify` of a GHCR digest against the documented identity; a real
  `cosign verify-blob` of an attestation bundle with no cached TUF root (needs network once); that
  `docker:24-cli` has a digest worth pinning on the target platform (choose and review it at
  implementation time); that GitHub runs `banner.yml` exactly as written after pinning.
- **Out of scope and unchanged:** the deployer's eight-second blind window and its `AutoRemove: true`
  (`P2-3`/`P2-6`) — that is D6's completion-signal problem, not a trust-anchor problem. This design
  only guarantees that a *verified* image is what the deployer is pointed at.

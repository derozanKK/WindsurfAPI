# DockerSign — Docker OTA trust (D9 Policy T § Docker OTA)

**Verdict: implemented and verified for the Docker OTA slice.** The release workflow
signs the pushed image **by digest** with the same keyless GitHub OIDC identity and
publishes `image-digest.txt` (plus its Sigstore bundle). The dashboard resolves a
tag to a digest through the Docker daemon's registry-metadata endpoint and refuses
to pull or deploy unless that digest equals the signed digest. The deployer helper
is pinned by digest and every `docker compose up` is `--no-build`.

- Base: `55a96d08cda92d122251164b0ecbf539ff92c7c9` (`git rev-parse HEAD`), branch `master`.
- Environment: Windows 11, Node v24.19.0.
- Non-goals respected: no live registry push, no tag move, no real Docker daemon in
  the test path. The only registry traffic in this report is a read-only manifest
  lookup used to choose and re-check the `docker:24-cli` digest.

## 1. What changed

### 1.1 `.github/workflows/release.yml` — sign the image digest, publish the digest file

`docker` job (`release.yml:73-211`):

- `permissions` gains `id-token: write` (`:83`) — without it cosign cannot obtain a
  Fulcio certificate, and the job would fail closed rather than sign nothing.
- Job-level `outputs.digest: ${{ steps.build.outputs.digest }}` (`:86-87`) keeps the
  immutable address in the job output.
- `docker/build-push-action` gains `id: build` (`:131`), so its documented `digest`
  output is addressable.
- After build-push, `cosign sign --yes "${IMAGE}@${{ steps.build.outputs.digest }}"`
  (`:154-170`) signs the
  **manifest digest** in GHCR. It uses the same `sigstore/cosign-installer` pin and
  cosign version as the release-assets job (`:148-152`), so the identity is the same
  `release.yml@refs/tags/vX.Y.Z`.
- `image-digest.txt` is written from the same `steps.build.outputs.digest` (`:173-181`),
  signed as a blob (`:183-189`), and uploaded with its bundle as the `image-digest`
  artifact (`:191-198`). Both steps fail on a non-`sha256:<64hex>` digest.
- The step summary prints the digest (`:207`).

`release` job:

- `Download the signed image digest` downloads that artifact (`release.yml:418-421`).
- `files:` attaches `image-digest.txt` and `image-digest.txt.sigstore.json` to the
  GitHub Release, immediately before `SHA256SUMS` (`:562-563`).

### 1.2 `src/dashboard/docker-self-update.js` — digest-only execution target

- `DEPLOYER_IMAGE` is now `docker:24-cli@sha256:2b62f89aaab9e4df0ff843f0d9a7bbd17340a9ba7c660ba6f40b1f00b38c2a4d`
  (`:41`). The digest is Docker Hub's `library/docker:24-cli` OCI index read on
  2026-10-26; the `linux/amd64` child is `sha256:dba081061b860672b2f50172ee0449b4d0a673586056ee8c12bf7747469e3cbe`.
- `parseImageReference()` (`:118-145`) separates repository/tag/digest and rejects a
  bare image ID (content-addressed, but not a Compose service reference).
- `readImageDigestFile()` / `parseImageDigest()` (`:147-183`) read
  `<DATA_DIR>/image-digest.txt` (default `config.dataDir`; a `digestFile` seam exists
  for tests/operators). Missing, empty or malformed material is
  `image-mutable-ref` (cause `image-digest-missing`) — a refusal, never a fallback.
- `resolveImageDigest()` (`:384-432`) calls `GET /distribution/<repo>:<tag>/json` and
  requires `Descriptor.digest` to be `sha256:<64hex>`; no layers are downloaded.
- `runDockerSelfUpdate()` (`:638-876`) authorises the target before writing the
  rollback journal or touching the daemon:
  - a digest-pinned `ctx.image` is an explicit operator pin and is used verbatim;
  - otherwise the signed digest is read first, the tag is resolved, and
    `registryDigest !== signedDigest` returns `image-digest-mismatch` with both
    digests in `detail` (`:689-722`);
  - `await pull(targetImage)` pulls the digest (`:764`);
  - `GET /images/<digest-ref>/json` requires a reported `RepoDigests` list to contain
    the requested digest, else `image-digest-unconfirmed` before any container create
    (`:769-783`);
  - the journal's `targetImage` and the API response's `image` are the digest ref,
    not the mutable tag (`:735`, `:865`).
- `dockerPull()` (`:438-519`) emits Moby's digest-pull shape:
  `POST /images/create?fromImage=<repo>&tag=sha256:<64hex>`. `fromImage=repo@sha256:…`
  is not the daemon API shape and is not used.
- `buildDockerDeployerScript()` (`:922-975`) refuses a non-digest `targetImage` and
  prefixes the first recreate with `WINDSURFAPI_IMAGE=<digest-ref>`; both Compose
  invocations are `up -d --no-build` (`:966` and the rollback line). Compose therefore
  cannot build from the on-disk checkout.

### 1.3 Docs updated in the same tree

`docs/RELEASE-SIGNING.md` (image digest asset, `cosign verify` commands, Docker OTA
section), `docs/DOCKER-UPDATE.md` (digest gate and `image-digest.txt` staging), and
the release-boundary paragraphs in `README.md` / `README.en.md`.

## 2. Red-first evidence

The new trust tests were written before the implementation. The final
`test/docker-self-update.test.js` was copied into a detached worktree at the unfixed
base `55a96d08`, then run with only the new block selected:

```text
$ git worktree add --detach .tmp-dockersign-red 55a96d08
$ cp test/docker-self-update.test.js .tmp-dockersign-red/test/
$ cd .tmp-dockersign-red
$ node --import ./test/setup-env.mjs --test --test-name-pattern "docker OTA digest trust" test/docker-self-update.test.js
✖ docker OTA digest trust (Policy T §5)
ℹ tests 7   ℹ pass 1   ℹ fail 6
```

The single pass is the deliberate operator-pinned-digest control (the old code also
pulled a digest ref); every gate that must be new failed:

| Red arm | Decisive failure on the unfixed base |
|---|---|
| mismatched registry digest vs `image-digest.txt` | returned `{ok:true,state:"pending-recreate"}` — it pulled and created the deployer |
| missing `image-digest.txt` | returned `{ok:true,...}` — a mutable tag was accepted with no verification material |
| matching digest proceeds | pull list was `['ghcr.io/dwgx/windsurf-api:latest','docker:24-cli']`, not the digest refs |
| pulled `RepoDigests` lacks the digest | returned `{ok:true,...}` — no post-pull confirmation existed |
| digest pull request shape | path was `fromImage=ghcr.io%2Fdwgx%2Fwindsurf-api%40sha256%3A…` instead of `fromImage=<repo>&tag=sha256%3A…` |
| deployer script | `DEPLOYER_IMAGE` was `docker:24-cli` and the first `up` had no `--no-build` |

Workflow red, same worktree with the final `test/release-workflow.test.js`:

```text
$ node --import ./test/setup-env.mjs --test --test-name-pattern "signs the pushed Docker image digest" test/release-workflow.test.js
✖ release workflow
ℹ tests 1   ℹ pass 0   ℹ fail 1
AssertionError: the docker job needs id-token: write for keyless cosign signing
```

## 3. Green evidence (final tree)

Targeted Docker/release set:

```text
$ node --import ./test/setup-env.mjs --test \
    test/docker-self-update.test.js \
    test/docker-oneclick-update.test.js \
    test/release-workflow.test.js \
    test/release-signing.test.js \
    test/self-update-docker.test.js \
    test/docker-script-packaging.test.js
exit 0
ℹ tests 107   ℹ suites 24   ℹ pass 92   ℹ fail 0   ℹ skipped 15
```

`docker-self-update.test.js` alone: **48 tests / 48 pass / 0 fail**, including the
seven Policy T arms. `docker-oneclick-update.test.js` executes the generated deployer
script against a fake docker CLI and asserts the first `up` carries
`IMAGE=<digest>` and `--no-build`; 11 pass, 13 skipped (POSIX-only integration arms
on this Windows host).

Docs consistency guard (`test/docs-consistency-guard.test.js`): **47/47 pass**, so
the new documentation does not break link, version or env-switch checks.

Full suite:

```text
$ node scripts/run-tests.mjs
exit 0
ℹ tests 7244   ℹ suites 1370   ℹ pass 7142   ℹ fail 0   ℹ cancelled 0   ℹ skipped 102   ℹ todo 0
```

## 4. Deployer digest provenance (read-only check)

```text
GET https://registry-1.docker.io/v2/library/docker/manifests/24-cli
  -> 200, application/vnd.oci.image.index.v1+json
  -> docker-content-digest: sha256:2b62f89aaab9e4df0ff843f0d9a7bbd17340a9ba7c660ba6f40b1f00b38c2a4d
GET https://registry-1.docker.io/v2/library/docker/manifests/sha256:2b62f89...
  -> 200, 8 platforms; linux/amd64 = sha256:dba081061b860672b2f50172ee0449b4d0a673586056ee8c12bf7747469e3cbe
```

This was a read-only registry query; nothing was pushed and no tag was moved.

## 5. Verification boundary

- The tests are hermetic: injected `detect`/`pull`/`request` seams, a fake registry
  (`GET /distribution/.../json` + `GET /images/.../json`), and a temp state dir.
  No `/var/run/docker.sock` and no registry network are used by the suite.
- `cosign sign` / `cosign sign-blob` are pinned in the workflow and fail the job on
  error, but a real tag build was not run here. That the GitHub OIDC exchange and
  GHCR signature upload succeed is `[UNVERIFIED]` until the first release after this
  change; this report does not claim a live signed image.
- The dashboard path consumes `image-digest.txt` from `<DATA_DIR>`; provisioning the
  release asset is an operator/deployment step documented in `docs/RELEASE-SIGNING.md`
  and `docs/DOCKER-UPDATE.md`. A digest-pinned `WINDSURFAPI_IMAGE` remains the explicit
  operator escape hatch.
- The shared working tree also carries the concurrent D9 source-OTA/banner lanes;
  this report covers only the Docker OTA slice.

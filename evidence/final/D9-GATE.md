# D9 gate — single-Owner trust assessment

**Decision: REDUCE RISK, but do not describe Policy T as independent release authorization.**
The supplied constraint is that only the Owner can push `v*` tags today. Under that constraint, a
signature automatically minted by the tag-triggered release workflow is provenance from the Owner's
repository, not a second approval. The useful minimum closes execution paths controlled by parties
*other than* the tag Owner (registry/helper/upstream-generator/action publishers). Source OTA remains
an explicitly accepted Owner-account trust boundary unless a genuinely separate approver or offline
root is introduced.

Audited: `evidence/D9-TRUST-DESIGN.md` and `evidence/audit2/Update.md`, both based on `2598299e`.
Current source references below are at `55a96d08cda92d122251164b0ecbf539ff92c7c9` (the baseline is
an ancestor). This is a static audit; repository rulesets, environment reviewers, account security,
registries, and live updates were not inspected or exercised. “Only the Owner can push tags” is an
input constraint, not something this repository can prove.

## 1. What still carries real risk

| Surface | Verdict under single-Owner tagging | Why the risk remains | What changes—and what does not |
|---|---|---|---|
| **Source OTA** | **Real, high-impact Owner-channel risk; no additional anonymous-org-member threat under the stated ruleset.** | Dashboard selection still trusts `origin`'s `v*` namespace, then merges the selected commit (`src/dashboard/api.js:4696-4719,4732-4743,1853-1857`); shell does the same (`update.sh:402-404,483-521,630-631`). Object/peeled and ancestry checks stop malformed/raced/unreachable candidates, not malicious code in a valid Owner-authorized tag. | Tag protection is useful admission control against everyone else, but cannot mitigate theft of the Owner's own account/token. A tag-triggered cosign statement also cannot: that same tag can mint the identity (`evidence/D9-TRUST-DESIGN.md:73-82`; `docs/RELEASE-SIGNING.md:114-126`). An offline key held separately can mitigate GitHub-token-only theft; a fully compromised Owner endpoint/key remains authoritative. |
| **Docker OTA** | **Real and broader than Owner trust; highest priority.** | The app is pulled from its current image reference without digest/signature authorization (`src/dashboard/docker-self-update.js:271-275,563-567`), normally moving `:latest` (`docker-compose.yml:4-10`; `deploy/update.sh:56-57`). The release job can push GHCR but does not sign the image (`.github/workflows/release.yml:73-80,123-132,415-447`). Separately, mutable `docker:24-cli` is pulled and run with `docker.sock` (`src/dashboard/docker-self-update.js:37,570-576,592-616`), host-root-equivalent by the module's own documentation (`:12-17`). | A registry-token compromise or mutable-tag/helper upstream compromise need not have `v*` permission. Digest resolution plus verification of an Owner-workflow-signed digest is therefore load-bearing against that narrower threat, even though it still cannot reject a malicious Owner release. The helper must be independently digest-pinned. The initial recreate still lacks `--no-build` (`src/dashboard/docker-self-update.js:740-745`), so D9's proposed fix remains necessary. |
| **Banner fetched code** | **Real cross-repository CI compromise; independent of `v*` permission.** | The workflow has `contents: write`, fetches four files from `dwgx/DWGX@main`, imports/runs them, and pushes (`.github/workflows/banner.yml:23,41-58,61-72`). A push/compromise on that other ref can execute with a write token here without any release tag. | A reviewed commit+per-file-hash lock makes upstream changes visible and prevents fetched-byte substitution. It does not make reviewed pinned code safe, and retaining write means a malicious reviewed generator can still push. PR-only output reduces that consequence but adds routine review friction. |

The documents' core missing-verification findings remain correct. Their old source line numbers are
historical; current equivalents are cited above. Their P2-3/P2-6 completion-signal descriptions are
not a current basis for this gate: the current Docker path now has durable state, health checking,
rollback, and a pending/not-verified response (`src/dashboard/docker-self-update.js:481-489,522-548,
580-586,640-655,714-747`). Those changes do **not** close any of the three trust-anchor gaps.

## 2. Load-bearing controls vs theater

### Load-bearing for a distinct threat

1. **Banner commit pin + exact file hashes, fail before import.** This directly removes mutable
   `main` as an execution authority. Pin `actions/checkout` and `actions/setup-python` on this job as
   well; mutable action tags otherwise remain privileged fetched code (`.github/workflows/banner.yml:33-38`).
   Reducing banner to read/PR output is useful least privilege, but optional rather than required to
   close the unreviewed-fetch defect (`evidence/D9-TRUST-DESIGN.md:364-374`).
2. **Docker app image signed by digest, then resolve/verify/pull/recreate by that digest in both
   dashboard and shell paths.** This binds the registry lookup to bytes authorized by the release
   workflow. The post-pull digest assertion and fail-closed behavior in D9 §5 are substantive, not
   cosmetic (`evidence/D9-TRUST-DESIGN.md:275-294,308-340`). Signature and digest must agree before
   pull/create; merely recording a digest afterward is not a gate.
3. **Digest-pin `docker:24-cli` and add `--no-build` to the initial Compose recreate.** These address
   two different execution routes: third-party helper bytes with host socket access, and a possible
   local build fallback from a Compose file that contains `build:` (`docker-compose.yml:11-19`;
   `src/dashboard/docker-self-update.js:740-745`). The existing health/rollback work is valuable for
   availability but is not provenance verification.
4. **SHA-pin the actions on privileged release/build/sign paths.** Otherwise an upstream moved action
   tag can alter or exfiltrate from a job before a perfectly valid signature is produced; the signing
   documentation itself acknowledges this (`docs/RELEASE-SIGNING.md:128-131`). Pinning all ~40 actions
   is reasonable hygiene, but only the privileged paths are in the minimal set.
5. **A truly independent release approver**, if such a person/service exists, or an offline signing
   root separated from GitHub credentials. Only these add a security principal distinct from the
   Owner's tag/account. An environment reviewer who is not the compromised Owner can make T4 real;
   an offline key can protect against GitHub-only account theft but adds distribution/rotation work.
6. **Operator-pinned commit/digest obtained and checked out of band.** This is a real human trust
   decision. The existing update mechanisms do not currently enforce such a pin; blindly copying a
   digest from the same compromised release channel does not create independence.

### Theater, or materially overclaimed, for the stated Owner-compromise threat

- **Source-OTA cosign attestation by itself (T2/T3).** It proves the pinned workflow signed a
  tag/commit statement. Because the sole authorized tagger can cause that workflow to run, it does
  not reject a malicious tag from a compromised Owner. It can prove provenance and detect unsigned
  artifact substitution; calling that authorization against Owner-account compromise is false.
- **`environment: release` with the Owner as the only approver.** A second click by the same account
  is not independent review and need not stop an attacker controlling that account/session. D9's
  claim that this is “the only item” that raises the bar is valid only with a genuinely separate,
  non-self-approving reviewer or equivalently separate credential/policy
  (`evidence/D9-TRUST-DESIGN.md:389-397`). Otherwise it is release friction and an audit event.
- **Tag rulesets as protection from the Owner.** They are load-bearing against other collaborators
  and over-broad tokens, and the current single-Owner rule should be retained/verified. They do not
  mitigate the Owner's own compromised credentials (`evidence/D9-TRUST-DESIGN.md:398-400`).
- **T1/content addressing by itself.** Selecting a 40-hex commit or `sha256:` digest prevents later
  mutation; it says nothing about whether those bytes are good. Source OTA already ultimately merges
  a commit SHA (`src/dashboard/api.js:1853-1857`). The authorization of that address is the important
  part (`evidence/D9-TRUST-DESIGN.md:119-126`).
- **Existing release-asset signatures as an OTA control.** OTA does not consume those assets
  (`docs/RELEASE-SIGNING.md:165-181,186-195`). Adding more signatures without a verification gate at
  the execution path changes nothing operationally.
- **Health gates, rollback, JSONL pull validation, and pending-state reporting.** They limit bad
  deployment outcomes but cannot establish that code/image bytes were authorized. Conversely, their
  presence is no reason to repeat the superseded P2-3 recommendation as a trust fix.
- **GPG is not inherently theater.** D9 is too categorical at `evidence/D9-TRUST-DESIGN.md:140-145`:
  a separately held offline key can protect against GitHub-token theft. It does not protect against
  compromise of both account and key/Owner machine, and its fleet key rollout is why it is not in the
  minimal set.

## 3. Minimal must-do set

This is the minimum to remove execution authorities **beyond the already accepted Owner release
channel**. It is not a claim that source OTA becomes independent of the Owner. Estimates are rough
engineering effort including focused tests, not live deployment time.

| Priority | Required change | Effort | Rollout/security risk | Completion test |
|---|---|---:|---|---|
| **M0** | Verify and retain the actual `v*` ruleset (Owner-only create/update/delete, no bypass), Owner phishing-resistant MFA, and least-privilege tokens. Do not add a same-Owner environment approval and call it independent review. | **< 0.5 day** | **Low**; settings error can block releases. Live settings are currently unverified. | Export/screenshot effective rules and bypass list; test a non-Owner tag attempt if feasible without disrupting release. |
| **M1** | Lock banner generator to reviewed commit + SHA-256 for every file; fail before import; SHA-pin that workflow's actions. Keep write only if the automatic commit is required; otherwise use read+PR. | **0.5–1 day** | **Low**; upstream updates become deliberate lock updates. | Negative hash/mutable-ref tests plus one watched dispatch; no import/push on mismatch. |
| **M2** | Digest-pin `docker:24-cli`; add `--no-build` to the initial dashboard deployer `up`; pin privileged Docker/release actions. | **0.5–1 day** | **Low–medium**; helper digest/platform selection and stale-pin maintenance require real-daemon validation. | Assert no create on invalid helper pin; inspect deployed command; exercise recreate and rollback on a real daemon. |
| **M3** | Sign GHCR image by digest; publish/bind the digest statement; resolve and verify before pull/create; pull/recreate by digest and re-check it in both dashboard and `deploy/update.sh`. Preserve a deliberate operator-pinned path for forks/air-gapped use. Stage signing before enforcement so existing installs can reach a verifier-bearing release. | **2–4 days** | **Medium**; new release assets, cosign availability/installation, failure semantics, and upgrade-boundary mistakes can block updates. | Red tests prove bad/missing signature or digest never pulls/creates/compose-ups; green real cosign+GHCR and real-Docker runs prove the rollout and recovery. |
| **M4 — source decision, no new source verifier in the minimum** | Keep the existing tag/ancestry/race checks and record that source OTA trusts the Owner's GitHub release authority. For high-risk deployments, require an out-of-band reviewed commit pin rather than pretending tag-triggered cosign is independent approval. | **0–0.5 day** for policy/operator procedure | **Low** operational change; **high residual impact** remains. Optional offline-tag verification or independent approval is a later, larger project, not a cosmetic add-on. | Document the accepted boundary and test any offered operator-pin path. Do not mark P2-1 closed solely because a workflow-signed statement exists. |

**Why no full source-cosign rollout in M0–M4:** under this constraint it adds runtime dependency and
upgrade complexity but does not change who can authorize a malicious release. If the Owner requires
protection from GitHub credential theft rather than only registry/third-party compromise, the minimal
set is no longer sufficient: add an independent environment reviewer **or** a separately held offline
signing key with bootstrap/rotation. A same-Owner approval click is not an acceptable substitute.

## 4. Residual risk accepted after only M0–M4

The Owner would explicitly accept all of the following:

1. **Owner compromise remains fleet-code-execution risk.** A malicious but valid Owner tag can still
   reach source OTA without an independent signature/approval. The same Owner-authorized release can
   produce a validly signed malicious Docker digest; M3 detects registry/artifact substitution, not
   malicious publisher intent. Impact extends to instances whose operator runs/clicks update.
2. **No independent human review is created.** The Owner can change source, workflow, verifier,
   constants, pins, and rollout boundary in the same release. In-tree assertions cannot constrain the
   person authorized to publish their replacements. Same-Owner environment approval adds no reliable
   defense against that account's compromise.
3. **Source OTA remains unsigned at installation.** P2-1 is deliberately accepted, not cryptographically
   closed. Existing object/peeled/ancestry checks continue to protect protocol consistency only
   (`src/dashboard/api.js:4696-4743`). Any optional operator pin is only as independent as the channel
   and review used to obtain it.
4. **Signed does not mean reviewed or reproducible.** Neither the signed image nor a signed source
   statement proves correspondence to reviewed source or freedom from malicious build inputs. The
   project documentation already scopes this limitation (`docs/RELEASE-SIGNING.md:122-131`). Action
   pinning reduces, but does not eliminate, compromised action/toolchain/base-image risk.
5. **Pinned banner/helper content can still be malicious or vulnerable.** The Owner accepts review
   quality at each lock/digest update. If banner retains `contents: write`, the pinned generator still
   has a write-capable execution path (`.github/workflows/banner.yml:23,53-72`). Helper pins also age
   and need a reviewed update process.
6. **Rollout does not repair old installations retroactively.** Until each deployment reaches and
   enables the verifier-bearing release, old mutable/unsigned behavior remains. Verification outages,
   missing cosign, bad pins, or unavailable release assets can cause update refusal/availability loss;
   fail-closed behavior intentionally chooses that over silent unsigned fallback.
7. **Trust and availability remain delegated to GitHub/Sigstore/GHCR/Docker Hub as applicable.** M3
   limits undetected substitution but does not make those services unavailable-proof. The initial
   cosign/tool distribution and TUF trust root must themselves be obtained correctly; these were not
   live-verified here.
8. **Local host compromise and explicit unsafe operator choices remain outside this gate.** Docker
   socket access is host-root-equivalent (`src/dashboard/docker-self-update.js:12-17`); rollback and
   health checks do not contain an already privileged malicious image. Explicit local `--build`, fork,
   or operator-pin modes trust whatever the operator selected.

**Gate wording allowed after the minimum:** “third-party fetched CI code is hash-locked; Docker app
and helper execution are digest-bound and the app digest is release-attested; source OTA and all
release signatures still ultimately trust the single Owner.”
**Gate wording not allowed:** “OTA has independent authorization,” “environment approval stops Owner
account compromise” (without an independent reviewer), or “all D9 supply-chain risk is closed.”

# OpenCodeReview (`ocr`) — why this repo has no review workflow yet

> **Status: not adopted as CI.** There is no OpenCodeReview workflow in this
> repository, so there is no `workflow_dispatch` trigger to add and no SARIF
> upload to wire. This file records the decision, the blocker, and the exact
> enablement path if the Owner decides to adopt it.

## What OpenCodeReview is

[`alibaba/open-code-review`](https://github.com/alibaba/open-code-review) is an
Apache-2.0 code-review CLI (`ocr`) with a deterministic selection/rule layer and
an LLM review layer. It reads a Git diff (`ocr review`), a commit, a branch
range, or whole files (`ocr scan`) and can emit `text`, `json`, or **`sarif`**.

Two properties matter for CI:

- **It is advisory, not a gate.** The CLI has no `fail_on_severity`; findings do
  not make it exit non-zero. `--max-tokens-budget` explicitly publishes partial
  results and exits 0; it exits non-zero only when every selected item failed.
- **The SARIF upload is free; the review that fills it is not.** `--preview` and
  `ocr delegate preview` are deterministic and need no LLM, but they only list
  the files that *would* be reviewed — `delegate` explicitly does not support
  SARIF. Producing findings (and therefore SARIF) requires a configured provider
  and a token.

The 2026-10-22 SEC audit recommended a phased, advisory-only adoption and
explicitly said not to put OCR on the merge path. This file implements the
"otherwise document why not" half of that follow-up.

## Why no workflow was added

1. **There is nothing to add a trigger to.** `git ls-files .github/workflows`
   lists five files — `banner.yml`, `baseline-audit.yml`, `ci.yml`,
   `release.yml`, `star-history.yml` — and none of them runs OCR.
2. **A SARIF-producing review needs an LLM credential.** `ocr review --format
   sarif` calls the configured provider. Without a provider token the command
   cannot produce findings; a SARIF file with no findings is not a review.
3. **This repository has zero Actions secrets.** Checked 2026-10-23:
   `gh api repos/dwgx/WindsurfAPI/actions/secrets --jq .total_count` → `0`.
   Adding a review job that expects `OCR_LLM_TOKEN` would add a secret the repo
   does not have, which is exactly the condition the follow-up excludes. The
   upstream example workflow
   (`alibaba/open-code-review/.github/workflows/ocr-review.yml`) is a
   `pull_request_target` job on a `self-hosted` runner with
   `pull-requests: write`, and it maps four secrets (`OCR_LLM_URL`,
   `OCR_LLM_AUTH_TOKEN`, `OCR_LLM_MODEL`, `OCR_LLM_USE_ANTHROPIC`). Copying it
   would add both the secrets and a write-scoped PR job; neither is acceptable
   without an explicit decision.
4. **The SARIF upload itself is not the blocker.** `security-events: write` is a
   workflow permission, not a secret, and `github/codeql-action/upload-sarif`
   needs nothing else. The blocker is the review that fills the file.
5. **`GITHUB_TOKEN` + GitHub Models is technically a no-new-secret path, but it
   is not a drop-in.** GitHub Models accepts the Actions token with `models:
   read` (GitHub announced this in April 2025), so a workflow could point
   `OCR_LLM_URL` at `https://models.github.ai/inference` and use
   `${{ github.token }}`. Before adopting it we would need to verify, on a real
   dispatch: that the chosen model supports the tool-calling loop OCR uses, what
   the per-account request quota does to a multi-group review, and whether the
   output precision survives. Those are `[UNVERIFIED]`; committing an unrun job
   would be a workflow-shaped claim, not a review.
6. **OCR is non-deterministic and advisory.** The merge condition in this repo
   is the deterministic gate (`npm run gate` / CI). A second, LLM-based opinion
   belongs on a manual trigger at most, never on `pull_request`.

## Enablement path (when the Owner decides)

### Step 1 — trial before wiring anything

```bash
# free: selection only, no LLM, no network
npx --yes @alibaba-group/open-code-review@1.13.3 review --preview \
  --from origin/master --to HEAD

# one real review against a provider; measure tokens and triage precision
npx --yes @alibaba-group/open-code-review@1.13.3 review \
  --from origin/master --to HEAD --format json --output /tmp/ocr.json
```

Compare the selected-file list with what you would review by hand, then triage
the findings. The audit's rule of thumb: if precision is below roughly 50 %,
skip the integration — triaging false positives costs more than the review
saves. The audit also measured the deterministic half: a release-sized range
(`v3.9.38..v3.9.52`, 327 changed files) selected 113 files in 8.8 s, and a
typical code commit selected 1–3.

### Step 2 — add the credential (this is the step that fails today)

Add one repository secret for the provider token (name it `OCR_LLM_TOKEN`), and
repository variables for the endpoint and model (`OCR_LLM_URL`,
`OCR_LLM_MODEL`) so they are visible without opening the secret. If the provider
is this project's own gateway, the token is a gateway API key; the endpoint is
`http://<gateway>/v1` and the protocol is `openai`.

Set `OCR_ENABLE_TELEMETRY=0` in CI. The CLI reads it from the environment; it is
not a secret.

### Step 3 — commit a `workflow_dispatch`-only job

The workflow below is deliberately **not** committed by this change: it cannot
run until Step 2 exists, and an unrun workflow is not evidence. It is the exact
file to add when it can run.

```yaml
name: OpenCodeReview (manual, advisory)

on:
  workflow_dispatch:
    inputs:
      base:
        description: Base ref to diff from (for example master)
        required: true
        default: master
      head:
        description: Head ref or commit SHA to review
        required: true
      model:
        description: Provider model name (must support tool calling)
        required: false
        default: ''

permissions:
  contents: read
  security-events: write   # SARIF upload only; no pull-requests: write

concurrency:
  group: opencode-review-${{ github.ref }}
  cancel-in-progress: false

jobs:
  ocr:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout the reviewed ref
        uses: actions/checkout@v5
        with:
          ref: ${{ inputs.head }}
          fetch-depth: 0

      - name: Make the base ref available
        run: git fetch --no-tags origin "+refs/heads/${{ inputs.base }}:refs/remotes/origin/${{ inputs.base }}"

      - uses: actions/setup-node@v5
        with:
          node-version: '24'

      - name: Run OpenCodeReview (SARIF, advisory)
        env:
          OCR_LLM_URL: ${{ vars.OCR_LLM_URL }}
          OCR_LLM_MODEL: ${{ inputs.model || vars.OCR_LLM_MODEL }}
          OCR_LLM_PROTOCOL: openai
          OCR_LLM_TOKEN: ${{ secrets.OCR_LLM_TOKEN }}
          OCR_ENABLE_TELEMETRY: '0'
        run: |
          npx --yes @alibaba-group/open-code-review@1.13.3 review \
            --from "origin/${{ inputs.base }}" \
            --to HEAD \
            --format sarif \
            --output ocr.sarif \
            --audience agent

      - name: Upload SARIF
        if: always() && hashFiles('ocr.sarif') != ''
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ocr.sarif
          category: opencodereview
```

Notes on the template:

- `workflow_dispatch` only; there is no `pull_request` trigger, so a review can
  never block or annotate a PR automatically.
- `security-events: write` is required by `upload-sarif`. `pull-requests: write`
  is intentionally absent: the CLI writes a file, it does not post comments. The
  upstream action (which posts inline comments and a sticky summary) would need
  PR write scope — do not use it for a SARIF-only job.
- Pin `@alibaba-group/open-code-review@1.13.3` exactly; `npx --yes` is only a
  convenience for a manual job. Pin the actions to commit SHAs when committing
  (SEC-11), even though the surrounding workflows still use major tags.
- The job uploads an artifact-free SARIF; the file is the evidence. Add
  `actions/upload-artifact` if the raw SARIF should be kept after the code
  scanning retention window.

### Step 4 — pin and review manually

Pin the CLI version, keep the trigger manual, and triage findings as a second
reader. Do not add a wrapper that turns SARIF counts into a non-zero exit: the
review is non-deterministic, so such a wrapper would be a flaky gate.

## Zero-new-secret variant (not recommended yet)

If a no-secret trial is required, the same job can use the Actions token with
GitHub Models:

```yaml
permissions:
  contents: read
  security-events: write
  models: read

env:
  OCR_LLM_URL: https://models.github.ai/inference
  OCR_LLM_TOKEN: ${{ github.token }}
  OCR_LLM_MODEL: openai/gpt-4.1
  OCR_LLM_PROTOCOL: openai
```

Why it is not the default: it introduces a new inference dependency and a new
data flow (the diff leaves the runner for GitHub Models), the per-account
request quota is documented but has not been measured against OCR's multi-group
review, and the model's tool-calling compatibility with OCR is `[UNVERIFIED]`.
The repository is public, so source confidentiality is not the concern;
reliability and review quality are.

## Security notes

- Never run OCR on `pull_request_target` with secrets. The upstream action's
  example does that because it does not execute PR code; this repository builds
  artifacts, so that pattern does not transfer.
- A SARIF-only job needs no PR write scope and no `contents: write`.
- OCR sends the diff to the configured provider. Set `OCR_ENABLE_TELEMETRY=0`
  and point the provider at a gateway you control if that matters.
- The CLI is a Go binary downloaded by the npm wrapper at install time; pin the
  npm version and, if you need stronger supply-chain guarantees, verify the
  platform binary's checksum against the upstream release before running it.

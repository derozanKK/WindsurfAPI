# Wave 7 — support-bundle credentials (Kimi P1 + P2-7)

**Worktree:** `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261022/w120-bundlep1`
**Branch:** `fix/support-bundle-credentials`, based on master `cf27abd`
**Date:** 2026-10-25 · **Not pushed, not tagged, not merged.**
**Logs:** `evidence/red-run.log`, `evidence/green-run.log`, `evidence/full-suite.log`,
`evidence/docs-guard.log`, `evidence/secret-scan.log` (untracked; `*.log` is gitignored).

Source: `evidence/KimiWaveReview.md` (wave 4–6 review of `d5e7ace..cf27abd`), P1
"support-bundle packages live request credentials" and P2-7 "text-leg redaction leaves
account identity and presigned URL credentials".

---

## 1. What was reproduced before the fix

The fixtures use the **real** `buildGetChatMessageRequest()` from `src/devin-connect.js`,
so the credential sits in ClientMetadata #3 exactly as it does on the wire. Tokens are
synthetic and carry the repository's `fixture` marker; values are omitted from this memo.

Command (old code, pre-fix tests):

```
node --import ./test/setup-env.mjs --test test/support-bundle.test.js
```

Result: `ℹ tests 9 / ℹ pass 0 / ℹ fail 4 / ℹ cancelled 5`. The suite's `before` hook and
each negative case failed for the reason the review named:

| Fixture | Old outcome |
|---|---|
| normal trace, `devin-session-token$<JWT-shaped fixture>` in #3 | `traces/0001-a/03-upstream-req.bin:3 session-token-literal` → **exit 1**, no ZIP: the documented workflow cannot produce a bundle |
| same shape, dedicated case | `traces/0001-jwt/03-upstream-req.bin:3 jwt-literal` → **exit 1**, no ZIP |
| opaque fixture in #3 (mixed case + digits, no recognisable prefix) | **exit 0**, ZIP written; assertion `the opaque token bytes are not in the archive` failed |
| `02-routing.json` with `account: <fixture email>`; `01-client-req.json` with a presigned URL (`X-Amz-Credential` / `X-Amz-Signature`) | **exit 0**, ZIP written; assertion `the account email is not in the archive` failed |
| opaque token duplicated in a text leg under a non-credential field name | **exit 0**, ZIP written, `0 value(s) redacted`; expected refusal |

The old code staged every non-text leg verbatim (`writeStaged(staging, rel, raw)`), and the
shared scanner cannot see an opaque token: `session-token-literal` requires the
`devin-session-token$` prefix, `jwt-literal` requires JWT structure.

## 2. Decision

**Binary legs.** `03-upstream-req.bin` is a `GetChatMessageRequest`; field #1 is
ClientMetadata, whose #3 is the account session token and whose #21 is the optional user
JWT. The bundler **parses and redacts exactly those two fields** (value → `[redacted]`) and
copies every other byte verbatim. Any binary leg that is not a recognisable request is
**omitted** from the archive; the manifest records `path`, `bytes`, `sha256` and a reason.
A redacted leg records `sourceBytes` / `sourceSha256` plus
`transforms: ['client-metadata-credentials']`, so a reviewer can tell it apart from an
untouched file.

Why both halves: parsing preserves the wire evidence a protocol bug needs (system prompt,
messages, model, tools, completion config, trajectory ids), while omission is the only
statement the bundler can prove for bytes it does not understand (`04-upstream-res.bin` is
gRPC-framed, possibly gzip). The brief allows either; the request is redacted and
everything unprovable is omitted.

**Proof.** Every credential value removed from #3/#21 is searched, byte-for-byte, across
the whole staging tree before the ZIP is written. A hit refuses the bundle (exit 1, nothing
written) and reports `credential-value` without echoing the value. This is what covers an
opaque token the shared rules cannot recognise, and it also catches the same credential
copied into a text leg.

**Text legs.** `redactText()` now removes:
- credential field values (existing `SECRET_FIELD`, extended so a whitespace-only value
  cannot be mistaken for a secret — `"token": ""` used to become `"token":[redacted]""`
  and break the JSON);
- presigned-URL query credentials: every `X-Amz-*` parameter plus `Signature`, `token`,
  `key`, `api_key`, `access_token`, `refresh_token`, `session_token`, `password`, `secret`;
- any email-address shape (the routing leg stores `ccAcct.email || ccAcct.id`).

`findResidualSensitive()` is an independent backstop: it looks for those names and requires
the following value to be exactly `[redacted]` (or empty). It is not the redaction regex,
so changing a replacement cannot silently ship the value. Generated `environment.json` is
redacted with the same function because `health.commitMessage` is free text from git.

## 3. Change map

| File | Change |
|---|---|
| `scripts/support-bundle.mjs` | text redaction (emails, query credentials), residual gate, span-based protobuf reader, `redactConnectRequest()` (#1.#3/#1.#21), content-first request classification, binary omission + manifest records, staging-wide credential-value search, environment redaction |
| `test/support-bundle.test.js` | real-builder fixtures (JWT, opaque, #21 user JWT), printable-request classification, email + presigned URL, residual refusal, environment redaction, omission size+sha256, empty-value tolerance |
| `README.md` | bundle section now states what is redacted and that unprovable binary legs are omitted |
| `.github/ISSUE_TEMPLATE/bug.yml` | same, in the reporter-facing instruction |
| `docs/ENV-SWITCHES.md` | one-line note: redact first, then secret scan |

Exit codes are unchanged: 0 = bundle written; 1 = gate hit (shared rules **or** a removed
credential still present) and nothing written; 2 = usage/I/O/environment failure.

## 4. Red → green

Red (old code, before the fix): see §1. The failure lines above are verbatim from
`evidence/red-run.log`; token values never appear in the log.

Green (branch head):

```
node --import ./test/setup-env.mjs --test test/support-bundle.test.js
→ ℹ tests 12 / ℹ pass 12 / ℹ fail 0 / ℹ cancelled 0

node scripts/run-tests.mjs
→ TEST_DISCOVERY 558 unique files
→ ℹ tests 6840 / ℹ suites 1289 / ℹ pass 6743 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 97 / ℹ todo 0

node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js
→ ℹ tests 47 / ℹ pass 47 / ℹ fail 0

node scripts/secret-scan.mjs
→ exit 0 (no findings)
```

Host: win32 10.0.26300, Node v24.19.0.

## 5. Independent ZIP proof (not the test suite)

Three real traces were built with the production builder: JWT-shaped token, opaque token,
and a text trace with a fixture account email + presigned URL. The bundler was run as a
user would run it, then the resulting ZIP was inspected with **Python's `zipfile`** (a
different reader from the test's local one). The probe workspace was deleted after the
run; the output below is the recorded result.

```
entries: ['environment.json', 'manifest.json',
          'traces/probe-jwt/03-upstream-req.bin',
          'traces/probe-opaque/03-upstream-req.bin',
          'traces/probe-text/01-client-req.json',
          'traces/probe-text/02-routing.json']

jwt:            absent from every entry
opaque:         absent from every entry
email:          absent from every entry
signature:      absent from every entry
credential id:  absent from every entry
scan:           {'engine': 'scripts/secret-rules.mjs', 'files': 5, 'findings': 0}
binaryLegs.redacted: 2 request legs, sourceBytes 1084 / 1033 → stored 1002 each,
                     credentialsRedacted 1 each
binaryLegs.omitted:  1 response leg, bytes 7, sha256 recorded, reason
                     "binary leg: not a GetChatMessageRequest (no ClientMetadata marker)"
presigned sample:    ...edacted]&X-Amz-SignedHeaders=[redacted]&X-Amz-Signature=[redacted]"
zip test:            None  (archive integrity OK)
```

The stored request is 82 bytes shorter for the JWT fixture and 31 bytes shorter for the
opaque fixture — exactly the difference between the token length and `[redacted]`, which
is the redaction itself, not a truncation. The non-credential request content (model,
system prompt, message text, config) is present in the stored leg (asserted by the test).

## 6. Mutation checks (safety layers are pinned)

Each mutation was applied to `scripts/support-bundle.mjs`, the targeted suite was run, and
the original file was restored byte-for-byte (`cmp` identical). Every layer has at least
one failing test:

| # | Mutation | Tests that failed |
|---|---|---|
| 1 | leave #3/#21 values unchanged (replace with original bytes) | ClientMetadata redaction, JWT, opaque, printable request (4) |
| 2 | disable the staging-wide credential-value search | residual-refusal case |
| 3 | drop email redaction | email + presigned URL case |
| 4 | drop query-credential redaction | email + presigned URL case |
| 5 | stage the raw request instead of the redacted buffer | main suite + redaction/manifest/refusal cases |
| 6 | only recognise a request when `isText()` is false | printable-request case (opaque token would ship) |
| 7 | stage `environment.json` without redaction | environment commit-message case |
| 8 | redact #3 but not #21 | user-JWT case |

## 7. Limits (explicit, not silently claimed)

- The request leg still carries prompt fragments, messages, tool results, model and
  config. That is the documented purpose of the bundle; only credentials are removed.
- Emails inside the **binary** request's prompt/system message are not scanned. The P2
  finding is the routing leg's account email; the request is user content and is already
  disclosed as "prompt fragments".
- The credential-value proof covers the values extracted from request metadata. An
  unrelated opaque credential pasted into prompt text is indistinguishable from user
  content; the shared rules still apply, but the bundler cannot know it is a credential.
- The review's lower-priority aggregate-size bound (per-file cap, no total cap) is
  unchanged; it was not part of P1/P2-7.
- Full-suite green is on this host only. The suite skips 97 tests (pre-existing).

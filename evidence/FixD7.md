# FixD7 — gRPC/Connect terminal truth (G1, G2, G3, G4)

Lane: worktree `C:/Users/dwgx1/.dwgx/ops/artifacts/windsurfapi-autonomous-20261026/w17x-FixD7`,
branch `fix/d7-grpc-terminal-truth` from master `2598299e`. Two commits: `597cb903` (the fix)
and a docs-only follow-up (§0 → `597cb903` in `HANDOFF-2026-10-15.md`, which the repo's
`docs-consistency-guard` demands once a branch touches `src/`). No default was flipped:
`GRPC_PROTOCOL` still selects legacy gRPC when unset (`src/grpc.js:16`).

Direction row: D7 — `src/grpc.js:150-292,510-543` unary/stream terminal handling and
`:96-113,168-182` opt-in Connect unary framing. Evidence behind the row:
`evidence/audit2/Transport.md` G1/G2/G3/G4 and §A.3.

## Files

| File | Why | Shape |
|---|---|---|
| `src/grpc.js` | the four findings | one shared `terminalFailure()`, strict Connect unary body decoder, HTTP-status fail-fast in both response handlers, spec framing for Connect unary |
| `test/helpers/s2-b-grpc-harness.mjs` | A.3 asks for a `startUnary` sibling | additive `startUnary()` (captures headers, written body, resolve/reject) |
| `test/s2-b-grpc.test.js` | the acceptance gate | 11 new arms — 5 gap arms (no status ×2, Connect 500 ×2, trailer-only) + 6 controls (status-0 ×2, Trailers-Only error, Connect error trailer, `application/proto` framing, bare response); `compare()` now supplies the status-0 trailer the frozen oracle also needs |
| `test/helpers/fake-grpc-trailers.mjs` | new; the fixtures below need a real terminal status | `terminateRpcWithStatus()` + `isConnectContentType()` |
| `test/client-panel-retry.test.js`, `test/native-read-wrapper.test.js`, `test/rate-risk.test.js`, `test/stream-backpressure-drain.test.js`, `test/cascade-abort-side-effects.test.js`, `test/cascade-detach-lazy-resume.test.js`, `test/detach-soak.test.js`, `test/helpers/fake-cascade-ls.mjs` | fake LS servers that never terminated an RPC and that recognised only the *streaming* Connect content-type | 2-line wrap at the single `server.on('stream')` site + one predicate call in each `responseBody`/`errorBody`/`requestPayload` |
| `test/rate-gap2.test.js` | fake transport emitted `end` with no response at all | emits the response + status-0 trailer it was implicitly relying on |
| `test/startserver-cascade-1m.test.js` | asserted the streaming content-type for a **unary** RPC, and echoed it back with an enveloped body | expects `application/proto`; answers unary with a bare message |
| `docs/HANDOFF-2026-10-15.md` | `docs-consistency-guard` fails a branch that changes `src/` without moving §0 | §0 master SHA → `597cb903`, in the docs-only follow-up commit |

## G4 — a response that never says how it ended is not a success

`grpcStatus` started at `'0'`, so a 200 response with no `grpc-status` took the success branch:
a truncated/crashed LS reply became an empty assistant turn and the account pool never failed
over (probe G1: `RESOLVED 0 bytes`). Presence is now tracked separately (`sawGrpcStatus`) and
`terminalFailure()` rejects with `gRPC response ended without grpc-status` in **both**
`grpcUnary` and `grpcStream` (`src/grpc.js:153-160,319,614`). Connect is exempt from this rule
(its terminal truth is HTTP status + end-stream JSON), and an explicit `grpc-status: 0`
Trailers-Only response still resolves an empty message, which is spec-legal.

Error shape: plain `Error` instances with the existing message vocabulary
(`upstream HTTP <status>`, `gRPC response ended without grpc-status`, the decoded
`grpc-message`, `Connect unary response is not a valid frame stream`). No `code` was added on
purpose: `hasUpstreamVerdict()` treats any `code` as "the upstream spoke", and
`classifyUpstreamError` would report a novel code as an unclassified fault.

## G2 — Connect HTTP status was ignored, and HTML was parsed as frames

The `:status` check was gated on `!USE_CONNECT`, so a Connect 500 body went into the frame
reader and surfaced as `HTTP/2 frame size 1752460652 exceeds 16777216` (probe C2). The check is
now mode-independent and happens **as soon as the response headers arrive**
(`src/grpc.js:295-307,590-603`): `upstream HTTP <status>`, stream cancelled, body never parsed.
Fail-fast is what makes the stream arm work at all — the data handler would otherwise throw
before `end`.

## G1 — Connect unary returned the envelope as the message

`payload = dataFrames.length > 0 ? … : full` returned the raw 5-byte-framed body for a
trailer-only response (probe C1: `RESOLVED 7 bytes hex=02000000027b7d`), which every caller then
fed to `parseFields()`. `decodeConnectUnaryResponse()` (`src/grpc.js:196-215`) now returns an
**empty** payload for a trailer-only body and rejects when the end-stream frame carries
`{error}`.

## G3 — Connect unary was wired as a streaming RPC

Unary sent `content-type: application/connect+proto` with a gzip envelope; the Connect protocol
reserves that for streaming and specifies `application/proto` + a bare message for unary
(connectrpc.com/docs/protocol). `grpcUnary` now unwraps the caller's `grpcFrame()` envelope
(`src/grpc.js:242-251`) and sends `application/proto` with no `connect-accept-encoding`
(`:262`). `grpcFrame()`/`wrapRequest()` are unchanged, so `grpcStream` keeps its envelope.

Response decoding accepts both shapes, and the discriminator is structural rather than
try/catch: a valid protobuf message cannot begin with `0x00-0x03` (field number 0 is illegal,
tags `0x01-0x03` are field 0 with wire types 1-3), which is the first byte of every envelope.
So a bare unary message is returned byte-for-byte, a corrupt envelope is a typed error
(`Connect unary response is not a valid frame stream`), and framing bytes are never handed to
`parseFields()`.

## Red → green

`node --import ./test/setup-env.mjs --test test/s2-b-grpc.test.js`

- Pre-fix source (new tests, `HEAD:src/grpc.js`): **11 pass / 7 fail**. The seven:
  no-status unary, Connect 500 unary, trailer-only, `application/proto` framing, bare-response
  control, no-status stream, Connect 500 stream. The four controls (status-0 unary, Trailers-Only
  error, Connect error trailer, status-0 stream) pass on both trees — legitimate behaviour did not
  move.
- Fixed source: **18/18 pass**.

## Fixture migration (why ten fixture files move)

Enforcing G4 exposed that the suite's fake language servers never send trailers: they `end()` a
200 response with no `grpc-status`, i.e. they model exactly the truncated RPC the client must
reject. Eight files now wrap their single `server.on('stream')` handler with
`terminateRpcWithStatus()`, which sets `waitForTrailers` and publishes `grpc-status: 0` — the
response itself is unchanged. The same helper is why the fakes stay honest on error paths: they
publish non-OK statuses through `additionalHeaders()`, which Node rejects after `respond()`
(`ERR_HTTP2_HEADERS_AFTER_RESPOND` — it is the 1xx/Early-Hints API, not trailers), so no fake
ever actually delivered a non-OK status; the wrapper sends the END_STREAM trailers frame empty
in that case rather than stamping a contradictory `0`.

The second fixture bug is the content-type predicate: the fakes branched on
`includes('application/connect+proto')`, which was true for every request while unary also used
the streaming content-type. With G3 they must treat both Connect content-types alike —
`isConnectContentType()` = "not `application/grpc`". Without it a Connect unary call was answered
with gRPC framing and an empty error body (that is the 30 s/91 s hang the first run showed).

`test/startserver-cascade-1m.test.js` asserted `/connect\+proto/` on `SendUserCascadeMessage`,
which is a unary RPC (`src/client.js:1201`); it now asserts `application/proto` and the fake
answers a unary request with a bare message.

## Verification

| Command | Result |
|---|---|
| `node --import ./test/setup-env.mjs --test test/s2-b-grpc.test.js` | 18/18 pass (pre-fix: 11/18) |
| `node --import ./test/setup-env.mjs --test test/rate-gap2.test.js test/stream-backpressure-drain.test.js test/native-read-wrapper.test.js test/startserver-cascade-1m.test.js test/rate-risk.test.js` | 69/69 pass |
| `node --import ./test/setup-env.mjs --test test/rate-risk.test.js test/client-panel-retry.test.js` | 29/29 pass (panel retry: 91.9 s hang → 2.1 s) |
| `node --import ./test/setup-env.mjs --test test/cascade-abort-side-effects.test.js test/cascade-detach-lazy-resume.test.js test/detach-soak.test.js test/rate-risk.test.js test/client-panel-retry.test.js` | 70 tests / 66 pass / 4 fail before the fixture fix (the three 30 s trajectory hangs + R-3); the same files are green inside the full suite below |
| `node scripts/run-tests.mjs` (full suite, this tree) | **7,123 tests / 7,026 pass / 0 fail / 97 skipped** |
| `node scripts/run-tests.mjs` (same command, clean worktree at `2598299e`) | 7,112 tests / 7,015 pass / 0 fail / 97 skipped |

Full-suite failure count went 8 → 0 across the fixture migration; the +11 tests and +11 passes
are the new arms.

### Mutation check (each layer deleted alone, targeted suite must fail)

| Mutation | Killed by |
|---|---|
| `if (!sawGrpcStatus)` removed | no-status unary + no-status stream |
| unary non-2xx fail-fast removed | Connect 500 unary |
| stream non-2xx fail-fast removed | Connect 500 stream |
| Connect trailer error ignored | Connect error trailer |
| trailer-only returns the envelope | trailer-only |
| bare-response discriminator removed | bare-response control + framing control |
| unary body not unwrapped | `application/proto` framing control |
| unary content-type reverted to streaming | `application/proto` framing control |
| `grpc-status` trailer not observed | status-0 unary control |

9/9 killed (`tmp/d7-mutate.mjs`, not committed).

## Boundaries — not claimed

- **No live LS probe.** Nothing here proves LS 2.12.5 sends `grpc-status` on every unary and
  stream reply; the requirement follows the gRPC protocol and the direction's acceptance gate.
  A live probe is explicitly out of scope for this direction. `[UNVERIFIED]`
- **No default flip.** `GRPC_PROTOCOL` is unset in every shipped config; the Connect path stays
  opt-in. Whether Connect works against the real LS after G3 is `[UNVERIFIED]` — the 2.0.19
  outage remains the reason not to flip it.
- **Untouched findings:** G5 (unbounded unary buffering), G11 (unguarded consumer callbacks),
  G12 (`stripGrpcFrame` fallback in gRPC mode) are outside this row. G12's Connect analogue is
  covered by the new decoder, but the gRPC `stripGrpcFrame` fallback is unchanged.
- **Fixtures answer Connect unary with the envelope shape** (success) — deliberate: the client
  must keep tolerating the LS's historical shape. The spec-pure bare shape is covered directly
  in `test/s2-b-grpc.test.js`.
- No product docs were edited (D10 owns `docs/ENV-SWITCHES.md` and the acceptance docs).

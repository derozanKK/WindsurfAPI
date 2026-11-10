// W4: the 1M-context history budget must survive the REAL route.
//
// `src/client.js` picks `CASCADE_1M_HISTORY_BYTES` (default 900_000) when the
// model uid matches /\b1m\b|[-_]1m$/i, otherwise `CASCADE_MAX_HISTORY_BYTES`
// (default 600_000). `test/review-history-coverage.test.js` already pins the
// budget arithmetic, but it calls `WindsurfClient.cascadeChat` directly with a
// hand-written uid — it never proves that the route resolves a public `-1m`
// model name to a uid the regex actually matches, nor that the resulting
// history reaches the upstream wire byte-for-byte.
//
// This file drives `handleChatCompletions` — the function `src/server.js` calls
// for POST /v1/chat/completions — with the LS seam (`ensureLs`/`getLsFor`)
// pointed at a fake HTTP/2 language server, and inspects the decoded
// `SendUserCascadeMessage` body. `startServer` itself has no seam for the LS
// pool (it always imports the real `ensureLs`), and spawning a real LS is not
// an offline test; the handler is the route layer under test here.
//
// Wire arithmetic with 6 turns of 200 KB (TURN_BYTES + marker/`_END_i`):
//   one history line = 8 (`<human>\n`) + ~200_026 + 10 (`\n</human>`) = ~200_044
//   900 KB branch: 4 history lines (~800 KB) fit, the 5th (~1_000 KB) does not
//                  → newest 5 of 6 turns on the wire, oldest dropped once
//   600 KB branch: 2 history lines (~400 KB) fit, the 3rd (~600 KB) does not
//                  → newest 3 of 6 turns on the wire
// So the 900 KB budget cannot carry the whole 1.2 MB payload; the "all six
// turns" case is pinned separately by raising CASCADE_1M_HISTORY_BYTES above
// the payload, which also proves the env key is read at request time (900000 is
// the compiled default, so the first test alone could not distinguish env from
// default).

import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';

Object.assign(process.env, {
  GRPC_PROTOCOL: 'connect',
  CASCADE_POLL_INTERVAL_MS: '5',
  CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '10000',
  CASCADE_COLD_STALL_BASE_MS: '10000',
  CASCADE_WARM_STALL_MS: '10000',
  CASCADE_1M_HISTORY_BYTES: '900000',
  CASCADE_MAX_HISTORY_BYTES: '600000',
  WINDSURFAPI_USER_JWT: '0',
});
// Cascade transport, not Devin connect: the budget lives on the Cascade path.
delete process.env.DEVIN_CONNECT;
delete process.env.DEVIN_ONLY;

const { addAccountByKey, getAccountInternal, getApiKey, removeAccount } = await import('../src/auth.js');
const { handleChatCompletions } = await import('../src/handlers/chat.js');
const { unwrapRequest, wrapEnvelope, endOfStreamEnvelope } = await import('../src/connect.js');
const {
  parseFields, getField, writeStringField, writeVarintField, writeMessageField,
} = await import('../src/proto.js');

const TURN_BYTES = 200_000;
const TURNS = 6;

let lsPort;
let accountId;
const sends = [];
const sessions = new Set();

// Fake LS: capture every SendUserCascadeMessage body, answer the cascade
// lifecycle calls the client makes (StartCascade → Send → trajectory poll).
const server = http2.createServer();
server.on('session', (session) => {
  sessions.add(session);
  session.on('close', () => sessions.delete(session));
});
server.on('stream', (stream, headers) => {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', () => {
    const payload = unwrapRequest(Buffer.concat(chunks), headers);
    const method = String(headers[':path']).split('/').pop();
    let body = Buffer.alloc(0);
    if (method === 'StartCascade') {
      body = writeStringField(1, 'synthetic-1m');
    }
    if (method === 'SendUserCascadeMessage') {
      const scope = getField(parseFields(payload), 2, 2);
      const text = getField(parseFields(scope.value), 1, 2).value.toString('utf8');
      sends.push({ payload, text, headers: { ...headers } });
    }
    if (method === 'GetCascadeTrajectorySteps') {
      // The client advances step_offset; return the trajectory only for the
      // first batch so a re-request cannot duplicate the planner step.
      const stepOffset = getField(parseFields(payload), 2, 0);
      if (!stepOffset) {
        body = writeMessageField(1, Buffer.concat([
          writeVarintField(1, 15), writeVarintField(4, 3), writeMessageField(20, writeStringField(1, 'answer')),
        ]));
      }
    }
    if (method === 'GetCascadeTrajectory') body = writeVarintField(2, 1);
    // Unary RPCs answer with a bare message under `application/proto`; streaming
    // RPCs keep the connect envelope plus end-of-stream frame (src/grpc.js).
    const contentType = headers['content-type'] || 'application/connect+proto';
    stream.respond({ ':status': 200, 'content-type': contentType });
    stream.end(String(contentType).includes('application/proto')
      ? body
      : Buffer.concat([wrapEnvelope(body, { compress: false }), endOfStreamEnvelope()]));
  });
});

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  lsPort = server.address().port;
  const added = addAccountByKey(`devin-session-token$xk-1m-${Math.random().toString(36).slice(2)}`, 'cascade-1m');
  accountId = added.id;
  const account = getAccountInternal(accountId);
  account.tier = 'pro';
  account.status = 'active';
});

after(async () => {
  if (accountId) removeAccount(accountId);
  for (const session of sessions) session.destroy();
  await new Promise((resolve) => server.close(resolve));
});

// Last message must be a user turn (the handler rejects assistant-final
// conversations before Cascade is ever reached).
function historyMessages(tag) {
  return Array.from({ length: TURNS }, (_, i) => ({
    role: i === TURNS - 1 ? 'user' : (i % 2 ? 'assistant' : 'user'),
    content: `${tag}_TURN_${i}_MARKER` + 'x'.repeat(TURN_BYTES) + `_END_${i}`,
  }));
}

async function runRoute({ model, messages }) {
  sends.length = 0;
  const result = await handleChatCompletions(
    { model, stream: false, max_tokens: 16, messages },
    {
      waitForAccount(tried, _signal, _maxWait, modelKey) { return getApiKey(tried, modelKey); },
      ensureLs: async () => {},
      getLsFor: () => ({ port: lsPort, csrfToken: 'csrf', generation: 1 }),
    },
  );
  return { result, captured: [...sends] };
}

// cascade_config (field 5) → planner config (field 1) → requested_model_uid
// (field 35) / plan_model_uid (field 34). The transport headers carry no model
// marker at all (only content-type/user-agent/csrf), so the uid on the body is
// the protocol's 1M marker.
function readRequestedModelUid(payload) {
  const cascadeConfig = getField(parseFields(payload), 5, 2);
  const planner = getField(parseFields(cascadeConfig.value), 1, 2);
  const uid35 = getField(parseFields(planner.value), 35, 2)?.value?.toString('utf8') || null;
  const uid34 = getField(parseFields(planner.value), 34, 2)?.value?.toString('utf8') || null;
  assert.equal(uid35, uid34, 'requested_model_uid and plan_model_uid must agree');
  return uid35;
}

function assertTurnsInOrder(text, messages, indices) {
  const positions = indices.map((i) => {
    const at = text.indexOf(messages[i].content);
    assert.notEqual(at, -1, `turn ${i} must arrive byte-for-byte`);
    return at;
  });
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'history turns must appear oldest-first');
}

it('the 900 KB 1M branch carries five of six 200 KB turns through the real route', async () => {
  const messages = historyMessages('ONE_M');
  const { result, captured } = await runRoute({ model: 'claude-sonnet-4-6-1m', messages });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(captured.length, 1, 'exactly one SendUserCascadeMessage per request');
  const { text, payload, headers } = captured[0];

  // The raw proto and the decoded prompt both spend the 900 KB budget; the
  // 600 KB branch would land near 600 KB total (control test below).
  assert.ok(payload.length > 900_000, `wire body ${payload.length} must exceed the 900 KB budget`);
  assert.ok(text.length > 900_000, `prompt text ${text.length} must exceed the 900 KB budget`);

  // Newest turn intact — the exact failure users report ("it forgot my last
  // message") is a budget that cuts from the wrong end.
  assert.ok(text.includes(messages[TURNS - 1].content), 'the newest turn must be complete');

  // 4 prior turns fit at 900 KB; all of them are byte-identical on the wire.
  assertTurnsInOrder(text, messages, [1, 2, 3, 4, 5]);
  for (let i = 1; i < TURNS; i++) {
    assert.ok(text.includes(messages[i].content), `turn ${i} must be complete, not mid-turn truncated`);
  }

  // Exactly one turn dropped, and it is the oldest.
  assert.ok(!text.includes('ONE_M_TURN_0_MARKER'), 'the oldest turn is the one dropped');
  assert.match(text, /truncation_note>The conversation above is truncated — 1 earlier turns were dropped/);

  // The protocol's 1M marker rides the body, not the headers.
  assert.equal(readRequestedModelUid(payload), 'claude-sonnet-4-6-1m');
  assert.equal(headers['x-codeium-csrf-token'], 'csrf', 'captured the real transport request');
  // SendUserCascadeMessage is a unary RPC, so Connect frames it as
  // `application/proto` with a bare message — not the streaming content type.
  assert.match(String(headers['content-type']), /application\/proto/);
  assert.equal(headers[':path'], '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage');

  assert.equal(result.body?.choices?.[0]?.message?.content, 'answer');
});

it('CASCADE_1M_HISTORY_BYTES is read per request: 1.1 MB carries all six turns', async () => {
  process.env.CASCADE_1M_HISTORY_BYTES = '1100000';
  try {
    const messages = historyMessages('ALL_SIX');
    const { result, captured } = await runRoute({ model: 'claude-sonnet-4-6-1m', messages });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(captured.length, 1);
    const { text, payload } = captured[0];

    // 5 history lines (~1.0 MB) now fit the raised budget: the whole
    // conversation is on the wire, no truncation note.
    assert.ok(text.length > 1_200_000, `prompt text ${text.length} must carry the whole payload`);
    assertTurnsInOrder(text, messages, [0, 1, 2, 3, 4, 5]);
    for (let i = 0; i < TURNS; i++) {
      assert.ok(text.includes(messages[i].content), `turn ${i} must be complete`);
    }
    assert.ok(!text.includes('truncation_note'), 'nothing was dropped, so no truncation note');
    assert.equal(readRequestedModelUid(payload), 'claude-sonnet-4-6-1m');
  } finally {
    process.env.CASCADE_1M_HISTORY_BYTES = '900000';
  }
});

it('the same history on a non-1M model is cut at the 600 KB budget', async () => {
  const messages = historyMessages('NORMAL');
  const { result, captured } = await runRoute({ model: 'claude-sonnet-4-6', messages });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(captured.length, 1);
  const { text, payload } = captured[0];

  // 2 history lines (~400 KB) fit 600 KB, the 3rd (~600 KB) does not.
  assert.ok(text.length > 600_000 && text.length < 700_000, `prompt text ${text.length} must sit at the 600 KB budget`);
  assertTurnsInOrder(text, messages, [3, 4, 5]);
  for (let i = 3; i < TURNS; i++) {
    assert.ok(text.includes(messages[i].content), `turn ${i} must be complete`);
  }
  for (let i = 0; i < 3; i++) {
    assert.ok(!text.includes(messages[i].content), `turn ${i} must be dropped on the 600 KB branch`);
  }
  assert.match(text, /truncation_note>The conversation above is truncated — 3 earlier turns were dropped/);
  assert.equal(readRequestedModelUid(payload), 'claude-sonnet-4-6');
});

// F2 (evidence/audit2/Cascade.md:254-278): the final IDLE sweep can be the
// FIRST place a step's text becomes visible — the LS writes the answer between
// the last poll's trajectory read and the end-of-turn sweep. The producer used
// to stream those bytes and still report `idle_empty`, so classifyCascadeEnd
// turned a delivered answer into a 502 EMPTY_RESPONSE (and the stream path
// wrote an error frame after the text).
//
// The contract pinned here, for BOTH final-sweep arms (inline default and
// WINDSURFAPI_CASCADE_TURN=1):
//   * text first seen only in the final sweep completes as `idle_done` and the
//     route answers 200 with that text (non-stream AND stream);
//   * a genuinely empty turn still ends as a typed 502 EMPTY_RESPONSE;
//   * the modifiedText top-up appends only the extension — never a duplicate;
//   * the classifier itself never turns delivered output into an empty failure.
//
// The seam is the real `cascadeChat` against a fake HTTP/2 language server, so
// the assertions are about the producer's real endReason/terminal and the real
// handler output, not a synthetic chunk shape.

import './setup-env.mjs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { terminateRpcWithStatus } from './helpers/fake-grpc-trailers.mjs';

// Every product import is dynamic and comes AFTER this block: src/client.js
// freezes CASCADE_TIMEOUTS at module load, so a static import would run first
// and the poll timings below would never apply.
Object.assign(process.env, {
  GRPC_PROTOCOL: 'connect',
  CASCADE_POLL_INTERVAL_MS: '10',
  CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '1500',
  CASCADE_COLD_STALL_BASE_MS: '1500',
  CASCADE_WARM_STALL_MS: '1500',
  WINDSURFAPI_USER_JWT: '0',
  // The handler-level arms must reach the producer; a cached answer from an
  // earlier arm would make the red assertion pass for the wrong reason.
  RESPONSE_CACHE_ENABLED: '0',
});
delete process.env.WINDSURFAPI_CASCADE_TURN;

const { unwrapRequest, wrapEnvelope, endOfStreamEnvelope } = await import('../src/connect.js');
const { writeMessageField, writeStringField, writeVarintField } = await import('../src/proto.js');
const { addAccountByKey, getApiKey, removeAccount } = await import('../src/auth.js');
const { handleChatCompletions } = await import('../src/handlers/chat.js');
const { WindsurfClient, classifyCascadeEnd } = await import('../src/client.js');

const CALLER = 'api:f2:user:u1';
const MODEL = 'gemini-2.5-flash';
const MODEL_UID = 'claude-sonnet-4-6';
const createdAccountIds = [];

afterEach(() => {
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
  delete process.env.WINDSURFAPI_CASCADE_TURN;
});

beforeEach(() => {
  delete process.env.WINDSURFAPI_CASCADE_TURN;
});

function newAccount() {
  const account = addAccountByKey(
    `f2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'f2',
  );
  createdAccountIds.push(account.id);
  return account;
}

function plannerStepBody({ responseText = '', modifiedText = '', status = 3 }) {
  const plannerFields = [];
  if (responseText) plannerFields.push(writeStringField(1, responseText));
  if (modifiedText) plannerFields.push(writeStringField(8, modifiedText));
  return Buffer.concat([
    writeVarintField(1, 15), // CORTEX_STEP_TYPE_PLANNER_RESPONSE
    writeVarintField(4, status),
    writeMessageField(20, Buffer.concat(plannerFields)),
  ]);
}

function stepsResponse(step) {
  return step ? writeMessageField(1, plannerStepBody(step)) : Buffer.alloc(0);
}

function respond(stream, headers, body) {
  stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/connect+proto' });
  stream.end(Buffer.concat([wrapEnvelope(body, { compress: false }), endOfStreamEnvelope()]));
}

/**
 * Fake LS whose step reads stay empty until `textOnRead` (1-based). The
 * final-sweep arm is the read after four empty IDLE polls, i.e. read 5.
 */
async function withFinalSweepServer({ textOnRead, step }, fn) {
  const requests = [];
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    terminateRpcWithStatus(stream);
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      unwrapRequest(Buffer.concat(chunks), headers);
      const method = String(headers[':path'] || '').split('/').pop();
      requests.push({ method, at: Date.now() });
      let body = Buffer.alloc(0);
      if (method === 'StartCascade') body = writeStringField(1, 'final-sweep-cascade');
      if (method === 'GetCascadeTrajectorySteps') {
        const read = requests.filter((request) => request.method === 'GetCascadeTrajectorySteps').length;
        body = read >= textOnRead ? stepsResponse(step) : Buffer.alloc(0);
      }
      if (method === 'GetCascadeTrajectory') body = writeVarintField(2, 1); // IDLE
      respond(stream, headers, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn({ port, requests });
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runProducer({ port, opts = {} }) {
  const client = new WindsurfClient('test-api-key', port, 'csrf-token');
  const chunks = await client.cascadeChat([{ role: 'user', content: 'hi' }], 0, MODEL_UID, opts);
  return {
    chunks,
    text: chunks.map((chunk) => chunk.text || '').join(''),
    terminal: chunks.terminal,
  };
}

function chatDeps(port) {
  return {
    waitForAccount(tried, _signal, _maxWaitMs, modelKey) {
      return tried.length === 0 ? getApiKey(tried, modelKey) : null;
    },
    ensureLs: async () => {},
    getLsFor: () => ({ port, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient,
    callerKey: CALLER,
  };
}

function fakeRes() {
  return {
    body: '',
    writableEnded: false,
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; },
    on() { return this; },
    removeListener() {},
  };
}

function chatFrames(body) {
  return body.split('\n\n')
    .filter(Boolean)
    .filter((frame) => !frame.startsWith(':'))
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter(Boolean);
}

function terminalChoice(body) {
  for (const raw of chatFrames(body)) {
    if (raw === '[DONE]') continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const choice = parsed.choices?.[0];
    if (choice?.finish_reason) return choice;
  }
  return null;
}

// The two final-sweep arms: the default inline loop and the CascadeTurn
// producer. Every behavioural assertion runs on both.
const ARMS = [
  { name: 'inline final sweep', env: null },
  { name: 'CascadeTurn final sweep', env: '1' },
];

function useArm(arm) {
  if (arm.env == null) delete process.env.WINDSURFAPI_CASCADE_TURN;
  else process.env.WINDSURFAPI_CASCADE_TURN = arm.env;
}

describe('F2 final-sweep text is a completed turn', () => {
  for (const arm of ARMS) {
    it(`${arm.name}: text first seen only in the final sweep completes with that text`, async () => {
      useArm(arm);
      await withFinalSweepServer({
        textOnRead: 5,
        step: { responseText: 'answer' },
      }, async (server) => {
        const { chunks, text, terminal } = await runProducer(server);
        const stepsReads = server.requests.filter((r) => r.method === 'GetCascadeTrajectorySteps').length;
        assert.equal(stepsReads, 5, 'precondition: four empty IDLE polls and one final sweep read');
        assert.equal(text, 'answer', 'the sweep bytes reach the caller exactly once');
        assert.equal(chunks.endReason, 'idle_done', 'a turn that emitted text did not end empty');
        assert.equal(chunks.sawText, true, 'the sweep must account for the emitted text');
        assert.equal(terminal.ok, true);
        assert.equal(terminal.kind, 'done');
        assert.equal(chunks.truncated, false);
        assert.equal(chunks.incomplete, false);
        assert.equal(chunks.totalYielded, 'answer'.length);
        if (arm.env === '1') {
          // A detach freezes this snapshot; a resumed turn restores sawText
          // from it, so a false here would resurrect F2 on the resume path.
          assert.equal(chunks.turnSnapshot?.sawText, true,
            'the snapshot a detach would freeze must record the emitted text');
        }
      });
    });

    it(`${arm.name}: text first seen only in the final sweep answers 200 (non-stream and stream)`, async () => {
      useArm(arm);
      await withFinalSweepServer({
        textOnRead: 5,
        step: { responseText: 'answer' },
      }, async ({ port }) => {
        newAccount();
        const nonStream = await handleChatCompletions({
          model: MODEL,
          stream: false,
          messages: [{ role: 'user', content: 'hi' }],
        }, chatDeps(port));
        assert.equal(nonStream.status, 200,
          `a delivered answer must not be reported as EMPTY_RESPONSE: ${JSON.stringify(nonStream.body)}`);
        assert.equal(nonStream.body.choices[0].message.content, 'answer');
        assert.equal(nonStream.body.choices[0].finish_reason, 'stop');
      });

      await withFinalSweepServer({
        textOnRead: 5,
        step: { responseText: 'answer' },
      }, async ({ port }) => {
        newAccount();
        const stream = await handleChatCompletions({
          model: MODEL,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }, chatDeps(port));
        assert.equal(stream.status, 200);
        const res = fakeRes();
        await stream.handler(res);
        assert.equal(res.body.includes('answer'), true, 'the answer reached the stream');
        assert.equal(res.body.includes('"error"'), false, 'a delivered answer must not be followed by an error frame');
        assert.equal(terminalChoice(res.body)?.finish_reason, 'stop');
        assert.equal(chatFrames(res.body).includes('[DONE]'), true);
      });
    });

    it(`${arm.name}: a genuinely empty turn is still a typed EMPTY_RESPONSE`, async () => {
      useArm(arm);
      await withFinalSweepServer({ textOnRead: Number.POSITIVE_INFINITY, step: null }, async (server) => {
        const { text, terminal } = await runProducer(server);
        assert.equal(text, '');
        assert.equal(terminal.ok, false);
        assert.equal(terminal.kind, 'empty');
        assert.equal(terminal.status, 502);
        assert.equal(terminal.code, 'EMPTY_RESPONSE');
      });

      await withFinalSweepServer({ textOnRead: Number.POSITIVE_INFINITY, step: null }, async ({ port }) => {
        newAccount();
        const nonStream = await handleChatCompletions({
          model: MODEL,
          stream: false,
          messages: [{ role: 'user', content: 'hi' }],
        }, chatDeps(port));
        assert.equal(nonStream.status, 502);
        assert.equal(nonStream.body.error.code, 'EMPTY_RESPONSE');
      });
    });

    it(`${arm.name}: the modifiedText top-up appends only the extension`, async () => {
      useArm(arm);
      await withFinalSweepServer({
        textOnRead: 1,
        step: { responseText: 'answer', modifiedText: 'answer plus' },
      }, async (server) => {
        const { chunks, text } = await runProducer(server);
        assert.equal(text, 'answer plus', 'no byte may be emitted twice');
        assert.equal(chunks.totalYielded, 'answer plus'.length);
        assert.equal(chunks.endReason, 'idle_done');
        assert.equal(chunks.terminal.ok, true);
        const reads = server.requests.filter((r) => r.method === 'GetCascadeTrajectorySteps').length;
        assert.ok(reads >= 2, 'precondition: at least one poll and the final sweep re-read the step');
      });
    });
  }

  it('classifier: idle_empty with delivered output is a truncation, not an empty failure', () => {
    const withOutput = classifyCascadeEnd('idle_empty', { totalYielded: 6 });
    assert.equal(withOutput.kind, 'truncated',
      'delivered text must never be classified as an empty turn');
    assert.equal(withOutput.status, 200);
    assert.equal(withOutput.truncated, true);
    assert.equal(withOutput.code, 'CASCADE_TRUNCATED');

    const thinkingOnly = classifyCascadeEnd('idle_empty', { totalThinking: 12 });
    assert.equal(thinkingOnly.kind, 'truncated',
      'the arm honours hasOutput exactly like max_wait');

    const toolOnly = classifyCascadeEnd('idle_empty', { toolCallCount: 1 });
    assert.equal(toolOnly.kind, 'truncated');

    const genuinelyEmpty = classifyCascadeEnd('idle_empty', {});
    assert.equal(genuinelyEmpty.kind, 'empty');
    assert.equal(genuinelyEmpty.status, 502);
    assert.equal(genuinelyEmpty.code, 'EMPTY_RESPONSE');

    // max_wait keeps its existing shape (the arm this one is made consistent with).
    assert.equal(classifyCascadeEnd('max_wait', { totalYielded: 6 }).kind, 'truncated');
    assert.equal(classifyCascadeEnd('max_wait', {}).kind, 'empty');
  });
});

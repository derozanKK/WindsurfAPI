#!/usr/bin/env node
/**
 * Fake language server for the detach gate-2 LS-pool pressure harness
 * (test/detach-ls-pool-pressure.test.js).
 *
 * The REAL pool manager (src/langserver.js) spawns this file as its LS binary,
 * so the harness exercises the production spawn → ready → pool-entry path. The
 * server speaks just enough h2c for a Cascade turn:
 *
 *   StartCascade                    → a unique cascade id
 *   SendUserCascadeMessage          → empty OK
 *   GetCascadeTrajectorySteps       → one ACTIVE planner step carrying
 *                                     FAKE_LS_TEXT, then empty reads
 *   GetCascadeTrajectory            → idle
 *   GetCascadeTrajectoryGeneratorMetadata → one usage record
 *
 * The first steps read is delayed so concurrent requests actually overlap on
 * the same pool entry. It never dials upstream, never reads a credential, and
 * never writes outside the caller-provided data dir.
 */
import http2 from 'node:http2';
import { endOfStreamEnvelope, unwrapRequest, wrapEnvelope } from '../../src/connect.js';
import { getField, parseFields, writeMessageField, writeStringField, writeVarintField } from '../../src/proto.js';
import { FAKE_LS_TEXT } from './fake-cascade-ls-constants.mjs';
import { isConnectContentType, terminateRpcWithStatus } from './fake-grpc-trailers.mjs';

const FIRST_READ_DELAY_MS = 200;

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
}
const port = Number(args.get('server_port'));
if (!Number.isInteger(port) || port <= 0) {
  console.error('fake-cascade-ls: missing --server_port=<n>');
  process.exit(2);
}

function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

function responseBody(payload, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function plannerStep(text, { status = 1 } = {}) {
  const plannerParts = [writeStringField(1, text)];
  const parts = [
    writeVarintField(1, 15), // CORTEX_STEP_TYPE_PLANNER_RESPONSE
    writeVarintField(4, status),
    writeMessageField(20, Buffer.concat(plannerParts)),
  ];
  return Buffer.concat(parts);
}

function rawStepsResponse(steps) {
  return Buffer.concat(steps.map(step => writeMessageField(1, step)));
}

function metadataEntry(inputTokens, outputTokens) {
  const usage = Buffer.concat([
    writeVarintField(2, inputTokens),
    writeVarintField(3, outputTokens),
  ]);
  const chatModel = writeMessageField(4, usage);
  return writeMessageField(1, chatModel); // CortexStepGeneratorMetadata.chat_model
}

function metadataResponse(records) {
  return Buffer.concat(records.map(record => writeMessageField(1, record)));
}

function readStringField(payload, num) {
  const field = getField(parseFields(payload), num, 2);
  return field ? String(field.value) : '';
}

function readVarintField(payload, num) {
  const field = getField(parseFields(payload), num, 0);
  return field ? Number(field.value) : 0;
}

let cascadeSeq = 0;
const cascades = new Map();

function cascadeState(cascadeId) {
  let state = cascades.get(cascadeId);
  if (!state) {
    state = { firstReadServed: false };
    cascades.set(cascadeId, state);
  }
  return state;
}

const server = http2.createServer();
server.on('stream', (stream, headers) => {
  terminateRpcWithStatus(stream);
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  stream.on('error', () => {});
  stream.on('end', () => {
    const method = String(headers[':path'] || '').split('/').pop();
    const contentType = headers['content-type'] || 'application/grpc';
    const payload = unwrapRequest(Buffer.concat(chunks), headers);
    const respond = (body) => {
      stream.respond({ ':status': 200, 'content-type': contentType });
      stream.end(responseBody(body, headers));
    };

    if (method === 'StartCascade') {
      const cascadeId = `fake-cascade-${process.pid}-${++cascadeSeq}`;
      cascadeState(cascadeId);
      respond(writeStringField(1, cascadeId));
      return;
    }
    if (method === 'SendUserCascadeMessage') {
      cascadeState(readStringField(payload, 1));
      respond(Buffer.alloc(0));
      return;
    }
    if (method === 'GetCascadeTrajectorySteps') {
      const cascadeId = readStringField(payload, 1);
      const offset = readVarintField(payload, 2);
      const state = cascadeState(cascadeId);
      if (offset === 0 && !state.firstReadServed) {
        state.firstReadServed = true;
        setTimeout(() => respond(rawStepsResponse([plannerStep(FAKE_LS_TEXT, { status: 1 })])), FIRST_READ_DELAY_MS);
      } else {
        respond(rawStepsResponse([]));
      }
      return;
    }
    if (method === 'GetCascadeTrajectory') {
      // 1 = idle; the producer needs two idle polls after the text to finish.
      respond(writeVarintField(2, 1));
      return;
    }
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      respond(metadataResponse([metadataEntry(100, 10)]));
      return;
    }
    respond(Buffer.alloc(0));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-cascade-ls listening on ${port}`);
});
server.on('error', (err) => {
  console.error(`fake-cascade-ls listen failed on ${port}: ${err.message}`);
  process.exit(1);
});

// A crashed test must not leave an orphan listener behind. Normal runs stop the
// child explicitly (`stopLanguageServerAndWait`); this is only the backstop.
setTimeout(() => process.exit(0), 10 * 60_000).unref();

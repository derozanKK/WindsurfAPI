// `parallel_tool_calls:false` is a caller PREFERENCE ("prefer one tool call per
// turn"), not a correctness requirement — and the proxy must never turn it into a
// 400. The only way to express it upstream is #11 `disable_parallel_tool_calls`, an
// opt-in field whose tag is unconfirmed (third-party .proto declaration order, never
// a wire capture), so it stays off by default. With the switch off the hint is
// dropped and the model may return several calls in one turn.
//
// That was a 400 until this lane. Two things were wrong with it:
//
//   1. A preference is not a bad request. Refusing it discards work the proxy can
//      serve perfectly well.
//   2. It broke a shipped client outright. Codex CLI 0.164 sends
//      `parallel_tool_calls:false` on EVERY request (29/29 captured,
//      evidence/ClientSandboxes.md §3.3 C1), so with the shipped default its first
//      turn got 400 `unsupported_parameter`, Codex surfaced `turn.failed` and exited
//      1 — the client was unusable against v3.10.x.
//
// So the two honest states are:
//
//   switch ON  → honour natively (#11 on the wire; the operator calibrated it).
//   switch OFF → serve the request, say once per process that the hint is being
//                dropped, and count every occurrence
//                (`parallel_tool_calls_hint_ignored`).
//
// The counter is the signal that would justify calibrating #11; the warn is what
// keeps the drop from being silent. Neither costs the caller a turn.
//
// Scoped to the connect flow on purpose: the switch and the wire field are
// connect-only, so a Cascade request is never affected by a connect knob.
// See evidence/CodexParallelFix.md (decision memo) and evidence/ToolChoiceFlag.md
// (the earlier refuse-instead-of-ignore policy this supersedes).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  handleChatCompletions,
  __setConnectDeps,
  __resetConnectDeps,
  __resetParallelToolCallsHintWarn,
} from '../src/handlers/chat.js';
import { handleResponses } from '../src/handlers/responses.js';
import { handleMessages } from '../src/handlers/messages.js';
import { streamChat, __setRequestImpl } from '../src/devin-connect.js';
import { getConnectMetrics, resetConnectMetrics } from '../src/devin-connect-metrics.js';
import { log } from '../src/config.js';
import { endOfStreamEnvelope } from '../src/connect.js';
import { parseFields } from '../src/proto.js';

const TOKEN = 'devin-session-token$parallel-tool-calls.test.jwt.sig';

const request = (extra) => ({
  model: 'claude-5-fable-medium',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

// Codex 0.164 shape as the capture shows it reaching the proxy: one function tool
// set plus the hint on every request.
const codexRequest = (extra = {}) => ({
  model: 'gpt-6-luna-max',
  stream: false,
  store: false,
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say ok' }] }],
  tools: [{
    type: 'function',
    name: 'functions__exec',
    description: 'run a command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  }],
  tool_choice: 'auto',
  ...extra,
});

const okBody = () => ({
  status: 200,
  body: {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'claude-5-fable-medium',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
});

// Capture what the handler hands the connect layer, without a network turn.
function stubConnect() {
  const seen = [];
  __setConnectDeps({
    toChatCompletion: async (params) => { seen.push(params); return okBody(); },
  });
  return seen;
}

/** Run `fn` while capturing every warn line, restoring the sink afterwards. */
async function captureWarns(fn) {
  const lines = [];
  const origWarn = log.warn;
  log.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    log.warn = origWarn;
  }
}

const hintIgnored = () => getConnectMetrics().parallel_tool_calls_hint_ignored;

beforeEach(() => {
  resetConnectMetrics();
  __resetParallelToolCallsHintWarn();
});

afterEach(() => {
  delete process.env.DEVIN_CONNECT;
  delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
  __resetConnectDeps();
  __setRequestImpl(null);
  resetConnectMetrics();
});

describe('Codex 0.164 regression: parallel_tool_calls:false is served, never refused', () => {
  it('serves a Codex-shaped responses request (field + tools) and calls the model', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = stubConnect();

    const r = await handleResponses(codexRequest({ parallel_tool_calls: false }));

    assert.equal(r.status, 200, `the shipped default must not reject a shipped client: ${JSON.stringify(r?.body)}`);
    assert.equal(seen.length, 1, 'the request must reach the model, not stop at a request-shape gate');
    assert.equal(seen[0].parallelToolCalls, false,
      'the hint still travels to the connect layer so the switch can honour it later');
    assert.equal(hintIgnored(), 1, 'the drop is counted, not silent');
  });

  it('serves the same request with the field absent (unchanged baseline)', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = stubConnect();

    const r = await handleResponses(codexRequest());

    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen.length, 1);
    assert.equal(hintIgnored(), 0, 'nothing to ignore when the caller said nothing');
  });

  it('does not refuse the hint on the chat route either', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = stubConnect();

    const r = await handleChatCompletions(request({ parallel_tool_calls: false }));

    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].parallelToolCalls, false);
    assert.equal(hintIgnored(), 1);
  });

  it('warns once per process, structurally, naming the event and the switch', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    stubConnect();

    const { lines } = await captureWarns(async () => {
      await handleChatCompletions(request({ parallel_tool_calls: false }));
      await handleChatCompletions(request({ parallel_tool_calls: false }));
    });

    const hits = lines.filter((l) => l.includes('parallel_tool_calls_hint_ignored'));
    assert.equal(hits.length, 1,
      `a per-request warn on every Codex turn is cry-wolf noise; got ${hits.length} lines`);
    assert.match(hits[0], /event=parallel_tool_calls_hint_ignored/,
      'the line must carry a stable, greppable event key');
    assert.match(hits[0], /DEVIN_CONNECT_TOOL_CHOICE/,
      'the line must name the switch that would make the hint honourable');
    assert.equal(hintIgnored(), 2, 'the counter carries the rate the single warn cannot');
  });

  it('honours the hint when the passthrough switch is on — and counts nothing', async () => {
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOOL_CHOICE = '1';
    const seen = stubConnect();

    const r = await handleChatCompletions(request({ parallel_tool_calls: false }));

    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen.length, 1, 'exactly one connect turn');
    assert.equal(seen[0].parallelToolCalls, false,
      'the flag must reach buildGetChatMessageRequest, not stop at the handler');
    assert.equal(hintIgnored(), 0, 'nothing was dropped, so nothing is counted');
  });

  it('threads tool_choice on the same switch (the other field behind it)', async () => {
    process.env.DEVIN_CONNECT = '1';
    process.env.DEVIN_CONNECT_TOOL_CHOICE = '1';
    const seen = stubConnect();

    const r = await handleChatCompletions(request({ tool_choice: 'required' }));

    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].toolChoice, 'required',
      'tool_choice is inert on the live route too unless the handler threads it');
  });

  it('leaves parallel_tool_calls:true unchanged (upstream default needs no field)', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = stubConnect();

    const { value: r, lines } = await captureWarns(
      () => handleChatCompletions(request({ parallel_tool_calls: true })),
    );

    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].parallelToolCalls, true);
    assert.equal(hintIgnored(), 0);
    assert.equal(lines.filter((l) => l.includes('parallel_tool_calls_hint_ignored')).length, 0,
      'true is the upstream default — it must not warn');
  });

  it('does not touch the connect counter on the Cascade route — the knob is connect-only', async () => {
    delete process.env.DEVIN_CONNECT;
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    stubConnect();

    const r = await handleChatCompletions({
      model: 'totally-made-up-model-xyz',
      messages: [{ role: 'user', content: 'hi' }],
      parallel_tool_calls: false,
    });

    // The Cascade path rejects the unknown model for its own reason; the point is
    // that the connect-only hint bookkeeping is not involved at all.
    assert.equal(r.status, 400);
    assert.equal(r.body?.error?.param, 'model', 'Cascade must answer about the model, not the connect knob');
    assert.equal(r.body?.error?.code, 'model_not_found');
    assert.equal(hintIgnored(), 0, 'a Cascade request must not move a connect counter');
  });
});

describe('/v1/messages: the Anthropic spelling of the same hint is served too', () => {
  it('accepts tool_choice.disable_parallel_tool_use instead of refusing it', async () => {
    process.env.DEVIN_CONNECT = '1';
    delete process.env.DEVIN_CONNECT_TOOL_CHOICE;
    const seen = stubConnect();

    // Real chain: handleMessages → handleChatCompletions → the connect layer.
    const r = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(r.status, 200, JSON.stringify(r?.body));
    assert.equal(seen.length, 1, 'the turn must reach the model');
    assert.equal(seen[0].parallelToolCalls, false,
      'F2 mapping still carries the Anthropic hint into the OpenAI-shaped field');
    assert.equal(hintIgnored(), 1);
  });
});

describe('streamChat threads the opt-in tool fields to the wire', () => {
  // Transport seam: capture the exact bytes the request sends, then answer with an
  // empty end-of-stream trailer so the generator drains.
  function captureRequest() {
    const captured = { body: null };
    __setRequestImpl((_opts, cb) => {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = () => {};
      req.write = (buf) => { captured.body = Buffer.from(buf); };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.pause = () => {};
        res.resume = () => {};
        cb(res);
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      };
      return req;
    });
    return captured;
  }

  // Request frames are written UNCOMPRESSED (connect.js: the upstream rejects a
  // gzipped request), so the proto is the payload after the 5-byte frame header.
  const protoOf = (body) => body.subarray(5);
  const hasField = (proto, n) => parseFields(proto).some((f) => f.field === n);

  async function drain(params) {
    for await (const _ev of streamChat(params)) { /* drain */ }
  }

  const base = {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'claude-sonnet-4.6',
    token: TOKEN,
  };

  it('emits #11 when the switch is on and the caller said false', async () => {
    const captured = captureRequest();
    await drain({
      ...base,
      parallelToolCalls: false,
      env: { DEVIN_CONNECT_TOKEN: TOKEN, DEVIN_CONNECT_TOOL_CHOICE: '1' },
    });
    assert.ok(captured.body, 'a request was written');
    assert.equal(hasField(protoOf(captured.body), 11), true,
      'disable_parallel_tool_calls must be on the wire, not swallowed by streamChat');
  });

  it('emits #12 for a non-default tool_choice when the switch is on', async () => {
    const captured = captureRequest();
    await drain({
      ...base,
      toolChoice: 'required',
      env: { DEVIN_CONNECT_TOKEN: TOKEN, DEVIN_CONNECT_TOOL_CHOICE: '1' },
    });
    assert.equal(hasField(protoOf(captured.body), 12), true);
  });

  it('emits neither field when the switch is off (default wire unchanged)', async () => {
    const captured = captureRequest();
    await drain({
      ...base,
      toolChoice: 'required',
      parallelToolCalls: false,
      env: { DEVIN_CONNECT_TOKEN: TOKEN },
    });
    const proto = protoOf(captured.body);
    assert.equal(hasField(proto, 11), false);
    assert.equal(hasField(proto, 12), false);
  });
});

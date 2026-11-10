// #236 — "subapi → WindsurfAPI → Codex" tool-call stall.
//
// The reporter's model is `glm-5-2-none`. The corrective retry ("rescue") is
// gated on `sawReasoning && !sawText` (src/devin-connect-openai.js), which a
// reasoning-effort `-none` selector can NEVER satisfy: the upstream emits no
// reasoning events at all. The reported shape is the same trap in the visible
// channel — the model narrates the tool call, finishes `stop`, emits zero calls.
//
// We deliberately do not retry it: the shape cannot be told apart from a
// legitimate prose answer without a real capture, and a false-positive nudge
// would rewrite a correct answer. What ships instead is the log-only detector
// the issue asks for. These tests pin BOTH halves:
//   - the detector fires on the stall shape and increments the counter,
//   - and it changes nothing on the wire (no retry, same text to the client).

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  streamChatCompletion,
  toChatCompletion,
  detectProseToolIntent,
  __setStreamChatForTest,
} from '../src/devin-connect-openai.js';
import { log } from '../src/config.js';
import { getConnectMetrics, resetConnectMetrics } from '../src/devin-connect-metrics.js';

afterEach(() => __setStreamChatForTest(null));

const TOOLS = [
  { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: {} } } },
];

function fakeStream(events) {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

/** Capture log.info lines that belong to the #236 detector. */
async function captureDetectorLogs(fn) {
  const lines = [];
  const realInfo = log.info;
  log.info = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (line.includes('prose tool intent without a call')) lines.push(line);
  };
  try {
    return { result: await fn(), lines };
  } finally {
    log.info = realInfo;
  }
}

describe('#236 detector — criterion', () => {
  it('flags a turn that ends mid-intent and names one of the request tools', () => {
    assert.equal(
      detectProseToolIntent({
        text: 'Sure. Calling read_file:',
        toolNames: ['read_file'],
        finishEv: { reason: 'stop' },
      }),
      'tool_name:read_file',
    );
  });

  it('flags a turn that ends mid-intent with a future-tense intent phrase', () => {
    assert.equal(
      detectProseToolIntent({
        text: "I'll search the web for that:",
        toolNames: ['read_file'],
        finishEv: { reason: 'stop' },
      }),
      "intent_verb:i'll",
    );
  });

  it('does NOT flag a finished answer that merely mentions a tool', () => {
    // This is the false positive that would make the counter useless: an agent
    // summarising its work names the tool it already used.
    assert.equal(
      detectProseToolIntent({
        text: 'I used read_file to inspect the config.',
        toolNames: ['read_file'],
        finishEv: { reason: 'stop' },
      }),
      null,
    );
  });

  it('does NOT flag the "let me know" closing', () => {
    assert.equal(
      detectProseToolIntent({
        text: 'Done — let me know if you need anything else',
        toolNames: ['read_file'],
        finishEv: { reason: 'stop' },
      }),
      null,
    );
  });

  it('does NOT flag a turn that DID emit a tool call', () => {
    assert.equal(
      detectProseToolIntent({
        text: 'Calling read_file:',
        toolNames: ['read_file'],
        finishEv: { reason: 'stop', toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }] },
      }),
      null,
    );
  });

  it('does NOT flag a non-stop terminal state', () => {
    for (const reason of ['length', 'tool_calls', 'content_filter']) {
      assert.equal(
        detectProseToolIntent({
          text: 'Calling read_file:',
          toolNames: ['read_file'],
          finishEv: { reason },
        }),
        null,
        `finish=${reason} is a real terminal state, not a stall`,
      );
    }
  });

  it('does NOT flag empty text or an absent finish event', () => {
    assert.equal(detectProseToolIntent({ text: '', toolNames: ['read_file'], finishEv: { reason: 'stop' } }), null);
    assert.equal(detectProseToolIntent({ text: 'Calling read_file:', toolNames: ['read_file'], finishEv: null }), null);
  });

  it('matches a tool name only on an ASCII boundary', () => {
    // `bash` inside `bashful`, and `read_file` inside `read_files`, are not the tool.
    assert.equal(
      detectProseToolIntent({
        text: 'The read_files helper is bashful:',
        toolNames: ['read_file', 'bash'],
        finishEv: { reason: 'stop' },
      }),
      null,
    );
  });
});

describe('#236 detector — end to end through the connect adapter', () => {
  it('logs and counts the -none stall shape without retrying or changing the reply', async () => {
    resetConnectMetrics();
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      // `glm-5-2-none` shape: no reasoning events at all, prose that stops
      // mid-intent, finish=stop, zero tool calls.
      yield { type: 'content', text: 'Sure. Calling read_file:' };
      yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } };
    });

    const { result, lines } = await captureDetectorLogs(() => toChatCompletion({
      model: 'glm-5-2-none',
      messages: [{ role: 'user', content: 'read /tmp/x' }],
      tools: TOOLS,
    }));

    // 1. Detected, once.
    assert.equal(lines.length, 1, `expected exactly one detector line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], /model=glm-5-2-none/);
    assert.match(lines[0], /signal=tool_name:read_file/);
    assert.match(lines[0], /reasoning=false/);
    assert.match(lines[0], /tools=2/);
    assert.equal(getConnectMetrics().prose_tool_intent, 1);

    // 2. Log-only: one upstream call, and the client still gets the same answer.
    assert.equal(calls, 1, 'the detector must not re-issue the request');
    assert.equal(result.body.choices[0].message.content, 'Sure. Calling read_file:');
    assert.equal(result.body.choices[0].finish_reason, 'stop');
    assert.equal(result.body.choices[0].message.tool_calls, undefined);
  });

  it('streaming path: same detection, and the stream is unchanged', async () => {
    resetConnectMetrics();
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: "I'll search the web for that:" },
      { type: 'finish', reason: 'stop', usage: null },
    ]));

    const frames = [];
    const { result, lines } = await captureDetectorLogs(() => streamChatCompletion(
      { model: 'glm-5-2-none', messages: [{ role: 'user', content: 'search' }], tools: TOOLS },
      (frame) => frames.push(frame),
      { emulateTools: true },
    ));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /signal=intent_verb:i'll/);
    assert.equal(getConnectMetrics().prose_tool_intent, 1);
    const text = frames
      .filter((f) => f?.choices?.[0]?.delta?.content)
      .map((f) => f.choices[0].delta.content)
      .join('');
    assert.equal(text, "I'll search the web for that:");
    assert.equal(result.finish_reason, 'stop');
  });

  // #236 P2: the detector used to run inside streamChatWithEmptyRetry, i.e.
  // BEFORE the emulation parser strips <tool_call> markup. Every normal
  // emulated call therefore looked like prose that stops mid-intent. The
  // detector must judge the DELIVERED turn, so a call that the adapter emitted
  // can never be counted as "narrated a call, emitted none".
  const EMULATED_CALL = 'I will inspect the file.\n'
    + '<tool_call>{"name":"read_file","arguments":{"path":"/tmp/x"}}</tool_call>';

  it('streaming path: a normal emulated <tool_call> is not reported', async () => {
    resetConnectMetrics();
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: EMULATED_CALL },
      { type: 'finish', reason: 'stop', usage: null },
    ]));

    const frames = [];
    const { result, lines } = await captureDetectorLogs(() => streamChatCompletion(
      { model: 'glm-5-2-none', messages: [{ role: 'user', content: 'read /tmp/x' }], tools: TOOLS },
      (frame) => frames.push(frame),
      { emulateTools: true },
    ));

    assert.deepEqual(lines, [], `an emulated call must not be logged as prose intent: ${JSON.stringify(lines)}`);
    assert.equal(getConnectMetrics().prose_tool_intent, 0);
    assert.equal(result.finish_reason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.equal(
      frames.filter((f) => f?.choices?.[0]?.delta?.tool_calls).length,
      1,
      'the adapter must still deliver the emulated tool call',
    );
  });

  it('non-stream path: a normal emulated <tool_call> is not reported', async () => {
    resetConnectMetrics();
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: EMULATED_CALL },
      { type: 'finish', reason: 'stop', usage: null },
    ]));

    const { result, lines } = await captureDetectorLogs(() => toChatCompletion(
      { model: 'glm-5-2-none', messages: [{ role: 'user', content: 'read /tmp/x' }], tools: TOOLS },
      { emulateTools: true },
    ));

    assert.deepEqual(lines, [], `an emulated call must not be logged as prose intent: ${JSON.stringify(lines)}`);
    assert.equal(getConnectMetrics().prose_tool_intent, 0);
    assert.equal(result.body.choices[0].finish_reason, 'tool_calls');
    assert.equal(result.body.choices[0].message.tool_calls.length, 1);
    assert.equal(result.body.choices[0].message.tool_calls[0].function.name, 'read_file');
  });

  it('does not flag prose truncated by a local stop sequence', async () => {
    resetConnectMetrics();
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'I will call read_file:' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));

    const { result, lines } = await captureDetectorLogs(() => toChatCompletion(
      { model: 'glm-5-2-none', messages: [{ role: 'user', content: 'read /tmp/x' }], tools: TOOLS },
      { stop: ['read_file:'] },
    ));

    // The cut is ours, not the model stalling: without the stopHit guard the
    // remaining "I will call " would match the intent-verb criterion.
    assert.deepEqual(lines, []);
    assert.equal(getConnectMetrics().prose_tool_intent, 0);
    assert.equal(result.body.choices[0].message.content, 'I will call ');
    assert.equal(result.body.choices[0].finish_reason, 'stop');
  });

  it('a normal prose answer with tools present is not reported', async () => {
    resetConnectMetrics();
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'I used read_file to inspect the config.' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));

    const { lines } = await captureDetectorLogs(() => toChatCompletion({
      model: 'glm-5-2-none',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: TOOLS,
    }));

    assert.deepEqual(lines, []);
    assert.equal(getConnectMetrics().prose_tool_intent, 0);
  });

  it('the same prose without tools in the request is not reported', async () => {
    resetConnectMetrics();
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'Calling read_file:' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));

    const { lines } = await captureDetectorLogs(() => toChatCompletion({
      model: 'glm-5-2-none',
      messages: [{ role: 'user', content: 'read /tmp/x' }],
    }));

    assert.deepEqual(lines, []);
    assert.equal(getConnectMetrics().prose_tool_intent, 0);
  });

  it('DEVIN_CONNECT_PROSE_INTENT_DETECT=0 silences it', async () => {
    resetConnectMetrics();
    const previous = process.env.DEVIN_CONNECT_PROSE_INTENT_DETECT;
    process.env.DEVIN_CONNECT_PROSE_INTENT_DETECT = '0';
    __setStreamChatForTest(fakeStream([
      { type: 'content', text: 'Calling read_file:' },
      { type: 'finish', reason: 'stop', usage: null },
    ]));
    try {
      const { lines } = await captureDetectorLogs(() => toChatCompletion({
        model: 'glm-5-2-none',
        messages: [{ role: 'user', content: 'read /tmp/x' }],
        tools: TOOLS,
      }));
      assert.deepEqual(lines, []);
      assert.equal(getConnectMetrics().prose_tool_intent, 0);
    } finally {
      if (previous === undefined) delete process.env.DEVIN_CONNECT_PROSE_INTENT_DETECT;
      else process.env.DEVIN_CONNECT_PROSE_INTENT_DETECT = previous;
    }
  });
});

// B1/B2 — Messages stream fidelity regressions from the GFHarness evidence
// (evidence/GFHarness.md, probes B and C).
//
// B1: text or thinking deltas interleaved between a tool call's argument
//     fragments closed the open tool_use block; every later fragment had no
//     legal destination and was dropped at finish(), so Claude Code received
//     `{"path"` and failed JSON.parse at position 7. A tool_use block can never
//     be reopened, so the only lossless option is to HOLD the text/thinking
//     until the tool block closes (or close the tool first when its arguments
//     are already complete JSON, which keeps ordinary streams byte-identical).
//
// B2: tool_result.is_error was read only by the Read-stub heuristic; for every
//     other tool the flag vanished, so a failed Bash/Edit result reached the
//     model as an ordinary success output.
//
// Also pinned here: duplicate forwarded tool names (a caller function named
// `web_search` plus the `web_search_20250305` server tool used to forward
// `tools: ["web_search", "web_search"]`).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const tc = (obj) => chunk({ choices: [{ index: 0, delta: { tool_calls: [obj] }, finish_reason: null }] });

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; }, off() { return this; },
    setHeader() {}, writeHead() { return this; }, flushHeaders() {},
  };
}

function events(raw) {
  return raw.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const lines = frame.split('\n');
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    return {
      event: lines.find((l) => l.startsWith('event: '))?.slice(7),
      data: data ? JSON.parse(data) : null,
    };
  });
}

function streamDeps(frames) {
  return {
    async handleChatCompletions() {
      return {
        status: 200, stream: true,
        async handler(res) { for (const f of frames) res.write(f); res.end(); },
      };
    },
  };
}

async function runStream(body, frames) {
  const result = await handleMessages(body, streamDeps(frames));
  const res = fakeRes();
  await result.handler(res);
  return events(res.body);
}

// Wire view of the emitted content blocks: every start must have exactly one
// stop, and no input_json_delta may target a block after it stopped.
function blockLedger(evts) {
  const started = [];
  const stopped = new Set();
  const deltas = [];
  const deltasAfterStop = [];
  for (const e of evts) {
    const d = e.data || {};
    if (d.type === 'content_block_start') started.push(d);
    else if (d.type === 'content_block_stop') stopped.add(d.index);
    else if (d.type === 'content_block_delta') {
      deltas.push(d);
      if (stopped.has(d.index)) deltasAfterStop.push(d);
    }
  }
  const argsByIndex = new Map();
  for (const d of deltas) {
    if (d.delta?.type === 'input_json_delta') {
      argsByIndex.set(d.index, (argsByIndex.get(d.index) || '') + d.delta.partial_json);
    }
  }
  return {
    started,
    stopped,
    deltasAfterStop,
    argsByIndex,
    text: deltas.filter((d) => d.delta?.type === 'text_delta').map((d) => d.delta.text).join(''),
    thinking: deltas.filter((d) => d.delta?.type === 'thinking_delta').map((d) => d.delta.thinking).join(''),
    stopReason: evts.find((e) => e.data?.type === 'message_delta')?.data?.delta?.stop_reason,
    errors: evts.filter((e) => e.data?.type === 'error').map((e) => e.data.error),
    sawMessageStop: evts.some((e) => e.data?.type === 'message_stop'),
  };
}

const READ_TOOLS = [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }];
const BASH_TOOLS = [{ name: 'Bash', description: 'run shell', input_schema: { type: 'object' } }];

describe('Messages: text/thinking interleaved with tool-argument fragments', () => {
  it('keeps every argument fragment and delivers the interleaved text (no truncated tool_use)', async () => {
    // Exactly the Q3 probe-B stream: args, text, args.
    const frames = [
      tc({ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path"' } }),
      chunk({ choices: [{ index: 0, delta: { content: 'interleave' }, finish_reason: null }] }),
      tc({ index: 0, function: { arguments: ':"x"}' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const evts = await runStream({
      model: 'claude-sonnet-4.6', stream: true, tools: READ_TOOLS,
      messages: [{ role: 'user', content: 'read it' }],
    }, frames);
    const wire = blockLedger(evts);

    const toolStarts = wire.started.filter((s) => s.content_block?.type === 'tool_use');
    assert.equal(toolStarts.length, 1, 'exactly one tool_use block');
    assert.equal(toolStarts[0].content_block.id, 'call_1');
    assert.equal(toolStarts[0].content_block.name, 'Read');

    const assembled = wire.argsByIndex.get(toolStarts[0].index) || '';
    assert.equal(assembled, '{"path":"x"}', `every fragment lands: got ${JSON.stringify(assembled)}`);
    assert.doesNotThrow(() => JSON.parse(assembled), 'assembled tool input is valid JSON');

    assert.equal(wire.text, 'interleave', 'the interleaved text is delivered exactly once');
    assert.equal(wire.stopReason, 'tool_use');
    assert.equal(wire.errors.length, 0);
    assert.equal(wire.sawMessageStop, true);
    assert.deepEqual(wire.deltasAfterStop, [], 'no delta targets a closed block');
    for (const s of wire.started) assert.ok(wire.stopped.has(s.index), `block ${s.index} was stopped`);
  });

  it('keeps every argument fragment when reasoning_content interleaves', async () => {
    const frames = [
      tc({ index: 0, id: 'call_2', type: 'function', function: { name: 'Bash', arguments: '{"comm' } }),
      chunk({ choices: [{ index: 0, delta: { reasoning_content: 'considering' }, finish_reason: null }] }),
      tc({ index: 0, function: { arguments: 'and":"ls"}' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const evts = await runStream({
      model: 'claude-sonnet-4.6', stream: true, tools: BASH_TOOLS,
      messages: [{ role: 'user', content: 'run it' }],
    }, frames);
    const wire = blockLedger(evts);
    const toolStart = wire.started.find((s) => s.content_block?.type === 'tool_use');
    assert.ok(toolStart, 'a tool_use block was opened');
    const assembled = wire.argsByIndex.get(toolStart.index) || '';
    assert.equal(assembled, '{"command":"ls"}');
    assert.doesNotThrow(() => JSON.parse(assembled));
    assert.equal(wire.thinking, 'considering');
    assert.deepEqual(wire.deltasAfterStop, []);
  });

  it('keeps a stream with no interleaving byte-identical (text, complete tool call, trailing text)', async () => {
    // The tool's arguments are complete JSON before the trailing text arrives,
    // so the text must stream in place, not be held to finish().
    const frames = [
      chunk({ choices: [{ index: 0, delta: { content: 'Reading. ' }, finish_reason: null }] }),
      tc({ index: 0, id: 'call_3', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }),
      chunk({ choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const evts = await runStream({
      model: 'claude-sonnet-4.6', stream: true, tools: READ_TOOLS,
      messages: [{ role: 'user', content: 'read a.txt' }],
    }, frames);
    const wire = blockLedger(evts);
    assert.deepEqual(
      wire.started.map((s) => [s.index, s.content_block.type]),
      [[0, 'text'], [1, 'tool_use'], [2, 'text']],
      'trailing text opens its own block in stream order',
    );
    assert.equal(wire.text, 'Reading. Done.');
    assert.equal(wire.argsByIndex.get(1), '{"path":"a.txt"}');
    assert.deepEqual(wire.deltasAfterStop, []);
  });

  it('streams text in place once the open tool call is complete (no hold-to-finish latency)', async () => {
    // Without the complete-JSON shortcut this fixture would still be lossless,
    // but the second text block would be held to finish() and emitted after the
    // SECOND tool block — a visible latency/order regression. The shortcut is
    // what keeps ordinary streams byte-identical to the pre-hold behavior.
    const frames = [
      chunk({ choices: [{ index: 0, delta: { content: 'Reading. ' }, finish_reason: null }] }),
      tc({ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }),
      chunk({ choices: [{ index: 0, delta: { content: 'Now running. ' }, finish_reason: null }] }),
      tc({ index: 1, id: 'call_b', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const evts = await runStream({
      model: 'claude-sonnet-4.6', stream: true,
      tools: READ_TOOLS.concat(BASH_TOOLS),
      messages: [{ role: 'user', content: 'go' }],
    }, frames);
    const wire = blockLedger(evts);
    assert.deepEqual(
      wire.started.map((s) => [s.index, s.content_block.type]),
      [[0, 'text'], [1, 'tool_use'], [2, 'text'], [3, 'tool_use']],
      'the text between the two calls streams before the second tool block',
    );
    assert.equal(wire.text, 'Reading. Now running. ');
    assert.equal(wire.argsByIndex.get(1), '{"path":"a.txt"}');
    assert.equal(wire.argsByIndex.get(3), '{"command":"ls"}');
    assert.deepEqual(wire.deltasAfterStop, []);
  });

  it('keeps two parallel calls byte-exact when text interleaves with both', async () => {
    // A3 (two interleaved tool calls) + B1 (text between fragments): the second
    // tool is held until finish, so the text must be held too, and both calls
    // must still assemble exactly once.
    const frames = [
      tc({ index: 0, id: 'call_a', type: 'function', function: { name: 'run_a', arguments: '{"command"' } }),
      tc({ index: 1, id: 'call_b', type: 'function', function: { name: 'run_b', arguments: '{"path"' } }),
      chunk({ choices: [{ index: 0, delta: { content: 'between' }, finish_reason: null }] }),
      tc({ index: 0, function: { arguments: ':"ls"}' } }),
      tc({ index: 1, function: { arguments: ':"b.txt"}' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const evts = await runStream({
      model: 'claude-sonnet-4.6', stream: true,
      tools: [
        { name: 'run_a', input_schema: { type: 'object' } },
        { name: 'run_b', input_schema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: 'run both' }],
    }, frames);
    const wire = blockLedger(evts);
    const starts = wire.started.filter((s) => s.content_block?.type === 'tool_use');
    assert.equal(starts.length, 2);
    const byId = new Map(starts.map((s) => [s.content_block.id, s]));
    assert.equal(wire.argsByIndex.get(byId.get('call_a').index), '{"command":"ls"}');
    assert.equal(wire.argsByIndex.get(byId.get('call_b').index), '{"path":"b.txt"}');
    assert.equal(wire.text, 'between');
    assert.deepEqual(wire.deltasAfterStop, []);
  });

  it('surfaces an explicit error instead of a truncated tool_use when the call cannot be represented', async () => {
    // Arguments arrive with no id/name at all: a tool_use block cannot be opened,
    // and dropping the bytes silently would tell the client the turn completed.
    const frames = [
      tc({ index: 0, function: { arguments: '{"path":"x"}' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const evts = await runStream({
      model: 'claude-sonnet-4.6', stream: true, tools: READ_TOOLS,
      messages: [{ role: 'user', content: 'read it' }],
    }, frames);
    const wire = blockLedger(evts);
    assert.equal(wire.started.filter((s) => s.content_block?.type === 'tool_use').length, 0,
      'no truncated tool_use block is emitted');
    assert.equal(wire.errors.length, 1, 'the stream reports an explicit error');
    assert.equal(wire.sawMessageStop, false, 'the turn is not reported as complete');
  });
});

describe('Messages: tool_result.is_error propagation', () => {
  async function upstreamToolMessage({ toolName, isError, content }) {
    let captured = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6', max_tokens: 32, stream: false,
      tools: [{ name: toolName, input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: toolName, input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', ...(isError ? { is_error: true } : {}), content }] },
      ],
    }, {
      async handleChatCompletions(body) {
        captured = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.equal(result.status, 200);
    return captured.messages.find((m) => m.role === 'tool');
  }

  it('marks an error result for a non-Read tool so the model can see the failure', async () => {
    const failed = await upstreamToolMessage({ toolName: 'Bash', isError: true, content: 'Exit code 1: permission denied' });
    assert.match(failed.content, /^\[tool error\] /, `error flag is carried: ${JSON.stringify(failed.content)}`);
    assert.match(failed.content, /permission denied/);
  });

  it('leaves a successful result byte-identical', async () => {
    const ok = await upstreamToolMessage({ toolName: 'Bash', isError: false, content: 'Exit code 0' });
    assert.equal(ok.content, 'Exit code 0');
  });

  it('keeps the Read error note and adds the error flag', async () => {
    const stub = 'File content (377.3KB) exceeds maximum allowed size (256KB). Use offset and limit parameters.';
    const failed = await upstreamToolMessage({ toolName: 'Read', isError: true, content: stub });
    assert.match(failed.content, /^\[tool error\] /);
    assert.match(failed.content, /does not prove the full file body/);
  });
});

describe('Messages: duplicate forwarded tool names', () => {
  async function forwardedTools(tools) {
    let captured = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6', max_tokens: 32, stream: false, tools,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        captured = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.equal(result.status, 200);
    return captured.tools || [];
  }

  const callerWebSearch = {
    name: 'web_search', description: 'caller own',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
  };
  const serverWebSearch = { type: 'web_search_20250305', max_uses: 3 };

  it('lets the caller function shadow the server-tool conversion, in either array order', async () => {
    for (const tools of [[serverWebSearch, callerWebSearch], [callerWebSearch, serverWebSearch]]) {
      const forwarded = await forwardedTools(tools);
      assert.deepEqual(forwarded.map((t) => t.function?.name), ['web_search'], 'one definition per name');
      assert.equal(forwarded[0].function.description, 'caller own', 'the caller definition wins');
      assert.deepEqual(forwarded[0].function.parameters.properties, { q: { type: 'string' } });
    }
  });

  it('still converts the server tool when no caller function claims the name', async () => {
    const forwarded = await forwardedTools([serverWebSearch]);
    assert.deepEqual(forwarded.map((t) => t.function?.name), ['web_search']);
    assert.equal(forwarded[0].function.description, 'Search the web');
  });

  it('deduplicates repeated caller definitions (first wins)', async () => {
    const forwarded = await forwardedTools([
      callerWebSearch,
      { ...callerWebSearch, description: 'second copy' },
    ]);
    assert.deepEqual(forwarded.map((t) => t.function?.name), ['web_search']);
    assert.equal(forwarded[0].function.description, 'caller own');
  });
});

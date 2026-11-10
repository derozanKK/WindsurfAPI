// KH-017 / FixA02: an Anthropic tool_use block must never close on argument
// bytes that are not one complete JSON value. Before the fix, closeCurrentBlock()
// flushed the last fragment and sent content_block_stop unconditionally, so a
// truncated call (`{"path"`) looked successful: finish() then emitted a normal
// message_delta(stop_reason:'tool_use') + message_stop and the client executed a
// tool_use whose input could not be parsed. The only correct outcome is an
// `error` event (and no message_stop), while valid JSON — including split deltas
// and zero-argument calls — must stay on the normal path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const tc = (obj) => chunk({ choices: [{ index: 0, delta: { tool_calls: [obj] }, finish_reason: null }] });

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(c) { this.body += typeof c === 'string' ? c : c.toString('utf8'); return true; },
    end(c) {
      if (c) this.write(c);
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function parseEvents(raw) {
  return raw
    .trim()
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .filter((frame) => !frame.startsWith(':'))
    .map((frame) => {
      const lines = frame.split('\n');
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6) || '{}';
      return {
        event: lines.find((l) => l.startsWith('event: '))?.slice(7),
        data: JSON.parse(data),
      };
    });
}

function streamDeps(frames) {
  return {
    async handleChatCompletions() {
      return {
        status: 200,
        stream: true,
        async handler(res) {
          for (const frame of frames) res.write(frame);
          res.end();
        },
      };
    },
  };
}

async function runStream(frames) {
  const result = await handleMessages({
    model: 'claude-sonnet-4.6',
    stream: true,
    tools: [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'read it' }],
  }, streamDeps(frames));
  const res = fakeRes();
  await result.handler(res);
  return parseEvents(res.body);
}

function wire(events) {
  const args = new Map();
  for (const e of events) {
    if (e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta') {
      args.set(e.data.index, (args.get(e.data.index) || '') + e.data.delta.partial_json);
    }
  }
  return {
    errors: events.filter((e) => e.data?.type === 'error').map((e) => e.data.error),
    sawMessageStop: events.some((e) => e.data?.type === 'message_stop'),
    messageDelta: events.find((e) => e.data?.type === 'message_delta')?.data,
    starts: events.filter((e) => e.data?.type === 'content_block_start'),
    stops: events.filter((e) => e.data?.type === 'content_block_stop'),
    args,
  };
}

function assertFailed(w) {
  assert.equal(w.errors.length, 1, 'exactly one error event must be emitted');
  assert.match(w.errors[0].message, /tool call "Read"/i, 'the error names the malformed call');
  assert.equal(w.sawMessageStop, false, 'a malformed tool block must not reach message_stop');
  assert.equal(w.messageDelta, undefined, 'no successful message_delta (stop_reason:tool_use) may be emitted');
  // Earlier well-formed calls may already have closed; the malformed one is the
  // last block opened and must never receive a content_block_stop.
  const malformedIndex = w.starts.length ? w.starts[w.starts.length - 1].data.index : null;
  assert.equal(
    w.stops.some((s) => s.data.index === malformedIndex),
    false,
    'the malformed tool block must not receive a content_block_stop',
  );
}

describe('Messages streaming: tool_use argument JSON validation (KH-017)', () => {
  it('truncated JSON in a tool block produces an error event, not a successful call + message_stop', async () => {
    const w = wire(await runStream([
      tc({ index: 0, id: 'call_trunc', type: 'function', function: { name: 'Read', arguments: '{"path"' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]));
    assertFailed(w);
  });

  it('structurally invalid JSON (not just truncated) also fails the stream', async () => {
    const w = wire(await runStream([
      tc({ index: 0, id: 'call_bad', type: 'function', function: { name: 'Read', arguments: '{"path": }' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]));
    assertFailed(w);
  });

  it('one malformed parallel call fails the whole turn instead of emitting an executable pair', async () => {
    const w = wire(await runStream([
      tc({ index: 0, id: 'call_ok', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }),
      tc({ index: 1, id: 'call_bad', type: 'function', function: { name: 'Read', arguments: '{"path":' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]));
    assertFailed(w);
  });

  it('valid JSON control stays green: complete args close normally and stop_reason is tool_use', async () => {
    const w = wire(await runStream([
      tc({ index: 0, id: 'call_ok', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]));
    assert.equal(w.errors.length, 0, 'valid JSON emits no error');
    assert.equal(w.sawMessageStop, true, 'valid JSON reaches message_stop');
    assert.equal(w.messageDelta?.delta?.stop_reason, 'tool_use');
    assert.equal(w.starts.length, 1);
    assert.equal(w.stops.length, 1);
    assert.equal(w.args.get(w.starts[0].data.index), '{"path":"a.txt"}');
  });

  it('valid JSON split across deltas stays green', async () => {
    const w = wire(await runStream([
      tc({ index: 0, id: 'call_split', type: 'function', function: { name: 'Read', arguments: '{"path"' } }),
      tc({ index: 0, function: { arguments: ':"a.txt"}' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]));
    assert.equal(w.errors.length, 0, 'split but complete JSON emits no error');
    assert.equal(w.sawMessageStop, true);
    assert.equal(w.messageDelta?.delta?.stop_reason, 'tool_use');
    assert.equal(w.args.get(w.starts[0].data.index), '{"path":"a.txt"}');
  });

  it('zero-argument tool call remains a valid control', async () => {
    const w = wire(await runStream([
      tc({ index: 0, id: 'call_noargs', type: 'function', function: { name: 'Read' } }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]));
    assert.equal(w.errors.length, 0, 'an absent argument string means an empty input object, not invalid JSON');
    assert.equal(w.sawMessageStop, true);
    assert.equal(w.messageDelta?.delta?.stop_reason, 'tool_use');
    assert.deepEqual(w.starts[0].data.content_block.input, {});
  });
});

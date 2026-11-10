// swe/devin client-visible tool-call id shape.
//
// Live finding (ToolMatrixLive §7): the Devin Connect upstream
// issues ChatToolCall ids in its own dialect — `get_weather:0#<uuid>` — and the
// adapter forwarded them verbatim. OpenAI clients expect an opaque
// `call_<opaque>` id. These tests pin the CLIENT-VISIBLE shape and the
// INTERNAL correlation: the id written back to the upstream wire (native
// multi-turn replay) is the exact id the upstream issued.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toChatCompletion,
  streamChatCompletion,
  __setStreamChatForTest,
} from '../src/devin-connect-openai.js';
import { toClientToolCallId, fromClientToolCallId } from '../src/tool-ids.js';

const CALL_ID_RE = /^call_[A-Za-z0-9_-]+$/;
// Verbatim ids from the live swe-2-medium matrix run (single + parallel).
const SWE_ID = 'get_weather:0#62786027996b4c40886cc7262bdf7382';
const SWE_ID_2 = 'get_time:1#bc94259feb84474faffc448f505465c8';

function fakeStream(events, capture) {
  return async function* (params) {
    if (capture) capture.push(params);
    for (const ev of events) yield ev;
  };
}

afterEach(() => __setStreamChatForTest(null));

describe('client-visible tool-call id shape (devin connect)', () => {
  it('normalizes the live swe-2-medium id in a non-stream completion', async () => {
    __setStreamChatForTest(fakeStream([
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ id: SWE_ID, name: 'get_weather', arguments: '{"city":"Paris","unit":"c"}' }],
      },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-2-medium', messages: [] });
    const [call] = body.choices[0].message.tool_calls;
    assert.match(call.id, CALL_ID_RE);
    assert.equal(call.function.name, 'get_weather');
    assert.deepEqual(JSON.parse(call.function.arguments), { city: 'Paris', unit: 'c' });
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
  });

  it('normalizes every id of a parallel native batch and keeps them distinct', async () => {
    __setStreamChatForTest(fakeStream([
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [
          { id: SWE_ID, name: 'get_weather', arguments: '{"city":"Paris"}' },
          { id: SWE_ID_2, name: 'get_time', arguments: '{"city":"Tokyo"}' },
        ],
      },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-2-medium', messages: [] });
    const calls = body.choices[0].message.tool_calls;
    assert.equal(calls.length, 2);
    for (const call of calls) assert.match(call.id, CALL_ID_RE);
    assert.notEqual(calls[0].id, calls[1].id);
  });

  it('normalizes the live id on the streaming surface', async () => {
    __setStreamChatForTest(fakeStream([
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ id: SWE_ID, name: 'get_weather', arguments: '{"city":"Paris"}' }],
      },
    ]));
    const frames = [];
    const result = await streamChatCompletion(
      { model: 'swe-2-medium', messages: [] },
      (d) => frames.push(d),
    );
    const delta = frames
      .flatMap((f) => f.choices?.[0]?.delta?.tool_calls || [])[0];
    assert.ok(delta, 'a tool_calls delta was emitted');
    assert.match(delta.id, CALL_ID_RE);
    assert.equal(result.finish_reason, 'tool_calls');
    assert.match(result.toolCalls[0].id, CALL_ID_RE);
  });

  it('leaves an already-conforming call_ id untouched', async () => {
    __setStreamChatForTest(fakeStream([
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ id: 'call_kJ0JyANNa0oiyUpqioI6H7p9', name: 'get_weather', arguments: '{}' }],
      },
    ]));
    const { body } = await toChatCompletion({ model: 'gpt-6-luna-max', messages: [] });
    assert.equal(body.choices[0].message.tool_calls[0].id, 'call_kJ0JyANNa0oiyUpqioI6H7p9');
  });

  it('generates a conforming fallback when upstream omitted the id', async () => {
    __setStreamChatForTest(fakeStream([
      {
        type: 'finish', reason: 'stop', usage: null,
        toolCalls: [{ name: 'get_weather', arguments: '{}' }],
      },
    ]));
    const { body } = await toChatCompletion({ model: 'swe-2-medium', messages: [] });
    assert.match(body.choices[0].message.tool_calls[0].id, CALL_ID_RE);
  });
});

describe('internal correlation across the egress boundary', () => {
  it('maps the same upstream id to the same client id (stable across turns)', () => {
    assert.equal(toClientToolCallId(SWE_ID), toClientToolCallId(SWE_ID));
    assert.notEqual(toClientToolCallId(SWE_ID), toClientToolCallId(SWE_ID_2));
  });

  it('round-trips a normalized id back to the upstream id', () => {
    const clientId = toClientToolCallId(SWE_ID);
    assert.match(clientId, CALL_ID_RE);
    assert.equal(fromClientToolCallId(clientId), SWE_ID);
  });

  it('does not rewrite ids that are not ours', () => {
    assert.equal(fromClientToolCallId('call_abc'), 'call_abc');
    assert.equal(fromClientToolCallId('call_e1_!!!not-base64'), 'call_e1_!!!not-base64');
    assert.equal(fromClientToolCallId('tc1'), 'tc1');
  });

  it('restores upstream ids on the wire when native history is replayed', async () => {
    const captured = [];
    __setStreamChatForTest(fakeStream(
      [{ type: 'content', text: 'ok' }, { type: 'finish', reason: 'stop', usage: null }],
      captured,
    ));
    const clientId = toClientToolCallId(SWE_ID);
    await toChatCompletion({
      model: 'swe-2-medium',
      messages: [
        {
          role: 'assistant', content: null,
          tool_calls: [{
            id: clientId, type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          }],
        },
        { role: 'tool', tool_call_id: clientId, content: '{"temp":21}' },
      ],
    });
    const wire = captured[0].messages;
    assert.equal(wire[0].tool_calls[0].id, SWE_ID, 'assistant #6 keeps the upstream id');
    assert.equal(wire[1].tool_call_id, SWE_ID, 'tool result #7 keeps the upstream id');
  });

  it('leaves unrelated ids on the wire untouched', async () => {
    const captured = [];
    __setStreamChatForTest(fakeStream(
      [{ type: 'content', text: 'ok' }, { type: 'finish', reason: 'stop', usage: null }],
      captured,
    ));
    await toChatCompletion({
      model: 'swe-2-medium',
      messages: [
        {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'call_abc', type: 'function',
            function: { name: 'get_weather', arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_abc', content: 'ok' },
      ],
    });
    assert.equal(captured[0].messages[0].tool_calls[0].id, 'call_abc');
    assert.equal(captured[0].messages[1].tool_call_id, 'call_abc');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';

const LONG = 'a'.repeat(128);

function fakeRes() {
  return {
    body: '', writableEnded: false,
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.write(c); this.writableEnded = true; },
    on() { return this; }, once() { return this; },
  };
}

function events(raw) {
  return raw.trim().split('\n\n').filter(Boolean).map((frame) => {
    const lines = frame.split('\n');
    return {
      event: lines.find((l) => l.startsWith('event: '))?.slice(7),
      data: JSON.parse(lines.find((l) => l.startsWith('data: '))?.slice(6) || '{}'),
    };
  });
}

describe('Anthropic tool-name boundary', () => {
  it('forwards a 64-char wire name and restores the 128-char client name on stream egress', async () => {
    let forwarded = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6', stream: true,
      tools: [{ name: LONG, description: 'x', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'go' }],
    }, {
      async handleChatCompletions(body) {
        forwarded = body.tools[0].function.name;
        return {
          status: 200, stream: true,
          async handler(res) {
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: forwarded, arguments: '{}' } }] } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_use' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    assert.equal(forwarded.length, 64);
    const start = events(res.body).find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
    assert.equal(start.data.content_block.name, LONG);
  });

  it('reserves history-only names before sanitizing declared tools', async () => {
    let captured = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6', stream: true,
      tools: [{ name: 'a/b', description: 'x', input_schema: { type: 'object' } }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'a_b', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
    }, {
      async handleChatCompletions(body) {
        captured = body;
        return {
          status: 200, stream: true,
          async handler(res) {
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: captured.tools[0].function.name, arguments: '{}' } }] } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_use' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    assert.equal(captured.tools[0].function.name !== 'a_b', true);
    assert.equal(captured.messages[0].tool_calls[0].function.name, 'a_b');
    const start = events(res.body).find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
    assert.equal(start.data.content_block.name, 'a/b');
  });

  it('accumulates a split stream function name before opening the tool block', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6', stream: true,
      tools: [{ name: 'foo.bar', description: 'x', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'go' }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200, stream: true,
          async handler(res) {
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'foo_' } }] } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'bar', arguments: '{}' } }] } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_use' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
          },
        };
      },
    });
    const res = fakeRes();
    await result.handler(res);
    const start = events(res.body).find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
    assert.equal(start.data.content_block.name, 'foo.bar');
  });

  it('restores the client name on the non-stream path and maps tool_choice', async () => {
    let captured = null;
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      tools: [{ name: LONG, description: 'x', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: LONG },
      messages: [{ role: 'user', content: 'go' }],
    }, {
      async handleChatCompletions(body) {
        captured = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: body.tools[0].function.name, arguments: '{}' } }] },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });
    assert.equal(captured.tool_choice.function.name, captured.tools[0].function.name);
    assert.equal(result.body.content.find((b) => b.type === 'tool_use').name, LONG);
  });
});

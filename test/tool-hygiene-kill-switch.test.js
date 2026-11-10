import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';
import { responsesToChat, chatToResponse } from '../src/handlers/responses.js';
import { geminiToOpenAI } from '../src/handlers/gemini.js';

const rawId = 'x'.repeat(70);

function withHygiene(value, fn) {
  const previous = process.env.WINDSURFAPI_TOOL_HYGIENE;
  if (value === undefined) delete process.env.WINDSURFAPI_TOOL_HYGIENE;
  else process.env.WINDSURFAPI_TOOL_HYGIENE = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.WINDSURFAPI_TOOL_HYGIENE;
      else process.env.WINDSURFAPI_TOOL_HYGIENE = previous;
    });
}

afterEach(() => {
  delete process.env.WINDSURFAPI_TOOL_HYGIENE;
});

describe('WINDSURFAPI_TOOL_HYGIENE=0 restores raw passthrough', () => {
  it('leaves the Anthropic request tool name raw', async () => {
    await withHygiene('0', async () => {
      let captured = null;
      await handleMessages({
        model: 'claude-sonnet-4.6',
        tools: [{ name: 'foo.bar', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'go' }],
      }, {
        handleChatCompletions: async (body) => {
          captured = body;
          return { status: 200, body: { model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} } };
        },
      });
      assert.equal(captured.tools[0].function.name, 'foo.bar');
      assert.equal(captured.__toolNameMap, undefined);
    });
  });

  it('leaves the Responses request tool name raw', async () => {
    await withHygiene('0', async () => {
      const chat = responsesToChat({
        model: 'gpt-4o',
        input: 'hi',
        tools: [{ type: 'function', name: 'foo.bar', parameters: { type: 'object' } }],
      });
      assert.equal(chat.tools[0].function.name, 'foo.bar');
      assert.equal(chat.__toolNameMap, undefined);
    });
  });

  it('leaves a Gemini explicit function id raw', async () => {
    await withHygiene('0', async () => {
      const out = geminiToOpenAI({
        contents: [{ role: 'model', parts: [{ functionCall: { id: rawId, name: 'f', args: {} } }] }],
      });
      assert.equal(out.messages[0].tool_calls[0].id, rawId);
    });
  });

  it('leaves the Responses egress call id raw', async () => {
    await withHygiene('0', async () => {
      const response = chatToResponse({
        choices: [{
          message: { tool_calls: [{ id: rawId, function: { name: 'f', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }],
      }, 'gpt-4o', 'resp_1', 'msg_1', [{ type: 'function', name: 'f' }]);
      const item = response.output.find((o) => o.type === 'function_call');
      assert.equal(item.call_id, rawId);
    });
  });

  it('leaves the Gemini request tool name raw', async () => {
    await withHygiene('0', async () => {
      const out = geminiToOpenAI({
        contents: [{ role: 'user', parts: [{ text: 'x' }] }],
        tools: [{ functionDeclarations: [{ name: 'foo.bar' }] }],
      });
      assert.equal(out.tools[0].function.name, 'foo.bar');
      assert.equal(out.__toolNameMap, undefined);
    });
  });

});

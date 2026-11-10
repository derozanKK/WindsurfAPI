// A07/KH-004: the non-stream Cascade path received the RAW request tools[],
// while the stream path received effectiveTools (tool_choice already applied).
// A fake XML/thinking call for a tool the caller excluded therefore surfaced
// only on the non-stream path. These tests pin stream/non-stream parity for
// tool_choice:none and forced choices, plus the original-contract validation
// that turns a forced-but-undeclared tool into a 400 before any upstream call.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { addAccountByKey, getApiKey, removeAccount } from '../src/auth.js';

const createdAccountIds = [];

afterEach(() => {
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
});

function fnTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  };
}

function newAccount(label) {
  const account = addAccountByKey(
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    label,
  );
  createdAccountIds.push(account.id);
  return account;
}

function chatDeps(Client) {
  return {
    waitForAccount(tried, _signal, _maxWaitMs, modelKey) {
      return tried.length === 0 ? getApiKey(tried, modelKey) : null;
    },
    ensureLs: async () => {},
    getLsFor: () => ({ port: 17777, csrfToken: 'csrf', generation: 1 }),
    WindsurfClient: Client,
  };
}

class XmlBashClient {
  constructor({ text, thinking = '', endReason = 'idle_done' } = {}) {
    this.text = text;
    this.thinking = thinking;
    this.endReason = endReason;
    this.calls = 0;
  }

  async cascadeChat(_messages, _modelEnum, _modelUid, opts = {}) {
    this.calls++;
    if (opts.onChunk) {
      if (this.thinking) await opts.onChunk({ text: '', thinking: this.thinking, isError: false });
      if (this.text) await opts.onChunk({ text: this.text, thinking: '', isError: false });
    }
    const chunks = opts.onChunk
      ? []
      : [{ text: this.text, thinking: this.thinking, isError: false }];
    chunks.endReason = this.endReason;
    chunks.toolCalls = [];
    return chunks;
  }
}

function history() {
  return [
    { role: 'user', content: 'earlier request' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_hist_1',
        type: 'function',
        function: { name: 'Bash', arguments: '{"command":"ls"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_hist_1', content: 'file.txt' },
    { role: 'user', content: 'now echo hi' },
  ];
}

const BASH_XML = '<tool_call>{"name":"Bash","arguments":{"command":"echo hi"}}</tool_call>';

async function runChat(body, options) {
  newAccount('tool-choice');
  const holder = { instance: null };
  class Client extends XmlBashClient {
    constructor(...args) {
      super(options);
      holder.instance = this;
    }
  }
  const result = await handleChatCompletions(body, chatDeps(Client));
  return { result, client: holder.instance };
}

function collectChatToolCalls(bodyText) {
  const calls = [];
  for (const frame of bodyText.split('\n\n')) {
    const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    if (!data || data === '[DONE]') continue;
    let parsed;
    try { parsed = JSON.parse(data); } catch { continue; }
    for (const choice of parsed.choices || []) {
      for (const tc of choice.delta?.tool_calls || []) calls.push(tc);
      for (const tc of choice.message?.tool_calls || []) calls.push(tc);
    }
  }
  return calls;
}

describe('A07 tool_choice parity and contract', () => {
  it('non-stream tool_choice:none with history emits no tool_calls and matches the stream result', async () => {
    const request = {
      model: 'gemini-2.5-flash',
      tools: [fnTool('Bash'), fnTool('Read')],
      tool_choice: 'none',
      messages: history(),
    };

    const { result: nonStream } = await runChat({ ...request, stream: false }, { text: BASH_XML });
    assert.equal(nonStream.status, 200);
    assert.equal(nonStream.body.choices[0].message.tool_calls, undefined,
      'tool_choice:none must drop a fake XML Bash call on the non-stream path');

    const { result: stream } = await runChat({ ...request, stream: true }, { text: BASH_XML });
    assert.equal(stream.status, 200);
    const res = {
      body: '', writableEnded: false,
      write(chunk) { this.body += String(chunk); return true; },
      end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; },
      on() { return this; }, removeListener() {},
    };
    await stream.handler(res);
    assert.equal(collectChatToolCalls(res.body).length, 0,
      'the stream path already filters against effectiveTools; non-stream must agree');
  });

  it('forced choice absent from tools returns 400 before upstream', async () => {
    const { result, client } = await runChat({
      model: 'gemini-2.5-flash',
      stream: false,
      tools: [fnTool('Read')],
      tool_choice: { type: 'function', function: { name: 'Bash' } },
      messages: [{ role: 'user', content: 'run echo hi' }],
    }, { text: BASH_XML });

    assert.equal(result.status, 400);
    assert.equal(result.body.error.type, 'invalid_request_error');
    assert.equal(result.body.error.param, 'tool_choice');
    assert.equal(result.body.error.code, 'tool_choice_tool_not_declared');
    assert.equal(client?.calls || 0, 0, 'a rejected contract must not spend an upstream turn');
  });

  it('forced Read does not admit a Bash call on either path', async () => {
    const request = {
      model: 'gemini-2.5-flash',
      tools: [fnTool('Bash'), fnTool('Read')],
      tool_choice: { type: 'function', function: { name: 'Read' } },
      messages: history(),
    };

    const { result: nonStream } = await runChat({ ...request, stream: false }, { text: BASH_XML });
    assert.equal(nonStream.status, 200);
    assert.equal(nonStream.body.choices[0].message.tool_calls, undefined,
      'a forced Read must not admit the non-forced Bash call');

    const { result: stream } = await runChat({ ...request, stream: true }, { text: BASH_XML });
    const res = {
      body: '', writableEnded: false,
      write(chunk) { this.body += String(chunk); return true; },
      end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; },
      on() { return this; }, removeListener() {},
    };
    await stream.handler(res);
    assert.equal(collectChatToolCalls(res.body).length, 0);
  });

  it('a tool_call recovered from thinking is filtered by tool_choice:none too', async () => {
    const { result } = await runChat({
      model: 'gemini-2.5-flash',
      stream: false,
      tools: [fnTool('Bash'), fnTool('Read')],
      tool_choice: 'none',
      messages: history(),
    }, { text: 'plain answer', thinking: BASH_XML });
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.tool_calls, undefined,
      'the thinking-tail recovery must use the effective list');
  });
});

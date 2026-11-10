// #141 regression pin — the proxy must NOT replay the previous instruction.
//
// The issue reports that a second Claude Code instruction re-executes the
// first. The probe on 2026-10-25 (evidence/Wave5-Replay.md §1) showed the
// request the proxy builds for the second instruction contains instruction 1
// exactly once, the tool pair exactly once, and instruction 2 exactly once —
// both in the OpenAI-shaped history and on the native upstream wire. The
// re-execution therefore is not proxy-side duplication.
//
// This test pins that measured shape so a future history rewrite cannot start
// duplicating the previous instruction or the previous tool call silently. It
// is a negative pin, not a fix: there is no code path to mutate here, so it has
// no mutation spec (a mutation would have to inject duplication that does not
// exist).
//
// The body is the real Claude Code 2.1.306 second-request shape recorded in the
// evidence: system prompt, env+instruction-1 user turn, assistant tool_use,
// tool_result, assistant text, then the second instruction.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { handleMessages } from '../src/handlers/messages.js';
import { normalizeMessagesForCascade } from '../src/handlers/tool-emulation.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const INSTR1 = '进入 Trae-Proxy 目录，看看内容';
const INSTR2 = '读取 README.md';
const TOOL_ID = 'toolu_01A';

const body = () => ({
  model: 'claude-opus-4-6',
  stream: false,
  system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: `- Platform: win32\n\n${INSTR1}` }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'List the directory.' },
      { type: 'tool_use', id: TOOL_ID, name: 'Bash', input: { command: 'ls -la Trae-Proxy' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: TOOL_ID, content: 'Dockerfile\nLICENSE\nREADME.md' },
    ] },
    { role: 'assistant', content: [{ type: 'text', text: '已进入 Trae-Proxy 目录，内容如下：Dockerfile LICENSE README.md' }] },
    { role: 'user', content: [{ type: 'text', text: INSTR2 }] },
  ],
});

const count = (haystack, needle) => haystack.split(needle).length - 1;
const textOf = (m) => (typeof m?.content === 'string'
  ? m.content
  : Array.isArray(m?.content) ? m.content.map((p) => p?.text || '').join('') : '');

async function captureHistory() {
  let captured = null;
  const res = await handleMessages(body(), {
    handleChatCompletions: async (chatBody) => {
      captured = chatBody;
      return {
        status: 200,
        body: {
          model: chatBody.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: {},
        },
      };
    },
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(captured?.messages), 'the chat layer must have been reached');
  return captured.messages;
}

const buildWire = (messages) => {
  const originalUUID = crypto.randomUUID;
  let n = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  syncBuiltinESMExports();
  try {
    return buildGetChatMessageRequest({
      token: 'wire-test', model: 'swe-1-7', messages,
      sessionId: 'wire-session', sessionModelConfig: { id: 'wire-config', turn: 1 },
      deviceSeed: 'wire-device', nativeToolCall: true, env: {},
    });
  } finally {
    crypto.randomUUID = originalUUID;
    syncBuiltinESMExports();
  }
};

describe('#141 the second instruction does not replay the first', () => {
  it('H5-T1: the OpenAI-shaped history carries each instruction and the tool pair once', async () => {
    const messages = await captureHistory();
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    const flat = messages.map(textOf).join('\n');
    assert.equal(count(flat, INSTR1), 1, 'instruction 1 appears exactly once');
    assert.equal(count(flat, INSTR2), 1, 'instruction 2 appears exactly once');
    const calls = messages.flatMap((m) => m.tool_calls || []);
    assert.deepEqual(calls.map((c) => c.id), [TOOL_ID], 'the previous call is not duplicated');
    assert.deepEqual(
      messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
      [TOOL_ID],
      'the result is paired to exactly one call',
    );
  });

  it('H5-T2: the native wire carries each instruction and the call/result pair once', async () => {
    const messages = await captureHistory();
    const normalized = normalizeMessagesForCascade(messages, [], {
      modelKey: 'swe-1-7', route: 'devin_connect', injectUserPreamble: false,
      stripOrphans: true, nativeStructured: true,
    });
    const items = getAllFields(parseFields(buildWire(normalized)), 3)
      .filter((f) => f.wireType === 2).map((f) => parseFields(f.value));
    assert.deepEqual(items.map((f) => getField(f, 2, 0).value), [1, 2, 4, 2, 1]);
    const texts = items.map((f) => getAllFields(f, 3)
      .filter((x) => x.wireType === 2).map((x) => x.value.toString('utf8')).join(''));
    assert.equal(texts.reduce((n, t) => n + count(t, INSTR1), 0), 1, 'instruction 1 is on the wire once');
    assert.equal(texts.reduce((n, t) => n + count(t, INSTR2), 0), 1, 'instruction 2 is on the wire once');
    const callIds = items.flatMap((f) => getAllFields(f, 6)
      .map((c) => getAllFields(parseFields(c.value), 1)[0]?.value.toString('utf8')));
    const resultIds = items.flatMap((f) => getAllFields(f, 7).map((x) => x.value.toString('utf8')));
    assert.deepEqual(callIds, [TOOL_ID], 'the call id is emitted once');
    assert.deepEqual(resultIds, [TOOL_ID], 'the result id is emitted once');
  });
});

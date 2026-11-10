// The cache must store what the client actually saw, not the raw upstream
// accumulator. Tool markup that the streaming parser filtered (an undeclared
// call, or an echoed <tool_result>) stays in `content` but never reaches the
// wire; caching `content` would replay that markup as the visible answer.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { streamChatCompletion, __setStreamChatForTest } from '../src/devin-connect-openai.js';

afterEach(() => __setStreamChatForTest(null));

test('delivered excludes filtered tool markup while content keeps the raw text', async () => {
  __setStreamChatForTest(async function* () {
    yield { type: 'content', text: 'before <tool_call>{"name":"nope","arguments":"{}"}</tool_call> after' };
    yield { type: 'finish', reason: 'stop' };
  });

  const frames = [];
  const result = await streamChatCompletion(
    { model: 'swe-1-6-slow', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    frame => frames.push(frame),
    { emulateTools: true },
  );

  assert.match(result.content, /<tool_call>/, 'raw accumulator keeps the markup');
  assert.equal(result.delivered, 'before  after', 'the client-visible text has the undeclared call removed');
  const visible = frames
    .flatMap(frame => frame.choices || [])
    .map(choice => choice.delta?.content || '')
    .join('');
  assert.equal(visible, result.delivered, 'delivered must equal the content actually sent');
  assert.doesNotMatch(visible, /tool_call/);
});

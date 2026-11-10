import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistoryTail, TRUNCATION_PLACEHOLDER } from '../src/history-normalize.js';
import { INTERRUPTED_RESULT_TEXT } from '../src/tool-ids.js';

const user = (content) => ({ role: 'user', content });

describe('history tail normalization', () => {
  it('strips a leading tool result but keeps a legitimate following assistant turn', () => {
    const messages = [
      { role: 'tool', tool_call_id: 'call_1', content: 'old output' },
      { role: 'assistant', content: 'old answer' },
      user('new question'),
    ];
    const out = normalizeHistoryTail(messages);
    assert.deepEqual(out, [{ role: 'assistant', content: 'old answer' }, user('new question')]);
  });

  it('preserves a leading system message and puts the placeholder after it', () => {
    const messages = [
      { role: 'system', content: 'rules' },
      { role: 'tool', tool_call_id: 'call_1', content: 'old output' },
      user('q'),
    ];
    const out = normalizeHistoryTail(messages, { placeholder: TRUNCATION_PLACEHOLDER });
    assert.equal(out[0].role, 'system');
    assert.equal(out[1].content, TRUNCATION_PLACEHOLDER);
    assert.equal(out[2].content, 'Understood.');
    assert.equal(out[3].content, 'q');
  });

  it('folds a middle orphan tool result into the preceding user text', () => {
    const messages = [
      user('question'),
      { role: 'tool', tool_call_id: 'call_missing', content: 'orphan body' },
      { role: 'assistant', content: 'answer' },
    ];
    const out = normalizeHistoryTail(messages);
    assert.equal(out.length, 2);
    assert.match(out[0].content, /question/);
    assert.match(out[0].content, /\[tool result for call_missing\]/);
    assert.match(out[0].content, /orphan body/);
  });

  it('synthesizes a missing result only for a non-trailing assistant call', () => {
    const call = { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } };
    const messages = [
      { role: 'assistant', content: null, tool_calls: [call] },
      user('next'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ];
    const out = normalizeHistoryTail(messages, { synthesizeMissing: true });
    const synthesized = out.filter((m) => m.role === 'tool');
    assert.equal(synthesized.length, 1);
    assert.equal(synthesized[0].tool_call_id, 'call_1');
    assert.equal(synthesized[0].content, INTERRUPTED_RESULT_TEXT);
  });

  it('prepends the placeholder pair only when something was stripped', () => {
    const stripped = normalizeHistoryTail([
      { role: 'tool', tool_call_id: 'call_1', content: 'x' },
      user('q'),
    ], { placeholder: TRUNCATION_PLACEHOLDER });
    assert.equal(stripped[0].content, TRUNCATION_PLACEHOLDER);
    assert.equal(stripped[1].content, 'Understood.');

    const intact = [user('q'), { role: 'assistant', content: 'a' }];
    assert.equal(normalizeHistoryTail(intact, { placeholder: TRUNCATION_PLACEHOLDER }), intact);
  });

  it('returns the same array when nothing changed', () => {
    const messages = [user('q'), { role: 'assistant', content: 'a' }];
    assert.equal(normalizeHistoryTail(messages), messages);
  });
});

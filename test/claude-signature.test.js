import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isClaudeThinkingSignature } from '../src/claude-signature.js';

describe('Claude thinking signature transport envelopes', () => {
  for (const [family, signature] of Object.entries({
    E: 'EggKBggLEgKquxgB',
    C: 'CAISCAoGCAsSAqq7GAE=',
    R: 'RWdnS0JnZ0xFZ0txdXhnQg==',
    Q: 'Q0FJU0NBb0dDQXNTQXFxN0dBRT0=',
  })) {
    it(`accepts the supported ${family} envelope without rewriting it`, () => {
      assert.equal(isClaudeThinkingSignature(signature), true);
    });
  }

  it('rejects foreign, prefixed, and malformed envelopes', () => {
    for (const signature of ['gAAAA-foreign-envelope', 'cache#EggKBggLEgKquxgB', 'EggA', 'not-base64']) {
      assert.equal(isClaudeThinkingSignature(signature), false);
    }
  });
});

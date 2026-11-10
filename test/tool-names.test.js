import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ANTHROPIC_TOOL_NAME,
  MAX_UPSTREAM_TOOL_NAME,
  buildToolNameMap,
  isValidToolName,
  restoreToolName,
  sanitizeToolName,
} from '../src/tool-names.js';

describe('tool names', () => {
  it('keeps a 128-char Anthropic name valid but truncates it for upstream', () => {
    const name = 'a'.repeat(MAX_ANTHROPIC_TOOL_NAME);
    assert.equal(isValidToolName(name), true);
    const { toUpstream, toClient } = buildToolNameMap([{ name }]);
    const wire = toUpstream.get(name);
    assert.equal(wire.length, MAX_UPSTREAM_TOOL_NAME);
    assert.equal(restoreToolName(wire, { toClient }), name);
  });

  it('does not rewrite a valid name when an invalid one sanitizes into it', () => {
    const { toUpstream } = buildToolNameMap(['a/b', 'a_b']);
    assert.equal(toUpstream.get('a_b'), 'a_b');
    assert.notEqual(toUpstream.get('a/b'), 'a_b');
    assert.equal(toUpstream.get('a/b').length <= MAX_UPSTREAM_TOOL_NAME, true);
  });

  it('sanitizes invalid characters and keeps distinct names distinct', () => {
    const { toUpstream, toClient } = buildToolNameMap(['read file', 'read-file', 'read_file']);
    const wires = [...toUpstream.values()];
    assert.equal(new Set(wires).size, 3);
    assert.equal(toUpstream.get('read-file'), 'read-file');
    assert.equal(toClient.get(toUpstream.get('read file')), 'read file');
  });

  it('never lets a normalized caller name become a native tool name', () => {
    const { toUpstream } = buildToolNameMap(['shell.command']);
    assert.notEqual(toUpstream.get('shell.command'), 'shell_command');
    const both = buildToolNameMap(['shell.command', 'shell_command']);
    assert.equal(both.toUpstream.get('shell_command'), 'shell_command');
    assert.notEqual(both.toUpstream.get('shell.command'), 'shell_command');
  });

  it('is deterministic for the same input', () => {
    const a = buildToolNameMap(['x/y', 'z'.repeat(80)]);
    const b = buildToolNameMap(['x/y', 'z'.repeat(80)]);
    assert.deepEqual([...a.toUpstream], [...b.toUpstream]);
  });

  it('handles empty and duplicate names without throwing', () => {
    const { toUpstream } = buildToolNameMap([{ name: '' }, { name: 'ok' }, { name: 'ok' }, null]);
    assert.equal(toUpstream.size, 1);
    assert.equal(toUpstream.get('ok'), 'ok');
  });

  it('never exceeds a small maxLen', () => {
    assert.equal(sanitizeToolName('abcdefghijklmnop', 8).length, 8);
    assert.equal(sanitizeToolName('abcdefghijklmnop', 4).length, 4);
  });

  it('sanitizeToolName never returns empty', () => {
    assert.equal(sanitizeToolName('///'), '___');
    assert.equal(sanitizeToolName(''), '');
    assert.equal(sanitizeToolName(null), '');
  });
});

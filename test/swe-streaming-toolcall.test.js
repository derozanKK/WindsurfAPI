import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ToolCallStreamParser,
  parseToolCallsFromText,
  pickToolDialect,
} from '../src/handlers/tool-emulation.js';

const xmlCall = (name, args) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

function collectStreaming(text, modelKey, chunkSize = text.length) {
  const parser = new ToolCallStreamParser({ modelKey });
  let outputText = '';
  const toolCalls = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    const result = parser.feed(text.slice(i, i + chunkSize));
    outputText += result.text;
    toolCalls.push(...result.toolCalls);
  }
  const result = parser.flush();
  return {
    text: outputText + result.text,
    toolCalls: [...toolCalls, ...result.toolCalls],
  };
}

describe('SWE dialect selection', () => {
  it('selects only observed SWE 1.5/1.6/1.7 variants', () => {
    for (const modelKey of [
      'swe-1.5', 'swe-1.5-fast', 'swe-1.6', 'swe-1.7', 'swe-1-7-medium',
    ]) assert.equal(pickToolDialect(modelKey), 'kimi_k2', modelKey);
    assert.equal(pickToolDialect('swe-1-6-slow'), 'openai_json_xml');
    assert.equal(pickToolDialect('swe-1-7-lightning'), 'openai_json_xml');
    for (const modelKey of ['swe-1.8', 'swe-2.0', 'swe-9-future']) {
      assert.equal(pickToolDialect(modelKey), 'openai_json_xml', modelKey);
    }
  });
});

describe('kimi_k2 XML compatibility fallback', () => {
  it('extracts a complete XML JSON call across arbitrary chunk splits', () => {
    const input = `Before ${xmlCall('Read', { file_path: 'a.js' })} after`;
    const result = collectStreaming(input, 'swe-1-7', 3);
    assert.equal(result.text, 'Before  after');
    assert.deepEqual(result.toolCalls.map(({ name, argumentsJson }) => ({ name, argumentsJson })), [
      { name: 'Read', argumentsJson: '{"file_path":"a.js"}' },
    ]);
  });

  it('extracts multiple XML calls while preserving surrounding prose', () => {
    const input = `start ${xmlCall('Read', { path: 'a' })} middle ${xmlCall('Bash', { command: 'ls' })} end`;
    const result = collectStreaming(input, 'swe-1-7', 1);
    assert.equal(result.text, 'start  middle  end');
    assert.deepEqual(result.toolCalls.map((call) => call.name), ['Read', 'Bash']);
  });

  it('preserves malformed and incomplete XML blocks as text', () => {
    const malformed = 'before <tool_call>{"name":}</tool_call> after';
    const incomplete = 'before <tool_call>{"name":"Read","arguments":{}';
    for (const input of [malformed, incomplete]) {
      const result = collectStreaming(input, 'swe-1-7', 2);
      assert.equal(result.toolCalls.length, 0);
      assert.equal(result.text, input);
    }
  });

  it('preserves an incomplete XML block even when its JSON body is complete', () => {
    const input = 'before <tool_call>{"name":"Read","arguments":{}}';
    const result = collectStreaming(input, 'swe-1-7', 2);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.text, input);
  });

  it('preserves source order when XML precedes a Kimi section-token call', () => {
    const sectionCall = '<|tool_calls_section_begin|><|tool_call_begin|>functions.Bash:0<|tool_call_argument_begin|>{"command":"ls"}<|tool_call_end|><|tool_calls_section_end|>';
    const input = `${xmlCall('Read', { file_path: 'a.js' })}${sectionCall}`;
    const result = collectStreaming(input, 'swe-1-7', 3);
    assert.equal(result.text, '');
    assert.deepEqual(result.toolCalls.map((call) => call.name), ['Read', 'Bash']);
  });

  it('matches non-streaming extraction for valid, prose, and malformed input', () => {
    for (const input of [
      `before ${xmlCall('Read', { path: 'a' })} after`,
      `${xmlCall('Read', {})}${xmlCall('Bash', { command: 'pwd' })}`,
      'before <tool_call>{"name":}</tool_call> after',
    ]) {
      const streaming = collectStreaming(input, 'swe-1-7', 4);
      const nonStreaming = parseToolCallsFromText(input, { modelKey: 'swe-1-7' });
      assert.deepEqual(
        { text: streaming.text, names: streaming.toolCalls.map((call) => call.name) },
        { text: nonStreaming.text, names: nonStreaming.toolCalls.map((call) => call.name) },
      );
    }
  });
});

// PR #252: the only real captured wire for the swe/Kimi tool dialect lives in
// test/_research/swe-1-7-kimi-tool-call-wire.json. Until this block the fixture
// was orphaned (zero references under test/ or src/), so the parser was pinned
// only against a hand-written approximation with `functions.Bash:0` and no space
// in the JSON. Feed the verbatim captured field instead.
describe('captured swe-1-7 Kimi wire field (PR #252)', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('./_research/swe-1-7-kimi-tool-call-wire.json', import.meta.url),
    'utf8',
  ));
  const raw = fixture.raw_response_field;

  it('fixture is the verbatim 156-byte captured field', () => {
    assert.equal(fixture.source.field_bytes, 156);
    assert.equal(Buffer.byteLength(raw, 'utf8'), 156, 'the fixture must not drift from the capture');
    assert.equal(
      createHash('sha256').update(raw).digest('hex').slice(0, 16),
      fixture.source.field_sha256_prefix,
      'the captured field must match the hash recorded with the evidence',
    );
    assert.equal(raw,
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.terminal:0<|tool_call_argument_begin|>'
      + '{"command": "pwd"}<|tool_call_end|><|tool_calls_section_end|>');
  });

  for (const [label, chunkSize] of [
    ['one byte at a time', 1],
    ['as a single chunk', raw.length],
  ]) {
    it(`parses the captured field ${label}`, () => {
      const result = collectStreaming(raw, 'swe-1-7', chunkSize);

      assert.equal(result.text, '', 'no protocol markup may leak into the text channel');
      assert.equal(result.toolCalls.length, 1, 'exactly one tool call is present in the field');
      const [call] = result.toolCalls;
      assert.equal(call.name, 'terminal');
      assert.deepEqual(JSON.parse(call.argumentsJson), { command: 'pwd' });
      assert.equal(raw.includes('{"command": "pwd"}'), true,
        'the captured wire keeps the JSON space; the parser normalizes it, not the fixture');
    });
  }
});

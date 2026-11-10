import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallStreamParser, TOOL_OVER_LIMIT_PLACEHOLDER } from '../src/handlers/tool-emulation.js';

// ---------------------------------------------------------------------------
// Over-limit tool_call bodies must be replaced with a placeholder instead of
// being flushed into the text stream. Raw flush pollutes the conversation
// with an unparsed blob (the client sees garbage prose instead of a tool
// call) — and for <tool_call> XML it also risks the wrapper being re-parsed
// as a real call on the next round.
// ---------------------------------------------------------------------------

const P = TOOL_OVER_LIMIT_PLACEHOLDER;

describe('over-limit tool_call bodies → placeholder, never raw text', () => {
  it('XML <tool_call> body over 65KB → placeholder, not the blob', () => {
    const parser = new ToolCallStreamParser({ dialect: 'glm47' });
    parser.feed('<tool_call>{"name":"X","arguments":{"data":"');
    let text = '';
    for (let i = 0; i < 40; i++) {
      const r = parser.feed('Z'.repeat(2000));
      if (r.text) text += r.text;
    }
    assert.ok(parser.buffer.length <= 65_536, 'buffer must stay bounded');
    assert.ok(text.includes(P), 'placeholder must appear');
    assert.ok(!text.includes('Z'.repeat(60000)), 'the blob itself must not leak as text');
  });

  it('XML <tool_call> body over 65KB with a close tag after → placeholder, call dropped', () => {
    const parser = new ToolCallStreamParser({ dialect: 'glm47' });
    parser.feed('<tool_call>{"name":"X"');
    let text = '';
    let calls = 0;
    // Force the ceiling first, then a proper close arrives — the oversized
    // call must stay dropped (no half-parsed tool call).
    for (let i = 0; i < 35; i++) { const r = parser.feed('W'.repeat(2000)); text += r.text || ''; }
    const r2 = parser.feed('}</tool_call>');
    text += r2.text || '';
    calls += (r2.toolCalls || []).length;
    assert.ok(text.includes(P), 'placeholder must appear');
    assert.equal(calls, 0, 'oversized call must not be emitted as a tool call');
    assert.ok(parser.buffer.length <= 65_536, 'buffer must stay bounded');
  });

  it('gpt_native bare-JSON sentinel over 65KB → placeholder (no raw dump)', () => {
    const parser = new ToolCallStreamParser({ dialect: 'gpt_native' });
    parser.feed('{"function_call"');
    let text = '';
    for (let i = 0; i < 40; i++) {
      const r = parser.feed('Y'.repeat(2000));
      if (r.text) text += r.text;
    }
    assert.ok(text.includes(P), 'placeholder must appear');
    assert.ok(!text.includes('Y'.repeat(60000)), 'the blob itself must not leak');
  });

  it('after XML oversize drop, the trailing close tag does NOT leak as text', () => {
    const parser = new ToolCallStreamParser({ dialect: 'glm47' });
    parser.feed('<tool_call>{"name":"X"');
    let text = '';
    for (let i = 0; i < 35; i++) { const r = parser.feed('W'.repeat(2000)); text += r.text || ''; }
    const r2 = parser.feed('}</tool_call>');
    text += r2.text || '';
    assert.ok(text.includes(P), 'placeholder appears');
    assert.ok(!text.includes('</tool_call>'), 'close tag must NOT leak as text');
    assert.ok(!text.includes('"}"'), 'close braces must NOT leak as text');
  });

  it('after gpt_native oversize drop, closing braces do NOT leak as text', () => {
    const parser = new ToolCallStreamParser({ dialect: 'gpt_native' });
    parser.feed('{"function_call":{"name":"X"');
    let text = '';
    for (let i = 0; i < 35; i++) { const r = parser.feed('V'.repeat(2000)); text += r.text || ''; }
    const r2 = parser.feed('"}}');
    text += r2.text || '';
    assert.ok(text.includes(P), 'placeholder appears');
    assert.ok(!text.includes('"}}'), 'closing braces must NOT leak');
  });

  it('B1: after XML oversize reset, subsequent model text flows normally (no zombie inToolCall)', () => {
    const parser = new ToolCallStreamParser({ dialect: 'openai_json_xml' });
    parser.feed('<tool_call>{"name":"X"');
    for (let i = 0; i < 35; i++) parser.feed('W'.repeat(2000));
    // close arrives → oversize resets
    const r1 = parser.feed('}</tool_call>');
    assert.equal(r1.text || '', '', 'close must be swallowed');
    // normal prose after close must flow
    const r2 = parser.feed('hello after the call');
    assert.equal(r2.text, 'hello after the call', 'post-reset text must not be swallowed');
    const f = parser.flush();
    assert.ok(!(f.text || '').includes('<tool_call>'), 'flush must not leak unclosed prefix');
    assert.ok(!(f.text || '').includes('W'.repeat(100)), 'flush must not leak the oversize blob');
  });

  it('B2: gpt_native oversize terminates on the closing braces (no infinite swallow)', () => {
    const parser = new ToolCallStreamParser({ dialect: 'gpt_native' });
    parser.feed('{"function_call":{"name":"X"');
    for (let i = 0; i < 35; i++) parser.feed('V'.repeat(2000));
    // V-11: the terminator is the construct's own balanced braces, so the two
    // braces it still owes must end the drop (a `}` inside a string must not).
    const r = parser.feed('}}');
    assert.equal(parser._oversizeDropped, false, 'drop state must reset');
    assert.ok(!(r.text || '').includes('}}'), 'closing braces must not leak');
    // post-reset prose flows
    const r2 = parser.feed('ok now');
    assert.equal(r2.text, 'ok now');
  });

  it('B3: oversize swallow caps its buffer (no unbounded growth)', () => {
    const parser = new ToolCallStreamParser({ dialect: 'glm47' });
    parser.feed('<tool_call>{"name":"X"');
    for (let i = 0; i < 35; i++) parser.feed('W'.repeat(2000));
    assert.equal(parser._oversizeDropped, true);
    // 1MB of prose without close — buffer must stay bounded
    for (let i = 0; i < 500; i++) parser.feed('P'.repeat(2000));
    assert.ok(parser.buffer.length <= 65_536 * 2 + 4096, `drop-state buffer bounded, got ${parser.buffer.length}`);
  });

  it('M1: {"name" sentinel oversize → placeholder + no trailing brace leak', () => {
    const parser = new ToolCallStreamParser({ dialect: 'gpt_native' });
    parser.feed('{"name":"X","arguments":{"data":"');
    let text = '';
    for (let i = 0; i < 35; i++) { const r = parser.feed('Q'.repeat(2000)); text += r.text || ''; }
    const r = parser.feed('"}}');
    text += r.text || '';
    assert.ok(text.includes(P), 'placeholder appears');
    assert.ok(!text.includes('"}}'), 'trailing braces must not leak');
  });

  it('a small complete <tool_call> still parses normally (no false positive)', () => {
    const parser = new ToolCallStreamParser({ dialect: 'glm47' });
    parser.feed('<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>');
    const f = parser.flush();
    assert.equal((f.toolCalls || []).length, 1, 'small call parses');
    assert.ok(!(f.text || '').includes(P), 'no placeholder for healthy calls');
  });
});

// ---------------------------------------------------------------------------
// V-11 — the over-limit drop is per construct and defined on the byte stream,
// not on chunk boundaries. The same bytes split differently must produce the
// same text/toolCalls, and the abandoned construct (body, terminator, partial
// open marker) must never leak into the text stream.
// ---------------------------------------------------------------------------

function runStream(chunks, options) {
  const parser = new ToolCallStreamParser(options);
  let text = '';
  const toolCalls = [];
  const absorb = (result) => {
    text += result.text || '';
    for (const tc of result.toolCalls || []) {
      toolCalls.push({ name: tc.name, argumentsJson: tc.argumentsJson });
    }
  };
  for (const chunk of chunks) absorb(parser.feed(chunk));
  absorb(parser.flush());
  return { text, toolCalls };
}

function chunksAt(text, cuts) {
  const out = [];
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    if (cut > from) out.push(text.slice(from, cut));
    from = cut;
  }
  return out;
}

function fixedChunks(text, size) {
  return chunksAt(text, Array.from({ length: Math.ceil(text.length / size) - 1 }, (_, i) => (i + 1) * size));
}

function randomChunks(text, seed) {
  let x = seed >>> 0;
  const next = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x1_0000_0000;
  };
  const out = [];
  let from = 0;
  while (from < text.length) {
    const size = 1 + Math.floor(next() * 257);
    out.push(text.slice(from, from + size));
    from += size;
  }
  return out;
}

function splitsFor(text, tinyChunk = 3) {
  return [
    ['whole', [text]],
    [`${tinyChunk}-byte`, fixedChunks(text, tinyChunk)],
    ['997-byte', fixedChunks(text, 997)],
    ['4096-byte', fixedChunks(text, 4096)],
    ['65536-byte', fixedChunks(text, 65_536)],
    ['at 1/65536', chunksAt(text, [1, 65_536])],
    ['at 65536', chunksAt(text, [65_536])],
    ['at 65537', chunksAt(text, [65_537])],
    ['random', randomChunks(text, 0x11)],
  ];
}

const BIG_BODY = 'Z'.repeat(70_000);
const PREFIX = 'PRE ';
const TAIL = 'TAIL';

const OVER_LIMIT_CASES = [
  {
    name: 'openai_json_xml <tool_call>',
    options: { dialect: 'openai_json_xml' },
    text: `${PREFIX}<tool_call>{"name":"X","arguments":{"d":"${BIG_BODY}"}}</tool_call>${TAIL}`,
    expected: `${PREFIX}${P}${TAIL}`,
    forbidden: ['<tool_call>', '</tool_call>', '{"name"', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'openai_json_xml <tool_result>',
    options: { dialect: 'openai_json_xml' },
    text: `${PREFIX}<tool_result tool_call_id="c1">${BIG_BODY}</tool_result>${TAIL}`,
    expected: `${PREFIX}${TAIL}`,
    forbidden: ['<tool_result', '</tool_result>', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'openai_json_xml {"tool_code"}',
    options: { dialect: 'openai_json_xml' },
    text: `${PREFIX}{"tool_code":"run(\\"${BIG_BODY}\\")"}${TAIL}`,
    expected: `${PREFIX}${P}${TAIL}`,
    forbidden: ['{"tool_code"', '"}', BIG_BODY.slice(0, 200)],
    tinyChunk: 97,
  },
  {
    name: 'openai_json_xml bare {"name"}',
    options: { dialect: 'openai_json_xml' },
    text: `${PREFIX}{"name":"X","arguments":{"d":"${BIG_BODY}"}}${TAIL}`,
    expected: `${PREFIX}${P}${TAIL}`,
    forbidden: ['{"name"', '}}', BIG_BODY.slice(0, 200)],
    tinyChunk: 97,
  },
  {
    name: 'glm47 <tool_call>',
    options: { dialect: 'glm47' },
    text: `${PREFIX}<tool_call>{"name":"X","arguments":{"d":"${BIG_BODY}"}}</tool_call>${TAIL}`,
    expected: `${PREFIX}${P}${TAIL}`,
    forbidden: ['<tool_call>', '</tool_call>', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'kimi_k2 section',
    options: { dialect: 'kimi_k2' },
    text: `${PREFIX}<|tool_calls_section_begin|><tool_call>${BIG_BODY}</tool_call><|tool_calls_section_end|>${TAIL}`,
    expected: `${PREFIX}${P}${TAIL}`,
    forbidden: ['<|tool_calls_section_begin|>', '<|tool_calls_section_end|>', '</tool_call>', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'kimi_k2 bare <tool_call>',
    options: { dialect: 'kimi_k2' },
    text: `${PREFIX}<tool_call>{"name":"X","arguments":{"d":"${BIG_BODY}"}}</tool_call>${TAIL}`,
    expected: `${PREFIX}${P}${TAIL}`,
    forbidden: ['<tool_call>', '</tool_call>', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'gpt_native function_call',
    options: { dialect: 'gpt_native' },
    text: `${PREFIX}{"function_call":{"name":"X","arguments":{"d":"${BIG_BODY}"}}}${TAIL}`,
    expected: `${PREFIX}${P}${TAIL}`,
    forbidden: ['{"function_call"', '}}}', BIG_BODY.slice(0, 200)],
    tinyChunk: 97,
  },
];

const OVER_LIMIT_EOF_CASES = [
  {
    name: 'openai_json_xml <tool_call> never closes',
    options: { dialect: 'openai_json_xml' },
    text: `${PREFIX}<tool_call>{"name":"X","arguments":{"d":"${BIG_BODY}"`,
    expected: `${PREFIX}${P}`,
    forbidden: ['<tool_call>', '</tool_call>', '{"name"', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'openai_json_xml <tool_result> never closes',
    options: { dialect: 'openai_json_xml' },
    text: `${PREFIX}<tool_result tool_call_id="c1">${BIG_BODY}`,
    expected: PREFIX,
    forbidden: ['<tool_result', '</tool_result>', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'openai_json_xml {"tool_code"} never closes',
    options: { dialect: 'openai_json_xml' },
    text: `${PREFIX}{"tool_code":"run(\\"${BIG_BODY}\\"`,
    expected: `${PREFIX}${P}`,
    forbidden: ['{"tool_code"', '"}', BIG_BODY.slice(0, 200)],
    tinyChunk: 97,
  },
  {
    name: 'openai_json_xml bare {"name"} never closes',
    options: { dialect: 'openai_json_xml' },
    text: `${PREFIX}{"name":"X","arguments":{"d":"${BIG_BODY}"`,
    expected: `${PREFIX}${P}`,
    forbidden: ['{"name"', '}}', BIG_BODY.slice(0, 200)],
    tinyChunk: 97,
  },
  {
    name: 'glm47 <tool_call> never closes',
    options: { dialect: 'glm47' },
    text: `${PREFIX}<tool_call>{"name":"X","arguments":{"d":"${BIG_BODY}"`,
    expected: `${PREFIX}${P}`,
    forbidden: ['<tool_call>', '</tool_call>', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'kimi_k2 section never closes',
    options: { dialect: 'kimi_k2' },
    text: `${PREFIX}<|tool_calls_section_begin|><tool_call>${BIG_BODY}`,
    expected: `${PREFIX}${P}`,
    forbidden: ['<|tool_calls_section_begin|>', '<|tool_calls_section_end|>', '<tool_call>', BIG_BODY.slice(0, 200)],
  },
  {
    name: 'gpt_native function_call never closes',
    options: { dialect: 'gpt_native' },
    text: `${PREFIX}{"function_call":{"name":"X","arguments":{"d":"${BIG_BODY}"`,
    expected: `${PREFIX}${P}`,
    forbidden: ['{"function_call"', '}}', BIG_BODY.slice(0, 200)],
    tinyChunk: 97,
  },
];

describe('V-11 over-limit drop is defined on the byte stream, not chunk boundaries', () => {
  for (const testCase of [...OVER_LIMIT_CASES, ...OVER_LIMIT_EOF_CASES]) {
    it(`${testCase.name}: identical output for every split, no markup leak`, () => {
      const [canonicalLabel, canonicalChunks] = splitsFor(testCase.text, testCase.tinyChunk)[0];
      const canonical = runStream(canonicalChunks, testCase.options);
      assert.equal(canonical.text, testCase.expected, `${canonicalLabel} text`);
      assert.deepEqual(canonical.toolCalls, [], 'over-limit construct must never become a tool call');
      for (const needle of testCase.forbidden) {
        assert.ok(!canonical.text.includes(needle), `over-limit markup leaked: ${JSON.stringify(needle.slice(0, 40))}`);
      }
      for (const [label, chunks] of splitsFor(testCase.text, testCase.tinyChunk).slice(1)) {
        assert.deepEqual(runStream(chunks, testCase.options), canonical, `split ${label} diverged from whole-stream output`);
      }
    });
  }

  it('control: a small unclosed <tool_call> is still regurgitated at EOF', () => {
    const result = runStream(['<tool_call>{"name":"X","arguments":{'], { dialect: 'openai_json_xml' });
    assert.equal(result.text, '<tool_call>{"name":"X","arguments":{');
    assert.deepEqual(result.toolCalls, []);
  });

  // The cap is about the construct, not about the whole held buffer: a small
  // call followed by a large delta must be parsed no matter where the split
  // lands (the old length check ran before the block end was located).
  const LARGE_PROSE = 'Z'.repeat(70_000);
  const SMALL_CALL_CASES = [
    {
      name: 'openai_json_xml bare JSON',
      options: { dialect: 'openai_json_xml' },
      text: `{"name":"X","arguments":{}}${LARGE_PROSE}`,
      callName: 'X',
    },
    {
      name: 'openai_json_xml <tool_call>',
      options: { dialect: 'openai_json_xml' },
      text: `<tool_call>{"name":"X","arguments":{}}</tool_call>${LARGE_PROSE}`,
      callName: 'X',
    },
    {
      name: 'openai_json_xml {"tool_code"}',
      options: { dialect: 'openai_json_xml' },
      text: `{"tool_code":"run(1)"}${LARGE_PROSE}`,
      callName: 'run',
    },
    {
      name: 'glm47 <tool_call>',
      options: { dialect: 'glm47' },
      text: `<tool_call>read<arg_key>path</arg_key><arg_value>"x"</arg_value></tool_call>${LARGE_PROSE}`,
      callName: 'read',
    },
  ];
  for (const testCase of SMALL_CALL_CASES) {
    it(`control: ${testCase.name} call followed by 70KB prose still parses (all splits)`, () => {
      const canonical = runStream([testCase.text], testCase.options);
      assert.equal(canonical.toolCalls.length, 1, 'small call must be parsed');
      assert.equal(canonical.toolCalls[0].name, testCase.callName);
      assert.equal(canonical.text, LARGE_PROSE, 'prose must survive intact');
      for (const [label, chunks] of splitsFor(testCase.text, 997).slice(1)) {
        assert.deepEqual(runStream(chunks, testCase.options), canonical, `split ${label} diverged`);
      }
    });
  }

  it('control: a small complete <tool_call> before trailing prose still parses', () => {
    const result = runStream(['PRE <tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call> POST'], { dialect: 'openai_json_xml' });
    assert.equal(result.text, 'PRE  POST');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'Bash');
  });
});

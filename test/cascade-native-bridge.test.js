// v2.0.65 (#115) — Cascade native tool bridge.
//
// Validates that:
//   1. canMapAllTools correctly admits supported tools and rejects mixed/
//      unknown sets so emulation fallback fires.
//   2. Forward + reverse argument translators round-trip per known tool.
//   3. shouldUseNativeBridge is default-off (auto-on was removed). Explicit
//      WINDSURFAPI_NATIVE_TOOL_BRIDGE=1 / all_mapped still work; OFF wins.
//   4. buildAdditionalStepsFromHistory produces decodable trajectory step
//      protos when prior assistant tool_calls + tool results are present.
//   5. windsurf.parseTrajectorySteps surfaces native cascade step kinds
//      (view_file=14, run_command=28, grep_search_v2=105, find=34,
//      list_directory=15, write_to_file=23) as toolCalls with
//      cascade_native:true and the right name + args.
//   6. buildSendCascadeMessageRequest writes additional_steps to field 9
//      (repeated CortexTrajectoryStep).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_MAP, CASCADE_STEP,
  canMapAllTools, partitionTools, shouldUseNativeBridge,
  buildAdditionalStep, buildAdditionalStepsFromHistory, buildNativeToolHistory, buildReverseLookup,
  parseNativeFunctionCallsFromText, NativeFunctionCallStreamParser,
} from '../src/cascade-native-bridge.js';
import { normalizeMessagesForCascade } from '../src/handlers/tool-emulation.js';
import {
  parseTrajectorySteps,
  buildSendCascadeMessageRequest,
} from '../src/windsurf.js';
import {
  parseFields, getField, getAllFields, writeMessageField, writeVarintField, writeStringField,
} from '../src/proto.js';
import { getSystemPrompts, resetSystemPrompt, setSystemPrompts } from '../src/runtime-config.js';

const fnTool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });

describe('canMapAllTools', () => {
  it('admits only mature default-native tools without an explicit tool allowlist', () => {
    const prev = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    try {
      assert.equal(canMapAllTools([fnTool('Bash'), fnTool('shell_command'), fnTool('run_command')]), true);
      assert.equal(canMapAllTools([fnTool('Read'), fnTool('Bash'), fnTool('Glob')]), false);
    } finally {
      if (prev === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = prev;
    }
  });

  it('rejects when ANY tool is unmapped', () => {
    assert.equal(canMapAllTools([fnTool('Read'), fnTool('get_weather')]), false);
  });

  it('rejects empty / non-array input', () => {
    assert.equal(canMapAllTools([]), false);
    assert.equal(canMapAllTools(null), false);
    assert.equal(canMapAllTools(undefined), false);
  });

  it('admits Codex-style command names by default and other native names only when allowlisted', () => {
    const prev = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    try {
      assert.equal(canMapAllTools([fnTool('run_command')]), true);
      assert.equal(canMapAllTools([fnTool('view_file'), fnTool('run_command'), fnTool('find')]), false);
      process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'view_file,run_command,find';
      assert.equal(canMapAllTools([fnTool('view_file'), fnTool('run_command'), fnTool('find')]), true);
    } finally {
      if (prev === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = prev;
    }
  });

  it('admits mixed Claude Code + Codex names when explicitly allowlisted', () => {
    const prev = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read,run_command,Grep';
    try {
      assert.equal(canMapAllTools([fnTool('Read'), fnTool('run_command'), fnTool('Grep')]), true);
    } finally {
      if (prev === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = prev;
    }
  });
});

describe('shouldUseNativeBridge — default-off + explicit gates', () => {
  const tools = [fnTool('Read'), fnTool('Bash')];

  it('GPT family on /v1/responses route → OFF (v2.0.70 reverts auto-on for GPT — cascade native grammar makes GPT fabricate)', () => {
    // v2.0.66 had GPT auto-on, v2.0.70 reverts after end-to-end probe
    // showed markers=none and PROBE fabricated. GPT family now goes
    // through emulation + gpt_native dialect.
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses' }),
      false,
    );
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'o4-mini', provider: 'openai', route: 'responses' }),
      false,
    );
  });

  it('GPT family on /v1/chat/completions → off (default emulation path)', () => {
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'chat' }),
      false,
    );
  });

  it('Anthropic Claude → OFF by default (v2.0.75 #124 regression fix — bridge runs tools in REMOTE cascade sandbox, but client tools expect LOCAL execution; hang forever)', () => {
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'claude-sonnet-4.6', provider: 'anthropic', route: 'responses' }),
      false,
    );
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'claude-sonnet-4.6', provider: 'anthropic', route: 'chat' }),
      false,
    );
  });

  it('Gemini → off (no auto-on — emulation works fine for it)', () => {
    assert.equal(
      shouldUseNativeBridge(tools, { modelKey: 'gemini-2.5-flash', provider: 'google', route: 'responses' }),
      false,
    );
  });

  it('partial-mapped tools on Claude → OFF (post-v2.0.75 — same #124 logic, no client wants remote execution by default)', () => {
    assert.equal(
      shouldUseNativeBridge([fnTool('Read'), fnTool('get_weather')], {
        modelKey: 'claude-sonnet-4.6', provider: 'anthropic', route: 'responses',
      }),
      false,
    );
  });

  it('zero mapped tools → off (no point booting native path)', () => {
    assert.equal(
      shouldUseNativeBridge([fnTool('get_weather'), fnTool('update_plan')], {
        modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses',
      }),
      false,
    );
  });

  it('explicit env override forces on for any mapped tool set (deployer opting into remote execution)', () => {
    const orig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
    const toolsOrig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read,Bash';
    try {
      assert.equal(
        shouldUseNativeBridge(tools, { modelKey: 'claude-sonnet-4-6', provider: 'anthropic', route: 'chat' }),
        true,
      );
      // GPT too, when explicitly enabled.
      assert.equal(
        shouldUseNativeBridge(tools, { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses' }),
        true,
      );
    } finally {
      if (orig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = orig;
      if (toolsOrig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = toolsOrig;
    }
  });

  it('all_mapped mode enables only when every function tool maps', () => {
    const orig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
    const toolsOrig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = 'all_mapped';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = 'Read,Bash,Grep,Glob';
    try {
      assert.equal(
        shouldUseNativeBridge([fnTool('Read'), fnTool('Bash'), fnTool('Grep'), fnTool('Glob')], {
          modelKey: 'claude-sonnet-4.6', provider: 'anthropic', route: 'chat',
        }),
        true,
      );
      assert.equal(
        shouldUseNativeBridge([fnTool('Read'), fnTool('Bash'), fnTool('update_plan')], {
          modelKey: 'claude-sonnet-4.6', provider: 'anthropic', route: 'chat',
        }),
        false,
      );
    } finally {
      if (orig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = orig;
      if (toolsOrig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS = toolsOrig;
    }
  });

  it('OFF override beats explicit on', () => {
    const onOrig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
    const offOrig = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF = '1';
    try {
      assert.equal(
        shouldUseNativeBridge(tools, { modelKey: 'gpt-5.5-medium', provider: 'openai', route: 'responses' }),
        false,
      );
    } finally {
      if (onOrig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE = onOrig;
      if (offOrig === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF = offOrig;
    }
  });
});

describe('TOOL_MAP — forward / reverse round-trip per kind', () => {
  it('Read ↔ view_file preserves file_path / offset / limit', () => {
    const original = { file_path: '/abs/path/foo.ts', offset: 10, limit: 200 };
    const cascade = TOOL_MAP.Read.forward(original);
    assert.equal(cascade.absolute_path_uri, 'file:///abs/path/foo.ts');
    assert.equal(cascade.offset, 10);
    assert.equal(cascade.limit, 200);
    const back = TOOL_MAP.Read.reverse(cascade);
    assert.deepEqual(back, original);
  });

  it('Bash ↔ run_command preserves command (and cwd if present)', () => {
    const original = { command: 'npm test --silent' };
    const cascade = TOOL_MAP.Bash.forward(original);
    assert.equal(cascade.command_line, 'npm test --silent');
    const back = TOOL_MAP.Bash.reverse(cascade);
    assert.equal(back.command, 'npm test --silent');
    // cwd round-trip
    const withCwd = TOOL_MAP.Bash.forward({ command: 'ls', cwd: '/tmp' });
    assert.equal(TOOL_MAP.Bash.reverse(withCwd).cwd, '/tmp');
  });

  it('Grep ↔ grep_search_v2 preserves pattern + flags', () => {
    const original = { pattern: 'foo', '-i': true, head_limit: 50, glob: '*.js' };
    const cascade = TOOL_MAP.Grep.forward(original);
    assert.equal(cascade.pattern, 'foo');
    assert.equal(cascade.case_insensitive, true);
    assert.equal(cascade.head_limit, 50);
    assert.equal(cascade.glob, '*.js');
    const back = TOOL_MAP.Grep.reverse(cascade);
    assert.equal(back.pattern, 'foo');
    assert.equal(back['-i'], true);
    assert.equal(back.head_limit, 50);
    assert.equal(back.glob, '*.js');
  });

  it('Glob ↔ find preserves pattern + path', () => {
    const cascade = TOOL_MAP.Glob.forward({ pattern: '**/*.ts', path: 'src' });
    assert.equal(cascade.pattern, '**/*.ts');
    assert.equal(cascade.search_directory, 'src');
    const back = TOOL_MAP.Glob.reverse(cascade);
    assert.equal(back.pattern, '**/*.ts');
    assert.equal(back.path, 'src');
  });

  it('Write ↔ write_to_file preserves file_path + content', () => {
    const cascade = TOOL_MAP.Write.forward({ file_path: '/tmp/x.txt', content: 'hello\n' });
    assert.equal(cascade.target_file_uri, 'file:///tmp/x.txt');
    assert.deepEqual(cascade.code_content, ['hello\n']);
    const back = TOOL_MAP.Write.reverse(cascade);
    assert.equal(back.file_path, '/tmp/x.txt');
    assert.equal(back.content, 'hello\n');
  });
});

describe('buildReverseLookup', () => {
  it('inverts caller tools by cascade kind', () => {
    const lookup = buildReverseLookup([fnTool('Read'), fnTool('Bash'), fnTool('Grep')]);
    assert.deepEqual(lookup.get('view_file'), ['Read']);
    assert.deepEqual(lookup.get('run_command'), ['Bash']);
    assert.deepEqual(lookup.get('grep_search_v2'), ['Grep']);
  });

  it('returns empty map for empty input', () => {
    const lookup = buildReverseLookup([]);
    assert.equal(lookup.size, 0);
  });

  it('handles caller declaring multiple tools that map to same kind', () => {
    const lookup = buildReverseLookup([fnTool('Read'), fnTool('view_file'), fnTool('read_file')]);
    const list = lookup.get('view_file');
    assert.ok(list.includes('Read'));
    assert.ok(list.includes('view_file'));
    assert.ok(list.includes('read_file'));
  });
});

describe('parseNativeFunctionCallsFromText', () => {
  it('maps Claude provider-native read_file invoke back to caller Read', () => {
    const lookup = buildReverseLookup([fnTool('Read')]);
    const out = parseNativeFunctionCallsFromText(
      'I will inspect it.\n<function_calls>\n<invoke name="read_file">\n<parameter name="path">/tmp/a.txt</parameter>\n</invoke>\n</function_calls>',
      lookup,
    );
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'Read');
    assert.deepEqual(JSON.parse(out.toolCalls[0].argumentsJson), { file_path: '/tmp/a.txt' });
    assert.ok(!out.text.includes('<function_calls>'));
    assert.ok(!out.text.includes('<invoke'));
  });

  it('drops unknown invokes instead of leaking XML or inventing caller tools', () => {
    const lookup = buildReverseLookup([fnTool('Read')]);
    const text = '<function_calls><invoke name="unknown_tool"><parameter name="x">1</parameter></invoke></function_calls>';
    const out = parseNativeFunctionCallsFromText(text, lookup);
    assert.equal(out.toolCalls.length, 0);
    assert.equal(out.text, '');
  });

  it('drops known invokes when the caller did not declare a matching tool', () => {
    const lookup = buildReverseLookup([fnTool('Bash')]);
    const text = 'before <function_calls><invoke name="read_file"><parameter name="path">README.md</parameter></invoke></function_calls> after';
    const out = parseNativeFunctionCallsFromText(text, lookup);
    assert.equal(out.toolCalls.length, 0);
    assert.equal(out.text, 'before  after');
  });

  it('stream parser withholds provider-native XML until it can emit a tool_call', () => {
    const lookup = buildReverseLookup([fnTool('Read')]);
    const parser = new NativeFunctionCallStreamParser(lookup);
    const a = parser.feed('<function_calls>\n<invoke name="read_file">\n');
    assert.equal(a.text, '');
    assert.equal(a.toolCalls.length, 0);
    const b = parser.feed('<parameter name="path">README.md</parameter>\n');
    assert.equal(b.text, '');
    assert.equal(b.toolCalls.length, 0);
    const c = parser.feed('</invoke>\n</function_calls>');
    assert.equal(c.text, '');
    assert.equal(c.toolCalls.length, 1);
    assert.equal(c.toolCalls[0].name, 'Read');
    assert.deepEqual(JSON.parse(c.toolCalls[0].argumentsJson), { file_path: 'README.md' });
    const tail = parser.flush();
    assert.equal(tail.text, '');
    assert.equal(tail.toolCalls.length, 0);
  });

  it('stream parser holds partial opening tags across chunk boundaries', () => {
    const lookup = buildReverseLookup([fnTool('Read')]);
    const parser = new NativeFunctionCallStreamParser(lookup);
    const a = parser.feed('prefix <fun');
    assert.equal(a.text, 'prefix ');
    assert.equal(a.toolCalls.length, 0);
    const b = parser.feed('ction_calls><invoke name="read_file"><parameter name="path">a.txt</parameter></invoke></function_calls> suffix');
    assert.equal(b.text, ' suffix');
    assert.equal(b.toolCalls.length, 1);
    assert.deepEqual(JSON.parse(b.toolCalls[0].argumentsJson), { file_path: 'a.txt' });
  });

  it('stream parser drops an incomplete XML block once it exceeds 64KiB', () => {
    const lookup = buildReverseLookup([fnTool('Read')]);
    const parser = new NativeFunctionCallStreamParser(lookup);
    parser.feed('<function_calls><invoke name="read_file">');
    const overflow = parser.feed('x'.repeat(70_000));
    assert.deepEqual(overflow, { text: '', toolCalls: [] });
    assert.equal(parser.buffer, '');
    const later = parser.feed('after-cap text');
    assert.equal(later.text, 'after-cap text');
  });

  it('stream parser does not drop a large content delta that is not an XML block', () => {
    const lookup = buildReverseLookup([fnTool('Read')]);
    const parser = new NativeFunctionCallStreamParser(lookup);
    const body = 'plain '.repeat(20_000);
    const out = parser.feed(body);
    assert.equal(out.text, body);
    assert.equal(out.toolCalls.length, 0);
  });

  it('stream parser drops incomplete XML on flush', () => {
    const lookup = buildReverseLookup([fnTool('Read')]);
    const parser = new NativeFunctionCallStreamParser(lookup);
    assert.deepEqual(parser.feed('start <function_calls><invoke name="read_file">'), { text: 'start ', toolCalls: [] });
    const tail = parser.flush();
    assert.equal(tail.text, '');
    assert.equal(tail.toolCalls.length, 0);
  });

  it('non-stream parser drops dangling function_calls blocks', () => {
    const lookup = buildReverseLookup([fnTool('Read')]);
    const out = parseNativeFunctionCallsFromText('prefix <function_calls><invoke name="read_file">', lookup);
    assert.equal(out.text, 'prefix');
    assert.equal(out.toolCalls.length, 0);
  });
});

describe('buildAdditionalStep / buildAdditionalStepsFromHistory', () => {
  it('view_file step encodes CortexStepType=8 with the body on oneof field 14', () => {
    const buf = buildAdditionalStep('view_file', {
      absolute_path_uri: 'file:///foo.ts',
      content: 'console.log("hi")',
    }, { observed: true });
    assert.ok(Buffer.isBuffer(buf));
    const fields = parseFields(buf);
    const typeField = getField(fields, 1, 0);
    assert.equal(typeField.value, 8, 'CortexStepType.VIEW_FILE is 8, not the oneof field 14');
    const oneof = getField(fields, 14, 2);
    assert.ok(oneof, 'view_file body should be on field 14');
    const body = parseFields(oneof.value);
    assert.equal(getField(body, 1, 2).value.toString('utf8'), 'file:///foo.ts');
    assert.equal(getField(body, 4, 2).value.toString('utf8'), 'console.log("hi")');
  });

  it('run_command step puts command_line on field 23 + combined_output on 21', () => {
    const buf = buildAdditionalStep('run_command', {
      command_line: 'echo hi',
      full_output: 'hi\n',
      exit_code: 0,
    }, { observed: true });
    const fields = parseFields(buf);
    assert.equal(getField(fields, 1, 0).value, 21, 'CortexStepType.RUN_COMMAND is 21');
    const body = parseFields(getField(fields, 28, 2).value);
    assert.equal(getField(body, 23, 2).value.toString('utf8'), 'echo hi');
    const combined = parseFields(getField(body, 21, 2).value);
    assert.equal(getField(combined, 1, 2).value.toString('utf8'), 'hi\n');
  });

  it('full assistant→tool history → trajectory step buffers', () => {
    const messages = [
      { role: 'user', content: 'find me a file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: JSON.stringify({ file_path: '/etc/hosts' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '127.0.0.1 localhost\n' },
    ];
    const steps = buildAdditionalStepsFromHistory(messages);
    assert.equal(steps.length, 1);
    const fields = parseFields(steps[0]);
    assert.equal(getField(fields, 1, 0).value, 8, 'CortexStepType.VIEW_FILE is 8');
    const body = parseFields(getField(fields, 14, 2).value);
    assert.equal(getField(body, 4, 2).value.toString('utf8'), '127.0.0.1 localhost\n');
  });

  it('WebFetch history encodes tool result as read_url_content web_document', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_fetch',
          type: 'function',
          function: { name: 'WebFetch', arguments: JSON.stringify({ url: 'https://example.com/docs' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_fetch', content: 'fetched document body' },
    ];
    const steps = buildAdditionalStepsFromHistory(messages);
    assert.equal(steps.length, 1);
    const fields = parseFields(steps[0]);
    assert.equal(getField(fields, 1, 0).value, 31, 'CortexStepType.READ_URL_CONTENT is 31');
    const body = parseFields(getField(fields, 40, 2).value);
    assert.equal(getField(body, 1, 2).value.toString('utf8'), 'https://example.com/docs');
    assert.equal(getField(body, 5, 2), null, 'read_url_content must not encode legacy top-level summary field 5');
    const doc = parseFields(getField(body, 2, 2).value);
    assert.equal(getField(doc, 2, 2).value.toString('utf8'), 'fetched document body');
    assert.equal(getField(doc, 3, 2).value.toString('utf8'), 'https://example.com/docs');
  });

  it('skips unmapped tool_calls (fall back to emulation path)', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_x',
          function: { name: 'get_weather', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_x', content: 'sunny' },
    ];
    const steps = buildAdditionalStepsFromHistory(messages);
    assert.equal(steps.length, 0);
  });
});

// V-13 (KH-034) — history truth: a step is only complete when the caller
// actually reported a result; a failed shell command keeps its non-zero
// status; unmapped history stays visible to the emulation path; and a
// reused cascade receives only the rounds it has not already seen.
describe('native history truth (V-13)', () => {
  const callMsg = (id, name, args, extra = {}) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
    ...extra,
  });
  const resultMsg = (id, content, extra = {}) => ({ role: 'tool', tool_call_id: id, content, ...extra });

  function decodeRunCommand(buf) {
    const fields = parseFields(buf);
    assert.equal(getField(fields, 1, 0).value, 21, 'CortexStepType.RUN_COMMAND is 21');
    return {
      status: getField(fields, 4, 0).value,
      body: parseFields(getField(fields, 28, 2).value),
    };
  }

  it('an unobserved call never becomes DONE and a failed Bash keeps its non-zero exit_code', () => {
    // Layer 1: the encoder itself refuses to stamp DONE without an observation.
    assert.equal(
      buildAdditionalStep('run_command', { command_line: 'ls' }),
      null,
      'no observation means no completed step',
    );

    // Layer 2: history conversion drops the unobserved call instead of
    // telling the planner it ran with empty output.
    const unobserved = buildAdditionalStepsFromHistory([
      { role: 'user', content: 'go' },
      callMsg('call_unobserved', 'Bash', { command: 'ls' }),
    ]);
    assert.equal(unobserved.length, 0, 'an assistant tool_call with no result is not a DONE step');

    // A failed Bash result carries its exit status. The step is DONE because
    // the command completed — not because it succeeded.
    const failedText = 'Exit code: 2\nOutput:\nls: cannot access /nope';
    const failed = buildAdditionalStepsFromHistory([
      { role: 'user', content: 'go' },
      callMsg('call_failed', 'Bash', { command: 'ls /nope' }),
      resultMsg('call_failed', failedText),
    ]);
    assert.equal(failed.length, 1);
    const decoded = decodeRunCommand(failed[0]);
    assert.equal(decoded.status, 3, 'status DONE means the step completed, not that it succeeded');
    assert.equal(getField(decoded.body, 6, 0).value, 2, 'a failed Bash keeps its non-zero exit_code');
    const combined = parseFields(getField(decoded.body, 21, 2).value);
    assert.equal(getField(combined, 1, 2).value.toString('utf8'), failedText);
    assert.equal(
      getField(decoded.body, 4, 2),
      null,
      'one authoritative output field: combined_output only, no duplicated stdout',
    );

    // Success keeps 0 — the fix must not turn every command into a failure.
    const ok = buildAdditionalStepsFromHistory([
      { role: 'user', content: 'go' },
      callMsg('call_ok', 'Bash', { command: 'true' }),
      resultMsg('call_ok', 'Exit code: 0\n'),
    ]);
    assert.equal(getField(decodeRunCommand(ok[0]).body, 6, 0).value, 0);

    // Anthropic-style failures carry no numeric code; they must still not be
    // replayed as success (proto3 reads an absent field as 0).
    const toolError = buildAdditionalStepsFromHistory([
      { role: 'user', content: 'go' },
      callMsg('call_err', 'Bash', { command: 'nope' }),
      resultMsg('call_err', '[tool error] bash: nope: command not found'),
    ]);
    assert.equal(
      getField(decodeRunCommand(toolError[0]).body, 6, 0).value,
      1,
      'a signalled failure without a numeric code is encoded non-zero, never 0',
    );

    const flagged = buildAdditionalStepsFromHistory([
      { role: 'user', content: 'go' },
      callMsg('call_flag', 'Bash', { command: 'nope' }),
      resultMsg('call_flag', 'bash: nope: command not found', { is_error: true }),
    ]);
    assert.equal(getField(decodeRunCommand(flagged[0]).body, 6, 0).value, 1);

    // codex-style structured shell results keep their exit status too.
    const json = buildAdditionalStepsFromHistory([
      { role: 'user', content: 'go' },
      callMsg('call_json', 'Bash', { command: 'nope' }),
      resultMsg('call_json', JSON.stringify({ output: 'boom', metadata: { exit_code: 127 } })),
    ]);
    assert.equal(getField(decodeRunCommand(json[0]).body, 6, 0).value, 127);
  });

  it('a reused cascade receives only the new tool round, not the already-injected prefix', () => {
    const messages = [
      { role: 'user', content: 'u1' },
      callMsg('call_1', 'Read', { file_path: '/a' }),
      resultMsg('call_1', 'A'),
      { role: 'assistant', content: 'read a' },
      callMsg('call_2', 'Read', { file_path: '/b' }),
      resultMsg('call_2', 'B'),
    ];

    // A fresh cascade never saw the earlier round, so it gets the full history.
    const fresh = buildNativeToolHistory(messages);
    assert.equal(fresh.steps.length, 2);
    // The full build exposes where the new round starts, so the wire can
    // slice instead of encoding the history a second time.
    assert.equal(fresh.deltaStart, 1);
    assert.deepEqual(fresh.steps.slice(fresh.deltaStart), buildAdditionalStepsFromHistory(messages, { reuse: true }));

    // The reused cascade already holds call_1's step; re-injecting it would
    // duplicate the observation in its trajectory.
    const delta = buildAdditionalStepsFromHistory(messages, { reuse: true });
    assert.equal(delta.length, 1, 'only the newest pending round is new');
    const body = parseFields(getField(parseFields(delta[0]), 14, 2).value);
    assert.equal(getField(body, 4, 2).value.toString('utf8'), 'B');

    // A reused cascade whose newest turn is a user message has nothing new.
    assert.equal(
      buildAdditionalStepsFromHistory([...messages, { role: 'user', content: 'next' }], { reuse: true }).length,
      0,
    );

    // The trailing round is only a delta when it has observations; an
    // unanswered proposal is not a completed step.
    assert.equal(
      buildAdditionalStepsFromHistory(messages.slice(0, 5), { reuse: true }).length,
      0,
    );
  });

  it('unmapped and orphan tool history survives in the emulation message list', () => {
    const messages = [
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_mapped', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
          { id: 'call_unmapped', type: 'function', function: { name: 'get_weather', arguments: '{"city":"x"}' } },
        ],
      },
      resultMsg('call_mapped', 'Exit code: 0\nok'),
      resultMsg('call_unmapped', 'sunny'),
      resultMsg('call_orphan', 'orphan output'),
    ];

    const history = buildNativeToolHistory(messages);
    assert.equal(history.steps.length, 1, 'only the mapped+observed call becomes a step');

    // The mapped pair belongs to the bridge and must not be duplicated into
    // the text history; the unmapped pair and the orphan result are retained.
    const retained = history.emulationMessages;
    assert.equal(retained.length, 4, 'user + assistant(unmapped call) + unmapped result + orphan result');
    assert.deepEqual(retained[1].tool_calls.map(tc => tc.id), ['call_unmapped']);
    assert.equal(retained[2].tool_call_id, 'call_unmapped');
    assert.equal(retained[3].tool_call_id, 'call_orphan');

    const folded = normalizeMessagesForCascade(retained, [fnTool('get_weather')], { injectUserPreamble: false });
    const text = folded.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
    assert.match(text, /sunny/, 'the unmapped result reaches the model as emulated history');
    assert.match(text, /orphan output/, 'an orphan result is not silently dropped');
    assert.doesNotMatch(text, /Exit code: 0/, 'the bridge-owned result is not duplicated as text');
  });
});

describe('parseTrajectorySteps — native step recognition', () => {
  // Helpers to build a CortexTrajectoryStep envelope by hand. We avoid
  // calling buildAdditionalStep here so tests double-cover encoder / decoder
  // independently.
  const wrapStep = (typeEnum, oneofField, bodyBuf) =>
    Buffer.concat([
      writeVarintField(1, typeEnum),
      writeVarintField(4, 3), // status DONE
      writeMessageField(oneofField, bodyBuf),
    ]);

  // GetCascadeTrajectoryStepsResponse is `repeated CortexTrajectoryStep steps = 1`
  const wrapResponse = (...stepBufs) =>
    Buffer.concat(stepBufs.map(b => writeMessageField(1, b)));

  it('view_file step → toolCall with name=view_file + arguments + result', () => {
    const body = Buffer.concat([
      writeStringField(1, 'file:///abs/foo.ts'),
      writeVarintField(11, 0),
      writeVarintField(12, 100),
      writeStringField(4, 'console.log("hi")\n'),
    ]);
    const resp = wrapResponse(wrapStep(8, 14, body));
    const steps = parseTrajectorySteps(resp);
    assert.equal(steps.length, 1);
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'view_file');
    const args = JSON.parse(calls[0].argumentsJson);
    assert.equal(args.absolute_path_uri, 'file:///abs/foo.ts');
    assert.equal(args.limit, 100);
    assert.equal(calls[0].result, 'console.log("hi")\n');
  });

  it('run_command step → toolCall with combined_output observation', () => {
    const combinedOutput = writeStringField(1, 'hi\n');
    const body = Buffer.concat([
      writeStringField(23, 'echo hi'),
      writeMessageField(21, combinedOutput),
    ]);
    const resp = wrapResponse(wrapStep(21, 28, body));
    const steps = parseTrajectorySteps(resp);
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'run_command');
    assert.equal(calls[0].result, 'hi\n');
    const args = JSON.parse(calls[0].argumentsJson);
    assert.equal(args.command_line, 'echo hi');
  });

  it('grep_search_v2 step (field 105) → toolCall name grep_search_v2', () => {
    const body = Buffer.concat([
      writeStringField(2, 'todo'),
      writeStringField(3, 'src'),
      writeStringField(15, 'src/foo.ts:10:// todo\n'),
    ]);
    const resp = wrapResponse(wrapStep(91, 105, body));
    const steps = parseTrajectorySteps(resp);
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'grep_search_v2');
    assert.equal(calls[0].result, 'src/foo.ts:10:// todo\n');
  });

  it('list_directory step → children joined as result', () => {
    const body = Buffer.concat([
      writeStringField(1, 'file:///src'),
      writeStringField(2, 'foo.ts'),
      writeStringField(2, 'bar.ts'),
    ]);
    const resp = wrapResponse(wrapStep(9, 15, body));
    const steps = parseTrajectorySteps(resp);
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'list_directory');
    assert.equal(calls[0].result, 'foo.ts\nbar.ts');
  });

  it('multiple native steps in same trajectory all surface', () => {
    const viewBody = Buffer.concat([writeStringField(1, 'file:///a.ts'), writeStringField(4, 'A')]);
    const cmdBody = Buffer.concat([writeStringField(23, 'ls'), writeMessageField(21, writeStringField(1, 'a.ts\n'))]);
    const resp = wrapResponse(wrapStep(8, 14, viewBody), wrapStep(21, 28, cmdBody));
    const steps = parseTrajectorySteps(resp);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].toolCalls.filter(tc => tc.cascade_native).length, 1);
    assert.equal(steps[1].toolCalls.filter(tc => tc.cascade_native).length, 1);
  });
});

describe('buildSendCascadeMessageRequest — additional_steps on field 9', () => {
  it('omits XML reinforcement from a Kimi preamble', () => {
    setSystemPrompts({ toolReinforcement: 'Use this exact format: <tool_call>{"name":"...","arguments":{...}}</tool_call>' });
    try {
      const proto = buildSendCascadeMessageRequest(
        'k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess',
        { toolPreamble: '<|tool_calls_section_begin|>\nAvailable tools:\n<|tool_calls_section_end|>' },
      );
      const top = parseFields(proto);
      const cfg = parseFields(getField(top, 5, 2).value);
      const planner = parseFields(getField(cfg, 1, 2).value);
      const conversational = parseFields(getField(planner, 2, 2).value);
      const section = parseFields(getField(conversational, 12, 2).value);
      const text = getField(section, 2, 2).value.toString('utf8');

      assert.match(text, /<\|tool_calls_section_begin\|>/);
      assert.doesNotMatch(text, /Use this exact format:\s*<tool_call>/i);
    } finally {
      resetSystemPrompt('toolReinforcement');
    }
  });

  // The test above INJECTS a reinforcement containing `<tool_call>`, so it proves the
  // suppression works — but not that it ever runs. Detection keys off that marker being
  // present, so if the shipped default stops carrying it the suppression silently becomes a
  // no-op and the test above still passes. #252 did exactly that: it added the dialect-scoped
  // suppression AND replaced the default with a generic sentence, and the two cancelled out.
  // Measured after the merge: conflictsWithKimiPreamble never fired on the default config.
  //
  // Net effect was the opposite of the PR's intent — the collision went away because the
  // marker was gone everywhere, which also stripped the format example from every non-Kimi
  // dialect. Pin the precondition so the mechanism cannot be hollowed out again.
  it('the shipped default carries the marker the Kimi suppression keys off', () => {
    resetSystemPrompt('toolReinforcement');
    const { toolReinforcement } = getSystemPrompts();
    assert.match(
      toolReinforcement,
      /<\s*tool_call\s*>/i,
      'default toolReinforcement must contain <tool_call>: it is both the format example for '
        + 'non-Kimi dialects and the trigger conflictsWithKimiPreamble() detects',
    );

    // And end-to-end: with the DEFAULT (not an injected string), a Kimi preamble must still
    // suppress it. This is the assertion #252 needed and did not have.
    const proto = buildSendCascadeMessageRequest(
      'k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess',
      { toolPreamble: '<|tool_calls_section_begin|>\nAvailable tools:\n<|tool_calls_section_end|>' },
    );
    const top = parseFields(proto);
    const cfg = parseFields(getField(top, 5, 2).value);
    const planner = parseFields(getField(cfg, 1, 2).value);
    const conversational = parseFields(getField(planner, 2, 2).value);
    const text = getField(parseFields(getField(conversational, 12, 2).value), 2, 2).value.toString('utf8');
    assert.match(text, /<\|tool_calls_section_begin\|>/, 'the Kimi preamble itself must survive');
    assert.doesNotMatch(
      text,
      /<\s*tool_call\s*>/i,
      'the XML reinforcement must be suppressed under a Kimi preamble, using the real default',
    );
  });

  it('includes each step as repeated field 9', () => {
    const stepA = buildAdditionalStep('view_file', { absolute_path_uri: 'file:///a', content: 'A' }, { observed: true });
    const stepB = buildAdditionalStep('run_command', { command_line: 'ls', full_output: 'a\n' }, { observed: true });
    const proto = buildSendCascadeMessageRequest(
      'k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess',
      { additionalSteps: [stepA, stepB] },
    );
    const fields = parseFields(proto);
    const additional = getAllFields(fields, 9).filter(f => f.wireType === 2);
    assert.equal(additional.length, 2, 'two repeated additional_steps expected on field 9');
  });

  it('omits field 9 when no additionalSteps provided', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {});
    const fields = parseFields(proto);
    assert.equal(getAllFields(fields, 9).length, 0);
  });

  it('nativeMode=true switches planner_mode to DEFAULT (1) and adds tool_config', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      nativeMode: true,
      nativeAllowlist: ['view_file', 'run_command'],
    });
    const top = parseFields(proto);
    const cfgField = getField(top, 5, 2);
    assert.ok(cfgField, 'cascade_config required on field 5');
    const cfg = parseFields(cfgField.value);
    const planner = parseFields(getField(cfg, 1, 2).value);
    // CascadePlannerConfig.tool_config = field 13 (CascadeToolConfig)
    const toolCfg = getField(planner, 13, 2);
    assert.ok(toolCfg, 'CascadePlannerConfig.tool_config (field 13) should be set in nativeMode');
    const tc = parseFields(toolCfg.value);
    const allow = getAllFields(tc, 32).map(f => f.value.toString('utf8'));
    assert.ok(allow.includes('view_file'));
    assert.ok(allow.includes('run_command'));
    // conversational planner sub-config (field 2) → planner_mode (field 4) = DEFAULT (1)
    const conv = parseFields(getField(planner, 2, 2).value);
    const mode = getField(conv, 4, 0);
    assert.equal(mode.value, 1, 'planner_mode in nativeMode should be DEFAULT (1)');
    assert.equal(getField(conv, 10, 2), null, 'nativeMode must not write a no-tool tool_calling_section');
    assert.equal(getField(conv, 12, 2), null, 'nativeMode must not write a no-tool additional_instructions_section');
  });

  it('native allowlist experiment aliases still enable the matching tool sub-configs', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      nativeMode: true,
      nativeAllowlist: ['read_file', 'grep_v2', 'list_dir'],
    });
    const top = parseFields(proto);
    const cfg = parseFields(getField(top, 5, 2).value);
    const planner = parseFields(getField(cfg, 1, 2).value);
    const tc = parseFields(getField(planner, 13, 2).value);
    const allow = getAllFields(tc, 32).map(f => f.value.toString('utf8'));
    assert.deepEqual(allow, ['read_file', 'grep_v2', 'list_dir']);
    assert.ok(getField(tc, 10, 2), 'read_file should still enable ViewFileToolConfig field 10');
    assert.ok(getField(tc, 33, 2), 'grep_v2 should still enable GrepV2ToolConfig field 33');
    assert.ok(getField(tc, 19, 2), 'list_dir should enable ListDirToolConfig field 19');
    assert.equal(getField(tc, 5, 2), null, 'list_dir experiment should not also enable FindToolConfig');
  });

  it('native tool config raw overrides inject exact sub-config bytes for protocol experiments', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW = 'read_file:0a03616263;grep_v2:base64:EgJwYQ==';
    try {
      const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
        nativeMode: true,
        nativeAllowlist: ['read_file', 'grep_v2'],
      });
      const top = parseFields(proto);
      const cfg = parseFields(getField(top, 5, 2).value);
      const planner = parseFields(getField(cfg, 1, 2).value);
      const tc = parseFields(getField(planner, 13, 2).value);
      assert.equal(getField(tc, 10, 2).value.toString('hex'), '0a03616263');
      assert.equal(getField(tc, 33, 2).value.toString('hex'), '12027061');
      assert.deepEqual(getAllFields(tc, 32).map(f => f.value.toString('utf8')), ['read_file', 'grep_v2']);
    } finally {
      delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW;
    }
  });

  it('native tool config raw overrides can inject unknown top-level fields for matrix experiments', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW = 'field42:0a03776562;field40:';
    try {
      const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
        nativeMode: true,
        nativeAllowlist: ['search_web', 'read_url_content'],
      });
      const top = parseFields(proto);
      const cfg = parseFields(getField(top, 5, 2).value);
      const planner = parseFields(getField(cfg, 1, 2).value);
      const tc = parseFields(getField(planner, 13, 2).value);
      assert.equal(getField(tc, 42, 2).value.toString('hex'), '0a03776562');
      assert.equal(getField(tc, 40, 2).value.length, 0);
      assert.deepEqual(getAllFields(tc, 32).map(f => f.value.toString('utf8')), ['search_web', 'read_url_content']);
    } finally {
      delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW;
    }
  });

  it('native allowlist emits confirmed WebSearch/WebFetch tool-config fields', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      nativeMode: true,
      nativeAllowlist: ['search_web', 'read_url_content'],
    });
    const top = parseFields(proto);
    const cfg = parseFields(getField(top, 5, 2).value);
    const planner = parseFields(getField(cfg, 1, 2).value);
    const tc = parseFields(getField(planner, 13, 2).value);
    assert.equal(getField(tc, 13, 2).value.length, 0, 'search_web should use SearchWebToolConfig field 13');
    assert.equal(getField(tc, 37, 2).value.length, 0, 'read_url_content should use ReadUrlContentToolConfig field 37');
    assert.deepEqual(getAllFields(tc, 32).map(f => f.value.toString('utf8')), ['search_web', 'read_url_content']);
  });

  it('native tool config raw overrides support web tool aliases', () => {
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW = 'search_web:0800;read_url_content:0a00';
    try {
      const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
        nativeMode: true,
        nativeAllowlist: ['search_web', 'read_url_content'],
      });
      const top = parseFields(proto);
      const cfg = parseFields(getField(top, 5, 2).value);
      const planner = parseFields(getField(cfg, 1, 2).value);
      const tc = parseFields(getField(planner, 13, 2).value);
      assert.equal(getField(tc, 13, 2).value.toString('hex'), '0800');
      assert.equal(getField(tc, 37, 2).value.toString('hex'), '0a00');
    } finally {
      delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW;
    }
  });

  it('nativeMode=true can carry environment facts without tool emulation schema', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      nativeMode: true,
      nativeAllowlist: ['view_file'],
      nativeEnvironment: '- Working directory: /repo\n- Platform: linux',
    });
    const top = parseFields(proto);
    const cfg = parseFields(getField(top, 5, 2).value);
    const planner = parseFields(getField(cfg, 1, 2).value);
    const conv = parseFields(getField(planner, 2, 2).value);
    assert.equal(getField(conv, 4, 0).value, 1, 'nativeMode still uses DEFAULT planner');
    assert.equal(getField(conv, 10, 2), null, 'native env must not inject tool_calling_section schemas');
    const additional = getField(conv, 12, 2);
    assert.ok(additional, 'native env should be written to additional_instructions_section');
    const section = parseFields(additional.value);
    const text = getField(section, 2, 2)?.value?.toString('utf8') || '';
    assert.match(text, /Working directory: \/repo/);
    assert.match(text, /built-in IDE tools/);
    assert.doesNotMatch(text, /You have access to the following functions/);
    assert.doesNotMatch(text, /<tool_call>/);
  });

  it('nativeMode=false (default) keeps planner_mode = NO_TOOL (3) and skips tool_config', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {});
    const top = parseFields(proto);
    const cfg = parseFields(getField(top, 5, 2).value);
    const planner = parseFields(getField(cfg, 1, 2).value);
    assert.equal(getField(planner, 13, 2), null, 'tool_config should NOT be set when nativeMode is off');
    const conv = parseFields(getField(planner, 2, 2).value);
    assert.equal(getField(conv, 4, 0).value, 3);
  });
});

describe('CASCADE_STEP type constants — sanity', () => {
  it('matches proto field numbers used in oneof', () => {
    assert.equal(CASCADE_STEP.view_file.typeEnum, 8);
    assert.equal(CASCADE_STEP.run_command.typeEnum, 21);
    assert.equal(CASCADE_STEP.grep_search_v2.typeEnum, 91);
    assert.equal(CASCADE_STEP.find.typeEnum, 25);
    assert.equal(CASCADE_STEP.list_directory.typeEnum, 9);
    assert.equal(CASCADE_STEP.write_to_file.typeEnum, 16);
  });
});

// ─── v2.0.66 (#115) — partition mode + codex CLI mapping ──────────────

describe('partitionTools — v2.0.66 mixed-mapping splitter', () => {
  it('splits mapped vs unmapped on a real codex CLI 0.128 toolset (web_search default-off)', () => {
    // Captured live from `dump-codex-tools.mjs`: codex CLI 0.128 declares
    // these 11 tools by default. Native web search/fetch remain opt-in in
    // the bridge allowlist, so the default mapped set stays shell-only.
    const codexTools = [
      'shell_command', 'update_plan', 'request_user_input',
      'apply_patch', 'web_search', 'view_image',
      'spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent',
    ].map(fnTool);
    const part = partitionTools(codexTools);
    assert.equal(part.hasAny, true);
    const mappedNames = part.mapped.map(t => t.function.name).sort();
    assert.deepEqual(mappedNames, ['shell_command']);
    assert.equal(part.unmapped.length, 10);
    assert.ok(part.unmapped.find(t => t.function.name === 'apply_patch'));
    assert.ok(part.unmapped.find(t => t.function.name === 'update_plan'));
    assert.ok(part.unmapped.find(t => t.function.name === 'web_search'));
  });

  it('returns hasAny=false when no tool maps', () => {
    const part = partitionTools([fnTool('get_weather'), fnTool('rng')]);
    assert.equal(part.hasAny, false);
    assert.equal(part.mapped.length, 0);
    assert.equal(part.unmapped.length, 2);
  });

  it('Claude Code-style tools keep Read/Glob out of the default native scope', () => {
    const part = partitionTools([fnTool('Read'), fnTool('Bash'), fnTool('Glob')]);
    assert.equal(part.hasAny, true);
    assert.deepEqual(part.mapped.map(t => t.function.name), ['Bash']);
    assert.deepEqual(part.unmapped.map(t => t.function.name), ['Read', 'Glob']);
  });

  it('skips non-function entries gracefully', () => {
    const part = partitionTools([
      fnTool('Read'),
      { type: 'web_search' },
      { type: 'function' },                 // missing function.name
      { type: 'function', function: { name: '' } },
    ]);
    assert.equal(part.mapped.length, 0);
    assert.equal(part.unmapped.length, 1);
  });
});

describe('TOOL_MAP — codex CLI 0.128 shell_command mapping (v2.0.66)', () => {
  it('shell_command ↔ run_command preserves command + workdir', () => {
    const fwd = TOOL_MAP.shell_command.forward({
      command: 'pytest -x',
      workdir: 'D:/Project/foo',
      timeout_ms: 30000,
    });
    assert.equal(fwd.command_line, 'pytest -x');
    assert.equal(fwd.cwd, 'D:/Project/foo');
    assert.equal(fwd.blocking, true);
    const back = TOOL_MAP.shell_command.reverse(fwd);
    assert.equal(back.command, 'pytest -x');
    assert.equal(back.workdir, 'D:/Project/foo');
  });

  it('shell_command reverse maps cascade combined_output → codex shell schema', () => {
    // Simulates the trajectory step → tool_call reverse direction the
    // proxy uses when surfacing a cascade-side run_command back to the
    // codex CLI client.
    const back = TOOL_MAP.shell_command.reverse({
      command_line: 'echo hi',
      cwd: '/tmp',
      stdout: 'hi\n',
    });
    assert.equal(back.command, 'echo hi');
    assert.equal(back.workdir, '/tmp');
  });
});

describe('canMapAllTools (legacy strict gate, kept for compat)', () => {
  it('still returns false when ANY tool is unmapped', () => {
    assert.equal(canMapAllTools([fnTool('Read'), fnTool('get_weather')]), false);
    assert.equal(canMapAllTools([fnTool('Read'), fnTool('Bash'), fnTool('Glob')]), false);
  });
});

describe('mergeReasoningEffortIntoModel — v2.0.66 reasoning_effort fold-in', () => {
  it('codex CLI shape (reasoning.effort) folds into bare gpt-5.5', async () => {
    const { mergeReasoningEffortIntoModel } = await import('../src/handlers/chat.js');
    assert.equal(
      mergeReasoningEffortIntoModel('gpt-5.5', { reasoning: { effort: 'xhigh' } }),
      'gpt-5.5-xhigh',
    );
    assert.equal(
      mergeReasoningEffortIntoModel('gpt-5.5', { reasoning: { effort: 'high' } }),
      'gpt-5.5-high',
    );
  });

  it('OpenAI-style (top-level reasoning_effort) also works', async () => {
    const { mergeReasoningEffortIntoModel } = await import('../src/handlers/chat.js');
    assert.equal(
      mergeReasoningEffortIntoModel('gpt-5.5', { reasoning_effort: 'low' }),
      'gpt-5.5-low',
    );
  });

  it('an explicit effort suffix is authoritative over the effort field (CompatClients F1)', async () => {
    const { mergeReasoningEffortIntoModel } = await import('../src/handlers/chat.js');
    // This case used to pin the OPPOSITE (suffix stripped and replaced), which
    // is the defect Codex hit: it sends reasoning.effort=medium on every turn,
    // so gpt-6-luna-max was served as gpt-6-luna-medium. An explicit tier in
    // the model id is the caller's selection and must win in both directions —
    // a -medium request must not be promoted either.
    assert.equal(
      mergeReasoningEffortIntoModel('gpt-6-luna-max', { reasoning: { effort: 'medium' } }),
      'gpt-6-luna-max',
    );
    assert.equal(
      mergeReasoningEffortIntoModel('gpt-5.5-xhigh', { reasoning: { effort: 'medium' } }),
      'gpt-5.5-xhigh',
    );
    assert.equal(
      mergeReasoningEffortIntoModel('claude-opus-4-8-medium', { reasoning: { effort: 'xhigh' } }),
      'claude-opus-4-8-medium',
    );
    // No suffix in the request → the effort field still supplies the tier.
    assert.equal(
      mergeReasoningEffortIntoModel('claude-opus-4.8', { reasoning_effort: 'max' }),
      'claude-opus-4.8-max',
    );
  });

  it('returns input unchanged when effort missing', async () => {
    const { mergeReasoningEffortIntoModel } = await import('../src/handlers/chat.js');
    assert.equal(mergeReasoningEffortIntoModel('gpt-5.5', {}), 'gpt-5.5');
    assert.equal(mergeReasoningEffortIntoModel('gpt-5.5', { reasoning: {} }), 'gpt-5.5');
    assert.equal(mergeReasoningEffortIntoModel('gpt-5.5', { reasoning: { effort: '' } }), 'gpt-5.5');
  });

  it('returns input unchanged for unknown effort strings (catalog has no -bogus variant)', async () => {
    const { mergeReasoningEffortIntoModel } = await import('../src/handlers/chat.js');
    assert.equal(mergeReasoningEffortIntoModel('gpt-5.5', { reasoning_effort: 'bogus' }), 'gpt-5.5');
  });

  it('returns input unchanged when merged model is not in catalog', async () => {
    const { mergeReasoningEffortIntoModel } = await import('../src/handlers/chat.js');
    // claude models don't have effort suffixes — the merged form
    // `claude-sonnet-4.6-xhigh` doesn't exist in models.js, so the helper
    // refuses to swap.
    assert.equal(
      mergeReasoningEffortIntoModel('claude-sonnet-4.6', { reasoning: { effort: 'xhigh' } }),
      'claude-sonnet-4.6',
    );
  });

  it('handles `minimal` by mapping to `none` (windsurf catalog naming)', async () => {
    const { mergeReasoningEffortIntoModel } = await import('../src/handlers/chat.js');
    // gpt-5.5-none is in the catalog (the lowest tier alias)
    assert.equal(
      mergeReasoningEffortIntoModel('gpt-5.5', { reasoning_effort: 'minimal' }),
      'gpt-5.5-none',
    );
  });
});

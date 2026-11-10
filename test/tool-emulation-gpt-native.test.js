// v2.0.62 (#115) — gpt_native dialect for GPT family models on the
// /v1/responses (Codex CLI) route. Verifies dialect dispatch, the
// strong anti-refusal preamble, history serializer, and round-trip
// parsing of bare-JSON function_call output through the stream parser.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickToolDialect,
  buildToolPreambleForProto,
  ToolCallStreamParser,
  parseToolCallsFromText,
  normalizeMessagesForCascade,
} from '../src/handlers/tool-emulation.js';

describe('pickToolDialect — gpt_native gating (v2.0.62 #115)', () => {
  it('GPT family + responses route → gpt_native', () => {
    assert.equal(pickToolDialect('gpt-5.5-medium', 'openai', 'responses'), 'gpt_native');
    assert.equal(pickToolDialect('gpt-4.1-mini', 'openai', 'responses'), 'gpt_native');
    assert.equal(pickToolDialect('o3-mini', 'openai', 'responses'), 'gpt_native');
    assert.equal(pickToolDialect('o4-preview', 'openai', 'responses'), 'gpt_native');
  });

  it('GPT family + chat route → gpt_native for 5.4+ (XML refusal), XML below', () => {
    // GPT-5.4+ refuses the XML protocol on chat routes too (observed 5.4 xhigh via opencode).
    assert.equal(pickToolDialect('gpt-5.5-medium', 'openai', 'chat'), 'gpt_native');
    assert.equal(pickToolDialect('gpt-5.5-medium', 'openai'), 'gpt_native');
    assert.equal(pickToolDialect('gpt-5.4-xhigh', 'openai', 'chat'), 'gpt_native');
    assert.equal(pickToolDialect('gpt-5.6-luna-medium', 'openai', 'chat'), 'gpt_native');
    // devin_connect 传连字符形态（catalog selector）——dashed 折叠后同样命中
    assert.equal(pickToolDialect('gpt-5-4-medium', 'openai', 'chat'), 'gpt_native');
    assert.equal(pickToolDialect('gpt-5-4-xhigh', 'openai', 'chat'), 'gpt_native');
    assert.equal(pickToolDialect('gpt-5-6-luna-medium', 'openai', 'chat'), 'gpt_native');
    assert.equal(pickToolDialect('gpt-5-3-codex', 'openai', 'chat'), 'openai_json_xml', '5.3 dashed keeps XML');
    // 5.1/5.2/5.3 and older keep the original #115 gate (chat → XML).
    assert.equal(pickToolDialect('gpt-5.2-medium', 'openai', 'chat'), 'openai_json_xml');
    assert.equal(pickToolDialect('gpt-5.3-codex', 'openai', 'chat'), 'openai_json_xml');
    assert.equal(pickToolDialect('gpt-4.1-mini', 'openai', 'chat'), 'openai_json_xml');
    assert.equal(pickToolDialect('gpt-4o-mini', 'openai', null), 'openai_json_xml');
  });

  it('non-GPT models on responses route → openai_json_xml (gpt_native is GPT-only)', () => {
    assert.equal(pickToolDialect('claude-sonnet-4.6', 'anthropic', 'responses'), 'openai_json_xml');
    assert.equal(pickToolDialect('gemini-3.0-flash', 'google', 'responses'), 'openai_json_xml');
  });

  it('GLM and Kimi precedence beats GPT detection', () => {
    // glm-5 is a genuine glm47 model, so it still proves the GLM branch wins over
    // GPT detection on the responses route (where a GPT name would pick gpt_native).
    assert.equal(pickToolDialect('glm-5', 'zhipu', 'responses'), 'glm47');
    assert.equal(pickToolDialect('kimi-k2', 'moonshot', 'responses'), 'kimi_k2');
  });

  // GLM-5.1 / GLM-5.2 arrive under both spellings — resolveConnectSelector maps
  // `glm-5.1` / `glm-5-1` and `glm-5.2` / `glm-5-2` onto the SAME upstream selector
  // (`glm-5-2`), so a client may legitimately send either, and clients do (#236 came in
  // reporting `glm-5-2-none`). Every spelling must land on gpt_native, because the
  // v2.0.72 probe found this model IGNORES the glm47 XML markup: the wrong dialect means
  // plain-text answers with no tool call emitted, and a client that waits forever for one.
  //
  // Bare `glm-5-2` was the first form that got it wrong — not equal to `glm-5.2`, and with
  // no trailing dash neither prefix test fired, so it fell through to glm47. `glm-5-1`
  // (and the dotted `glm-5.1` after dot-collapse) was the second: the old `[2-9]` class
  // started at 5.2, so the whole 5.1 alias family landed on the dialect it ignores.
  it('every GLM-5.1 / GLM-5.2 spelling gets gpt_native, dotted or dashed, bare or suffixed', () => {
    for (const key of [
      'glm-5.2', 'glm-5-2',
      'glm-5.2-none', 'glm-5-2-none',
      'glm-5.2-high', 'glm-5-2-high',
      'GLM-5-2', 'GLM-5.2-NONE',
      'glm-5.1', 'glm-5-1',
      'glm-5.1-none', 'glm-5-1-none',
      'GLM-5-1', 'GLM-5.1-NONE',
    ]) {
      assert.equal(pickToolDialect(key, 'zhipu'), 'gpt_native',
        `${key} must use gpt_native — glm47 markup is ignored by this model, so the wrong `
        + 'dialect emits no tool call and stalls the client');
    }
  });

  it('and the fix does not drag other GLM models onto gpt_native', () => {
    // The dot-collapse must not widen the match. glm-4.7 and bare glm-5 are different
    // models and the glm47 dialect is correct for them; a `startsWith('glm-5')` style fix
    // would have swallowed them. The `-12` / `-1x` entries pin the boundary of the
    // `(?:1|[2-9])(?:-|$)` class: a bare `1` may only match when the minor version ends
    // there, so a hypothetical 5.12 or 5.1x is NOT silently treated as 5.1.
    for (const key of ['glm-4.7', 'glm-4-7', 'glm-5', 'glm-5-12', 'glm-5-1x']) {
      assert.equal(pickToolDialect(key, 'zhipu'), 'glm47', `${key} must stay on glm47`);
    }
  });

  it('dialect table: GLM 5.1 alias family → gpt_native, bare glm-5 and 4.x → glm47', () => {
    // The acceptance table for the glm-5-1 alias/dialect fix. Pinned as data so a future
    // regex widening (or narrowing) cannot quietly move a model onto the dialect it
    // ignores — the failure mode is a silent no-tool-call stall, not an error.
    const table = [
      ['glm-5-1', 'gpt_native'],
      ['glm-5.1', 'gpt_native'],
      ['glm-5-2', 'gpt_native'],
      ['glm-5.2', 'gpt_native'],
      ['glm-5', 'glm47'],
      ['glm-4.7', 'glm47'],
      ['glm-4-7', 'glm47'],
    ];
    for (const [model, dialect] of table) {
      assert.equal(pickToolDialect(model, 'zhipu'), dialect, `${model} must use ${dialect}`);
    }
  });

  it('strips a provider prefix before the family checks', () => {
    // The selector resolver already strips `provider/` (resolveConnectSelector:
    // `.replace(/^[a-z0-9][a-z0-9-]*\//, '')` — S3 widened it so `x-ai/` and
    // `z-ai/` strip too), so `zhipu/glm-5.1` and `anthropic/claude-…` route to
    // the right upstream model. pickToolDialect saw the RAW name, so every
    // prefixed name missed its family rule: `zhipu/glm-5.1` fell through the
    // `startsWith('glm')` test to openai_json_xml (glm47-adjacent wrong answer,
    // and glm-5.1 ignores XML markup), and a prefixed Kimi lost kimi_k2.
    // The stall is silent — the model answers in plain text and the client waits
    // for a tool call that never arrives.
    assert.equal(pickToolDialect('zhipu/glm-5.1', 'zhipu'), 'gpt_native',
      'prefixed GLM with the provider argument still gets the GLM family dialect');
    assert.equal(pickToolDialect('zhipu/glm-5.1', null), 'gpt_native',
      'the prefix alone must be enough — provider is optional');
    assert.equal(pickToolDialect('moonshot/kimi-k2', null), 'kimi_k2',
      'prefixed Kimi keeps its family dialect');
    assert.equal(pickToolDialect('moonshot/kimi-k2.6', null), 'openai_json_xml',
      'prefixed newer Kimi keeps the newer-SKU dialect');

    // No family rule fires for Claude, and the prefix must not invent one.
    assert.equal(pickToolDialect('anthropic/claude-sonnet-4.6', null), 'openai_json_xml');
    assert.equal(pickToolDialect('anthropic/claude-sonnet-4.6', 'anthropic', 'responses'), 'openai_json_xml');
    // GPT: prefixed and bare must agree, on both routes.
    assert.equal(pickToolDialect('openai/gpt-4o-mini', null), 'openai_json_xml');
    assert.equal(pickToolDialect('openai/gpt-5-4-medium', null), 'gpt_native',
      'prefixed 5.4+ matches bare gpt-5-4-medium, which refuses XML on chat');
    assert.equal(pickToolDialect('openai/gpt-4.1-mini', 'openai', 'responses'), 'gpt_native');

    // Normalization happens ONCE: a second segment is not another provider prefix.
    assert.equal(pickToolDialect('foo/bar/baz', null), 'openai_json_xml');
    assert.equal(pickToolDialect('x/y/glm-5.1', null), 'openai_json_xml',
      'stripping twice would expose glm-5.1 and wrongly return gpt_native');
  });

  it('matches family rules against the dotted spelling (S2)', () => {
    // S2: the resolver collapses dots before every lookup, so `gpt.5.5.low` ROUTES
    // to gpt-5-5-low — but pickToolDialect tested its family regexes against the
    // literal spelling. `gpt.5.5.low` matched neither `/^(?:gpt-|o3|o4)/` nor the
    // 5.4+ test nested inside it, so a model documented to refuse the XML protocol
    // ran on it. Collapse dots ONCE at the top of the function (the GLM branch
    // already did this locally) and match every family regex against the result.
    assert.equal(pickToolDialect('gpt.5.5.low', null), 'gpt_native',
      'dotted 5.5 resolves to gpt-5-5-low, which refuses the XML protocol');
    assert.equal(pickToolDialect('gpt.5.6-luna', null), 'gpt_native');
    assert.equal(pickToolDialect('gpt5.6-luna', null), 'gpt_native',
      'the compact spelling routes to the same selector as gpt.5.6-luna');
    assert.equal(pickToolDialect('swe.1.5', null), 'kimi_k2',
      'dotted SWE-1.5 is the same model as swe-1.5, so it must not change dialect');
    assert.equal(pickToolDialect('kimi.k2', null), 'kimi_k2',
      'dotted Kimi K2 is the same model as kimi-k2 (vLLM markup)');
    // No family is invented by the collapse.
    assert.equal(pickToolDialect('claude.opus.4.8', null), 'openai_json_xml');
    assert.equal(pickToolDialect('glm-5.12', 'zhipu'), 'glm47');
    assert.equal(pickToolDialect('glm-5-12', 'zhipu'), 'glm47');
  });

  it('gives the SWE-1.5 enum target the same dialect as its alias (S7)', () => {
    // S7: SELECTOR_MAP resolves the SWE-1.5 aliases to ENUM selectors
    // (`swe-1-5` → MODEL_SWE_1_5_SLOW, `swe-1-5-fast` → MODEL_SWE_1_5). The family
    // rule matched the alias spelling but not the enum, so the SAME model got
    // kimi_k2 under one spelling and openai_json_xml under the other — a client
    // could flip the protocol by renaming the model. The alias is the observed
    // spelling (production 2026-08-07: SWE-1.5 emits Kimi section tokens), and
    // `_SLOW` is the slow MODE of SWE-1.5, not the distinct deployment selector
    // `swe-1-6-slow` that the exclusion below is about.
    assert.equal(pickToolDialect('swe-1-5', null), 'kimi_k2');
    assert.equal(pickToolDialect('MODEL_SWE_1_5_SLOW', null), 'kimi_k2',
      'the enum spelling names the same model as swe-1-5');
    assert.equal(pickToolDialect('swe-1-5-fast', null), 'kimi_k2');
    assert.equal(pickToolDialect('MODEL_SWE_1_5', null), 'kimi_k2',
      'the fast enum names the same model as swe-1-5-fast');
    // The distinct-deployment exclusion is unchanged.
    assert.equal(pickToolDialect('swe-1-6-slow', null), 'openai_json_xml');
    assert.equal(pickToolDialect('swe-1-7-lightning', null), 'openai_json_xml');
  });

  it('uses exactly the resolver prefix rule (P2-2)', () => {
    // The strip must be the SAME rule the resolver applies, or the dialect can be
    // chosen for a model the request never runs on. The resolver's rule is
    // `/^[a-z0-9][a-z0-9-]*\//` (S3 widened it for `x-ai/` / `z-ai/`) and it does
    // NOT treat an underscore segment as a provider. The dialect strip previously
    // allowed `_`, so `foo_bar/glm-5.1` picked gpt_native while the resolver
    // degraded the same name to free.
    assert.equal(pickToolDialect('foo_bar/glm-5.1', null), 'openai_json_xml',
      'the resolver does not strip `_` segments, so neither may the dialect');
    assert.equal(pickToolDialect('x-ai/glm-5.1', null), 'gpt_native');
    assert.equal(pickToolDialect('z-ai/glm-5.1', null), 'gpt_native');
    assert.equal(pickToolDialect('9lives/glm-5.1', null), 'gpt_native',
      'the resolver prefix may start with a digit');
    assert.equal(pickToolDialect('x/y/glm-5.1', null), 'openai_json_xml',
      'single strip only');
  });

  it('WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT=1 forces gpt_native on chat route too', () => {
    const orig = process.env.WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT;
    process.env.WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT = '1';
    try {
      assert.equal(pickToolDialect('gpt-5.5-medium', 'openai', 'chat'), 'gpt_native');
    } finally {
      if (orig === undefined) delete process.env.WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT;
      else process.env.WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT = orig;
    }
  });
});

describe('gpt_native preamble — strong anti-refusal language', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }];

  it('preamble includes function_call JSON shape, not <tool_call> XML', () => {
    const p = buildToolPreambleForProto(tools, 'auto', '', 'gpt-5.5-medium', 'openai', 'responses');
    assert.match(p, /function_call/, 'must mention function_call shape');
    assert.match(p, /"name"\s*:/, 'must show JSON shape');
    assert.match(p, /"arguments"\s*:/, 'must show arguments key');
    assert.doesNotMatch(p, /<tool_call>/, 'gpt_native must NOT use <tool_call> XML wrapper');
  });

  it('preamble has explicit anti-refusal phrasing', () => {
    const p = buildToolPreambleForProto(tools, 'auto', '', 'gpt-5.5-medium', 'openai', 'responses');
    assert.match(p, /forbidden|DO NOT|never refuse|are available|are real/i,
      'preamble must reject "I cannot read files / paste me the file" patterns');
  });

  it('preamble forbids markdown fence around the JSON', () => {
    const p = buildToolPreambleForProto(tools, 'auto', '', 'gpt-5.5-medium', 'openai', 'responses');
    assert.match(p, /NO\s+markdown|no\s+markdown|no\s+\`\`\`json|NO\s+\`\`\`/i);
  });

  it('non-responses route on gpt-5.2 keeps openai_json_xml preamble (XML wrapper)', () => {
    // 5.4+ chat switched to gpt_native; 5.2 keeps the #115 back-compat gate.
    const p = buildToolPreambleForProto(tools, 'auto', '', 'gpt-5.2-medium', 'openai', 'chat');
    assert.match(p, /<tool_call>/, 'chat route on 5.2 must keep XML wrapper for back-compat');
  });
  it('non-responses route on gpt-5.5 now gets gpt_native preamble', () => {
    const p = buildToolPreambleForProto(tools, 'auto', '', 'gpt-5.5-medium', 'openai', 'chat');
    assert.match(p, /function_call/, 'chat route on 5.5 must use gpt_native (XML refusal)');
    assert.ok(!p.includes('<tool_call>'), '5.5 chat must not use XML wrapper');
  });
});

describe('gpt_native history serializer', () => {
  it('emits {"function_call":{...}} for assistant tool_calls in history', () => {
    // normalizeMessagesForCascade reformats prior assistant tool_calls into
    // the dialect's expected on-wire form so the model sees its own past
    // calls in the same shape it's now asked to emit.
    const messages = [
      { role: 'user', content: 'weather please' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    ];
    const out = normalizeMessagesForCascade(messages, [], {
      modelKey: 'gpt-5.5-medium',
      provider: 'openai',
      route: 'responses',
    });
    const assistantTurn = out.find(m => m.role === 'assistant' && typeof m.content === 'string');
    assert.ok(assistantTurn, 'assistant turn should be present after normalization');
    assert.match(assistantTurn.content, /"function_call"\s*:/);
    assert.match(assistantTurn.content, /"name"\s*:\s*"get_weather"/);
    assert.match(assistantTurn.content, /"city"\s*:\s*"Tokyo"/);
    assert.doesNotMatch(assistantTurn.content, /<tool_call>/, 'must NOT use XML wrapper for gpt_native');
  });
});

describe('gpt_native parser — stream + flush', () => {
  it('parseToolCallsFromText extracts {"function_call":{...}} bare-JSON output', () => {
    const text = 'I will check the weather.\n{"function_call":{"name":"get_weather","arguments":{"city":"Berlin"}}}';
    const r = parseToolCallsFromText(text, {
      modelKey: 'gpt-5.5-medium',
      provider: 'openai',
      route: 'responses',
    });
    assert.equal(r.toolCalls.length, 1, 'one tool call expected');
    assert.equal(r.toolCalls[0].name, 'get_weather');
    const args = JSON.parse(r.toolCalls[0].argumentsJson);
    assert.equal(args.city, 'Berlin');
  });

  it('parses bare {"name":...,"arguments":...} when GPT skips the function_call wrapper', () => {
    const text = '{"name":"Read","arguments":{"file_path":"/etc/hosts"}}';
    const r = parseToolCallsFromText(text, {
      modelKey: 'gpt-5.5-medium',
      provider: 'openai',
      route: 'responses',
    });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'Read');
    assert.match(r.toolCalls[0].argumentsJson, /"file_path"\s*:\s*"\/etc\/hosts"/);
  });

  it('parses multiple function_call objects (parallel calls, one per line)', () => {
    const text = '{"function_call":{"name":"Read","arguments":{"file":"a.md"}}}\n'
               + '{"function_call":{"name":"Read","arguments":{"file":"b.md"}}}';
    const r = parseToolCallsFromText(text, {
      modelKey: 'gpt-5.5-medium',
      provider: 'openai',
      route: 'responses',
    });
    assert.equal(r.toolCalls.length, 2, 'two parallel calls');
    assert.equal(r.toolCalls[0].name, 'Read');
    assert.equal(r.toolCalls[1].name, 'Read');
  });

  it('plain prose without JSON falls through as text (non-tool turn)', () => {
    const text = 'Hello! How can I help you today?';
    const r = parseToolCallsFromText(text, {
      modelKey: 'gpt-5.5-medium',
      provider: 'openai',
      route: 'responses',
    });
    assert.equal(r.toolCalls.length, 0, 'no tool call');
    assert.match(r.text, /Hello!/);
  });

  it('stream parser holds back JSON sentinels until full object is closed', () => {
    const parser = new ToolCallStreamParser({
      modelKey: 'gpt-5.5-medium',
      provider: 'openai',
      route: 'responses',
    });
    // First chunk: just the start of the JSON object.
    const a = parser.feed('{"function_call":{"name":"Read",');
    assert.equal(a.toolCalls.length, 0, 'no call yet — JSON not closed');
    // Second chunk: rest of the JSON.
    const b = parser.feed('"arguments":{"file":"x.md"}}}');
    const c = parser.flush();
    const allCalls = [...a.toolCalls, ...b.toolCalls, ...c.toolCalls];
    assert.equal(allCalls.length, 1, 'one tool call after full object received');
    assert.equal(allCalls[0].name, 'Read');
  });
});

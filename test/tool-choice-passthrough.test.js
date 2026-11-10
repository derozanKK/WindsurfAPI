// tool_choice (#12) / disable_parallel_tool_calls (#11) passthrough — opt-in.
//
// Before this, the repo could only CLASSIFY tool_choice for cache-keying and
// prompt-emulation decisions (handlers/chat.js:347) — it never reached the upstream,
// so 'required' could not be honoured natively and a forced tool name was a request
// we silently downgraded.
//
// The tags come from third-party .proto DECLARATION ORDER, not a wire capture, and
// prost allows tag gaps — so declaration order is not a tag number. Same position as
// the billing tags and #13, same treatment: default-OFF, operator-overridable tags.
// These tests pin the OFF path hardest, because every operator who never sets the
// variable is on it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGetChatMessageRequest,
  buildToolChoice,
  normalizeToolChoice,
  getToolChoiceTags,
  isToolChoicePassthroughEnabled,
} from '../src/devin-connect.js';
import { parseFields, getField, writeStringField } from '../src/proto.js';

const ON = { DEVIN_CONNECT_TOOL_CHOICE: '1' };

function request(env, { toolChoice, parallelToolCalls } = {}) {
  return buildGetChatMessageRequest({
    token: 'devin-session-token$a.b.c',
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    env,
    toolChoice,
    parallelToolCalls,
    deviceSeed: 'stable',
  });
}
const hasField = (proto, n) => parseFields(proto).some((f) => f.field === n);
const str = (fields, n) => getField(fields, n, 2)?.value?.toString('utf8');

describe('isToolChoicePassthroughEnabled — default OFF, exact "1"', () => {
  it('is off unless the value is exactly "1"', () => {
    assert.equal(isToolChoicePassthroughEnabled({}), false);
    for (const v of ['', '0', 'false', 'true', 'yes']) {
      assert.equal(isToolChoicePassthroughEnabled({ DEVIN_CONNECT_TOOL_CHOICE: v }), false,
        `"${v}" must not enable an unconfirmed wire field`);
    }
    assert.equal(isToolChoicePassthroughEnabled(ON), true);
  });
});

describe('normalizeToolChoice', () => {
  it('maps none / required / any to an option name', () => {
    assert.deepEqual(normalizeToolChoice('none'), { optionName: 'none', toolName: null });
    assert.deepEqual(normalizeToolChoice('required'), { optionName: 'required', toolName: null });
    // 'any' is Anthropic's spelling of OpenAI's 'required' — both mean "call >=1 tool".
    assert.deepEqual(normalizeToolChoice('any'), { optionName: 'required', toolName: null });
  });

  it('is case- and whitespace-insensitive', () => {
    assert.deepEqual(normalizeToolChoice('  REQUIRED '), { optionName: 'required', toolName: null });
  });

  it('returns null for auto and for absent input', () => {
    // 'auto' IS the upstream default, so emitting it would add a field that changes
    // nothing while widening an unconfirmed surface.
    for (const v of ['auto', 'AUTO', null, undefined, '', 'nonsense']) {
      assert.equal(normalizeToolChoice(v), null, `${JSON.stringify(v)} must not produce a field`);
    }
  });

  it('extracts a forced function name from either shape', () => {
    assert.deepEqual(normalizeToolChoice({ type: 'function', function: { name: 'get_weather' } }),
      { optionName: 'function', toolName: 'get_weather' });
    assert.deepEqual(normalizeToolChoice({ name: 'bare_shape' }),
      { optionName: 'function', toolName: 'bare_shape' });
  });

  it('returns null for an object with no usable name instead of emitting an empty one', () => {
    for (const v of [{}, { function: {} }, { function: { name: '   ' } }, { name: 42 }]) {
      assert.equal(normalizeToolChoice(v), null, `${JSON.stringify(v)} must not force an unnamed tool`);
    }
  });
});

describe('buildToolChoice', () => {
  it('returns null when the switch is off, whatever the choice', () => {
    for (const tc of ['required', 'none', { function: { name: 'x' } }]) {
      assert.equal(buildToolChoice(tc, {}), null);
    }
  });

  it('encodes exactly one oneof member: tool_name for a forced tool, option_name otherwise', () => {
    // ChatToolChoice is `oneof choice { option_name = 1; tool_name = 2; }`.
    // Emitting BOTH (as this did) is a schema violation: a conformant decoder
    // keeps only the last member, so the forced name and the "function" option
    // overwrote each other depending on decode order.
    const forcedBuf = buildToolChoice({ function: { name: 'get_weather' } }, ON);
    const forced = parseFields(forcedBuf);
    assert.equal(str(forced, 2), 'get_weather');
    assert.equal(forced.some((f) => f.field === 1), false,
      'a named tool must NOT also carry option_name (#1)');
    assert.deepEqual(forcedBuf, writeStringField(2, 'get_weather'),
      'the encoded bytes are exactly one tool_name member');

    const requiredBuf = buildToolChoice('required', ON);
    const required = parseFields(requiredBuf);
    assert.equal(str(required, 1), 'required');
    assert.equal(required.some((f) => f.field === 2), false,
      'a non-forced choice must not carry an empty tool_name');
    assert.deepEqual(requiredBuf, writeStringField(1, 'required'),
      'the encoded bytes are exactly one option_name member');
  });
});

describe('getToolChoiceTags — operator override', () => {
  it('defaults to choice=12 parallel=11', () => {
    assert.deepEqual({ ...getToolChoiceTags({}) }, { choice: 12, parallel: 11 });
  });

  it('honours a re-point and ignores garbage entries', () => {
    const t = getToolChoiceTags({ DEVIN_CONNECT_TOOL_CHOICE_TAGS: 'choice=30,parallel=notanumber,bogus=5' });
    assert.equal(t.choice, 30, 'a valid override applies');
    assert.equal(t.parallel, 11, 'an invalid value keeps the default rather than breaking decode');
  });

  it('rejects non-positive tags', () => {
    const t = getToolChoiceTags({ DEVIN_CONNECT_TOOL_CHOICE_TAGS: 'choice=0,parallel=-3' });
    assert.deepEqual({ ...t }, { choice: 12, parallel: 11 });
  });

  it('refuses an override that collides with a field the request already emits', () => {
    // Found by attacking this feature after it shipped. protobuf permits a repeated
    // appearance of a non-repeated field and decoders take the LAST, so pointing
    // `choice` at #1 emitted a second #1 beside the ~800-byte ClientMetadata and let a
    // 10-byte tool_choice overwrite the metadata the upstream AUTHENTICATES on. It
    // surfaced as an auth failure, not as a config typo.
    for (const tag of [1, 2, 3, 7, 8, 15, 16, 20, 21, 22]) {
      const t = getToolChoiceTags({ DEVIN_CONNECT_TOOL_CHOICE_TAGS: `choice=${tag}` });
      assert.equal(t.choice, 12, `choice=${tag} collides with an occupied field and must be refused`);
    }
  });

  it('refuses choice and parallel pointing at the same tag', () => {
    // The same collision one step removed: two fields on one tag is still one
    // overwriting the other. The second declaration is dropped and its default kept,
    // so the invariant that matters — the two tags never coincide — holds.
    const t = getToolChoiceTags({ DEVIN_CONNECT_TOOL_CHOICE_TAGS: 'choice=30,parallel=30' });
    assert.equal(t.choice === t.parallel, false, 'the two tags must never coincide');
    assert.equal(t.choice, 30, 'the first, non-colliding declaration still applies');
    assert.equal(t.parallel, 11, 'the colliding one keeps its default');
  });

  it('never lets the two tags coincide, whichever order they are declared', () => {
    for (const raw of ['choice=30,parallel=30', 'parallel=30,choice=30', 'parallel=40,choice=40']) {
      const t = getToolChoiceTags({ DEVIN_CONNECT_TOOL_CHOICE_TAGS: raw });
      assert.notEqual(t.choice, t.parallel, `"${raw}" produced coinciding tags`);
    }
  });
});

describe('wire: a colliding override cannot duplicate an occupied field', () => {
  it('emits exactly one #1 (ClientMetadata) even when choice is pointed at 1', () => {
    const proto = buildGetChatMessageRequest({
      token: 'devin-session-token$a.b.c',
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      env: { ...ON, DEVIN_CONNECT_TOOL_CHOICE_TAGS: 'choice=1' },
      toolChoice: 'required',
      deviceSeed: 'stable',
    });
    const ones = parseFields(proto).filter((f) => f.field === 1);
    assert.equal(ones.length, 1, 'a second #1 would overwrite the auth metadata');
    // And the surviving #1 is the real metadata, not a 10-byte tool_choice.
    assert.ok(ones[0].value.length > 100, 'the surviving #1 must be ClientMetadata');
  });
});

describe('request wire', () => {
  it('emits NEITHER #11 nor #12 when the switch is off', () => {
    // The load-bearing assertion: unconfirmed tags must not reach the wire of an
    // operator who never opted in. Field ABSENCE is checked rather than byte-equality
    // because two identical requests already differ (a pre-existing random field).
    const proto = request({}, { toolChoice: 'required', parallelToolCalls: false });
    assert.equal(hasField(proto, 11), false);
    assert.equal(hasField(proto, 12), false);
  });

  it('emits #12 for a non-default choice when on', () => {
    assert.equal(hasField(request(ON, { toolChoice: 'required' }), 12), true);
    assert.equal(hasField(request(ON, { toolChoice: 'none' }), 12), true);
  });

  it('does NOT emit #12 for auto — the upstream default needs no field', () => {
    assert.equal(hasField(request(ON, { toolChoice: 'auto' }), 12), false);
    assert.equal(hasField(request(ON, {}), 12), false);
  });

  it('emits #11 only when parallel_tool_calls was explicitly false', () => {
    assert.equal(hasField(request(ON, { parallelToolCalls: false }), 11), true);
    // true is the upstream default and protobuf omits a false bool anyway, so
    // emitting anything here would be a no-op field on an unconfirmed tag.
    assert.equal(hasField(request(ON, { parallelToolCalls: true }), 11), false);
    assert.equal(hasField(request(ON, {}), 11), false);
  });

  it('keeps request fields ascending with both new fields present', () => {
    const nums = parseFields(request(ON, { toolChoice: 'required', parallelToolCalls: false }))
      .map((f) => f.field);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), `not ascending: ${nums}`);
    assert.ok(nums.indexOf(11) < nums.indexOf(12), '#11 must precede #12');
    assert.ok(nums.indexOf(12) > nums.indexOf(8), '#12 must follow #8');
  });

  it('adds exactly #11/#12 and displaces no existing field', () => {
    const off = new Set(parseFields(request({}, { toolChoice: 'required', parallelToolCalls: false })).map((f) => f.field));
    const on = new Set(parseFields(request(ON, { toolChoice: 'required', parallelToolCalls: false })).map((f) => f.field));
    for (const f of off) assert.ok(on.has(f), `field ${f} disappeared when the switch was enabled`);
    assert.deepEqual([...on].filter((f) => !off.has(f)).sort((a, b) => a - b), [11, 12]);
  });

  it('honours a tag re-point on the wire', () => {
    const env = { ...ON, DEVIN_CONNECT_TOOL_CHOICE_TAGS: 'choice=30' };
    const proto = request(env, { toolChoice: 'required' });
    assert.equal(hasField(proto, 30), true, 'the re-pointed tag carries the choice');
    assert.equal(hasField(proto, 12), false, 'the default tag is no longer used');
  });
});

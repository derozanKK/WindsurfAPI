// FIX-LS — audit items A1–A6 (local language-server protocol fixes).
// Every assertion inspects the produced wire bytes through src/proto.js.
// A5 (`CortexStepReadUrlContent` #5) is intentionally not covered here: its
// fix is pending a decision because a lab test pins the current behaviour —
// see the FIX-LS report for the analysis and the prepared patch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildRawGetChatMessageRequest,
  buildSendCascadeMessageRequest,
  parseTrajectorySteps,
} from '../src/windsurf.js';
import {
  parseFields, getField, getAllFields,
  writeMessageField, writeStringField, writeVarintField,
} from '../src/proto.js';

const wrapStep = (typeEnum, oneofField, bodyBuf) =>
  Buffer.concat([
    writeVarintField(1, typeEnum),
    writeVarintField(4, 3), // status DONE
    writeMessageField(oneofField, bodyBuf),
  ]);
const wrapResp = (...stepBufs) => Buffer.concat(stepBufs.map(b => writeMessageField(1, b)));

const cascadeConfigFields = (proto) => {
  const cfgField = getField(parseFields(proto), 5, 2);
  assert.ok(cfgField, 'cascade_config (field 5) must be present');
  return parseFields(cfgField.value);
};

describe('A1 — RawGetChatMessageRequest keeps chat_messages (#2) non-empty', () => {
  it('all-system message list still carries one #2 entry', () => {
    const req = buildRawGetChatMessageRequest('key', [{ role: 'system', content: 'x' }], 1, 'model');
    const entries = getAllFields(parseFields(req), 2);
    assert.equal(entries.length, 1, 'repeated #2 must carry at least one ChatMessage');
  });

  it('the placeholder entry is an empty user ChatMessage', () => {
    const req = buildRawGetChatMessageRequest('key', [{ role: 'system', content: 'x' }], 1, 'model');
    const msg = getAllFields(parseFields(req), 2)[0];
    const mf = parseFields(msg.value);
    assert.equal(getField(mf, 2, 0)?.value, 1, 'source must be USER (1)');
    const intent = getField(mf, 5, 2);
    assert.ok(intent, 'user messages carry an intent (#5)');
    const generic = getField(parseFields(intent.value), 1, 2);
    assert.ok(generic, 'intent carries a generic wrapper');
    const intentText = getField(parseFields(generic.value), 1, 2);
    assert.ok(intentText, 'generic carries a text field');
    assert.equal(intentText.value.toString('utf8'), '');
  });

  it('an empty message array also keeps one #2 entry', () => {
    const req = buildRawGetChatMessageRequest('key', [], 1, 'model');
    assert.equal(getAllFields(parseFields(req), 2).length, 1);
  });

  it('does not add a placeholder when a real user turn exists', () => {
    const req = buildRawGetChatMessageRequest('key', [{ role: 'user', content: 'hi' }], 1, 'model');
    assert.equal(getAllFields(parseFields(req), 2).length, 1);
  });
});

describe('A2 — CascadeConfig.memory_config (#5) reaches the wire with enabled=false (#2)', () => {
  it('carries memory_config and its #2 = 0 explicitly', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 0, 'MODEL_TEST', 'sess', {});
    const cfg = cascadeConfigFields(proto);
    const mem = getField(cfg, 5, 2);
    assert.ok(mem, 'memory_config (field 5) must be present');
    assert.equal(mem.value.toString('hex'), '1000', 'explicit varint 0 on #2');
    const mf = parseFields(mem.value);
    assert.equal(getField(mf, 2, 0)?.value, 0, 'enabled (#2) = 0');
  });
});

describe('A3 — code_changes_section rides the conversational planner config (#11)', () => {
  it('with no toolPreamble: planner#11 absent, conversational#11 present', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 0, 'MODEL_TEST', 'sess', {});
    const cfg = cascadeConfigFields(proto);
    const planner = parseFields(getField(cfg, 1, 2).value);
    assert.equal(getField(planner, 11), null, 'planner-level #11 must not carry a section');
    const conv = parseFields(getField(planner, 2, 2).value);
    const section = getField(conv, 11, 2);
    assert.ok(section, 'conversational #11 (code_changes_section) must be present');
    const sf = parseFields(section.value);
    assert.equal(getField(sf, 1, 0)?.value, 1, 'SECTION_OVERRIDE_MODE_OVERRIDE');
  });
});

describe('A4 — BrainConfig no longer writes a nested message on #6', () => {
  it('source contains no nested #6 write for the brain config', () => {
    // The nested write was dropped by the empty-message guard, so it never
    // emitted bytes; the observable defect is the dead write itself.
    const src = readFileSync(new URL('../src/windsurf.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /writeMessageField\(6,\s*writeMessageField\(6/);
  });

  it('emitted brain_config carries no len-delim #6', () => {
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 0, 'MODEL_TEST', 'sess', {});
    const cfg = cascadeConfigFields(proto);
    const brain = getField(cfg, 7, 2);
    assert.ok(brain, 'brain_config (field 7) present');
    const bf = parseFields(brain.value);
    assert.equal(getField(bf, 6, 2), null, 'no len-delim #6 in BrainConfig bytes');
    assert.equal(getField(bf, 1, 0)?.value, 1, 'enabled (#1) stays true');
  });
});

describe('A6 — #19 view_file promotion is guarded against structured payloads', () => {
  it('a message-shaped #4 suppresses the promotion (no fake view_file call)', () => {
    // #19 as a real user_input: a query that happens to look like a path,
    // and #4 carrying the declared active_user_state message — not file text.
    const activeUserState = writeMessageField(2, writeStringField(1, 'file:///repo/main.ts'));
    const wrapper = Buffer.concat([
      writeStringField(1, 'README.md'),
      writeMessageField(4, activeUserState),
    ]);
    const steps = parseTrajectorySteps(wrapResp(wrapStep(14, 19, wrapper)));
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 0, 'structured #4 must not produce a view_file call');
  });

  it('still promotes the observed wrapper shape with plain-text #4', () => {
    const wrapper = Buffer.concat([
      writeStringField(2, 'file:///home/user/projects/workspace-abc123/README.md'),
      writeStringField(4, 'observed content'),
    ]);
    const steps = parseTrajectorySteps(wrapResp(wrapStep(14, 19, wrapper)));
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].result, 'observed content');
  });
});

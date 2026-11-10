import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';
import { geminiToOpenAI } from '../src/handlers/gemini.js';
import { log } from '../src/config.js';
import { getConnectMetrics, resetConnectMetrics } from '../src/devin-connect-metrics.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } };

function build(messages, env = {}, nativeToolCall = true) {
  const originalUUID = crypto.randomUUID;
  let n = 0;
  // Fix entropy before encoding, not by erasing fields from the encoded bytes.
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  syncBuiltinESMExports();
  try {
    return buildGetChatMessageRequest({
      token: 'wire-test',
      model: 'swe-1-7',
      sessionId: 'wire-session',
      sessionModelConfig: { id: 'wire-config', turn: 1 },
      deviceSeed: 'wire-device',
      messages,
      nativeToolCall,
      env,
    });
  } finally {
    crypto.randomUUID = originalUUID;
    syncBuiltinESMExports();
  }
}

const frames = (buf) => getAllFields(parseFields(buf), 3)
  .filter((f) => f.wireType === 2).map((f) => parseFields(f.value));
const strings = (fields, tag) => getAllFields(fields, tag)
  .filter((f) => f.wireType === 2).map((f) => f.value.toString('utf8'));
const roles = (items) => items.map((f) => getField(f, 2, 0).value);
const user = { role: 'user', content: 'continue' };
const call = (id) => ({
  id, type: 'function', function: { name: 'f', arguments: '{}' },
});

test('H1-T1: enabled replay retains a reasoning-only assistant', () => {
  for (const [value, tag] of [['1', 11], ['9', 9]]) {
    for (const key of ['reasoning', 'reasoning_content']) {
      for (const native of [false, true]) {
        const items = frames(build([
          { role: 'assistant', content: null, [key]: ' R ' }, user,
        ], { DEVIN_CONNECT_REPLAY_REASONING: value }, native));
        assert.deepEqual(roles(items), [2, 1]);
        assert.deepEqual(strings(items[0], 3), ['']);
        assert.deepEqual(strings(items[0], tag), ['R']);
        assert.deepEqual(strings(items[0], tag === 11 ? 9 : 11), []);
        assert.equal(getAllFields(items[0], 6).length, 0);
      }
    }
  }
});

test('H1-T2: disabled replay preserves complete request bytes', () => {
  for (const env of [{}, { DEVIN_CONNECT_REPLAY_REASONING: '0' }]) {
    for (const key of ['reasoning', 'reasoning_content']) {
      for (const native of [false, true]) {
        assert.deepEqual(
          build([{ role: 'assistant', content: null, [key]: 'R' }, user], env, native),
          build([user], env, native),
        );
      }
    }
  }
});

test('H1-T3: no encodable reasoning still means no empty assistant frame', () => {
  const emptyTurns = [
    { role: 'assistant', content: '' },
    { role: 'assistant', content: ' \n ', reasoning: ' \t ' },
    { role: 'assistant', content: null, reasoning_content: ' \n ' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'R' }] },
  ];
  for (const value of ['1', '9']) {
    const env = { DEVIN_CONNECT_REPLAY_REASONING: value };
    for (const msg of emptyTurns) {
      assert.deepEqual(build([msg, user], env), build([user], env));
    }
  }
});

test('H1-T4: image-only Gemini history is reachable but default wire stays frozen', () => {
  const converted = geminiToOpenAI({
    contents: [
      { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] },
      { role: 'user', parts: [{ text: 'continue' }] },
    ],
  }, 'swe-1-7');
  assert.deepEqual(converted.messages, [
    { role: 'assistant', content: [image] }, user,
  ]);
  // This is a compatibility boundary, not an assertion that image loss is desirable:
  // the upstream ignores #10 on role=assistant (measured 2026-10-21, issue #272), so
  // admitting the turn would ship bytes it discards. What must NOT happen is losing
  // the image SILENTLY — that is H1-T7 below.
  for (const native of [false, true]) {
    assert.deepEqual(build(converted.messages, {}, native), build([user], {}, native));
  }
});

test('H1-T4b: the image-only assistant drop is named in the log and counted (#272)', () => {
  // Issue #272 is filed as "silently dropped". The drop itself is measured-correct
  // (upstream ignores assistant-role images); the silence is the defect. Pin both
  // halves here so a future edit cannot restore the silence — or admit the turn
  // without a deliberate decision (that is what mutation M5 guards).
  const captured = [];
  const realWarn = log.warn;
  log.warn = (...args) => captured.push(args.join(' '));
  resetConnectMetrics();
  try {
    build([{ role: 'assistant', content: [image] }, user], {});
  } finally {
    log.warn = realWarn;
  }
  assert.equal(captured.length, 1, `expected exactly one drop warning, got ${JSON.stringify(captured)}`);
  assert.match(captured[0], /from an assistant turn \(#272\)/);
  assert.match(captured[0], /dropped 1 inline image/);
  assert.equal(getConnectMetrics().assistant_images_dropped, 1);

  // Image emission disabled → the images were never going to be emitted, so there
  // is nothing to report and the counter must not move.
  captured.length = 0;
  log.warn = (...args) => captured.push(args.join(' '));
  try {
    build([{ role: 'assistant', content: [image] }, user], { DEVIN_CONNECT_IMAGE_TAG: '0' });
  } finally {
    log.warn = realWarn;
  }
  assert.deepEqual(captured, []);
  assert.equal(getConnectMetrics().assistant_images_dropped, 1);

  // A text-carrying assistant turn keeps its image (H1-T5) — it must not be
  // reported as dropped either.
  captured.length = 0;
  log.warn = (...args) => captured.push(args.join(' '));
  try {
    build([{ role: 'assistant', content: [{ type: 'text', text: 'caption' }, image] }, user], {});
  } finally {
    log.warn = realWarn;
  }
  assert.deepEqual(captured, []);
  assert.equal(getConnectMetrics().assistant_images_dropped, 1);

  // Second drop site: the native tool-call branch encodes text and #6 calls only,
  // so an image riding an assistant turn that also carries tool_calls is discarded
  // there instead. Same defect class, same report.
  captured.length = 0;
  log.warn = (...args) => captured.push(args.join(' '));
  try {
    build([
      { role: 'assistant', content: [image], tool_calls: [call('a')] },
      user,
    ], {}, true);
  } finally {
    log.warn = realWarn;
  }
  assert.equal(captured.length, 1, `expected one native-branch drop warning, got ${JSON.stringify(captured)}`);
  assert.match(captured[0], /from an assistant turn \(#272\)/);
  assert.equal(getConnectMetrics().assistant_images_dropped, 2);
});

test('H1-T5: a non-text part must not be flattened by coalescing', () => {
  const items = frames(build([
    { role: 'assistant', content: 'before' },
    { role: 'assistant', content: [image, { type: 'text', text: 'caption' }] },
    user,
  ]));
  assert.deepEqual(roles(items), [2, 2, 1]);
  assert.deepEqual(strings(items[0], 3), ['before']);
  assert.deepEqual(strings(items[1], 3), ['caption']);
  const images = getAllFields(items[1], 10);
  assert.equal(images.length, 1);
  const inner = parseFields(images[0].value);
  assert.deepEqual(strings(inner, 1), [PNG]);
  assert.deepEqual(strings(inner, 2), ['image/png']);
});

test('H1-T6: an empty-text native call remains a call', () => {
  const items = frames(build([
    { role: 'assistant', content: null, tool_calls: [call('a')] }, user,
  ]));
  assert.deepEqual(roles(items), [2, 1]);
  const calls = getAllFields(items[0], 6);
  assert.equal(calls.length, 1);
  assert.deepEqual(strings(parseFields(calls[0].value), 1), ['a']);
});

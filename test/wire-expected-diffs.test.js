// WHY THIS FILE EXISTS. The wire gate may now waive individual byte differences through
// test/wire-expected-diffs.json. A waiver mechanism is exactly the kind of safety layer that
// passes its happy path while quietly becoming a blanket: an entry that stops matching, an
// entry that matches a different comparison, or a verifier that accepts any bytes at all
// would all keep the gate green. So the mechanism is driven here on synthetic request bodies
// where the right answer is known, including the negative cases:
//
//   • a diff with no entry fails (no implicit waivers);
//   • an entry whose declared shape does not match fails (a changed byte cannot ride along);
//   • an entry that matches nothing fails as stale, and one that matches twice as ambiguous;
//   • the checked-in file names exactly the 12 measured #273 comparisons, no more.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyWireDiff,
  coordinateKey,
  loadExpectedDiffs,
  parseFields,
  stripMessageIdentity,
  unusedExpectedDiffs,
  validateExpectedDiffs,
  verifyExpectedDiff,
} from './wire-expected-diffs.js';

// ── synthetic protobuf request bodies ───────────────────────────────────────────
const varint = (value) => {
  let v = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    bytes.push(byte);
  } while (v);
  return Buffer.from(bytes);
};
const key = (tag, wire) => varint(tag * 8 + wire);
const vField = (tag, value) => Buffer.concat([key(tag, 0), varint(value)]);
const sField = (tag, value) => {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([key(tag, 2), varint(body.length), body]);
};
const mField = (tag, body) => Buffer.concat([key(tag, 2), varint(body.length), body]);
const message = (role, uuid, text) => Buffer.concat([sField(1, uuid), vField(2, role), sField(3, text)]);
const request = (messages, model = 'm') => Buffer.concat([
  sField(1, 'metadata'),
  ...messages.map((frame) => mField(3, frame)),
  sField(21, model),
]);

const before = request([message(1, 'uuid-a', 'result-a'), message(2, 'uuid-b', 'call'), message(1, 'uuid-c', 'continue')]);
// The #273 shape: the tool result moves after its call, so the deterministic uuid sequence
// follows the new order. Payloads are identical modulo #1.
const after = request([message(2, 'uuid-a', 'call'), message(1, 'uuid-b', 'result-a'), message(1, 'uuid-c', 'continue')]);

const entry = {
  id: 'synthetic-reorder',
  fixture: 0,
  route: 'normalize',
  native: false,
  env: {},
  reason: '#273 synthetic reorder for the verifier tests',
  expected: {
    kind: 'message-order',
    messageField: 3,
    bytes: before.length,
    beforeRoles: [1, 2, 1],
    afterRoles: [2, 1, 1],
  },
};
const entries = validateExpectedDiffs({ schema: 1, entries: [entry] });
const context = { fixture: 0, route: 'normalize', native: false, env: {} };

test('an allowlisted reorder passes and is reported as expected', () => {
  const verdict = classifyWireDiff(entries, context, before, after);
  assert.equal(verdict.kind, 'expected');
  assert.equal(verdict.entry.id, 'synthetic-reorder');
  assert.equal(verifyExpectedDiff(entry, before, after), null);
});

test('identical buffers need no entry, and an entry for them is stale', () => {
  const verdict = classifyWireDiff(entries, context, before, before);
  assert.equal(verdict.kind, 'identical');
  assert.deepEqual(unusedExpectedDiffs(entries, []), [
    'entry synthetic-reorder matched no differing comparison (stale: the compared release already contains the change, or its coordinates drifted)',
  ]);
});

test('a diff with NO entry is unexpected — the allowlist is not a blanket waiver', () => {
  const verdict = classifyWireDiff([], context, before, after);
  assert.equal(verdict.kind, 'unexpected');
  assert.match(verdict.problem, /no entry in test\/wire-expected-diffs\.json matches/);

  // Same bytes, a different matrix cell: still unexpected.
  for (const other of [
    { ...context, route: 'strip' },
    { ...context, native: true },
    { ...context, env: { DEVIN_CONNECT_REPLAY_REASONING: '0' } },
    { ...context, fixture: 6 },
  ]) {
    assert.equal(classifyWireDiff(entries, other, before, after).kind, 'unexpected',
      `${coordinateKey(other)} must not inherit another cell's entry`);
  }
});

test('an allowlisted cell whose bytes changed outside the message field is invalid', () => {
  const tampered = Buffer.from(after);
  tampered[2] ^= 0xff; // inside the #1 metadata field, after the tag/length bytes
  const verdict = classifyWireDiff(entries, context, before, tampered);
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.problem, /bytes outside top-level field #3 changed/);
});

test('a changed message payload cannot ride an allowlisted reorder', () => {
  const tampered = request([message(2, 'uuid-a', 'call'), message(1, 'uuid-b', 'result-B'), message(1, 'uuid-c', 'continue')]);
  const verdict = classifyWireDiff(entries, context, before, tampered);
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.problem, /message payloads changed beyond the per-message #1 uuid/);
});

test('a changed uuid value cannot ride an allowlisted reorder', () => {
  const tampered = request([message(2, 'uuid-z', 'call'), message(1, 'uuid-b', 'result-a'), message(1, 'uuid-c', 'continue')]);
  const verdict = classifyWireDiff(entries, context, before, tampered);
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.problem, /uuid sequence changed/);
});

test('the declared role order is enforced, not inferred', () => {
  // Same length and same message count, but the second frame is role 2 instead of role 1.
  const wrongRoles = request([message(2, 'uuid-a', 'call'), message(2, 'uuid-b', 'result-a'), message(1, 'uuid-c', 'continue')]);
  const verdict = classifyWireDiff(entries, context, before, wrongRoles);
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.problem, /current roles/);
});

test('the declared byte length is enforced', () => {
  const shorter = request([message(2, 'uuid-a', 'call'), message(1, 'uuid-b', 'result-a')]);
  const verdict = classifyWireDiff(entries, context, before, shorter);
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.problem, /declared|message frame/);
});

test('a message frame without its #1 uuid is not silently accepted', () => {
  const noUuid = Buffer.concat([vField(2, 1), sField(3, 'result-a')]);
  const broken = request([noUuid, message(2, 'uuid-b', 'call'), message(1, 'uuid-c', 'continue')]);
  const verdict = classifyWireDiff(entries, context, before, broken);
  assert.equal(verdict.kind, 'invalid');
  assert.match(verdict.problem, /does not start with the #1 uuid field/);
});

test('unused entries are stale, reused entries are ambiguous, unknown ids are named', () => {
  const second = { ...entry, id: 'second', fixture: 1 };
  const two = validateExpectedDiffs({ schema: 1, entries: [entry, second] });
  assert.deepEqual(unusedExpectedDiffs(two, ['synthetic-reorder']), [
    'entry second matched no differing comparison (stale: the compared release already contains the change, or its coordinates drifted)',
  ]);
  assert.deepEqual(unusedExpectedDiffs(two, ['synthetic-reorder', 'synthetic-reorder', 'second']), [
    'entry synthetic-reorder matched 2 comparisons; each entry must describe exactly one',
  ]);
  assert.deepEqual(unusedExpectedDiffs(two, ['synthetic-reorder', 'second', 'ghost']), ['used id ghost has no entry']);
});

test('the schema rejects entries that could not be checked', () => {
  const bad = (patch) => () => validateExpectedDiffs({
    schema: 1,
    entries: [{ ...entry, expected: { ...entry.expected }, ...patch }],
  });
  const badExpected = (patch) => () => validateExpectedDiffs({
    schema: 1,
    entries: [{ ...entry, expected: { ...entry.expected, ...patch } }],
  });
  const cases = [
    [() => validateExpectedDiffs({ schema: 2, entries: [] }), /schema must be 1/],
    [() => validateExpectedDiffs({ schema: 1, entries: [], extra: true }), /unknown top-level key/],
    [bad({ id: '' }), /non-empty string/],
    [bad({ route: 'explode' }), /route must be one of/],
    [bad({ native: 'false' }), /native must be a boolean/],
    [bad({ env: { X: 1 } }), /env\.X must be a string/],
    [bad({ reason: 'because' }), /reason must start with the issue number/],
    [bad({ unexpected: true }), /unknown key/],
    [badExpected({ kind: 'anything' }), /expected\.kind/],
    [badExpected({ bytes: 0 }), /expected\.bytes/],
    [badExpected({ beforeRoles: [1] }), /at least two/],
    [badExpected({ afterRoles: [1, 2, 1] }), /must actually reorder/],
    [badExpected({ mystery: 1 }), /expected has unknown key/],
  ];
  for (const [run, expected] of cases) assert.throws(run, expected);

  assert.throws(
    () => validateExpectedDiffs({ schema: 1, entries: [entry, { ...entry }] }),
    /duplicate id/,
  );
  assert.throws(
    () => validateExpectedDiffs({ schema: 1, entries: [entry, { ...entry, id: 'same-cell' }] }),
    /duplicate comparison/,
  );
});

test('the checked-in allowlist is empty after v3.141.592655 absorbed the #273 reorder', () => {
  // The 12 measured #273 comparisons were removed once the compared release
  // (v3.141.592655) contained the reorder; a stale entry now fails the wire gate
  // instead of waiving anything. Keep this assertion exact: adding an entry is a
  // deliberate act that must arrive with a fresh measurement and its own issue.
  assert.deepEqual(loadExpectedDiffs(), []);
});

test('the protobuf helpers expose the message frames the verifier relies on', () => {
  const fields = parseFields(before);
  assert.deepEqual(fields.map((field) => field.tag), [1, 3, 3, 3, 21]);
  const frames = fields.filter((field) => field.tag === 3).map((field) => field.value);
  assert.deepEqual(frames.map((frame) => stripMessageIdentity(frame)?.length > 0), [true, true, true]);
  // Every non-message field is compared verbatim, including its length prefix.
  assert.deepEqual(fields.filter((field) => field.tag !== 3).map((field) => field.raw.toString('hex')),
    parseFields(Buffer.concat([sField(1, 'metadata'), sField(21, 'm')]))
      .filter((field) => field.tag !== 3).map((field) => field.raw.toString('hex')));
});

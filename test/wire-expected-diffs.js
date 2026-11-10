// WHY THIS FILE EXISTS. test/wire-byte-identity.test.js requires the current tree to emit
// the same request bytes as the last released tag. That invariant is deliberately absolute:
// the upstream is a stateful validator, so a stray byte is a rejected session. But a release
// occasionally changes the wire ON PURPOSE, and the gate's only previous options were to fail
// the release or to weaken the comparison for everyone.
//
// This module is the narrow third option. test/wire-expected-diffs.json names individual
// comparisons (fixture x prepare route x native/emulated x env) that may differ, together
// with the byte-level shape of that difference. Everything else still has to be identical:
//
//   • every byte outside the repeated message field is compared raw and must be equal;
//   • the message frames must be the same payloads modulo their per-message #1 uuid (the
//     deterministic uuid sequence follows message order, so a reorder reassigns uuids);
//   • the role sequence before/after must be exactly the one the entry declares;
//   • the total length must equal the declared length.
//
// A diff with no entry fails. An entry that matches no diff fails as stale, and an entry that
// matches more than one comparison fails as ambiguous — the allowlist is used exactly, so it
// cannot rot into a blanket waiver. Entries are expected to be deleted once the release being
// compared against contains the change (the gate then reports them as stale).
//
// WHAT THIS DOES NOT PROVE: the comparison is still request-body protobuf only. An expected
// entry does not bless a handler, a response stream, or an HTTP/Connect frame.
import { readFileSync } from 'node:fs';

export const EXPECTED_DIFFS_URL = new URL('./wire-expected-diffs.json', import.meta.url);
export const EXPECTED_DIFFS_SCHEMA = 1;
export const ROUTES = Object.freeze(['raw', 'direct', 'normalize', 'strip', 'emulation']);
const ENTRY_KEYS = new Set(['id', 'fixture', 'route', 'native', 'env', 'reason', 'expected']);
const EXPECTED_KEYS = new Set(['kind', 'messageField', 'bytes', 'beforeRoles', 'afterRoles']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new Error(`wire expected-diffs: ${message}`); };

/** Stable identity of one matrix cell. Env is part of the key: a different env is a different comparison. */
export function coordinateKey({ fixture, route, native, env = {} }) {
  const pairs = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${fixture}|${route}|${native ? 'native' : 'emulated'}|${JSON.stringify(pairs)}`;
}

function validateRoles(value, where) {
  if (!Array.isArray(value) || value.length < 2) fail(`${where} must be an array of at least two role numbers`);
  for (const role of value) {
    if (!Number.isInteger(role) || role < 0) fail(`${where} contains a non-integer role: ${JSON.stringify(role)}`);
  }
}

/** Validate the document before any comparison uses it. Throws with the entry named. */
export function validateExpectedDiffs(doc) {
  if (!isPlainObject(doc)) fail('the document must be a JSON object');
  if (doc.schema !== EXPECTED_DIFFS_SCHEMA) fail(`schema must be ${EXPECTED_DIFFS_SCHEMA}, got ${JSON.stringify(doc.schema)}`);
  for (const key of Object.keys(doc)) {
    if (key !== 'schema' && key !== 'entries' && !key.startsWith('_')) fail(`unknown top-level key ${JSON.stringify(key)}`);
  }
  if (!Array.isArray(doc.entries)) fail('entries must be an array');

  const ids = new Set();
  const coordinates = new Set();
  for (const [index, entry] of doc.entries.entries()) {
    const where = `entries[${index}]`;
    if (!isPlainObject(entry)) fail(`${where} must be an object`);
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) fail(`${where} has unknown key ${JSON.stringify(key)}`);
    if (typeof entry.id !== 'string' || !entry.id.trim()) fail(`${where}.id must be a non-empty string`);
    if (ids.has(entry.id)) fail(`duplicate id ${JSON.stringify(entry.id)}`);
    ids.add(entry.id);
    if (!Number.isInteger(entry.fixture) || entry.fixture < 0) fail(`${entry.id}: fixture must be a non-negative integer`);
    if (!ROUTES.includes(entry.route)) fail(`${entry.id}: route must be one of ${ROUTES.join(', ')}`);
    if (typeof entry.native !== 'boolean') fail(`${entry.id}: native must be a boolean`);
    if (!isPlainObject(entry.env)) fail(`${entry.id}: env must be an object`);
    for (const [name, value] of Object.entries(entry.env)) {
      if (!name) fail(`${entry.id}: env has an empty variable name`);
      if (typeof value !== 'string') fail(`${entry.id}: env.${name} must be a string`);
    }
    if (typeof entry.reason !== 'string' || !/^#\d+\b/.test(entry.reason)) {
      fail(`${entry.id}: reason must start with the issue number that justifies the change (e.g. "#273 …")`);
    }
    const expected = entry.expected;
    if (!isPlainObject(expected)) fail(`${entry.id}: expected must be an object`);
    for (const key of Object.keys(expected)) if (!EXPECTED_KEYS.has(key)) fail(`${entry.id}: expected has unknown key ${JSON.stringify(key)}`);
    if (expected.kind !== 'message-order') fail(`${entry.id}: expected.kind must be "message-order"`);
    if (!Number.isInteger(expected.messageField) || expected.messageField < 1) fail(`${entry.id}: expected.messageField must be a positive integer`);
    if (!Number.isInteger(expected.bytes) || expected.bytes < 1) fail(`${entry.id}: expected.bytes must be a positive integer`);
    validateRoles(expected.beforeRoles, `${entry.id}: expected.beforeRoles`);
    validateRoles(expected.afterRoles, `${entry.id}: expected.afterRoles`);
    if (expected.beforeRoles.length !== expected.afterRoles.length) fail(`${entry.id}: beforeRoles and afterRoles must have the same length`);
    if (JSON.stringify(expected.beforeRoles) === JSON.stringify(expected.afterRoles)) {
      fail(`${entry.id}: beforeRoles and afterRoles are identical — an expected diff must actually reorder something`);
    }
    const key = coordinateKey(entry);
    if (coordinates.has(key)) fail(`${entry.id}: duplicate comparison ${key}`);
    coordinates.add(key);
  }
  return doc.entries;
}

/** Read + validate the checked-in allowlist. Throws rather than silently allowing nothing. */
export function loadExpectedDiffs(url = EXPECTED_DIFFS_URL) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(url, 'utf8'));
  } catch (error) {
    fail(`cannot read ${String(url)}: ${error.message}`);
  }
  return validateExpectedDiffs(doc);
}

/** The single entry for this matrix cell, or null. Exact match — env is not a subset. */
export function findExpectedDiff(entries, context) {
  const key = coordinateKey(context);
  return entries.find((entry) => coordinateKey(entry) === key) ?? null;
}

// ── protobuf walk (request body only; the test compares no framing) ──────────────
function readVarint(buf, at) {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    if (i >= buf.length) throw new Error(`truncated varint at byte ${at}`);
    const byte = buf[i++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 49) throw new Error(`varint longer than 7 bytes at byte ${at}`);
  }
}

/** Top-level fields with their verbatim bytes, so "unchanged" means unchanged. */
export function parseFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const start = i;
    const head = readVarint(buf, i);
    const tag = Math.floor(head.value / 8);
    const wire = head.value % 8;
    i = head.next;
    if (wire === 0) {
      const value = readVarint(buf, i);
      out.push({ tag, wire, start, end: value.next, raw: buf.subarray(start, value.next), value: value.value });
      i = value.next;
    } else if (wire === 2) {
      const length = readVarint(buf, i);
      const from = length.next;
      const end = from + length.value;
      if (end > buf.length) throw new Error(`truncated length-delimited field #${tag} at byte ${start}`);
      out.push({ tag, wire, start, end, raw: buf.subarray(start, end), value: buf.subarray(from, end) });
      i = end;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (i + size > buf.length) throw new Error(`truncated fixed-width field #${tag} at byte ${start}`);
      out.push({ tag, wire, start, end: i + size, raw: buf.subarray(start, i + size), value: buf.subarray(i, i + size) });
      i += size;
    } else {
      throw new Error(`unsupported wire type ${wire} for field #${tag} at byte ${start}`);
    }
  }
  return out;
}

const hex = (buf) => Buffer.from(buf).toString('hex');

/** A ChatMessage frame without its per-message #1 uuid. Null when the frame is not shaped that way. */
export function stripMessageIdentity(frame) {
  const fields = parseFields(frame);
  if (fields.length === 0 || fields[0].tag !== 1 || fields[0].wire !== 2) return null;
  return Buffer.concat(fields.slice(1).map((field) => field.raw));
}

function messageRole(frame) {
  const field = parseFields(frame).find((candidate) => candidate.tag === 2 && candidate.wire === 0);
  return field ? field.value : null;
}

/**
 * Verify that the measured difference is exactly the declared shape. Returns null when it is,
 * or a human-readable problem string. Never decides whether a diff is ALLOWED — that is
 * classifyWireDiff's job, and it only asks this after an entry matched.
 */
export function verifyExpectedDiff(entry, before, after) {
  const expected = entry.expected;
  const problems = [];
  const beforeBuf = Buffer.from(before);
  const afterBuf = Buffer.from(after);
  if (Buffer.compare(beforeBuf, afterBuf) === 0) {
    problems.push('the two buffers are identical; an expected diff must actually differ');
  }
  if (beforeBuf.length !== expected.bytes) problems.push(`base length ${beforeBuf.length} != declared ${expected.bytes}`);
  if (afterBuf.length !== expected.bytes) problems.push(`current length ${afterBuf.length} != declared ${expected.bytes}`);

  let beforeFields;
  let afterFields;
  try {
    beforeFields = parseFields(beforeBuf);
    afterFields = parseFields(afterBuf);
  } catch (error) {
    return `cannot parse the request body: ${error.message}`;
  }

  const outside = (fields) => fields.filter((field) => field.tag !== expected.messageField).map((field) => hex(field.raw));
  const beforeOutside = outside(beforeFields);
  const afterOutside = outside(afterFields);
  if (JSON.stringify(beforeOutside) !== JSON.stringify(afterOutside)) {
    problems.push(`bytes outside top-level field #${expected.messageField} changed`);
  }

  const messagesOf = (fields) => fields.filter((field) => field.tag === expected.messageField);
  const beforeMessages = messagesOf(beforeFields);
  const afterMessages = messagesOf(afterFields);
  if (beforeMessages.length !== expected.beforeRoles.length) {
    problems.push(`base carries ${beforeMessages.length} message frame(s), declared ${expected.beforeRoles.length}`);
  }
  if (afterMessages.length !== expected.afterRoles.length) {
    problems.push(`current carries ${afterMessages.length} message frame(s), declared ${expected.afterRoles.length}`);
  }

  const roles = (frames) => frames.map((frame) => messageRole(frame.value));
  if (JSON.stringify(roles(beforeMessages)) !== JSON.stringify(expected.beforeRoles)) {
    problems.push(`base roles ${JSON.stringify(roles(beforeMessages))} != declared ${JSON.stringify(expected.beforeRoles)}`);
  }
  if (JSON.stringify(roles(afterMessages)) !== JSON.stringify(expected.afterRoles)) {
    problems.push(`current roles ${JSON.stringify(roles(afterMessages))} != declared ${JSON.stringify(expected.afterRoles)}`);
  }

  const payloads = (frames) => {
    const stripped = frames.map((frame) => stripMessageIdentity(frame.value));
    if (stripped.some((value) => value === null)) return null;
    return stripped.map(hex).sort();
  };
  const beforePayloads = payloads(beforeMessages);
  const afterPayloads = payloads(afterMessages);
  if (beforePayloads === null || afterPayloads === null) {
    problems.push('a message frame does not start with the #1 uuid field this verifier knows how to ignore');
  } else if (JSON.stringify(beforePayloads) !== JSON.stringify(afterPayloads)) {
    problems.push('message payloads changed beyond the per-message #1 uuid');
  }

  // A reorder reassigns the deterministic uuid sequence to different messages; it must not
  // change the sequence itself. Pinning it here means a uuid-value change cannot ride the entry.
  const uuidOf = (frame) => {
    const first = parseFields(frame)[0];
    return first && first.tag === 1 && first.wire === 2 ? hex(first.value) : null;
  };
  const beforeUuids = beforeMessages.map((frame) => uuidOf(frame.value));
  const afterUuids = afterMessages.map((frame) => uuidOf(frame.value));
  if (JSON.stringify(beforeUuids) !== JSON.stringify(afterUuids)) {
    problems.push('the per-message #1 uuid sequence changed; only reassignment to reordered frames is allowed');
  }

  return problems.length ? problems.join('; ') : null;
}

/**
 * The wire gate's decision for one comparison:
 *   identical  — no entry needed (an entry here would be reported stale by the caller);
 *   expected   — one entry matched and its declared shape was measured;
 *   unexpected — bytes differ and no entry matches → the gate must fail;
 *   invalid    — an entry matched but the difference is not the declared shape → fail.
 */
export function classifyWireDiff(entries, context, before, after) {
  const beforeBuf = Buffer.from(before);
  const afterBuf = Buffer.from(after);
  if (Buffer.compare(beforeBuf, afterBuf) === 0) return { kind: 'identical', entry: null, problem: null };
  const entry = findExpectedDiff(entries, context);
  if (!entry) {
    const offset = firstDifference(beforeBuf, afterBuf);
    return {
      kind: 'unexpected',
      entry: null,
      problem: `request bytes differ at byte ${offset} (${beforeBuf.length} -> ${afterBuf.length}) and no entry in test/wire-expected-diffs.json matches ${coordinateKey(context)}`,
    };
  }
  const problem = verifyExpectedDiff(entry, beforeBuf, afterBuf);
  return problem
    ? { kind: 'invalid', entry, problem }
    : { kind: 'expected', entry, problem: null };
}

function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
  return limit;
}

/**
 * Exact usage: every entry matched exactly one differing comparison, and no comparison used an
 * id that is not in the file. Returns problems (the gate asserts the list is empty).
 */
export function unusedExpectedDiffs(entries, usedIds) {
  const counts = new Map();
  for (const id of usedIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const problems = [];
  for (const entry of entries) {
    const count = counts.get(entry.id) ?? 0;
    if (count === 0) problems.push(`entry ${entry.id} matched no differing comparison (stale: the compared release already contains the change, or its coordinates drifted)`);
    if (count > 1) problems.push(`entry ${entry.id} matched ${count} comparisons; each entry must describe exactly one`);
  }
  const known = new Set(entries.map((entry) => entry.id));
  for (const id of counts.keys()) if (!known.has(id)) problems.push(`used id ${id} has no entry`);
  return problems;
}

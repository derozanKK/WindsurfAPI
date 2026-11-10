// A20 + P-02 — a real, finite byte budget over every retained field.
//
// A20: approxBytes counted only `content`, `tool_calls` and `tool_call_id`, while
// copyStoredValue retained every own enumerable field (and object key). An entry
// with a 100k-char extra field was accounted at ~68 bytes. The final per-entry
// limit also ignored metadata and other entry fields, and a sole entry was never
// required to fit the total budget.
//
// P-02: trimContentToFit stopped after a fixed 64 halving passes, so 20
// independently shrinkable 60,000-char blocks were stored at 276,744 bytes
// against a 65,536-byte per-entry ceiling.
//
// This file runs with RESPONSE_STORE_MAX_BYTES=256k, where the per-entry ceiling
// is max(64KiB, 256KiB/4) = 65,536 bytes.

process.env.RESPONSE_STORE_MAX_BYTES = '256k';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const store = await import('../src/response-store.js');
const { parseByteSize } = store;

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const A = 'api:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:user:alice';
const MAX_ENTRY_BYTES = Math.max(64 * 1024, Math.floor(256 * 1024 / 4));

const bytes = () => store.getResponseStoreStats().bytes;

function runProbe(source, env) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `probe failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

beforeEach(() => store.resetResponseStore());

describe('A20 — every retained field is metered', () => {
  it('an own field outside content is charged (the omitted-field case)', () => {
    // `extra` is retained by copyStoredValue but the old approxBytes never looked
    // at it: measured 68 bytes for an entry holding 40KB of CJK here (the audit's
    // 100k-char variant reproduced the same omission at 68 bytes).
    assert.equal(store.putResponse('extra', [{
      role: 'user',
      content: 'hi',
      extra: '界'.repeat(20_000), // 40,000 bytes at 2 bytes/char
    }], A), true);
    assert.ok(bytes() >= 40_000,
      `an omitted retained field must be charged, got ${bytes()} bytes`);
  });

  it('a deeply nested retained string is charged, not flattened to a 32-byte stub', () => {
    let nested = '界'.repeat(20_000);
    for (let i = 0; i < 10; i++) nested = { child: nested };
    assert.equal(store.putResponse('deep', [{
      role: 'user',
      content: 'hi',
      payload: nested,
    }], A), true);
    assert.ok(bytes() >= 40_000,
      `a depth-10 string must still be charged, got ${bytes()} bytes`);
  });

  it('object keys are charged because they are retained too', () => {
    const key = '界'.repeat(20_000);
    assert.equal(store.putResponse('keys', [{
      role: 'user',
      content: 'hi',
      [key]: 'v',
    }], A), true);
    assert.ok(bytes() >= 40_000,
      `a 40KB own key must be charged, got ${bytes()} bytes`);
  });

  it('Buffers are charged their actual byte length, not 8 bytes per element', () => {
    assert.equal(store.putResponse('buf', [{
      role: 'user',
      content: 'hi',
      blob: Buffer.alloc(20_000),
    }], A), true);
    assert.ok(bytes() >= 20_000, `a 20KB Buffer must be charged at least 20KB, got ${bytes()}`);
    assert.ok(bytes() < 100_000,
      `a 20KB Buffer must not be inflated by walking each element, got ${bytes()}`);
  });

  it('model, status, incompleteReason and callerKey are part of the entry budget', () => {
    const model = '界'.repeat(20_000); // 40KB
    assert.equal(store.putResponse('fields', [{ role: 'user', content: 'hi' }], A, {
      model,
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
    }), true);
    assert.ok(bytes() >= 40_000,
      `retained entry fields must be charged, got ${bytes()} bytes`);
  });

  it('a huge responseId is charged and rejected when it cannot fit', () => {
    const id = 'r'.repeat(40_000); // 80KB > 65,536 per-entry ceiling
    assert.equal(store.putResponse(id, [{ role: 'user', content: 'hi' }], A), false);
    assert.equal(store.getResponseStoreStats().size, 0);
  });

  it('metadata is included in the FINAL per-entry limit, after message trimming', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'.repeat(512)]),
    );
    // Two 20k-char blocks = 80KB. The old trimmer halved ONE block and stopped at
    // ~60KB, then ~16KB of metadata pushed the stored entry back over the ceiling.
    assert.equal(store.putResponse('meta', [{
      role: 'user',
      content: [
        { type: 'text', text: 'x'.repeat(20_000) },
        { type: 'text', text: 'y'.repeat(20_000) },
      ],
    }], A, { metadata }), true);
    assert.ok(bytes() <= MAX_ENTRY_BYTES,
      `metadata must not push the entry past its ceiling (${bytes()} vs ${MAX_ENTRY_BYTES})`);
  });

  it('an entry whose unshrinkable fields exceed the per-entry limit is rejected', () => {
    assert.equal(store.putResponse('cannot', [{
      role: 'tool',
      tool_call_id: 'c'.repeat(40_000), // 80KB and must never be cut
      content: 'ok',
    }], A), false, 'the whole write must fail, not store an over-cap entry');
    assert.equal(store.getResponseStoreStats().size, 0);
    assert.equal(store.getResponse('cannot', A).ok, false);
  });

  it('a sole entry cannot exceed the total budget', () => {
    // At MAX_BYTES=1 the per-entry ceiling is 1 byte: every real entry must be
    // rejected rather than left readable at 264 accounted bytes.
    const probe = runProbe(`
      const s = await import('./src/response-store.js');
      const put = s.putResponse('solo', [{ role: 'user', content: 'x' }], 'api:a:user:1');
      const st = s.getResponseStoreStats();
      console.log(JSON.stringify({ put, size: st.size, bytes: st.bytes, maxBytes: st.maxBytes }));
    `, { RESPONSE_STORE_MAX_BYTES: '1' });
    assert.equal(probe.maxBytes, 1);
    assert.equal(probe.put, false, 'an entry larger than the total budget must be rejected');
    assert.equal(probe.size, 0);
    assert.equal(probe.bytes, 0);
  });
});

describe('A20 — budgets must be finite and safe', () => {
  it('rejects a 400-digit byte setting instead of accepting Infinity', () => {
    assert.equal(parseByteSize('9'.repeat(400)), null);
    const probe = runProbe(`
      const s = await import('./src/response-store.js');
      console.log(JSON.stringify({ maxBytes: s.getResponseStoreStats().maxBytes }));
    `, { RESPONSE_STORE_MAX_BYTES: '9'.repeat(400) });
    assert.equal(probe.maxBytes, 128 * 1024 * 1024,
      'an unusable setting must fall back to the finite default');
  });

  it('rejects unsafe integers and values above the operational bound', () => {
    assert.equal(parseByteSize('9007199254740993'), null, 'unsafe integer must be rejected');
    assert.equal(parseByteSize(String(1024 ** 4 + 1)), null, 'above the operational bound');
    const probe = runProbe(`
      const s = await import('./src/response-store.js');
      console.log(JSON.stringify({ maxBytes: s.getResponseStoreStats().maxBytes }));
    `, { RESPONSE_STORE_MAX_BYTES: '9007199254740993' });
    assert.equal(probe.maxBytes, 128 * 1024 * 1024);
  });

  it('a 400-digit entry count falls back to the default rather than Infinity', () => {
    const probe = runProbe(`
      const s = await import('./src/response-store.js');
      console.log(JSON.stringify({ size: s.getResponseStoreStats().size }));
    `, { RESPONSE_STORE_MAX: '9'.repeat(400) });
    assert.equal(probe.size, 0);
  });
});

describe('P-02 — trimming converges to the byte bound', () => {
  it('20 independently shrinkable 60,000-char blocks fit the per-entry ceiling', () => {
    const blocks = Array.from({ length: 20 }, () => ({
      type: 'text',
      text: 'x'.repeat(60_000),
    }));
    assert.equal(store.putResponse('p02', [{ role: 'user', content: blocks }], A), true);
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= MAX_ENTRY_BYTES,
      `20 blocks must converge to the ceiling (${st.bytes} vs ${MAX_ENTRY_BYTES})`);
    assert.ok(st.bytes <= st.maxBytes, 'and the sole entry must fit the total budget');

    const got = store.getResponse('p02', A);
    assert.equal(got.ok, true, 'trimmed, not rejected');
    assert.equal(got.messages[0].content.length, 20, 'no block may be dropped');
    assert.deepEqual(got.messages[0].content.map((b) => b.type), Array(20).fill('text'),
      'every block keeps its discriminator');
    assert.match(JSON.stringify(got.messages), /truncated by the response store/,
      'the cut must be visible');
  });

  it('27+ blocks still converge (past the old fixed 64-pass starvation)', () => {
    const blocks = Array.from({ length: 40 }, () => ({
      type: 'text',
      text: 'y'.repeat(60_000),
    }));
    assert.equal(store.putResponse('p02-40', [{ role: 'user', content: blocks }], A), true);
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= MAX_ENTRY_BYTES,
      `40 blocks must converge to the ceiling (${st.bytes} vs ${MAX_ENTRY_BYTES})`);
  });

  it('a long series of large entries keeps the total budget bounded', () => {
    for (let i = 0; i < 30; i++) {
      store.putResponse(`big${i}`, [{
        role: 'user',
        content: Array.from({ length: 10 }, () => ({ type: 'text', text: 'z'.repeat(60_000) })),
      }], `api:t${i}:user:1`);
    }
    const st = store.getResponseStoreStats();
    assert.ok(st.bytes <= st.maxBytes,
      `the global budget must hold after trimming (${st.bytes} vs ${st.maxBytes})`);
  });
});

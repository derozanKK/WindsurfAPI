// Response store: the `metadata` slot.
//
// `metadata` is a top-level Responses parameter whose ONLY purpose is to be echoed
// back to the caller (OpenAI: "set of 16 key-value pairs ... useful for storing
// additional information about the object ... and querying for objects"). The
// store held `{messages, callerKey, model, status, ...}` and nothing else, so a
// response retrieved through `GET /v1/responses/{id}` could not report the tag the
// caller attached to it — the audit trail a client keys on silently lost its key
// (DataAuditTools F4).
//
// Two properties matter and are pinned separately:
//   - it survives the store round-trip, including the copy-on-read boundary that
//     every other stored field goes through;
//   - it is BOUNDED. Metadata is caller-controlled and stored per response, so an
//     unbounded slot would be a memory amplifier that the byte budget never sees.
//     The HTTP boundary rejects contract violations with a 400 (see
//     responses.test.js), which makes these caps defence in depth for any other
//     caller of putResponse.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../src/response-store.js');

const CALLER = 'api:metadatametadatametadatametada:user:tagger';
const MESSAGES = [{ role: 'user', content: 'hello' }];

beforeEach(() => store.resetResponseStore());

describe('metadata round-trips through the store', () => {
  it('returns the metadata put with the response', () => {
    store.putResponse('r1', MESSAGES, CALLER, { model: 'm', metadata: { trace_id: 'abc', tenant: 'acme' } });
    const got = store.getResponse('r1', CALLER);
    assert.equal(got.ok, true);
    assert.deepEqual(got.metadata, { trace_id: 'abc', tenant: 'acme' });
  });

  it('reports null when the response carried none — absence stays absent', () => {
    store.putResponse('r2', MESSAGES, CALLER, { model: 'm' });
    assert.equal(store.getResponse('r2', CALLER).metadata, null);
  });

  it('keeps metadata across an id refresh that supplies only the messages', () => {
    store.putResponse('r3', MESSAGES, CALLER, { metadata: { tag: 'kept' } });
    store.putResponse('r3', [...MESSAGES, { role: 'assistant', content: 'ok' }], CALLER, {});
    assert.deepEqual(store.getResponse('r3', CALLER).metadata, { tag: 'kept' });
  });

  it('does not alias the caller object or the returned copy', () => {
    const metadata = { tag: 'original' };
    store.putResponse('r4', MESSAGES, CALLER, { metadata });
    metadata.tag = 'mutated-after-store';
    const first = store.getResponse('r4', CALLER).metadata;
    assert.equal(first.tag, 'original', 'the store must own its copy');
    first.tag = 'mutated-after-read';
    assert.equal(store.getResponse('r4', CALLER).metadata.tag, 'original',
      'each reader must get its own copy');
  });

  it('never resolves another caller’s metadata', () => {
    store.putResponse('r5', MESSAGES, CALLER, { metadata: { tag: 'private' } });
    const foreign = store.getResponse('r5', 'api:otherotherotherotherotherothe:user:x');
    assert.equal(foreign.ok, false);
    assert.equal(foreign.metadata, undefined);
  });
});

describe('metadata is bounded', () => {
  it('keeps at most 16 key-value pairs', () => {
    const metadata = {};
    for (let i = 0; i < 40; i++) metadata[`k${i}`] = `v${i}`;
    store.putResponse('b1', MESSAGES, CALLER, { metadata });
    const kept = store.getResponse('b1', CALLER).metadata;
    assert.equal(Object.keys(kept).length, 16, 'the OpenAI contract caps a metadata map at 16 pairs');
    assert.equal(kept.k0, 'v0', 'the first pairs are the ones kept');
  });

  it('drops keys longer than 64 characters', () => {
    store.putResponse('b2', MESSAGES, CALLER, {
      metadata: { ['k'.repeat(65)]: 'v', ok: 'v' },
    });
    assert.deepEqual(store.getResponse('b2', CALLER).metadata, { ok: 'v' });
  });

  it('drops values longer than 512 characters', () => {
    store.putResponse('b3', MESSAGES, CALLER, {
      metadata: { long: 'v'.repeat(513), short: 'v' },
    });
    assert.deepEqual(store.getResponse('b3', CALLER).metadata, { short: 'v' });
  });

  it('drops non-string values instead of storing objects the echo cannot represent', () => {
    store.putResponse('b4', MESSAGES, CALLER, {
      metadata: { nested: { a: 1 }, list: ['a'], num: 3, good: 'yes' },
    });
    assert.deepEqual(store.getResponse('b4', CALLER).metadata, { good: 'yes' });
  });

  it('treats a non-object metadata as absent', () => {
    for (const [i, bad] of ['string', 42, ['a'], true].entries()) {
      store.putResponse(`b5-${i}`, MESSAGES, CALLER, { metadata: bad });
      assert.equal(store.getResponse(`b5-${i}`, CALLER).metadata, null, `metadata=${JSON.stringify(bad)}`);
    }
  });

  it('counts metadata bytes against the store budget', () => {
    store.putResponse('c1', MESSAGES, CALLER, {});
    const withoutMetadata = store.getResponseStoreStats().bytes;
    store.resetResponseStore();
    store.putResponse('c1', MESSAGES, CALLER, { metadata: { tag: 'x'.repeat(500) } });
    const withMetadata = store.getResponseStoreStats().bytes;
    assert.ok(withMetadata > withoutMetadata + 500,
      `metadata must be metered: ${withMetadata} vs ${withoutMetadata}`);
  });

  it('bounds the whole slot by bytes, not only by pair count', () => {
    // The worst case the contract allows: 16 pairs, 64-char keys, 512-char values.
    // The byte bound is DERIVED from those caps — 16 * (64 + 512) characters —
    // so the maximum must be stored in full and nothing can exceed it.
    const metadata = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`.padEnd(64, 'x'), 'v'.repeat(512)]));
    store.putResponse('c2', MESSAGES, CALLER, { metadata });
    const kept = store.getResponse('c2', CALLER).metadata;
    assert.equal(Object.keys(kept).length, 16, 'the contract maximum must be stored in full');
    const bytes = Object.entries(kept).reduce((n, [k, v]) => n + k.length * 2 + v.length * 2, 0);
    assert.equal(bytes, 16 * (64 + 512) * 2,
      'the slot is bounded by the contract caps, so it cannot exceed this');
  });
});

// D2-DEPTH: the trace depth cutoff must not persist the subtree it skipped.
//
// redact() returned the raw value once `depth > 6`, so a secret-named key inside a
// container at depth 7+ was written to disk verbatim (evidence:
// .agent/audit-20260922/evidence/probes/d2-trace-redaction-depth/result.json, which
// records raw markers in containers at depth 7 and 9 while 0/5/6 were redacted).
// A skipped subtree has to become a visible truncation marker instead.
//
// The real traceClientRequest runs against a synthetic temporary trace root
// (WINDSURFAPI_TRACE_DIR), so nothing touches the repository's .trace dir.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { traceClientRequest } from '../src/trace.js';

const ROOT = mkdtempSync(join(tmpdir(), 'd2-depth-trace-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const ON = { WINDSURFAPI_TRACE: '1', WINDSURFAPI_TRACE_DIR: ROOT };
const OFF = { WINDSURFAPI_TRACE: '0', WINDSURFAPI_TRACE_DIR: ROOT };
const TRUNCATED = /\[truncated[^\]]*\]/;

function marker(name) {
  return `MARKER-D2-${name}-SYNTHETIC`;
}

// `depth` nested objects whose innermost container holds a recognized secret key.
function chainOfContainers(depth, secretName, secretValue) {
  let node = { [secretName]: secretValue };
  for (let i = depth - 1; i >= 0; i--) node = { [`level${i}`]: node };
  return node;
}

function readLeg(traceId) {
  return readFileSync(join(ROOT, traceId, '01-client-req.json'), 'utf8');
}

describe('D2-DEPTH: trace redaction at the depth cutoff', () => {
  it('persists no raw secret value from containers at depth 7 and 9', () => {
    const deep7 = marker('L7');
    const deep9 = marker('L9');
    const body = {
      ...chainOfContainers(7, 'password', deep7),
      other: chainOfContainers(9, 'api_key', deep9),
    };
    traceClientRequest(body, { traceId: 'd2-depth-7-9' }, ON);
    const written = readLeg('d2-depth-7-9');

    assert.equal(written.includes(deep7), false, `depth-7 password was persisted verbatim: ${written.slice(0, 400)}`);
    assert.equal(written.includes(deep9), false, `depth-9 api_key was persisted verbatim: ${written.slice(0, 400)}`);
    assert.match(written, TRUNCATED, 'the skipped subtree must be visible as a truncation marker');
  });

  it('keeps [redacted:Nb] for containers at depth 0 and 6 (control)', () => {
    const shallow = marker('L0');
    const atSix = marker('L6');
    const body = {
      password: shallow,
      ...chainOfContainers(6, 'token', atSix),
    };
    traceClientRequest(body, { traceId: 'd2-depth-shallow' }, ON);
    const written = readLeg('d2-depth-shallow');

    assert.match(written, new RegExp(`\\[redacted:${shallow.length}b\\]`), 'depth-0 secret lost its byte-length redaction');
    assert.match(written, new RegExp(`\\[redacted:${atSix.length}b\\]`), 'depth-6 secret lost its byte-length redaction');
    assert.equal(written.includes(shallow), false);
    assert.equal(written.includes(atSix), false);
  });

  it('persists no raw secret from an array-wrapped container beyond the cutoff', () => {
    const deepArray = marker('ARR');
    // Six object wrappers put the ARRAY itself at depth 7, so the array is the
    // container being skipped rather than the object inside it.
    let node = [{ password: deepArray }];
    for (let i = 5; i >= 0; i--) node = { [`wrap${i}`]: node };
    const body = { ...node, model: 'swe-1.5' };
    traceClientRequest(body, { traceId: 'd2-depth-array' }, ON);
    const written = readLeg('d2-depth-array');

    assert.equal(written.includes(deepArray), false, `array-wrapped password was persisted verbatim: ${written.slice(0, 400)}`);
    assert.match(written, TRUNCATED, 'the skipped array must be visible as a truncation marker');
  });

  it('leaves ordinary shallow content unchanged and does not mutate the request', () => {
    const body = {
      model: 'swe-1.5',
      messages: [{ role: 'user', content: 'hello', meta: { retries: 0, tags: ['a', 'b'] } }],
      tools: [{ type: 'function', function: { name: 'read_file' } }],
    };
    const before = JSON.stringify(body);
    traceClientRequest(body, { traceId: 'd2-depth-shallow-content' }, ON);
    const written = readLeg('d2-depth-shallow-content');

    assert.equal(JSON.stringify(body), before, 'redaction must not mutate the caller\'s request object');
    assert.match(written, /"retries": 0/);
    assert.match(written, /"name": "read_file"/);
    assert.equal(written.includes('[truncated'), false, 'shallow content must not be truncated');
  });

  it('writes nothing at all while tracing is off (control)', () => {
    const id = traceClientRequest({ password: marker('OFF') }, { traceId: 'd2-depth-off' }, OFF);
    assert.equal(id, 'd2-depth-off');
    assert.equal(existsSync(join(ROOT, 'd2-depth-off')), false, 'trace-off must not create a trace directory');
    assert.equal(readdirSync(ROOT).includes('d2-depth-off'), false);
  });

  it('handles a self-referential container without throwing or persisting raw values', () => {
    const cyclic = { password: marker('CYC') };
    cyclic.self = cyclic;
    traceClientRequest(cyclic, { traceId: 'd2-depth-cyclic' }, ON);
    const file = join(ROOT, 'd2-depth-cyclic', '01-client-req.json');
    // The cycle lives at depth 1, so the cutoff terminates it: the leg must be written
    // (bounded, no throw) and must not contain the raw secret.
    assert.equal(existsSync(file), true, 'a cyclic body must not abort the trace write');
    const written = readFileSync(file, 'utf8');
    assert.equal(written.includes(marker('CYC')), false);
    assert.match(written, TRUNCATED);
  });
});

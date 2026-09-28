// Load the REAL src/image.js body with exactly ONE import boundary redirected: the
// vendored JPEG decoder is swapped for test/helpers/jpeg-decode-stub.mjs, which counts
// the call and throws before allocating, so "was the decoder reached?" is observable
// without ever performing a large decode.
//
// This is the source-transformation seam test/helpers/s2-b-grpc-harness.mjs already
// uses for src/grpc.js: every import line is rewritten to the absolute URL of the SAME
// target (a data: URL module cannot resolve relative specifiers), the module body is
// byte-identical, and both facts are asserted here rather than assumed — exactly one
// import target may differ from the original, and the non-import body must match.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const SUBJECT = new URL('src/image.js', ROOT);
const STUB = new URL('test/helpers/jpeg-decode-stub.mjs', ROOT).href;

const IMPORT_LINE = /^import[^\n]*\n/gm;
const IMPORT_FROM = /^import[^\n]*?from '([^']+)';\n/gm;

export async function loadImageWithCodecStub() {
  const source = readFileSync(SUBJECT, 'utf8');
  const importLines = source.match(IMPORT_LINE) || [];
  const relative = [...source.matchAll(IMPORT_FROM)].filter((m) => !m[1].startsWith('node:'));

  assert.equal(importLines.length, 10, 'src/image.js import shape changed; re-check the seam');
  assert.equal(relative.length, 6, 'src/image.js relative import shape changed; re-check the seam');

  const redirected = [];
  let transformed = source;
  for (const match of relative) {
    const specifier = match[1];
    const resolved = new URL(specifier, SUBJECT).href;
    const target = resolved.endsWith('/vendor/jpeg-js/decoder.js') ? STUB : resolved;
    if (target !== resolved) redirected.push({ specifier, from: resolved, to: target });
    transformed = transformed.replace(match[0], match[0].replace(`'${specifier}'`, `'${target}'`));
  }

  assert.equal(redirected.length, 1, 'exactly one import boundary may be redirected');
  assert.equal(redirected[0].to, STUB);
  assert.equal(
    transformed.replace(IMPORT_LINE, ''),
    source.replace(IMPORT_LINE, ''),
    'only import lines may differ: the production module body must be untouched',
  );

  const url = `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`;
  return { module: await import(url), redirected: redirected[0] };
}

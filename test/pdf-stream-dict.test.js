// A7-PDF: the dictionary that belongs to a stream decides whether the stream is
// inflated, however far its entries sit from the `stream` keyword.
//
// The old scan looked 500 bytes back and matched the bare substring
// "FlateDecode", which fails in both directions: a legitimate /Filter entry
// further back was missed (text silently lost), and a prior object's dictionary
// — or a string/comment inside this one — could classify a PLAIN stream as
// Flate, in which case the failed inflate dropped the stream's text too.
//
// Fixtures are the same LF-only, sub-2 KiB shape as
// .agent/audit-20260922/evidence/probes/a7-pdf-filter-lookback (flate-pad-700 is
// the first required red: the filter ends 716 bytes before `stream`).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractPdfText } from '../src/pdf.js';

const TEXT_A = 'FIXTURE-TEXT-A7';
const TEXT_B = 'FIXTURE-TEXT-B7';

const content = (text) => `BT /F1 12 Tf (${text}) Tj ET`;
const flate = (text) => deflateSync(Buffer.from(content(text), 'latin1'));

// One `N 0 obj` carrying `dictBody` and `streamData` between the LF-only
// `stream` / `endstream` delimiters the extractor understands.
function objectBlock(n, dictBody, streamData) {
  return Buffer.concat([
    Buffer.from(`${n} 0 obj\n<< ${dictBody} >>\nstream\n`, 'latin1'),
    streamData,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
}

function pdf(...blocks) {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    ...blocks,
    Buffer.from('trailer\n<<>>\n%%EOF\n', 'latin1'),
  ]);
}

const pad = (n, ch = 'x') => ch.repeat(n);

describe('A7-PDF: stream dictionary association', () => {
  it('inflates a /Filter /FlateDecode whose entry ends 716 bytes before `stream`', () => {
    const data = flate(TEXT_A);
    const buf = pdf(objectBlock(1, `/Length ${data.length} /Filter /FlateDecode /Padding (${pad(700)})`, data));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('inflates with a nested padding dictionary after the filter (a "last <<" scan is not enough)', () => {
    const data = flate(TEXT_A);
    const buf = pdf(objectBlock(
      1,
      `/Length ${data.length} /Filter /FlateDecode /Padding << /Nested (${pad(700)}) >>`,
      data,
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('keeps inflating an adjacent /Filter /FlateDecode (control)', () => {
    const data = flate(TEXT_A);
    assert.equal(extractPdfText(pdf(objectBlock(1, `/Length ${data.length} /Filter /FlateDecode`, data))), TEXT_A);
  });

  it('keeps inflating with a 400-byte padding entry after the filter (control)', () => {
    const data = flate(TEXT_A);
    const buf = pdf(objectBlock(1, `/Length ${data.length} /Filter /FlateDecode /Padding (${pad(400)})`, data));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('reads a plain stream whose only filter-like token is inside a literal string', () => {
    const buf = pdf(objectBlock(
      1,
      `/Length ${content(TEXT_A).length} /Note (FlateDecode) /Padding (${pad(700)})`,
      Buffer.from(content(TEXT_A), 'latin1'),
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('reads a plain stream whose only filter-like token is inside a comment', () => {
    const buf = pdf(objectBlock(
      1,
      `/Length ${content(TEXT_A).length}\n% /Filter /FlateDecode\n/Padding (${pad(700)})`,
      Buffer.from(content(TEXT_A), 'latin1'),
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('reads a plain stream whose dictionary text contains FlateDecode in a string (in-window)', () => {
    // Within the old 500-byte window, so a substring test classified this PLAIN
    // stream as Flate, the inflate failed, and the stream's text was dropped. The
    // string holds a complete "/Filter /FlateDecode" pair, so a lookup that fails to
    // skip literal strings sees a filter the stream does not have.
    const buf = pdf(objectBlock(
      1,
      `/Length ${content(TEXT_A).length} /Note (/Filter /FlateDecode)`,
      Buffer.from(content(TEXT_A), 'latin1'),
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('reads a plain stream whose dictionary text contains FlateDecode in a comment (in-window)', () => {
    const buf = pdf(objectBlock(
      1,
      `/Length ${content(TEXT_A).length}\n% /Filter /FlateDecode\n/Padding (${pad(300)})`,
      Buffer.from(content(TEXT_A), 'latin1'),
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('inflates a Flate stream whose dictionary string holds a balanced nested group and a >> (regression)', () => {
    // The /Note string contains a BALANCED nested group and a literal '>>'. A scanner
    // that closes a literal string at the first ')' mistakes that '>>' for the
    // dictionary end, loses the association, and silently drops the compressed text.
    const data = flate(TEXT_A);
    const buf = pdf(objectBlock(
      1,
      `/Length ${data.length} /Note (outer (nested) >> still-string) /Filter /FlateDecode`,
      data,
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('reads a dictionary string holding an escaped paren, a nested group and a >> (control)', () => {
    // `\)` is escaped and `(c)` is balanced, so the whole string — including the
    // literal '>>' inside it — ends only at the final ')'; the filter entry after it
    // still belongs to this stream. A scanner that ignores escapes or nesting sees a
    // dictionary end inside the string and drops the compressed text.
    const data = flate(TEXT_A);
    const buf = pdf(objectBlock(
      1,
      `/Length ${data.length} /Note (a \\) >> b (c)) /Filter /FlateDecode`,
      data,
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('degrades without throwing on an unterminated dictionary string (control)', () => {
    const body = Buffer.from(content(TEXT_A), 'latin1');
    const buf = pdf(objectBlock(1, `/Length ${body.length} /Note (unterminated`, body));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('reads a plain stream with a 700-byte padding entry and no filter (control)', () => {
    const buf = pdf(objectBlock(
      1,
      `/Length ${content(TEXT_A).length} /Padding (${pad(700)})`,
      Buffer.from(content(TEXT_A), 'latin1'),
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('reads a plain stream whose dictionary holds an unrelated hex string (control)', () => {
    const buf = pdf(objectBlock(
      1,
      `/Length ${content(TEXT_A).length} /X <48656c6c6f> /Padding (${pad(700)})`,
      Buffer.from(content(TEXT_A), 'latin1'),
    ));
    assert.equal(extractPdfText(buf), TEXT_A);
  });

  it('does not apply a previous object\'s filter to the next object', () => {
    // Object 1 is Flate. Object 2 is plain AND its dictionary sits 700 bytes away
    // from its own stream, so a scan that hunts for "/FlateDecode" anywhere to the
    // left would inflate plain bytes and lose object 2's text.
    const first = flate(TEXT_A);
    const second = Buffer.from(content(TEXT_B), 'latin1');
    const buf = pdf(
      objectBlock(1, `/Length ${first.length} /Filter /FlateDecode`, first),
      objectBlock(2, `/Length ${second.length} /Padding (${pad(700)})`, second),
    );
    assert.equal(extractPdfText(buf), `${TEXT_A}\n\n${TEXT_B}`);
  });

  it('applies each object\'s own filter in a mixed two-object document', () => {
    const first = Buffer.from(content(TEXT_A), 'latin1');
    const second = flate(TEXT_B);
    const buf = pdf(
      objectBlock(1, `/Length ${first.length} /Padding (${pad(700)})`, first),
      objectBlock(2, `/Length ${second.length} /Filter /FlateDecode`, second),
    );
    assert.equal(extractPdfText(buf), `${TEXT_A}\n\n${TEXT_B}`);
  });

  it('finds the filter of a distant dictionary in a 200-stream document', () => {
    // The association must not depend on how many objects precede it.
    const blocks = [];
    for (let i = 1; i <= 199; i++) {
      const data = Buffer.from(content(`${TEXT_A}-${i}`), 'latin1');
      blocks.push(objectBlock(i, `/Length ${data.length} /Padding (${pad(300)})`, data));
    }
    const last = flate(TEXT_B);
    blocks.push(objectBlock(200, `/Length ${last.length} /Filter /FlateDecode /Padding (${pad(700)})`, last));
    const text = extractPdfText(pdf(...blocks));
    assert.ok(text.endsWith(TEXT_B), `distant filter in the 200th object was not applied: ${JSON.stringify(text.slice(-80))}`);
  });
});

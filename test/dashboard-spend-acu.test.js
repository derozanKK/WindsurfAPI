// #239: the dashboard decoded `acuCost` but never rendered it — the consumer
// existed, the wiring did not. Same defect shape the connect spend path had
// before values reached `credits > 0`: a conditional cell that can only ever
// stay hidden is invisible to source-grep guards, because every string they
// match is present and correct. The discriminator is execution: render the
// shipped template with a spend record that carries the value, and with one
// that does not.
//
// So this file extracts renderSpendCells(sp) from src/dashboard/index.html and
// RUNS it — the same technique dashboard-escape-behaviour.test.js uses for
// esc()/escJsAttr(). The stub I18n returns `i18n:<key>`, so assertions can name
// which key drove which cell.
//
// Why the cell MUST stay conditional — do not "fix" it into an unconditional
// row: `committed_acu_cost` is an uncalibrated billing coordinate. The decoder
// emits it only when DEVIN_CONNECT_BILLING_TAGS names its tag — default off
// (#239 thread; docs/releases/RELEASE_NOTES_3.9.24.md; docs/AUDIT-LEDGER.md:
// "tag 来自第三方 .proto 声明顺序,不是测量。默认关"). On an unconfigured
// deployment the field is absent from `totalSpend`, so a rendered 0 would read
// as a settled number where the truth is "not decoded" — the outcome #239's
// acceptance criteria rule out. Show it when present; never fake it.
//
// Red conditions: delete the ACU cell, invert `acu > 0`, unwire the
// renderAccountDetail call, or flatten a sub-cent magnitude to `0` — each
// turns an assertion below red.

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

// Pull the method body out of the App object literal and turn it into a
// callable whose only inputs are the spend record and the i18n lookup.
// Extracting the shipped source (not reimplementing it) is the point: a mirror
// implementation would keep passing while production regressed.
function extractSpendCells() {
  const at = HTML.indexOf('\n  renderSpendCells(sp)');
  assert.notEqual(at, -1,
    'renderSpendCells(sp) must exist as a one-arg method in the dashboard App object — '
    + 'without it the account detail has no way to render the decoded ACU cost (#239)');
  const open = HTML.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, 'could not delimit the body of renderSpendCells');
  const body = HTML.slice(open, end);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  return new Function('sp', 'I18n', `return (function renderSpendCells(sp) ${body}).call(null, sp);`);
}

const I18n = { t: (k) => `i18n:${k}` };

// The text content of the ACU cell's value span, or null when the cell is absent.
function acuCellValue(html) {
  const m = html.match(/<span class="k">i18n:account\.detail\.runtime\.spendAcu<\/span><span class="v"[^>]*>([^<]*)<\/span>/);
  return m ? m[1] : null;
}

// Parse a rendered number back into a Number, tolerating comma decimal-separators.
function asNumber(text) {
  return Number(String(text).replace(/\s/g, '').replace(',', '.'));
}

let renderSpendCells;
before(() => { renderSpendCells = extractSpendCells(); });

describe('account detail renders the decoded ACU cost (#239)', () => {
  it('renders a labelled ACU cell when the decoder produced a value, beside credit rather than merged', () => {
    const html = renderSpendCells({ requests: 3, totalTokens: 120, creditCost: 2.5, acuCost: 1.25 }, I18n);
    assert.match(html,
      /<span class="k">i18n:account\.detail\.runtime\.spendAcu<\/span><span class="v"[^>]*>1[.,]25<\/span>/,
      'a present acuCost must render its own labelled cell with its value');
    assert.match(html,
      /<span class="k">i18n:account\.detail\.runtime\.spendCredits<\/span><span class="v"[^>]*>2[.,]5<\/span>/,
      'the credit cell must keep rendering alongside it');
    assert.doesNotMatch(html, /3[.,]75/,
      'ACU and credit are different units — the two cells must never be added together (#239)');
  });

  it('renders the canonical sub-cent ACU value (#22 wire fixture) as a non-zero magnitude', () => {
    // 0.0006735000060871243 is the decoded committed_acu_cost the repo's own
    // opt-in fixture pins (test/acu-opt-in-decode.test.js:16). A 2-decimal
    // formatter flattens it to the literal "0" — a settled-looking zero on
    // exactly the opt-in deployment this cell exists for (#239).
    const CANONICAL_ACU = 0.0006735000060871243;
    const html = renderSpendCells({ requests: 1, totalTokens: 10, acuCost: CANONICAL_ACU }, I18n);
    const text = acuCellValue(html);
    assert.notEqual(text, null, 'the sub-cent ACU must still render its cell');
    assert.notEqual(text, '0', 'sub-cent ACU rendered as a literal "0" — the magnitude was flattened away');
    const n = asNumber(text);
    assert.ok(n > 0.0006 && n < 0.0007, `expected the magnitude ~6.7e-4, got "${text}"`);
  });

  it('does not flatten other sub-cent magnitudes either', () => {
    const html = renderSpendCells({ acuCost: 0.004 }, I18n);
    const text = acuCellValue(html);
    assert.notEqual(text, null, 'a sub-cent ACU still renders its cell');
    const n = asNumber(text);
    assert.ok(n > 0.003 && n < 0.005, `expected the magnitude ~0.004, got "${text}"`);
  });

  it('omits the ACU cell when nothing was decoded (default-off deployment)', () => {
    const html = renderSpendCells({ requests: 3, totalTokens: 120, creditCost: 2.5 }, I18n);
    assert.doesNotMatch(html, /spendAcu/,
      'no decoded value must mean no cell — rendering 0 would present an uncalibrated coordinate '
      + 'as settled, and the decoder is default-off (#239)');
    assert.match(html, /i18n:account\.detail\.runtime\.spendCredits/, 'sibling cells are unaffected');
  });

  it('treats an explicit decoded zero the same as absent', () => {
    const html = renderSpendCells({ requests: 1, totalTokens: 10, acuCost: 0 }, I18n);
    assert.doesNotMatch(html, /spendAcu/, 'a decoded 0 is not a number worth showing');
  });

  it('coerces a non-numeric value to absent instead of rendering it', () => {
    const html = renderSpendCells({ acuCost: '<img src=x onerror=alert(1)>' }, I18n);
    assert.doesNotMatch(html, /<img/, 'a hostile string must never reach the markup');
    assert.doesNotMatch(html, /spendAcu/, 'Number() maps it to NaN → cell absent');
  });

  it('renders the zeroed base rows when totalSpend is absent (pre-K8 accounts)', () => {
    const html = renderSpendCells(undefined, I18n);
    assert.match(html, /i18n:account\.detail\.runtime\.spendRequests/);
    assert.match(html, /i18n:account\.detail\.runtime\.spendTokens/);
    assert.doesNotMatch(html, /spendAcu/);
  });
});

describe('the ACU cell is wired, not merely defined', () => {
  // #239's actual defect was a missing wire while every piece existed: the
  // decoder decoded, the accumulator accumulated, the template could render —
  // and nothing carried the value across the last hop. A method that exists but
  // is never called reproduces exactly that shape while every behavioural test
  // above stays green, so pin the call site too.
  it('renderAccountDetail delegates to renderSpendCells(a.totalSpend)', () => {
    assert.match(HTML, /this\.renderSpendCells\(a\.totalSpend\)/,
      'the account detail must actually call renderSpendCells — an uncalled method renders nothing');
  });
});

// The FREE badge must carry the promo end date, in both languages.
//
// The chip used to say just "FREE"/"免费" and hide the end date in a tooltip.
// "Free" with no horizon is how a promotion quietly turns into a surprise bill:
// the badge is what an operator scans, so the date belongs in the badge. These
// execute the SHIPPED filterModels method (brace-sliced out of index.html), with
// the real translation files — a mirror implementation would not prove the
// shipped copy says it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const LOCALES = {
  en: JSON.parse(readFileSync(new URL('../src/dashboard/i18n/en.json', import.meta.url), 'utf8')),
  zh: JSON.parse(readFileSync(new URL('../src/dashboard/i18n/zh-CN.json', import.meta.url), 'utf8')),
};

/** Slice one App method out of the shipped template. */
function methodParts(name) {
  const at = HTML.indexOf(`\n  ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  const parenOpen = HTML.indexOf('(', at);
  let depthParen = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < HTML.length; i++) {
    if (HTML[i] === '(') depthParen++;
    else if (HTML[i] === ')' && --depthParen === 0) { parenClose = i; break; }
  }
  assert.notEqual(parenClose, -1, `could not delimit the parameters of ${name}`);
  const params = HTML.slice(parenOpen, parenClose + 1);
  const open = HTML.indexOf('{', parenClose);
  let depth = 0;
  let end = -1;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `could not delimit the body of ${name}`);
  return { params, body: HTML.slice(open, end) };
}

function lookup(locale, key) {
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), locale);
}

function translator(locale) {
  return (key, vars) => {
    const raw = lookup(locale, key);
    assert.equal(typeof raw, 'string', `missing i18n key ${key}`);
    return vars ? raw.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? '')) : raw;
  };
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Run the shipped filterModels against one model row and return the chip HTML. */
function renderChips(localeName, models) {
  const { params, body } = methodParts('filterModels');
  const container = { innerHTML: '' };
  const document = {
    getElementById: (id) => (id === 'model-chips-container' ? container : { value: '' }),
  };
  const self = {
    esc,
    escJsAttr: (value) => String(value ?? '').replace(/"/g, '&quot;'),
    allModels: models,
    modelAccessConfig: { list: [] },
  };
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const fn = new Function('I18n', 'document', 'self',
    `return (function filterModels${params} ${body}).apply(self, []);`);
  fn({ t: translator(LOCALES[localeName]) }, document, self);
  return container.innerHTML;
}

const FREE_PROMO = [{
  id: 'swe-2-medium',
  name: 'swe-2-medium',
  provider: 'windsurf',
  reachable: true,
  freeNow: true,
  freeReason: 'cost_tier_free',
  promoEndsAt: '2026-11-01T06:59:59.999Z',
  quotaState: 'free',
  connectSelector: 'swe-2-medium',
  pricingStale: false,
}];

describe('FREE badge carries the promo end date', () => {
  it('renders 免费（促销至 …） in zh-CN', () => {
    const html = renderChips('zh', FREE_PROMO);
    assert.ok(html.includes('免费（促销至 2026-11-01）'), html);
  });

  it('renders FREE (promo until …) in en', () => {
    const html = renderChips('en', FREE_PROMO);
    assert.ok(html.includes('FREE (promo until 2026-11-01)'), html);
  });

  it('keeps the plain FREE badge when the upstream sent no promo end', () => {
    const noPromo = [{ ...FREE_PROMO[0], promoEndsAt: null }];
    assert.ok(renderChips('zh', noPromo).includes('>免费<'));
    assert.ok(renderChips('en', noPromo).includes('>FREE<'));
  });

  it('still renders QUOTA for a billable row', () => {
    const paid = [{ ...FREE_PROMO[0], freeNow: false, freeReason: null, promoEndsAt: null, quotaState: 'unknown' }];
    assert.ok(renderChips('zh', paid).includes('>计费<'));
    assert.ok(renderChips('en', paid).includes('>QUOTA<'));
  });

  it('renders no price badge when freeNow is unknown (no live data)', () => {
    const unknown = [{ ...FREE_PROMO[0], freeNow: null, freeReason: null, promoEndsAt: null, quotaState: null }];
    const html = renderChips('zh', unknown);
    // No badge span at all: the chip's tooltip (costUnknownHint) legitimately
    // mentions 免费 in prose, so the assertion is about the badge, not the word.
    assert.ok(!html.includes('chip-badge'), html);
  });

  it('surfaces staleness in the tooltip when the sync stopped', () => {
    const stale = [{ ...FREE_PROMO[0], pricingStale: true }];
    const html = renderChips('zh', stale);
    assert.ok(html.includes('定价数据已过期'), html);
  });
});

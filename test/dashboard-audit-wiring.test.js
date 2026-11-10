// Dashboard audit sweep (2026-10-23) — wiring regressions found on the
// deployed 3.9.60 dashboard. These are source pins, in the same style as
// dashboard-syntax.test.js: the UI is one inline script, so the contract is
// the literal wiring, not an exported helper.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const html = read('src/dashboard/index.html');
const en = JSON.parse(read('src/dashboard/i18n/en.json'));
const zh = JSON.parse(read('src/dashboard/i18n/zh-CN.json'));

const flat = (obj, prefix = '', out = {}) => {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flat(value, path, out);
    else out[path] = value;
  }
  return out;
};
const enKeys = flat(en);
const zhKeys = flat(zh);

describe('dashboard audit wiring', () => {
  it('credits subtitle uses the pageSubtitle key that exists in both locales', () => {
    assert.match(html, /data-i18n="pageSubtitle\.credits"/);
    assert.doesNotMatch(html, /data-i18n="page\.credits\.sub"/);
    assert.equal(typeof enKeys['pageSubtitle.credits'], 'string');
    assert.equal(typeof zhKeys['pageSubtitle.credits'], 'string');
  });

  it('credits CTA title uses credits.cta.title, not the object node', () => {
    assert.match(html, /data-i18n="credits\.cta\.title"/);
    assert.doesNotMatch(html, /data-i18n="credits\.cta"/);
    assert.equal(typeof enKeys['credits.cta.title'], 'string');
    assert.equal(typeof zhKeys['credits.cta.title'], 'string');
  });

  it('credits PR links are guarded for non-PR entries (author row has pr: 0)', () => {
    assert.match(html, /const prLink = \(pr\) => \(Number\(pr\) > 0/);
    assert.match(html, /\$\{prLink\(p\.pr\)\}/);
    assert.match(html, /\$\{prLink\(latest\.pr\)\}/);
    assert.doesNotMatch(html, /WindsurfAPI\/pull\/\$\{p\.pr\}/);
    assert.doesNotMatch(html, /WindsurfAPI\/pull\/\$\{latest\.pr\}/);
    assert.equal(typeof enKeys['credits.author'], 'string');
    assert.equal(typeof zhKeys['credits.author'], 'string');
  });

  it('public-bind local scan shows an explanation instead of a blank tab', () => {
    assert.match(html, /accounts\.add\.localUnavailable/);
    assert.match(html, /hint\.classList\.remove\('hidden'\)/);
    assert.equal(typeof enKeys['accounts.add.localUnavailable'], 'string');
    assert.equal(typeof zhKeys['accounts.add.localUnavailable'], 'string');
  });

  it('browser back/forward hash changes navigate the visible panel', () => {
    assert.match(html, /addEventListener\('hashchange'/);
    assert.match(html, /const target = document\.getElementById\('p-' \+ panel\)/);
    assert.match(html, /if \(target && active === target\) return;/);
    assert.match(html, /App\.navigate\(panel\)/);
  });
});

// Dashboard P1 fixes — colour pairs, destructive confirm safety, response-gated
// mutations, truthful settings writes, overview lifecycle, and mobile layout.
//
// The colour/typography assertions read the shipped HTML; the behaviour tests
// execute the shipped App methods (brace-sliced) with small DOM/API stubs, the
// same convention dashboard-ui-p2.test.js uses.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readStyleBlock, customProperties, resolveVar, parseColor, contrastRatio,
} from '../scripts/dashboard-css.mjs';
import {
  undefinedCustomProperties, TEXT_FLOOR,
} from '../scripts/check-dashboard-contrast.mjs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const CSS = readStyleBlock(HTML);
const ZH = JSON.parse(readFileSync(new URL('../src/dashboard/i18n/zh-CN.json', import.meta.url), 'utf8'));
const EN = JSON.parse(readFileSync(new URL('../src/dashboard/i18n/en.json', import.meta.url), 'utf8'));

function methodParts(name) {
  let at = HTML.indexOf(`\n  ${name}(`);
  if (at === -1) at = HTML.indexOf(`\n  async ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  const nameAt = HTML.indexOf(name, at);
  const parenOpen = HTML.indexOf('(', nameAt);
  let depth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < HTML.length; i++) {
    if (HTML[i] === '(') depth++;
    else if (HTML[i] === ')' && --depth === 0) { parenClose = i; break; }
  }
  assert.notEqual(parenClose, -1, `could not delimit ${name} parameters`);
  const params = HTML.slice(parenOpen, parenClose + 1);
  const isAsync = /^async\s/.test(HTML.slice(at + 3, parenOpen));
  const open = HTML.indexOf('{', parenClose);
  let braces = 0;
  let end = -1;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') braces++;
    else if (HTML[i] === '}' && --braces === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `could not delimit ${name} body`);
  return { params, body: HTML.slice(open, end), isAsync };
}

function method(name) {
  const { params, body, isAsync } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const fn = new Function('I18n', '...args', `return (${isAsync ? 'async ' : ''}function ${name}${params} ${body}).apply(this, args);`);
  return function (...args) { return fn.call(this, I18n, ...args); };
}

const I18n = { locale: 'zh-CN', t: (key, vars) => `i18n:${key}${vars ? ':' + JSON.stringify(vars) : ''}` };

function themes() {
  const light = customProperties(CSS, ':root');
  const dark = { ...light, ...customProperties(CSS, '[data-theme="dark"]') };
  return { light, dark };
}
function color(vars, name) {
  const parsed = parseColor(resolveVar(vars[name], vars));
  assert.ok(parsed, `${name} must resolve to a colour`);
  return parsed;
}

describe('P1 colour: measured hover states and on-fill labels', () => {
  const { light, dark } = themes();

  it('defines every status on-* label and explicit hover fill', () => {
    for (const [theme, vars] of Object.entries({ light, dark })) {
      for (const token of ['--on-success', '--on-warn', '--on-error', '--on-info']) {
        assert.ok(vars[token], `${theme}: ${token} is defined`);
      }
      for (const token of ['--success-hover', '--warn-hover', '--error-hover', '--info-hover']) {
        assert.ok(vars[token], `${theme}: ${token} is defined`);
      }
    }
  });

  it('keeps every on-* label above AA on both the base and hover fill', () => {
    const pairs = [
      ['--on-success', '--success', '--success-hover'],
      ['--on-warn', '--warn', '--warn-hover'],
      ['--on-error', '--error', '--error-hover'],
      ['--on-info', '--info', '--info-hover'],
    ];
    for (const [theme, vars] of Object.entries({ light, dark })) {
      for (const [label, fill, hover] of pairs) {
        for (const bg of [fill, hover]) {
          const ratio = contrastRatio(color(vars, label), color(vars, bg));
          assert.ok(ratio >= TEXT_FLOOR, `${theme}: ${label} on ${bg} is ${ratio}:1`);
        }
      }
    }
  });

  it('removed the brightness() hover filters from danger/success buttons', () => {
    assert.doesNotMatch(HTML, /\.btn-danger:hover[^{]*\{[^}]*filter:\s*brightness/);
    assert.doesNotMatch(HTML, /\.btn-success:hover[^{]*\{[^}]*filter:\s*brightness/);
    assert.match(CSS, /\.btn-danger:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--error-hover\)/s);
    assert.match(CSS, /\.btn-success:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--success-hover\)/s);
  });

  it('has no unresolved custom properties', () => {
    assert.deepEqual(undefinedCustomProperties(HTML), []);
    assert.doesNotMatch(HTML, /var\(--muted\b/);
    assert.doesNotMatch(HTML, /var\(--info-bg\b/);
  });
});

describe('P1 typography and badge matrix', () => {
  it('keeps literal font sizes at or above 12px', () => {
    const small = [...HTML.matchAll(/font-size:\s*(8|9|10(?:\.5)?|11(?:\.5)?)px/g)].map((m) => m[0]);
    assert.deepEqual(small, []);
  });

  it('does not route meaningful text through the 9/10/11px tokens', () => {
    assert.doesNotMatch(HTML, /var\(--fs-(?:3xs|2xs|xs)\)/);
  });

  it('maps the legacy badge-success markup to the real success variant', () => {
    assert.match(CSS, /\.badge\.active,\s*\.badge\.running,\s*\.badge\.success,\s*\.badge-success\s*\{/);
    const badge = CSS.match(/\.badge\s*\{([^}]*)\}/s);
    assert.ok(badge, '.badge base exists');
    assert.match(badge[1], /font-size:\s*12px/);
  });

  it('gives the tier/chip/capability pills the same readable geometry', () => {
    for (const selector of ['.tier', '.chip-badge', '.cap-item']) {
      const re = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 's');
      const m = CSS.match(re);
      assert.ok(m, `${selector} exists`);
      assert.match(m[1], /font-size:\s*12px/, `${selector} is 12px`);
    }
  });

  it('uses solid accent focus outlines instead of wash-only rings', () => {
    assert.match(CSS, /\.sidebar nav a:focus-visible,\s*\n?\.seg-btn:focus-visible,\s*\n?\[role="button"\]:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-focus\)/s);
  });
});

describe('P1 #1 destructive confirmation defaults', () => {
  it('never approves a danger dialog on a bare Enter', () => {
    const src = methodParts('confirm').body;
    assert.match(src, /const isDanger = !!opts\.danger/);
    assert.match(src, /e\.key === 'Enter' && !isDanger/);
    assert.doesNotMatch(src, /e\.key === 'Enter' && e\.target\.tagName !== 'BUTTON'\) \{ e\.preventDefault\(\); close\(true\); \}/);
  });

  it('focuses Cancel first for danger and supports a typed confirmation', () => {
    const src = methodParts('confirm').body;
    assert.match(src, /const target = isDanger[\s\S]{0,120}\[data-act=cancel\]/);
    assert.match(src, /opts\.requireText/);
    assert.match(src, /okBtn\.disabled = !confirmMatches\(\)/);
  });

  it('requires the exact count when bulk delete exceeds the visible page', () => {
    const src = methodParts('batchAccountOp').body;
    assert.match(src, /const visible = Number\(this\.accountsPageSize\) \|\| 50/);
    assert.match(src, /requireText: requireCount \|\| undefined/);
  });
});

describe('P1 #3 delete is response-gated', () => {
  function self(overrides = {}) {
    return {
      _accountDetails: new Map([['a1', {}]]),
      _cardsByAccount: new Map([['a1', {}]]),
      _requestsByAccount: new Map([['a1', []]]),
      _selectedAccounts: new Set(['a1']),
      _batchResults: new Map([['a1', {}]]),
      _drawerAccountId: 'a1',
      toasts: [],
      confirm: async () => true,
      translateError: (_e, fallback) => `i18n:${fallback}`,
      _showAccountActionError(message, retry) { this.inlineError = { message, retry }; },
      loadAccounts() { this.loaded = true; },
      closeAccountDrawer() { this.closed = true; },
      toast(message, type = 'success') { this.toasts.push({ message, type }); },
      ...overrides,
    };
  }

  it('keeps the row, drawer and selection when DELETE returns success:false', async () => {
    const s = self({ api: async () => ({ success: false, error: 'denied' }) });
    await method('deleteAccount').call(s, 'a1');
    assert.ok(s._accountDetails.has('a1'), 'detail cache retained');
    assert.ok(s._cardsByAccount.has('a1'), 'card cache retained');
    assert.ok(s._selectedAccounts.has('a1'), 'selection retained');
    assert.equal(s.loaded, undefined, 'list not reloaded');
    assert.equal(s.closed, undefined, 'drawer not closed');
    assert.ok(s.inlineError, 'inline error exposed');
    assert.equal(s.toasts.filter((t) => t.type === 'success').length, 0, 'no false success toast');
  });

  it('clears local state only after a confirmed success envelope', async () => {
    const s = self({ api: async () => ({ success: true }) });
    await method('deleteAccount').call(s, 'a1');
    assert.equal(s._accountDetails.has('a1'), false);
    assert.equal(s._cardsByAccount.has('a1'), false);
    assert.equal(s._selectedAccounts.has('a1'), false);
    assert.equal(s.loaded, true);
    assert.equal(s.closed, true);
    assert.equal(s.toasts.filter((t) => t.type === 'success').length, 1);
  });
});

describe('P1 #8 settings writes are truthful and serialized', () => {
  it('rolls a preference checkbox back and never says saved on success:false', async () => {
    const checkbox = { type: 'checkbox', checked: true, disabled: false, parentNode: null, setAttribute() {}, removeAttribute() {}, getAttribute: () => "App.savePref('oauthSkipChooser', this.checked)" };
    const oldDocument = globalThis.document;
    globalThis.document = {
      querySelectorAll: () => [checkbox],
      querySelector: () => null,
      createElement: () => ({ dataset: {}, className: '', textContent: '', appendChild() {}, querySelector: () => null }),
    };
    try {
      const s = {
        _prefs: {}, _pendingWrites: new Map(), toasts: [],
        api: async () => ({ success: false, error: 'nope' }),
        translateError: () => 'i18n:error.saveFailed',
        toast(message, type = 'success') { this.toasts.push({ message, type }); },
      };
      s._beginInlineSave = method('_beginInlineSave');
      s._endInlineSave = method('_endInlineSave');
      await method('savePref').call(s, 'oauthSkipChooser', true);
      assert.equal(checkbox.checked, false, 'previous checkbox state restored');
      assert.equal(checkbox.disabled, false, 'control re-enabled');
      assert.equal(s.toasts.filter((t) => t.type === 'success').length, 0);
    } finally {
      globalThis.document = oldDocument;
    }
  });

  it('_putBackendSwitch throws on success:false instead of toasting success', async () => {
    const s = {
      _pendingWrites: new Map(), toasts: [],
      api: async () => ({ success: false, error: 'denied' }),
      translateError: () => 'i18n:error.saveFailed',
      toast(message, type = 'success') { this.toasts.push({ message, type }); },
    };
    await assert.rejects(() => method('_putBackendSwitch').call(s, { devinConnect: true }));
    assert.equal(s.toasts.filter((t) => t.type === 'success').length, 0);
  });

  it('serializes a second write for the same key while the first is pending', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const s = {
      _pendingWrites: new Map(), toasts: [],
      api: async () => { calls++; await gate; return { success: true }; },
      translateError: () => 'x',
      toast() {},
    };
    const p1 = method('_putBackendSwitch').call(s, { devinConnect: true });
    const p2 = method('_putBackendSwitch').call(s, { devinConnect: false });
    release();
    await Promise.all([p1, p2]);
    assert.equal(calls, 1, 'only one in-flight write per key');
  });
});

describe('P1 #2 overview lifecycle', () => {
  it('has an inline error and a persistent stale banner, not an endless skeleton', () => {
    assert.match(HTML, /id="overview-stale-banner"[^>]*role="status"/);
    assert.match(methodParts('_renderOverviewError').body, /overview\.errorTitle/);
    assert.match(methodParts('_renderOverviewError').body, /action\.retry/);
    const load = methodParts('loadOverview').body;
    assert.match(load, /if \(!d \|\| d\.success === false\)/);
    assert.match(load, /this\._showOverviewStale\(reason\)/);
    assert.match(load, /this\._renderOverviewError\(reason\)/);
    assert.match(load, /this\._overviewPollDelay\(\)/);
  });

  it('backs off 15s → 30s → 60s and resets on success', () => {
    const fn = method('_overviewPollDelay');
    assert.equal(fn.call({ _overviewFailures: 1 }), 15000);
    assert.equal(fn.call({ _overviewFailures: 2 }), 30000);
    assert.equal(fn.call({ _overviewFailures: 3 }), 60000);
    assert.equal(fn.call({ _overviewFailures: 9 }), 60000);
  });
});

describe('P1 #5/#9 mobile navigation and table access', () => {
  it('adds a mobile app bar and a labelled off-canvas drawer', () => {
    assert.match(HTML, /class="mobile-appbar"/);
    assert.match(HTML, /id="mobile-menu-btn"[\s\S]{0,160}aria-controls="app-sidebar"/);
    assert.match(CSS, /@media \(max-width: 720px\)\s*\{[\s\S]*?\.mobile-appbar\s*\{[^}]*display:\s*flex/s);
    assert.match(CSS, /\.sidebar\.open\s*\{\s*transform:\s*none;\s*\}/);
    assert.match(CSS, /#settings-search\s*\{\s*display:\s*none;\s*\}/);
    assert.ok(ZH.aria.openNav && EN.aria.openNav);
  });

  it('keeps mobile row/menu and pagination targets at least 44px', () => {
    assert.match(CSS, /\.row-menu-btn,\s*\.table-pagination \.btn,\s*\.btn-xs\s*\{\s*min-height:\s*44px;\s*min-width:\s*44px;\s*\}/);
  });

  it('scopes overflow-x:visible to the accounts card transformation only', () => {
    assert.match(CSS, /\.accounts-table-wrap\s*\{\s*overflow-x:\s*visible;\s*\}/);
    assert.doesNotMatch(CSS, /\.table-wrap\s*\{\s*overflow-x:\s*visible;\s*\}/);
    assert.match(CSS, /\.table-wrap:not\(\.accounts-table-wrap\)\s*\{[^}]*overflow-x:\s*auto/);
    assert.match(HTML, /class="table-wrap accounts-table-wrap"/);
  });

  it('makes non-account table regions keyboard-scrollable', () => {
    const wraps = [...HTML.matchAll(/<div class="table-wrap"([^>]*)>/g)];
    assert.ok(wraps.length > 0);
    for (const m of wraps) {
      assert.match(m[1], /tabindex="0"/);
      assert.match(m[1], /role="region"/);
      assert.match(m[1], /data-i18n-aria-label="aria\.scrollableTable"/);
    }
  });
});

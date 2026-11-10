// Dashboard color system — tokens, states and measured AA contrast.
//
// The shipped gate (scripts/check-dashboard-contrast.mjs) runs the same WCAG
// 2.2 math. This test pins the *new* surface/accent/status pairs from
// evidence/DashboardColor.md so a future palette edit cannot silently drop a
// -text twin back onto a fill hue or remove a state token.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readStyleBlock, customProperties, resolveVar, parseColor, composite, contrastRatio,
} from '../scripts/dashboard-css.mjs';
import {
  TEXT_ON_SOFT, UI_BORDERS, ACCENT_STATES, TEXT_FLOOR, GRAPHICAL_FLOOR, LADDER_FLOOR,
} from '../scripts/check-dashboard-contrast.mjs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const CSS = readStyleBlock(HTML);

function themes() {
  const light = customProperties(CSS, ':root');
  const dark = { ...light, ...customProperties(CSS, '[data-theme="dark"]') };
  return { light, dark };
}

function color(vars, name) {
  const raw = resolveVar(vars[name], vars);
  const parsed = parseColor(raw);
  assert.ok(parsed, `${name} must resolve to a colour, got ${raw}`);
  return parsed;
}

function onSurface(vars, name) {
  const surface = color(vars, '--surface');
  const fg = color(vars, name);
  return fg.a < 1 ? composite(fg, surface) : fg;
}

function onWash(vars, name) {
  const surface = color(vars, '--surface');
  const wash = color(vars, name);
  return wash.a < 1 ? composite(wash, surface) : wash;
}

describe('dashboard color system', () => {
  const { light, dark } = themes();

  it('defines the surface/elevation ramp on the existing --surface-* names', () => {
    for (const vars of [light, dark]) {
      assert.equal(resolveVar(vars['--bg-elev'], vars), resolveVar(vars['--surface-2'], vars),
        '--bg-elev must be the field rung of the same ramp');
      const ladder = ['--paper', '--surface', '--surface-2', '--surface-3'];
      for (let i = 1; i < ladder.length; i++) {
        const ratio = contrastRatio(color(vars, ladder[i]), color(vars, ladder[i - 1]));
        assert.ok(ratio >= LADDER_FLOOR, `${ladder[i]} vs ${ladder[i - 1]} is ${ratio}:1`);
      }
    }
  });

  it('defines one accent with hover/active/focus/text states in both themes', () => {
    for (const vars of [light, dark]) {
      for (const token of ['--accent', '--accent-hover', '--accent-active', '--accent-focus', '--accent-text', '--accent-soft', '--on-accent']) {
        assert.ok(vars[token], `${token} is defined`);
      }
      assert.match(vars['--gradient-accent'], /^linear-gradient\(/);
      assert.match(vars['--gradient-accent'], /var\(--accent-soft\)/);
      for (const token of ACCENT_STATES) {
        const ratio = contrastRatio(onSurface(vars, token), color(vars, '--surface'));
        assert.ok(ratio >= GRAPHICAL_FLOOR, `${token} is ${ratio}:1 on --surface`);
      }
    }
  });

  it('keeps every status/accent text twin above AA on surface and its soft wash', () => {
    for (const [theme, vars] of Object.entries({ light, dark })) {
      for (const [token, soft] of Object.entries(TEXT_ON_SOFT)) {
        assert.ok(vars[token], `${theme}: ${token} is defined`);
        for (const bg of ['--surface', '--surface-2', '--surface-3']) {
          const ratio = contrastRatio(onSurface(vars, token), color(vars, bg));
          assert.ok(ratio >= TEXT_FLOOR, `${theme}: ${token} is ${ratio}:1 on ${bg}`);
        }
        const onSoftRatio = contrastRatio(onSurface(vars, token), onWash(vars, soft));
        assert.ok(onSoftRatio >= TEXT_FLOOR, `${theme}: ${token} is ${onSoftRatio}:1 on ${soft}`);
      }
    }
  });

  it('keeps control borders at 3:1 on every surface rung', () => {
    for (const [theme, vars] of Object.entries({ light, dark })) {
      for (const token of UI_BORDERS) {
        for (const bg of ['--surface', '--surface-2', '--surface-3']) {
          const surface = color(vars, bg);
          let border = color(vars, token);
          if (border.a < 1) border = composite(border, surface);
          const ratio = contrastRatio(border, surface);
          assert.ok(ratio >= GRAPHICAL_FLOOR, `${theme}: ${token} is ${ratio}:1 on ${bg}`);
        }
      }
    }
  });

  it('keeps the on-accent label above AA on every solid fill it labels', () => {
    for (const [theme, vars] of Object.entries({ light, dark })) {
      const label = color(vars, '--on-accent');
      for (const fill of ['--accent', '--accent-hover', '--success', '--warn', '--error', '--info']) {
        const ratio = contrastRatio(label, color(vars, fill));
        assert.ok(ratio >= TEXT_FLOOR, `${theme}: --on-accent is ${ratio}:1 on ${fill}`);
      }
    }
  });

  it('routes text through the -text twins and fills through the base hues', () => {
    const plain = /(?<![-a-zA-Z])color:\s*var\(--(accent|success|warn|error|info)\)/g;
    assert.deepEqual([...HTML.matchAll(plain)].map((m) => m[0]), [],
      'status/accent fills must not be used as text colours');
    assert.match(CSS, /\.page-header::before\s*\{[^}]*background:\s*var\(--gradient-accent\)/s);
    assert.match(CSS, /\.metrics-grid \.card\s*\{[^}]*background-image:\s*var\(--gradient-accent\)/s);
    assert.match(CSS, /\.btn-primary:active:not\(:disabled\)\s*\{[^}]*var\(--accent-active\)/s);
    assert.match(CSS, /a:focus-visible\s*\{[^}]*var\(--accent-focus\)/s);
    assert.match(CSS, /\.input, \.select, \.textarea\s*\{[^}]*border:\s*1px solid var\(--border-control\)/s);
  });
});

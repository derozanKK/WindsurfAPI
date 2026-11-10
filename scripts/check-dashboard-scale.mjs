#!/usr/bin/env node
/**
 * UISpec P2 — dashboard scale gate (account + usage surfaces).
 *
 * The account page, the add/login modal and the usage panel each grew their own
 * px values. This gate pins them to the two token scales in the :root block:
 *
 *   --space-<n>  spacing, named by its px value (2px grid)
 *   --text-*     one dense type ladder
 *   --radius-*   the existing radius set (+ --radius-xs for chips/swatches)
 *
 * It also pins the 44 px row budget: `--acct-row-pad-y` may only appear on the
 * accounts table, so a later "cleanup" cannot quietly turn 5 px into 4 or 6 and
 * move every row off the height 3.9.50 measured.
 *
 * Exit 0 = clean. Exported as lintDashboardScale() for the test suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStyleBlock, parseRules, parseDeclarations, customProperties } from './dashboard-css.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Account management, add/login modal, usage panel + their shared primitives. */
export const SCOPE = /(\.acct-|#accounts-|\.fleet-|\.add-modal|\.add-tabs|\.add-tab\b|\.add-panel|\.add-result|\.login-method|\.login-panel|\.login-steps|\.login-advanced|\.login-token-step|\.login-alt-panel|\.method-chip|\.provider-swatch|\.detail-advanced|\.note-chip|\.row-menu|\.tb-group|\.oauth-brand|\.th-sort|\.usage-|#p-accounts)/;

const SPACING_PROPS = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap',
]);

/** Values that are allowed without a token, and why. */
function spacingOk(token, selector) {
  if (token === '0' || token === 'auto') return true;
  if (token === '1px') return true; // hairline (1 px borders/offsets)
  if (/^var\(--space-\d+\)$/.test(token)) return true;
  if (token === 'var(--acct-row-pad-y)') return /#accounts-table/.test(selector);
  if (token.endsWith('%')) return true;
  if (token.includes('calc(')) return true; // e.g. calc(-1 * var(--space-4))
  return false;
}

function radiusOk(value) {
  if (/^var\(--radius(-sm|-lg|-xs)?\)$/.test(value)) return true;
  if (value === '999px' || value === '50%' || value === '0') return true;
  const px = Number(String(value).replace('px', ''));
  return Number.isFinite(px) && px <= 2; // optical radius on a 2–3 px bar
}

function pxNumber(value) {
  const m = String(value).match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? Number(m[1]) : null;
}

export function lintDashboardScale(html = readDashboardHtml()) {
  const problems = [];
  const css = readStyleBlock(html);

  // ── the tokens themselves ────────────────────────────────────────────────
  const root = customProperties(css, ':root');
  const spaces = Object.keys(root).filter((k) => /^--space-\d+$/.test(k));
  if (!spaces.length) problems.push('no --space-* tokens defined');
  for (const key of spaces) {
    const expected = Number(key.replace('--space-', ''));
    const actual = pxNumber(root[key]);
    if (actual !== expected) problems.push(`${key} must be ${expected}px, found ${root[key]}`);
    if (expected % 2 !== 0) problems.push(`${key} is off the 2px grid`);
  }
  const texts = Object.keys(root).filter((k) => /^--fs-/.test(k));
  if (!texts.length) problems.push('no --fs-* tokens defined');
  let prev = 0;
  for (const key of texts) {
    const size = pxNumber(root[key]);
    if (size === null) { problems.push(`${key} must be a px size, found ${root[key]}`); continue; }
    if (size <= prev) problems.push(`${key} (${size}px) is not larger than the previous step (${prev}px)`);
    prev = size;
  }
  if (root['--acct-row-pad-y'] !== '5px') {
    problems.push(`--acct-row-pad-y must stay 5px (44px row budget), found ${root['--acct-row-pad-y']}`);
  }

  // ── the rules that use them ──────────────────────────────────────────────
  for (const { selector, body } of parseRules(css)) {
    if (!SCOPE.test(selector)) continue;
    for (const { prop, value } of parseDeclarations(body)) {
      if (prop === 'font-size') {
        if (!/^var\(--fs-[a-z0-9]+\)$/.test(value) && value !== 'inherit') {
          problems.push(`${selector} — font-size: ${value} (use var(--fs-*))`);
        }
        continue;
      }
      if (SPACING_PROPS.has(prop)) {
        if (value.includes('calc(')) continue; // calc() is already token-derived
        const tokens = value.split(/\s+/).filter(Boolean);
        const bad = tokens.filter((t) => !spacingOk(t, selector));
        if (bad.length) problems.push(`${selector} — ${prop}: ${value} (off-scale: ${bad.join(' ')})`);
        continue;
      }
      if (prop === 'border-radius' && !radiusOk(value)) {
        problems.push(`${selector} — border-radius: ${value} (use var(--radius-*))`);
      }
    }
  }

  // ── the row budget stays on the table ────────────────────────────────────
  for (const { selector, body } of parseRules(css)) {
    if (!body.includes('var(--acct-row-pad-y)')) continue;
    if (/#accounts-table/.test(selector)) continue;
    problems.push(`${selector} uses --acct-row-pad-y outside the accounts table`);
  }

  return { ok: problems.length === 0, problems };
}

function readDashboardHtml() {
  return fs.readFileSync(path.join(ROOT, 'src/dashboard/index.html'), 'utf8');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { ok, problems } = lintDashboardScale();
  if (ok) {
    console.log('✓ dashboard scale: account/usage surfaces use the spacing + type tokens');
    process.exit(0);
  }
  console.error(`✗ dashboard scale: ${problems.length} off-scale value(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * AC-COPY-1 — dashboard copy lint (account + usage scope).
 *
 * The P0 was "normal-path UI speaks in implementation names": `api_key` chips,
 * `ls_not_idle_resident` skip reasons, `GetUserStatus` in the re-auth notice,
 * raw `ERR_*` fallbacks. This script pins the fix so the next feature can't
 * quietly reintroduce them.
 *
 * Rules:
 *  1. Every string in the account/usage scope of BOTH locales is scanned for
 *     the forbidden vocabulary. A technical key (`*.tech*`, `tooltip.help.*`)
 *     may carry the raw term — that is where the code is allowed to live.
 *  2. Locale parity: a key present in one locale must exist in the other.
 *  3. Source rules on index.html: the row renders a method LABEL (not the raw
 *     enum), skip reasons go through skipReasonText(), the failure list does
 *     not print `error || reason` raw, and translateError has a human fallback.
 *
 * Exit 0 = clean. Also exported as lintDashboardCopy() for the test suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Scope from UISpec §8: account management + usage + their shared chrome. */
export const SCOPE = /^(accounts\.|batchOps\.|usage\.|account\.detail\.|section\.(smartImport|addAccount|oauthLogin|emailLogin)|help\.|pageSubtitle\.accounts|pageSubtitle\.usage|table\.header\.)/;

/** Technical-detail channels: the raw identifier is allowed here. */
export const TECH = /(^|\.)[a-z]*tech[a-z]*($|\.)|^tooltip\.help\./i;

export const FORBIDDEN = [
  { label: 'GetUserStatus', re: /GetUserStatus/ },
  { label: 'auth1_', re: /\bauth1_/ },
  { label: 'loopback', re: /\bloopback\b/i },
  { label: 'api_key', re: /\bapi_key\b/ },
  { label: 'ls_not_idle_resident', re: /\bls_not_idle_resident\b/ },
  { label: 'account_busy', re: /\baccount_busy\b/ },
  { label: 'ERR_*', re: /\bERR_[A-Z0-9_]+\b/ },
  { label: '上游', re: /上游/ },
  { label: 'upstream', re: /\bupstream\b/i },
  { label: 'JSON', re: /\bJSON\b/ },
  { label: 'PostAuth', re: /\bPostAuth\b/ },
];

/**
 * UISpec P0-4 — one action, one verb.
 *
 * `check` is the free probe (tier + models), `refresh balance` reads credits and
 * on-demand balance in one upstream call, and 配额 / 额度 / 余额 keep their
 * distinct meanings. These keys are the canonical strings; the scan below
 * rejects the retired synonyms anywhere in the account/usage scope.
 */
export const TERMS = [
  { locale: 'zh-CN', key: 'batchOps.probe', must: /^检查$/, why: 'the probe action is 检查' },
  { locale: 'zh-CN', key: 'accounts.toolbar.probeAll', must: /^全部检查$/, why: 'the fleet probe is 全部检查' },
  { locale: 'zh-CN', key: 'accounts.row.probe', must: /^检查层级与模型$/, why: 'the row action is 检查层级与模型' },
  { locale: 'zh-CN', key: 'action.probe', must: /^检查$/, why: 'the drawer footer action is 检查' },
  { locale: 'zh-CN', key: 'batchOps.refresh', must: /^刷新余额$/, why: 'the balance action is 刷新余额' },
  { locale: 'zh-CN', key: 'accounts.row.refreshBalance', must: /^刷新余额$/, why: 'the row balance action is 刷新余额' },
  { locale: 'zh-CN', key: 'accounts.toolbar.refreshAll', must: /^刷新全部余额$/, why: 'the fleet balance action is 刷新全部余额' },
  { locale: 'zh-CN', key: 'table.header.quota', must: /^配额$/, why: '配额 is the daily/weekly percentage' },
  { locale: 'zh-CN', key: 'table.header.credits', must: /^余额$/, why: '余额 is the on-demand balance' },
  { locale: 'en', key: 'batchOps.probe', must: /^Check$/, why: 'the probe action is Check' },
  { locale: 'en', key: 'accounts.toolbar.probeAll', must: /^Check all$/, why: 'the fleet probe is Check all' },
  { locale: 'en', key: 'accounts.row.probe', must: /^Check tier and models$/, why: 'the row action is Check tier and models' },
  { locale: 'en', key: 'action.probe', must: /^Check$/, why: 'the drawer footer action is Check' },
  { locale: 'en', key: 'batchOps.refresh', must: /^Refresh balances$/, why: 'the balance action is Refresh balances' },
  { locale: 'en', key: 'accounts.row.refreshBalance', must: /^Refresh balance$/, why: 'the row balance action is Refresh balance' },
  { locale: 'en', key: 'accounts.toolbar.refreshAll', must: /^Refresh all balances$/, why: 'the fleet balance action is Refresh all balances' },
];

/** Retired synonyms; their presence anywhere visible in scope is a regression. */
export const RETIRED = [
  { locale: 'zh-CN', label: '刷新额度', re: /刷新额度/ },
  { locale: 'zh-CN', label: '探测', re: /探测/ },
  { locale: 'en', label: 'Refresh credits', re: /\bRefresh credits\b/i },
  { locale: 'en', label: 'Probe', re: /\bProbe\b/i },
];

function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

function readLocale(name) {
  return flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/dashboard/i18n', `${name}.json`), 'utf8')));
}

/** Locale + source lint. Returns `{ok, problems[]}`; never throws on findings. */
export function lintDashboardCopy() {
  const problems = [];
  const zh = readLocale('zh-CN');
  const en = readLocale('en');

  for (const key of Object.keys(zh)) {
    if (!Object.hasOwn(en, key)) problems.push(`locale parity: ${key} exists in zh-CN but not en`);
  }
  for (const key of Object.keys(en)) {
    if (!Object.hasOwn(zh, key)) problems.push(`locale parity: ${key} exists in en but not zh-CN`);
  }

  for (const [locale, table] of [['zh-CN', zh], ['en', en]]) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string' || !SCOPE.test(key) || TECH.test(key)) continue;
      for (const { label, re } of FORBIDDEN) {
        if (re.test(value)) problems.push(`${locale} ${key}: contains "${label}" — ${value.slice(0, 80)}`);
      }
      for (const { label, re } of RETIRED) {
        if (re.test(value)) problems.push(`${locale} ${key}: uses retired verb "${label}" — ${value.slice(0, 80)}`);
      }
    }
  }

  // Canonical action strings (one action, one verb).
  for (const { locale, key, must, why } of TERMS) {
    const table = locale === 'zh-CN' ? zh : en;
    const value = table[key];
    if (typeof value !== 'string') problems.push(`${locale} ${key}: missing canonical action string (${why})`);
    else if (!must.test(value)) problems.push(`${locale} ${key}: "${value}" does not match ${must} (${why})`);
  }

  const html = fs.readFileSync(path.join(ROOT, 'src/dashboard/index.html'), 'utf8');
  const sourceRules = [
    {
      // The row must not print the storage enum; it renders a label with the
      // raw value only in the chip's title.
      bad: /class="method-chip"[^>]*>\$\{this\.esc\(a\.method/,
      label: 'row renders the raw credential method enum',
    },
    {
      // Failure lists must not concatenate `error || reason` straight into the
      // DOM: both are identifiers (`ls_not_idle_resident`, `ERR_*`).
      bad: /esc\(f\.error \|\| f\.reason/,
      label: 'failure list prints a raw error/reason identifier',
    },
    {
      bad: /return errorCode \|\| I18n\.t\(fallbackKey\);/,
      label: 'translateError falls back to the raw code instead of a human sentence',
    },
  ];
  for (const rule of sourceRules) {
    if (rule.bad.test(html)) problems.push(`index.html: ${rule.label}`);
  }
  for (const required of [
    'accountMethodLabel(', 'skipReasonText(', "'error.genericAction'", 'accounts.fleet.running',
    'setAddModalTitle(', 'selectLoginMethod(', 'toggleStatusDetails(', 'renderLastCheck(', 'onDrawerAdvancedToggle(',
  ]) {
    if (!html.includes(required)) problems.push(`index.html: missing required human-copy hook ${required}`);
  }

  return { ok: problems.length === 0, problems };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { ok, problems } = lintDashboardCopy();
  if (ok) {
    console.log('✓ dashboard copy: account/usage scope is free of machine identifiers');
  } else {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\n${problems.length} copy problem(s)`);
  }
  process.exit(ok ? 0 : 1);
}

// Dashboard copy lint (UISpec P0-2 / AC-COPY-1, AC-COPY-3).
//
// The lint itself lives in scripts/check-dashboard-copy.mjs so a release check
// and the test suite run the same rules. This file pins the behaviour the P0
// asked for: normal-path copy never shows an identifier, and the identifier is
// still reachable in a technical-detail channel.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintDashboardCopy, FORBIDDEN, SCOPE, TECH } from '../scripts/check-dashboard-copy.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

function locale(name) {
  return flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/dashboard/i18n', `${name}.json`), 'utf8')));
}

describe('dashboard copy lint (AC-COPY-1)', () => {
  it('reports zero problems in the account/usage scope', () => {
    const { ok, problems } = lintDashboardCopy();
    assert.deepEqual(problems, []);
    assert.equal(ok, true);
  });

  it('scopes account + usage copy and exempts technical-detail keys', () => {
    assert.ok(SCOPE.test('accounts.reauth.detail'));
    assert.ok(SCOPE.test('usage.reason.upstream'));
    assert.ok(SCOPE.test('account.detail.key.expiryNote'));
    assert.ok(!SCOPE.test('overview.title'), 'unrelated panels are out of scope');
    assert.ok(TECH.test('accounts.reauth.techDetail'));
    assert.ok(TECH.test('account.detail.modelStatus.sourceTech'));
    assert.ok(TECH.test('tooltip.help.devinOnly'));
    assert.ok(!TECH.test('accounts.reauth.detail'));
  });

  it('keeps every forbidden term out of visible copy', () => {
    for (const name of ['zh-CN', 'en']) {
      const table = locale(name);
      for (const [key, value] of Object.entries(table)) {
        if (typeof value !== 'string' || !SCOPE.test(key) || TECH.test(key)) continue;
        for (const { label, re } of FORBIDDEN) {
          assert.ok(!re.test(value), `${name} ${key} must not contain "${label}"`);
        }
      }
    }
  });
});

describe('human labels (AC-COPY-3)', () => {
  it('never renders the credential storage enum as its own label', () => {
    const zh = locale('zh-CN');
    const en = locale('en');
    for (const method of ['api_key', 'token', 'email', 'session', 'unknown']) {
      const key = `accounts.method.${method}`;
      assert.ok(zh[key], `zh has a label for ${method}`);
      assert.ok(en[key], `en has a label for ${method}`);
      assert.notEqual(zh[key], method);
      assert.notEqual(en[key], method);
      assert.ok(!/[_$]/.test(zh[key]), `zh ${method} label must be prose`);
      assert.ok(!/[_$]/.test(en[key]), `en ${method} label must be prose`);
    }
    assert.notEqual(zh['accounts.method.token'], en['accounts.method.token'], 'en is not a copy of zh');
  });

  it('translates every probe skip reason the backend can emit', () => {
    const zh = locale('zh-CN');
    for (const reason of ['ls_not_idle_resident', 'account_busy', 'memory_guard', 'probe_skipped']) {
      const value = zh[`accounts.skip.${reason}`];
      assert.ok(value, `zh has copy for skip reason ${reason}`);
      assert.ok(!value.includes('_'), `${reason} copy is a sentence, not the enum`);
    }
  });

  it('moves the re-auth code out of the sentence and into the technical detail', () => {
    const zh = locale('zh-CN');
    const en = locale('en');
    assert.ok(!zh['accounts.reauth.detail'].includes('{{code}}'), 'the default sentence has no code placeholder');
    assert.ok(!en['accounts.reauth.detail'].includes('{{code}}'));
    assert.match(zh['accounts.reauth.techDetail'], /\{\{code\}\}/, 'the code is still available under 技术详情');
    assert.match(en['accounts.reauth.techDetail'], /\{\{code\}\}/);
  });

  it('has a human fallback for an unmapped server error', () => {
    assert.ok(locale('zh-CN')['error.genericAction']);
    assert.ok(locale('en')['error.genericAction']);
  });
});

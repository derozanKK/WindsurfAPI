// Ledger backfill guard (2026-10-15): the credits wall lagged the PR corpus.
// The CONTRIBUTOR-MAP audit found four merged PRs by authors with no entry at
// all (suhaihui-git #142, Await-d #144, wjurkowlaniec #252, 3219378872 #278)
// and one missing row for warelik (#249 of his fifteen). This pins the backfill
// so the next drift is visible.
//
// The general structural checks live in dashboard-syntax.test.js (README
// representation, docs mirror byte-equality); this file covers the backfill.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../src/dashboard/data/contributors.json', import.meta.url), 'utf8'));

const BACKFILL = [
  { login: 'suhaihui-git', pr: 142 },
  { login: 'Await-d', pr: 144 },
  { login: 'warelik', pr: 249 },
  { login: 'wjurkowlaniec', pr: 252 },
  { login: '3219378872', pr: 278 },
];

describe('contributors ledger backfill', () => {
  it('every merged-PR backfill entry is present', () => {
    for (const { login, pr } of BACKFILL) {
      assert.ok(
        data.contributors.some((c) => c.login === login && c.pr === pr),
        `contributors.json must include @${login} PR #${pr}`,
      );
    }
  });

  it('backfill entries carry the full entry shape', () => {
    for (const { login, pr } of BACKFILL) {
      const hit = data.contributors.find((c) => c.login === login && c.pr === pr);
      for (const field of ['weight', 'weightLabel', 'mergedAt', 'title', 'summary']) {
        assert.ok(hit[field] && String(hit[field]).length > 0, `@${login} #${pr} missing ${field}`);
      }
      assert.match(hit.mergedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('warelik rows catch up with his merged-PR count (was 14 of 15)', () => {
    const rows = data.contributors.filter((c) => c.login === 'warelik');
    assert.ok(rows.length >= 15, `warelik needs at least 15 rows, found ${rows.length}`);
  });
});

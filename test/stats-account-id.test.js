// P1 — the request log's `account` dimension must be the immutable account id,
// never the upstream credential.
//
// Every DEVIN_CONNECT session token starts with the same eight characters
// (`devin-se` for `devin-session-token$…`, `auth1_XX` for PostAuth strings).
// The old `accountId.slice(0, 8)` therefore collapsed every connect account into
// ONE bucket, so the "By account" tab and its filter could not distinguish
// accounts on the normal chat path. It also persisted and displayed a
// credential-derived prefix. The log must carry an opaque `acct-<hash>` ref
// (the same shape the DevIn panel uses), derived from the stable id.
//
// P2 — a failed attempt is not spend. `recordRequest` charged the row's
// `credit` even when the success-only credit totals did not, so the log's cost
// column/summary over-reported by every failover/429/500.
//
// Red-first: the first three tests fail on the pre-fix code (two rows land in
// one `devin-se` bucket, the row carries the raw key prefix, and a failed row
// still carries the model's card price).
//
// Run through `npm test` or
// `node --import ./test/setup-env.mjs --test test/stats-account-id.test.js`:
// addAccountByKey starts a catalog sync, and setup-env's network guard keeps it
// local.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addAccountByKey, removeAccount } from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';
import {
  getRequestLog,
  getStats,
  importStats,
  recordRequest,
  resetStats,
} from '../src/dashboard/stats.js';
import { accountRef } from '../src/log-safety.js';
import { getModelInfo } from '../src/models.js';

const ACCOUNT_REF_RE = /^acct-[0-9a-f]{8}$/;
const createdIds = [];

function createAccount(key, label) {
  const acct = addAccountByKey(key, label);
  createdIds.push(acct.id);
  return acct;
}

beforeEach(() => resetStats());

afterEach(() => {
  while (createdIds.length) removeAccount(createdIds.pop());
  resetStats();
});

describe('request log account attribution', () => {
  it('keeps two accounts with the same credential prefix in distinct buckets', () => {
    recordRequest('m', true, 10, 'devin-session-token$AAAA1111');
    recordRequest('m', true, 10, 'devin-session-token$BBBB2222');

    const page = getRequestLog();
    assert.equal(page.byAccount.length, 2, 'two accounts must not collapse into one bucket');
    assert.equal(new Set(page.byAccount.map(a => a.account)).size, 2);
    for (const bucket of page.byAccount) {
      assert.match(bucket.account, ACCOUNT_REF_RE);
      assert.doesNotMatch(bucket.account, /devin|auth1|\$/);
    }
    assert.deepEqual(page.byAccount.map(a => a.requests), [1, 1]);
  });

  it('stores the stable account id as an opaque ref, not a key prefix', () => {
    recordRequest('m', true, 10, 'a1b2c3d4');

    const expected = accountRef('a1b2c3d4');
    assert.match(expected, ACCOUNT_REF_RE);
    assert.equal(getRequestLog().items[0].account, expected);
    assert.deepEqual(Object.keys(getStats().accountCounts), [expected]);
  });

  it('never re-derives a credential prefix for an auth1_ key', () => {
    recordRequest('m', true, 10, 'auth1_CCCC3333');
    recordRequest('m', true, 10, 'auth1_DDDD4444');

    const page = getRequestLog();
    assert.equal(page.byAccount.length, 2);
    for (const bucket of page.byAccount) {
      assert.match(bucket.account, ACCOUNT_REF_RE);
      assert.doesNotMatch(bucket.account, /auth1/i);
    }
    assert.equal(page.filters.accounts.includes('auth1_CC'), false);
  });

  it('attributes a real connect finalize to the immutable id (two accounts, one prefix)', () => {
    const a = createAccount('devin-session-token$LOGID-A-1111', 'logid-a');
    const b = createAccount('devin-session-token$LOGID-B-2222', 'logid-b');

    finalizeConnectAccount({ id: a.id, apiKey: a.apiKey }, {
      model: 'swe-1-6-slow', startTime: Date.now() - 5, err: null,
    });
    finalizeConnectAccount({ id: b.id, apiKey: b.apiKey }, {
      model: 'swe-1-6-slow', startTime: Date.now() - 5, err: null,
    });

    const page = getRequestLog();
    assert.equal(page.byAccount.length, 2, 'the handler must pass acct.id, not the presented key');
    assert.deepEqual(
      new Set(page.byAccount.map(row => row.account)),
      new Set([accountRef(a.id), accountRef(b.id)]),
    );
    for (const bucket of page.byAccount) {
      assert.doesNotMatch(bucket.account, /devin|session|\$/i);
    }
  });

  it('scrubs a legacy persisted credential prefix on import and display', () => {
    assert.equal(importStats({
      recentRequests: [
        { ts: 1, model: 'legacy', success: true, account: 'devin-se', credit: 0 },
      ],
      accountCounts: { 'devin-se': { requests: 1, success: 1, errors: 0 } },
    }, { mode: 'replace' }).ok, true);

    const page = getRequestLog();
    assert.match(page.items[0].account, ACCOUNT_REF_RE);
    assert.doesNotMatch(page.items[0].account, /devin/i);
    assert.deepEqual(Object.keys(getStats().accountCounts), [page.items[0].account]);
  });

  it('keeps an already-normalized ref idempotent across export/import', () => {
    recordRequest('m', true, 10, 'a1b2c3d4');
    const ref = getRequestLog().items[0].account;
    assert.equal(importStats({ recentRequests: [
      { ts: 2, model: 'm', success: true, account: ref, credit: 0 },
    ] }, { mode: 'replace' }).ok, true);
    assert.equal(getRequestLog().items[0].account, ref);
  });
});

describe('failed-attempt pricing', () => {
  it('charges zero on the row when the attempt failed', () => {
    const card = Number(getModelInfo('swe-2-medium')?.credit) || 0;
    assert.ok(card > 0, 'precondition: the static card prices swe-2-medium');

    recordRequest('swe-2-medium', true, 10, 'a1b2c3d4');
    recordRequest('swe-2-medium', false, 10, 'a1b2c3d4');

    const page = getRequestLog();
    const stats = getStats();
    const failed = page.items.find(row => row.success === false);
    const succeeded = page.items.find(row => row.success === true);

    assert.equal(succeeded.credit, card, 'the card price for swe-2-medium');
    assert.equal(failed.credit, 0, 'a failed attempt is not charged');
    assert.equal(page.summary.credits, stats.creditsTotal,
      'the log cost total must agree with the success-only credits card');
    assert.equal(page.byModel[0].credits, stats.creditsTotal);
    assert.equal(page.byAccount[0].credits, stats.creditsTotal);
  });
});

describe('source guard: recordRequest never receives a credential', () => {
  const CHAT = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');

  // Split a call's argument list on top-level commas only: `Date.now() - startTime`
  // and object/array arguments must not be torn apart.
  function splitArgs(body) {
    const args = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        args.push(body.slice(start, i).trim());
        start = i + 1;
      }
    }
    args.push(body.slice(start).trim());
    return args;
  }

  function calls(src) {
    const marker = 'recordRequest(';
    const out = [];
    let at = 0;
    while ((at = src.indexOf(marker, at)) !== -1) {
      let i = at + marker.length;
      let depth = 1;
      let quote = null;
      for (; i < src.length && depth > 0; i++) {
        const ch = src[i];
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      out.push(splitArgs(src.slice(at + marker.length, i - 1)));
      at = i;
    }
    return out;
  }

  it('passes an account id at every call site', () => {
    const sites = calls(CHAT).filter(args => args.length >= 4);

    assert.ok(sites.length >= 12, `expected all recordRequest call sites, found ${sites.length}`);
    for (const args of sites) {
      assert.doesNotMatch(args[3], /apiKey|currentApiKey/,
        `recordRequest must not receive the presented credential: ${args.join(', ')}`);
    }
    const accountArgs = new Set(sites.map(args => args[3]));
    for (const expected of ['acct.id', 'accountId', 'currentAccountId']) {
      assert.ok(accountArgs.has(expected), `expected a call site passing ${expected}`);
    }
  });
});

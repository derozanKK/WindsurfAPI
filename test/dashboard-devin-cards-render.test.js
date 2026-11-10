// Render guards for the DevinMap cards.
//
// These execute the SHIPPED template methods (brace-sliced out of index.html),
// not a mirror implementation — same technique as dashboard-spend-acu.test.js.
// The stub I18n returns `i18n:<key>` so an assertion can name which key drove
// which cell, and a hostile string must never reach the markup unescaped.

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function methodBody(name) {
  return methodParts(name).body;
}

function methodParts(name) {
  let at = HTML.indexOf(`\n  ${name}(`);
  if (at === -1) at = HTML.indexOf(`\n  async ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  const open = HTML.indexOf('{', at);
  const params = HTML.slice(HTML.indexOf(name, at) + name.length, open).trim();
  let depth = 0;
  let end = -1;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `could not delimit the body of ${name}`);
  return { params, body: HTML.slice(open, end) };
}

const I18n = {
  t: (key, vars) => (vars && vars.total != null ? `i18n:${key}|${vars.total}` : `i18n:${key}`),
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const self = {
  esc,
  escJsAttr: (value) => String(value ?? '').replace(/[\\'"<>&\r\n]/g, (c) => ({
    '\\': '\\\\', "'": "\\'", '"': '\\"', '<': '\\x3c', '>': '\\x3e', '&': '\\x26', '\r': '\\r', '\n': '\\n',
  }[c])),
  dmAgo: () => '5m',
  _preflightModel: new Map(),
};

function renderer(name) {
  const { params, body } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  return new Function('I18n', 'self', '...args', `return (function ${name}${params} ${body}).apply(self, args);`);
}

let renderLedgerCard;
let renderModelStatusCard;
let renderKeyCard;
let renderPreflightCard;
let renderRequestHistoryCard;
before(() => {
  renderLedgerCard = renderer('renderLedgerCard');
  renderModelStatusCard = renderer('renderModelStatusCard');
  renderKeyCard = renderer('renderKeyCard');
  renderPreflightCard = renderer('renderPreflightCard');
  renderRequestHistoryCard = renderer('renderRequestHistoryCard');
});

describe('ledger card', () => {
  it('renders the decoded ACU value when the decoder produced one', () => {
    const html = renderLedgerCard(I18n, self, {
      acu: { known: true, value: 1.25, reason: null },
      lifetime: { requests: 3, totalTokens: 120, creditCost: 2.5 },
      balance: { usd: 8, overageUsd: 0, known: true },
      cycle: { dailyPercent: 70, weeklyPercent: 80, prompt: { remaining: 10, limit: 20 }, flex: { remaining: 1, limit: 2 } },
      debits: [],
      latestSnapshotAt: 1_700_000_000_000,
    });
    assert.match(html, /i18n:account\.detail\.ledger\.acuKnown/);
    assert.match(html, />1[.,]25</, 'the decoded ACU magnitude must be on screen');
    assert.doesNotMatch(html, /acuNotObservable/);
    assert.match(html, /i18n:account\.detail\.ledger\.noDebits/);
  });

  it('labels an undecoded ACU as not observable and never prints 0', () => {
    const html = renderLedgerCard(I18n, self, {
      acu: { known: false, value: null, reason: 'no_billing_tag' },
      lifetime: { requests: 0, totalTokens: 0, creditCost: 0 },
      balance: { usd: null, overageUsd: null, known: false },
      cycle: {},
      debits: [],
    });
    assert.match(html, /i18n:account\.detail\.ledger\.acuNotObservable/);
    assert.doesNotMatch(html, /acuKnown/);
    const acuStat = html.match(/<span class="dm-stat-value">([^<]*)<\/span><span class="dm-stat-label">i18n:account\.detail\.ledger\.acu<\/span>/);
    assert.ok(acuStat, 'the ACU stat cell must exist');
    assert.equal(acuStat[1], '—', 'an undecoded ACU renders as an em dash, never 0');
  });

  it('renders observed debits with their deltas', () => {
    const html = renderLedgerCard(I18n, self, {
      acu: { known: false, value: null, reason: 'no_billing_tag' },
      lifetime: { requests: 1, totalTokens: 1, creditCost: 1 },
      balance: { usd: 7.5, overageUsd: 0, known: true },
      cycle: {},
      debits: [
        { ts: 2_000, kind: 'mixed', delta: { balanceUsd: -2.5, promptCredits: -40, flexCredits: null, dailyPercent: -10, weeklyPercent: null } },
      ],
      latestSnapshotAt: 2_000,
    });
    assert.match(html, /i18n:account\.detail\.ledger\.kind\.mixed/);
    assert.match(html, /-\$2\.50/, 'the balance delta must render');
    assert.match(html, /-40/);
    assert.doesNotMatch(html, /i18n:account\.detail\.ledger\.noDebits/);
  });

  it('escapes a hostile debit value instead of emitting markup', () => {
    const html = renderLedgerCard(I18n, self, {
      acu: { known: false },
      debits: [{ ts: 1, kind: '<img src=x onerror=alert(1)>', delta: {} }],
    });
    assert.doesNotMatch(html, /<img/);
  });
});

describe('model status card', () => {
  const status = {
    tier: 'pro',
    counts: { total: 3, available: 1, blocked: 1, notEntitled: 1, unknown: 0, freeNow: 0, tierListed: 2 },
    attention: [
      { id: 'claude-sonnet-4.6', status: 'blocked', tierListed: true, freeNow: false, creditNow: 4 },
      { id: 'gpt-5.5-medium', status: 'not_entitled', tierListed: true, freeNow: false, creditNow: 1.5 },
      { id: 'mystery-model', status: 'unknown', tierListed: false, freeNow: false, creditNow: null },
    ],
    source: { probed: true, rateTable: true },
    entitlementFetchedAt: 1_700_000_000_000,
  };

  it('renders all four state counts and the attention rows', () => {
    const html = renderModelStatusCard(I18n, self, status);
    assert.match(html, /i18n:account\.detail\.modelStatus\.available/);
    assert.match(html, /i18n:account\.detail\.modelStatus\.blocked/);
    assert.match(html, /i18n:account\.detail\.modelStatus\.notEntitled/);
    assert.match(html, /i18n:account\.detail\.modelStatus\.unknown/);
    assert.match(html, /claude-sonnet-4\.6/);
    assert.match(html, /gpt-5\.5-medium/);
    assert.match(html, /mystery-model/);
    assert.match(html, /i18n:account\.detail\.modelStatus\.attention/);
    assert.match(html, /i18n:account\.detail\.modelStatus\.rateTable/);
  });

  it('says all-entitled only when nothing needs attention', () => {
    const html = renderModelStatusCard(I18n, self, {
      ...status,
      counts: { ...status.counts, total: 2, available: 2, blocked: 0, notEntitled: 0, unknown: 0 },
      attention: [],
    });
    assert.match(html, /i18n:account\.detail\.modelStatus\.allEntitled\|2/);
    assert.doesNotMatch(html, /modelStatus\.attention/);
  });

  it('renders the never-probed empty state', () => {
    const html = renderModelStatusCard(I18n, self, {
      counts: { total: 0, available: 0, blocked: 0, notEntitled: 0, unknown: 0 },
      attention: [],
      source: { probed: false, rateTable: false },
    });
    assert.match(html, /i18n:account\.detail\.modelStatus\.noneProbed/);
    assert.match(html, /i18n:account\.detail\.modelStatus\.rateTableMissing/);
  });

  it('escapes a hostile model id', () => {
    const html = renderModelStatusCard(I18n, self, {
      counts: { total: 1, available: 0, blocked: 0, notEntitled: 0, unknown: 1 },
      attention: [{ id: '<img src=x>', status: 'unknown' }],
      source: {},
    });
    assert.doesNotMatch(html, /<img/);
  });
});

describe('key card', () => {
  it('renders the masked key, the never-rotated state, and auto-refresh state', () => {
    const html = renderKeyCard(I18n, self, {
      masked: 'abcd1234...wxyz',
      createdAt: 1_700_000_000_000,
      rotatedAt: null,
      lastProbed: 1_700_000_100_000,
      hasRefreshToken: true,
      expires: { known: false, reason: 'not_observable' },
    }, 'acct-id-1');
    assert.match(html, /abcd1234\.\.\.wxyz/);
    assert.match(html, /i18n:account\.detail\.key\.neverRotated/);
    assert.match(html, /i18n:account\.detail\.key\.notObservable/);
    assert.match(html, /i18n:account\.detail\.key\.autoRefreshOn/);
  });

  it('does not duplicate the re-login action the drawer footer owns', () => {
    // The card used to carry its own 重新登录 button while the drawer footer had
    // one too — two entry points for the same modal. The footer is the only one.
    const html = renderKeyCard(I18n, self, { masked: 'a...z' }, 'acct-id-1');
    assert.doesNotMatch(html, /App\.reloginAccount\(/);
  });

  it('renders a stamped rotation time', () => {
    const html = renderKeyCard(I18n, self, { masked: 'a...z', rotatedAt: 1_700_000_000_000 }, 'id');
    assert.doesNotMatch(html, /neverRotated/);
  });
});

describe('preflight card', () => {
  const account = { id: 'acct-1', tierModels: ['gemini-2.5-flash', 'blocked-model'], blockedModels: ['blocked-model'] };

  it('is idle before the first run', () => {
    const html = renderPreflightCard(I18n, self, account, null);
    assert.match(html, /i18n:account\.detail\.preflight\.idle/);
    assert.match(html, /id="acct-preflight-run"/);
    assert.match(html, /gemini-2\.5-flash/);
    assert.doesNotMatch(html, /blocked-model/);
  });

  it('renders the verdict, selector, messages and pool facts', () => {
    const html = renderPreflightCard(I18n, self, account, {
      ok: true,
      verdict: 'throttled',
      model: 'gemini-2.5-flash',
      selector: 'gemini-2-5-flash',
      local: { state: 'ok', eligible: true, reasons: [], rpmHeadroom: 19, rpmLimit: 20 },
      upstream: { state: 'limited', messagesRemaining: 0, maxMessages: 40, retryAfterMs: 30_000, unlimited: false },
      pool: { entitled: true, freeNow: false },
      cached: true,
      fetchedAt: 1_700_000_000_000,
    });
    assert.match(html, /i18n:account\.detail\.preflight\.verdictThrottled/);
    assert.match(html, /i18n:account\.detail\.preflight\.stateLimited/);
    assert.match(html, /gemini-2-5-flash/);
    assert.match(html, /30s/, 'retryAfterMs must render as seconds');
    assert.match(html, /i18n:account\.detail\.preflight\.cached/);
  });

  it('says not-in-catalog when the model did not resolve to a selector', () => {
    const html = renderPreflightCard(I18n, self, account, {
      ok: true,
      verdict: 'unknown',
      model: 'made-up-model',
      selector: null,
      local: { state: 'ok', eligible: true, reasons: [] },
      upstream: { state: 'unknown', error: 'upstream_unreachable' },
      pool: {},
      cached: false,
      fetchedAt: 1,
    });
    assert.match(html, /i18n:account\.detail\.preflight\.unresolved/);
    assert.match(html, /i18n:account\.detail\.preflight\.verdictUnknown/);
  });

  it('does not claim unlimited messages when the upstream probe failed', () => {
    const html = renderPreflightCard(I18n, self, account, {
      ok: true,
      verdict: 'unknown',
      model: '',
      selector: null,
      local: { state: 'ok', eligible: true, reasons: [] },
      upstream: { state: 'unknown', unlimited: false, error: 'upstream_unreachable' },
      pool: {},
      fetchedAt: 1,
    });
    assert.doesNotMatch(html, /i18n:account\.detail\.preflight\.unlimited/);
  });

  it('renders local block reasons', () => {
    const html = renderPreflightCard(I18n, self, account, {
      ok: true,
      verdict: 'blocked',
      model: 'gemini-2.5-flash',
      selector: 'gemini-2-5-flash',
      local: { state: 'rate_limited', eligible: false, reasons: ['rate_limited'] },
      upstream: { state: 'ok' },
      pool: {},
      fetchedAt: 1,
    });
    assert.match(html, /i18n:account\.detail\.preflight\.reasonRate/);
    assert.match(html, /i18n:account\.detail\.preflight\.verdictBlocked/);
  });
});

describe('request history card', () => {
  const payload = {
    ok: true,
    total: 2,
    capacity: 100,
    summary: { requests: 2, promptTokens: 14, completionTokens: 26, totalTokens: 40, credit: 1.5, acu: 0.5, lastTs: 1_700_000_100_000 },
    items: [
      { ts: 1_700_000_100_000, model: 'gemini-2.5-flash', promptTokens: 10, completionTokens: 20, totalTokens: 30, credit: 1, acu: 0.25 },
      { ts: 1_700_000_000_000, model: 'claude-sonnet-4', promptTokens: 4, completionTokens: 6, totalTokens: 10, credit: 0.5, acu: 0.25 },
    ],
  };

  it('renders window totals and one row per request, newest first', () => {
    const html = renderRequestHistoryCard(I18n, self, payload, 'acct-1');
    assert.match(html, /i18n:account\.detail\.requests\.title/);
    assert.match(html, /i18n:account\.detail\.requests\.window\|2/, 'the window badge must name the ring total');
    assert.match(html, /i18n:account\.detail\.requests\.shown\|2/);
    assert.equal((html.match(/class="dm-req-row"/g) || []).length, 2);
    assert.ok(html.indexOf('gemini-2.5-flash') < html.indexOf('claude-sonnet-4'),
      'rows must be newest-first as served');
    assert.match(html, /1,?\.?5|1\.5/, 'the credit total must render');
  });

  it('renders a failed attempt as a zero-cost verdict and splits the counts', () => {
    const html = renderRequestHistoryCard(I18n, self, {
      ...payload,
      total: 3,
      billed: 2,
      failed: 1,
      items: [
        { ts: 1_700_000_200_000, model: 'swe-2', billed: false, outcome: 'rate_limited', status: 429, totalTokens: 0, credit: 0, acu: 0 },
        ...payload.items,
      ],
    }, 'acct-1');
    assert.match(html, /dm-stat-value">2<\/span><span class="dm-stat-label">i18n:account\.detail\.requests\.billed/);
    assert.match(html, /dm-stat-value">1<\/span><span class="dm-stat-label">i18n:account\.detail\.requests\.failed/);
    assert.match(html, /i18n:account\.detail\.requests\.shown\|3/);
    assert.equal((html.match(/class="dm-req-row/g) || []).length, 3);
    assert.equal((html.match(/dm-req-row is-failed/g) || []).length, 1);
    assert.match(html, /429 · rate_limited/, 'the verdict must ride the row title');
    // The failed row must not render a zeroed token/credit pair that would read
    // as a free successful call; it renders a dash plus the localized label.
    assert.match(html, /—<\/span>\s*<span class="dm-req-num is-credit" style="color:\s*var\(--warn-text\)">i18n:account\.detail\.requests\.failed/);
  });

  it('escapes a hostile model name from the upstream', () => {
    const html = renderRequestHistoryCard(I18n, self, {
      ...payload,
      items: [{ ts: 1, model: '<img src=x onerror=alert(1)>', totalTokens: 1, credit: 0 }],
    }, 'acct-1');
    assert.equal(html.includes('<img src=x'), false, 'the model name must never become markup');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('renders the empty state rather than a zeroed table', () => {
    const html = renderRequestHistoryCard(I18n, self, { ok: true, total: 0, capacity: 100, summary: { requests: 0 }, items: [] }, 'acct-1');
    assert.match(html, /i18n:account\.detail\.requests\.empty/);
    assert.equal((html.match(/class="dm-req-row"/g) || []).length, 0);
  });

  it('renders a retry state when the read failed', () => {
    const html = renderRequestHistoryCard(I18n, self, { ok: false, error: 'boom' }, 'acct-1');
    assert.match(html, /i18n:account\.detail\.requests\.loadFailed/);
    assert.match(html, /App\.refreshAccountRequests\('acct-1'\)/);
    assert.doesNotMatch(html, /dm-req-row/);
  });

  it('escapes the account id in the refresh action', () => {
    const html = renderRequestHistoryCard(I18n, self, payload, "x'); alert(1); //");
    assert.equal(html.includes("x');"), false, 'the raw quote must never close the onclick string');
    assert.equal(html.includes("x\\');"), true, 'the quote must be backslash-escaped');
  });
});

describe('missing card payload', () => {
  it('renders an explicit unavailable note instead of fabricated zeros', () => {
    for (const [fn, args] of [
      [renderLedgerCard, []],
      [renderModelStatusCard, []],
      [renderKeyCard, [undefined, 'id']],
      [renderRequestHistoryCard, [undefined, 'id']],
    ]) {
      const html = fn(I18n, self, ...args);
      assert.match(html, /i18n:account\.detail\.cardsUnavailable/);
      assert.doesNotMatch(html, /dm-stat-value">0</, 'a failed fetch must never render a zero');
    }
  });
});

describe('the cards are wired into the drawer, not merely defined', () => {
  it('renderAccountDetail renders all five cards', () => {
    const body = methodBody('renderAccountDetail');
    assert.match(body, /this\.renderLedgerCard\(cards\?\.ledger\)/);
    assert.match(body, /this\.renderRequestHistoryCard\(this\._requestsByAccount\?\.get\(a\.id\), a\.id\)/);
    assert.match(body, /this\.renderModelStatusCard\(cards\?\.modelStatus\)/);
    assert.match(body, /this\.renderKeyCard\(cards\?\.key, a\.id\)/);
    assert.match(body, /this\.renderPreflightCard\(a, this\._preflightByAccount\?\.get\(a\.id\)\)/);
  });

  it('the drawer fetches the card payload and passes it to the renderer', () => {
    const open = methodBody('openAccountDrawer');
    assert.match(open, /this\.getAccountCards\(id\)/);
    assert.match(open, /this\.getAccountRequests\(id, \{ force: true \}\)/);
    const render = methodBody('renderAccountDrawer');
    assert.match(render, /this\.renderAccountDetail\(a, this\._cardsByAccount\?\.get\(id\) \|\| null\)/);
  });

  it('a probe re-reads every open-drawer source instead of leaving it stale', () => {
    const body = methodBody('probeAccount');
    assert.match(body, /this\.refreshOpenDrawer\(id\)/);
    const refresh = methodBody('refreshOpenDrawer');
    assert.match(refresh, /this\.getAccountDetail\(id, \{ force: true \}\)/);
    assert.match(refresh, /this\.getAccountCards\(id, \{ force: true \}\)/);
    assert.match(refresh, /this\.getAccountRequests\(id, \{ force: true \}\)/);
  });

  it('the preflight button posts to the new route and stores the result', () => {
    const body = methodBody('runCapacityPreflight');
    assert.match(body, /\/capacity-preflight/);
    assert.match(body, /this\._preflightByAccount\.set\(id, r\)/);
    assert.match(body, /this\.renderAccountDrawer\(id\)/);
  });

  it('a credit refresh invalidates the cached cards', () => {
    const body = methodBody('refreshCredits');
    assert.match(body, /this\._cardsByAccount\?\.delete\(id\)/);
  });
});

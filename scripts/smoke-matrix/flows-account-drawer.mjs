/**
 * Smoke-matrix families: request-history · devin-cards.
 *
 * Both surfaces are per-account drawers that read PROCESS-LOCAL state only
 * (the billed-request ring and the spend/key cards) — no upstream call. They
 * are asserted after one real chat has gone through the pooled account, so the
 * payloads are not vacuously empty.
 */

const ACCOUNT_REF_RE = /^acct-[0-9a-f]{8}$/;
const MASKED_KEY_RE = /^.{8}\.\.\..{4}$/;

/** Read every account id in the pool (full rows carry status + masked key). */
async function listAccounts(http, requireThat) {
  const r = await http('GET', '/dashboard/api/accounts');
  requireThat(r.status === 200, `accounts status ${r.status}`);
  requireThat(Array.isArray(r.json?.accounts), 'accounts array missing');
  return r.json.accounts;
}

export function registerAccountDrawerFlows(ctx) {
  const { http, requireThat, addFlow, state, MATRIX } = ctx;

  // ─── request-history ─────────────────────────────────────────────────
  addFlow('request-history', 'request-history.chat-records-spend', async () => {
    // One real chat, served by the pool (accounts exist by now), so
    // recordAccountSpend writes a ring row for whichever account served it.
    const chat = await http('POST', '/v1/chat/completions', {
      auth: 'api',
      body: { model: MATRIX.models.chat, messages: [{ role: 'user', content: 'record one billed turn' }] },
    });
    requireThat(chat.status === 200, `chat status ${chat.status} error ${chat.json?.error?.message || '?'}`);
    requireThat(chat.json?.choices?.[0]?.message?.content === MATRIX.text, 'chat did not return the scripted text');

    const accounts = await listAccounts(http, requireThat);
    requireThat(accounts.length >= 1, 'pool is empty after login');

    const holders = [];
    for (const account of accounts) {
      const r = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(account.id)}/requests?limit=10`);
      requireThat(r.status === 200 && r.json?.ok === true, `requests status ${r.status} for ${account.id}`);
      requireThat(Array.isArray(r.json.items), 'items array missing');
      requireThat(ACCOUNT_REF_RE.test(String(r.json.accountRef)), `accountRef ${r.json.accountRef}`);
      requireThat(typeof r.json.capacity === 'number' && r.json.capacity > 0, `capacity ${r.json.capacity}`);
      requireThat(r.json.total <= r.json.capacity, `total ${r.json.total} exceeds capacity ${r.json.capacity}`);
      if (r.json.total > 0) holders.push({ id: account.id, payload: r.json });
    }

    requireThat(holders.length === 1, `expected exactly one account to own the billed turn, saw ${holders.length}`);
    const { id, payload } = holders[0];
    const item = payload.items[0];
    requireThat(!!item && typeof item === 'object', 'newest row missing');
    requireThat(typeof item.ts === 'number' && item.ts > 0, `row ts ${item.ts}`);
    requireThat(typeof item.model === 'string', `row model ${typeof item.model}`);
    requireThat(item.promptTokens === 11, `promptTokens ${item.promptTokens}`);
    requireThat(item.completionTokens === 7, `completionTokens ${item.completionTokens}`);
    requireThat(item.totalTokens === 18, `totalTokens ${item.totalTokens}`);
    requireThat(typeof item.credit === 'number' && item.credit >= 0, `credit ${item.credit}`);
    requireThat(typeof item.acu === 'number' && item.acu >= 0, `acu ${item.acu}`);
    requireThat(payload.total === payload.items.length, `total ${payload.total} vs page ${payload.items.length}`);
    requireThat(payload.summary?.requests === payload.total, `summary.requests ${payload.summary?.requests}`);
    requireThat(payload.summary?.totalTokens === 18 * payload.total, `summary.totalTokens ${payload.summary?.totalTokens}`);
    requireThat(payload.summary?.promptTokens === 11 * payload.total, `summary.promptTokens ${payload.summary?.promptTokens}`);
    requireThat(payload.summary?.completionTokens === 7 * payload.total, `summary.completionTokens ${payload.summary?.completionTokens}`);
    requireThat(payload.summary?.lastTs >= item.ts, 'summary.lastTs is older than the newest row');

    state.spendAccountId = id;
    return `${payload.total} row(s) on ${id}, ${payload.summary.totalTokens} tokens`;
  });

  addFlow('request-history', 'request-history.paging-and-404', async () => {
    requireThat(!!state.spendAccountId, 'no serving account recorded by the previous flow');
    const full = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(state.spendAccountId)}/requests?limit=10`);
    requireThat(full.status === 200, `full status ${full.status}`);

    const one = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(state.spendAccountId)}/requests?limit=1`);
    requireThat(one.status === 200 && one.json?.ok === true, `limit=1 status ${one.status}`);
    requireThat(one.json.items.length === 1, `limit=1 returned ${one.json.items.length} rows`);
    requireThat(one.json.total === full.json.total, `limit=1 changed total (${one.json.total} vs ${full.json.total})`);

    const junk = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(state.spendAccountId)}/requests?limit=not-a-number`);
    requireThat(junk.status === 200, `junk limit status ${junk.status}`);
    requireThat(junk.json.total === full.json.total, 'junk limit changed total');
    requireThat(junk.json.items.length <= junk.json.capacity, 'junk limit exceeded capacity');

    // Newest-first: every adjacent pair is non-increasing.
    for (let i = 1; i < full.json.items.length; i++) {
      requireThat(full.json.items[i - 1].ts >= full.json.items[i].ts, 'rows are not newest-first');
    }

    const missing = await http('GET', '/dashboard/api/accounts/deadbeef/requests');
    requireThat(missing.status === 404, `unknown account status ${missing.status}`);
    requireThat(!full.text.includes(MATRIX.reauthToken), 'a session token leaked into the history payload');
    return 'limit clamps to the ring total; unknown account 404';
  });

  // ─── devin-cards ─────────────────────────────────────────────────────
  addFlow('devin-cards', 'devin-cards.ledger-reflects-spend', async () => {
    requireThat(!!state.spendAccountId, 'no serving account recorded by the history flow');
    const r = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(state.spendAccountId)}/devin-cards`);
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status}`);
    requireThat(ACCOUNT_REF_RE.test(String(r.json.accountRef)), `accountRef ${r.json.accountRef}`);

    const ledger = r.json.ledger || {};
    requireThat(ledger.accountRef === r.json.accountRef, 'ledger card lost the accountRef');
    requireThat(typeof ledger.lifetime === 'object', 'ledger.lifetime missing');
    requireThat(ledger.lifetime.requests >= 1, `lifetime.requests ${ledger.lifetime.requests}`);
    requireThat(ledger.lifetime.totalTokens >= 18, `lifetime.totalTokens ${ledger.lifetime.totalTokens}`);
    // The chat wire carries no per-turn billing tag, so ACU stays explicitly
    // "not observable" rather than a fabricated zero.
    requireThat(ledger.acu?.known === false, `acu.known ${ledger.acu?.known}`);
    requireThat(ledger.acu?.value === null, `acu.value ${ledger.acu?.value}`);
    requireThat(ledger.acu?.reason === 'no_billing_tag', `acu.reason ${ledger.acu?.reason}`);

    const modelStatus = r.json.modelStatus || {};
    requireThat(modelStatus.accountRef === r.json.accountRef, 'modelStatus card lost the accountRef');
    requireThat(typeof modelStatus.counts === 'object', 'modelStatus.counts missing');
    requireThat(Array.isArray(modelStatus.rows), 'modelStatus.rows missing');

    const key = r.json.key || {};
    requireThat(key.accountRef === r.json.accountRef, 'key card lost the accountRef');
    requireThat(key.state === 'ok', `key.state ${key.state}`);
    requireThat(key.reauth?.required === false, 'healthy account reports a reauth requirement');
    requireThat(key.rotation === 'relogin', `key.rotation ${key.rotation}`);
    requireThat(key.expires?.known === false, 'session key claims a known expiry');
    return `ledger ${ledger.lifetime.requests} req / ${ledger.lifetime.totalTokens} tok, ACU not observable`;
  });

  addFlow('devin-cards', 'devin-cards.key-card-is-masked', async () => {
    requireThat(!!state.spendAccountId, 'no serving account recorded by the history flow');
    const r = await http('GET', `/dashboard/api/accounts/${encodeURIComponent(state.spendAccountId)}/devin-cards`);
    requireThat(r.status === 200, `status ${r.status}`);
    const key = r.json.key || {};
    requireThat(typeof key.masked === 'string' && key.masked.length > 0, 'key.masked missing');
    requireThat(MASKED_KEY_RE.test(key.masked), `key.masked is not the documented mask shape: ${key.masked}`);
    requireThat(typeof key.method === 'string' && key.method.length > 0, 'key.method missing');
    requireThat(key.createdAt > 0, `key.createdAt ${key.createdAt}`);
    requireThat(typeof key.hasRefreshToken === 'boolean', 'key.hasRefreshToken missing');
    for (const secret of [MATRIX.importToken, MATRIX.loginImportToken, MATRIX.loginImportTokenDeep]) {
      requireThat(!r.text.includes(secret), 'a raw session token reached the cards payload');
    }
    const missing = await http('GET', '/dashboard/api/accounts/deadbeef/devin-cards');
    requireThat(missing.status === 404, `unknown account status ${missing.status}`);
    requireThat(missing.json?.ok === false && missing.json?.error === 'account_not_found', `unknown payload ${JSON.stringify(missing.json)}`);
    return `masked ${key.masked}, unknown account 404`;
  });
}

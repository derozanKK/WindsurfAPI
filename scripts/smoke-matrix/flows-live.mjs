/**
 * Smoke-matrix families: dashboard-live · acp · i18n.
 *
 * dashboard-live is the second dashboard pass, after accounts exist and after
 * all four protocol fronts have served traffic: usage/billing reads, model
 * reconciliation, the live catalog diff, the account list and the request ring
 * can only be asserted once there is something to read.
 *
 * acp flips the runtime backend switch (the same hot-swap the dashboard exposes)
 * and runs the REAL ACP runner against a fake `devin acp` stdio server.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function registerLiveFlows(ctx) {
  const { http, requireThat, addFlow, state, waitFor, MATRIX, deps } = ctx;

  // ─── dashboard-live ──────────────────────────────────────────────────
  addFlow('dashboard-live', 'dashboard-live.accounts-and-pool', async () => {
    const r = await http('GET', '/dashboard/api/accounts');
    requireThat(r.status === 200 && Array.isArray(r.json?.accounts), `status ${r.status}`);
    const ids = r.json.accounts.map((a) => a.id);
    for (const key of ['emailAccountId', 'tokenAccountId', 'passwordAccountId', 'otpAccountId']) {
      requireThat(ids.includes(state[key]), `${key} (${state[key]}) missing from the list`);
    }
    requireThat(!r.text.includes(MATRIX.sessionTokenPassword), 'password session token in the account list');
    requireThat(!r.text.includes(MATRIX.otpKey), 'OTP key in the account list');
    const pool = await http('GET', '/dashboard/api/pool-events');
    requireThat(pool.status === 200 && pool.json.accounts.length >= 4, `pool rows ${pool.json?.accounts?.length}`);
    requireThat(pool.json.accounts.every((a) => typeof a.state === 'string'), 'pool row lacks state');
    return `${ids.length} accounts listed, ${pool.json.accounts.length} pool rows`;
  });

  addFlow('dashboard-live', 'dashboard-live.catalog-diff', async () => {
    const synced = await waitFor(() => deps.getLiveCatalog().length > 0);
    requireThat(synced, 'live catalog never synced through the scripted GetCliModelConfigs transport');
    const r = await http('GET', '/dashboard/api/models/catalog');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(r.json?.synced === true, 'catalog reported unsynced');
    requireThat(r.json.liveCount >= 1, `liveCount ${r.json.liveCount}`);
    requireThat(r.json.snapshotCount > 0, `snapshotCount ${r.json.snapshotCount}`);
    requireThat(r.json.added.includes(ctx.SMOKE.liveSelector), 'live-only selector missing from added[]');
    return `live ${r.json.liveCount} vs snapshot ${r.json.snapshotCount}`;
  });

  addFlow('dashboard-live', 'dashboard-live.usage-and-billing', async () => {
    const account = encodeURIComponent(state.tokenAccountId);
    const usage = await http('GET', `/dashboard/api/usage?account=${account}&refresh=1`);
    requireThat(usage.status === 200 && usage.json?.ok === true, `usage status ${usage.status} error ${usage.json?.error || '?'}`);
    requireThat(usage.json.plan === 'pro', `plan ${usage.json.plan}`);
    requireThat(usage.json.availableCredits === 1234, `availableCredits ${usage.json.availableCredits}`);
    requireThat(usage.json.quota?.dailyPercentage === 42.5, `daily ${usage.json.quota?.dailyPercentage}`);
    const health = await http('GET', `/dashboard/api/billing/health?account=${account}&refresh=1`);
    requireThat(health.status === 200 && health.json?.ok === true, `health status ${health.status}`);
    return 'usage + billing health normalized from the fake app.devin.ai';
  });

  addFlow('dashboard-live', 'dashboard-live.model-reconcile', async () => {
    const account = encodeURIComponent(state.tokenAccountId);
    const r = await http('GET', `/dashboard/api/models/reconcile?account=${account}&refresh=1`);
    requireThat(r.status === 200 && r.json?.ok === true, `status ${r.status} error ${r.json?.error || '?'}`);
    requireThat(typeof r.json?.sources === 'object', 'sources missing');
    requireThat(r.json.partial === false, `a source degraded: ${JSON.stringify(r.json.degraded)}`);
    requireThat(typeof r.json.localCount === 'number' && r.json.localCount > 0, `localCount ${r.json.localCount}`);
    requireThat(typeof r.json.liveCount === 'number', `liveCount ${r.json.liveCount}`);
    requireThat(typeof r.json.toggleable === 'object' && typeof r.json.toggleable.total === 'number', 'toggleable summary missing');
    return `local ${r.json.localCount} vs live ${r.json.liveCount}, no degraded source`;
  });

  addFlow('dashboard-live', 'dashboard-live.request-ring', async () => {
    const r = await http('GET', '/dashboard/api/requests?limit=50');
    requireThat(r.status === 200 && Array.isArray(r.json?.items), `status ${r.status}`);
    const protocols = new Set(r.json.items.map((row) => row.protocol).filter(Boolean));
    for (const protocol of ['openai', 'messages', 'responses', 'gemini']) {
      requireThat(protocols.has(protocol), `no ring row for the ${protocol} front (saw ${[...protocols].join(',')})`);
    }
    requireThat(r.json.items.every((row) => typeof row.caller !== 'string' || !row.caller.includes(MATRIX.connectToken)), 'raw caller token in the ring');
    const stats = await http('GET', '/dashboard/api/stats');
    requireThat(stats.status === 200 && stats.json.totalRequests > 0, `stats totalRequests ${stats.json?.totalRequests}`);
    return `${r.json.items.length} rows across ${protocols.size} protocols`;
  });

  // ─── acp ─────────────────────────────────────────────────────────────
  async function armAcp() {
    process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND = 'devin-cli';
    process.env.DEVIN_CLI_MODE = 'acp';
    process.env.DEVIN_ACP_PROBE = '1';
    // The entitlement filter in getApiKey reads the account tier; make the
    // account explicitly paid so the ACP checkout does not reject the model.
    await http('PATCH', `/dashboard/api/accounts/${encodeURIComponent(state.tokenAccountId)}`, {
      body: { tier: 'pro' },
    });
    const flipped = await http('PUT', '/dashboard/api/runtime-env-status', {
      body: { devinConnect: false, devinCliMode: 'acp' },
    });
    requireThat(flipped.status === 200 && flipped.json?.success === true, `backend flip status ${flipped.status}`);
    requireThat(flipped.json?.switches?.devinConnect?.value === false, 'devinConnect did not flip off');
    requireThat(flipped.json?.switches?.devinCliMode?.value === 'acp', 'devinCliMode did not flip to acp');
  }

  addFlow('acp', 'acp.chat', async () => {
    await armAcp();
    const r = await http('POST', '/v1/chat/completions', {
      auth: 'api',
      body: { model: MATRIX.models.acp, messages: [{ role: 'user', content: 'run through acp' }] },
    });
    requireThat(r.status === 200, `status ${r.status} error ${JSON.stringify(r.json?.error)}`);
    const content = String(r.json?.choices?.[0]?.message?.content || '');
    requireThat(content.includes(MATRIX.acpReply), `ACP reply missing from ${JSON.stringify(content)}`);
    requireThat(content.includes('auth=present'), 'pool credential did not reach the ACP authenticate frame');
    requireThat(!content.includes('internal reasoning'), 'agent_thought_chunk leaked into the visible reply');
    requireThat(r.json?.model === MATRIX.models.acp, `model echo ${r.json?.model}`);
    requireThat(r.json?.usage?.total_tokens > 0, 'usage missing on the ACP response');
    return 'real ACP runner served the reply with the pooled credential';
  });

  addFlow('acp', 'acp.stream', async () => {
    const r = await http('POST', '/v1/chat/completions', {
      auth: 'api',
      body: { model: MATRIX.models.acp, messages: [{ role: 'user', content: 'stream through acp' }], stream: true },
    });
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(/text\/event-stream/i.test(r.contentType), `content-type ${r.contentType}`);
    requireThat(r.text.includes(MATRIX.acpReply), 'ACP reply missing from the stream');
    requireThat(r.text.includes('"object":"chat.completion.chunk"'), 'no completion chunk');
    requireThat(r.text.includes('"finish_reason":"stop"'), 'no finish frame');
    requireThat(r.text.trimEnd().endsWith('data: [DONE]'), 'stream does not end with [DONE]');
    return 'buffered ACP SSE re-framed as a valid OpenAI stream';
  });

  addFlow('acp', 'acp.failure-mapping', async () => {
    const r = await http('POST', '/v1/chat/completions', {
      auth: 'api',
      body: {
        model: MATRIX.models.acp,
        messages: [{ role: 'user', content: `fail please ${MATRIX.marker.fail}` }],
      },
    });
    requireThat(r.status === 429, `status ${r.status}`);
    requireThat(r.json?.error?.backend === 'devin-cli', `backend ${r.json?.error?.backend}`);
    requireThat(/overload/i.test(String(r.json?.error?.message)), `message ${r.json?.error?.message}`);
    return 'ACP overload → 429 capacity, account not burned';
  });

  addFlow('acp', 'acp.connect-synthesized-rows-hidden', async () => {
    // While devinConnect is off, the dashboard's connect-namespace rows must be
    // absent: `swe-1-6-slow` is not in the MODELS table, it is synthesized only
    // for the connect transport. This is the routing-dependent observable the
    // restore flow re-checks in the other direction.
    const r = await http('GET', '/dashboard/api/models');
    requireThat(r.status === 200, `status ${r.status}`);
    requireThat(!r.json.models.some((m) => m.id === 'swe-1-6-slow'), 'connect-only row served while connect is off');
    return 'connect-only model rows hidden on the ACP transport';
  });

  addFlow('acp', 'acp.restore-connect-backend', async () => {
    const r = await http('PUT', '/dashboard/api/runtime-env-status', { body: { devinConnect: true } });
    requireThat(r.status === 200 && r.json?.success === true, `status ${r.status}`);
    requireThat(r.json?.switches?.devinConnect?.value === true, 'devinConnect did not flip back on');
    requireThat(r.json?.switches?.devinConnect?.source === 'config', 'override source not reported');
    // Prove the transport, not just the switch: the connect-namespace rows
    // reappear only when getBackendSwitch('devinConnect') is true. A live chat
    // request here would queue on the pool (the ACP 429 cooled an account), so
    // the routing observable is the right instrument.
    const models = await http('GET', '/dashboard/api/models');
    requireThat(models.status === 200, `models status ${models.status}`);
    const row = models.json.models.find((m) => m.id === 'swe-1-6-slow');
    requireThat(!!row, 'connect-only row did not return after the restore');
    requireThat(row.connectSelector === 'swe-1-6-slow', `connectSelector ${row.connectSelector}`);
    delete process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND;
    delete process.env.DEVIN_CLI_MODE;
    return 'hot-swap back to connect; connect-namespace rows restored';
  });

  // ─── i18n ────────────────────────────────────────────────────────────
  addFlow('i18n', 'i18n.locale-parity', async () => {
    const dir = fileURLToPath(new URL('../../src/dashboard/i18n', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    requireThat(files.length >= 2, `only ${files.length} locale files`);
    const flatten = (obj, prefix = '', out = {}) => {
      for (const [key, value] of Object.entries(obj || {})) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
        else out[path] = value;
      }
      return out;
    };
    const locales = new Map();
    for (const file of files) {
      const r = await http('GET', `/dashboard/i18n/${file}`, { auth: 'none' });
      requireThat(r.status === 200, `${file} status ${r.status}`);
      requireThat(r.json && typeof r.json === 'object', `${file} is not an object`);
      locales.set(file, flatten(r.json));
    }
    const [baseFile, baseKeys] = [...locales.entries()][0];
    const base = new Set(Object.keys(baseKeys));
    requireThat(base.size > 100, `${baseFile} only has ${base.size} keys`);
    for (const [file, keys] of locales) {
      const own = new Set(Object.keys(keys));
      const missing = [...base].filter((k) => !own.has(k));
      const extra = [...own].filter((k) => !base.has(k));
      requireThat(missing.length === 0, `${file} is missing ${missing.length} keys (e.g. ${missing.slice(0, 3).join(', ')})`);
      requireThat(extra.length === 0, `${file} has ${extra.length} keys absent from ${baseFile} (e.g. ${extra.slice(0, 3).join(', ')})`);
      for (const key of ['nav.overview', 'emailLogin.methodEmailCode', 'emailLogin.methodPassword']) {
        requireThat(typeof keys[key] === 'string' && keys[key].trim(), `${file} has no value for ${key}`);
      }
    }
    const en = locales.get('en.json');
    const zh = locales.get('zh-CN.json');
    requireThat(en && zh, 'en.json / zh-CN.json pair missing');
    requireThat(en['nav.overview'] !== zh['nav.overview'], 'zh-CN is untranslated for nav.overview');
    return `${files.length} locales, ${base.size} keys each, zh-CN translated`;
  });
}

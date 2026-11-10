import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ReadError,
  accountRef,
  cacheKey,
  peekCached,
  readCached,
  readDevinJson,
  redactUpstreamText,
  resolveOrgId,
  __resetReadCache,
  __setFetchImplForTest,
  __setNowForTest,
} from '../src/dashboard/devin-read.js';

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => (typeof value === 'string' ? value : JSON.stringify(value)),
  };
}

function errorResponse(status) {
  return jsonResponse({ detail: 'nope' }, { status });
}

const originalOrg = process.env.DEVIN_BACKEND_ORG_ID;

afterEach(() => {
  __setFetchImplForTest(null);
  __setNowForTest(null);
  __resetReadCache();
  if (originalOrg === undefined) delete process.env.DEVIN_BACKEND_ORG_ID;
  else process.env.DEVIN_BACKEND_ORG_ID = originalOrg;
});

describe('readDevinJson', () => {
  it('is GET-only: no method/body parameter, redirect blocked, no Content-Type', async () => {
    const calls = [];
    const out = await readDevinJson({
      token: 'tok',
      path: '/org-abc123/billing/status',
      orgId: 'org-abc123',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ plan_slug: 'pro' });
      },
    });
    assert.equal(out.plan_slug, 'pro');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal('body' in calls[0].init, false);
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
    assert.equal(calls[0].init.headers.Accept, 'application/json');
    assert.match(calls[0].init.headers['User-Agent'], /^WindsurfAPI\//);
    assert.equal(calls[0].init.headers['x-cog-org-id'], 'org-abc123');
    assert.equal('Content-Type' in calls[0].init.headers, false);
    assert.equal(calls[0].url, 'https://app.devin.ai/api/org-abc123/billing/status');
  });

  it('omits x-cog-org-id on global paths', async () => {
    let seen;
    await readDevinJson({
      token: 'tok',
      path: '/users/spending-state',
      fetchImpl: async (url, init) => { seen = init; return jsonResponse({ state: 'active' }); },
    });
    assert.equal('x-cog-org-id' in seen.headers, false);
  });

  it('rejects absolute URLs, protocol-relative paths and header injection before fetch', async () => {
    let called = 0;
    const fetchImpl = async () => { called++; return jsonResponse({}); };
    for (const path of ['https://evil.test/x', '//evil.test/x', '/x\r\nHost: evil', 'x/no-leading-slash']) {
      await assert.rejects(
        readDevinJson({ token: 'tok', path, fetchImpl }),
        (err) => err instanceof ReadError && err.kind === 'bad_path',
        `path ${JSON.stringify(path)} must be rejected`,
      );
    }
    assert.equal(called, 0, 'no fetch may happen for a bad path');
  });

  it('maps upstream statuses to error kinds', async () => {
    const cases = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [429, 'rate_limited'],
      [500, 'upstream'],
      [302, 'redirect_blocked'],
    ];
    for (const [status, kind] of cases) {
      await assert.rejects(
        readDevinJson({ token: 'tok', path: '/x', fetchImpl: async () => errorResponse(status) }),
        (err) => err instanceof ReadError && err.kind === kind && err.status === status,
        `status ${status}`,
      );
    }
  });

  it('maps timeout, malformed and too-large bodies', async () => {
    await assert.rejects(
      readDevinJson({
        token: 'tok',
        path: '/x',
        fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
      }),
      (err) => err.kind === 'timeout',
    );
    await assert.rejects(
      readDevinJson({ token: 'tok', path: '/x', fetchImpl: async () => jsonResponse('<html>not json') }),
      (err) => err.kind === 'malformed',
    );
    await assert.rejects(
      readDevinJson({
        token: 'tok',
        path: '/x',
        maxBytes: 8,
        fetchImpl: async () => jsonResponse({ long: 'aaaaaaaaaaaaaaaa' }),
      }),
      (err) => err.kind === 'too_large',
    );
  });

  it('keeps the timeout armed while a streamed body is read', async () => {
    let signal;
    await assert.rejects(
      readDevinJson({
        token: 'tok',
        path: '/x',
        timeoutMs: 20,
        fetchImpl: async (_url, init) => {
          signal = init.signal;
          return new Response(new ReadableStream({
            start(controller) {
              const timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('{}'));
                controller.close();
              }, 120);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              }, { once: true });
            },
          }));
        },
      }),
      (err) => err.kind === 'timeout',
    );
    assert.equal(signal.aborted, true);
  });

  it('aborts an oversized streamed body before reading all of it', async () => {
    let chunks = 0;
    await assert.rejects(
      readDevinJson({
        token: 'tok',
        path: '/x',
        maxBytes: 32,
        fetchImpl: async () => new Response(new ReadableStream({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(16).fill(97));
            if (chunks === 8) controller.close();
          },
        }, { highWaterMark: 0 })),
      }),
      (err) => err.kind === 'too_large',
    );
    assert.ok(chunks <= 3, `read ${chunks} chunks before enforcing the cap`);
  });

  it('requires a token and a valid org header when one is supplied', async () => {
    await assert.rejects(readDevinJson({ token: '', path: '/x' }), (err) => err.kind === 'no_account');
    await assert.rejects(
      readDevinJson({ token: 'tok', path: '/x', orgId: 'not-an-org' }),
      (err) => err.kind === 'bad_org',
    );
  });
});

describe('resolveOrgId', () => {
  it('uses GET /users/current-membership first, never post-auth', async () => {
    const calls = [];
    const org = await resolveOrgId({
      token: 'tok',
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method });
        if (url.endsWith('/users/current-membership')) {
          return jsonResponse({ org: { org_id: 'org-primary1' }, user: { email: 'x@example.test' } });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(org, 'org-primary1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls.every((c) => !c.url.includes('/users/post-auth')));
  });

  it('falls back to GET /organizations and picks the primary org', async () => {
    const calls = [];
    const org = await resolveOrgId({
      token: 'tok',
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith('/users/current-membership')) return errorResponse(404);
        if (url.endsWith('/organizations')) {
          return jsonResponse([{ org_id: 'org-a' }, { org_id: 'org-b', is_primary_org: true }]);
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(org, 'org-b');
    assert.deepEqual(calls.map((u) => u.split('/api')[1]), ['/users/current-membership', '/organizations']);
  });

  it('uses the single org when no primary is flagged', async () => {
    const org = await resolveOrgId({
      token: 'tok',
      fetchImpl: async (url) => {
        if (url.endsWith('/users/current-membership')) return jsonResponse({});
        if (url.endsWith('/organizations')) return jsonResponse([{ org_id: 'org-only1' }]);
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.equal(org, 'org-only1');
  });

  it('refuses to guess between multiple orgs with no primary', async () => {
    await assert.rejects(
      resolveOrgId({
        token: 'tok',
        fetchImpl: async (url) => {
          if (url.endsWith('/users/current-membership')) return jsonResponse({});
          if (url.endsWith('/organizations')) return jsonResponse([{ org_id: 'org-a' }, { org_id: 'org-b' }]);
          throw new Error(`unexpected ${url}`);
        },
      }),
      (err) => err.kind === 'org_unresolved',
    );
  });

  it('does not fall back when the token itself is rejected', async () => {
    const calls = [];
    await assert.rejects(
      resolveOrgId({
        token: 'tok',
        fetchImpl: async (url) => { calls.push(url); return errorResponse(401); },
      }),
      (err) => err.kind === 'unauthorized',
    );
    assert.equal(calls.length, 1, 'a 401 must not be retried against /organizations');
  });

  it('honours DEVIN_BACKEND_ORG_ID without any fetch', async () => {
    process.env.DEVIN_BACKEND_ORG_ID = 'org-fromenv';
    let called = 0;
    const org = await resolveOrgId({ token: 'tok', fetchImpl: async () => { called++; return jsonResponse({}); } });
    assert.equal(org, 'org-fromenv');
    assert.equal(called, 0);
  });
});

describe('readCached', () => {
  it('serves fresh hits, refetches after TTL, and supports force', async () => {
    let now = 1_000_000;
    __setNowForTest(() => now);
    let loads = 0;
    const load = async () => { loads++; return { n: loads }; };

    const first = await readCached('k', 30_000, load);
    assert.equal(first.cached, false);
    assert.equal(first.value.n, 1);

    now += 29_000;
    const hit = await readCached('k', 30_000, load);
    assert.equal(hit.cached, true);
    assert.equal(hit.value.n, 1);
    assert.equal(loads, 1);

    now += 2_000;
    const miss = await readCached('k', 30_000, load);
    assert.equal(miss.cached, false);
    assert.equal(miss.value.n, 2);

    now += 1_000;
    const forced = await readCached('k', 30_000, load, { force: true });
    assert.equal(forced.cached, false);
    assert.equal(loads, 3);
  });

  it('single-flights concurrent loads', async () => {
    let loads = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const load = async () => { loads++; await gate; return { ok: 1 }; };
    const a = readCached('single', 30_000, load);
    const b = readCached('single', 30_000, load);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(loads, 1);
    assert.equal(ra.value.ok, 1);
    assert.equal(rb.value.ok, 1);
  });

  it('serves the last good value as stale on transient errors, but never on 403', async () => {
    let now = 2_000_000;
    __setNowForTest(() => now);
    await readCached('stale', 30_000, async () => ({ plan: 'pro' }));
    now += 31_000;

    const stale = await readCached('stale', 30_000, async () => {
      throw new ReadError('timeout', { status: null });
    });
    assert.equal(stale.ok, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.value.plan, 'pro');

    const forbidden = await readCached('stale', 30_000, async () => {
      throw new ReadError('forbidden', { status: 403 });
    });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error, 'forbidden');
    assert.equal('value' in forbidden, false);
  });

  it('drops the stale value after the max-stale cap', async () => {
    let now = 3_000_000;
    __setNowForTest(() => now);
    await readCached('old', 30_000, async () => ({ plan: 'pro' }));
    now += 31 * 60_000;
    const out = await readCached('old', 30_000, async () => {
      throw new ReadError('upstream', { status: 502 });
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'upstream');
  });

  it('caps the cache at 200 entries, evicting the oldest insertion', async () => {
    for (let i = 0; i < 201; i += 1) {
      await readCached(`cap-${i}`, 30_000, async () => ({ i }));
    }
    assert.equal(peekCached('cap-0'), null, 'the oldest entry is evicted');
    assert.equal(peekCached('cap-200').value.i, 200);
  });
});

describe('cache keys, peek and redaction', () => {
  it('never uses the raw token as a cache key and accountRef is a hash', () => {
    const token = ['super', 'secret', 'token'].join('-');
    const key = cacheKey({ accountId: 'acct-test', token, name: 'status' });
    assert.equal(key.includes(token), false);
    assert.match(key, /^acct-test:[0-9a-f]{12}:status$/);
    assert.match(accountRef('acct-test'), /^acct-[0-9a-f]{8}$/);
  });

  it('peekCached is read-only and reports freshness', async () => {
    let now = 4_000_000;
    __setNowForTest(() => now);
    assert.equal(peekCached('peek'), null);
    await readCached('peek', 30_000, async () => ({ v: 1 }));
    assert.equal(peekCached('peek').value.v, 1);
    assert.equal(peekCached('peek').stale, false);
    now += 31_000;
    assert.equal(peekCached('peek').stale, true);
  });

  it('redacts credentials, org/user/acct ids and email from free text', () => {
    const raw = 'contact org-test123 / user-test456 / acct_abcdef123 / user@example.test '
      + 'auth1_abcdefgh devin-session-token$abcdef';
    const out = redactUpstreamText(raw);
    for (const secret of ['org-test123', 'user-test456', 'acct_abcdef123', 'user@example.test', 'auth1_abcdefgh', 'devin-session-token$abcdef']) {
      assert.equal(out.includes(secret), false, `must redact ${secret}`);
    }
    assert.ok(redactUpstreamText('x'.repeat(1000)).length <= 200);
  });
});

describe('read-path write scan', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const modules = [
    'devin-read.js',
    'billing-health.js',
    'model-reconcile.js',
    'quota-burn-down.js',
    'usage.js',
    'catalog-diff.js',
    'pool-events.js',
  ];
  const FORBIDDEN = [
    'probePostAuth',
    'saveAccounts',
    'setAccountStatus',
    'refreshCredits',
    'setRuntimeApiKey',
    'setRuntimeDashboardPassword',
    'writeJsonAtomic',
    'writeFileSync',
    "method: 'POST'",
    'method: "POST"',
  ];

  it('never contains a write call, a post-auth probe or a local persistence call', () => {
    for (const name of modules) {
      const source = readFileSync(join(here, '..', 'src', 'dashboard', name), 'utf8');
      for (const token of FORBIDDEN) {
        assert.equal(source.includes(token), false, `${name} must not contain ${token}`);
      }
      assert.equal(source.includes("'/users/post-auth'"), false, `${name} must not call post-auth`);
    }
  });
});

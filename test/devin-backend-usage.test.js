/**
 * H0 dashboard read path: org resolution and GET-only reads.
 *
 * This file used to exercise `getBillingUsage` from the devin-backend stub. The
 * dashboard now owns its read path (`src/dashboard/devin-read.js`) and the stub
 * function is gone; the same wire assertions live here against the new reader.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ReadError,
  readDevinJson,
  resolveOrgId,
  __resetReadCache,
  __setFetchImplForTest,
} from '../src/dashboard/devin-read.js';

function jsonResponse(value, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(value),
  };
}

function errorResponse(status) {
  return jsonResponse({}, { status });
}

const originalOrg = process.env.DEVIN_BACKEND_ORG_ID;

afterEach(() => {
  __setFetchImplForTest(null);
  __resetReadCache();
  if (originalOrg === undefined) delete process.env.DEVIN_BACKEND_ORG_ID;
  else process.env.DEVIN_BACKEND_ORG_ID = originalOrg;
});

describe('dashboard read path org resolution', () => {
  it('resolves the org through GET current-membership, never post-auth', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method });
      if (url.endsWith('/users/current-membership')) return jsonResponse({ org: { org_id: 'org-test' } });
      throw new Error(`unexpected ${url}`);
    };

    const org = await resolveOrgId({ token: 'tok', fetchImpl });
    assert.equal(org, 'org-test');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls.every((c) => !c.url.includes('/users/post-auth')));
    assert.ok(calls.every((c) => c.method === 'GET'));
  });

  it('falls back to GET /organizations and picks the primary org', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith('/users/current-membership')) return errorResponse(404);
      if (url.endsWith('/organizations')) {
        return jsonResponse([{ org_id: 'org-a' }, { org_id: 'org-b', is_primary_org: true }]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const org = await resolveOrgId({ token: 'tok', fetchImpl });
    assert.equal(org, 'org-b');
    assert.equal(calls.length, 2);
    assert.ok(calls.some((url) => url.endsWith('/organizations')));
  });

  it('rejects when neither GET endpoint returns a usable org id', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/users/current-membership')) return errorResponse(404);
      if (url.endsWith('/organizations')) return jsonResponse([]);
      throw new Error(`unexpected ${url}`);
    };
    await assert.rejects(
      resolveOrgId({ token: 'tok', fetchImpl }),
      (err) => err instanceof ReadError && err.kind === 'org_unresolved',
    );
  });

  it('does not fall back when the token is rejected', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return errorResponse(401); };
    await assert.rejects(
      resolveOrgId({ token: 'tok', fetchImpl }),
      (err) => err.kind === 'unauthorized',
    );
    assert.equal(calls.length, 1);
  });

  it('never puts orgId, accountId or keyPrefix in the reader output', async () => {
    const out = await readDevinJson({
      token: 'tok',
      path: '/org-test/billing/status',
      orgId: 'org-test',
      fetchImpl: async () => jsonResponse({ plan_slug: 'pro' }),
    });
    assert.equal(out.orgId, undefined);
    assert.equal(out.accountId, undefined);
    assert.equal(out.keyPrefix, undefined);
    assert.equal(out.plan_slug, 'pro');
  });
});

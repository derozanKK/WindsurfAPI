// P1 (Q7 descriptor audit): PlanStatus.overage_balance_micros is `int64`, and
// proto3 JSON mandates a DECIMAL STRING for 64-bit integers. The decoder used a
// bare `typeof === 'number'` check, so a spec-compliant response
// (`"overageBalanceMicros":"80000000"`) silently lost the on-demand balance
// while the same value as a JSON number worked. These tests drive the real
// getUserStatus → normalizeUserStatus path through the transport hook.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getUserStatus, __setWindsurfApiPostJsonForTest } from '../src/windsurf-api.js';

const respondWith = (planStatus) => async () => ({
  status: 200,
  data: { userStatus: { planStatus } },
  raw: '{}',
});

afterEach(() => __setWindsurfApiPostJsonForTest(null));

describe('GetUserStatus overageBalanceMicros — proto3 int64 JSON encoding', () => {
  it('accepts the spec-compliant string form ("80000000" → $80)', async () => {
    __setWindsurfApiPostJsonForTest(respondWith({
      overageBalanceMicros: '80000000',
      planInfo: { planName: 'Pro' },
    }));
    const out = await getUserStatus('test-key');
    assert.equal(out.overageBalance, 80, 'the int64-as-string form must decode, not vanish');
    assert.equal(out.planName, 'Pro', 'the same response must still normalize normally');
  });

  it('still accepts the numeric form (80000000 → $80)', async () => {
    __setWindsurfApiPostJsonForTest(respondWith({ overageBalanceMicros: 80000000 }));
    const out = await getUserStatus('test-key');
    assert.equal(out.overageBalance, 80);
  });

  it('keeps an explicit zero balance as 0 in both encodings', async () => {
    for (const raw of ['0', 0]) {
      __setWindsurfApiPostJsonForTest(respondWith({ overageBalanceMicros: raw }));
      const out = await getUserStatus('test-key');
      assert.equal(out.overageBalance, 0, `${JSON.stringify(raw)} is a real zero balance, not unknown`);
    }
  });

  it('rejects the uint64 -1 sentinel in both encodings', async () => {
    for (const raw of ['-1', -1]) {
      __setWindsurfApiPostJsonForTest(respondWith({ overageBalanceMicros: raw }));
      const out = await getUserStatus('test-key');
      assert.equal(out.overageBalance, null, `${JSON.stringify(raw)} must stay unknown`);
    }
  });

  it('rejects non-numeric and out-of-range values instead of fabricating a balance', async () => {
    for (const raw of ['abc', '', '   ', 'Infinity', 'NaN', '1e13', 1e13, true, {}]) {
      __setWindsurfApiPostJsonForTest(respondWith({ overageBalanceMicros: raw }));
      const out = await getUserStatus('test-key');
      assert.equal(out.overageBalance, null, `${JSON.stringify(raw)} is not a micro-USD balance`);
    }
  });

  it('keeps an absent field null', async () => {
    __setWindsurfApiPostJsonForTest(respondWith({ planInfo: { planName: 'Free' } }));
    const out = await getUserStatus('test-key');
    assert.equal(out.overageBalance, null);
  });
});

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  __setWindsurfApiPostJsonForTest,
  getUserStatus,
} from '../src/windsurf-api.js';

const USER_STATUS_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';

function stubUserStatus(data) {
  __setWindsurfApiPostJsonForTest(async (host, path) => {
    if (path !== USER_STATUS_PATH) return { status: 404, data: {}, raw: '{}' };
    return { status: 200, data, raw: JSON.stringify(data) };
  });
}

afterEach(() => {
  __setWindsurfApiPostJsonForTest(null);
});

describe('GetUserStatus normalization (cockpit parity)', () => {
  it('extracts email/displayName from userStatus so pasted-token rows can show a real label', async () => {
    stubUserStatus({
      planInfo: { planName: 'PRO', monthlyPromptCredits: 50000 },
      userStatus: {
        email: 'devin.user@example.com',
        name: 'Devin User',
        planStatus: {
          dailyQuotaRemainingPercent: 42,
          weeklyQuotaRemainingPercent: 10,
          dailyQuotaResetAtUnix: 1759123200,
          weeklyQuotaResetAtUnix: 1759728000,
          overageBalanceMicros: -210000,
        },
      },
    });

    const s = await getUserStatus('devin-session-token$abc');
    assert.equal(s.email, 'devin.user@example.com');
    assert.equal(s.displayName, 'Devin User');
    assert.equal(s.planName, 'PRO');
    assert.equal(s.dailyPercent, 42);
    assert.equal(s.weeklyPercent, 10);
    assert.equal(s.dailyUsedPercent, 58);
    assert.equal(s.weeklyUsedPercent, 90);
    assert.equal(s.dailyResetAt, 1759123200);
    assert.equal(s.weeklyResetAt, 1759728000);
    assert.equal(s.overageBalance, -0.21);
    assert.equal(s.prompt.limit, 500);
  });

  it('falls back to weekly quota reset for planEnd when the plan omits it (free accounts)', async () => {
    stubUserStatus({
      planInfo: { planName: 'FREE' },
      userStatus: {
        email: 'free@example.com',
        planStatus: {
          dailyQuotaRemainingPercent: 100,
          weeklyQuotaRemainingPercent: 0,
          dailyQuotaResetAtUnix: 1759123200,
          weeklyQuotaResetAtUnix: 1759728000,
        },
      },
    });

    const s = await getUserStatus('devin-session-token$xyz');
    assert.equal(s.planEnd, 1759728000 * 1000);
    assert.equal(s.dailyUsedPercent, 0);
    assert.equal(s.weeklyUsedPercent, 100);
  });

  it('accepts an explicit planEnd in ISO or seconds form and normalizes to ms', async () => {
    stubUserStatus({
      planInfo: { planName: 'PRO' },
      userStatus: {
        planStatus: {
          planStart: '2026-08-31T16:00:00Z',
          planEnd: '2026-09-30T16:00:00Z',
          dailyQuotaRemainingPercent: 5,
        },
      },
    });

    const s = await getUserStatus('sk-ws-01-key');
    assert.equal(s.planEnd, Date.parse('2026-09-30T16:00:00Z'));
    assert.equal(s.planStart, Date.parse('2026-08-31T16:00:00Z'));
    assert.equal(s.dailyUsedPercent, 95);
  });

  it('keeps the legacy planStatus.planInfo nesting working', async () => {
    stubUserStatus({
      userStatus: {
        planStatus: {
          planInfo: { planName: 'TEAMS', monthlyPromptCredits: 100000 },
          usedPromptCredits: 1000,
          availablePromptCredits: 99000,
        },
      },
    });

    const s = await getUserStatus('legacy-key');
    assert.equal(s.planName, 'TEAMS');
    assert.equal(s.prompt.limit, 1000);
    assert.equal(s.prompt.used, 10);
    assert.equal(s.prompt.remaining, 990);
    assert.equal(s.email, null);
  });
});

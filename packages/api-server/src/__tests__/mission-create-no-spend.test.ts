import { describe, expect, it } from 'vitest';
import { CreateMissionSchema } from '../routes/missions.js';

const base = {
  objective: 'Generate 12 qualified demos with roofing companies in Texas',
  targetDefinition: {},
  qualificationRules: {},
  allowedChannels: ['call', 'email'],
};

describe('POST /api/missions — no spend field required', () => {
  it('accepts a mission with no policy at all and defaults to zero added spend', () => {
    const r = CreateMissionSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.policy.budgetCents).toBe(0);
    expect(r.data.policy.approveBeforePivot).toBe(true);
    expect(r.data.policy.firstTouchOptIn).toBe('manual');
  });

  it('accepts the dashboard payload, which no longer sends budgetCents', () => {
    const r = CreateMissionSchema.safeParse({
      ...base,
      policy: { approveBeforePivot: true, firstTouchOptIn: 'manual', requireApprovalForNewCampaigns: true },
    });
    expect(r.success && r.data.policy.budgetCents).toBe(0);
  });

  it('does not require or accept a mode selector to be chosen', () => {
    const r = CreateMissionSchema.safeParse(base);
    expect(r.success && 'mode' in r.data).toBe(false);
  });

  it('still rejects a negative or fractional budget if one is sent', () => {
    expect(CreateMissionSchema.safeParse({ ...base, policy: { budgetCents: -1 } }).success).toBe(false);
    expect(CreateMissionSchema.safeParse({ ...base, policy: { budgetCents: 1.5 } }).success).toBe(false);
  });
});

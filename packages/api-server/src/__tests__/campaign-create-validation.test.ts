import { describe, expect, it } from 'vitest';
import { campaignValidationErrorBody, createCampaignSchema } from '../routes/campaign-schemas.js';

const base = { name: 'Texas HVAC', industries: ['HVAC'], cities: ['Dallas TX'] };

describe('POST /api/campaigns validation', () => {
  it('accepts the dashboard payload with no spend, budget or mode field', () => {
    const r = createCampaignSchema.safeParse({ ...base, targetLeads: 100, national: false });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.pushToBuildmybot).toBe(false);
      expect(Object.keys(r.data)).not.toEqual(expect.arrayContaining(['budgetCents', 'spendUsd', 'mode']));
    }
  });

  it('defaults targetLeads to 100 when omitted', () => {
    const r = createCampaignSchema.safeParse(base);
    expect(r.success && r.data.targetLeads).toBe(100);
  });

  it('returns a string error plus field details the dashboard can render (not [object Object])', () => {
    const cities = Array.from({ length: 51 }, (_, i) => `City ${i} TX`);
    const r = createCampaignSchema.safeParse({ ...base, cities, targetLeads: 6000 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const body = campaignValidationErrorBody(r.error);
    expect(typeof body.error).toBe('string');
    expect(body.error).toBe('Invalid campaign request');
    expect(body.details.fieldErrors.cities?.[0]).toMatch(/50/);
    expect(body.details.fieldErrors.targetLeads?.[0]).toMatch(/5000/);
    expect(`${body.error}`).not.toContain('[object Object]');
  });

  it('still requires some territory', () => {
    const r = createCampaignSchema.safeParse({ name: 'abc', industries: ['HVAC'] });
    expect(r.success).toBe(false);
  });
});

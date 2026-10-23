import { describe, expect, it } from 'vitest';
import { decideMissionStart, executeMissionTaskTitle, missionExecutionAgent } from '../routes/mission-start.js';

const ok = { goalStatus: 'active', missionStatus: 'validating', validationApprovalStatuses: ['approved'] };

describe('POST /api/missions/:missionId/start gating', () => {
  it('allows a validating mission with an active goal and an approved validation', () => {
    expect(decideMissionStart(ok)).toEqual({ ok: true });
  });

  it('allows start when an older approval was rejected but one is approved', () => {
    expect(decideMissionStart({ ...ok, validationApprovalStatuses: ['rejected', 'approved'] }).ok).toBe(true);
  });

  it.each(['draft', 'running', 'paused', 'budget_exhausted', 'cancelled'])('rejects mission status %s', (missionStatus) => {
    const d = decideMissionStart({ ...ok, missionStatus });
    expect(d.ok).toBe(false);
    if (!d.ok) { expect(d.httpStatus).toBe(400); expect(d.error).toContain(missionStatus); }
  });

  it.each(['paused', 'cancelled', 'completed'])('rejects goal status %s', (goalStatus) => {
    const d = decideMissionStart({ ...ok, goalStatus });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toMatch(/goal is not active/);
  });

  it('rejects when the validation approval is still pending', () => {
    const d = decideMissionStart({ ...ok, validationApprovalStatuses: ['pending'] });
    expect(d).toMatchObject({ ok: false, httpStatus: 409 });
  });

  it('rejects when there is no validation approval at all', () => {
    const d = decideMissionStart({ ...ok, validationApprovalStatuses: [] });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toMatch(/Submit it for validation/);
  });

  it('names the execution task after the mission', () => {
    expect(executeMissionTaskTitle('Revenue Ops Mission: Find 5000 Leads')).toBe('Execute mission: Revenue Ops Mission: Find 5000 Leads');
  });

  it('assigns the task to an agent queue so it can actually be claimed', () => {
    expect(missionExecutionAgent(null)).toBe('apex-coo-001');
    expect(missionExecutionAgent('')).toBe('apex-coo-001');
    expect(missionExecutionAgent('apex-sales-001')).toBe('apex-sales-001');
  });
});

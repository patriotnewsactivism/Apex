// ─── Revenue Workforce Runner ────────────────────────────────────────────────
//
// A small durable coordinator for revenue-ops enrollments. It does not bypass
// provider approvals: it creates strategy, queues the next action, and prepares
// a timeline event that the approved channel tool can execute.

import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { campaigns, campaignEnrollments, db } from '@workspace/db';
import {
  prepareDueRevenueStep,
  queueNextRevenueWorkforceStep,
} from '@workspace/core';

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_ENROLLMENTS_PER_TICK = 25;

export class RevenueWorkforceRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly intervalMs = DEFAULT_INTERVAL_MS) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error('[revenue-workforce] tick failed:', error instanceof Error ? error.message : String(error));
      });
    }, this.intervalMs);
    this.timer.unref?.();
    console.log(`[revenue-workforce] Runner started (every ${Math.round(this.intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<{ campaigns: number; enrollments: number; prepared: number }> {
    if (this.running) return { campaigns: 0, enrollments: 0, prepared: 0 };
    this.running = true;
    try {
      const activeCampaigns = await db.select({ id: campaigns.id }).from(campaigns)
        .where(inArray(campaigns.status, ['active']))
        .orderBy(asc(campaigns.createdAt))
        .limit(50);
      if (activeCampaigns.length === 0) return { campaigns: 0, enrollments: 0, prepared: 0 };

      const rows = await db.select().from(campaignEnrollments).where(and(
        inArray(campaignEnrollments.campaignId, activeCampaigns.map((campaign) => campaign.id)),
        inArray(campaignEnrollments.status, ['pending', 'active']),
        or(isNull(campaignEnrollments.nextActionAt), lte(campaignEnrollments.nextActionAt, new Date())),
      )).orderBy(asc(campaignEnrollments.nextActionAt)).limit(MAX_ENROLLMENTS_PER_TICK);

      let prepared = 0;
      for (const enrollment of rows) {
        const queued = await queueNextRevenueWorkforceStep({
          organizationId: enrollment.organizationId,
          enrollmentId: enrollment.id,
        });
        if (!queued.queued && queued.reason === 'Enrollment already has an outstanding step.') {
          const result = await prepareDueRevenueStep({
            organizationId: enrollment.organizationId,
            enrollmentId: enrollment.id,
          });
          if (result.prepared) prepared++;
          continue;
        }
        if (queued.queued) {
          const result = await prepareDueRevenueStep({
            organizationId: enrollment.organizationId,
            enrollmentId: enrollment.id,
          });
          if (result.prepared) prepared++;
        }
      }
      return { campaigns: activeCampaigns.length, enrollments: rows.length, prepared };
    } finally {
      this.running = false;
    }
  }
}

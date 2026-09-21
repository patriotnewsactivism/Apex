import { z } from 'zod';
import { db, emailCampaigns, emailSends } from '@workspace/db';
import { inArray, eq, and, desc, sql } from 'drizzle-orm';
import type { ToolDefinition } from './types.js';

export const campaignSnapshotSchema = z.object({
  campaignIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
});

export const campaignSnapshotTool: ToolDefinition<z.infer<typeof campaignSnapshotSchema>> = {
  name: 'campaign_snapshot',
  description: 'Read up to 50 email campaigns in one operation, with real queued/sent/failed counts. No messages are sent. Use one snapshot instead of checking campaigns one at a time.',
  requiresApproval: false,
  schema: campaignSnapshotSchema,
  async execute({ campaignIds }) {
    const ids = campaignIds ? [...new Set(campaignIds)] : undefined;
    const campaigns = await db.select().from(emailCampaigns)
      .where(ids ? inArray(emailCampaigns.id, ids) : undefined)
      .orderBy(desc(emailCampaigns.createdAt)).limit(50);
    if (!campaigns.length) return { campaigns: [], missingIds: ids ?? [] };
    const queued = await db.select({ campaignId: emailSends.campaignId, count: sql<number>`count(*)::int` })
      .from(emailSends).where(and(inArray(emailSends.campaignId, campaigns.map(c => c.id)), eq(emailSends.status, 'queued')))
      .groupBy(emailSends.campaignId);
    const counts = new Map(queued.map(row => [row.campaignId, row.count]));
    const found = new Set(campaigns.map(c => c.id));
    return { campaigns: campaigns.map(c => ({
      campaignId: c.id, name: c.name, status: c.status, targets: c.totalTargets,
      sent: c.sentCount, failed: c.failedCount, queued: counts.get(c.id) ?? 0,
      percentComplete: c.totalTargets ? Math.round(((c.sentCount + c.failedCount) / c.totalTargets) * 100) : 0,
    })), missingIds: ids?.filter(id => !found.has(id)) ?? [] };
  },
};

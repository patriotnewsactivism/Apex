import { Router } from 'express';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, emailCampaigns, emailSends } from '@workspace/db';

// ─── Email Campaigns — human-facing surface ──────────────────────────────────
//
// The send path (start_email_campaign / send_email_campaign_batch /
// get_email_campaign_status in packages/core/src/tool-registry.ts) has existed
// since 2026-09-06 and is agent-driven only: no route ever read emailCampaigns/
// emailSends, and no operator control could pause, resume, or cancel one.
// send_email_campaign_batch already refuses to send a 'paused' campaign and
// tells the caller to "resume it (set its status back to running)" — but
// nothing could ever perform that transition. This router is that missing
// control surface, deliberately thin: it never sends anything itself, it only
// reads emailCampaigns/emailSends and flips emailCampaigns.status, exactly the
// way routes/campaigns.ts does for leadCampaigns.

/** Only these transitions are meaningful. A draft can be paused before its
 *  first batch ever sends (holds it, the same as pausing mid-run); completed
 *  and cancelled are terminal — starting over means a new campaign, not
 *  reviving one whose queued rows may already be stale. */
const PAUSABLE_STATUSES = ['draft', 'running'] as const;
const CANCELLABLE_STATUSES = ['draft', 'running', 'paused'] as const;

type EmailSendCounts = Record<string, number>;

/** emailCampaigns.sentCount/failedCount are the tool's own coarse ledger,
 *  incremented once per attempt. This breakdown is finer and lives entirely
 *  in emailSends.status, which the Resend webhook keeps current after the
 *  send — a row is queued, then exactly one of sent/delivered/opened/clicked/
 *  bounced/complained/failed/suppressed, never more than one at a time. */
/** Exported so the guard can assert the funnel math directly against fixture
 *  rows instead of only pattern-matching the source. */
export function summarizeEmailCampaign(
  campaign: typeof emailCampaigns.$inferSelect,
  counts: EmailSendCounts,
) {
  const queued = counts.queued ?? 0;
  const sent = counts.sent ?? 0;
  const delivered = counts.delivered ?? 0;
  const opened = counts.opened ?? 0;
  const clicked = counts.clicked ?? 0;
  const bounced = counts.bounced ?? 0;
  const complained = counts.complained ?? 0;
  const failed = counts.failed ?? 0;
  const suppressed = counts.suppressed ?? 0;
  const attempted = campaign.sentCount + campaign.failedCount;

  return {
    campaignId: campaign.id,
    name: campaign.name,
    status: campaign.status,
    leadCampaignId: campaign.leadCampaignId,
    goalId: campaign.goalId,
    totalTargets: campaign.totalTargets,
    sentCount: campaign.sentCount,
    failedCount: campaign.failedCount,
    percentComplete: campaign.totalTargets > 0
      ? Math.round((attempted / campaign.totalTargets) * 100)
      : 0,
    queued,
    sent,
    delivered,
    opened,
    clicked,
    bounced,
    complained,
    failed,
    suppressed,
    createdAt: campaign.createdAt,
    startedAt: campaign.startedAt,
    completedAt: campaign.completedAt,
    lastProgressAt: campaign.lastProgressAt,
  };
}

export function createEmailCampaignsRouter() {
  const router = Router();

  // GET /api/email-campaigns — every campaign with its delivery breakdown
  router.get('/', async (_req, res) => {
    const campaigns = await db.select().from(emailCampaigns).orderBy(desc(emailCampaigns.createdAt)).limit(100);
    if (campaigns.length === 0) {
      res.json({ campaigns: [] });
      return;
    }
    const ids = campaigns.map((c) => c.id);
    const rows = await db
      .select({ campaignId: emailSends.campaignId, status: emailSends.status, n: sql<number>`count(*)::int` })
      .from(emailSends)
      .where(inArray(emailSends.campaignId, ids))
      .groupBy(emailSends.campaignId, emailSends.status);

    const byCampaign = new Map<string, EmailSendCounts>();
    for (const row of rows) {
      if (!row.campaignId) continue;
      const bucket = byCampaign.get(row.campaignId) ?? {};
      bucket[row.status] = row.n;
      byCampaign.set(row.campaignId, bucket);
    }

    res.json({ campaigns: campaigns.map((c) => summarizeEmailCampaign(c, byCampaign.get(c.id) ?? {})) });
  });

  // GET /api/email-campaigns/sends — recent outbound email activity across
  // campaigns AND one-off sends. This route intentionally comes before /:id so
  // Express never mistakes the literal path segment "sends" for a campaign id.
  //
  // scope=all (default) | campaign | one-off
  // status=<email_sends.status> narrows the activity feed without changing the
  // underlying delivery ledger. Read-only and admin-authenticated by the
  // blanket /api gate in index.ts.
  router.get('/sends', async (req, res) => {
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
    const scope = req.query.scope === 'campaign' || req.query.scope === 'one-off'
      ? req.query.scope
      : 'all';
    const status = typeof req.query.status === 'string' && req.query.status.trim()
      ? req.query.status.trim()
      : null;

    const scopeCondition = scope === 'campaign'
      ? isNotNull(emailSends.campaignId)
      : scope === 'one-off'
        ? isNull(emailSends.campaignId)
        : undefined;
    const statusCondition = status ? eq(emailSends.status, status) : undefined;
    const where = and(scopeCondition, statusCondition);

    const sends = where
      ? await db.select().from(emailSends).where(where).orderBy(desc(emailSends.createdAt)).limit(limit)
      : await db.select().from(emailSends).orderBy(desc(emailSends.createdAt)).limit(limit);

    res.json({ sends });
  });

  // GET /api/email-campaigns/:id — breakdown plus recent individual sends
  router.get('/:id', async (req, res) => {
    const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, req.params.id)).limit(1);
    if (!campaign) {
      res.status(404).json({ error: 'Email campaign not found' });
      return;
    }
    const [counts, sends] = await Promise.all([
      db
        .select({ status: emailSends.status, n: sql<number>`count(*)::int` })
        .from(emailSends)
        .where(eq(emailSends.campaignId, campaign.id))
        .groupBy(emailSends.status),
      db
        .select()
        .from(emailSends)
        .where(eq(emailSends.campaignId, campaign.id))
        .orderBy(desc(emailSends.createdAt))
        .limit(Math.min(Number(req.query.limit) || 200, 2000)),
    ]);

    const bucket: EmailSendCounts = {};
    for (const row of counts) bucket[row.status] = row.n;

    res.json({
      campaign: {
        ...summarizeEmailCampaign(campaign, bucket),
        subjectTemplate: campaign.subjectTemplate,
        bodyTemplate: campaign.bodyTemplate,
        result: campaign.result,
      },
      sends,
    });
  });

  // POST /api/email-campaigns/:id/pause | /resume | /cancel
  const transitions: Array<{ action: 'pause' | 'resume' | 'cancel'; next: string; from: readonly string[] }> = [
    { action: 'pause', next: 'paused', from: PAUSABLE_STATUSES },
    { action: 'resume', next: 'running', from: ['paused'] },
    { action: 'cancel', next: 'cancelled', from: CANCELLABLE_STATUSES },
  ];

  for (const { action, next, from } of transitions) {
    router.post(`/:id/${action}`, async (req, res) => {
      const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, req.params.id)).limit(1);
      if (!campaign) {
        res.status(404).json({ error: 'Email campaign not found' });
        return;
      }
      if (!from.includes(campaign.status)) {
        res.status(409).json({
          error: `Campaign is ${campaign.status} and can no longer be ${action}d.${
            campaign.status === 'completed' || campaign.status === 'cancelled' ? ' Start a new campaign instead.' : ''
          }`,
        });
        return;
      }

      // CAS on the status just read: two concurrent requests (an operator
      // clicking Cancel while send_email_campaign_batch is mid-flight and
      // flips draft/paused -> running) must not both report success for one
      // transition.
      const [updated] = await db
        .update(emailCampaigns)
        .set({
          status: next,
          lastProgressAt: new Date(),
          ...(next === 'cancelled' ? { completedAt: new Date(), result: campaign.result ?? 'Cancelled by operator.' } : {}),
        })
        .where(and(eq(emailCampaigns.id, campaign.id), eq(emailCampaigns.status, campaign.status)))
        .returning({ id: emailCampaigns.id, status: emailCampaigns.status });

      if (!updated) {
        res.status(409).json({ error: 'Campaign status changed before this action applied. Reload and try again.' });
        return;
      }

      res.json({ campaignId: campaign.id, status: updated.status });
    });
  }

  return router;
}

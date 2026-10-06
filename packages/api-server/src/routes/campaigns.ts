import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, campaignSegments, leadCampaigns, researchedLeads } from '@workspace/db';
import { computeCampaignProgress, countUsableCampaignLeads, createCampaign, extendCampaign, getLeadSearchPauseSnapshot } from '@workspace/background-jobs';
import { broadcast } from '../websocket.js';

// Progress is always computed from campaign + segment rows at read time, never
// stored. A cached percentage goes stale the moment a segment lands, and a
// stored ETA is a number that looks authoritative while being wrong.

const createSchema = z
  .object({
    name: z.string().min(3).max(120),
    industries: z.array(z.string().min(1)).min(1).max(20),
    // Explicit cities remain supported and combine with states/national
    // below rather than being replaced by them.
    cities: z.array(z.string().min(1)).max(50).optional().default([]),
    // Two-letter USPS codes — each expands to that state's principal cities.
    states: z.array(z.string().min(2).max(2)).max(51).optional(),
    // Shorthand for every state at once.
    national: z.boolean().optional().default(false),
    targetLeads: z.number().int().min(1).max(5000).optional().default(100),
    goalId: z.string().optional(),
    projectId: z.string().optional(),
    pushToBuildmybot: z.boolean().optional().default(false),
    notes: z.string().max(2000).optional(),
  })
  .refine(
    (v) => v.cities.length > 0 || (v.states?.length ?? 0) > 0 || v.national,
    { message: 'Provide at least one city, one state, or national=true.', path: ['cities'] },
  );

const extendSchema = z.object({
  // Same ceiling as creation.
  targetLeads: z.number().int().min(1).max(5000),
  retryFailed: z.boolean().optional().default(true),
  reopenCancelled: z.boolean().optional().default(true),
  addCities: z.array(z.string().min(1)).max(50).optional(),
  addStates: z.array(z.string().min(2).max(2)).max(51).optional(),
  national: z.boolean().optional().default(false),
  addIndustries: z.array(z.string().min(1)).max(20).optional(),
  dryRun: z.boolean().optional().default(false),
});

/** Only these transitions are meaningful, and only from a live campaign.
 *  Resuming a completed campaign would restart territory it already finished. */
const LIVE_STATUSES = ['running', 'paused'] as const;

export function createCampaignsRouter() {
  const router = Router();

  // GET /api/campaigns — every campaign with live progress
  router.get('/', async (_req, res) => {
    const campaigns = await db.select().from(leadCampaigns).orderBy(desc(leadCampaigns.createdAt)).limit(100);
    if (campaigns.length === 0) {
      res.json({ campaigns: [] });
      return;
    }
    const allSegments = await db.select().from(campaignSegments);
    const byCampaign = new Map<string, Array<typeof campaignSegments.$inferSelect>>();
    for (const s of allSegments) {
      const list = byCampaign.get(s.campaignId) ?? [];
      list.push(s);
      byCampaign.set(s.campaignId, list);
    }

    const usableRows = await db
      .select({
        campaignId: researchedLeads.campaignId,
        count: sql<number>`count(*)::int`,
      })
      .from(researchedLeads)
      .where(
        and(
          inArray(researchedLeads.campaignId, campaigns.map((campaign) => campaign.id)),
          eq(researchedLeads.pipelineState, 'CAMPAIGN_READY'),
          eq(researchedLeads.status, 'qualified'),
          sql`(${researchedLeads.contactEmail} IS NOT NULL OR ${researchedLeads.contactPhone} IS NOT NULL)`,
          sql`${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'`,
        ),
      )
      .groupBy(researchedLeads.campaignId);
    const usableByCampaign = new Map(
      usableRows
        .filter((row): row is typeof row & { campaignId: string } => Boolean(row.campaignId))
        .map((row) => [row.campaignId, Number(row.count)]),
    );

    res.json({
      campaigns: campaigns.map((campaign) =>
        computeCampaignProgress(
          campaign,
          byCampaign.get(campaign.id) ?? [],
          Date.now(),
          usableByCampaign.get(campaign.id) ?? 0,
          getLeadSearchPauseSnapshot(),
        ),
      ),
    });
  });

  // GET /api/campaigns/:id — progress plus the per-segment territory grid
  router.get('/:id', async (req, res) => {
    const [campaign] = await db.select().from(leadCampaigns).where(eq(leadCampaigns.id, req.params.id)).limit(1);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    const segments = await db
      .select()
      .from(campaignSegments)
      .where(eq(campaignSegments.campaignId, campaign.id))
      .orderBy(campaignSegments.industry, campaignSegments.city);

    const usableLeadCount = await countUsableCampaignLeads(campaign.id);
    res.json({
      campaign: {
        ...computeCampaignProgress(campaign, segments, Date.now(), usableLeadCount, getLeadSearchPauseSnapshot()),
        icp: campaign.icp,
        result: campaign.result,
      },
      segments,
    });
  });

  // GET /api/campaigns/:id/leads — what this campaign actually produced
  router.get('/:id/leads', async (req, res) => {
    const leads = await db
      .select()
      .from(researchedLeads)
      .where(
        and(
          eq(researchedLeads.campaignId, req.params.id),
          eq(researchedLeads.pipelineState, 'CAMPAIGN_READY'),
          eq(researchedLeads.status, 'qualified'),
          sql`(${researchedLeads.contactEmail} IS NOT NULL OR ${researchedLeads.contactPhone} IS NOT NULL)`,
          sql`${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'`,
        ),
      )
      .orderBy(desc(researchedLeads.createdAt))
      .limit(Math.min(Number(req.query.limit) || 500, 5000));
    res.json({ leads });
  });

  // POST /api/campaigns — create and start
  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const created = await createCampaign(parsed.data);
      broadcast({
        type: 'campaign:started',
        campaignId: created.campaignId,
        name: parsed.data.name,
        targetLeads: parsed.data.targetLeads,
        segments: created.segments,
      });
      res.status(201).json(created);
    } catch (err) {
      // createCampaign throws on an oversized territory or an ICP that
      // normalized to nothing — both are user input problems, not 500s.
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/campaigns/:id/extend — raise the target of a finished,
  // cancelled, or short campaign and resume it through its UNSEARCHED
  // territory. Done/exhausted segments are kept and skipped; cancelled
  // segments reopen; failed ones are retried (retryFailed, default true).
  // { dryRun: true } returns the plan without writing.
  router.post('/:id/extend', async (req, res) => {
    const parsed = extendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const result = await extendCampaign({ campaignId: req.params.id, ...parsed.data, requestedBy: 'operator' });
      if (!result.dryRun) {
        broadcast({
          type: 'campaign:started',
          campaignId: result.campaignId,
          name: result.name,
          targetLeads: result.targetLeads,
          segments: result.segmentsTotalBefore + result.newSegments,
        });
      }
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(/^No campaign with id/.test(message) ? 404 : 409).json({ error: message });
    }
  });

  // POST /api/campaigns/:id/pause | /resume | /cancel
  for (const [action, next] of [['pause', 'paused'], ['resume', 'running'], ['cancel', 'cancelled']] as const) {
    router.post(`/:id/${action}`, async (req, res) => {
      const [campaign] = await db.select().from(leadCampaigns).where(eq(leadCampaigns.id, req.params.id)).limit(1);
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      if (!(LIVE_STATUSES as readonly string[]).includes(campaign.status)) {
        res.status(409).json({
          error: `Campaign is ${campaign.status} and can no longer be ${action}d. Use POST /api/campaigns/${campaign.id}/extend to raise its target and continue its unsearched territory.`,
        });
        return;
      }

      await db
        .update(leadCampaigns)
        .set({
          status: next,
          lastProgressAt: new Date(),
          ...(next === 'cancelled' ? { completedAt: new Date(), result: 'Cancelled by operator.' } : {}),
        })
        .where(eq(leadCampaigns.id, campaign.id));

      // Release any in-flight segment so a paused or cancelled campaign does
      // not leave a cell wedged in_progress until its lease expires.
      if (next !== 'running') {
        await db
          .update(campaignSegments)
          .set({ status: 'pending', leasedAt: null })
          .where(and(eq(campaignSegments.campaignId, campaign.id), eq(campaignSegments.status, 'in_progress')));
      }

      res.json({ campaignId: campaign.id, status: next });
    });
  }

  return router;
}

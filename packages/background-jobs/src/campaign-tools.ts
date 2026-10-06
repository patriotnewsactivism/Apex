import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db, campaignSegments, leadCampaigns } from '@workspace/db';
import type { ToolDefinition } from '@workspace/core';
import { computeCampaignProgress, createCampaign, extendCampaign } from './campaign-runner.js';
import { getLeadSearchPauseSnapshot } from './lead-search-capacity.js';

// ─── Campaign tools ───────────────────────────────────────────────────────────
//
// These let Apex run a lead hunt conversationally — "go find me 200 HVAC
// companies across Texas" — and then report on it honestly.
//
// get_campaign_progress deliberately returns the same computed numbers the
// dashboard renders. Agents previously reported pipeline status by guessing
// from a listResearchedLeads count, which cannot distinguish "this brief is
// 40% done" from "this brief finished and came up short".
//
// None are approval-gated: a campaign only reads public business directories
// and writes to Apex's own leads table. Nothing outward-facing happens until
// the BuildMyBot push, which IS gated.

export function createCampaignTools(): ToolDefinition[] {
  return [
    {
      name: 'start_lead_campaign',
      description:
        "Start a bounded, monitored lead-research campaign. Give it industries, cities and a target lead count; it works the (industry x city) territory segment by segment, saving qualified leads against the campaign so progress is measurable. Use this INSTEAD of ad-hoc searchBusinessDirectory calls whenever the goal is a quantity of leads — it is resumable, deduplicates against every lead already on file, and can be paused. Check on it with get_campaign_progress; do NOT block waiting for it to finish.",
      schema: z.object({
        name: z.string().describe('Short name for this campaign, e.g. "Texas HVAC Q3"'),
        industries: z
          .array(z.string())
          .describe('Industries to cover, e.g. ["HVAC", "Plumbing"]. Normalized to the canonical taxonomy automatically.'),
        cities: z
          .array(z.string())
          .optional()
          .describe('Explicit cities, e.g. ["Dallas TX", "Houston TX"]. Include the state. Combines with states/national below rather than being replaced by them.'),
        states: z
          .array(z.string().length(2))
          .optional()
          .describe('Two-letter USPS state codes, e.g. ["TX", "CA"] — expands to each state\'s 3 principal cities. Use instead of typing out cities when the brief is state- or region-scoped.'),
        national: z
          .boolean()
          .optional()
          .describe('Cover all 50 states + DC at once (3 principal cities each = ~153 cities). National multi-industry campaigns are supported up to the 5,000-segment safety ceiling, and the runner stops early when the target lead count is reached.'),
        targetLeads: z.number().optional().describe('How many NEW leads to find before stopping. Default 100.'),
        pushToBuildmybot: z
          .boolean()
          .optional()
          .describe('Mark this campaign for handoff into the BuildMyBot sales pipeline once it has leads. Default false.'),
        notes: z.string().optional().describe('Any extra ICP context to record with the campaign.'),
      }),
      requiresApproval: false,
      async execute({ name, industries, cities, states, national, targetLeads, pushToBuildmybot, notes }, ctx) {
        const created = await createCampaign({
          name,
          industries,
          cities: cities ?? [],
          states,
          national,
          targetLeads,
          pushToBuildmybot,
          notes,
          goalId: ctx.goalId,
          createdByAgentId: ctx.agentId,
        });
        return {
          ...created,
          message:
            `Campaign "${name}" started: ${created.segments} territory segments ` +
            `(${created.industries.length} industries x ${created.cities.length} cities), target ${targetLeads ?? 100} leads. ` +
            `It runs in the background — call get_campaign_progress to check on it rather than waiting.`,
        };
      },
    },

    {
      name: 'get_campaign_progress',
      description:
        'Get REAL progress on lead campaigns: leads saved against target, territory coverage, yield per segment, ETA, and whether a campaign has stalled. Use this to report pipeline status instead of guessing from lead counts — it distinguishes "still running" from "finished but came up short".',
      schema: z.object({
        campaignId: z.string().optional().describe('One campaign. Omit to get every campaign, newest first.'),
      }),
      requiresApproval: false,
      async execute({ campaignId }) {
        const campaigns = campaignId
          ? await db.select().from(leadCampaigns).where(eq(leadCampaigns.id, campaignId)).limit(1)
          : await db.select().from(leadCampaigns).orderBy(desc(leadCampaigns.createdAt)).limit(20);

        if (campaigns.length === 0) {
          return campaignId
            ? { error: `No campaign with id ${campaignId}` }
            : { campaigns: [], note: 'No lead campaigns have been started yet. Use start_lead_campaign.' };
        }

        const out = [];
        for (const campaign of campaigns) {
          const segments = await db
            .select()
            .from(campaignSegments)
            .where(eq(campaignSegments.campaignId, campaign.id));
          const p = computeCampaignProgress(campaign, segments, Date.now(), undefined, getLeadSearchPauseSnapshot());
          out.push({
            campaignId: p.campaignId,
            name: p.name,
            status: p.displayStatus,
            leads: `${p.leadsSaved} / ${p.targetLeads}`,
            percentComplete: Math.round(p.leadProgress * 100),
            territory: `${p.segmentsDone} of ${p.segmentsTotal} segments worked`,
            segmentsRemaining: p.segmentsRemaining,
            segmentsFailed: p.segmentsFailed,
            duplicatesSkipped: p.duplicatesSkipped,
            yieldPerSegment: p.yieldPerSegment === null ? null : Number(p.yieldPerSegment.toFixed(1)),
            etaMinutes: p.etaMs === null ? null : Math.round(p.etaMs / 60_000),
            result: campaign.result ?? undefined,
            // Say it plainly. A stalled campaign reads as 'running' in the
            // table, and that is exactly the failure mode worth surfacing.
            warning:
              p.displayStatus === 'waiting_for_search'
                ? `WAITING FOR SEARCH — every search source is unavailable (${p.searchPause?.summary ?? 'no source answered'}). Searches are paused, not failing, and none are being closed. Next test search at ${p.searchPause?.resumeAt ?? 'the next runner tick'}.`
                : p.displayStatus === 'stalled'
                  ? 'STALLED — no progress in over 15 minutes. The runner may be wedged or every provider may be down.'
                  : undefined,
          });
        }
        return campaignId ? out[0] : { campaigns: out };
      },
    },

    {
      name: 'pause_lead_campaign',
      description:
        'Pause or resume a running lead campaign, or cancel it outright. Pausing stops new territory being worked but keeps everything found so far. To continue a completed, cancelled, or short campaign use extend_lead_campaign.',
      schema: z.object({
        campaignId: z.string(),
        action: z.enum(['pause', 'resume', 'cancel']),
      }),
      requiresApproval: false,
      async execute({ campaignId, action }) {
        const [campaign] = await db.select().from(leadCampaigns).where(eq(leadCampaigns.id, campaignId)).limit(1);
        if (!campaign) throw new Error(`No campaign with id ${campaignId}`);
        if (campaign.status !== 'running' && campaign.status !== 'paused') {
          throw new Error(
            `Campaign "${campaign.name}" is ${campaign.status} and can no longer be ${action}d. Use extend_lead_campaign to raise its target and continue its unsearched territory.`,
          );
        }

        const next = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled';
        await db
          .update(leadCampaigns)
          .set({
            status: next,
            lastProgressAt: new Date(),
            ...(next === 'cancelled'
              ? { completedAt: new Date(), result: 'Cancelled.' }
              : {}),
          })
          .where(eq(leadCampaigns.id, campaignId));

        return { campaignId, status: next, name: campaign.name };
      },
    },

    {
      name: 'extend_lead_campaign',
      description:
        'Keep a lead campaign collecting: raise its target and resume it through territory it has NOT searched yet. Works on completed, completed_short, cancelled, paused, and running campaigns. Segments already worked are kept and skipped (their searches are cached, so nothing is re-fetched or re-paid); segments cancelled when the old target was hit are reopened; failed segments are retried unless retryFailed=false. Optionally widen with addCities/addStates/national/addIndustries. Call with dryRun=true first to see exactly what would happen. Lead collection only — it never emails or calls anyone.',
      schema: z.object({
        campaignId: z.string(),
        targetLeads: z.number().int().min(1).max(5000).describe('New target in usable (verified, contact-ready) leads; must be above the current count.'),
        retryFailed: z.boolean().optional().describe('Requeue failed segments with a fresh retry budget. Default true.'),
        reopenCancelled: z.boolean().optional().describe('Reopen segments cancelled when the previous target was met. Default true.'),
        addCities: z.array(z.string()).optional().describe('Extra cities, e.g. ["Boise ID"].'),
        addStates: z.array(z.string().length(2)).optional().describe('Extra two-letter state codes.'),
        national: z.boolean().optional().describe('Add every state\'s principal cities.'),
        addIndustries: z.array(z.string()).optional().describe('Extra industries to cover across the territory.'),
        dryRun: z.boolean().optional().describe('Return the plan without changing anything.'),
      }),
      requiresApproval: false,
      async execute({ campaignId, targetLeads, retryFailed, reopenCancelled, addCities, addStates, national, addIndustries, dryRun }, ctx) {
        return extendCampaign({
          campaignId,
          targetLeads,
          retryFailed,
          reopenCancelled,
          addCities,
          addStates,
          national,
          addIndustries,
          dryRun,
          requestedBy: ctx.agentId,
        });
      },
    },
  ];
}

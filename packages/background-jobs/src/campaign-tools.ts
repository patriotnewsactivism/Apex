import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db, campaignSegments, leadCampaigns } from '@workspace/db';
import type { ToolDefinition } from '@workspace/core';
import { computeCampaignProgress, createCampaign } from './campaign-runner.js';

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
          .describe('Cities to cover, e.g. ["Dallas TX", "Houston TX"]. Include the state.'),
        targetLeads: z.number().optional().describe('How many NEW leads to find before stopping. Default 100.'),
        pushToBuildmybot: z
          .boolean()
          .optional()
          .describe('Mark this campaign for handoff into the BuildMyBot sales pipeline once it has leads. Default false.'),
        notes: z.string().optional().describe('Any extra ICP context to record with the campaign.'),
      }),
      requiresApproval: false,
      async execute({ name, industries, cities, targetLeads, pushToBuildmybot, notes }, ctx) {
        const created = await createCampaign({
          name,
          industries,
          cities,
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
          const p = computeCampaignProgress(campaign, segments);
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
              p.displayStatus === 'stalled'
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
        'Pause or resume a running lead campaign, or cancel it outright. Pausing stops new territory being worked but keeps everything found so far; a cancelled campaign cannot be restarted.',
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
            `Campaign "${campaign.name}" is ${campaign.status} and can no longer be ${action}d. Start a new campaign instead.`,
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
  ];
}

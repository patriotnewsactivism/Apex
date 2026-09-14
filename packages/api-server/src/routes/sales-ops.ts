// ─── Sales Operations & Monitoring ──────────────────────────────────────────
//
// A dedicated operator surface for running and watching sales work:
//
//   GET  /overview  — the live cost + outreach + pipeline picture in one call:
//                     LLM dollar spend (spend-ledger), outbound-call and email
//                     tallies (from the same durable records the webhooks write),
//                     lead-pipeline funnel, and the current autonomy level.
//   POST /call      — place ONE outbound AI call immediately. This is an
//                     operator-initiated action from an authenticated console,
//                     so it approves the hard-gated make_outbound_call tool on
//                     the operator's behalf (requestApproval => true) rather than
//                     parking it in the agent approval queue. The operator owns
//                     DNC/consent for a number they type in here.
//   POST /automate  — designate a target (one lead, a list/campaign, or the whole
//                     qualified pipeline) for full automation: set the workforce
//                     autonomy level and hand the Sales org a goal to work it
//                     end-to-end. The autonomous loops carry it from there.
//
// Everything read here is a live query against durable state or the in-process
// spend ledger — never fabricated. Mounted behind requireAdminAuth like every
// other /api route.

import { Router } from 'express';
import {
  db,
  researchedLeads,
  leadCampaigns,
  emailCampaigns,
  emailSends,
  logs,
  integrationSettings,
} from '@workspace/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getSpendLedgerSnapshot } from '@workspace/core';
import type { ApexCEO } from '@workspace/agents';

const SALES_AGENT_ID = 'apex-sales-001';

// Same presets the Settings → System control uses, kept identical so the
// autonomy level shown here and there always means the same throughput.
const AUTONOMY_PRESETS: Record<string, { cron: string; label: string }> = {
  conservative: { cron: '*/30 * * * *', label: 'Conservative — goal review every 30 min' },
  balanced: { cron: '*/15 * * * *', label: 'Balanced — goal review every 15 min (default)' },
  aggressive: { cron: '*/10 * * * *', label: 'Aggressive — goal review every 10 min, max throughput' },
};

/** The paid-cost portion of an outbound call is only ever reported inside the
 *  Vapi end-of-call log line ("Cost: $0.1234"). Pull it out with a bound regex
 *  parameter rather than string-building the pattern into the SQL. */
const CALL_COST_PATTERN = 'Cost: \\$([0-9.]+)';

function startOfUtcDay(at = new Date()): Date {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function applyAutonomyPreset(level: string): Promise<boolean> {
  if (!AUTONOMY_PRESETS[level]) return false;
  await db
    .insert(integrationSettings)
    .values({ key: 'system:autonomy_level', value: level, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: integrationSettings.key,
      set: { value: level, updatedAt: new Date() },
    });
  // Reschedule the CEO goal-review job so the new cadence takes effect, exactly
  // as PUT /api/settings/system does. Best-effort: a missing job must not fail
  // the autonomy change itself.
  try {
    const { scheduledJobs } = await import('@workspace/db');
    const { CronParser } = await import('@workspace/background-jobs');
    const cron = AUTONOMY_PRESETS[level].cron;
    const [reviewJob] = await db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.id, 'system-ceo-goal-review'))
      .limit(1);
    if (reviewJob) {
      const nextRunAt = CronParser.nextRun(cron, new Date()) ?? new Date(Date.now() + 60_000);
      await db
        .update(scheduledJobs)
        .set({ cronExpression: cron, nextRunAt, status: 'active', retryCount: 0 })
        .where(eq(scheduledJobs.id, 'system-ceo-goal-review'));
    }
  } catch (err) {
    console.warn(
      '[sales-ops] autonomy reschedule skipped:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return true;
}

function defaultAssistantPrompt(name: string | undefined, angle: string | undefined): string {
  return [
    `You are Alex, a friendly and concise sales rep for BuildMyBot.app, an AI chatbot platform for small and mid-sized businesses.`,
    `You are calling ${name ?? 'a prospective customer'}.`,
    angle ? `Lead in with this angle: ${angle}.` : '',
    `Goal of the call: qualify their interest, explain how BuildMyBot can help, handle objections briefly, and — only if they are clearly interested — offer to send a checkout link by calling send_checkout_link.`,
    `Be honest: do not promise features you are unsure about, and do not claim they can subscribe today unless asked to send a link. Keep it conversational and under two minutes. If they are not interested, thank them and end politely.`,
  ]
    .filter(Boolean)
    .join(' ');
}

function defaultFirstMessage(name: string | undefined): string {
  return name
    ? `Hi, is this ${name}? I'm Alex from BuildMyBot.app — do you have a quick minute?`
    : `Hi there, I'm Alex from BuildMyBot.app — do you have a quick minute?`;
}

export function createSalesOpsRouter(ceo: ApexCEO): Router {
  const router = Router();

  // ── GET /overview ─────────────────────────────────────────────────────────
  router.get('/overview', async (_req, res) => {
    try {
      const dayStart = startOfUtcDay();

      const [
        leadStatusRows,
        emailStatusRows,
        emailTodayRow,
        callRow,
        leadCampaignRows,
        emailCampaignRows,
        autonomyRow,
      ] = await Promise.all([
        db
          .select({ status: researchedLeads.status, n: sql<number>`count(*)::int` })
          .from(researchedLeads)
          .groupBy(researchedLeads.status),
        db
          .select({ status: emailSends.status, n: sql<number>`count(*)::int` })
          .from(emailSends)
          .groupBy(emailSends.status),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(emailSends)
          .where(gte(emailSends.createdAt, dayStart)),
        db
          .select({
            completedTotal: sql<number>`count(*) filter (where ${logs.message} like '%Outbound call ended%')::int`,
            completedToday: sql<number>`count(*) filter (where ${logs.message} like '%Outbound call ended%' and ${logs.timestamp} >= ${dayStart})::int`,
            placedTotal: sql<number>`count(*) filter (where ${logs.message} like '%Outbound call ringing%')::int`,
            placedToday: sql<number>`count(*) filter (where ${logs.message} like '%Outbound call ringing%' and ${logs.timestamp} >= ${dayStart})::int`,
            checkoutLinksTotal: sql<number>`count(*) filter (where ${logs.message} like '%Checkout link created%')::int`,
            callSpendTotalUsd: sql<number>`coalesce(sum((substring(${logs.message} from ${CALL_COST_PATTERN}))::float8) filter (where ${logs.message} like '%Outbound call ended%'), 0)::float8`,
            callSpendTodayUsd: sql<number>`coalesce(sum((substring(${logs.message} from ${CALL_COST_PATTERN}))::float8) filter (where ${logs.message} like '%Outbound call ended%' and ${logs.timestamp} >= ${dayStart}), 0)::float8`,
          })
          .from(logs)
          .where(eq(logs.agentId, SALES_AGENT_ID)),
        db
          .select({ status: leadCampaigns.status, n: sql<number>`count(*)::int` })
          .from(leadCampaigns)
          .groupBy(leadCampaigns.status),
        db
          .select({ status: emailCampaigns.status, n: sql<number>`count(*)::int` })
          .from(emailCampaigns)
          .groupBy(emailCampaigns.status),
        db
          .select()
          .from(integrationSettings)
          .where(eq(integrationSettings.key, 'system:autonomy_level'))
          .limit(1),
      ]);

      const leadsByStatus: Record<string, number> = {};
      let leadsTotal = 0;
      for (const row of leadStatusRows) {
        leadsByStatus[row.status] = row.n;
        leadsTotal += row.n;
      }

      const emailsByStatus: Record<string, number> = {};
      let emailsTotal = 0;
      for (const row of emailStatusRows) {
        emailsByStatus[row.status] = row.n;
        emailsTotal += row.n;
      }

      const call = callRow[0] ?? {
        completedTotal: 0,
        completedToday: 0,
        placedTotal: 0,
        placedToday: 0,
        checkoutLinksTotal: 0,
        callSpendTotalUsd: 0,
        callSpendTodayUsd: 0,
      };

      const spend = getSpendLedgerSnapshot();
      const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
      const runningCostTodayUsd = round4(spend.spentUsd + (call.callSpendTodayUsd ?? 0));

      const countRunning = (rows: { status: string; n: number }[]) =>
        rows
          .filter((r) => r.status === 'running' || r.status === 'active')
          .reduce((sum, r) => sum + r.n, 0);

      res.json({
        generatedAt: new Date().toISOString(),
        autonomyLevel: autonomyRow[0]?.value ?? 'balanced',
        autonomyPresets: Object.entries(AUTONOMY_PRESETS).map(([id, p]) => ({
          id,
          label: p.label,
        })),
        // Live LLM dollar spend against today's daily budget.
        spend,
        // Outbound calls, read from the durable Vapi call log lines.
        calls: {
          placedToday: call.placedToday ?? 0,
          placedTotal: call.placedTotal ?? 0,
          completedToday: call.completedToday ?? 0,
          completedTotal: call.completedTotal ?? 0,
          checkoutLinksTotal: call.checkoutLinksTotal ?? 0,
          spendTodayUsd: round4(call.callSpendTodayUsd ?? 0),
          spendTotalUsd: round4(call.callSpendTotalUsd ?? 0),
        },
        emails: {
          sentToday: emailTodayRow[0]?.n ?? 0,
          total: emailsTotal,
          byStatus: emailsByStatus,
        },
        leads: {
          total: leadsTotal,
          byStatus: leadsByStatus,
        },
        campaigns: {
          leadRunning: countRunning(leadCampaignRows),
          emailRunning: countRunning(emailCampaignRows),
        },
        // The single number the operator asked for: today's combined running
        // cost. LLM spend is authoritative to the micro-dollar; call spend is
        // summed from the per-call Vapi cost lines. Email is effectively free
        // per message and reported as a count, not a dollar figure.
        runningCost: {
          todayUsd: runningCostTodayUsd,
          llmSpendTodayUsd: spend.spentUsd,
          callSpendTodayUsd: round4(call.callSpendTodayUsd ?? 0),
          projectedLlmUsd: spend.projectedUsd,
          dailyCapUsd: spend.capUsd,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /call — place one outbound AI call, immediately ────────────────────
  router.post('/call', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        customerNumber?: string;
        customerName?: string;
        assistantPrompt?: string;
        firstMessage?: string;
        leadId?: string;
      };

      const rawNumber = typeof body.customerNumber === 'string' ? body.customerNumber.trim() : '';
      const normalized = rawNumber.replace(/[\s()-]/g, '');
      if (!/^\+?[0-9]{7,15}$/.test(normalized)) {
        res
          .status(400)
          .json({ error: 'A valid destination phone number in E.164 format (e.g. +18328804970) is required.' });
        return;
      }
      const customerNumber = normalized.startsWith('+') ? normalized : `+${normalized}`;

      // Hydrate personalization from the lead pipeline when a leadId is given —
      // never from an arbitrary contact list.
      let customerName = typeof body.customerName === 'string' ? body.customerName.trim() : '';
      let outreachAngle = '';
      if (body.leadId) {
        const [lead] = await db
          .select()
          .from(researchedLeads)
          .where(eq(researchedLeads.id, body.leadId))
          .limit(1);
        if (lead) {
          if (!customerName) customerName = lead.decisionMakerName ?? lead.companyName ?? '';
          outreachAngle = lead.outreachAngle ?? '';
        }
      }

      const assistantPrompt =
        typeof body.assistantPrompt === 'string' && body.assistantPrompt.trim()
          ? body.assistantPrompt.trim()
          : defaultAssistantPrompt(customerName || undefined, outreachAngle || undefined);
      const firstMessage =
        typeof body.firstMessage === 'string' && body.firstMessage.trim()
          ? body.firstMessage.trim()
          : defaultFirstMessage(customerName || undefined);

      const { getToolRegistry } = await import('@workspace/core');
      const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
      const registry = getToolRegistry(workspaceRoot);

      const result = await registry.execute(
        'make_outbound_call',
        { customerNumber, customerName: customerName || undefined, assistantPrompt, firstMessage },
        {
          agentId: SALES_AGENT_ID,
          workspaceRoot,
          // Operator-initiated from the authenticated Sales Ops console: the
          // human IS in the loop, so approve the hard gate on their behalf
          // instead of queueing an approval nobody is waiting on.
          requestApproval: async () => true,
        },
      );

      const success = !(result && typeof result === 'object' && 'success' in result && result.success === false);

      // Leave an honest operator-action record next to the agent's own call logs.
      await db.insert(logs).values({
        agentId: SALES_AGENT_ID,
        taskId: null,
        level: success ? 'acting' : 'error',
        message: success
          ? `Operator placed an outbound call to ${customerName ? `${customerName} ` : ''}${customerNumber} from Sales Ops.`
          : `Operator outbound call to ${customerNumber} failed: ${(result as { error?: string })?.error ?? 'unknown error'}`,
        timestamp: new Date(),
      });

      res.status(success ? 200 : 502).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /automate — designate a target for full automation ─────────────────
  router.post('/automate', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        autonomyLevel?: string;
        target?: { type?: 'lead' | 'campaign' | 'pipeline'; id?: string };
      };

      const target = body.target ?? {};
      const type = target.type ?? 'pipeline';

      let autonomyApplied: string | null = null;
      if (body.autonomyLevel) {
        const ok = await applyAutonomyPreset(body.autonomyLevel);
        if (!ok) {
          res.status(400).json({
            error: `Unknown autonomy level '${body.autonomyLevel}'. Expected one of: ${Object.keys(AUTONOMY_PRESETS).join(', ')}.`,
          });
          return;
        }
        autonomyApplied = body.autonomyLevel;
      }

      // Build the goal that the Sales org will execute autonomously.
      let title: string;
      let description: string;

      if (type === 'lead') {
        if (!target.id) {
          res.status(400).json({ error: 'target.id (a researched lead id) is required for a lead target.' });
          return;
        }
        const [lead] = await db
          .select()
          .from(researchedLeads)
          .where(eq(researchedLeads.id, target.id))
          .limit(1);
        if (!lead) {
          res.status(404).json({ error: `Lead ${target.id} not found.` });
          return;
        }
        title = `Full-automation outreach: ${lead.companyName}`;
        description = [
          `Run fully autonomous, end-to-end sales outreach for the researched lead "${lead.companyName}" (id ${lead.id}).`,
          lead.contactPhone ? `Phone on file: ${lead.contactPhone}.` : 'No phone on file — research one before calling.',
          lead.contactEmail ? `Email on file: ${lead.contactEmail}.` : 'No email on file — research one before emailing.',
          lead.outreachAngle ? `Suggested angle: ${lead.outreachAngle}.` : '',
          `Work the lead across the channels that are configured (call and/or email), track the outcome, and pursue it toward a booked appointment or closed deal. Respect all outreach hard rules and only contact this lead through the pipeline record.`,
        ]
          .filter(Boolean)
          .join(' ');
      } else if (type === 'campaign') {
        if (!target.id) {
          res.status(400).json({ error: 'target.id (a lead campaign id) is required for a campaign target.' });
          return;
        }
        const [campaign] = await db
          .select()
          .from(leadCampaigns)
          .where(eq(leadCampaigns.id, target.id))
          .limit(1);
        if (!campaign) {
          res.status(404).json({ error: `Campaign ${target.id} not found.` });
          return;
        }
        title = `Full-automation outreach: campaign ${campaign.name}`;
        description = [
          `Run fully autonomous sales outreach across every qualified lead sourced by lead campaign "${campaign.name}" (id ${campaign.id}).`,
          `Prioritize leads with complete contact info, reach out on the configured channels (call and/or email) in sensible batches, track each outcome, and drive the list toward booked appointments and closed deals.`,
          `Respect all outreach hard rules — only contact leads that exist in the pipeline for this campaign.`,
        ].join(' ');
      } else {
        title = `Full-automation outreach: entire qualified pipeline`;
        description = [
          `Run fully autonomous sales outreach across the entire qualified researched-lead pipeline.`,
          `Prioritize the highest-fit leads with complete contact info first, work them on the configured channels (call and/or email) in sensible batches, track each outcome, and continuously drive the pipeline toward booked appointments and closed deals until told to stop.`,
          `Respect all outreach hard rules and only contact leads that exist in the pipeline.`,
        ].join(' ');
      }

      // priority 2 — just under a hand-typed emergency goal, above routine work.
      const goalId = await ceo.submitGoal(title, description, 2);

      res.status(201).json({
        ok: true,
        goalId,
        autonomyLevel: autonomyApplied,
        target: { type, id: target.id ?? null },
        message: `Automation launched. The Sales org will work this target autonomously${autonomyApplied ? ` at ${autonomyApplied} autonomy` : ''}.`,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

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
//   GET  /sms/threads       — one row per SMS conversation (most recent first).
//   GET  /sms/threads/:number — the full two-way thread with one contact.
//   POST /sms/send          — send ONE outbound SMS immediately, operator-
//                     initiated from this console, same trust model as POST
//                     /call. Inbound replies land via telnyx-assistant.ts's
//                     /sms-inbound webhook into the same sms_messages table.
//
// Everything read here is a live query against durable state or the in-process
// spend ledger — never fabricated. Mounted behind requireAdminAuth like every
// other /api route.

import { Router } from 'express';
import crypto from 'crypto';
import {
  db,
  researchedLeads,
  leadCampaigns,
  emailCampaigns,
  emailSends,
  logs,
  integrationSettings,
  smsMessages,
  callOutcomes,
} from '@workspace/db';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
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
 *  parameter rather than string-building the pattern into the SQL.
 *
 *  The capture group allows AT MOST one decimal point on purpose. The pattern
 *  is unanchored, and vapi.ts appends the LLM-generated call summary to the
 *  same log line right after the cost — if that free-form text ever contains
 *  its own "Cost: $<digits/dots>"-shaped substring (a price or version number
 *  the model happened to mention), the old `[0-9.]+` would happily swallow a
 *  second '.' (e.g. "4.12.34") and hand Postgres a value ::float8 rejects.
 *  Postgres has no per-row fallback for a failed cast, so one such row 500'd
 *  this entire endpoint — not just the cost figure, but leads/emails/
 *  campaigns/autonomy too, since they all ride in the same Promise.all. This
 *  shape can only ever match a well-formed number or fail to match at all. */
export const CALL_COST_PATTERN = 'Cost: \\$([0-9]+(?:\\.[0-9]+)?)';

/** Drizzle's postgres-js dialect wraps every driver error in a generic
 *  "Failed query: <sql>\nparams: <params>" message and puts the actual
 *  database error on `.cause` — a bare `err.message` in an API response
 *  shows the query dump but hides the one line that says what went wrong
 *  (exactly what happened when the substring/cast bug above first surfaced:
 *  the operator saw the query text, never the "invalid input syntax for type
 *  double precision" that actually explained it). Prefer the cause. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

/** Validate and normalize an operator-entered destination number to E.164
 *  shape (a leading '+', digits only). Returns null for anything that isn't a
 *  plausible phone number. Shared by /call and /sms/send so both operator-
 *  initiated-immediately actions agree on what a valid destination looks
 *  like. Exported for direct guard testing. */
export function normalizeE164(raw: unknown): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const normalized = trimmed.replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(normalized)) return null;
  return normalized.startsWith('+') ? normalized : `+${normalized}`;
}

/** Return the start of the UTC day containing the supplied timestamp. */
function startOfUtcDay(at = new Date()): Date {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Persist an autonomy preset and reschedule the CEO goal-review cadence. */
async function applyAutonomyPreset(level: string): Promise<boolean> {
  if (!Object.hasOwn(AUTONOMY_PRESETS, level)) return false;
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

/** Build the default outbound-call instructions for a prospective customer. */
function defaultAssistantPrompt(name: string | undefined, angle: string | undefined): string {
  return [
    `You are Alex, an outbound sales rep for BuildMyBot.app — a white-label AI chatbot and voice-agent platform that turns website visitors and missed calls into booked customers, 24/7. You sound like a real person having a real conversation: warm, direct, unhurried, genuinely curious about their business — never like you're reading a script.`,
    `You are calling ${name ?? 'a prospective customer'}.`,
    angle
      ? `Lead in with this specific angle, since it's the real reason this call is relevant to them: ${angle}.`
      : `BuildMyBot's best-fit customers are home services (HVAC, roofing, plumbing, solar), legal (personal injury, DUI, family law), medical/esthetics (medspas, dental, plastic surgery), and real estate — businesses that lose leads to missed calls and slow follow-up. Open by asking what happens today when a call comes in after hours or during a busy job, and let their answer set the direction.`,
    `Discovery before pitching: ask one or two real questions about how they currently handle inbound leads/calls before describing the product — what's actually costing them business matters more than a feature list.`,
    `Objection handling — meet these head-on, don't deflect. "Not interested": ask what would make it worth a second look, then let it go gracefully if still no. "Too expensive": ask what they're currently losing to missed leads before defending price — chatbot plans start at $29/mo, the missed-call voice service is a separate add-on starting at $79/mo, so quote whichever one actually matches what they need. "Already have something": ask what's working and what isn't about it — don't trash competitors. "Send me info": that's usually a soft no — ask one clarifying question to check for real interest before agreeing to follow up by email instead.`,
    `Be honest: only confirm a feature or capability you are actually certain is live — if you're not sure, say you'll have someone confirm rather than guessing or promising. Do not claim they can subscribe today unless you are about to send a real checkout link. Never disparage a named competitor.`,
    `Goal of the call: qualify real interest and pain, and — only if they are clearly ready — offer to send a checkout link by calling send_checkout_link. Keep the whole call under three minutes. If they're genuinely not interested, thank them warmly and end the call — don't push.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Build the default opening line for an outbound sales call. */
function defaultFirstMessage(name: string | undefined): string {
  return name
    ? `Hi, is this ${name}? I'm Alex from BuildMyBot.app — do you have a quick minute?`
    : `Hi there, I'm Alex from BuildMyBot.app — do you have a quick minute?`;
}

/** Create the authenticated router for sales monitoring and operator actions. */
export function createSalesOpsRouter(ceo: ApexCEO): Router {
  const router = Router();

  // ── GET /overview ─────────────────────────────────────────────────────────
  router.get('/overview', async (_req, res) => {
    try {
      const dayStart = startOfUtcDay();
      // Typed Drizzle predicates (gte(column, Date)) know how to encode a Date.
      // Raw sql`` parameters do not carry that column encoder, and postgres-js
      // can therefore receive the Date object where it expects a string/Buffer.
      // Use one explicit ISO timestamptz parameter for the aggregate FILTERs.
      const dayStartIso = dayStart.toISOString();

      const emptyCallMetrics = {
        completedTotal: 0,
        completedToday: 0,
        placedTotal: 0,
        placedToday: 0,
        checkoutLinksTotal: 0,
        callSpendTotalUsd: 0,
        callSpendTodayUsd: 0,
      };

      // A broken call-metrics aggregate must never blank the entire Sales Ops
      // console. Isolate it from the rest of the overview so leads, email,
      // campaigns, autonomy, and LLM spend continue rendering.
      const callMetricsPromise = (async () => {
        try {
          return await db
            .select({
              completedTotal: sql<number>`count(*) filter (where ${logs.message} like '%Outbound call ended%')::int`,
              completedToday: sql<number>`count(*) filter (where ${logs.message} like '%Outbound call ended%' and ${logs.timestamp} >= CAST(${dayStartIso} AS timestamptz))::int`,
              placedTotal: sql<number>`count(*) filter (where ${logs.message} like '%Outbound call ringing%')::int`,
              placedToday: sql<number>`count(*) filter (where ${logs.message} like '%Outbound call ringing%' and ${logs.timestamp} >= CAST(${dayStartIso} AS timestamptz))::int`,
              checkoutLinksTotal: sql<number>`count(*) filter (where ${logs.message} like '%Checkout link created%')::int`,
              callSpendTotalUsd: sql<number>`coalesce(sum((substring(${logs.message} from ${CALL_COST_PATTERN}))::float8) filter (where ${logs.message} like '%Outbound call ended%'), 0)::float8`,
              callSpendTodayUsd: sql<number>`coalesce(sum((substring(${logs.message} from ${CALL_COST_PATTERN}))::float8) filter (where ${logs.message} like '%Outbound call ended%' and ${logs.timestamp} >= CAST(${dayStartIso} AS timestamptz)), 0)::float8`,
            })
            .from(logs)
            .where(eq(logs.agentId, SALES_AGENT_ID));
        } catch (err) {
          console.error('[sales-ops] call metrics unavailable:', errorMessage(err));
          return [emptyCallMetrics];
        }
      })();

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
        callMetricsPromise,
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

      const call = callRow[0] ?? emptyCallMetrics;

      const spend = getSpendLedgerSnapshot();
      /** Round currency ledger values to four decimal places for API output. */
      const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
      const runningCostTodayUsd = round4(spend.spentUsd + (call.callSpendTodayUsd ?? 0));

      /** Sum rows whose status represents an active campaign. */
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
        // Live LLM dollar spend telemetry. spend.enforced=false means the
        // legacy budget fields are informational and do not gate FlashX.
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
          spendCapEnforced: spend.enforced,
        },
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
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

      const customerNumber = normalizeE164(body.customerNumber);
      if (!customerNumber) {
        res
          .status(400)
          .json({ error: 'A valid destination phone number in E.164 format (e.g. +18328804970) is required.' });
        return;
      }

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

      type OutboundCallResult = {
        success?: boolean;
        error?: string;
        callId?: string;
        status?: string;
        [key: string]: unknown;
      };
      const callResult: OutboundCallResult =
        result.success && result.data && typeof result.data === 'object'
          ? (result.data as OutboundCallResult)
          : { success: false, error: result.error ?? 'Outbound call tool failed before reaching Vapi.' };
      const success = result.success && callResult.success !== false;

      // Leave an honest operator-action record next to the agent's own call logs.
      await db.insert(logs).values({
        agentId: SALES_AGENT_ID,
        taskId: null,
        level: success ? 'acting' : 'error',
        message: success
          ? `Operator placed an outbound call to ${customerName ? `${customerName} ` : ''}${customerNumber} from Sales Ops. Vapi call ID: ${callResult.callId ?? 'unknown'}. Initial status: ${callResult.status ?? 'unknown'}.`
          : `Operator outbound call to ${customerNumber} failed: ${callResult.error ?? result.error ?? 'unknown error'}`,
        timestamp: new Date(),
      });

      res.status(success ? 200 : 502).json(success ? callResult : { ...callResult, success: false });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── GET /call-outcomes — structured disposition/appointment records ─────────
  //
  // Everything an outbound call actually produced, as real rows rather than
  // the free-text lines the call-metrics aggregate above has to regex out of
  // `logs`. ?upcoming=true narrows to booked appointments not yet in the past,
  // soonest first — the "what do I need to show up for" view.
  router.get('/call-outcomes', async (req, res) => {
    try {
      const upcomingOnly = req.query.upcoming === 'true';
      const limitParam = Number(req.query.limit);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;

      const rows = upcomingOnly
        ? await db
            .select()
            .from(callOutcomes)
            .where(and(
              eq(callOutcomes.disposition, 'appointment_booked'),
              gte(callOutcomes.appointmentAt, new Date()),
            ))
            .orderBy(asc(callOutcomes.appointmentAt))
            .limit(limit)
        : await db
            .select()
            .from(callOutcomes)
            .orderBy(desc(callOutcomes.createdAt))
            .limit(limit);

      res.json({ outcomes: rows });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
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

      // Validate the complete request before changing global workforce settings.
      if (!['lead', 'campaign', 'pipeline'].includes(type)) {
        res.status(400).json({ error: 'target.type must be lead, campaign, or pipeline.' });
        return;
      }
      if (type !== 'pipeline' && (typeof target.id !== 'string' || !target.id.trim())) {
        res.status(400).json({ error: 'target.id is required for a lead or campaign target.' });
        return;
      }
      if (body.autonomyLevel !== undefined &&
          (typeof body.autonomyLevel !== 'string' || !Object.hasOwn(AUTONOMY_PRESETS, body.autonomyLevel))) {
        res.status(400).json({
          error: `Unknown autonomy level. Expected one of: ${Object.keys(AUTONOMY_PRESETS).join(', ')}.`,
        });
        return;
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

      // The target now exists and all input is valid; only now may the request
      // touch anything. Goal submission runs FIRST: it's the thing "automation
      // launched" actually means, so only a request that gets that far may go
      // on to change global autonomy or reschedule the CEO review job. The
      // reverse order let submitGoal throw AFTER the autonomy preset already
      // committed — an operator seeing "failed" on screen while the workforce's
      // autonomy level and goal-review cadence had already changed underneath
      // them.
      //
      // priority 2 — just under a hand-typed emergency goal, above routine work.
      const goalId = await ceo.submitGoal(title, description, 2);

      let autonomyApplied: string | null = null;
      if (body.autonomyLevel) {
        await applyAutonomyPreset(body.autonomyLevel);
        autonomyApplied = body.autonomyLevel;
      }

      res.status(201).json({
        ok: true,
        goalId,
        autonomyLevel: autonomyApplied,
        target: { type, id: target.id ?? null },
        message: `Automation launched. The Sales org will work this target autonomously${autonomyApplied ? ` at ${autonomyApplied} autonomy` : ''}.`,
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── GET /sms/threads — one row per conversation, most recent first ──────────
  router.get('/sms/threads', async (_req, res) => {
    try {
      const threads = (await db.execute(sql`
        select distinct on (counterparty_number)
          counterparty_number as "counterpartyNumber",
          body,
          direction,
          status,
          created_at as "createdAt"
        from sms_messages
        order by counterparty_number, created_at desc
      `)) as unknown as Array<{ createdAt: string }>;
      threads.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(threads);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── GET /sms/threads/:number — full two-way thread with one contact ─────────
  router.get('/sms/threads/:number', async (req, res) => {
    try {
      const number = req.params.number;
      const messages = await db
        .select()
        .from(smsMessages)
        .where(eq(smsMessages.counterpartyNumber, number))
        .orderBy(smsMessages.createdAt);
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ── POST /sms/send — one outbound SMS, immediately ───────────────────────────
  router.post('/sms/send', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { toNumber?: string; body?: string };

      const toNumber = normalizeE164(body.toNumber);
      if (!toNumber) {
        res.status(400).json({ error: 'A valid destination phone number in E.164 format (e.g. +18328804970) is required.' });
        return;
      }

      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!text) {
        res.status(400).json({ error: 'Message text is required.' });
        return;
      }

      const apiKey = process.env.TELNYX_API_KEY;
      const fromNumber = process.env.APEX_FRONT_DESK_NUMBER;
      if (!apiKey || !fromNumber) {
        res.status(500).json({ error: 'TELNYX_API_KEY or APEX_FRONT_DESK_NUMBER is not configured.' });
        return;
      }

      let providerId: string | undefined;
      let status = 'sent';
      let errorMsg: string | null = null;
      try {
        const smsRes = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: fromNumber, to: toNumber, text }),
        });
        const json = (await smsRes.json().catch(() => null)) as { data?: { id?: string } } | null;
        if (!smsRes.ok) {
          status = 'failed';
          errorMsg = `Telnyx returned ${smsRes.status}`;
        } else {
          providerId = json?.data?.id;
        }
      } catch (err) {
        status = 'failed';
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      const id = crypto.randomUUID();
      await db.insert(smsMessages).values({
        id,
        direction: 'outbound',
        counterpartyNumber: toNumber,
        fromNumber,
        toNumber,
        body: text,
        status,
        providerId,
        errorMessage: errorMsg,
        createdByAgentId: 'operator',
        createdAt: new Date(),
      });

      res.status(status === 'sent' ? 200 : 502).json({ success: status === 'sent', id, error: errorMsg ?? undefined });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}

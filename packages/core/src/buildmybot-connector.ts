import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { ICP_INDUSTRIES, isIcpIndustry, normalizeIndustry } from './industry-taxonomy.js';
import {
  apexLeadExternalId,
  apexLeadIdFromExternalId,
  isBuildMyBotLeadIngestConfigured,
  leadIngestNotConfigured,
  listBuildMyBotLeads,
  pushBuildMyBotLeads,
  type ApexIngestLead,
} from './buildmybot-lead-client.js';

// ─── BuildMyBot Connector ─────────────────────────────────────────────────────
//
// Gives APEX command-and-supervision authority over the BuildMyBot.app AI
// workforce (the persistent, role-specific agents served by the Railway-hosted
// Node/Express application). BuildMyBot persists product data in Supabase.
// APEX does not open that database. Lead handoff uses the authenticated
// ingest API in buildmybot-lead-client.ts. APEX is the portfolio-level
// commander; the BuildMyBot agents are its hands for that product.
//
// Command channel:  manager_briefings — every BuildMyBot role reads the
//                   latest briefing for today FIRST on its next shift and
//                   treats it as top priority. APEX writing a briefing is
//                   equivalent to the owner steering the whole team.
// Telemetry back:   ai_team_log (shift outcomes), error_logs (failures,
//                   ErrorRecoveryDashboard), escalations, leads.
// Direct trigger:   /api/cron/all-shifts and /api/cron/lead-followups,
//                   authenticated with the shared CRON_SECRET.
//
// Env (all in .env — see .env.example):
//   BUILDMYBOT_APP_URL               default https://www.buildmybot.app
//   BUILDMYBOT_API_BASE_URL          lead-ingest base URL; default https://www.buildmybot.app
//   BUILDMYBOT_LEAD_INGEST_TOKEN     bearer token for /api/integrations/apex/leads
//   BUILDMYBOT_CRON_SECRET           shared secret protecting BuildMyBot cron routes
//   BUILDMYBOT_RAILWAY_TOKEN         Railway API token (approval-gated redeploy tool)
//   BUILDMYBOT_RAILWAY_SERVICE_ID    defaults to 60b6d260-f5d8-463d-87be-58339545eaaf
//   BUILDMYBOT_RAILWAY_ENVIRONMENT_ID defaults to 6ce38db0-789b-4fe9-ad02-f068fe6866ae
//
// Security posture (updated 2026-07-23 — buildmybot2 promoted from monitored
// to MANAGED project): APEX's COO/Lead-Dev branch can now dispatch real
// engineering tasks into the buildmybot2 codebase (buildmybot_dispatch_
// engineering → Lead Developer, who lands changes via the existing
// approval-gated create_pull_request tool with repo
// 'patriotnewsactivism/buildmybot2'), manually retrigger Railway when required (approval-gated), and run live health
// checks against buildmybot.app. Railway normally auto-deploys merged main commits.
// Direct pushes to main remain off the table — code still lands through
// branch-protected PRs; the deploy hook only rebuilds what's merged.

const APP_URL = () => process.env.BUILDMYBOT_APP_URL ?? 'https://www.buildmybot.app';

/** Service-level BuildMyBot integration is available without database
 * credentials. Health, cron, and deploy controls talk to the application and
 * Railway APIs. Lead push and recent-lead reads use the ingest HTTP API.
 */
export function buildMyBotConfigured(): boolean {
  try {
    return new URL(APP_URL()).protocol === 'https:';
  } catch {
    return false;
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    sp.append(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/** Fail-closed stub for BuildMyBot tools that still have no API backend.
 * Status, briefings, and error logs stay filtered out below. Lead push and
 * recent-lead reads do not use this helper.
 */
async function sbFetch(
  _table: string,
  _query: string,
  _init?: RequestInit,
): Promise<any> {
  throw new Error(
    'BuildMyBot direct data-plane tool is retired: no API backend is available for this operation.',
  );
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ApexLeadForHandoff {
  id: string;
  companyName: string;
  website: string | null;
  industry: string | null;
  city: string | null;
  decisionMakerName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  fitReason: string | null;
  outreachAngle: string | null;
  researchedByAgentId: string | null;
  campaignId: string | null;
}

export interface BuildMyBotPushLoadResult {
  candidatesScanned: number;
  leads: ApexLeadForHandoff[];
}

export interface BuildMyBotPushDeps {
  loadCandidates: (input: {
    source: 'campaign' | 'backlog';
    campaignId?: string;
    limit: number;
  }) => Promise<BuildMyBotPushLoadResult>;
  markPushed: (ids: string[]) => Promise<void>;
}

let pushDepsOverride: BuildMyBotPushDeps | null = null;

/** Test-only seam. Production calls leave this unset and read APEX's own leads table. */
export function setBuildMyBotPushDepsForTests(deps: BuildMyBotPushDeps | null): void {
  pushDepsOverride = deps;
}

function toIngestLead(lead: ApexLeadForHandoff, source: 'campaign' | 'backlog'): ApexIngestLead {
  const notes = [lead.fitReason, lead.outreachAngle ? `Angle: ${lead.outreachAngle}` : null]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const tags = [normalizeIndustry(lead.industry), lead.city].filter((part): part is string => Boolean(part));
  return {
    externalId: apexLeadExternalId(lead.id),
    ...(lead.decisionMakerName ? { name: lead.decisionMakerName } : {}),
    ...(lead.contactEmail ? { email: lead.contactEmail } : {}),
    ...(lead.contactPhone ? { phone: lead.contactPhone } : {}),
    ...(lead.companyName ? { company: lead.companyName } : {}),
    ...(lead.website ? { website: lead.website } : {}),
    source: `apex:${source}${lead.campaignId ? `:${lead.campaignId}` : ''}`,
    ...(notes ? { notes } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

async function loadApexLeadsForPush(input: {
  source: 'campaign' | 'backlog';
  campaignId?: string;
  limit: number;
}): Promise<BuildMyBotPushLoadResult> {
  const { db, researchedLeads } = await import('@workspace/db');
  const { and, eq, isNull, isNotNull, desc } = await import('drizzle-orm');
  const cap = input.limit;
  const candidates = await db
    .select()
    .from(researchedLeads)
    .where(
      input.source === 'campaign'
        ? and(eq(researchedLeads.campaignId, input.campaignId!), eq(researchedLeads.status, 'new'))
        : and(
            isNull(researchedLeads.campaignId),
            eq(researchedLeads.status, 'new'),
            isNotNull(researchedLeads.website),
          ),
    )
    .orderBy(desc(researchedLeads.createdAt))
    .limit(input.source === 'backlog' ? cap * 20 : cap);

  const eligible = (input.source === 'backlog'
    ? candidates.filter((lead) => lead.website && isIcpIndustry(lead.industry))
    : candidates
  ).slice(0, cap);

  return {
    candidatesScanned: candidates.length,
    leads: eligible.map((lead) => ({
      id: lead.id,
      companyName: lead.companyName,
      website: lead.website,
      industry: lead.industry,
      city: lead.city,
      decisionMakerName: lead.decisionMakerName,
      contactEmail: lead.contactEmail,
      contactPhone: lead.contactPhone,
      fitReason: lead.fitReason,
      outreachAngle: lead.outreachAngle,
      researchedByAgentId: lead.researchedByAgentId,
      campaignId: lead.campaignId,
    })),
  };
}

async function markApexLeadsPushed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { db, researchedLeads } = await import('@workspace/db');
  const { inArray } = await import('drizzle-orm');
  await db
    .update(researchedLeads)
    .set({ status: 'pushed_to_buildmybot' })
    .where(inArray(researchedLeads.id, ids));
}

export function createBuildMyBotTools(): ToolDefinition[] {
  return [
    // ── Read: portfolio status snapshot ────────────────────────────────────
    {
      name: 'buildmybot_status',
      description:
        "Get today's BuildMyBot AI-workforce status: shift outcomes per role, open error count, open escalations, and lead pipeline counts. Read this BEFORE issuing any briefing or directive so commands are grounded in real telemetry.",
      schema: z.object({
        includeYesterday: z
          .boolean()
          .optional()
          .describe('Also include the prior day of shift logs for trend context'),
      }),
      requiresApproval: false,
      async execute({ includeYesterday: includeYesterday = false }) {
        const today = todayISO();
        const fromDate = includeYesterday
          ? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
          : today;

        const [shifts, openErrors, escalations, leadsNew, leadsAwaiting] = await Promise.all([
          sbFetch('ai_team_log', buildQuery({
            'shift_date': `gte.${fromDate}`,
            order: 'created_at.desc',
            limit: 60,
          })),
          sbFetch('error_logs', buildQuery({
            status: 'eq.open',
            order: 'created_at.desc',
            limit: 25,
            select: 'id,source,level,message,created_at',
          })),
          sbFetch('escalations', buildQuery({ order: 'created_at.desc', limit: 15 })).catch(() => []),
          sbFetch('leads', buildQuery({ created_at: `gte.${today}`, select: 'id', limit: 500 })).catch(() => []),
          sbFetch('leads', buildQuery({
            replied_at: 'is.null',
            follow_up_sent_at: 'not.is.null',
            select: 'id',
            limit: 500,
          })).catch(() => []),
        ]);

        return {
          date: today,
          shifts: (shifts ?? []).map((s: any) => ({
            role: s.role_name,
            summary: s.summary,
            tasks_completed: s.tasks_completed,
            flags: s.flags || undefined,
            escalated_to: s.escalated_to || undefined,
          })),
          open_errors: openErrors ?? [],
          escalations: escalations ?? [],
          leads_created_today: (leadsNew ?? []).length,
          leads_followed_up_awaiting_reply: (leadsAwaiting ?? []).length,
        };
      },
    },

    // ── Command: daily briefing to the whole workforce ─────────────────────
    {
      name: 'buildmybot_send_briefing',
      description:
        "Issue today's top-priority directive to EVERY BuildMyBot AI employee. Each role reads the latest briefing first on its next shift and prioritizes it above all other work. One row per day; the latest briefing wins. Use for steering (e.g. 'prioritize churn-risk leads today'), never for fabricating status.",
      schema: z.object({
        content: z
          .string()
          .describe('The directive text. Concrete and actionable; the whole team sees it verbatim.'),
      }),
      requiresApproval: true,
      async execute({ content: content = '' }) {
        const rows = await sbFetch('manager_briefings', '', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            briefing_date: todayISO(),
            content,
            delivered_via: 'apex',
          }),
        });
        return { saved: true, briefing: rows?.[0] ?? null };
      },
    },

    // ── Command: trigger workforce runs on demand ──────────────────────────
    {
      name: 'buildmybot_run_workforce',
      description:
        'Trigger a BuildMyBot worker run immediately instead of waiting for its cron slot: "shifts" runs all role shifts, "lead_followups" runs the 48h follow-up worker, "sales_outreach" runs the outreach agent that picks up researched leads and initiates first contact, "pulse" runs the 10-minute heartbeat. Use sales_outreach right after buildmybot_push_leads so pushed leads are worked without waiting. Requires BUILDMYBOT_CRON_SECRET.',
      schema: z.object({
        worker: z
          .enum(['shifts', 'lead_followups', 'sales_outreach', 'pulse', 'sms_overage'])
          .describe('Which worker to run'),
      }),
      requiresApproval: true,
      async execute({ worker: worker = 'shifts' }) {
        const secret = process.env.BUILDMYBOT_CRON_SECRET;
        if (!secret) throw new Error('BUILDMYBOT_CRON_SECRET is not configured');
        // These resolve through buildmybot2's dynamic cron routes mounted by the
        // Railway/Express runtime. This tool provides an on-demand trigger independent
        // of the recurring GitHub/BuildMyBot schedules. sms_overage (added 2026-09-06) also has its
        // own recurring trigger — buildmybot2's own GitHub Actions schedule
        // AND Apex's 'buildmybot_sms_overage' scheduled job — this tool slot
        // just gives any Apex agent an on-demand way to run it too.
        const paths: Record<typeof worker, string> = {
          shifts: '/api/cron/all-shifts',
          lead_followups: '/api/cron/lead-followups',
          sales_outreach: '/api/cron/sales-outreach',
          pulse: '/api/cron/pulse',
          sms_overage: '/api/cron/sms-overage',
        };
        const path = paths[worker];
        const res = await fetch(`${APP_URL()}${path}`, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        const body = await res.text();
        if (!res.ok) throw new Error(`Worker ${worker} returned ${res.status}: ${body.slice(0, 300)}`);
        return JSON.parse(body);
      },
    },

    // ── Read: drill into open failures ─────────────────────────────────────
    {
      name: 'buildmybot_open_errors',
      description:
        'List open (unresolved) BuildMyBot agent errors with full context, worst first. Use to decide what needs human attention vs. a corrective briefing.',
      schema: z.object({
        limit: z.number().optional().describe('Max rows (default 25)'),
      }),
      requiresApproval: false,
      async execute({ limit: limit = 25 }) {
        const rows = await sbFetch(
          'error_logs',
          buildQuery({ status: 'eq.open', order: 'level.asc,created_at.desc', limit: limit ?? 25 }),
        );
        return rows ?? [];
      },
    },

    // ── Write: resolve an error after review ───────────────────────────────
    {
      name: 'buildmybot_resolve_error',
      description:
        'Mark a BuildMyBot error_logs row as resolved after it has been reviewed and addressed. Only resolve errors you have actually verified are fixed — never to make dashboards look clean.',
      schema: z.object({
        errorId: z.string().describe('The error_logs row id (uuid)'),
        resolutionNote: z
          .string()
          .describe('What was done about it — stored in the error context for the audit trail'),
      }),
      requiresApproval: true,
      async execute({ errorId: errorId = '', resolutionNote: resolutionNote = '' }) {
        const existing = await sbFetch(
          'error_logs',
          buildQuery({ id: `eq.${errorId}`, select: 'id,context' }),
        );
        if (!existing?.length) throw new Error(`No error_logs row with id ${errorId}`);
        const context = {
          ...(existing[0].context ?? {}),
          apex_resolution: resolutionNote,
          apex_resolved_at: new Date().toISOString(),
        };
        await sbFetch('error_logs', buildQuery({ id: `eq.${errorId}` }), {
          method: 'PATCH',
          body: JSON.stringify({ status: 'resolved', context }),
        });
        return { resolved: true, errorId };
      },
    },

    // ── Manage: dispatch real engineering work into buildmybot2 ────────────
    //
    // This is what makes buildmybot2 a MANAGED project instead of a monitored
    // one: the COO/CEO can file a real engineering ticket that lands in the
    // same task queue the Lead Developer already works from, with full repo
    // context attached so the Lead Dev branch knows exactly which repo to
    // change, how to open the PR, and how to verify the deploy afterward.
    {
      name: 'buildmybot_dispatch_engineering',
      description:
        "Dispatch a real engineering task into the buildmybot2 codebase (github.com/patriotnewsactivism/buildmybot2). Creates a task assigned to the Lead Developer with full repo/deploy/health-check context attached — exactly like an internal Apex engineering ticket, not just a status read. The Lead Dev lands changes via the approval-gated create_pull_request tool; use buildmybot_deploy after merge and buildmybot_health_check to verify.",
      schema: z.object({
        title: z.string().describe('Short imperative ticket title'),
        spec: z
          .string()
          .describe(
            'Full engineering spec: what to change, where, acceptance criteria, and how to verify',
          ),
        priority: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe('1 (highest) – 10 (lowest); default 4'),
      }),
      requiresApproval: true, // Hard-gated in approval-policy.ts (HARD_GATED_TOOLS) -- fixed 2026-09-07, was incorrectly false. ToolRegistry.execute() now enforces the hard gate centrally regardless of this flag, but keeping it accurate here too so the registry-consistency guard actually means something.
      async execute({ title: title = '', spec: spec = '', priority: priority = 4 }) {
        const { randomUUID } = await import('crypto');
        const { db, tasks } = await import('@workspace/db');
        const now = new Date();
        const taskId = randomUUID();
        await db.insert(tasks).values({
          id: taskId,
          title,
          description: spec,
          status: 'pending',
          priority: priority ?? 4,
          assignedAgentId: 'apex-lead-dev-001',
          createdByAgentId: 'apex-coo-001',
          createdAt: now,
          updatedAt: now,
          retryCount: 0,
          maxRetries: 3,
          context: {
            project: 'buildmybot2',
            repo: 'patriotnewsactivism/buildmybot2',
            repoUrl: 'https://github.com/patriotnewsactivism/buildmybot2',
            prInstructions:
              "Land changes via create_pull_request with repo 'patriotnewsactivism/buildmybot2' — never direct pushes to main",
            deployInstructions:
              'Railway auto-deploys merged main commits; use buildmybot_deploy only to manually retrigger production when needed',
            healthCheckUrl: `${APP_URL()}/api/health`,
          },
        });
        return {
          success: true,
          taskId,
          assignedTo: 'apex-lead-dev-001',
          project: 'buildmybot2',
          message: `Engineering task dispatched into buildmybot2: ${title}`,
        };
      },
    },

    // ── Manage: manually retrigger the Railway production service ───────────
    {
      name: 'buildmybot_deploy',
      description:
        'Manually retrigger the Railway production service for buildmybot2. Railway normally auto-deploys merged main commits, so use this only for an explicit recovery/redeploy. Requires BUILDMYBOT_RAILWAY_TOKEN and approval.',
      schema: z.object({
        reason: z
          .string()
          .describe('Why this Railway redeploy is being triggered (audit trail)'),
      }),
      requiresApproval: true,
      async execute({ reason: reason = '' }) {
        const token = process.env.BUILDMYBOT_RAILWAY_TOKEN;
        if (!token) throw new Error('BUILDMYBOT_RAILWAY_TOKEN is not configured');
        const serviceId = process.env.BUILDMYBOT_RAILWAY_SERVICE_ID ?? '60b6d260-f5d8-463d-87be-58339545eaaf';
        const environmentId = process.env.BUILDMYBOT_RAILWAY_ENVIRONMENT_ID ?? '6ce38db0-789b-4fe9-ad02-f068fe6866ae';
        const query = 'mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }';
        const res = await fetch('https://backboard.railway.com/graphql/v2', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { environmentId, serviceId } }),
          signal: AbortSignal.timeout(15_000),
        });
        const payload = await res.json().catch(() => null) as
          | { data?: { serviceInstanceRedeploy?: boolean }; errors?: Array<{ message?: string }> }
          | null;
        const railwayError = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ');
        if (!res.ok || railwayError || payload?.data?.serviceInstanceRedeploy !== true) {
          throw new Error('Railway redeploy failed (' + res.status + '): ' + (railwayError || 'unexpected response'));
        }
        return { success: true, platform: 'railway', reason, serviceId, environmentId };
      },
    },
    // ── Manage: live health check against the deployed product ─────────────
    {
      name: 'buildmybot_health_check',
      description:
        'Live HTTP health check against the deployed buildmybot.app API (/api/health). Use after a deploy, and as the buildmybot2 leg of any portfolio health sweep. Reports real HTTP status and latency — never a guess.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const url = `${APP_URL()}/api/health`;
        const started = Date.now();
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          const ms = Date.now() - started;
          const text = await res.text();
          let parsed: any = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* non-JSON body — report raw */
          }
          return {
            healthy: res.ok && parsed?.status === 'ok',
            httpStatus: res.status,
            latencyMs: ms,
            url,
            body: parsed ?? text.slice(0, 300),
          };
        } catch (err: any) {
          return {
            healthy: false,
            httpStatus: 0,
            latencyMs: Date.now() - started,
            url,
            error: err?.message ?? String(err),
          };
        }
      },
    },

    // ── Bridge: push Apex-researched leads into BuildMyBot's pipeline ──────
    //
    // Posts to BuildMyBot's lead ingest API. Each APEX lead keeps a stable
    // externalId (`apex:<researched_leads.id>`) so a retry is idempotent.
    // dryRun defaults to true. A live push is hard-gated in approval-policy.ts
    // and ToolRegistry.execute, the same gate used by other outbound tools.
    // This tool does not email or call anyone.
    {
      name: 'buildmybot_push_leads',
      description:
        "Push Apex-researched leads into BuildMyBot through POST /api/integrations/apex/leads. dryRun defaults to true and does not write. Set dryRun=false for a real push; that call is approval-gated. Use source='campaign' with a campaignId, or source='backlog' for pre-campaign ICP leads that have a website. Retries reuse a stable externalId per APEX lead. Nothing is emailed or called by this tool. Requires BUILDMYBOT_LEAD_INGEST_TOKEN.",
      schema: z.object({
        source: z
          .enum(['campaign', 'backlog'])
          .describe("'campaign' pushes one campaign's leads; 'backlog' pushes pre-campaign leads that match the ICP."),
        campaignId: z.string().optional().describe("Required when source='campaign'."),
        orgId: z.string().optional().describe('BuildMyBot organization id, when the ingest API should scope the write.'),
        ownerEmail: z.string().optional().describe('BuildMyBot owner email, when orgId is not used.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Max APEX leads this call (default 50). Requests are chunked at 200 for the ingest API.'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Default true. Preview the handoff without writing. Set false for a real, approval-gated push.'),
      }),
      requiresApproval: true, // Hard-gated in approval-policy.ts. ToolRegistry.execute enforces that gate before this body runs.
      async execute(input: {
        source?: 'campaign' | 'backlog';
        campaignId?: string;
        orgId?: string;
        ownerEmail?: string;
        limit?: number;
        dryRun?: boolean;
      }) {
        const source = input.source ?? 'backlog';
        const campaignId = input.campaignId ?? '';
        const orgId = input.orgId;
        const ownerEmail = input.ownerEmail;
        const limit = input.limit ?? 50;
        const dryRun = input.dryRun ?? true;
        const live = dryRun === false;
        if (!isBuildMyBotLeadIngestConfigured()) return leadIngestNotConfigured(!live);

        if (source === 'campaign' && !campaignId) {
          throw new Error("source='campaign' requires a campaignId. Use source='backlog' for pre-campaign leads.");
        }
        const cap = limit ?? 50;
        const loaded = pushDepsOverride
          ? await pushDepsOverride.loadCandidates({ source, campaignId, limit: cap })
          : await loadApexLeadsForPush({ source, campaignId, limit: cap });
        const leads = loaded.leads.slice(0, cap);
        const ingestLeads = leads.map((lead) => toIngestLead(lead, source));
        const byIndustry: Record<string, number> = {};
        for (const lead of leads) {
          const key = normalizeIndustry(lead.industry) ?? 'Unknown';
          byIndustry[key] = (byIndustry[key] ?? 0) + 1;
        }

        const apiResult = await pushBuildMyBotLeads({
          orgId,
          ownerEmail,
          dryRun: !live,
          leads: ingestLeads,
        });

        let markedPushed = 0;
        if (live && apiResult.appliedExternalIds.length > 0) {
          const ids = apiResult.appliedExternalIds
            .map((externalId) => apexLeadIdFromExternalId(externalId))
            .filter((id): id is string => Boolean(id));
          const mark = pushDepsOverride?.markPushed ?? markApexLeadsPushed;
          await mark(ids);
          markedPushed = ids.length;
        }

        return {
          ...apiResult,
          source,
          campaignId: campaignId || undefined,
          candidatesScanned: loaded.candidatesScanned,
          eligible: leads.length,
          markedPushed,
          byIndustry,
          icpFilter: source === 'backlog' ? ICP_INDUSTRIES : 'not applied (campaign leads are already on-ICP)',
          sample: leads.slice(0, 5).map((lead) => ({
            externalId: apexLeadExternalId(lead.id),
            companyName: lead.companyName,
            website: lead.website,
            industry: normalizeIndustry(lead.industry),
            city: lead.city,
          })),
          note: live
            ? 'Live push sent leads to BuildMyBot. This tool does not email or call anyone.'
            : 'Dry run only. No leads were written. Set dryRun=false for a real push; that call stays approval-gated.',
        };
      },
    },

    // ── Maintenance: normalize the legacy industry strings ─────────────────
    {
      name: 'normalize_lead_industries',
      description:
        'Rewrite the industry field on researched leads onto the canonical taxonomy. The pre-campaign rows carry hundreds of distinct spellings of the same handful of industries, which makes every industry filter and count unreliable. Idempotent — running it twice changes nothing the second time.',
      schema: z.object({
        dryRun: z.boolean().optional().describe('Report what would change without writing.'),
      }),
      requiresApproval: false,
      async execute({ dryRun: dryRun = false }) {
        const { db, researchedLeads } = await import('@workspace/db');
        const { eq } = await import('drizzle-orm');

        const rows = await db
          .select({ id: researchedLeads.id, industry: researchedLeads.industry })
          .from(researchedLeads);

        const before = new Set(rows.map((r) => r.industry ?? '(null)'));
        let changed = 0;
        const changes: Array<{ from: string; to: string }> = [];

        for (const row of rows) {
          const normalized = normalizeIndustry(row.industry);
          if (!normalized || normalized === row.industry) continue;
          if (changes.length < 15) changes.push({ from: row.industry ?? '', to: normalized });
          changed++;
          if (!dryRun) {
            await db
              .update(researchedLeads)
              .set({ industry: normalized })
              .where(eq(researchedLeads.id, row.id));
          }
        }

        const after = new Set(
          rows.map((r) => normalizeIndustry(r.industry) ?? r.industry ?? '(null)'),
        );
        return {
          dryRun: dryRun === true,
          rowsScanned: rows.length,
          rowsChanged: changed,
          distinctIndustriesBefore: before.size,
          distinctIndustriesAfter: after.size,
          sampleChanges: changes,
        };
      },
    },

    // ── Read: leads already visible to the ingest API ──────────────────────
    {
      name: 'buildmybot_recent_leads',
      description:
        'List leads from BuildMyBot GET /api/integrations/apex/leads. Pass orgId or ownerEmail, and optional since/limit. Requires BUILDMYBOT_LEAD_INGEST_TOKEN. Returns a not-configured result when the token is unset.',
      schema: z.object({
        orgId: z.string().optional().describe('BuildMyBot organization id'),
        ownerEmail: z.string().optional().describe('BuildMyBot owner email, when orgId is not used'),
        since: z.string().optional().describe('ISO timestamp lower bound'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 20)'),
      }),
      requiresApproval: false,
      async execute(input: { orgId?: string; ownerEmail?: string; since?: string; limit?: number }) {
        return listBuildMyBotLeads({
          orgId: input.orgId,
          ownerEmail: input.ownerEmail,
          since: input.since,
          limit: input.limit ?? 20,
        });
      },
    },
  ].filter((tool) => {
    // Status, briefings, and error tools still have no BuildMyBot API.
    // They stay unregistered. Lead push and recent-lead reads are served
    // by the ingest client above.
    const retiredWithoutBackend = new Set([
      'buildmybot_status',
      'buildmybot_send_briefing',
      'buildmybot_open_errors',
      'buildmybot_resolve_error',
    ]);
    return !retiredWithoutBackend.has(tool.name);
  });
}

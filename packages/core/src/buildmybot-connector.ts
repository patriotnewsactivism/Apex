import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { ICP_INDUSTRIES, isIcpIndustry, normalizeIndustry } from './industry-taxonomy.js';

// ─── BuildMyBot Connector ─────────────────────────────────────────────────────
//
// Gives APEX command-and-supervision authority over the BuildMyBot.app AI
// workforce (the persistent, role-specific agents that run as Vercel cron
// workers backed by Supabase). APEX is the portfolio-level commander; the
// BuildMyBot agents are its hands for that product.
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
//   BUILDMYBOT_SUPABASE_URL          e.g. https://evkjlnbpntimbxklnhoz.supabase.co
//   BUILDMYBOT_SUPABASE_SERVICE_KEY  service-role key (server-side only, never
//                                    committed; APEX runs on the owner's machine)
//   BUILDMYBOT_APP_URL               default https://www.buildmybot.app
//   BUILDMYBOT_CRON_SECRET           same value as Vercel's CRON_SECRET
//   BUILDMYBOT_VERCEL_DEPLOY_HOOK    Vercel deploy-hook URL for the
//                                    buildmybot2 project (managed-project
//                                    deploy authority; approval-gated tool)
//
// Security posture (updated 2026-07-23 — buildmybot2 promoted from monitored
// to MANAGED project): APEX's COO/Lead-Dev branch can now dispatch real
// engineering tasks into the buildmybot2 codebase (buildmybot_dispatch_
// engineering → Lead Developer, who lands changes via the existing
// approval-gated create_pull_request tool with repo
// 'patriotnewsactivism/buildmybot2'), trigger deploys via the Vercel deploy
// hook (approval-gated), and run live health checks against buildmybot.app.
// Direct pushes to main remain off the table — code still lands through
// branch-protected PRs; the deploy hook only rebuilds what's merged.

const SUPABASE_URL = () => process.env.BUILDMYBOT_SUPABASE_URL ?? '';
const SERVICE_KEY = () => process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY ?? '';
const APP_URL = () => process.env.BUILDMYBOT_APP_URL ?? 'https://www.buildmybot.app';

export function buildMyBotConfigured(): boolean {
  const url = SUPABASE_URL();
  const key = SERVICE_KEY();
  if (!url || !key) return false;
  // Guard against a common Railway misconfiguration: if the "URL" starts with
  // eyJ it's a base64-encoded JWT (i.e. the env vars are swapped — the service
  // key ended up in BUILDMYBOT_SUPABASE_URL). Fail-safe here so the broken
  // tools are never registered rather than surfacing a cryptic fetch error.
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
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

/** Thin Supabase REST helper (PostgREST). Throws on non-2xx. */
async function sbFetch(
  table: string,
  query: string,
  init?: RequestInit,
): Promise<any> {
  const baseUrl = SUPABASE_URL();
  // Fail early with a clear message instead of "Failed to parse URL from eyJ…"
  // which happens when BUILDMYBOT_SUPABASE_URL and BUILDMYBOT_SUPABASE_SERVICE_KEY
  // are swapped in the environment — the service-role JWT token ends up as the
  // URL, and Node's fetch can't parse it.
  if (!baseUrl.startsWith('https://')) {
    throw new Error(
      `BUILDMYBOT_SUPABASE_URL must be an https:// project URL ` +
      `(e.g. https://xyz.supabase.co). Got: "${baseUrl.slice(0, 30)}…". ` +
      `BUILDMYBOT_SUPABASE_URL and BUILDMYBOT_SUPABASE_SERVICE_KEY may be swapped in your env.`,
    );
  }
  const url = `${baseUrl}/rest/v1/${table}${query}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BuildMyBot Supabase ${res.status} on ${table}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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
      async execute({ includeYesterday }) {
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
      async execute({ content }) {
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
          .enum(['shifts', 'lead_followups', 'sales_outreach', 'pulse'])
          .describe('Which worker to run'),
      }),
      requiresApproval: true,
      async execute({ worker }) {
        const secret = process.env.BUILDMYBOT_CRON_SECRET;
        if (!secret) throw new Error('BUILDMYBOT_CRON_SECRET is not configured');
        // Every one of these resolves through buildmybot2's single dynamic
        // cron route (api/cron/[job].ts), which exists to stay under Vercel's
        // Hobby 12-function cap. sales-outreach in particular has NO
        // vercel.json cron entry, so this tool is the only thing that runs it
        // short of a manual curl.
        const paths: Record<typeof worker, string> = {
          shifts: '/api/cron/all-shifts',
          lead_followups: '/api/cron/lead-followups',
          sales_outreach: '/api/cron/sales-outreach',
          pulse: '/api/cron/pulse',
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
      async execute({ limit }) {
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
      async execute({ errorId, resolutionNote }) {
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
      requiresApproval: false,
      async execute({ title, spec, priority }) {
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
              'After merge, request buildmybot_deploy (approval-gated Vercel deploy hook)',
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

    // ── Manage: trigger a production deploy via Vercel deploy hook ─────────
    {
      name: 'buildmybot_deploy',
      description:
        'Trigger a production rebuild+deploy of buildmybot2 via its Vercel deploy hook. Only rebuilds what is already merged to the production branch — this is NOT a way around PR review. Requires BUILDMYBOT_VERCEL_DEPLOY_HOOK and approval.',
      schema: z.object({
        reason: z
          .string()
          .describe('Why this deploy is being triggered (audit trail)'),
      }),
      requiresApproval: true,
      async execute({ reason }) {
        const hook = process.env.BUILDMYBOT_VERCEL_DEPLOY_HOOK;
        if (!hook) throw new Error('BUILDMYBOT_VERCEL_DEPLOY_HOOK is not configured');
        const res = await fetch(hook, { method: 'POST' });
        const body = await res.text();
        if (!res.ok) {
          throw new Error(`Deploy hook returned ${res.status}: ${body.slice(0, 300)}`);
        }
        return { success: true, reason, response: body.slice(0, 500) };
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
    // THE gap this closes. Apex and BuildMyBot each have a researched_leads
    // table in a DIFFERENT Supabase project, with different column names:
    //
    //   Apex (zvbypuo…)          BuildMyBot (evkjlnb…)
    //   fit_reason               why_good_fit
    //   outreach_angle           suggested_angle
    //   researched_by_agent_id   researched_by
    //   —                        source_query, surfaced_to_sales_at
    //
    // api/cron/_sales-outreach.ts (Jordan Blake) is the ONLY thing in either
    // system that sends a real email or places a real call, and it reads
    // BuildMyBot's table. So every lead Apex ever researched sat somewhere
    // that worker cannot see — 4,722 of them, all still status='new', while
    // BuildMyBot's own copy went stale on 2026-07-21.
    //
    // Safety: BuildMyBot's SALES_AUTOMATION_DRY_RUN defaults to TRUE, so
    // pushing queues leads without sending anything. Turning outbound on is a
    // separate, deliberate act. This tool is approval-gated and batch-capped
    // regardless — it is the step where Apex's work becomes contact with real
    // businesses.
    {
      name: 'buildmybot_push_leads',
      description:
        "Push Apex-researched leads into BuildMyBot's sales pipeline so the outreach agent can work them. Handles the column mapping between the two systems and de-dupes on website. Use source='campaign' with a campaignId to hand off one campaign's output, or source='backlog' for pre-campaign leads (those are filtered to ICP industries with a real website). Nothing is sent to a business by this tool — it queues leads for BuildMyBot's outreach worker, which is itself dry-run gated.",
      schema: z.object({
        source: z
          .enum(['campaign', 'backlog'])
          .describe("'campaign' pushes one campaign's leads; 'backlog' pushes pre-campaign leads that match the ICP."),
        campaignId: z.string().optional().describe("Required when source='campaign'."),
        limit: z
          .number()
          .min(1)
          .max(200)
          .optional()
          .describe('Max leads this push (default 50). Deliberately capped — outreach deliverability degrades on bulk dumps.'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Preview what WOULD be pushed without writing anything. Use this first on the backlog.'),
      }),
      requiresApproval: true,
      async execute({ source, campaignId, limit, dryRun }) {
        const { db, researchedLeads } = await import('@workspace/db');
        const { and, eq, isNull, isNotNull, desc } = await import('drizzle-orm');

        if (source === 'campaign' && !campaignId) {
          throw new Error("source='campaign' requires a campaignId. Use source='backlog' for pre-campaign leads.");
        }
        const cap = limit ?? 50;

        // Pull a wider slice than the cap for the backlog: ICP filtering runs
        // in JS (via the taxonomy) so selection does not depend on whether the
        // stored industry strings have been normalized yet.
        const candidates = await db
          .select()
          .from(researchedLeads)
          .where(
            source === 'campaign'
              ? and(eq(researchedLeads.campaignId, campaignId!), eq(researchedLeads.status, 'new'))
              : and(
                  isNull(researchedLeads.campaignId),
                  eq(researchedLeads.status, 'new'),
                  isNotNull(researchedLeads.website),
                ),
          )
          .orderBy(desc(researchedLeads.createdAt))
          .limit(source === 'backlog' ? cap * 20 : cap);

        const eligible = (source === 'backlog'
          ? candidates.filter((l) => l.website && isIcpIndustry(l.industry))
          : candidates
        ).slice(0, cap);

        if (dryRun) {
          const byIndustry: Record<string, number> = {};
          for (const l of eligible) {
            const key = normalizeIndustry(l.industry) ?? 'Unknown';
            byIndustry[key] = (byIndustry[key] ?? 0) + 1;
          }
          return {
            dryRun: true,
            source,
            candidatesScanned: candidates.length,
            wouldPush: eligible.length,
            byIndustry,
            icpFilter: source === 'backlog' ? ICP_INDUSTRIES : 'not applied (campaign leads are already on-ICP)',
            sample: eligible.slice(0, 5).map((l) => ({
              companyName: l.companyName,
              website: l.website,
              industry: normalizeIndustry(l.industry),
              city: l.city,
            })),
          };
        }

        let pushed = 0;
        let skipped = 0;
        const failures: string[] = [];

        for (const lead of eligible) {
          try {
            // resolution=ignore-duplicates leans on BuildMyBot's UNIQUE index
            // on website — Postgres does the de-dup, not a read-then-write
            // race across two databases.
            await sbFetch('researched_leads', '', {
              method: 'POST',
              headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
              body: JSON.stringify({
                company_name: lead.companyName,
                website: lead.website,
                industry: normalizeIndustry(lead.industry),
                city: lead.city,
                why_good_fit: lead.fitReason,
                suggested_angle: lead.outreachAngle,
                source_query: `apex:${source}${campaignId ? `:${campaignId}` : ''}`,
                researched_by: lead.researchedByAgentId,
                status: 'new',
              }),
            });

            await db
              .update(researchedLeads)
              .set({ status: 'pushed_to_buildmybot' })
              .where(eq(researchedLeads.id, lead.id));
            pushed++;
          } catch (err) {
            skipped++;
            const msg = err instanceof Error ? err.message : String(err);
            if (failures.length < 5) failures.push(`${lead.companyName}: ${msg.slice(0, 120)}`);
          }
        }

        return {
          source,
          campaignId,
          candidatesScanned: candidates.length,
          eligible: eligible.length,
          pushed,
          skipped,
          failures: failures.length > 0 ? failures : undefined,
          note:
            `${pushed} lead(s) queued in BuildMyBot's researched_leads. The outreach worker ` +
            `(api/cron/_sales-outreach.ts) picks these up on its next run. Nothing has been sent yet — ` +
            `SALES_AUTOMATION_DRY_RUN must be explicitly set to false before any real email or call goes out.`,
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
      async execute({ dryRun }) {
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

    // ── Read: lead pipeline detail ─────────────────────────────────────────
    {
      name: 'buildmybot_recent_leads',
      description:
        'List recent BuildMyBot CRM leads with follow-up state (created, followed-up, replied). Use for pipeline supervision and to ground sales directives.',
      schema: z.object({
        limit: z.number().optional().describe('Max rows (default 20)'),
        onlyUnreplied: z
          .boolean()
          .optional()
          .describe('Only leads that have not replied yet'),
      }),
      requiresApproval: false,
      async execute({ limit, onlyUnreplied }) {
        const rows = await sbFetch(
          'leads',
          buildQuery({
            order: 'created_at.desc',
            limit: limit ?? 20,
            ...(onlyUnreplied ? { replied_at: 'is.null' } : {}),
            select: 'id,name,email,status,source,created_at,replied_at,follow_up_sent_at,last_ai_action_at',
          }),
        );
        return rows ?? [];
      },
    },
  ];
}

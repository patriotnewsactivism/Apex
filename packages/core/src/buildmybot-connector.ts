import { z } from 'zod';
import type { ToolDefinition } from './types.js';

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
//
// Security posture: APEX gets NO GitHub write access and NO deploy authority
// over BuildMyBot. It commands via data (briefings), reads telemetry, and can
// trigger a run — nothing else. Deployment stays behind branch-protected PRs.

const SUPABASE_URL = () => process.env.BUILDMYBOT_SUPABASE_URL ?? '';
const SERVICE_KEY = () => process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY ?? '';
const APP_URL = () => process.env.BUILDMYBOT_APP_URL ?? 'https://www.buildmybot.app';

export function buildMyBotConfigured(): boolean {
  return Boolean(SUPABASE_URL() && SERVICE_KEY());
}

/** Thin Supabase REST helper (PostgREST). Throws on non-2xx. */
async function sbFetch(
  table: string,
  query: string,
  init?: RequestInit,
): Promise<any> {
  const url = `${SUPABASE_URL()}/rest/v1/${table}${query ? `?${query}` : ''}`;
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
        const dateFilter = includeYesterday
          ? `shift_date=gte.${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`
          : `shift_date=eq.${today}`;

        const [shifts, openErrors, escalations, leadsNew, leadsAwaiting] = await Promise.all([
          sbFetch('ai_team_log', `${dateFilter}&order=created_at.desc&limit=60`),
          sbFetch(
            'error_logs',
            'status=eq.open&order=created_at.desc&limit=25&select=id,source,level,message,created_at',
          ),
          sbFetch('escalations', 'order=created_at.desc&limit=15').catch(() => []),
          sbFetch('leads', `created_at=gte.${today}&select=id&limit=500`).catch(() => []),
          sbFetch(
            'leads',
            'replied_at=is.null&follow_up_sent_at=not.is.null&select=id&limit=500',
          ).catch(() => []),
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
        'Trigger a BuildMyBot worker run immediately instead of waiting for its cron slot: "shifts" runs all role shifts, "lead_followups" runs the autonomous lead follow-up worker. Requires BUILDMYBOT_CRON_SECRET.',
      schema: z.object({
        worker: z
          .enum(['shifts', 'lead_followups'])
          .describe('Which worker to run'),
      }),
      requiresApproval: true,
      async execute({ worker }) {
        const secret = process.env.BUILDMYBOT_CRON_SECRET;
        if (!secret) throw new Error('BUILDMYBOT_CRON_SECRET is not configured');
        const path = worker === 'shifts' ? '/api/cron/all-shifts' : '/api/cron/lead-followups';
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
          `status=eq.open&order=level.asc,created_at.desc&limit=${limit ?? 25}`,
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
          `id=eq.${errorId}&select=id,context`,
        );
        if (!existing?.length) throw new Error(`No error_logs row with id ${errorId}`);
        const context = {
          ...(existing[0].context ?? {}),
          apex_resolution: resolutionNote,
          apex_resolved_at: new Date().toISOString(),
        };
        await sbFetch('error_logs', `id=eq.${errorId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'resolved', context }),
        });
        return { resolved: true, errorId };
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
        const filter = onlyUnreplied ? '&replied_at=is.null' : '';
        const rows = await sbFetch(
          'leads',
          `order=created_at.desc&limit=${limit ?? 20}${filter}` +
            '&select=id,name,email,status,source,created_at,replied_at,follow_up_sent_at,last_ai_action_at',
        );
        return rows ?? [];
      },
    },
  ];
}

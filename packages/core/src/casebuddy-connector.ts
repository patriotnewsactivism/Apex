import { z } from 'zod';
import type { ToolDefinition } from './types.js';

// ─── CaseBuddy Connector ──────────────────────────────────────────────────────
//
// Gives APEX command-and-supervision authority over the CaseBuddy legal AI
// platform (casebuddy.live). CaseBuddy has 8 operational agents (Maya intake,
// Lex research, Doc drafting, Rex trial coaching, Sol deadlines, Sierra comms,
// Jules jury psychology, Max e-filing) + 12 legal specialist personas. Its
// "Deploy the Firm" orchestration fans out to all agents on a case, producing
// work products (motions, research, strategies, intake summaries) stored in
// Supabase with Realtime.
//
// The key gap APEX fills: CaseBuddy's agent engine currently runs in the
// browser (setInterval + localStorage) — agents die when the tab closes. APEX
// creates firm_runs server-side (durable in Supabase), monitors work_products
// for results, and health-checks the deployed product. As CaseBuddy migrates
// its agent execution to server-side, the firm_runs APEX creates will be
// picked up automatically — zero connector change needed.
//
// Telemetry back: cases (jsonb data column), intake_cases (client intake
// pipeline), firm_runs (orchestration status), work_products (agent outputs).
// Command channel: firm_runs (create one = dispatch the firm on a case).
//
// Env (all in .env — see .env.example):
//   CASEBUDDY_SUPABASE_URL          e.g. https://xxxxx.supabase.co
//   CASEBUDDY_SUPABASE_SERVICE_KEY  service-role key (server-side only)
//   CASEBUDDY_APP_URL               default https://casebuddy.live
//   CASEBUDDY_SYSTEM_USER_ID        a CaseBuddy user UUID to create firm_runs as
//                                    (required for casebuddy_deploy_firm)

const SUPABASE_URL = () => process.env.CASEBUDDY_SUPABASE_URL ?? '';
const SERVICE_KEY = () => process.env.CASEBUDDY_SUPABASE_SERVICE_KEY ?? '';
const APP_URL = () => process.env.CASEBUDDY_APP_URL ?? 'https://casebuddy.live';

export function caseBuddyConfigured(): boolean {
  const url = SUPABASE_URL();
  const key = SERVICE_KEY();
  if (!url || !key) return false;
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
  if (!baseUrl.startsWith('https://')) {
    throw new Error(
      `CASEBUDDY_SUPABASE_URL must be an https:// project URL. ` +
      `Got: "${baseUrl.slice(0, 30)}…". Check that env vars are not swapped.`,
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
    throw new Error(`CaseBuddy Supabase ${res.status} on ${table}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function createCaseBuddyTools(): ToolDefinition[] {
  return [
    // ── Read: portfolio status snapshot ────────────────────────────────────
    {
      name: 'casebuddy_status',
      description:
        "Get CaseBuddy platform status: case count by status, recent firm runs (Deploy the Firm), pending/working work products, and intake pipeline counts. Read this BEFORE dispatching agents or issuing directives so commands are grounded in real case data.",
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const [cases, recentRuns, pendingWork, intakes] = await Promise.all([
          sbFetch('cases', buildQuery({ select: 'id,updated_at', order: 'updated_at.desc', limit: 500 })).catch(() => []),
          sbFetch('firm_runs', buildQuery({ order: 'created_at.desc', limit: 10 })).catch(() => []),
          sbFetch('work_products', buildQuery({ status: 'in.(queued,working)', order: 'started_at.desc', limit: 20 })).catch(() => []),
          sbFetch('intake_cases', buildQuery({ order: 'created_at.desc', limit: 20 })).catch(() => []),
        ]);

        const caseList = cases ?? [];
        const runs = recentRuns ?? [];
        const work = pendingWork ?? [];
        const intakeList = intakes ?? [];

        // Count intakes by status
        const intakeStatus: Record<string, number> = {};
        for (const i of intakeList) {
          const s = i.status || 'unknown';
          intakeStatus[s] = (intakeStatus[s] || 0) + 1;
        }

        return {
          total_cases: caseList.length,
          recent_firm_runs: runs.map((r: any) => ({
            id: r.id,
            case_id: r.case_id,
            status: r.status,
            specialist: r.specialist_id,
            created_at: r.created_at,
            completed_at: r.completed_at,
          })),
          pending_work_products: work.map((w: any) => ({
            agent: w.agent_name,
            task: w.task_id,
            title: w.title,
            status: w.status,
          })),
          intakes: {
            total: intakeList.length,
            by_status: intakeStatus,
          },
        };
      },
    },

    // ── Read: list cases ─────────────────────────────────────────────────────
    {
      name: 'casebuddy_list_cases',
      description:
        'List CaseBuddy cases with title, client, status, case type, and win probability. Cases are stored as jsonb in the `data` column — this extracts the key fields for a dashboard view.',
      schema: z.object({
        limit: z.number().optional().describe('Max rows (default 25)'),
        status: z.string().optional().describe('Filter by case status (Pre-Trial, Discovery, Trial, Appeal, Closed)'),
      }),
      requiresApproval: false,
      async execute({ limit, status }) {
        const params: Record<string, string | number> = {
          order: 'updated_at.desc',
          limit: limit ?? 25,
        };
        if (status) params['data->>status'] = `eq.${status}`;
        const rows = await sbFetch('cases', buildQuery(params));
        return (rows ?? []).map((r: any) => {
          const d = r.data || {};
          return {
            id: r.id,
            title: d.title,
            client: d.client,
            status: d.status,
            caseType: d.caseType,
            winProbability: d.winProbability,
            nextCourtDate: d.nextCourtDate,
            assignedSpecialist: d.assignedSpecialistId,
            updated_at: r.updated_at,
          };
        });
      },
    },

    // ── Read: get full case details ─────────────────────────────────────────
    {
      name: 'casebuddy_get_case',
      description:
        'Get full case details from CaseBuddy, including the complete jsonb data (summary, opposing counsel, judge, evidence, timeline, strategy notes, etc.). Use before dispatching agents or writing case strategy.',
      schema: z.object({
        caseId: z.string().describe('The case ID'),
      }),
      requiresApproval: false,
      async execute({ caseId }) {
        const rows = await sbFetch('cases', buildQuery({ id: `eq.${caseId}` }));
        if (!rows?.length) throw new Error(`No case found with id ${caseId}`);
        return { id: rows[0].id, ...rows[0].data, updated_at: rows[0].updated_at };
      },
    },

    // ── Command: deploy the firm on a case ──────────────────────────────────
    {
      name: 'casebuddy_deploy_firm',
      description:
        "Dispatch the full CaseBuddy agent workforce on a case — creates a firm_run (the durable Supabase record that triggers 'Deploy the Firm'). All 8 operational agents (Maya, Lex, Doc, Rex, Sol, Sierra, Jules, Max) produce work products: intake summary, legal research, deadline analysis, draft motions, jury analysis, trial strategy, client letter, e-filing check. Requires CASEBUDDY_SYSTEM_USER_ID or a specified userId.",
      schema: z.object({
        caseId: z.string().describe('The case ID to deploy the firm on'),
        specialistId: z.string().optional().describe('Optional: assign a specific specialist (e.g. personal-injury, criminal-defense)'),
        userId: z.string().optional().describe('CaseBuddy user UUID to create the run as. Defaults to CASEBUDDY_SYSTEM_USER_ID env var.'),
      }),
      requiresApproval: true,
      async execute({ caseId, specialistId, userId }) {
        const uid = userId || process.env.CASEBUDDY_SYSTEM_USER_ID;
        if (!uid) {
          return {
            success: false,
            error: 'No user ID. Set CASEBUDDY_SYSTEM_USER_ID env var or pass userId parameter.',
          };
        }
        const rows = await sbFetch('firm_runs', '', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            case_id: caseId,
            user_id: uid,
            status: 'pending',
            specialist_id: specialistId || null,
          }),
        });
        const run = rows?.[0];
        return {
          success: true,
          runId: run?.id,
          caseId,
          status: run?.status,
          message: `Firm deployed on case ${caseId}. 8 agents will produce work products. Monitor with casebuddy_recent_work_products.`,
        };
      },
    },

    // ── Read: client intake pipeline ────────────────────────────────────────
    {
      name: 'casebuddy_list_intakes',
      description:
        'List recent CaseBuddy client intakes (from Maya voice/text intake) with status (new/accepted/denied/routed), matter type, and intake score. Use for intake pipeline supervision and to identify cases needing attention.',
      schema: z.object({
        limit: z.number().optional().describe('Max rows (default 20)'),
        onlyNew: z.boolean().optional().describe('Only intakes with status "new"'),
      }),
      requiresApproval: false,
      async execute({ limit, onlyNew }) {
        const params: Record<string, string | number> = { order: 'created_at.desc', limit: limit ?? 20 };
        if (onlyNew) params.status = 'eq.new';
        const rows = await sbFetch('intake_cases', buildQuery(params));
        return (rows ?? []).map((i: any) => ({
          id: i.id,
          created_at: i.created_at,
          status: i.status,
          client_name: i.client_name || i.full_name,
          matter_type: i.matter_type,
          score: i.score,
          disposition: i.disposition,
          urgency: i.urgency,
        }));
      },
    },

    // ── Read: agent work products ───────────────────────────────────────────
    {
      name: 'casebuddy_recent_work_products',
      description:
        'List recent CaseBuddy agent work products (legal research, draft motions, trial strategy, intake summaries, deadline analyses, jury profiles, e-filing status). These are the outputs produced by the 8 operational agents during a firm_run. Use to review what the agents have produced and ground follow-up directives.',
      schema: z.object({
        runId: z.string().optional().describe('Filter by firm_run ID (if omitted, shows most recent across all runs)'),
        limit: z.number().optional().describe('Max rows (default 20)'),
      }),
      requiresApproval: false,
      async execute({ runId, limit }) {
        const params: Record<string, string | number> = {
          order: 'completed_at.desc.nullslast',
          limit: limit ?? 20,
        };
        if (runId) params.run_id = `eq.${runId}`;
        const rows = await sbFetch('work_products', buildQuery(params));
        return (rows ?? []).map((w: any) => ({
          id: w.id,
          run_id: w.run_id,
          agent: w.agent_name,
          emoji: w.emoji,
          task: w.task_id,
          title: w.title,
          status: w.status,
          content: w.content?.slice(0, 500),
          started_at: w.started_at,
          completed_at: w.completed_at,
        }));
      },
    },

    // ── Manage: live health check ─────────────────────────────────────────────
    {
      name: 'casebuddy_health_check',
      description:
        'Live HTTP health check against the deployed casebuddy.live. Use after a deploy or as the CaseBuddy leg of any portfolio health sweep. Reports real HTTP status and latency.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const url = APP_URL();
        const started = Date.now();
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          const ms = Date.now() - started;
          return {
            healthy: res.ok,
            httpStatus: res.status,
            latencyMs: ms,
            url,
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

    // ── Manage: dispatch engineering work into casebuddy-ai-law-partner ─────
    {
      name: 'casebuddy_dispatch_engineering',
      description:
        "Dispatch a real engineering task into the casebuddy-ai-law-partner codebase (github.com/patriotnewsactivism/casebuddy-ai-law-partner). Creates a task assigned to the Lead Developer with full repo context attached. The Lead Dev lands changes via approval-gated create_pull_request; use casebuddy_health_check after merge to verify.",
      schema: z.object({
        title: z.string().describe('Short imperative ticket title'),
        spec: z.string().describe('Full engineering spec: what to change, where, acceptance criteria'),
        priority: z.number().min(1).max(10).optional().describe('1 (highest) – 10 (lowest); default 4'),
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
            project: 'casebuddy',
            repo: 'patriotnewsactivism/casebuddy-ai-law-partner',
            repoUrl: 'https://github.com/patriotnewsactivism/casebuddy-ai-law-partner',
            prInstructions:
              "Land changes via create_pull_request with repo 'patriotnewsactivism/casebuddy-ai-law-partner' — never direct pushes to main",
            healthCheckUrl: `${APP_URL()}`,
          },
        });
        return {
          success: true,
          taskId,
          assignedTo: 'apex-lead-dev-001',
          project: 'casebuddy',
          message: `Engineering task dispatched into casebuddy-ai-law-partner: ${title}`,
        };
      },
    },
  ];
}

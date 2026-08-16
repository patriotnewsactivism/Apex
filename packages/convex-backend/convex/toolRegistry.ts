import { v } from 'convex/values';
import { internalQuery, internalMutation } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal, api } from './_generated/api';
import { getConfiguredProviders } from './llmConfig';

// ─── Convex port of packages/core/src/tool-registry.ts ───────────────────────
//
// The old ToolRegistry ran inside a long-lived Node process with a real
// filesystem, a real shell, and a real (single, in-memory) AlertManager
// singleton. Convex actions have none of that: no persistent disk between
// invocations, no arbitrary process spawn in the default runtime, and no
// process-lifetime singleton state (every action invocation is its own
// isolate). Every one of the ~44 tools below is ported into exactly one of
// two shapes:
//
//   kind: 'sync'        — DB read/write (via ctx.runQuery/ctx.runMutation),
//                          pure computation, or an outbound HTTP fetch. Runs
//                          to completion inside this action call.
//   kind: 'externalJob'  — needs a real filesystem, shell, git, or browser.
//                          Instead of running now, builds a job payload and
//                          hands it to internal.cicd.enqueueJob; the actual
//                          work happens later on the standalone M5 CI/CD
//                          worker, which is not built yet.
//
// JSON schemas below are reproduced VERBATIM from the old file's zodToJsonSchema
// mapper (packages/core/src/tool-registry.ts:82-107) — including that
// mapper's real quirks: only ZodString ever carries a `description` in the
// output, and only when `.describe()` was called on the string itself (not
// on a wrapping `.optional()`, since `zodTypeToJson`'s ZodOptional branch
// unwraps and never reads the optional wrapper's own description). Several
// fields in the old schemas are `.optional().describe(...)` (description
// lost) vs `.describe(...).optional()` (description kept) — both forms are
// preserved exactly as the old mapper would have emitted them, not "fixed up".
//
// Several DB-backed tools (researched leads, scheduled jobs, learning/predictive
// tables, portfolio applications) reference Convex tables that already exist
// in schema.ts but don't yet have a dedicated query/mutation module — only
// agents/projects/goals/tasks/approvals/memories/logs/messages/cicd do. Rather
// than invent ~10 new module files (a larger architectural call outside "port
// the tool registry"), the missing plumbing is added here as small
// internalQuery/internalMutation helpers, colocated with the tool that needs
// them, and referenced via internal.toolRegistry.<helperName>.

// ─── Shared contract types (mirrored in convex/agentLoop.ts, written separately) ──

export type ToolOutcome =
  | { kind: 'sync'; result: unknown }
  | { kind: 'pendingExternalJob'; jobId: Id<'externalJobs'> };

/** Shape of the `input` old code passed to delegateToRole/delegateToAgent. */
export type DelegateTaskInput = {
  title: string;
  description: string;
  parentTaskId?: Id<'tasks'>;
  priority?: number;
  context?: Record<string, unknown>;
};

/**
 * Wired up by the caller (convex/agentLoop.ts, written separately). Only the
 * type lives here — dispatchTool/TOOL_DEFS just call toolContext.xxx(...) the
 * same way the old tool `execute()` bodies called ctx.xxx(...).
 */
export type ToolContext = {
  agentId: Id<'agents'>;
  taskId: Id<'tasks'>;
  requestApproval: (toolName: string, args: unknown, reason: string) => Promise<boolean>;
  delegateToRole: (role: string, input: DelegateTaskInput) => Promise<string>;
  delegateToAgent: (agentId: Id<'agents'>, input: DelegateTaskInput) => Promise<string>;
};

export type LLMTool = { name: string; description: string; parameters: Record<string, unknown> };

/** Matches cicd.ts's JOB_TYPE union exactly. */
type ExternalJobType =
  | 'test' | 'lint' | 'build' | 'deploy' | 'rollback'
  | 'git_status' | 'create_branch' | 'push' | 'create_pr'
  | 'run_shell' | 'read_file' | 'write_file' | 'list_dir'
  | 'run_sandbox' | 'browser_check';

type ToolDef = {
  schema: { name: string; description: string; parameters: Record<string, unknown> };
  requiresApproval: boolean;
  kind: 'sync' | 'externalJob';
  run?: (ctx: ActionCtx, args: any, toolContext: ToolContext) => Promise<unknown>;
  buildJobPayload?: (args: any, toolContext: ToolContext) => { jobType: ExternalJobType; payload: unknown };
};

const ROLE_ENUM = [
  'CEO', 'CTO', 'COO', 'LEAD_DEV', 'FRONTEND', 'BACKEND', 'DEVOPS', 'QA',
  'RESEARCH', 'DOCS', 'OPS', 'QA_DIRECTOR', 'LEAD_RESEARCH', 'SALES',
  'MARKETING', 'CUSTOMER_SUCCESS',
];

// ═══════════════════════════════════════════════════════════════════════════
// Internal DB helpers for tables that exist in schema.ts but don't yet have
// a dedicated module (researchedLeads, scheduledJobs, jobExecutionLog,
// taskOutcomes, learningInsights, strategyRecommendations, performanceBaselines,
// componentHealth, applications, applicationTasks, predictiveForecasts,
// riskAssessments). Cross-agent memory reads (shared_insights / health ping)
// also live here since memories.ts's exports are all scoped to a single agentId.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Researched Leads (saveResearchedLead / listResearchedLeads) ──────────────

export const researchedLeads_findByWebsite = internalQuery({
  args: { website: v.string() },
  handler: async (ctx, { website }) => {
    return await ctx.db.query('researchedLeads').withIndex('by_website', (q) => q.eq('website', website)).first();
  },
});

export const researchedLeads_insert = internalMutation({
  args: {
    companyName: v.string(),
    website: v.optional(v.string()),
    industry: v.optional(v.string()),
    city: v.optional(v.string()),
    fitReason: v.string(),
    outreachAngle: v.optional(v.string()),
    researchedByAgentId: v.id('agents'),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('researchedLeads', { ...args, status: 'new' });
  },
});

export const researchedLeads_list = internalQuery({
  args: {
    status: v.optional(v.union(v.literal('new'), v.literal('contacted'), v.literal('qualified'), v.literal('rejected'))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { status, limit }) => {
    const rows = status
      ? await ctx.db.query('researchedLeads').withIndex('by_status', (q) => q.eq('status', status)).collect()
      : await ctx.db.query('researchedLeads').collect();
    return rows.sort((a, b) => b._creationTime - a._creationTime).slice(0, limit ?? 25);
  },
});

// ─── Scheduled Jobs (schedule_task / list_scheduled_tasks / cancel_scheduled_task) ──

export const scheduledJobs_insert = internalMutation({
  args: {
    name: v.string(),
    jobType: v.string(),
    cronExpression: v.optional(v.string()),
    scheduledAt: v.optional(v.number()),
    targetAgentId: v.optional(v.id('agents')),
    payload: v.optional(v.any()),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert('scheduledJobs', {
      name: args.name,
      jobType: args.jobType,
      cronExpression: args.cronExpression,
      scheduledAt: args.scheduledAt,
      enabled: true,
      targetAgentId: args.targetAgentId,
      payload: args.payload,
      priority: args.priority ?? 5,
      status: 'active',
      retryCount: 0,
      maxRetries: 3,
      nextRunAt: args.scheduledAt ?? now,
      updatedAt: now,
    });
  },
});

export const scheduledJobs_list = internalQuery({
  args: {
    status: v.optional(v.union(v.literal('active'), v.literal('paused'), v.literal('completed'), v.literal('failed'))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { status, limit }) => {
    const rows = await ctx.db.query('scheduledJobs').collect();
    const filtered = status ? rows.filter((r) => r.status === status) : rows;
    return filtered.sort((a, b) => b._creationTime - a._creationTime).slice(0, limit ?? 25);
  },
});

export const scheduledJobs_get = internalQuery({
  args: { jobId: v.id('scheduledJobs') },
  handler: async (ctx, { jobId }) => ctx.db.get(jobId),
});

export const scheduledJobs_cancel = internalMutation({
  args: { jobId: v.id('scheduledJobs') },
  handler: async (ctx, { jobId }) => {
    await ctx.db.patch(jobId, { enabled: false, status: 'paused', updatedAt: Date.now() });
  },
});

// ─── Job Execution Log (get_job_history) ──────────────────────────────────────

export const jobExecutionLog_list = internalQuery({
  args: { jobId: v.id('scheduledJobs'), limit: v.optional(v.number()) },
  handler: async (ctx, { jobId, limit }) => {
    const rows = await ctx.db.query('jobExecutionLog').withIndex('by_job', (q) => q.eq('jobId', jobId)).collect();
    return rows.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit ?? 20);
  },
});

// ─── Task Outcomes (analyze_performance / record_outcome / forecast_tasks / risk_assessment) ──

export const taskOutcomes_listAll = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query('taskOutcomes').collect(),
});

export const taskOutcomes_insert = internalMutation({
  args: {
    taskId: v.id('tasks'),
    agentId: v.id('agents'),
    role: v.string(),
    durationMs: v.number(),
    success: v.boolean(),
    qualityScore: v.optional(v.number()),
    toolExecutions: v.optional(v.number()),
    llmCalls: v.optional(v.number()),
    iterations: v.optional(v.number()),
    requiredApprovals: v.optional(v.number()),
    errorType: v.optional(v.string()),
    complexity: v.optional(v.number()),
    satisfactionMetric: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('taskOutcomes', {
      taskId: args.taskId,
      agentId: args.agentId,
      role: args.role,
      durationMs: args.durationMs,
      success: args.success,
      qualityScore: args.qualityScore ?? 1.0,
      toolExecutions: args.toolExecutions ?? 0,
      llmCalls: args.llmCalls ?? 0,
      iterations: args.iterations ?? 1,
      requiredApprovals: args.requiredApprovals ?? 0,
      errorType: args.errorType,
      complexity: args.complexity ?? 0.5,
      satisfactionMetric: args.satisfactionMetric ?? 1.0,
      tags: args.tags,
    });
  },
});

// ─── Learning Insights (get_insights / apply_strategy_recommendation) ─────────

export const learningInsights_list = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query('learningInsights').collect();
    return rows.sort((a, b) => b._creationTime - a._creationTime).slice(0, limit ?? 20);
  },
});

export const learningInsights_insert = internalMutation({
  args: {
    insightType: v.union(v.literal('pattern'), v.literal('improvement'), v.literal('warning')),
    title: v.string(),
    description: v.string(),
    confidence: v.number(),
    evidence: v.optional(v.any()),
    applied: v.boolean(),
  },
  handler: async (ctx, args) => ctx.db.insert('learningInsights', args),
});

// ─── Strategy Recommendations (get_strategy_recommendations / apply_strategy_recommendation) ──

export const strategyRecommendations_list = internalQuery({
  args: {
    status: v.optional(v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected'), v.literal('applied'))),
  },
  handler: async (ctx, { status }) => {
    const rows = status
      ? await ctx.db.query('strategyRecommendations').withIndex('by_status', (q) => q.eq('status', status)).collect()
      : await ctx.db.query('strategyRecommendations').collect();
    return rows.sort((a, b) => b._creationTime - a._creationTime);
  },
});

export const strategyRecommendations_get = internalQuery({
  args: { recommendationId: v.id('strategyRecommendations') },
  handler: async (ctx, { recommendationId }) => ctx.db.get(recommendationId),
});

export const strategyRecommendations_markApplied = internalMutation({
  args: { recommendationId: v.id('strategyRecommendations') },
  handler: async (ctx, { recommendationId }) => {
    await ctx.db.patch(recommendationId, { status: 'applied', reviewedAt: Date.now() });
  },
});

// ─── Performance Baselines (set_performance_baseline) ─────────────────────────

export const performanceBaselines_upsert = internalMutation({
  args: {
    metricName: v.string(),
    baselineValue: v.number(),
    measurementWindow: v.optional(v.string()),
    sampleSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('performanceBaselines')
      .withIndex('by_metricName', (q) => q.eq('metricName', args.metricName))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        baselineValue: args.baselineValue,
        measurementWindow: args.measurementWindow ?? '30d',
        sampleSize: args.sampleSize ?? 0,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert('performanceBaselines', {
      metricName: args.metricName,
      baselineValue: args.baselineValue,
      measurementWindow: args.measurementWindow ?? '30d',
      sampleSize: args.sampleSize ?? 0,
      updatedAt: now,
    });
  },
});

// ─── Component Health (get_system_status) ─────────────────────────────────────

export const componentHealth_list = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query('componentHealth').collect(),
});

// ─── Portfolio Applications (register_application / app_health_check / delegate_to_application) ──

export const applications_upsert = internalMutation({
  args: { legacyId: v.string(), name: v.string(), repoUrl: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('applications')
      .withIndex('by_legacyId', (q) => q.eq('legacyId', args.legacyId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { name: args.name, repoUrl: args.repoUrl, lastSyncAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert('applications', {
      legacyId: args.legacyId,
      name: args.name,
      repoUrl: args.repoUrl,
      status: 'active',
      healthScore: 1.0,
      lastSyncAt: Date.now(),
    });
  },
});

export const applications_getByLegacyId = internalQuery({
  args: { legacyId: v.string() },
  handler: async (ctx, { legacyId }) => {
    return await ctx.db.query('applications').withIndex('by_legacyId', (q) => q.eq('legacyId', legacyId)).unique();
  },
});

export const applicationTasks_insert = internalMutation({
  args: { appId: v.id('applications'), taskName: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert('applicationTasks', { appId: args.appId, taskName: args.taskName, status: 'pending' });
  },
});

// ─── Predictive Forecasts / Risk Assessments (forecast_tasks / risk_assessment) ──

export const predictiveForecasts_insert = internalMutation({
  args: { metricName: v.string(), forecastValue: v.number(), confidence: v.number(), window: v.string() },
  handler: async (ctx, args) => ctx.db.insert('predictiveForecasts', args),
});

export const riskAssessments_insert = internalMutation({
  args: {
    target: v.string(),
    riskLevel: v.union(v.literal('low'), v.literal('medium'), v.literal('high'), v.literal('critical')),
    details: v.string(),
  },
  handler: async (ctx, args) => ctx.db.insert('riskAssessments', args),
});

// ─── Cross-agent Memory Reads (shared_insights + health/reachability ping) ────
//
// memories.ts's exports are all scoped to a single agentId (upsert/recall/getAll
// take agentId as a required arg); shared_insights needs a cross-agent scan by
// key prefix ('global:%' in the old SQL LIKE), which nothing else exposes.

export const memories_listGlobal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query('memories').collect();
    return rows
      .filter((m) => m.key.startsWith('global:'))
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, limit ?? 20);
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers ported from @workspace/health-monitor and @workspace/predictive
// (both Postgres/Drizzle-backed packages with no Convex equivalent — their
// logic is inlined here rather than importing the old packages).
// ═══════════════════════════════════════════════════════════════════════════

type ComponentStatus = 'healthy' | 'degraded' | 'critical';
type ComponentCheckResult = { status: ComponentStatus; detail: string; ms?: number };
type HealthReport = { overall: ComponentStatus; checks: Record<string, ComponentCheckResult>; timestamp: string };

async function safeCheck(fn: () => Promise<{ status: ComponentStatus; detail: string }>): Promise<ComponentCheckResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, ms: Date.now() - start };
  } catch (err) {
    return { status: 'critical', detail: err instanceof Error ? err.message : String(err), ms: Date.now() - start };
  }
}

/** Ported from health-monitor/src/index.ts's checkBuildMyBotAITeam — pure HTTP, no DB. */
async function checkBuildMyBotAITeam(): Promise<{ status: ComponentStatus; detail: string }> {
  const url = process.env.BUILDMYBOT_SUPABASE_URL;
  const key = process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return { status: 'degraded', detail: 'BUILDMYBOT_SUPABASE_URL / BUILDMYBOT_SUPABASE_SERVICE_KEY not configured' };
  }
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'https:') {
    return {
      status: 'critical',
      detail:
        `BUILDMYBOT_SUPABASE_URL is not a valid https:// project URL ` +
        `(got "${url.slice(0, 30)}…"). It may hold a secret/JWT — check that ` +
        `BUILDMYBOT_SUPABASE_URL and BUILDMYBOT_SUPABASE_SERVICE_KEY are not ` +
        `swapped, and that the value is a plaintext URL (e.g. https://xyz.supabase.co).`,
    };
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const today = new Date().toISOString().slice(0, 10);
  const [shiftsRes, criticalsRes] = await Promise.all([
    fetch(`${url}/rest/v1/ai_team_log?shift_date=eq.${today}&select=role_name,flags,escalated_to&limit=100`, {
      headers,
      signal: AbortSignal.timeout(4_500),
    }),
    fetch(`${url}/rest/v1/error_logs?status=eq.open&level=eq.critical&select=source&limit=50`, {
      headers,
      signal: AbortSignal.timeout(4_500),
    }),
  ]);
  if (!shiftsRes.ok || !criticalsRes.ok) {
    return {
      status: 'critical',
      detail: `buildmybot2 Supabase unreachable (ai_team_log ${shiftsRes.status}, error_logs ${criticalsRes.status})`,
    };
  }
  const shifts = (await shiftsRes.json()) as Array<{ role_name: string; flags?: unknown; escalated_to?: unknown }>;
  const criticals = (await criticalsRes.json()) as Array<{ source: string }>;
  const flagged = shifts.filter((s) => s.flags || s.escalated_to).length;
  const chainExhaustions = criticals.filter((c) => c.source === 'llm-provider-chain').length;
  const status: ComponentStatus = criticals.length > 0 ? 'critical' : flagged > 0 ? 'degraded' : 'healthy';
  return {
    status,
    detail:
      `${shifts.length} AI Team shift(s) today, ${flagged} flagged/escalated, ` +
      `${criticals.length} open critical(s)` +
      (chainExhaustions ? ` (${chainExhaustions} provider-chain exhaustion!)` : ''),
  };
}

/** Ported from HealthMonitor.runAll() — same 8 checks, same rollup rule. */
async function buildHealthReport(ctx: ActionCtx): Promise<HealthReport> {
  const [database, llmProviders, memorySystem, toolRegistryCheck, webSocket, taskBacklog, buildMyBotAITeam, ariaDispatch] =
    await Promise.all([
      safeCheck(async () => {
        await ctx.runQuery(api.agents.list, {});
        return { status: 'healthy' as ComponentStatus, detail: 'query succeeded' };
      }),
      safeCheck(async () => {
        const providers = getConfiguredProviders();
        const configuredCount = providers.filter((p) => p.configured).length;
        const status: ComponentStatus =
          configuredCount === 0 ? 'critical' : configuredCount < providers.length ? 'degraded' : 'healthy';
        return { status, detail: providers.map((p) => `${p.name}:${p.configured ? 'ok' : 'missing'}`).join(', ') };
      }),
      safeCheck(async () => {
        await ctx.runQuery(internal.toolRegistry.memories_listGlobal, { limit: 1 });
        return { status: 'healthy' as ComponentStatus, detail: 'memories table reachable' };
      }),
      safeCheck(async () => {
        const toolCount = Object.keys(TOOL_DEFS).length;
        return { status: (toolCount > 0 ? 'healthy' : 'critical') as ComponentStatus, detail: `${toolCount} tools registered` };
      }),
      safeCheck(async () => ({
        status: 'degraded' as ComponentStatus,
        detail: 'no WebSocket checker injected (only wireable from a live process, not a Convex action)',
      })),
      safeCheck(async () => {
        const all = await ctx.runQuery(api.tasks.list, {});
        const count = all.filter((t) => t.status === 'pending' || t.status === 'in_progress').length;
        return { status: (count > 50 ? 'degraded' : 'healthy') as ComponentStatus, detail: `${count} pending/in_progress tasks` };
      }),
      safeCheck(() => checkBuildMyBotAITeam()),
      safeCheck(async () => {
        const yesterday = Date.now() - 24 * 60 * 60 * 1000;
        const [allGoals, allTasks] = await Promise.all([
          ctx.runQuery(api.goals.list, {}),
          ctx.runQuery(api.tasks.list, {}),
        ]);
        const goalCount = allGoals.filter((g) => g._creationTime >= yesterday).length;
        const taskCount = allTasks.filter((t) => t._creationTime >= yesterday).length;
        return {
          status: 'healthy' as ComponentStatus,
          detail: `${goalCount} goal(s) dispatched, ${taskCount} task(s) created in last 24h`,
        };
      }),
    ]);

  const checks: Record<string, ComponentCheckResult> = {
    database, llmProviders, memorySystem, toolRegistry: toolRegistryCheck, webSocket, taskBacklog, buildMyBotAITeam, ariaDispatch,
  };
  const statuses = Object.values(checks).map((c) => c.status);
  const overall: ComponentStatus = statuses.includes('critical')
    ? 'critical'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'healthy';

  return { overall, checks, timestamp: new Date().toISOString() };
}

/** Ported from Forecaster's WINDOW_MS map. */
function windowToMs(window: string): number {
  const WINDOW_MS: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return WINDOW_MS[window] ?? WINDOW_MS['7d'];
}

/** Ported verbatim from Forecaster.wilsonConfidenceInterval. */
function wilsonConfidenceInterval(successes: number, total: number, z = 1.96): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 100 };
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion)) / total + (z * z) / (4 * total * total))) / denominator;
  return { lower: Math.max(0, (center - margin) * 100), upper: Math.min(100, (center + margin) * 100) };
}

// ═══════════════════════════════════════════════════════════════════════════
// BuildMyBot Connector — ported from packages/core/src/buildmybot-connector.ts.
// Direct Supabase REST (PostgREST) calls, same approach as checkBuildMyBotAITeam
// above (which only covers the read-only health-sweep leg). Only the 6 tools
// agentConfigs.ts actually assigns to a role are ported (buildmybot_status,
// buildmybot_send_briefing, buildmybot_dispatch_engineering, buildmybot_deploy,
// buildmybot_health_check, buildmybot_open_errors) — buildmybot_run_workforce,
// buildmybot_resolve_error, and buildmybot_recent_leads exist in the old file
// but no role's tool list references them, so they're left unported.
// ═══════════════════════════════════════════════════════════════════════════

/** Thin Supabase REST helper (PostgREST). Throws on non-2xx. Ported from buildmybot-connector.ts's sbFetch. */
async function bmbFetch(table: string, query: string, init?: RequestInit): Promise<any> {
  const baseUrl = process.env.BUILDMYBOT_SUPABASE_URL ?? '';
  const key = process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY ?? '';
  if (!baseUrl.startsWith('https://')) {
    throw new Error(
      `BUILDMYBOT_SUPABASE_URL must be an https:// project URL (e.g. https://xyz.supabase.co). ` +
      `Got: "${baseUrl.slice(0, 30)}…". BUILDMYBOT_SUPABASE_URL and BUILDMYBOT_SUPABASE_SERVICE_KEY may be swapped in your env.`,
    );
  }
  const url = `${baseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
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

function bmbTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL_DEFS — every tool from packages/core/src/tool-registry.ts, in the same
// order as the old file's createBuiltinTools() array.
// ═══════════════════════════════════════════════════════════════════════════

export const TOOL_DEFS: Record<string, ToolDef> = {

  // ─── Read File (externalJob — real filesystem) ─────────────────────────────
  readFile: {
    schema: {
      name: 'readFile',
      description: 'Read the contents of a file. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
        },
        required: ['path'],
      },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: (args) => ({
      jobType: 'read_file',
      payload: { path: args.path, startLine: args.startLine, endLine: args.endLine },
    }),
  },

  // ─── Write File (externalJob — real filesystem) ─────────────────────────────
  writeFile: {
    schema: {
      name: 'writeFile',
      description: 'Write content to a file. Creates parent directories if needed. Path is relative to workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          content: { type: 'string', description: 'File content to write' },
          append: { type: 'boolean' },
        },
        required: ['path', 'content'],
      },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: (args) => ({
      jobType: 'write_file',
      payload: { path: args.path, content: args.content, append: args.append },
    }),
  },

  // ─── List Directory (externalJob — real filesystem) ─────────────────────────
  listDir: {
    schema: {
      name: 'listDir',
      description: 'List files and directories at the given path. Path is relative to workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace root' },
        },
        required: [],
      },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: (args) => ({ jobType: 'list_dir', payload: { path: args.path } }),
  },

  // ─── Run Shell Command (externalJob — real shell; approval required) ───────
  runShell: {
    schema: {
      name: 'runShell',
      description: 'Execute a shell command in the workspace directory. Use with caution.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          cwd: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['command'],
      },
    },
    requiresApproval: true,
    kind: 'externalJob',
    buildJobPayload: (args) => ({
      jobType: 'run_shell',
      payload: { command: args.command, cwd: args.cwd, timeoutMs: args.timeoutMs ?? 30000 },
    }),
  },

  // ─── Web Search (sync — outbound HTTP only) ─────────────────────────────────
  webSearch: {
    schema: {
      name: 'webSearch',
      description:
        'Search the web for information. Returns real search results with titles, URLs, and snippets. For broad topics, use specific queries (e.g. "real estate companies Texas" instead of "real estate companies in the south"). Call multiple times with different queries to build comprehensive results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query — be specific for best results' },
          maxResults: { type: 'number' },
        },
        required: ['query'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (_ctx, args) => {
      const { query, maxResults } = args as { query: string; maxResults?: number };
      const n = maxResults ?? 10;
      const results: Array<{ title: string; url: string; snippet: string }> = [];

      const tavilyKey = process.env.TAVILY_API_KEY;
      if (tavilyKey) {
        try {
          const tavilyRes = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: tavilyKey, query, max_results: n, search_depth: 'advanced', include_answer: true }),
          });
          if (tavilyRes.ok) {
            const tavilyData = (await tavilyRes.json()) as {
              answer?: string;
              results?: Array<{ title: string; url: string; content: string }>;
            };
            if (tavilyData.answer) results.push({ title: 'Tavily AI Summary', url: '', snippet: tavilyData.answer });
            for (const r of tavilyData.results ?? []) results.push({ title: r.title, url: r.url, snippet: r.content });
            if (results.length > 0) return { query, provider: 'tavily', results: results.slice(0, n + 1) };
          }
        } catch (e) {
          console.warn(`[webSearch] Tavily failed for "${query}": ${e}`);
        }
      }

      const braveKey = process.env.BRAVE_SEARCH_API_KEY;
      if (braveKey) {
        try {
          const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
          const braveRes = await fetch(braveUrl, {
            headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveKey },
          });
          if (braveRes.ok) {
            const braveData = (await braveRes.json()) as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
            for (const r of braveData.web?.results ?? []) results.push({ title: r.title, url: r.url, snippet: r.description });
            if (results.length > 0) return { query, provider: 'brave', results: results.slice(0, n) };
          }
        } catch (e) {
          console.warn(`[webSearch] Brave failed for "${query}": ${e}`);
        }
      }

      try {
        const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
        const ddgRes = await fetch(ddgUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html',
          },
        });
        const html = await ddgRes.text();

        const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
        const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

        const links: Array<{ url: string; title: string }> = [];
        let linkMatch;
        while ((linkMatch = linkRegex.exec(html)) !== null) links.push({ url: linkMatch[1], title: linkMatch[2].trim() });

        const snippets: string[] = [];
        let snippetMatch;
        while ((snippetMatch = snippetRegex.exec(html)) !== null) {
          snippets.push(
            snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(),
          );
        }

        for (let i = 0; i < links.length && i < n; i++) {
          results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? '' });
        }

        if (results.length > 0) return { query, provider: 'duckduckgo-html', results: results.slice(0, n) };

        const generalLinkRegex = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let generalMatch;
        while ((generalMatch = generalLinkRegex.exec(html)) !== null) {
          const href = generalMatch[1];
          const text = generalMatch[2].replace(/<[^>]+>/g, '').trim();
          if (href.startsWith('http') && text.length > 5 && !href.includes('duckduckgo.com')) {
            results.push({ title: text, url: href, snippet: '' });
          }
        }

        if (results.length > 0) return { query, provider: 'duckduckgo-html-fallback', results: results.slice(0, n) };
      } catch (e) {
        console.warn(`[webSearch] DuckDuckGo HTML failed for "${query}": ${e}`);
      }

      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
        const res = await fetch(url);
        const data = (await res.json()) as Record<string, unknown>;

        if (data.AbstractText) {
          results.push({ title: String(data.AbstractSource ?? 'Result'), url: String(data.AbstractURL ?? ''), snippet: String(data.AbstractText ?? '') });
        }
        const relatedTopics = (data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }>) ?? [];
        for (const topic of relatedTopics.slice(0, n)) {
          if (topic.Text) results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL ?? '', snippet: topic.Text });
        }
      } catch (e) {
        console.warn(`[webSearch] DuckDuckGo API also failed for "${query}": ${e}`);
      }

      if (results.length === 0) {
        return {
          query, provider: 'none', results: [],
          suggestion: 'No results found. Try a more specific query — for example, search by specific state, city, or industry keyword instead of broad regional terms.',
        };
      }

      return { query, provider: 'duckduckgo-api', results: results.slice(0, n) };
    },
  },

  // ─── Fetch URL (sync — outbound HTTP only) ──────────────────────────────────
  fetchUrl: {
    schema: {
      name: 'fetchUrl',
      description: 'Fetch the content of a URL and return its text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          maxChars: { type: 'number' },
        },
        required: ['url'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (_ctx, args) => {
      const { url, maxChars } = args as { url: string; maxChars?: number };
      const res = await fetch(url, { headers: { 'User-Agent': 'APEX-Agent/1.0' } });
      const text = await res.text();
      const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { url, content: plain.slice(0, maxChars ?? 8000), status: res.status };
    },
  },

  // ─── Browser Check (externalJob — real headless Chromium) ──────────────────
  browserCheck: {
    schema: {
      name: 'browserCheck',
      description:
        'Load a URL in a real headless Chromium browser and report whether it rendered successfully: HTTP status, page title, any JavaScript console errors, and any uncaught page exceptions. Use this for real browser-level QA, not just raw HTML fetching.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to load in the browser' },
          maxConsoleMessages: { type: 'number' },
        },
        required: ['url'],
      },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: (args) => ({
      jobType: 'browser_check',
      payload: { url: args.url, maxConsoleMessages: args.maxConsoleMessages ?? 20 },
    }),
  },

  // ─── Send Message (sync — DB insert + delegateToAgent) ──────────────────────
  sendMessage: {
    schema: {
      name: 'sendMessage',
      description: 'Send a message to another agent, delegating a task to them. The message body becomes the task description the target agent will execute.',
      parameters: {
        type: 'object',
        properties: {
          toAgentId: { type: 'string', description: 'ID of the target agent (e.g. "apex-cto-001")' },
          subject: { type: 'string', description: 'Message subject — becomes the delegated task title' },
          body: { type: 'string', description: 'Message body — becomes the delegated task description' },
        },
        required: ['toAgentId', 'subject', 'body'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args, toolContext) => {
      const { toAgentId, subject, body } = args as { toAgentId: string; subject: string; body: string };
      // toAgentId is a legacy role slug (e.g. "apex-cto-001") on the LLM-facing
      // schema, same as the old code — but the new messages/tasks tables are
      // strictly v.id('agents'), unlike the old free-text FK columns, so it
      // must be resolved to a real agent doc first.
      const targetAgent = await ctx.runQuery(internal.agents.getByLegacyId, { legacyId: toAgentId });
      if (!targetAgent) throw new Error(`Unknown agent legacyId: ${toAgentId}`);

      const messageId = await ctx.runMutation(internal.messages.send, {
        fromAgentId: toolContext.agentId,
        toAgentId: targetAgent._id,
        subject,
        body,
      });

      const taskId = await toolContext.delegateToAgent(targetAgent._id, {
        title: subject,
        description: body,
        parentTaskId: toolContext.taskId,
        context: { messageId, fromAgentId: toolContext.agentId },
      });

      return { sent: true, taskId, messageId, fromAgentId: toolContext.agentId, toAgentId: targetAgent._id, subject };
    },
  },

  // ─── Save Researched Lead (sync — DB read + insert) ─────────────────────────
  saveResearchedLead: {
    schema: {
      name: 'saveResearchedLead',
      description:
        "Save a qualified outbound lead to the researched_leads table. Call this once per qualifying company found via web search — do NOT just describe leads in your final answer, they must be persisted here to count as pipeline output. Checks for an existing row with the same website first and skips the insert if found (returns duplicate: true) so the team never double-works a company.",
      parameters: {
        type: 'object',
        properties: {
          companyName: { type: 'string', description: 'Real company name as found in search results' },
          website: { type: 'string' },
          industry: { type: 'string' },
          city: { type: 'string' },
          fitReason: { type: 'string', description: 'Why this company matches the ICP pain point (missed calls, slow lead response, after-hours gaps)' },
          outreachAngle: { type: 'string' },
        },
        required: ['companyName', 'fitReason'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args, toolContext) => {
      const { companyName, website, industry, city, fitReason, outreachAngle } = args as {
        companyName: string; website?: string; industry?: string; city?: string; fitReason: string; outreachAngle?: string;
      };
      if (website) {
        const existing = await ctx.runQuery(internal.toolRegistry.researchedLeads_findByWebsite, { website });
        if (existing) return { duplicate: true, existingLeadId: existing._id, companyName };
      }
      const leadId = await ctx.runMutation(internal.toolRegistry.researchedLeads_insert, {
        companyName, website, industry, city, fitReason, outreachAngle, researchedByAgentId: toolContext.agentId,
      });
      return { saved: true, leadId, companyName };
    },
  },

  // ─── List Researched Leads (sync — DB read) ─────────────────────────────────
  listResearchedLeads: {
    schema: {
      name: 'listResearchedLeads',
      description: 'List researched/qualified outbound leads from the researched_leads table, most recent first. Use to review pipeline status honestly instead of guessing counts.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'number' },
        },
        required: [],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { status, limit } = args as { status?: 'new' | 'contacted' | 'qualified' | 'rejected'; limit?: number };
      return await ctx.runQuery(internal.toolRegistry.researchedLeads_list, { status, limit });
    },
  },

  // ─── Request Peer Review (sync — delegateToRole only) ───────────────────────
  requestPeerReview: {
    schema: {
      name: 'requestPeerReview',
      description: 'Request another specialized agent role (e.g. QA, DEVOPS, BACKEND) to review code, features, or design and create a subtask for them.',
      parameters: {
        type: 'object',
        properties: {
          targetRole: { type: 'string', enum: ROLE_ENUM },
          reviewObjective: { type: 'string', description: 'Clear objective and instructions explaining what they should review' },
          contextData: { type: 'string' },
        },
        required: ['targetRole', 'reviewObjective'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (_ctx, args, toolContext) => {
      const { targetRole, reviewObjective, contextData } = args as {
        targetRole: string; reviewObjective: string; contextData?: Record<string, unknown>;
      };
      const taskId = await toolContext.delegateToRole(targetRole, {
        title: 'Peer Review Request',
        description: reviewObjective,
        parentTaskId: toolContext.taskId,
        context: contextData,
      });
      return { success: true, taskId, targetRole, message: `Review request dispatched to ${targetRole}` };
    },
  },

  // ─── Dispatch Swarm (sync — delegateToRole loop) ────────────────────────────
  dispatchSwarm: {
    schema: {
      name: 'dispatchSwarm',
      description: 'Fan out a shared objective to N independent instances/personas of a target role. Creates one real task per instance, each parameterized with its own context. Returns a swarmId for later collection via collectSwarmResults.',
      parameters: {
        type: 'object',
        properties: {
          targetRole: { type: 'string', enum: ROLE_ENUM },
          objective: { type: 'string', description: 'Shared objective/instructions all instances will work on' },
          instances: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Human-readable instance name (e.g. "Susan-novice", "Marcus-security")' },
                instructions: { type: 'string', description: 'Instance-specific instructions, persona description, or parameters that differentiate this task from the others' },
                context: { type: 'string' },
              },
              required: ['name', 'instructions'],
            },
          },
          sharedContext: { type: 'string' },
          priority: { type: 'number' },
        },
        required: ['targetRole', 'objective', 'instances'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (_ctx, args, toolContext) => {
      const { targetRole, objective, instances, sharedContext } = args as {
        targetRole: string;
        objective: string;
        instances: Array<{ name: string; instructions: string; context?: Record<string, unknown> }>;
        sharedContext?: Record<string, unknown>;
        priority?: number;
      };
      const swarmId = crypto.randomUUID();
      const taskIds: Array<{ name: string; taskId: string }> = [];

      for (const instance of instances) {
        const taskId = await toolContext.delegateToRole(targetRole, {
          title: `[Swarm: ${instance.name}] ${objective.slice(0, 100)}`,
          description: `## Swarm Objective\n${objective}\n\n## Your Instance\nYou are executing as: **${instance.name}**\n\n${instance.instructions}`,
          parentTaskId: toolContext.taskId,
          context: { swarmId, instanceName: instance.name, ...(sharedContext ?? {}), ...(instance.context ?? {}) },
        });
        taskIds.push({ name: instance.name, taskId });
      }

      return {
        success: true, swarmId, targetRole, totalDispatched: instances.length, tasks: taskIds,
        message: `Swarm dispatched: ${instances.length} tasks to ${targetRole} (swarmId: ${swarmId})`,
      };
    },
  },

  // ─── Collect Swarm Results (sync — DB read) ─────────────────────────────────
  collectSwarmResults: {
    schema: {
      name: 'collectSwarmResults',
      description: 'Check the status of a previously dispatched swarm and collect results from completed tasks. Use after dispatchSwarm to gather and synthesize findings.',
      parameters: {
        type: 'object',
        properties: { swarmId: { type: 'string', description: 'The swarmId returned by dispatchSwarm' } },
        required: ['swarmId'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { swarmId } = args as { swarmId: string };
      // tasks.context isn't indexed/queryable by nested field in Convex —
      // the old code's `context->>'swarmId' = $1` SQL filter becomes a
      // client-side scan over tasks.list, mirroring how this codebase
      // already scans+filters elsewhere (e.g. tasks.resetOrphanedInProgress).
      const allTasks = await ctx.runQuery(api.tasks.list, {});
      const swarmTasks = allTasks.filter((t) => (t.context as Record<string, unknown> | null | undefined)?.swarmId === swarmId);

      if (swarmTasks.length === 0) return { success: false, error: `No tasks found for swarmId: ${swarmId}` };

      const summary = { swarmId, total: swarmTasks.length, done: 0, failed: 0, pending: 0, inProgress: 0, other: 0 };
      const results: Array<{ instanceName: string; taskId: string; status: string; result?: string; error?: string }> = [];

      for (const task of swarmTasks) {
        const taskCtx = task.context as Record<string, unknown> | null | undefined;
        const instanceName = (taskCtx?.instanceName as string | undefined) ?? task.title;

        switch (task.status) {
          case 'done': summary.done++; break;
          case 'failed': summary.failed++; break;
          case 'pending': summary.pending++; break;
          case 'in_progress': summary.inProgress++; break;
          default: summary.other++; break;
        }

        results.push({ instanceName, taskId: task._id, status: task.status, result: task.result ?? undefined, error: task.errorMessage ?? undefined });
      }

      const allComplete = summary.pending === 0 && summary.inProgress === 0;
      return { success: true, allComplete, summary, results };
    },
  },

  // ─── Run in Sandbox (externalJob — real temp dir + process spawn) ───────────
  runInSandbox: {
    schema: {
      name: 'runInSandbox',
      description: 'Execute TypeScript, JavaScript, Python, or Shell code in an isolated temporary sandbox directory with a strict timeout and automatic cleanup.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code or script content to execute' },
          language: { type: 'string', enum: ['typescript', 'javascript', 'python', 'shell'] },
          timeoutMs: { type: 'number' },
        },
        required: ['code', 'language'],
      },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: (args) => ({
      jobType: 'run_sandbox',
      payload: { code: args.code, language: args.language, timeoutMs: args.timeoutMs ?? 10000 },
    }),
  },

  // ─── Health Check (sync — read-only diagnostics) ────────────────────────────
  health_check: {
    schema: {
      name: 'health_check',
      description: 'Run fast, read-only diagnostics across Apex core components (database, tool registry, configured LLM fallback providers, memory system, task backlog, WebSocket liveness) and return a health summary. No side effects, no live LLM calls -- safe to call anytime.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx) => {
      const report = await buildHealthReport(ctx);
      return { success: true, data: report };
    },
  },

  // ─── Get System Status (sync — read-only diagnostics + stored components) ──
  get_system_status: {
    schema: {
      name: 'get_system_status',
      description: 'Get comprehensive system status including live health checks, per-component historical status from the database, and alert summary. More detailed than health_check — includes component_health table data and active alert counts.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx) => {
      const report = await buildHealthReport(ctx);
      const storedComponents = await ctx.runQuery(internal.toolRegistry.componentHealth_list, {});
      const alerts = await ctx.runQuery(internal.health.getActiveAlerts, {});
      const alertSummary = await ctx.runQuery(internal.health.getAlertSummary, {});
      return { success: true, data: { live: report, storedComponents, alerts: alertSummary, activeAlerts: alerts } };
    },
  },

  // ─── Get Active Alerts (sync — real persisted state from convex/health.ts,
  // populated by the scheduled_jobs 'health_check' cron via internal.health.runHealthCheck) ──
  get_active_alerts: {
    schema: {
      name: 'get_active_alerts',
      description: 'Get all currently active (un-acknowledged) alerts from the persistent alert store. Alerts fire when health thresholds are breached (component critical, task backlog > 50, approval backlog > 10, 3+ components degraded) and are evaluated on every scheduled health check, not recomputed on demand. Includes severity, component, and when the alert fired.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx) => {
      const alerts = await ctx.runQuery(internal.health.getActiveAlerts, {});
      const summary = await ctx.runQuery(internal.health.getAlertSummary, {});
      return { success: true, data: { alerts, summary } };
    },
  },

  // ─── Get Metrics View (sync — DB reads) ─────────────────────────────────────
  get_metrics_view: {
    schema: {
      name: 'get_metrics_view',
      description: 'Get a live metrics snapshot: task counts by status, agent counts by status, pending approval backlog, and log volume by level over the last 24h. Complements get_active_alerts (thresholds) and health_check (component diagnostics) with raw counts for trend-spotting.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx) => {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const [allTasks, allAgents, pendingApprovals, recentLogs] = await Promise.all([
        ctx.runQuery(api.tasks.list, {}),
        ctx.runQuery(api.agents.list, {}),
        ctx.runQuery(api.approvals.listPending, {}),
        ctx.runQuery(api.logs.recent, { limit: 2000 }),
      ]);

      const tasksByStatus: Record<string, number> = {};
      for (const t of allTasks) tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;

      const agentsByStatus: Record<string, number> = {};
      for (const a of allAgents) agentsByStatus[a.status] = (agentsByStatus[a.status] ?? 0) + 1;

      const logsIn24h = recentLogs.filter((l) => l.timestamp >= since);
      const logsByLevel24h: Record<string, number> = {};
      for (const l of logsIn24h) logsByLevel24h[l.level] = (logsByLevel24h[l.level] ?? 0) + 1;
      const totalLogs24h = logsIn24h.length;
      const errorCount24h = logsByLevel24h.error ?? 0;

      return {
        tasksByStatus, agentsByStatus,
        pendingApprovals: pendingApprovals.length,
        logsByLevel24h,
        errorRate24h: totalLogs24h > 0 ? errorCount24h / totalLogs24h : 0,
        generatedAt: new Date().toISOString(),
      };
    },
  },

  // ─── Get Error Summary (sync — DB read) ─────────────────────────────────────
  get_error_summary: {
    schema: {
      name: 'get_error_summary',
      description: 'Get recent error-level logs grouped by message pattern (IDs redacted) with counts and last-seen times, to spot systemic/recurring failures vs one-offs.',
      parameters: {
        type: 'object',
        properties: { hours: { type: 'number' }, limit: { type: 'number' } },
        required: [],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { hours, limit } = args as { hours?: number; limit?: number };
      const since = Date.now() - (hours ?? 24) * 60 * 60 * 1000;
      const recentLogs = await ctx.runQuery(api.logs.recent, { limit: 2000 });
      const rows = recentLogs.filter((l) => l.level === 'error' && l.timestamp >= since).slice(0, 500);

      const grouped = new Map<string, { count: number; lastSeen: number; agentId: string | null; taskId: string | null }>();
      for (const row of rows) {
        const key = row.message.replace(/[0-9a-f-]{8,}/gi, '<id>').slice(0, 120);
        const existing = grouped.get(key);
        if (existing) {
          existing.count += 1;
          if (row.timestamp > existing.lastSeen) existing.lastSeen = row.timestamp;
        } else {
          grouped.set(key, { count: 1, lastSeen: row.timestamp, agentId: row.agentId ?? null, taskId: row.taskId ?? null });
        }
      }

      const summary = Array.from(grouped.entries())
        .map(([pattern, val]) => ({ pattern, count: val.count, lastSeen: val.lastSeen, agentId: val.agentId, taskId: val.taskId }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit ?? 20);

      return {
        success: true,
        data: { totalErrors: rows.length, windowHours: hours ?? 24, distinctPatterns: grouped.size, topErrors: summary },
      };
    },
  },

  // ─── Schedule Task (sync — DB insert) ───────────────────────────────────────
  schedule_task: {
    schema: {
      name: 'schedule_task',
      description: 'Create a scheduled background job (cron recurring or one-time). Job types: task_delegation (delegates a task to an agent), health_check (runs health diagnostics), report_generation (generates daily summary), maintenance (cleans old logs/expired data).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable job name' },
          jobType: { type: 'string', enum: ['task_delegation', 'health_check', 'report_generation', 'maintenance'] },
          cronExpression: { type: 'string' },
          scheduledAt: { type: 'string' },
          targetAgentId: { type: 'string' },
          payload: { type: 'string' },
          priority: { type: 'number' },
        },
        required: ['name', 'jobType'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { name, jobType, cronExpression, scheduledAt, targetAgentId, payload, priority } = args as {
        name: string; jobType: string; cronExpression?: string; scheduledAt?: string;
        targetAgentId?: string; payload?: Record<string, unknown>; priority?: number;
      };
      let resolvedTargetAgentId: Id<'agents'> | undefined;
      if (targetAgentId) {
        const agent = await ctx.runQuery(internal.agents.getByLegacyId, { legacyId: targetAgentId });
        resolvedTargetAgentId = agent?._id;
      }
      const jobId = await ctx.runMutation(internal.toolRegistry.scheduledJobs_insert, {
        name, jobType, cronExpression,
        scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : undefined,
        targetAgentId: resolvedTargetAgentId,
        payload, priority,
      });
      return { created: true, jobId, name, jobType };
    },
  },

  // ─── List Scheduled Tasks (sync — DB read) ──────────────────────────────────
  list_scheduled_tasks: {
    schema: {
      name: 'list_scheduled_tasks',
      description: 'List all scheduled background jobs with their status, next run time, and last execution result.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string' }, limit: { type: 'number' } },
        required: [],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { status, limit } = args as { status?: 'active' | 'paused' | 'completed' | 'failed'; limit?: number };
      return await ctx.runQuery(internal.toolRegistry.scheduledJobs_list, { status, limit });
    },
  },

  // ─── Cancel Scheduled Task (sync — DB patch) ────────────────────────────────
  cancel_scheduled_task: {
    schema: {
      name: 'cancel_scheduled_task',
      description: 'Cancel or disable a scheduled background job by ID. The job will stop executing but its history is preserved.',
      parameters: {
        type: 'object',
        properties: { jobId: { type: 'string', description: 'The scheduled job ID to cancel' } },
        required: ['jobId'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { jobId } = args as { jobId: string };
      const id = jobId as Id<'scheduledJobs'>;
      const existing = await ctx.runQuery(internal.toolRegistry.scheduledJobs_get, { jobId: id });
      if (!existing) return { success: false, error: `No scheduled job with id ${jobId}` };
      await ctx.runMutation(internal.toolRegistry.scheduledJobs_cancel, { jobId: id });
      return { cancelled: true, jobId, name: existing.name };
    },
  },

  // ─── Get Job History (sync — DB read) ───────────────────────────────────────
  get_job_history: {
    schema: {
      name: 'get_job_history',
      description: 'Get the execution history for a specific scheduled job, including run times, duration, status, and any errors.',
      parameters: {
        type: 'object',
        properties: { jobId: { type: 'string', description: 'The scheduled job ID' }, limit: { type: 'number' } },
        required: ['jobId'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { jobId, limit } = args as { jobId: string; limit?: number };
      return await ctx.runQuery(internal.toolRegistry.jobExecutionLog_list, { jobId: jobId as Id<'scheduledJobs'>, limit });
    },
  },

  // ─── Analyze Performance (sync — DB read) ───────────────────────────────────
  analyze_performance: {
    schema: {
      name: 'analyze_performance',
      description: 'Analyze task execution outcomes, success rates, avg durations, and tool execution counts across agents and roles.',
      parameters: {
        type: 'object',
        properties: { role: { type: 'string' }, limit: { type: 'number' } },
        required: [],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { role, limit } = args as { role?: string; limit?: number };
      const all = await ctx.runQuery(internal.toolRegistry.taskOutcomes_listAll, {});
      const filtered = role ? all.filter((r) => r.role === role) : all;
      const rows = filtered.sort((a, b) => b._creationTime - a._creationTime).slice(0, limit ?? 50);

      const total = rows.length;
      const successCount = rows.filter((r) => r.success).length;
      const avgDurationMs = total > 0 ? rows.reduce((sum, r) => sum + r.durationMs, 0) / total : 0;
      const totalTools = rows.reduce((sum, r) => sum + r.toolExecutions, 0);

      return {
        totalTasks: total, successCount, failedCount: total - successCount,
        successRate: total > 0 ? successCount / total : 1.0,
        avgDurationMs, totalToolExecutions: totalTools, outcomes: rows,
      };
    },
  },

  // ─── Record Outcome (sync — DB insert) ──────────────────────────────────────
  record_outcome: {
    schema: {
      name: 'record_outcome',
      description: 'Record the outcome of a completed task execution (success/failure, duration, quality) so the learning system has real data to analyze. Call this automatically whenever a task finishes.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'ID of the completed task' },
          agentId: { type: 'string', description: 'ID of the agent that executed the task' },
          role: { type: 'string', description: 'Role of the executing agent' },
          durationMs: { type: 'number' },
          success: { type: 'boolean' },
          qualityScore: { type: 'number' },
          toolExecutions: { type: 'number' },
          llmCalls: { type: 'number' },
          iterations: { type: 'number' },
          requiredApprovals: { type: 'number' },
          errorType: { type: 'string' },
          complexity: { type: 'number' },
          satisfactionMetric: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['taskId', 'agentId', 'role', 'durationMs', 'success'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const a = args as {
        taskId: string; agentId: string; role: string; durationMs: number; success: boolean;
        qualityScore?: number; toolExecutions?: number; llmCalls?: number; iterations?: number;
        requiredApprovals?: number; errorType?: string; complexity?: number; satisfactionMetric?: number; tags?: string[];
      };
      // taskId/agentId stay opaque strings on the LLM-facing schema (verbatim,
      // matching the old free-text Postgres columns) but taskOutcomes is
      // strictly v.id('tasks')/v.id('agents') in the new schema — cast on the
      // way in, same as record_outcome's old callers always passed real IDs.
      const id = await ctx.runMutation(internal.toolRegistry.taskOutcomes_insert, {
        taskId: a.taskId as Id<'tasks'>,
        agentId: a.agentId as Id<'agents'>,
        role: a.role,
        durationMs: a.durationMs,
        success: a.success,
        qualityScore: a.qualityScore,
        toolExecutions: a.toolExecutions,
        llmCalls: a.llmCalls,
        iterations: a.iterations,
        requiredApprovals: a.requiredApprovals,
        errorType: a.errorType,
        complexity: a.complexity,
        satisfactionMetric: a.satisfactionMetric,
        tags: a.tags,
      });
      return { recorded: true, id };
    },
  },

  // ─── Get Insights (sync — DB read) ──────────────────────────────────────────
  get_insights: {
    schema: {
      name: 'get_insights',
      description: 'Get active learning insights and detected patterns across task executions.',
      parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { limit } = args as { limit?: number };
      return await ctx.runQuery(internal.toolRegistry.learningInsights_list, { limit });
    },
  },

  // ─── Get Strategy Recommendations (sync — DB read) ──────────────────────────
  get_strategy_recommendations: {
    schema: {
      name: 'get_strategy_recommendations',
      description: 'Get active strategy recommendations queue. All recommendations are advisory and await human review/approval.',
      parameters: { type: 'object', properties: { status: { type: 'string' } }, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { status } = args as { status?: 'pending' | 'approved' | 'rejected' | 'applied' };
      return await ctx.runQuery(internal.toolRegistry.strategyRecommendations_list, { status });
    },
  },

  // ─── Set Performance Baseline (sync — DB upsert) ────────────────────────────
  set_performance_baseline: {
    schema: {
      name: 'set_performance_baseline',
      description: 'Set or update a target performance baseline metric (e.g. avg_task_duration_ms, overall_success_rate). Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          metricName: { type: 'string', description: 'Metric identifier name' },
          baselineValue: { type: 'number' },
          measurementWindow: { type: 'string' },
          sampleSize: { type: 'number' },
        },
        required: ['metricName', 'baselineValue'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { metricName, baselineValue, measurementWindow, sampleSize } = args as {
        metricName: string; baselineValue: number; measurementWindow?: string; sampleSize?: number;
      };
      await ctx.runMutation(internal.toolRegistry.performanceBaselines_upsert, { metricName, baselineValue, measurementWindow, sampleSize });
      return { updated: true, metricName, baselineValue };
    },
  },

  // ─── Apply Strategy Recommendation (sync — DB patch + best-effort insight) ──
  apply_strategy_recommendation: {
    schema: {
      name: 'apply_strategy_recommendation',
      description: 'Mark an approved strategy recommendation as applied. Requires human approval.',
      parameters: {
        type: 'object',
        properties: { recommendationId: { type: 'string', description: 'ID of the strategy recommendation to apply' } },
        required: ['recommendationId'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { recommendationId } = args as { recommendationId: string };
      const id = recommendationId as Id<'strategyRecommendations'>;
      const existing = await ctx.runQuery(internal.toolRegistry.strategyRecommendations_get, { recommendationId: id });
      if (!existing) return { success: false, error: `No recommendation found with id ${recommendationId}` };

      if (existing.status !== 'approved') {
        return {
          success: false,
          error: `Recommendation ${recommendationId} must be approved before it can be applied (current status: ${existing.status})`,
          requiresApproval: true,
          currentStatus: existing.status,
        };
      }

      await ctx.runMutation(internal.toolRegistry.strategyRecommendations_markApplied, { recommendationId: id });

      let persistedAsInsight = false;
      try {
        await ctx.runMutation(internal.toolRegistry.learningInsights_insert, {
          insightType: 'improvement',
          title: `Applied strategy: ${existing.title}`,
          description: existing.text,
          confidence: existing.confidence,
          evidence: { sourceRecommendationId: recommendationId, type: existing.recommendationType },
          applied: true,
        });
        persistedAsInsight = true;
      } catch {
        // insight persistence is best-effort; apply still succeeded
      }

      return { applied: true, recommendationId, title: existing.title, persistedAsInsight };
    },
  },

  // ─── CI/CD: Run Tests (externalJob) ─────────────────────────────────────────
  run_tests: {
    schema: {
      name: 'run_tests',
      description: 'Run automated test suite and typechecks across workspace packages. Returns detailed test pass/fail report.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: () => ({ jobType: 'test', payload: {} }),
  },

  // ─── CI/CD: Run Lint (externalJob) ───────────────────────────────────────────
  run_lint: {
    schema: {
      name: 'run_lint',
      description: 'Run linter and strict typecheck audit across workspace packages.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: () => ({ jobType: 'lint', payload: {} }),
  },

  // ─── CI/CD: Build Project (externalJob) ─────────────────────────────────────
  build_project: {
    schema: {
      name: 'build_project',
      description: 'Build production assets for workspace packages including Vite dashboard.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: () => ({ jobType: 'build', payload: {} }),
  },

  // ─── CI/CD: Deploy to Environment (externalJob; approval required) ──────────
  deploy_to_environment: {
    schema: {
      name: 'deploy_to_environment',
      description: 'Deploy codebase to specified target environment (staging | production). Production deploys require explicit human approval.',
      parameters: {
        type: 'object',
        properties: {
          environment: { type: 'string', enum: ['staging', 'production'] },
          platform: { type: 'string', enum: ['vercel', 'local'] }, // railway retired 2026-08-16
        },
        required: ['environment'],
      },
    },
    requiresApproval: true,
    kind: 'externalJob',
    buildJobPayload: (args) => ({ jobType: 'deploy', payload: { environment: args.environment, platform: args.platform ?? 'local' } }),
  },

  // ─── CI/CD: Rollback Deployment (externalJob; approval required) ────────────
  rollback_deployment: {
    schema: {
      name: 'rollback_deployment',
      description: 'Rollback a deployment environment to the previous healthy release. Requires approval.',
      parameters: {
        type: 'object',
        properties: { deploymentId: { type: 'string', description: 'Deployment ID to roll back' } },
        required: ['deploymentId'],
      },
    },
    requiresApproval: true,
    kind: 'externalJob',
    buildJobPayload: (args) => ({ jobType: 'rollback', payload: { deploymentId: args.deploymentId } }),
  },

  // ─── CI/CD: Create Feature Branch (externalJob — real git) ──────────────────
  create_feature_branch: {
    schema: {
      name: 'create_feature_branch',
      description: 'Create a new git feature branch for isolated feature development. Requires approval.',
      parameters: {
        type: 'object',
        properties: { branchName: { type: 'string', description: 'Name of feature branch to create (e.g. "feat/learning-system")' } },
        required: ['branchName'],
      },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: (args) => ({ jobType: 'create_branch', payload: { branchName: args.branchName } }),
  },

  // ─── CI/CD: Git Status (externalJob — real git, read-only) ──────────────────
  git_status: {
    schema: {
      name: 'git_status',
      description: 'Get current git status: branch, uncommitted changes, and last commit. Read-only, no side effects.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'externalJob',
    buildJobPayload: () => ({ jobType: 'git_status', payload: {} }),
  },

  // ─── CI/CD: Push to Remote (externalJob — real git; approval required) ──────
  push_to_remote: {
    schema: {
      name: 'push_to_remote',
      description: 'Push committed changes on a branch to the GitHub remote. Requires approval and a GITHUB_TOKEN configured in this environment.',
      parameters: {
        type: 'object',
        properties: { branch: { type: 'string' }, remote: { type: 'string' } },
        required: [],
      },
    },
    requiresApproval: true,
    kind: 'externalJob',
    // "current branch" / GITHUB_TOKEN resolution needs real git/env access —
    // that now happens on the worker at execution time, not here.
    buildJobPayload: (args) => ({ jobType: 'push', payload: { branch: args.branch, remote: args.remote ?? 'origin' } }),
  },

  // ─── CI/CD: Create Pull Request (externalJob per plan; approval required) ───
  create_pull_request: {
    schema: {
      name: 'create_pull_request',
      description: 'Create a real pull request on GitHub via the GitHub API for code review. Requires approval and a GITHUB_TOKEN configured in this environment.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR Title' },
          body: { type: 'string', description: 'PR Description' },
          headBranch: { type: 'string', description: 'Feature branch name' },
          baseBranch: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['title', 'body', 'headBranch'],
      },
    },
    requiresApproval: true,
    kind: 'externalJob',
    buildJobPayload: (args) => ({
      jobType: 'create_pr',
      payload: {
        title: args.title, body: args.body, headBranch: args.headBranch,
        baseBranch: args.baseBranch ?? 'main', repo: args.repo ?? 'patriotnewsactivism/Apex',
      },
    }),
  },

  // ─── MultiApp: Register Application (sync — DB upsert; approval required) ───
  register_application: {
    schema: {
      name: 'register_application',
      description: 'Register a new portfolio application repository for multi-application orchestration. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Application identifier (e.g. "buildmybot2", "aria")' },
          name: { type: 'string', description: 'Display name' },
          repoUrl: { type: 'string', description: 'GitHub repository URL' },
        },
        required: ['id', 'name', 'repoUrl'],
      },
    },
    requiresApproval: true,
    kind: 'sync',
    run: async (ctx, args) => {
      const { id, name, repoUrl } = args as { id: string; name: string; repoUrl: string };
      await ctx.runMutation(internal.toolRegistry.applications_upsert, { legacyId: id.toLowerCase(), name, repoUrl });
      return { success: true, id, name };
    },
  },

  // ─── MultiApp: App Health Check (sync — DB read) ────────────────────────────
  app_health_check: {
    schema: {
      name: 'app_health_check',
      description: 'Check health status and sync reachability of a registered portfolio application.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Application identifier' } },
        required: ['id'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { id } = args as { id: string };
      const app = await ctx.runQuery(internal.toolRegistry.applications_getByLegacyId, { legacyId: id });
      if (!app) return { status: 'not_found', healthScore: 0 };
      return { status: app.status, healthScore: app.healthScore, lastSyncAt: app.lastSyncAt };
    },
  },

  // ─── MultiApp: Delegate to Application (sync — DB insert; approval required) ──
  delegate_to_application: {
    schema: {
      name: 'delegate_to_application',
      description: 'Delegate a task to a registered target application repository. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: 'Target application ID' },
          taskName: { type: 'string', description: 'Task name / specification' },
        },
        required: ['appId', 'taskName'],
      },
    },
    requiresApproval: true,
    kind: 'sync',
    run: async (ctx, args) => {
      const { appId, taskName } = args as { appId: string; taskName: string };
      const app = await ctx.runQuery(internal.toolRegistry.applications_getByLegacyId, { legacyId: appId });
      if (!app) return { success: false, error: `No application registered with id ${appId}` };
      const taskId = await ctx.runMutation(internal.toolRegistry.applicationTasks_insert, { appId: app._id, taskName });
      return { taskId, appId, taskName, status: 'pending' };
    },
  },

  // ─── MultiApp: Shared Insights (sync — DB read) ─────────────────────────────
  shared_insights: {
    schema: {
      name: 'shared_insights',
      description: 'Get read-only cross-application shared insights and global learnings.',
      parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { limit } = args as { limit?: number };
      return await ctx.runQuery(internal.toolRegistry.memories_listGlobal, { limit });
    },
  },

  // ─── Predictive: Forecast Tasks (sync — DB read + best-effort insert) ───────
  forecast_tasks: {
    schema: {
      name: 'forecast_tasks',
      description: 'Compute predictive task completion velocity and success rate forecasts with confidence intervals.',
      parameters: {
        type: 'object',
        properties: { metricName: { type: 'string' }, window: { type: 'string' } },
        required: [],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { metricName, window } = args as { metricName?: string; window?: string };
      const resolvedMetricName = metricName ?? 'task_completion_rate';
      const resolvedWindow = window ?? '7d';
      const since = Date.now() - windowToMs(resolvedWindow);

      const all = await ctx.runQuery(internal.toolRegistry.taskOutcomes_listAll, {});
      const outcomes = all.filter((o) => o._creationTime >= since);

      const total = outcomes.length;
      const successCount = outcomes.filter((o) => o.success).length;
      const forecastValue = total > 0 ? (successCount / total) * 100 : 95.0;
      const confidenceInterval = wilsonConfidenceInterval(successCount, total);
      const confidence = total > 0 ? Math.min(0.95, 0.7 + total * 0.02) : 0.35;

      try {
        await ctx.runMutation(internal.toolRegistry.predictiveForecasts_insert, {
          metricName: resolvedMetricName, forecastValue, confidence, window: resolvedWindow,
        });
      } catch {
        // advisory persistence is best-effort, matches old .catch(() => {})
      }

      return {
        metricName: resolvedMetricName, forecastValue, confidence, window: resolvedWindow,
        sampleSize: total, observedSuccessRate: total > 0 ? successCount / total : null,
        confidenceInterval, advisoryOnly: true, actionsTriggered: [],
      };
    },
  },

  // ─── Predictive: Risk Assessment (sync — DB read + best-effort insert) ──────
  risk_assessment: {
    schema: {
      name: 'risk_assessment',
      description: 'Run automated risk detection across portfolio applications and systemic performance trends.',
      parameters: { type: 'object', properties: { target: { type: 'string' } }, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (ctx, args) => {
      const { target } = args as { target?: string };
      const resolvedTarget = target ?? 'global';
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const all = await ctx.runQuery(internal.toolRegistry.taskOutcomes_listAll, {});
      const outcomes = all.filter((o) => o._creationTime >= since);

      const total = outcomes.length;
      const failures = outcomes.filter((o) => !o.success).length;
      const failureRate = total > 0 ? failures / total : 0;
      const confidence = total > 0 ? Math.min(0.95, 0.65 + total * 0.025) : 0.3;

      let riskLevel: 'low' | 'medium' | 'high' = 'low';
      let details = 'All portfolio systems operating within normal parameters.';
      if (failureRate > 0.3) {
        riskLevel = 'high';
        details = `High failure rate detected (${(failureRate * 100).toFixed(1)}%) across recent task outcomes.`;
      } else if (failureRate > 0.15) {
        riskLevel = 'medium';
        details = `Moderate failure rate detected (${(failureRate * 100).toFixed(1)}%). Recommended monitoring.`;
      }

      try {
        await ctx.runMutation(internal.toolRegistry.riskAssessments_insert, { target: resolvedTarget, riskLevel, details });
      } catch {
        // advisory persistence is best-effort, matches old .catch(() => {})
      }

      return { target: resolvedTarget, riskLevel, details, sampleSize: total, failureRate, confidence, advisoryOnly: true, actionsTriggered: [] };
    },
  },

  // ─── BuildMyBot: Status (sync — Supabase REST read) ─────────────────────────
  buildmybot_status: {
    schema: {
      name: 'buildmybot_status',
      description:
        "Get today's BuildMyBot AI-workforce status: shift outcomes per role, open error count, open escalations, and lead pipeline counts. Read this BEFORE issuing any briefing or directive so commands are grounded in real telemetry.",
      parameters: {
        type: 'object',
        properties: {
          includeYesterday: { type: 'boolean', description: 'Also include the prior day of shift logs for trend context' },
        },
        required: [],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (_ctx, args) => {
      const { includeYesterday } = args as { includeYesterday?: boolean };
      const today = bmbTodayISO();
      const dateFilter = includeYesterday
        ? `shift_date=gte.${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`
        : `shift_date=eq.${today}`;

      const [shifts, openErrors, escalations, leadsNew, leadsAwaiting] = await Promise.all([
        bmbFetch('ai_team_log', `${dateFilter}&order=created_at.desc&limit=60`),
        bmbFetch('error_logs', 'status=eq.open&order=created_at.desc&limit=25&select=id,source,level,message,created_at'),
        bmbFetch('escalations', 'order=created_at.desc&limit=15').catch(() => []),
        bmbFetch('leads', `created_at=gte.${today}&select=id&limit=500`).catch(() => []),
        bmbFetch('leads', 'replied_at=is.null&follow_up_sent_at=not.is.null&select=id&limit=500').catch(() => []),
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

  // ─── BuildMyBot: Send Briefing (sync — Supabase REST write; approval required) ──
  buildmybot_send_briefing: {
    schema: {
      name: 'buildmybot_send_briefing',
      description:
        "Issue today's top-priority directive to EVERY BuildMyBot AI employee. Each role reads the latest briefing first on its next shift and prioritizes it above all other work. One row per day; the latest briefing wins. Use for steering (e.g. 'prioritize churn-risk leads today'), never for fabricating status.",
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The directive text. Concrete and actionable; the whole team sees it verbatim.' },
        },
        required: ['content'],
      },
    },
    requiresApproval: true,
    kind: 'sync',
    run: async (_ctx, args) => {
      const { content } = args as { content: string };
      const rows = await bmbFetch('manager_briefings', '', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ briefing_date: bmbTodayISO(), content, delivered_via: 'apex' }),
      });
      return { saved: true, briefing: rows?.[0] ?? null };
    },
  },

  // ─── BuildMyBot: Open Errors (sync — Supabase REST read) ─────────────────────
  buildmybot_open_errors: {
    schema: {
      name: 'buildmybot_open_errors',
      description:
        'List open (unresolved) BuildMyBot agent errors with full context, worst first. Use to decide what needs human attention vs. a corrective briefing.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max rows (default 25)' } },
        required: [],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (_ctx, args) => {
      const { limit } = args as { limit?: number };
      const rows = await bmbFetch('error_logs', `status=eq.open&order=level.asc,created_at.desc&limit=${limit ?? 25}`);
      return rows ?? [];
    },
  },

  // ─── BuildMyBot: Dispatch Engineering (sync — delegateToRole('LEAD_DEV')) ────
  buildmybot_dispatch_engineering: {
    schema: {
      name: 'buildmybot_dispatch_engineering',
      description:
        "Dispatch a real engineering task into the buildmybot2 codebase (github.com/patriotnewsactivism/buildmybot2). Creates a task assigned to the Lead Developer with full repo/deploy/health-check context attached — exactly like an internal Apex engineering ticket, not just a status read. The Lead Dev lands changes via the approval-gated create_pull_request tool; use buildmybot_deploy after merge and buildmybot_health_check to verify.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative ticket title' },
          spec: { type: 'string', description: 'Full engineering spec: what to change, where, acceptance criteria, and how to verify' },
          priority: { type: 'number', description: '1 (highest) – 10 (lowest); default 4' },
        },
        required: ['title', 'spec'],
      },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async (_ctx, args, toolContext) => {
      const { title, spec, priority } = args as { title: string; spec: string; priority?: number };
      const appUrl = process.env.BUILDMYBOT_APP_URL ?? 'https://www.buildmybot.app';
      const taskId = await toolContext.delegateToRole('LEAD_DEV', {
        title,
        description: spec,
        parentTaskId: toolContext.taskId,
        priority,
        context: {
          project: 'buildmybot2',
          repo: 'patriotnewsactivism/buildmybot2',
          repoUrl: 'https://github.com/patriotnewsactivism/buildmybot2',
          prInstructions:
            "Land changes via create_pull_request with repo 'patriotnewsactivism/buildmybot2' — never direct pushes to main",
          deployInstructions: 'After merge, request buildmybot_deploy (approval-gated Vercel deploy hook)',
          healthCheckUrl: `${appUrl}/api/health`,
        },
      });
      return {
        success: true, taskId, assignedTo: 'LEAD_DEV', project: 'buildmybot2',
        message: `Engineering task dispatched into buildmybot2: ${title}`,
      };
    },
  },

  // ─── BuildMyBot: Deploy (sync — Vercel deploy hook; approval required) ───────
  buildmybot_deploy: {
    schema: {
      name: 'buildmybot_deploy',
      description:
        'Trigger a production rebuild+deploy of buildmybot2 via its Vercel deploy hook. Only rebuilds what is already merged to the production branch — this is NOT a way around PR review. Requires BUILDMYBOT_VERCEL_DEPLOY_HOOK and approval.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why this deploy is being triggered (audit trail)' } },
        required: ['reason'],
      },
    },
    requiresApproval: true,
    kind: 'sync',
    run: async (_ctx, args) => {
      const { reason } = args as { reason: string };
      const hook = process.env.BUILDMYBOT_VERCEL_DEPLOY_HOOK;
      if (!hook) throw new Error('BUILDMYBOT_VERCEL_DEPLOY_HOOK is not configured');
      const res = await fetch(hook, { method: 'POST' });
      const body = await res.text();
      if (!res.ok) throw new Error(`Deploy hook returned ${res.status}: ${body.slice(0, 300)}`);
      return { success: true, reason, response: body.slice(0, 500) };
    },
  },

  // ─── BuildMyBot: Health Check (sync — live HTTP check) ───────────────────────
  buildmybot_health_check: {
    schema: {
      name: 'buildmybot_health_check',
      description:
        'Live HTTP health check against the deployed buildmybot.app API (/api/health). Use after a deploy, and as the buildmybot2 leg of any portfolio health sweep. Reports real HTTP status and latency — never a guess.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresApproval: false,
    kind: 'sync',
    run: async () => {
      const appUrl = process.env.BUILDMYBOT_APP_URL ?? 'https://www.buildmybot.app';
      const url = `${appUrl}/api/health`;
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
};

// ═══════════════════════════════════════════════════════════════════════════
// Public entry points — mirrors the old ToolRegistry.getLLMToolSchemas / .execute
// ═══════════════════════════════════════════════════════════════════════════

/** Mirrors the old `registry.getLLMToolSchemas(this.config.tools)`. */
export function getLLMToolSchemas(allowedNames?: string[]): LLMTool[] {
  const defs = Object.values(TOOL_DEFS);
  const filtered = allowedNames ? defs.filter((d) => allowedNames.includes(d.schema.name)) : defs;
  return filtered.map((d) => ({ name: d.schema.name, description: d.schema.description, parameters: d.schema.parameters }));
}

/**
 * Looks up TOOL_DEFS[toolName] and either runs it synchronously (kind:'sync')
 * or enqueues it for the standalone CI/CD worker (kind:'externalJob').
 *
 * Approval gating is deliberately NOT done here — the caller (agentLoop.ts)
 * checks `TOOL_DEFS[toolName].requiresApproval` (surfaced by getToolDef below)
 * and calls toolContext.requestApproval(...) itself before ever calling
 * dispatchTool, exactly mirroring how the old ToolRegistry.execute() applied
 * its approval gate before calling tool.execute().
 */
export async function dispatchTool(
  ctx: ActionCtx,
  toolName: string,
  args: any,
  toolContext: ToolContext,
  toolCallId: string,
): Promise<ToolOutcome> {
  const def = TOOL_DEFS[toolName];
  if (!def) throw new Error(`Unknown tool: ${toolName}`);

  if (def.kind === 'sync') {
    if (!def.run) throw new Error(`Tool '${toolName}' is marked kind:'sync' but has no run() implementation`);
    const result = await def.run(ctx, args, toolContext);
    return { kind: 'sync', result };
  }

  if (!def.buildJobPayload) throw new Error(`Tool '${toolName}' is marked kind:'externalJob' but has no buildJobPayload() implementation`);
  const { jobType, payload } = def.buildJobPayload(args, toolContext);
  const jobId = await ctx.runMutation(internal.cicd.enqueueJob, {
    jobType,
    payload,
    requestingTaskId: toolContext.taskId,
    requestingAgentId: toolContext.agentId,
    toolCallId,
  });
  return { kind: 'pendingExternalJob', jobId };
}

/** Lets agentLoop.ts check `requiresApproval` before calling dispatchTool. */
export function getToolDef(toolName: string): Pick<ToolDef, 'requiresApproval' | 'kind'> | undefined {
  const def = TOOL_DEFS[toolName];
  if (!def) return undefined;
  return { requiresApproval: def.requiresApproval, kind: def.kind };
}

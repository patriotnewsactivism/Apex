import { v } from 'convex/values';
import { internalQuery, internalMutation } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';

// ─── Job Handlers ────────────────────────────────────────────────────────────
//
// Ports packages/background-jobs/src/handlers/index.ts's 6 JobHandler classes.
// The old handlers were stateless classes with one `execute(job)` method
// hitting Drizzle directly; here each is a plain async function taking the
// action's ctx (so it can ctx.runQuery/ctx.runMutation/ctx.runAction — actions
// never touch ctx.db directly, same rule agentLoop.ts follows) plus the
// scheduledJobs row. convex/scheduledJobs.ts's executeJob calls into
// JOB_HANDLERS[job.jobType], the direct equivalent of the old JobExecutor's
// `this.handlers.get(job.jobType)` Map lookup.
//
// Colocated here are the small internalQuery/internalMutation helpers each
// handler needs for tables that don't have their own dedicated module yet
// (mirrors how toolRegistry.ts colocates helpers for the same reason).

export type JobHandlerFn = (ctx: ActionCtx, job: Doc<'scheduledJobs'>) => Promise<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// TaskDelegationJob — delegates a task to an agent via tasks.enqueue
// ═══════════════════════════════════════════════════════════════════════════

async function taskDelegationJob(ctx: ActionCtx, job: Doc<'scheduledJobs'>): Promise<unknown> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const targetAgentId = job.targetAgentId;
  if (!targetAgentId) {
    throw new Error('TaskDelegationJob requires targetAgentId');
  }

  // Reuses convex/tasks.ts's existing internal mutation rather than
  // reimplementing task creation raw. NOTE: the old code stamped
  // createdByAgentId with the string sentinel 'system-scheduler' — that
  // column is now a real v.id('agents'), which a scheduler process has no
  // agent row for, so it's simply omitted; tasks.enqueue already defaults
  // createdByAgentId to assignedAgentId when not provided.
  const taskId = await ctx.runMutation(internal.tasks.enqueue, {
    assignedAgentId: targetAgentId,
    title: (payload.title as string | undefined) ?? `Scheduled task: ${job.name}`,
    description: (payload.description as string | undefined) ?? `Automatically scheduled task from job '${job.name}'`,
    priority: job.priority,
    context: { scheduledJobId: job._id, ...payload },
  });

  return { taskId, assignedTo: targetAgentId };
}

// ═══════════════════════════════════════════════════════════════════════════
// HealthCheckJob — delegates to convex/health.ts's ported HealthMonitor +
// AlertManager. Deliberately NOT reimplemented here — a sibling subagent is
// porting packages/health-monitor/* into convex/health.ts concurrently.
//
// ASSUMED EXPORT: `internal.health.runHealthCheck` as an internalAction with
// args {} that runs the health checks, evaluates alert rules, persists
// healthMetrics/componentHealth/alerts rows, and returns a report object.
// If health.ts lands with a different export name, update this call site —
// do not duplicate the health-check logic in this file.
// ═══════════════════════════════════════════════════════════════════════════

async function healthCheckJob(ctx: ActionCtx, _job: Doc<'scheduledJobs'>): Promise<unknown> {
  const report = await ctx.runAction(internal.health.runHealthCheck, {});
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// ReportGenerationJob — daily summary of system activity, stored as a memory
// ═══════════════════════════════════════════════════════════════════════════

/** tasks has no global time-range index (only by_agent_status_retry / by_goal /
 * by_parentTask / by_legacyId, and schema.ts is out of scope for this port), so
 * this takes a bounded recent-order window instead of an unbounded collect —
 * the same shape of tradeoff convex/logs.ts's `recent` query already makes.
 * If task throughput in a single day exceeds RECENT_SCAN_LIMIT this
 * undercounts rather than erroring or scanning unboundedly, which is
 * acceptable for a daily digest metric (a future by_updatedAt index would
 * make this exact). */
const RECENT_SCAN_LIMIT = 3000;

export const reportTaskCounts24h = internalQuery({
  args: { since: v.number() },
  returns: v.object({ total: v.number(), completed: v.number(), failed: v.number() }),
  handler: async (ctx, { since }) => {
    const recent = await ctx.db.query('tasks').order('desc').take(RECENT_SCAN_LIMIT);
    const inWindow = recent.filter((t) => t.updatedAt >= since);
    return {
      total: inWindow.length,
      completed: inWindow.filter((t) => t.status === 'done').length,
      failed: inWindow.filter((t) => t.status === 'failed').length,
    };
  },
});

export const reportErrorCount24h = internalQuery({
  args: { since: v.number() },
  returns: v.object({ total: v.number() }),
  handler: async (ctx, { since }) => {
    const recent = await ctx.db.query('logs').order('desc').take(RECENT_SCAN_LIMIT);
    const inWindow = recent.filter((l) => l.level === 'error' && l.timestamp >= since);
    return { total: inWindow.length };
  },
});

/** goals is a small, business-level table (one row per initiative, not a
 * high-frequency log/task table) — in practice this never approaches
 * GOALS_SCAN_LIMIT, but it's bounded with .take() rather than .collect()
 * regardless, per the "never unbounded" rule. Covers both
 * ReportGenerationJob's goal counts and its "ARIA dispatch volume" (24h
 * goal-creation count, since ARIA dispatches work into the swarm as goals). */
const GOALS_SCAN_LIMIT = 5000;

export const reportGoalStats = internalQuery({
  args: { since: v.number() },
  returns: v.object({ active: v.number(), completed: v.number(), goalsDispatched24h: v.number() }),
  handler: async (ctx, { since }) => {
    const all = await ctx.db.query('goals').order('desc').take(GOALS_SCAN_LIMIT);
    return {
      active: all.filter((g) => g.status === 'active').length,
      completed: all.filter((g) => g.status === 'completed').length,
      goalsDispatched24h: all.filter((g) => g._creationTime >= since).length,
    };
  },
});

async function reportGenerationJob(ctx: ActionCtx, _job: Doc<'scheduledJobs'>): Promise<unknown> {
  const since = Date.now() - 24 * 60 * 60 * 1000;

  const [taskCounts, goalStats, errorCounts] = await Promise.all([
    ctx.runQuery(internal.jobHandlers.reportTaskCounts24h, { since }),
    ctx.runQuery(internal.jobHandlers.reportGoalStats, { since }),
    ctx.runQuery(internal.jobHandlers.reportErrorCount24h, { since }),
  ]);

  // ── Portfolio leg: BuildMyBot2 AI Team shift outcomes, so the daily summary
  // is ONE view of the whole business instead of separate dashboards.
  // Best-effort: a missing env or unreachable Supabase yields an honest note,
  // never a crashed report. Ported verbatim from the old ReportGenerationJob —
  // deliberately not gold-plated with the extra https:// protocol validation
  // toolRegistry.ts's separate buildmybot2 health-check tool added later.
  let buildMyBotAITeam: unknown;
  {
    const url = process.env.BUILDMYBOT_SUPABASE_URL;
    const key = process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      buildMyBotAITeam = { note: 'BUILDMYBOT_SUPABASE_URL / _SERVICE_KEY not configured' };
    } else {
      try {
        const headers = { apikey: key, Authorization: `Bearer ${key}` };
        const today = new Date().toISOString().slice(0, 10);
        const [shiftsRes, criticalsRes] = await Promise.all([
          fetch(
            `${url}/rest/v1/ai_team_log?shift_date=eq.${today}&select=role_name,summary,flags,escalated_to&limit=100`,
            { headers, signal: AbortSignal.timeout(8_000) },
          ),
          fetch(
            `${url}/rest/v1/error_logs?status=eq.open&level=eq.critical&select=source,message&limit=25`,
            { headers, signal: AbortSignal.timeout(8_000) },
          ),
        ]);
        const shifts = (shiftsRes.ok ? await shiftsRes.json() : []) as Array<{
          role_name: string;
          flags?: unknown;
          escalated_to?: unknown;
        }>;
        const criticals = (criticalsRes.ok ? await criticalsRes.json() : []) as Array<{
          source: string;
          message: string;
        }>;
        buildMyBotAITeam = {
          shiftsToday: shifts.length,
          rolesReported: [...new Set(shifts.map((s) => s.role_name))],
          flaggedOrEscalated: shifts.filter((s) => s.flags || s.escalated_to).length,
          openCriticals: criticals.length,
          providerChainExhaustions: criticals.filter((c) => c.source === 'llm-provider-chain').length,
        };
      } catch (err) {
        buildMyBotAITeam = { note: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

  const report = {
    period: '24h',
    generatedAt: new Date().toISOString(),
    tasks: taskCounts,
    goals: { active: goalStats.active, completed: goalStats.completed },
    errors: errorCounts,
    buildMyBotAITeam,
    ariaDispatch: { goalsDispatched24h: goalStats.goalsDispatched24h },
  };

  // Store the report as a memory for the CEO to reference — real Convex _id
  // via legacyId lookup, matching every other 'apex-ceo-001' reference in
  // this codebase (see convex/agents.ts's getByLegacyId).
  const ceo = await ctx.runQuery(internal.agents.getByLegacyId, { legacyId: 'apex-ceo-001' });
  if (!ceo) {
    throw new Error("ReportGenerationJob: no agent found with legacyId 'apex-ceo-001' — has the roster been seeded?");
  }

  await ctx.runMutation(internal.memories.upsert, {
    agentId: ceo._id,
    key: `daily-report:${new Date().toISOString().slice(0, 10)}`,
    value: JSON.stringify(report),
    scope: 'global',
    importance: 0.7,
    tags: ['daily-report', 'automated'],
  });

  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// MaintenanceJob — cleans old logs, expired memories, stale job execution logs
// ═══════════════════════════════════════════════════════════════════════════

/** Convex has no bulk delete — iterate and ctx.db.delete(doc._id), same as
 * every other cleanup sweep in this codebase. Each table is scanned oldest-
 * first via the default _creationTime order (no index needed for this — take()
 * alone bounds the read), capped at MAINTENANCE_BATCH_LIMIT per table per run
 * so a single invocation can never approach the ~16k read / ~8k write ceiling.
 * If the eligible backlog exceeds the cap, it's cleaned up over several 60s
 * dispatch cycles instead of all at once — harmless for a maintenance sweep. */
const MAINTENANCE_BATCH_LIMIT = 1000;

export const runMaintenanceSweep = internalMutation({
  args: {},
  returns: v.object({
    cleanedAt: v.string(),
    logsRemoved: v.number(),
    expiredMemoriesRemoved: v.number(),
    oldJobLogsRemoved: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    // 1. Old debug/info logs (keep 7 days)
    const logCandidates = await ctx.db.query('logs').order('asc').take(MAINTENANCE_BATCH_LIMIT);
    let logsRemoved = 0;
    for (const l of logCandidates) {
      if (l.timestamp < sevenDaysAgo && (l.level === 'debug' || l.level === 'info')) {
        await ctx.db.delete(l._id);
        logsRemoved++;
      }
    }

    // 2. Expired memories
    const memCandidates = await ctx.db.query('memories').order('asc').take(MAINTENANCE_BATCH_LIMIT);
    let expiredMemoriesRemoved = 0;
    for (const m of memCandidates) {
      if (m.expiresAt !== undefined && m.expiresAt <= now) {
        await ctx.db.delete(m._id);
        expiredMemoriesRemoved++;
      }
    }

    // 3. Old job execution logs (keep 30 days)
    const jobLogCandidates = await ctx.db.query('jobExecutionLog').order('asc').take(MAINTENANCE_BATCH_LIMIT);
    let oldJobLogsRemoved = 0;
    for (const jl of jobLogCandidates) {
      if (jl.startedAt < thirtyDaysAgo) {
        await ctx.db.delete(jl._id);
        oldJobLogsRemoved++;
      }
    }

    return {
      cleanedAt: new Date(now).toISOString(),
      logsRemoved,
      expiredMemoriesRemoved,
      oldJobLogsRemoved,
    };
  },
});

async function maintenanceJob(ctx: ActionCtx, _job: Doc<'scheduledJobs'>): Promise<unknown> {
  return await ctx.runMutation(internal.jobHandlers.runMaintenanceSweep, {});
}

// ═══════════════════════════════════════════════════════════════════════════
// GoalReviewJob — "the autonomous spark that makes APEX self-directing"
//
// Before this handler existed, agent activity was purely reactive — the CEO
// only reasoned when a human hit POST /api/goals, and the scheduler polled an
// empty scheduledJobs table forever on a fresh DB. This job runs on a cron
// schedule, snapshots REAL system state (active goals, task backlog,
// component health, recent learning insights, BuildMyBot2 telemetry), and
// enqueues a task for the CEO to reason about it and originate/delegate the
// highest-value next work — or consciously decide nothing needs doing. No
// human endpoint call required.
//
// Charter-safe: the CEO's own tools are read/research/delegation; any
// downstream irreversible action (deploy, external send, schema, financial)
// still hits its per-tool human-approval gate (agentLoop.ts's
// requiresApproval dispatch). The prompt explicitly instructs restraint so
// the loop does not generate busywork or unbounded token spend.
// ═══════════════════════════════════════════════════════════════════════════

export const goalReviewActiveGoals = internalQuery({
  args: {},
  returns: v.array(v.object({ goalId: v.id('goals'), title: v.string(), priority: v.number() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query('goals').withIndex('by_status', (q) => q.eq('status', 'active')).collect();
    return rows
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 10)
      .map((g) => ({ goalId: g._id, title: g.title, priority: g.priority }));
  },
});

/** No global "all tasks by status" index exists (tasks.by_agent_status_retry
 * is scoped per-agent, and schema.ts is out of scope for this port), so this
 * sums the backlog across the fixed, small agent roster instead of an
 * unbounded collect over the whole tasks table — each per-(agent,status)
 * query is index-scoped and bounded by that agent's real backlog. */
const AGENTS_SCAN_LIMIT = 500;

export const goalReviewBacklogCount = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const agentsList = await ctx.db.query('agents').take(AGENTS_SCAN_LIMIT);
    let count = 0;
    for (const agent of agentsList) {
      const pending = await ctx.db
        .query('tasks')
        .withIndex('by_agent_status_retry', (q) => q.eq('assignedAgentId', agent._id).eq('status', 'pending'))
        .collect();
      const inProgress = await ctx.db
        .query('tasks')
        .withIndex('by_agent_status_retry', (q) => q.eq('assignedAgentId', agent._id).eq('status', 'in_progress'))
        .collect();
      count += pending.length + inProgress.length;
    }
    return count;
  },
});

/** componentHealth is a small, one-row-per-monitored-component operational
 * table (bounded by the number of monitored components, not a growing log) —
 * bounded with .take() rather than .collect() regardless, per the "never
 * unbounded" rule. */
const COMPONENT_HEALTH_SCAN_LIMIT = 500;

export const goalReviewUnhealthyComponents = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      component: v.string(),
      status: v.union(v.literal('healthy'), v.literal('degraded'), v.literal('critical')),
      detail: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const all = await ctx.db.query('componentHealth').take(COMPONENT_HEALTH_SCAN_LIMIT);
    return all
      .filter((c) => c.status === 'degraded' || c.status === 'critical')
      .map((c) => ({ component: c.component, status: c.status, detail: c.detail }));
  },
});

async function goalReviewJob(ctx: ActionCtx, job: Doc<'scheduledJobs'>): Promise<unknown> {
  let targetAgentId = job.targetAgentId;
  if (!targetAgentId) {
    const ceo = await ctx.runQuery(internal.agents.getByLegacyId, { legacyId: 'apex-ceo-001' });
    if (!ceo) {
      throw new Error("GoalReviewJob: no targetAgentId set on job and no agent found with legacyId 'apex-ceo-001'");
    }
    targetAgentId = ceo._id;
  }

  // Snapshot real state so the CEO reasons from facts, not a vacuum.
  const activeGoals = await ctx.runQuery(internal.jobHandlers.goalReviewActiveGoals, {});
  const openTaskBacklog = await ctx.runQuery(internal.jobHandlers.goalReviewBacklogCount, {});
  const unhealthy = await ctx.runQuery(internal.jobHandlers.goalReviewUnhealthyComponents, {});
  // Reuses agentLoop.ts's existing recentLearningInsights query (already
  // exported, already read elsewhere) rather than adding a duplicate.
  const allInsights = await ctx.runQuery(internal.agentLoop.recentLearningInsights, {});
  const recentInsights = allInsights
    .slice(0, 5)
    .map((i: { title: string; insightType: string }) => ({ title: i.title, insightType: i.insightType }));

  // BuildMyBot2 telemetry — the portfolio leg, so the autonomous review
  // operates on the revenue flagship too, not just Apex's own queue. Mirrors
  // the proven best-effort Supabase fetch in ReportGenerationJob: a missing
  // env or an unreachable Supabase yields an honest note, never a crash.
  let buildmybot2: unknown;
  {
    const url = process.env.BUILDMYBOT_SUPABASE_URL;
    const key = process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      buildmybot2 = { note: 'BUILDMYBOT_SUPABASE_URL / _SERVICE_KEY not configured' };
    } else {
      try {
        const headers = { apikey: key, Authorization: `Bearer ${key}` };
        const today = new Date().toISOString().slice(0, 10);
        const [errorsRes, leadsRes, shiftsRes] = await Promise.all([
          fetch(
            `${url}/rest/v1/error_logs?status=eq.open&order=level.asc,created_at.desc&limit=10&select=id,source,level,message`,
            { headers, signal: AbortSignal.timeout(6_000) },
          ),
          fetch(
            `${url}/rest/v1/leads?replied_at=is.null&select=id,status,follow_up_sent_at&limit=500`,
            { headers, signal: AbortSignal.timeout(6_000) },
          ),
          fetch(
            `${url}/rest/v1/ai_team_log?shift_date=eq.${today}&select=role_name,flags,escalated_to&limit=100`,
            { headers, signal: AbortSignal.timeout(6_000) },
          ),
        ]);
        const openErrors = (errorsRes.ok ? await errorsRes.json() : []) as Array<{
          id: string;
          source: string;
          level: string;
          message: string;
        }>;
        const leadsAwaiting = (leadsRes.ok ? await leadsRes.json() : []) as Array<{
          id: string;
          status: string;
          follow_up_sent_at: string | null;
        }>;
        const shifts = (shiftsRes.ok ? await shiftsRes.json() : []) as Array<{
          role_name: string;
          flags?: unknown;
          escalated_to?: unknown;
        }>;
        buildmybot2 = {
          openErrors: openErrors.length,
          worstErrors: openErrors.slice(0, 3),
          leadsAwaitingReply: leadsAwaiting.length,
          shiftsToday: shifts.length,
          flaggedShifts: shifts.filter((s) => s.flags || s.escalated_to).length,
        };
      } catch (err) {
        buildmybot2 = { note: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

  const snapshot = {
    activeGoals,
    openTaskBacklog,
    unhealthyComponents: unhealthy,
    recentInsights,
    buildmybot2,
    reviewedAt: new Date().toISOString(),
  };

  const description = [
    'AUTONOMOUS PERIODIC REVIEW — no human requested this; you are self-directing.',
    'Review the current state below and decide the highest-value next work for the business.',
    '',
    '## Current State',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
    '',
    '## Your job',
    '1. If there are active goals, take the highest-priority one and delegate concrete initiatives to your CTO/COO via sendMessage (or dispatchSwarm for multi-perspective work).',
    '2. If a component is degraded/critical, delegate investigation and a fix to the CTO.',
    '3. If a recent insight signals a recurring problem, act on it.',
    '4. BuildMyBot2 (managed revenue flagship): if snapshot.buildmybot2 shows open errors (especially critical), flagged/escalated shifts, or leads stalling without reply, delegate to the COO (apex-coo-001) — it owns buildmybot_status / buildmybot_send_briefing / buildmybot_dispatch_engineering. Have it send a corrective briefing or dispatch an engineering fix as warranted.',
    '5. RESTRAINT: do NOT create busywork. If the system is healthy and nothing needs doing, record a one-line note to memory and create no tasks.',
    'Irreversible actions (deploys, external sends, schema changes, financial) still require human approval — propose and queue them, do not execute.',
  ].join('\n');

  const now = new Date();
  const taskId = await ctx.runMutation(internal.tasks.enqueue, {
    assignedAgentId: targetAgentId,
    title: `Autonomous goal review — ${now.toISOString()}`,
    description,
    priority: job.priority,
    context: { scheduledJobId: job._id, snapshot },
  });

  return {
    taskId,
    assignedTo: targetAgentId,
    activeGoals: activeGoals.length,
    unhealthyComponents: unhealthy.length,
    openTaskBacklog,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LearningAnalysisJob — autonomous pattern detection + insight generation.
// Deliberately NOT reimplemented here — a sibling subagent is porting
// packages/learning-system/* into convex/learning.ts concurrently.
//
// ASSUMED EXPORT: `internal.learning.runAnalysis` as a single orchestrating
// internalAction with args {} that runs PatternDetector -> InsightGenerator ->
// StrategyOptimizer end to end and returns
// { patternsDetected, insightsCreated, recommendationsCreated }. If
// learning.ts lands with a different export name, update this call site.
// ═══════════════════════════════════════════════════════════════════════════

async function learningAnalysisJob(ctx: ActionCtx, _job: Doc<'scheduledJobs'>): Promise<unknown> {
  const result = await ctx.runAction(internal.learning.runAnalysis, {});
  return { ...result, analyzedAt: new Date().toISOString() };
}

// ═══════════════════════════════════════════════════════════════════════════
// Registry — the direct equivalent of the old JobExecutor's
// `handlers = new Map<string, JobHandler>()` populated via registerHandler().
// ═══════════════════════════════════════════════════════════════════════════

export const JOB_HANDLERS: Record<string, JobHandlerFn> = {
  task_delegation: taskDelegationJob,
  health_check: healthCheckJob,
  report_generation: reportGenerationJob,
  maintenance: maintenanceJob,
  goal_review: goalReviewJob,
  learning_analysis: learningAnalysisJob,
};

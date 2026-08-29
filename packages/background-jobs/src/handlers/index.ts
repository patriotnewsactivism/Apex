// ─── Job Handlers ─────────────────────────────────────────────────────────────
//
// Each handler implements the JobHandler interface and handles one job type.
// Handlers are stateless — they receive the job row and execute against the DB.

import type { ScheduledJob } from '@workspace/db';
import { isRecoverableLLMProviderFailure } from '@workspace/core';

export interface JobHandler {
  execute(job: ScheduledJob, signal?: AbortSignal): Promise<unknown>;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Task states where the task is still live in a queue and will (or may) run. */
const OPEN_STATUSES = ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const;

/** Separate historical provider failures disproved by a later successful task
 * from failures that are still actionable. Kept pure so the exact incident
 * classification can be regression-tested without touching production data. */
export function partitionRecoveredProviderFailures<
  T extends { id: string; errorMessage: string | null; updatedAt: Date },
>(failures: T[], latestSuccessfulTaskAt: Date | null): { actionable: T[]; recovered: T[] } {
  if (!latestSuccessfulTaskAt) return { actionable: failures, recovered: [] };
  const recovered = failures.filter(
    (failure) =>
      isRecoverableLLMProviderFailure(failure.errorMessage) &&
      failure.updatedAt.getTime() < latestSuccessfulTaskAt.getTime(),
  );
  const recoveredIds = new Set(recovered.map((failure) => failure.id));
  return {
    actionable: failures.filter((failure) => !recoveredIds.has(failure.id)),
    recovered,
  };
}

/** BuildMyBot2 operational telemetry, read straight from its Supabase.
 *
 * Best-effort by design and shared by every handler that needs it (daily
 * report, goal review, COO branch review): a missing env var or an unreachable
 * Supabase produces an honest `note`, never a thrown error that would fail the
 * whole job. Extracted here so the three callers cannot drift apart. */
async function fetchBuildMyBot2Telemetry(): Promise<Record<string, unknown>> {
  const url = process.env.BUILDMYBOT_SUPABASE_URL;
  const key = process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return { note: 'BUILDMYBOT_SUPABASE_URL / _SERVICE_KEY not configured' };
  }
  try {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const today = new Date().toISOString().slice(0, 10);
    const [errorsRes, leadsRes, shiftsRes] = await Promise.all([
      fetch(
        `${url}/rest/v1/error_logs?status=eq.open&order=level.asc,created_at.desc&limit=10&select=id,source,level,message`,
        { headers, signal: AbortSignal.timeout(6_000) },
      ),
      fetch(`${url}/rest/v1/leads?replied_at=is.null&select=id,status,follow_up_sent_at&limit=500`, {
        headers,
        signal: AbortSignal.timeout(6_000),
      }),
      fetch(`${url}/rest/v1/ai_team_log?shift_date=eq.${today}&select=role_name,flags,escalated_to&limit=100`, {
        headers,
        signal: AbortSignal.timeout(6_000),
      }),
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
    return {
      openErrors: openErrors.length,
      criticalErrors: openErrors.filter((e) => e.level === 'critical').length,
      worstErrors: openErrors.slice(0, 3),
      leadsAwaitingReply: leadsAwaiting.length,
      leadsNeverFollowedUp: leadsAwaiting.filter((l) => !l.follow_up_sent_at).length,
      shiftsToday: shifts.length,
      flaggedShifts: shifts.filter((s) => s.flags || s.escalated_to).length,
    };
  } catch (err) {
    return { note: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** True when this agent already has an open task whose title starts with
 *  `titlePrefix`. Every autonomous handler below is idempotent on this check —
 *  a cron that fires every few minutes must never stack duplicate review tasks
 *  on an agent that hasn't worked through the last one yet. */
async function hasOpenTaskWithPrefix(agentId: string, titlePrefix: string): Promise<boolean> {
  const { db, tasks } = await import('@workspace/db');
  const { and, eq, inArray, like } = await import('drizzle-orm');
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedAgentId, agentId),
        inArray(tasks.status, [...OPEN_STATUSES]),
        like(tasks.title, `${titlePrefix}%`),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Insert an autonomously-originated task. Kept in one place so every
 *  system-created task carries consistent provenance (`createdByAgentId:
 *  'system-scheduler'` + the originating job in `context`), which is what makes
 *  autonomous work auditable and distinguishable from human-submitted work. */
async function enqueueSystemTask(input: {
  title: string;
  description: string;
  assignedAgentId: string;
  priority: number;
  goalId?: string | null;
  context?: Record<string, unknown>;
}): Promise<string> {
  const { randomUUID } = await import('crypto');
  const { db, tasks } = await import('@workspace/db');
  const taskId = randomUUID();
  const now = new Date();
  await db.insert(tasks).values({
    id: taskId,
    goalId: input.goalId ?? null,
    title: input.title,
    description: input.description,
    status: 'pending',
    priority: input.priority,
    assignedAgentId: input.assignedAgentId,
    createdByAgentId: 'system-scheduler',
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    maxRetries: 3,
    context: input.context ?? null,
  });
  return taskId;
}

// ── TaskDelegationJob: delegates a task to an agent via DB insert ──────────

export class TaskDelegationJob implements JobHandler {
  async execute(job: ScheduledJob): Promise<unknown> {
    const { randomUUID } = await import('crypto');
    const { db, tasks } = await import('@workspace/db');

    const payload = (job.payload ?? {}) as Record<string, string>;
    const targetAgentId = job.targetAgentId;

    if (!targetAgentId) {
      throw new Error('TaskDelegationJob requires targetAgentId');
    }

    const taskId = randomUUID();
    const now = new Date();

    await db.insert(tasks).values({
      id: taskId,
      title: payload.title ?? `Scheduled task: ${job.name}`,
      description: payload.description ?? `Automatically scheduled task from job '${job.name}'`,
      status: 'pending',
      priority: job.priority,
      assignedAgentId: targetAgentId,
      createdByAgentId: 'system-scheduler',
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: 3,
      context: { scheduledJobId: job.id, ...payload },
    });

    return { taskId, assignedTo: targetAgentId };
  }
}

// ── HealthCheckJob: runs HealthMonitor.runAll() + AlertManager.evaluate() ──

export class HealthCheckJob implements JobHandler {
  async execute(_job: ScheduledJob): Promise<unknown> {
    // Dynamic import to avoid circular dependency — the health-monitor
    // package doesn't depend on background-jobs, we import it at runtime.
    const { HealthMonitor, AlertManager } = await import('@workspace/health-monitor');

    const monitor = new HealthMonitor();
    const report = await monitor.runAll();

    const alertManager = new AlertManager();
    const newAlerts = alertManager.evaluate(report);

    return {
      overall: report.overall,
      componentCount: Object.keys(report.checks).length,
      newAlerts: newAlerts.length,
      timestamp: report.timestamp,
    };
  }
}

// ── ReportGenerationJob: generates a daily summary of system activity ──────

export class ReportGenerationJob implements JobHandler {
  async execute(_job: ScheduledJob): Promise<unknown> {
    const { db, tasks, goals, logs } = await import('@workspace/db');
    const { sql, gte } = await import('drizzle-orm');

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Count tasks by status in the last 24h
    const [taskCounts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
        failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')::int`,
      })
      .from(tasks)
      .where(gte(tasks.updatedAt, yesterday));

    // Count goals
    const [goalCounts] = await db
      .select({
        active: sql<number>`count(*) filter (where ${goals.status} = 'active')::int`,
        completed: sql<number>`count(*) filter (where ${goals.status} = 'completed')::int`,
      })
      .from(goals);

    // Count errors
    const [errorCounts] = await db
      .select({
        total: sql<number>`count(*) filter (where ${logs.level} = 'error')::int`,
      })
      .from(logs)
      .where(gte(logs.timestamp, yesterday));

    // ── Portfolio legs: BuildMyBot2 AI Team shift outcomes + ARIA dispatch
    // volume, so the daily summary is ONE view of the whole business instead
    // of three dashboards. Both are best-effort: a missing env or an
    // unreachable Supabase yields an honest note, never a crashed report.
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

    // ARIA dispatches work into the swarm as goals (POST /api/goals via the
    // control room), so 24h goal-creation volume is the dispatch volume.
    const [ariaDispatch] = await db
      .select({
        goalsDispatched24h: sql<number>`count(*)::int`,
      })
      .from(goals)
      .where(gte(goals.createdAt, yesterday));

    const report = {
      period: '24h',
      generatedAt: new Date().toISOString(),
      tasks: taskCounts,
      goals: goalCounts,
      errors: errorCounts,
      buildMyBotAITeam,
      ariaDispatch,
    };

    // Store the report as a memory for the CEO to reference
    const { randomUUID } = await import('crypto');
    const { memories } = await import('@workspace/db');

    await db.insert(memories).values({
      id: randomUUID(),
      agentId: 'apex-ceo-001',
      scope: 'global',
      key: `daily-report:${new Date().toISOString().slice(0, 10)}`,
      value: JSON.stringify(report),
      importance: 0.7,
      tags: ['daily-report', 'automated'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return report;
  }
}

// ── MaintenanceJob: cleans old logs, expired memories, stale data ──────────

export class MaintenanceJob implements JobHandler {
  async execute(_job: ScheduledJob): Promise<unknown> {
    const { db, logs, memories, jobExecutionLog } = await import('@workspace/db');
    const { lt, and, isNotNull, lte } = await import('drizzle-orm');
    const { sql } = await import('drizzle-orm');

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 1. Clean old debug/info logs (keep 7 days)
    const logResult = await db.delete(logs).where(
      and(
        lt(logs.timestamp, sevenDaysAgo),
        sql`${logs.level} IN ('debug', 'info')`,
      ),
    );

    // 2. Clean expired memories
    const memResult = await db.delete(memories).where(
      and(
        isNotNull(memories.expiresAt),
        lte(memories.expiresAt, now),
      ),
    );

    // 3. Clean old job execution logs (keep 30 days)
    const jobLogResult = await db.delete(jobExecutionLog).where(
      lt(jobExecutionLog.startedAt, thirtyDaysAgo),
    );

    return {
      cleanedAt: now.toISOString(),
      logsRemoved: logResult.count ?? 0,
      expiredMemoriesRemoved: memResult.count ?? 0,
      oldJobLogsRemoved: jobLogResult.count ?? 0,
    };
  }
}

// ── GoalReviewJob: the autonomous "spark" that makes APEX self-directing ────
//
// Before this handler existed, agent activity was purely reactive — the CEO
// only reasoned when a human hit POST /api/goals, and the JobScheduler polled
// an empty scheduled_jobs table forever on a fresh DB. This job runs on a
// cron schedule, snapshots REAL system state (active goals, task backlog,
// component health, recent learning insights), and enqueues a task for the CEO
// to reason about it and originate/delegate the highest-value next work — or
// consciously decide nothing needs doing. No human endpoint call required.
//
// Charter-safe: the CEO's own tools are read/research/delegation; any
// downstream irreversible action (deploy, external send, schema, financial)
// still hits its per-tool human-approval gate. The prompt explicitly instructs
// restraint so the loop does not generate busywork or unbounded token spend.

export class GoalReviewJob implements JobHandler {
  async execute(job: ScheduledJob): Promise<unknown> {
    const { randomUUID } = await import('crypto');
    const { db, tasks, goals, componentHealth, learningInsights, scheduledJobs } = await import('@workspace/db');
    const { eq, desc, sql } = await import('drizzle-orm');

    const targetAgentId = job.targetAgentId ?? 'apex-ceo-001';

    // Snapshot real state so the CEO reasons from facts, not a vacuum.
    const activeGoals = await db
      .select({ id: goals.id, title: goals.title, priority: goals.priority })
      .from(goals)
      .where(eq(goals.status, 'active'))
      .orderBy(goals.priority)
      .limit(5);

    const [backlog] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(sql`${tasks.status} IN ('pending', 'in_progress')`);

    const unhealthy = await db
      .select({
        component: componentHealth.component,
        status: componentHealth.status,
        detail: componentHealth.detail,
      })
      .from(componentHealth)
      .where(sql`${componentHealth.status} IN ('degraded', 'critical')`);

    const recentInsights = await db
      .select({ title: learningInsights.title, insightType: learningInsights.insightType })
      .from(learningInsights)
      .orderBy(desc(learningInsights.createdAt))
      .limit(5);

    // Current cron schedule — the CEO owns scheduling/HR and must see the
    // standing shift roster to decide whether cadence matches priorities.
    const cronSchedule = await db
      .select({
        id: scheduledJobs.id,
        name: scheduledJobs.name,
        jobType: scheduledJobs.jobType,
        cronExpression: scheduledJobs.cronExpression,
        status: scheduledJobs.status,
        enabled: scheduledJobs.enabled,
        targetAgentId: scheduledJobs.targetAgentId,
        nextRunAt: scheduledJobs.nextRunAt,
      })
      .from(scheduledJobs)
      .orderBy(desc(scheduledJobs.createdAt))
      .limit(20);

    // BuildMyBot2 telemetry — the portfolio leg, so the autonomous review
    // operates on the revenue flagship too, not just Apex's own queue.
    const buildmybot2 = await fetchBuildMyBot2Telemetry();

    const snapshot = {
      activeGoals,
      openTaskBacklog: backlog?.count ?? 0,
      unhealthyComponents: unhealthy,
      recentInsights,
      cronSchedule,
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
      '5. WORK SCHEDULE (you own scheduling/HR): review snapshot.cronSchedule. If the lead-gen cadence is too slow for the #1 priority, create a more frequent sweep or a second sweep targeting a different industry with schedule_task. If a recurring function is missing (outreach follow-ups, content cadence), create it. If a cron is stale or redundant, cancel it with cancel_scheduled_task. The baseline crons are a starting roster — adjust them as priorities shift.',
      '6. GOAL HYGIENE (you own the goal list): call list_goals to see real per-goal progress, not just titles. A goal showing "work_finished_awaiting_closeout" must be verified with get_delegation_status and then CLOSED with update_goal_status — goals do not close themselves, and every goal left open makes the next review reason over stale state. A goal showing "no_work_created" is one you accepted and never decomposed: decompose it now. A goal showing "stalled_all_failed" means your approach does not work — change it or escalate_to_human.',
      '7. RESTRAINT: do NOT create busywork. If the system is healthy and nothing needs doing, record a one-line note to memory and create no tasks.',
      'Irreversible actions (deploys, external sends, schema changes, financial) still require human approval — propose and queue them, do not execute.',
    ].join('\n');

    // Idempotency: if the CEO still has an unworked review sitting in its
    // queue, do not stack another one on top. A 15-minute cron that blindly
    // inserts would build a backlog of stale snapshots the moment the CEO is
    // busy or the LLM chain is briefly exhausted — each one re-reasoned later
    // against state that has since moved on.
    if (await hasOpenTaskWithPrefix(targetAgentId, 'Autonomous goal review')) {
      return {
        skipped: true,
        reason: 'CEO already has an unworked autonomous goal review queued',
        assignedTo: targetAgentId,
      };
    }

    const taskId = randomUUID();
    const now = new Date();
    await db.insert(tasks).values({
      id: taskId,
      title: `Autonomous goal review — ${now.toISOString()}`,
      description,
      status: 'pending',
      priority: job.priority,
      assignedAgentId: targetAgentId,
      createdByAgentId: 'system-scheduler',
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: 3,
      context: { scheduledJobId: job.id, snapshot },
    });

    return {
      taskId,
      assignedTo: targetAgentId,
      activeGoals: activeGoals.length,
      unhealthyComponents: unhealthy.length,
      openTaskBacklog: backlog?.count ?? 0,
    };
  }
}

// ── LearningAnalysisJob: autonomous pattern detection + insight generation ──
//
// Mirrors POST /api/learning/analyze but runs on a schedule, so learning is
// not dependent on a human hitting the endpoint. Detected insights feed back
// into agent prompts (BaseAgent.buildLearningContext), and human-approved
// strategy recommendations that get applied become standing instructions —
// closing the learning loop from "measure and report" to "measure and adapt".

export class LearningAnalysisJob implements JobHandler {
  async execute(_job: ScheduledJob): Promise<unknown> {
    const { PatternDetector, InsightGenerator, StrategyOptimizer } = await import(
      '@workspace/learning-system'
    );

    const detector = new PatternDetector(5); // documented >=5 sample threshold
    const patterns = await detector.detectPatterns(30);

    const insightGen = new InsightGenerator();
    const insightsCreated = await insightGen.generateInsights(patterns);

    const optimizer = new StrategyOptimizer();
    const recommendationsCreated = await optimizer.generateRecommendations(patterns);

    return {
      patternsDetected: patterns.length,
      insightsCreated,
      recommendationsCreated,
      analyzedAt: new Date().toISOString(),
    };
  }
}

// ── PromptSelfImproveJob: closes the loop on Apex improving its own prompts ─
//
// Runs Prompt Forge against one persisted agent role per invocation (or rotates
// roles when payload.role='auto'). It evolves the actual incumbent prompt,
// preserves immutable security/permission/evidence/approval clauses, compares
// incumbent and candidate, and stores the winning prompt plus test evidence as
// a ranked opportunity. This NEVER silently edits live agent behavior.
export class PromptSelfImproveJob implements JobHandler {
  static readonly IMPROVEMENT_THRESHOLD = 0.25; // out of a 10-point total_score scale

  async execute(job: ScheduledJob): Promise<unknown> {
    const payload = (job.payload as Record<string, unknown>) ?? {};
    const requestedRole = String(payload.role ?? '').trim();
    if (!requestedRole) {
      return { skipped: true, reason: "job.payload.role is required (e.g. 'MARKETING', 'QA_DIRECTOR')" };
    }
    const personaHint = typeof payload.personaHint === 'string' ? payload.personaHint : undefined;

    const { optimizePrompt, evaluateCandidate, opportunityFingerprint } = await import('@workspace/core');
    const { db, agents, opportunities, performanceBaselines } = await import('@workspace/db');
    const { eq, sql } = await import('drizzle-orm');

    const agentRows = await db.select().from(agents).orderBy(agents.role);
    if (!agentRows.length) return { skipped: true, reason: 'No persisted agents are available to evolve' };
    const selectedAgent = requestedRole.toLowerCase() === 'auto'
      ? agentRows[Math.floor(Date.now() / (6 * 60 * 60 * 1000)) % agentRows.length]
      : agentRows.find((agent) => agent.role.toLowerCase() === requestedRole.toLowerCase());
    if (!selectedAgent) return { skipped: true, reason: `No agent found for role ${requestedRole}` };
    const role = selectedAgent.role;

    const immutableRules = [
      'Never expose secrets, credentials, or private user data.',
      'Never weaken or bypass security, permission, autonomy, or per-action approval boundaries.',
      'Never claim work, tests, deployments, outreach, or outcomes happened without evidence.',
      'External sends, spending, deployments, schema changes, destructive actions, and other irreversible operations retain their existing approval gates.',
    ];

    const goalDescription =
      typeof payload.goalDescription === 'string'
        ? payload.goalDescription
        : `Improve the ${role} agent's system prompt for higher clarity and task-success, while ` +
          `preserving every existing hard rule and domain-specific requirement — this is a refinement, not a rewrite.`;

    const incumbentEvaluation = await evaluateCandidate(
      goalDescription,
      selectedAgent.systemPrompt,
      personaHint,
      role,
    );
    const result = await optimizePrompt({
      goalDescription,
      targetPersona: personaHint,
      maxIterations: Number(payload.maxIterations ?? 4),
      role,
      incumbentPrompt: selectedAgent.systemPrompt,
      immutableRules,
    });

    const metricName = `prompt_forge:${role}`;
    const [baseline] = await db
      .select()
      .from(performanceBaselines)
      .where(eq(performanceBaselines.metricName, metricName))
      .limit(1);

    if (result.status !== 'converged' || !result.bestCandidate) {
      return {
        role,
        status: result.status,
        iterationsRun: result.iterationsRun,
        note: 'No usable candidate produced this run — no baseline change, no task created.',
      };
    }

    const newScore = result.bestCandidate.totalScore;
    const previousBaseline = incumbentEvaluation?.totalScore ?? baseline?.baselineValue ?? null;
    const isFirstRun = baseline === undefined;
    const delta = previousBaseline === null ? null : newScore - previousBaseline;

    // Always record the latest attempt as the new comparison point — whether
    // or not it beat the last one — so a plateaued prompt doesn't re-alert
    // every run once a human has already seen and decided on that ceiling.
    await db
      .insert(performanceBaselines)
      .values({
        metricName,
        baselineValue: newScore,
        measurementWindow: 'prompt_forge',
        sampleSize: (baseline?.sampleSize ?? 0) + 1,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: performanceBaselines.metricName,
        set: {
          baselineValue: newScore,
          sampleSize: (baseline?.sampleSize ?? 0) + 1,
          updatedAt: new Date(),
        },
      });

    const meaningfulImprovement = delta !== null && delta >= PromptSelfImproveJob.IMPROVEMENT_THRESHOLD;

    if (meaningfulImprovement) {
      const title = `Evolve the ${role} agent prompt (+${delta.toFixed(2)} evaluated quality)`;
      const now = new Date();
      await db.insert(opportunities).values({
        id: crypto.randomUUID(),
        projectId: null,
        fingerprint: opportunityFingerprint(null, `prompt-evolution-${selectedAgent.id}`),
        source: 'prompt_forge',
        category: 'prompt_improvement',
        title,
        description: `A candidate evolved from the actual ${role} prompt scored ${newScore.toFixed(2)}/10 versus ${previousBaseline?.toFixed(2)}/10 for the incumbent. It preserves immutable security, evidence, permission, and approval clauses.`,
        rationale: 'Better role prompts compound across every future task while controlled candidate promotion prevents silent regressions.',
        evidence: {
          incumbentScore: previousBaseline,
          candidateScore: newScore,
          delta,
          scoreTrajectory: result.scoreTrajectory,
          selfCritique: result.bestCandidate.selfCritique,
          testOutput: result.bestCandidate.testOutput,
          immutableRulesPreserved: true,
        },
        proposedPlan: {
          targetAgentId: selectedAgent.id,
          targetRole: role,
          incumbentPrompt: selectedAgent.systemPrompt,
          candidatePrompt: result.bestCandidate.promptText,
          validation: ['Run representative role tasks against incumbent and candidate', 'Promote only after a minimum sample and no safety regression'],
          immutableRules,
        },
        impact: 'high',
        difficulty: 'medium',
        confidence: Math.min(1, 0.65 + Math.max(0, delta) / 10),
        novelty: 0.8,
        valueScore: Math.min(100, Math.round(72 + delta * 4)),
        status: 'proposed',
        goalTitle: `Validate and promote the improved ${role} prompt`,
        goalDescription: `Test the stored candidate prompt against the incumbent using representative ${role} work. Preserve all immutable rules. Promote only if measured outcomes materially improve without security, permission, approval, truthfulness, cost, or reliability regressions.`,
        goalPriority: 4,
        generatedByAgentId: 'prompt-forge',
        generationId: job.id,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: opportunities.fingerprint,
        set: {
          title,
          description: `A new candidate evolved from the actual ${role} prompt scored ${newScore.toFixed(2)}/10 versus ${previousBaseline?.toFixed(2)}/10 for the incumbent.`,
          evidence: {
            incumbentScore: previousBaseline,
            candidateScore: newScore,
            delta,
            scoreTrajectory: result.scoreTrajectory,
            selfCritique: result.bestCandidate.selfCritique,
            testOutput: result.bestCandidate.testOutput,
            immutableRulesPreserved: true,
          },
          proposedPlan: {
            targetAgentId: selectedAgent.id,
            targetRole: role,
            incumbentPrompt: selectedAgent.systemPrompt,
            candidatePrompt: result.bestCandidate.promptText,
            immutableRules,
          },
          valueScore: Math.min(100, Math.round(72 + delta * 4)),
          occurrences: sql`${opportunities.occurrences} + 1`,
          lastSeenAt: now,
          updatedAt: now,
        },
      });
    }

    return {
      role,
      isFirstRun,
      newScore,
      previousBaseline,
      delta,
      meaningfulImprovement,
      iterationsRun: result.iterationsRun,
      scoreTrajectory: result.scoreTrajectory,
      opportunityCreated: meaningfulImprovement,
    };
  }
}

// ── DelegationFollowupJob: closes the delegation loop ──────────────────────
//
// THE structural gap this fixes: `BaseAgent.delegate()` wrote a child task row
// and the delegating agent's own task finished immediately. Nothing in the
// running system ever read `tasks.parent_task_id` back — so a manager could
// delegate five initiatives, report "delegated successfully", and never learn
// that four of them failed. Delegation was a one-way broadcast, which is why
// the org chart produced activity but very little compounding work.
//
// This handler is the return path. It finds delegated tasks that have reached a
// terminal state, waits until EVERY sibling under the same parent is finished
// (so the delegator reasons about a complete picture, not a dribble), then
// hands the delegator one synthesis task carrying the real outcomes: what
// succeeded, what failed, and the actual error text.
//
// Termination: the synthesis task is created as a ROOT task (no parentTaskId),
// so it can never trigger a follow-up for itself. If the delegator responds by
// delegating again, those new children legitimately produce the next round —
// that is the intended loop, and it converges because each round only fires
// once all its work is finished. Children are marked `reportedToParent` in
// their own `context` (a jsonb merge, not a schema change) so a report is
// generated exactly once.

export class DelegationFollowupJob implements JobHandler {
  async execute(job: ScheduledJob): Promise<unknown> {
    const { db, tasks } = await import('@workspace/db');
    const { and, eq, gte, inArray, isNotNull, sql } = await import('drizzle-orm');

    const maxSyntheses = Number((job.payload as Record<string, unknown>)?.maxPerRun ?? 8);
    // Bound the sweep to recent work: on a long-lived database the first run
    // must not try to retro-report months of historical delegations.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const finishedChildren = await db
      .select({
        id: tasks.id,
        parentTaskId: tasks.parentTaskId,
        title: tasks.title,
        status: tasks.status,
        result: tasks.result,
        errorMessage: tasks.errorMessage,
        assignedAgentId: tasks.assignedAgentId,
        goalId: tasks.goalId,
      })
      .from(tasks)
      .where(
        and(
          isNotNull(tasks.parentTaskId),
          inArray(tasks.status, ['done', 'failed', 'cancelled']),
          gte(tasks.updatedAt, since),
          sql`coalesce((${tasks.context}->>'reportedToParent')::boolean, false) = false`,
        ),
      )
      .limit(300);

    if (finishedChildren.length === 0) {
      return { unreportedChildren: 0, synthesesCreated: 0 };
    }

    // Group by parent so one report covers a whole delegated batch.
    const byParent = new Map<string, typeof finishedChildren>();
    for (const child of finishedChildren) {
      if (!child.parentTaskId) continue;
      const group = byParent.get(child.parentTaskId) ?? [];
      group.push(child);
      byParent.set(child.parentTaskId, group);
    }

    let synthesesCreated = 0;
    let deferred = 0;
    const created: Array<{ parentTaskId: string; taskId: string; delegator: string }> = [];

    for (const [parentTaskId, children] of byParent) {
      if (synthesesCreated >= maxSyntheses) break;

      // Wait for the whole batch. Reporting on 2 of 5 finished children would
      // make the delegator draw a conclusion from a partial picture.
      const [stillOpen] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.parentTaskId, parentTaskId), inArray(tasks.status, [...OPEN_STATUSES])));
      if ((stillOpen?.count ?? 0) > 0) {
        deferred++;
        continue;
      }

      const [parent] = await db.select().from(tasks).where(eq(tasks.id, parentTaskId)).limit(1);
      const delegator = parent?.assignedAgentId;

      // Orphaned children (parent deleted, or a parent with no owner) can never
      // be reported to anyone — mark them so they don't get re-scanned forever.
      if (!parent || !delegator) {
        await db
          .update(tasks)
          .set({
            context: sql`coalesce(${tasks.context}, '{}'::jsonb) || '{"reportedToParent":true,"reportSkipped":"no-parent-or-delegator"}'::jsonb`,
          })
          .where(
            inArray(
              tasks.id,
              children.map((c) => c.id),
            ),
          );
        continue;
      }

      const succeeded = children.filter((c) => c.status === 'done');
      const failed = children.filter((c) => c.status !== 'done');

      const description = [
        `DELEGATION RESULTS — the work you handed down from "${parent.title}" has finished.`,
        'This is the return leg of your own delegation. Nobody asked for this; the system routes',
        'completed sub-work back to whoever delegated it so outcomes are verified, not assumed.',
        '',
        `## Outcome summary: ${succeeded.length} succeeded, ${failed.length} failed/cancelled`,
        '',
        ...children.map((c) =>
          [
            `### [${c.status.toUpperCase()}] ${c.title}`,
            `- taskId: ${c.id}`,
            `- handled by: ${c.assignedAgentId ?? 'unassigned'}`,
            c.status === 'done'
              ? `- result: ${(c.result ?? '(no result recorded)').slice(0, 900)}`
              : `- error: ${(c.errorMessage ?? '(no error recorded)').slice(0, 500)}`,
          ].join('\n'),
        ),
        '',
        '## What to do now',
        '1. JUDGE THE WORK, do not just acknowledge it. Does each result actually satisfy what you asked for?',
        '   A subordinate reporting "no results found" or returning a plan instead of a deliverable has NOT',
        '   done the work — re-delegate with sharper, more specific instructions.',
        '2. For anything that failed: read the error. Decide — re-delegate with a corrected approach, handle',
        '   it yourself, or escalate_to_human if it is blocked on something outside the system (a missing',
        '   credential, a spend decision, a legal question). Do not silently drop a failure.',
        '3. Use get_task_details for the full text of any result or error truncated above.',
        '4. If this batch completes an initiative and no other work remains for its goal, verify with',
        '   get_delegation_status and then close the goal with update_goal_status. Goals do not close',
        '   themselves.',
        '5. Report honestly: what actually shipped, what did not, and what you are doing about the gap.',
        '   Never report a delegated initiative as delivered when its children failed.',
      ].join('\n');

      const taskId = await enqueueSystemTask({
        title: `Delegation results: ${parent.title}`.slice(0, 200),
        description,
        assignedAgentId: delegator,
        priority: Math.max(1, (parent.priority ?? 5) - 1), // slightly ahead of the work that spawned it
        goalId: parent.goalId,
        context: {
          scheduledJobId: job.id,
          synthesisForParentTaskId: parentTaskId,
          childTaskIds: children.map((c) => c.id),
          succeeded: succeeded.length,
          failed: failed.length,
        },
      });

      // Mark the batch reported — jsonb merge preserves whatever else the
      // child's context carried (messageId, swarm metadata, snapshots).
      await db
        .update(tasks)
        .set({
          context: sql`coalesce(${tasks.context}, '{}'::jsonb) || '{"reportedToParent":true}'::jsonb`,
        })
        .where(
          inArray(
            tasks.id,
            children.map((c) => c.id),
          ),
        );

      synthesesCreated++;
      created.push({ parentTaskId, taskId, delegator });
    }

    return {
      unreportedChildren: finishedChildren.length,
      parentBatches: byParent.size,
      synthesesCreated,
      deferredBatchesStillRunning: deferred,
      created,
    };
  }
}

// ── GoalProgressJob: drives goals to a real conclusion ─────────────────────
//
// Goals were created 'active' and only a human hitting PATCH /api/goals/:id
// ever changed that. So the active-goal list only grew: the CEO's periodic
// review re-read the same finished-but-open goals every cycle, `delegate()`'s
// idempotency guard turned the re-delegation into a no-op, and the autonomous
// loop quietly degraded to doing nothing while still looking busy.
//
// This handler inspects each active goal's REAL task rollup and enqueues a
// pointed task only when a goal is in a state that needs a decision — finished
// and awaiting close-out, accepted but never decomposed, or fully stalled. A
// goal with work legitimately in flight is left alone.

export class GoalProgressJob implements JobHandler {
  async execute(job: ScheduledJob): Promise<unknown> {
    const { db, tasks, goals } = await import('@workspace/db');
    const { eq, inArray, sql } = await import('drizzle-orm');

    const maxPerRun = Number((job.payload as Record<string, unknown>)?.maxPerRun ?? 4);
    const defaultOwner = job.targetAgentId ?? 'apex-ceo-001';
    // A goal submitted seconds ago has legitimately not been decomposed yet.
    // Default 60 minutes gives the CEO goal-review loop (every 15 min) several
    // cycles to decompose before flagging the goal as idle.
    const minAgeMs = Number((job.payload as Record<string, unknown>)?.minAgeMinutes ?? 60) * 60_000;

    const activeGoals = await db
      .select()
      .from(goals)
      .where(eq(goals.status, 'active'))
      .orderBy(goals.priority)
      .limit(50);

    if (activeGoals.length === 0) {
      return { activeGoals: 0, actionsCreated: 0 };
    }

    const rollups = await db
      .select({ goalId: tasks.goalId, status: tasks.status, count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        inArray(
          tasks.goalId,
          activeGoals.map((g) => g.id),
        ),
      )
      .groupBy(tasks.goalId, tasks.status);

    const byGoal = new Map<string, Record<string, number>>();
    for (const r of rollups) {
      if (!r.goalId) continue;
      const bucket = byGoal.get(r.goalId) ?? {};
      bucket[r.status] = r.count;
      byGoal.set(r.goalId, bucket);
    }

    let actionsCreated = 0;
    const actions: Array<{ goalId: string; state: string; taskId: string }> = [];
    const states: Record<string, string> = {};

    for (const goal of activeGoals) {
      const bucket = byGoal.get(goal.id) ?? {};
      const open = OPEN_STATUSES.reduce((n, s) => n + (bucket[s] ?? 0), 0);
      const done = bucket.done ?? 0;
      const failed = bucket.failed ?? 0;
      const total = Object.values(bucket).reduce((n, c) => n + c, 0);
      const ageMs = goal.createdAt ? Date.now() - goal.createdAt.getTime() : 0;

      const state =
        open > 0
          ? 'in_progress'
          : total === 0
            ? 'no_work_created'
            : failed > 0 && done === 0
              ? 'stalled_all_failed'
              : failed > 0
                ? 'finished_with_failures'
                : 'finished_awaiting_closeout';
      states[goal.id] = state;

      // Work still running, or too new to judge — leave it alone.
      if (state === 'in_progress') continue;
      if (state === 'no_work_created' && ageMs < minAgeMs) continue;
      if (actionsCreated >= maxPerRun) continue;

      const owner = goal.assignedAgentId ?? defaultOwner;
      const titlePrefix = `Goal review: ${goal.title}`.slice(0, 120);
      if (await hasOpenTaskWithPrefix(owner, titlePrefix)) continue;

      const instructions =
        state === 'no_work_created'
          ? [
              `This goal has been active for ~${Math.round(ageMs / 60_000)} minutes and NO tasks exist for it.`,
              'You accepted it and never decomposed it. Do that now:',
              '1. Break it into 2-5 concrete initiatives with explicit acceptance criteria.',
              '2. Delegate each one via sendMessage to the right agent (or dispatchSwarm for work that',
              '   benefits from several independent angles).',
              '3. If this goal is no longer worth pursuing, say so and close it with',
              '   update_goal_status(cancelled) plus an honest reason — do not leave it sitting open.',
            ]
          : state === 'stalled_all_failed'
            ? [
                `Every task created for this goal FAILED (${failed} failed, 0 succeeded).`,
                'The current approach does not work. Do not simply retry it:',
                '1. Call get_delegation_status with this goalId and read the actual errors.',
                '2. Diagnose the real blocker — wrong agent, missing tool/credential, impossible scope,',
                '   or instructions too vague to act on.',
                '3. Then either re-plan with a genuinely different approach, or escalate_to_human with your',
                '   diagnosis and recommendation if it is blocked on something outside the system.',
                '4. If the goal is not achievable with what Apex has today, close it honestly with',
                '   update_goal_status(cancelled) and state what would unblock it.',
              ]
            : [
                `All work for this goal has finished (${done} done, ${failed} failed) and nothing is still running.`,
                'Close it out properly:',
                '1. Call get_delegation_status with this goalId and READ the results — do not assume the',
                '   work was good just because the tasks are marked done.',
                '2. If the results genuinely satisfy the goal, call update_goal_status(completed) with a',
                '   `result` summarizing what was actually delivered, including anything that fell short.',
                '3. If they do NOT satisfy it, the goal is not done: delegate the remaining work now and',
                '   leave the goal active.',
                failed > 0
                  ? '4. Some tasks failed. Account for them explicitly — either the failure was immaterial (say why) or the goal is incomplete.'
                  : '4. Be honest in the result: partial delivery is reported as partial, never as complete.',
              ];

      const description = [
        'AUTONOMOUS GOAL REVIEW — no human requested this. A goal reached a state that needs your decision.',
        '',
        `## Goal: ${goal.title}`,
        `- goalId: ${goal.id}`,
        `- priority: ${goal.priority}`,
        `- state: ${state}`,
        `- task rollup: ${total} total / ${open} open / ${done} done / ${failed} failed`,
        '',
        '## Description',
        goal.description,
        '',
        '## What to do',
        ...instructions,
        '',
        'Irreversible actions (deploys, external sends, schema changes, financial) remain human-approved.',
      ].join('\n');

      const taskId = await enqueueSystemTask({
        title: titlePrefix,
        description,
        assignedAgentId: owner,
        priority: Math.max(1, goal.priority - 1),
        goalId: goal.id,
        context: { scheduledJobId: job.id, goalState: state, rollup: { total, open, done, failed } },
      });

      actionsCreated++;
      actions.push({ goalId: goal.id, state, taskId });
    }

    return { activeGoals: activeGoals.length, actionsCreated, actions, states };
  }
}

// ── FailureReviewJob: makes failures something the business learns from ────
//
// A task that exhausted its retries went to 'failed' and stopped there. No
// agent ever saw it, nothing aggregated it, and the same root cause could fail
// dozens of tasks a day indefinitely. The learning system measured outcomes but
// only produced insights at a >=5-sample statistical threshold — it did not put
// a specific, actionable failure in front of a decision-maker.
//
// This handler clusters recent failures by owning agent + normalized error
// signature and hands the top clusters to the CEO for triage. Clustering (not
// one task per failure) is what keeps this from becoming its own noise source.

export class FailureReviewJob implements JobHandler {
  /** Collapse a raw error string into a comparable signature: strip UUIDs,
   *  numbers, quoted fragments and timestamps so "task abc-123 failed" and
   *  "task def-456 failed" cluster together instead of looking distinct. */
  private signature(error: string): string {
    return error
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
      .replace(/\d+/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  async execute(job: ScheduledJob): Promise<unknown> {
    const { db, tasks } = await import('@workspace/db');
    const { and, eq, gte } = await import('drizzle-orm');

    const windowHours = Number((job.payload as Record<string, unknown>)?.windowHours ?? 24);
    const minCluster = Number((job.payload as Record<string, unknown>)?.minClusterSize ?? 2);
    const reviewer = job.targetAgentId ?? 'apex-ceo-001';
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const failures = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        assignedAgentId: tasks.assignedAgentId,
        errorMessage: tasks.errorMessage,
        retryCount: tasks.retryCount,
      })
      .from(tasks)
      .where(and(eq(tasks.status, 'failed'), gte(tasks.updatedAt, since)))
      .limit(500);

    if (failures.length === 0) {
      return { windowHours, failures: 0, clusters: 0, taskCreated: false };
    }

    const clusters = new Map<
      string,
      { agentId: string; signature: string; count: number; sampleTaskIds: string[]; sampleTitles: string[] }
    >();
    for (const f of failures) {
      const agentId = f.assignedAgentId ?? 'unassigned';
      const sig = this.signature(f.errorMessage ?? 'unknown error');
      const key = `${agentId}::${sig}`;
      const entry = clusters.get(key) ?? { agentId, signature: sig, count: 0, sampleTaskIds: [], sampleTitles: [] };
      entry.count++;
      if (entry.sampleTaskIds.length < 3) {
        entry.sampleTaskIds.push(f.id);
        entry.sampleTitles.push(f.title);
      }
      clusters.set(key, entry);
    }

    const ranked = [...clusters.values()].sort((a, b) => b.count - a.count);
    const significant = ranked.filter((c) => c.count >= minCluster).slice(0, 8);

    // One-off failures are normal operating noise; only recurring patterns are
    // worth a decision-maker's attention.
    if (significant.length === 0) {
      return {
        windowHours,
        failures: failures.length,
        clusters: ranked.length,
        taskCreated: false,
        reason: `No cluster reached the minimum size of ${minCluster} — treated as isolated noise, not a pattern.`,
      };
    }

    if (await hasOpenTaskWithPrefix(reviewer, 'Failure triage')) {
      return { windowHours, failures: failures.length, clusters: ranked.length, taskCreated: false, reason: 'triage already queued' };
    }

    const description = [
      `AUTONOMOUS FAILURE TRIAGE — ${failures.length} task(s) failed in the last ${windowHours}h.`,
      'No human reported this; the system surfaces recurring failures so they get fixed rather than repeated.',
      '',
      '## Failure clusters (grouped by owning agent + error signature)',
      ...significant.map(
        (c, i) =>
          [
            `${i + 1}. ${c.count}× — agent \`${c.agentId}\``,
            `   signature: ${c.signature}`,
            `   example tasks: ${c.sampleTaskIds.join(', ')}`,
            `   example titles: ${c.sampleTitles.join(' | ')}`,
          ].join('\n'),
      ),
      '',
      '## What to do',
      '1. Call get_task_details on one example per cluster to read the real error, not just the signature.',
      '2. Classify each cluster honestly:',
      '   - CAPACITY (LLM providers exhausted, rate limits) → not a code bug. Note it; consider whether the',
      '     cron cadence you own is simply too aggressive and adjust it with schedule_task/cancel_scheduled_task.',
      '   - MISSING CAPABILITY (absent credential, tool not wired, e.g. GITHUB_TOKEN) → escalate_to_human with',
      '     exactly what is needed. Do NOT keep retrying work that cannot succeed without it.',
      '   - REAL DEFECT (code/logic error in Apex itself) → delegate the fix to the CTO (apex-cto-001) with the',
      '     error text and example task IDs attached.',
      '   - BAD INSTRUCTIONS (the task was too vague for the agent to act on) → that is your own delegation',
      '     quality. Re-delegate with concrete acceptance criteria.',
      '3. Do not re-run failed work whose blocker you have not actually removed — that is how a failure loop',
      '   burns the whole LLM budget.',
    ].join('\n');

    const taskId = await enqueueSystemTask({
      title: `Failure triage — ${failures.length} failures / ${significant.length} clusters (${windowHours}h)`,
      description,
      assignedAgentId: reviewer,
      priority: job.priority,
      context: { scheduledJobId: job.id, clusters: significant },
    });

    return {
      windowHours,
      failures: failures.length,
      clusters: ranked.length,
      significantClusters: significant.length,
      taskCreated: true,
      taskId,
    };
  }
}

// ── BranchReviewJob: self-direction below the CEO ──────────────────────────
//
// Only the CEO had an autonomous heartbeat. The COO and CTO — the two agents
// that actually own day-to-day operations and engineering — did nothing unless
// the CEO happened to message them, so whole branches of the org chart sat idle
// between goal reviews. A business does not run on one person checking in every
// 15 minutes.
//
// This is the generic branch heartbeat: it snapshots the branch's own state
// (its open work, its subordinates' open and recently failed tasks) plus, for
// the COO, live BuildMyBot2 telemetry, and hands its manager a review task with
// a role-specific focus supplied by the job payload.

export class BranchReviewJob implements JobHandler {
  async execute(job: ScheduledJob): Promise<unknown> {
    const { db, tasks } = await import('@workspace/db');
    const { and, desc, eq, gte, inArray, sql } = await import('drizzle-orm');

    const targetAgentId = job.targetAgentId;
    if (!targetAgentId) {
      throw new Error('BranchReviewJob requires targetAgentId (the manager whose branch is reviewed)');
    }

    const payload = (job.payload ?? {}) as {
      focus?: string;
      subordinates?: string[];
      includeBuildMyBot2?: boolean;
    };
    const subordinates = payload.subordinates ?? [];
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    if (await hasOpenTaskWithPrefix(targetAgentId, 'Autonomous branch review')) {
      return { skipped: true, reason: 'manager already has an unworked branch review queued', targetAgentId };
    }

    const ownOpen = await db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, priority: tasks.priority })
      .from(tasks)
      .where(and(eq(tasks.assignedAgentId, targetAgentId), inArray(tasks.status, [...OPEN_STATUSES])))
      .orderBy(tasks.priority)
      .limit(15);

    const branchIds = [targetAgentId, ...subordinates];

    const branchOpen = await db
      .select({ agentId: tasks.assignedAgentId, status: tasks.status, count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(inArray(tasks.assignedAgentId, branchIds), inArray(tasks.status, [...OPEN_STATUSES])))
      .groupBy(tasks.assignedAgentId, tasks.status);

    const branchFailures = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        assignedAgentId: tasks.assignedAgentId,
        errorMessage: tasks.errorMessage,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(and(inArray(tasks.assignedAgentId, branchIds), eq(tasks.status, 'failed'), gte(tasks.updatedAt, since)))
      .orderBy(desc(tasks.updatedAt));

    const branchCompleted = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        assignedAgentId: tasks.assignedAgentId,
        result: tasks.result,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(and(inArray(tasks.assignedAgentId, branchIds), eq(tasks.status, 'done'), gte(tasks.updatedAt, since)))
      .orderBy(desc(tasks.updatedAt))
      .limit(10);

    // A later successful agent task proves that the process-wide provider
    // chain recovered. Without this partition, every branch review continued
    // treating pre-deploy 402/404/no-key failures as an active outage for 24h,
    // generating false credit requests, duplicate work, and human escalations
    // even while agents were completing tool-using tasks successfully.
    const [latestSuccessfulTask] = await db
      .select({ id: tasks.id, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(eq(tasks.status, 'done'))
      .orderBy(desc(tasks.updatedAt))
      .limit(1);

    const {
      actionable: actionableFailures,
      recovered: recoveredProviderFailures,
    } = partitionRecoveredProviderFailures(
      branchFailures,
      latestSuccessfulTask?.updatedAt ?? null,
    );

    const snapshot: Record<string, unknown> = {
      manager: targetAgentId,
      subordinates,
      myOpenTasks: ownOpen,
      branchOpenByAgent: branchOpen,
      branchFailuresLast24h: actionableFailures.slice(0, 10).map((f) => ({
        taskId: f.id,
        title: f.title,
        agent: f.assignedAgentId,
        error: (f.errorMessage ?? '').slice(0, 300),
      })),
      recoveredProviderFailuresLast24h: {
        count: recoveredProviderFailures.length,
        latestSuccessfulTaskAt: latestSuccessfulTask?.updatedAt.toISOString() ?? null,
        note:
          'Historical provider-chain failures older than a later successful task. They are recovered context, not active incidents; do not escalate or duplicate them unless health_check currently fails.',
      },
      branchCompletedLast24h: branchCompleted.map((c) => ({
        taskId: c.id,
        title: c.title,
        agent: c.assignedAgentId,
        result: (c.result ?? '').slice(0, 300),
      })),
      reviewedAt: new Date().toISOString(),
    };

    if (payload.includeBuildMyBot2) {
      snapshot.buildmybot2 = await fetchBuildMyBot2Telemetry();
    }

    const description = [
      'AUTONOMOUS BRANCH REVIEW — no human requested this. You run this branch; review it and act.',
      '',
      '## Your branch state',
      '```json',
      JSON.stringify(snapshot, null, 2),
      '```',
      '',
      '## Focus for this review',
      payload.focus ?? 'Keep your branch productive and unblocked.',
      '',
      '## Standing rules for every branch review',
      '1. IDLE IS NOT A DEFECT. Give a subordinate work only when it advances an existing goal, resolves a',
      '   current incident, or implements an approved roadmap item. Zero open tasks is acceptable; never',
      '   manufacture audits, refactors, or reviews merely to make an agent look busy.',
      '2. VERIFY, DO NOT ASSUME. For work you previously delegated, call get_delegation_status and read what',
      '   actually came back before treating it as delivered.',
      '3. ACT ONLY ON CURRENT FAILURES. Items in branchFailuresLast24h need a corrected delegation, a fix, or',
      '   an escalation. recoveredProviderFailuresLast24h is historical context: do not re-delegate or',
      '   escalate it unless a fresh health_check proves the provider chain is still failing.',
      '4. RESPECT THE MANAGEMENT CHAIN. Delegate through direct reports and check for equivalent open work',
      '   first. The CTO delegates engineering only to the Lead Developer; it must never also assign the same',
      '   work directly to Frontend, Backend, DevOps, or QA.',
      '5. RESPECT PROJECT BOUNDARIES. readFile/listDir inspect the Apex container workspace only. Never use',
      '   them as evidence about BuildMyBot2. BuildMyBot work must retain project/repository context and use',
      '   its repo-scoped dispatch, PR, deploy, and health-check path.',
      '6. RESTRAINT. If the branch is healthy and has no goal-backed work, say so in one line and create',
      '   nothing. An honest quiet review is a good review.',
      '7. APPROVAL IS PER TOOL, never a global switch. Human approval is independently required before',
      '   each use of: runShell, deploy_to_environment, rollback_deployment, push_to_remote,',
      '   create_pull_request, register_application, delegate_to_application, make_outbound_call,',
      '   buildmybot_send_briefing, buildmybot_run_workforce, buildmybot_resolve_error,',
      '   buildmybot_deploy, and casebuddy_deploy_firm.',
      '   Irreversible actions (deploys, external sends, schema changes, financial) also stay',
      '   human-approved — propose and queue them; do not execute.',
    ].join('\n');

    const taskId = await enqueueSystemTask({
      title: `Autonomous branch review — ${targetAgentId} — ${new Date().toISOString()}`,
      description,
      assignedAgentId: targetAgentId,
      priority: job.priority,
      context: { scheduledJobId: job.id, snapshot },
    });

    return {
      taskId,
      assignedTo: targetAgentId,
      subordinates: subordinates.length,
      openInBranch: branchOpen.reduce((n, r) => n + r.count, 0),
      failuresLast24h: actionableFailures.length,
      recoveredProviderFailuresLast24h: recoveredProviderFailures.length,
      completedLast24h: branchCompleted.length,
    };
  }
}

// ── StalledWorkRecoveryJob: provider outages must not be permanent ─────────
//
// `TaskQueue.fail()` deliberately refuses to immediately retry any whole-chain
// LLM failure. That call is correct on its own terms: retrying on a 2s→300s
// backoff just repeats the same broken provider/model/key state and floods the
// dashboard.
//
// But nothing ever revisited those tasks afterwards. A task killed by a
// transient provider outage was dead FOREVER — the work simply vanished. On
// 2026-07-28 that was 22 tasks, including "Lead Generation & Outreach Campaign
// for BuildMyBot2" and every BuildMyBot2 error-remediation task. The workforce
// did not just stop when capacity ran out; it never came back when capacity
// returned, because no code path existed to bring it back. The Task Board sat
// at 0 pending / 0 in-progress with 22 dead tasks beside it.
//
// This handler is that missing path. It requeues recoverable provider-failed
// work on a widening backoff, bounded so a genuinely dead task cannot loop forever:
// if the chain is still exhausted the task fails again, comes back with a
// longer delay, and after `maxRequeues` is left alone for a human.

export class StalledWorkRecoveryJob implements JobHandler {
  /** Backoff before each successive requeue attempt. Widening, so a prolonged
   *  outage costs a handful of probe calls rather than a hot loop. */
  private static readonly BACKOFF_MS = [10 * 60_000, 45 * 60_000, 180 * 60_000];

  async execute(job: ScheduledJob): Promise<unknown> {
    const { db, tasks } = await import('@workspace/db');
    const { and, eq, gte, inArray, sql } = await import('drizzle-orm');

    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const windowHours = Number(payload.windowHours ?? 24);
    const maxPerRun = Number(payload.maxPerRun ?? 15);
    const maxRequeues = Number(payload.maxRequeues ?? StalledWorkRecoveryJob.BACKOFF_MS.length);
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const failedTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        assignedAgentId: tasks.assignedAgentId,
        errorMessage: tasks.errorMessage,
        context: tasks.context,
      })
      .from(tasks)
      .where(and(eq(tasks.status, 'failed'), gte(tasks.updatedAt, since)))
      .limit(200);

    const recoverable = failedTasks.filter((t) => isRecoverableLLMProviderFailure(t.errorMessage));
    if (recoverable.length === 0) {
      return {
        windowHours,
        failedInWindow: failedTasks.length,
        recoverableProviderFailures: 0,
        requeued: 0,
        note: 'No recoverable provider-chain failures. Any other failures are left for FailureReviewJob to triage.',
      };
    }

    let requeued = 0;
    let exhausted = 0;
    const requeuedTasks: Array<{ taskId: string; title: string; attempt: number; dueInMin: number }> = [];

    for (const task of recoverable) {
      if (requeued >= maxPerRun) break;

      const ctx = (task.context ?? {}) as Record<string, unknown>;
      const priorRequeues = Number(ctx.capacityRequeueCount ?? 0);

      // Repeatedly recovered and repeatedly died — stop burning calls on it.
      // FailureReviewJob will cluster it and put it in front of the CEO.
      if (priorRequeues >= maxRequeues) {
        exhausted++;
        continue;
      }

      const backoffMs =
        StalledWorkRecoveryJob.BACKOFF_MS[Math.min(priorRequeues, StalledWorkRecoveryJob.BACKOFF_MS.length - 1)];
      const nextRetryAt = new Date(Date.now() + backoffMs);

      await db
        .update(tasks)
        .set({
          status: 'pending',
          // Fresh retry budget: the previous failure was the provider's fault,
          // not this task's, so it should not inherit exhausted retries.
          retryCount: 0,
          errorMessage: null,
          nextRetryAt,
          updatedAt: new Date(),
          context: sql`coalesce(${tasks.context}, '{}'::jsonb) || ${JSON.stringify({
            capacityRequeueCount: priorRequeues + 1,
            lastCapacityRequeueAt: new Date().toISOString(),
          })}::jsonb`,
        })
        .where(eq(tasks.id, task.id));

      requeued++;
      requeuedTasks.push({
        taskId: task.id,
        title: task.title,
        attempt: priorRequeues + 1,
        dueInMin: Math.round(backoffMs / 60_000),
      });
    }

    return {
      windowHours,
      failedInWindow: failedTasks.length,
      recoverableProviderFailures: recoverable.length,
      requeued,
      exhaustedGiveUp: exhausted,
      requeuedTasks,
    };
  }
}

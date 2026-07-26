// ─── Job Handlers ─────────────────────────────────────────────────────────────
//
// Each handler implements the JobHandler interface and handles one job type.
// Handlers are stateless — they receive the job row and execute against the DB.

import type { ScheduledJob } from '@workspace/db';

export interface JobHandler {
  execute(job: ScheduledJob): Promise<unknown>;
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
    const { db, tasks, goals, componentHealth, learningInsights } = await import('@workspace/db');
    const { eq, desc, sql } = await import('drizzle-orm');

    const targetAgentId = job.targetAgentId ?? 'apex-ceo-001';

    // Snapshot real state so the CEO reasons from facts, not a vacuum.
    const activeGoals = await db
      .select({ id: goals.id, title: goals.title, priority: goals.priority })
      .from(goals)
      .where(eq(goals.status, 'active'))
      .orderBy(goals.priority)
      .limit(10);

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
      openTaskBacklog: backlog?.count ?? 0,
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

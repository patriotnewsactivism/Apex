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
          const shifts: Array<{ role_name: string; flags?: unknown; escalated_to?: unknown }> =
            shiftsRes.ok ? await shiftsRes.json() : [];
          const criticals: Array<{ source: string; message: string }> = criticalsRes.ok
            ? await criticalsRes.json()
            : [];
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

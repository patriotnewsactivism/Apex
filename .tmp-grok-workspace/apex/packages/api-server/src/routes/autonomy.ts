// ─── Autonomy Dashboard (Phase 8 of the autonomous-OS upgrade) ──────────────
//
// One endpoint that answers: "is APEX actually doing useful unattended work?"
// Distinct from /api/diagnostics (which answers "what is wrong right now")
// and the top-level /health (which answers "is the process serving traffic
// and is a worker heartbeat present") — this is throughput and autonomy
// mechanism health specifically: checkpoints, yields, quarantines, the
// executor, retries, and approvals, over time.
//
// Every number here is either a live query against durable state or a
// process-local counter clearly labeled as such (resets on restart) — never
// fabricated. Behind requireAdminAuth like every other /api route.

import { Router } from 'express';
import { db, tasks, approvals, goals, taskCheckpoints } from '@workspace/db';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { getWorkforceLiveness, getWorkerHeartbeatSummary, getAutonomyCounters } from '@workspace/core';

const TIMEOUT_QUARANTINE_PREFIX = 'Quarantined after hard task timeout:';

export function createAutonomyRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const [
        heartbeats,
        pendingTaskRow,
        oldestPendingRow,
        inProgressRow,
        blockedRow,
        quarantinedRow,
        retryBacklogRow,
        executorRows,
        throughput1h,
        throughput24h,
        pendingApprovalsRow,
        goalRows,
        checkpointRows,
        resumedRow,
      ] = await Promise.all([
        getWorkerHeartbeatSummary(),
        db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.status, 'pending')),
        db.select({ createdAt: tasks.createdAt }).from(tasks).where(eq(tasks.status, 'pending')).orderBy(tasks.createdAt).limit(1),
        db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.status, 'in_progress')),
        db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.status, 'blocked')),
        db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(
          eq(tasks.status, 'blocked'),
          sql`${tasks.errorMessage} LIKE ${`${TIMEOUT_QUARANTINE_PREFIX}%`}`,
        )),
        db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(
          isNotNull(tasks.nextRetryAt),
          sql`${tasks.nextRetryAt} > now()`,
        )),
        db.select({
          status: tasks.status,
          dispatched: sql<boolean>`(${tasks.context}->>'dispatchedAt') IS NOT NULL`,
          n: sql<number>`count(*)::int`,
        }).from(tasks)
          .where(sql`${tasks.context}->>'runtime' = 'job'`)
          .groupBy(tasks.status, sql`(${tasks.context}->>'dispatchedAt') IS NOT NULL`),
        db.select({
          done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
          failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')::int`,
        }).from(tasks).where(and(isNotNull(tasks.completedAt), gte(tasks.completedAt, oneHourAgo))),
        db.select({
          done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
          failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')::int`,
        }).from(tasks).where(and(isNotNull(tasks.completedAt), gte(tasks.completedAt, oneDayAgo))),
        db.select({ n: sql<number>`count(*)::int` }).from(approvals).where(and(eq(approvals.kind, 'approval'), eq(approvals.status, 'pending'))),
        db.select({
          status: goals.status,
          n: sql<number>`count(*)::int`,
        }).from(goals).groupBy(goals.status),
        db.select({ n: sql<number>`count(*)::int` }).from(taskCheckpoints),
        db.select({ n: sql<number>`count(*)::int` }).from(taskCheckpoints).where(isNotNull(taskCheckpoints.resumedAt)),
      ]);

      const executorSummary = { pendingUndispatched: 0, dispatched: 0, done: 0, failed: 0, other: 0 };
      for (const row of executorRows) {
        if (row.status === 'done') executorSummary.done += row.n;
        else if (row.status === 'failed') executorSummary.failed += row.n;
        else if (row.status === 'pending' && !row.dispatched) executorSummary.pendingUndispatched += row.n;
        else if (row.status === 'pending' && row.dispatched) executorSummary.dispatched += row.n;
        else executorSummary.other += row.n;
      }

      const goalCounts: Record<string, number> = {};
      for (const row of goalRows) goalCounts[row.status] = row.n;

      const liveness = getWorkforceLiveness();
      const counters = getAutonomyCounters();

      res.json({
        generatedAt: now.toISOString(),
        // ── Workers ──────────────────────────────────────────────────────
        workers: {
          healthy: heartbeats.healthyWorkerCount,
          total: heartbeats.totalWorkerCount,
          oldestHeartbeatAgeSeconds: heartbeats.oldestHeartbeatAgeSeconds,
          detail: heartbeats.workers,
          error: heartbeats.error,
        },
        agents: {
          active: liveness.alive,
          supervised: liveness.supervised,
          restarting: liveness.restarting.length,
          stalled: liveness.stalled.length,
          abandoned: liveness.abandoned.length,
        },
        // ── Queue shape ──────────────────────────────────────────────────
        tasks: {
          pending: pendingTaskRow[0]?.n ?? 0,
          oldestPendingCreatedAt: oldestPendingRow[0]?.createdAt?.toISOString() ?? null,
          inProgress: inProgressRow[0]?.n ?? 0,
          blocked: blockedRow[0]?.n ?? 0,
          hardTimeoutQuarantined: quarantinedRow[0]?.n ?? 0,
          retryBacklog: retryBacklogRow[0]?.n ?? 0,
        },
        // ── Checkpoint / yield mechanism (Phase 2 + 3) ──────────────────
        checkpoints: {
          // Durable (survives restart): every checkpoint ever written / how
          // many were actually resumed by a later execution.
          totalCreated: checkpointRows[0]?.n ?? 0,
          totalResumed: resumedRow[0]?.n ?? 0,
          // Process-local (resets on restart): what THIS process has done
          // since it started — useful for "is this happening right now".
          sinceProcessStart: {
            checkpointsCreated: counters.checkpointsCreated,
            tasksSoftYielded: counters.tasksSoftYielded,
            tasksResumedFromCheckpoint: counters.tasksResumedFromCheckpoint,
            approvalYields: counters.approvalYields,
            hardTimeoutQuarantines: counters.hardTimeoutQuarantines,
          },
        },
        executor: executorSummary,
        approvals: {
          pending: pendingApprovalsRow[0]?.n ?? 0,
        },
        throughput: {
          lastHour: { completed: throughput1h[0]?.done ?? 0, failed: throughput1h[0]?.failed ?? 0 },
          last24Hours: { completed: throughput24h[0]?.done ?? 0, failed: throughput24h[0]?.failed ?? 0 },
        },
        goals: {
          completed: goalCounts.completed ?? 0,
          failed: goalCounts.failed ?? 0,
          active: goalCounts.active ?? 0,
          paused: goalCounts.paused ?? 0,
          cancelled: goalCounts.cancelled ?? 0,
        },
        duplicateSideEffectPreventionEvents: counters.duplicateSideEffectsPrevented,
        heavyWorkRoutedToExecutor: counters.heavyWorkRoutedToExecutor,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

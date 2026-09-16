/**
 * Durable, cross-process worker heartbeat (Phase 5 of the autonomous-OS
 * upgrade).
 *
 * WHY THIS EXISTS
 * ------------------------------------------------------------------
 * getWorkforceLiveness() in runtime-health.ts is process-local. That is fine
 * for "is a loop inside THIS process stuck", but it cannot answer the
 * question ADR-011 explicitly flags as unresolved: whether a separately
 * deployed `start:worker` process is alive at all. The HTTP control-plane
 * process serving /health has no visibility into another process's memory,
 * and the worker process has no HTTP listener of its own to check. A web
 * server answering 200 must never be read as "the autonomous workers are
 * healthy" — this table is what makes the two independently observable.
 *
 * Every runtime (the HTTP control plane, or a standalone start:worker
 * process) that calls startWorkerHeartbeat() upserts one row for its own
 * process lifetime, on a short interval. /health reads the table (see
 * routes/health.ts and index.ts) rather than process memory.
 */

import { randomUUID } from 'crypto';
import { db, workerHeartbeats } from '@workspace/db';
import { desc } from 'drizzle-orm';
import { getBuildInfo, getWorkforceLiveness } from './runtime-health.js';

export type WorkerKind = 'http' | 'worker';

// ── Last-task activity (process-local, coarse) ───────────────────────────────
//
// Deliberately simple: a single "most recent" pointer per process, not a
// full per-agent task tracker (that already exists — the agents/tasks tables
// and /api/tasks). With concurrency > 1 this can be overwritten by a second
// task starting while a first is still running; that is an acceptable
// simplification for a coarse "is this process doing something" signal, and
// is documented here rather than left to look more precise than it is.

interface LastTaskActivity {
  currentTaskId: string | null;
  currentTaskStartedAtMs: number | null;
  lastCompletedTaskId: string | null;
  lastCompletedTaskAtMs: number | null;
}

const lastTaskActivity: LastTaskActivity = {
  currentTaskId: null,
  currentTaskStartedAtMs: null,
  lastCompletedTaskId: null,
  lastCompletedTaskAtMs: null,
};

export function recordTaskStarted(taskId: string): void {
  lastTaskActivity.currentTaskId = taskId;
  lastTaskActivity.currentTaskStartedAtMs = Date.now();
}

export function recordTaskFinished(taskId: string): void {
  if (lastTaskActivity.currentTaskId === taskId) {
    lastTaskActivity.currentTaskId = null;
    lastTaskActivity.currentTaskStartedAtMs = null;
  }
  lastTaskActivity.lastCompletedTaskId = taskId;
  lastTaskActivity.lastCompletedTaskAtMs = Date.now();
}

export function getLastTaskActivity(): LastTaskActivity {
  return { ...lastTaskActivity };
}

let schedulerHeartbeatAtMs: number | null = null;
/** Called by JobScheduler.runOnce() so a worker heartbeat can report whether
 *  the durable job scheduler itself is still cycling, not just the agent
 *  loops. */
export function touchSchedulerHeartbeat(): void {
  schedulerHeartbeatAtMs = Date.now();
}

let lastErrorMessage: string | null = null;
export function recordWorkerRuntimeError(message: string): void {
  lastErrorMessage = message.slice(0, 2000);
}

const WORKER_ID = randomUUID();
const PROCESS_STARTED_AT = new Date();

export function workerIdForThisProcess(): string {
  return WORKER_ID;
}

export interface WorkerHeartbeatHandle {
  stop(): void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export function startWorkerHeartbeat(
  kind: WorkerKind,
  options?: { intervalMs?: number },
): WorkerHeartbeatHandle {
  const intervalMs = options?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let stopped = false;

  const beat = async (status: 'starting' | 'running' | 'draining' | 'stopped') => {
    const liveness = getWorkforceLiveness();
    const activity = getLastTaskActivity();
    const build = getBuildInfo();
    const now = new Date();
    const row = {
      workerId: WORKER_ID,
      kind,
      buildSha: build.sha,
      startedAt: PROCESS_STARTED_AT,
      lastHeartbeatAt: now,
      agentCount: liveness.supervised,
      aliveAgentCount: liveness.alive,
      currentTaskId: activity.currentTaskId,
      currentTaskStartedAt: activity.currentTaskStartedAtMs ? new Date(activity.currentTaskStartedAtMs) : null,
      lastCompletedTaskId: activity.lastCompletedTaskId,
      lastCompletedTaskAt: activity.lastCompletedTaskAtMs ? new Date(activity.lastCompletedTaskAtMs) : null,
      schedulerHeartbeatAt: schedulerHeartbeatAtMs ? new Date(schedulerHeartbeatAtMs) : null,
      lastError: lastErrorMessage,
      status,
    };
    try {
      await db
        .insert(workerHeartbeats)
        .values(row)
        .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: row });
    } catch (err) {
      // A missed heartbeat write must never crash the runtime it is
      // reporting on. /health treats a stale/absent row as "unknown", which
      // is the honest state here, not a false "healthy".
      console.warn(
        `[worker-heartbeat] write failed (durable worker health degraded to unknown for this tick):`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  void beat('starting');
  const timer = setInterval(() => {
    if (!stopped) void beat('running');
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      void beat('stopped');
    },
  };
}

// ── Reading heartbeats back (for /health and the autonomy dashboard) ────────

/** A worker whose last heartbeat is older than this is reported unhealthy
 *  even if its row still exists — 6x the default write interval, generous
 *  enough that one missed tick under load is not a false alarm. */
const HEARTBEAT_STALE_AFTER_MS = 90_000;

export interface WorkerHeartbeatView {
  workerId: string;
  kind: string;
  buildSha: string;
  startedAt: string;
  lastHeartbeatAt: string;
  ageSeconds: number;
  agentCount: number;
  aliveAgentCount: number;
  currentTaskId: string | null;
  currentTaskStartedAt: string | null;
  lastCompletedTaskId: string | null;
  lastCompletedTaskAt: string | null;
  schedulerHeartbeatAt: string | null;
  lastError: string | null;
  status: string;
  healthy: boolean;
}

export interface WorkerHeartbeatSummary {
  workers: WorkerHeartbeatView[];
  healthyWorkerCount: number;
  totalWorkerCount: number;
  oldestHeartbeatAgeSeconds: number | null;
  /** Set when the durable read itself failed — distinct from "no workers
   *  registered yet", which is a legitimate (if concerning) empty result. */
  error?: string;
}

/** Never throws: a failed read here must not take down /health. */
export async function getWorkerHeartbeatSummary(): Promise<WorkerHeartbeatSummary> {
  try {
    const rows = await db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastHeartbeatAt)).limit(50);
    const now = Date.now();
    const workers: WorkerHeartbeatView[] = rows.map((row) => {
      const ageSeconds = Math.max(0, Math.round((now - row.lastHeartbeatAt.getTime()) / 1000));
      return {
        workerId: row.workerId,
        kind: row.kind,
        buildSha: row.buildSha,
        startedAt: row.startedAt.toISOString(),
        lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
        ageSeconds,
        agentCount: row.agentCount,
        aliveAgentCount: row.aliveAgentCount,
        currentTaskId: row.currentTaskId,
        currentTaskStartedAt: row.currentTaskStartedAt?.toISOString() ?? null,
        lastCompletedTaskId: row.lastCompletedTaskId,
        lastCompletedTaskAt: row.lastCompletedTaskAt?.toISOString() ?? null,
        schedulerHeartbeatAt: row.schedulerHeartbeatAt?.toISOString() ?? null,
        lastError: row.lastError,
        status: row.status,
        healthy: row.status !== 'stopped' && ageSeconds * 1000 <= HEARTBEAT_STALE_AFTER_MS,
      };
    });
    return {
      workers,
      healthyWorkerCount: workers.filter((w) => w.healthy).length,
      totalWorkerCount: workers.length,
      oldestHeartbeatAgeSeconds: workers.length ? Math.max(...workers.map((w) => w.ageSeconds)) : null,
    };
  } catch (err) {
    return {
      workers: [],
      healthyWorkerCount: 0,
      totalWorkerCount: 0,
      oldestHeartbeatAgeSeconds: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

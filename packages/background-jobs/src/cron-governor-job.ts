// ─── CronGovernorJob — the crons-creating-crons ceiling ─────────────────────
//
// Phase 5.4 of the autonomous-execution scheduler. Runs hourly and enforces
// the governance contract on the scheduled_jobs table:
//
//   · ceiling: at most MAX_DYNAMIC_JOBS dynamic (agent-created) jobs total;
//   · per-workstream ceiling: at most 3 dynamic jobs per workstream;
//   · frequency floor: dynamic recurring jobs must not fire more often than
//     every 15 minutes (computed from the cron expression via CronParser);
//   · failed-storm pruning: long-dead failed jobs are disabled rather than
//     retried forever;
//   · a summary memory row is written so the workforce can read its own
//     governance state.
//
// The governor never creates jobs; it only pauses/enforces. The bounded
// recursion guarantee ("workstream → cron → workstream, depth 1") comes from
// schedule_task + work_generation creating dynamic jobs only through
// governed paths, and from this job stopping anything that exceeds a ceiling.

import { randomUUID } from 'crypto';
import {
  db,
  scheduledJobs,
  workstreams,
  memories,
  type ScheduledJob,
} from '@workspace/db';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { CronParser } from './cron-parser.js';
import type { JobHandler } from './handlers/index.js';

export const DYNAMIC_JOB_FLOOR_MINUTES = 15;
export const DEFAULT_MAX_DYNAMIC_JOBS = 25;
export const PER_WORKSTREAM_JOB_CAP = 3;
export const FAILED_JOB_MAX_AGE_DAYS = 7;

export function maxDynamicJobs(): number {
  const raw = Number(process.env.APEX_MAX_DYNAMIC_JOBS ?? DEFAULT_MAX_DYNAMIC_JOBS);
  return Number.isFinite(raw) && raw >= 5 ? Math.floor(raw) : DEFAULT_MAX_DYNAMIC_JOBS;
}

/** A "dynamic" job is one created by an agent or a governed autonomous path,
 *  not by the code-owned seeded roster. */
export function isDynamicJob(row: {
  id: string;
  payload: Record<string, unknown> | null;
  name: string;
}): boolean {
  if (row.payload?.dynamic === true) return true;
  if (row.id.startsWith('auto-project-improvement:')) return true;
  return /^dynamic-/.test(row.id);
}

/** True when the cron fires more often than the frequency floor. */
export function violatesFrequencyFloor(cronExpression: string | null, from: Date): boolean {
  if (!cronExpression) return false;
  try {
    const first = CronParser.nextRun(cronExpression, from);
    if (!first) return false;
    const second = CronParser.nextRun(cronExpression, new Date(first.getTime() + 1000));
    if (!second) return false;
    return second.getTime() - first.getTime() < DYNAMIC_JOB_FLOOR_MINUTES * 60_000;
  } catch {
    return false;
  }
}

export class CronGovernorJob implements JobHandler {
  async execute(): Promise<unknown> {
    const now = new Date();
    const cap = maxDynamicJobs();
    const actions: Array<{ jobId: string; action: string; reason: string }> = [];

    const [dynamicRows, workstreamRows, failedRows] = await Promise.all([
      db
        .select()
        .from(scheduledJobs)
        .where(and(eq(scheduledJobs.enabled, true), inArray(scheduledJobs.status, ['active', 'running']))),
      db.select().from(workstreams).where(eq(workstreams.status, 'active')),
      db
        .select()
        .from(scheduledJobs)
        .where(and(eq(scheduledJobs.status, 'failed'), lt(scheduledJobs.updatedAt, new Date(now.getTime() - FAILED_JOB_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)))),
    ]);

    const workstreamIds = new Set(workstreamRows.map((ws) => ws.id));
    const dynamic = dynamicRows.filter((row) => isDynamicJob(row));
    const byWorkstream = new Map<string, typeof dynamic>();

    // ── Frequency floor: pause dynamic jobs that fire more often than 15 min.
    let floorViolations = 0;
    for (const row of dynamic) {
      if (row.cronExpression && violatesFrequencyFloor(row.cronExpression, now)) {
        await db.update(scheduledJobs).set({
          enabled: false,
          status: 'paused',
          error: `cron_governor: fires more often than the ${DYNAMIC_JOB_FLOOR_MINUTES}-minute frequency floor`,
          nextRunAt: null,
          updatedAt: now,
        }).where(and(eq(scheduledJobs.id, row.id), eq(scheduledJobs.status, 'running'), eq(scheduledJobs.enabled, true)));
        floorViolations++;
        actions.push({ jobId: row.id, action: 'paused', reason: 'frequency floor' });
      }
    }

    // ── Per-workstream ceiling: at most 3 dynamic jobs per workstream.
    let perWorkstreamViolations = 0;
    const postFloorDynamic = dynamic.filter((row) => violatesFrequencyFloor(row.cronExpression ?? '', now) === false);
    for (const row of postFloorDynamic) {
      const wsId = (row.payload?.workstreamId as string | undefined) ?? null;
      if (!wsId) continue;
      byWorkstream.set(wsId, [...(byWorkstream.get(wsId) ?? []), row]);
    }
    for (const [wsId, rows] of byWorkstream) {
      if (!workstreamIds.has(wsId)) continue;
      if (rows.length <= PER_WORKSTREAM_JOB_CAP) continue;
      const excess = rows.slice(PER_WORKSTREAM_JOB_CAP);
      for (const row of excess) {
        await db.update(scheduledJobs).set({
          enabled: false,
          status: 'paused',
          error: `cron_governor: workstream ${wsId} exceeds ${PER_WORKSTREAM_JOB_CAP} dynamic jobs`,
          nextRunAt: null,
          updatedAt: now,
        }).where(and(eq(scheduledJobs.id, row.id), eq(scheduledJobs.enabled, true)));
        perWorkstreamViolations++;
        actions.push({ jobId: row.id, action: 'paused', reason: `per-workstream cap (${wsId})` });
      }
    }

    // ── Total ceiling: pause excess dynamic jobs (oldest first, keep newest).
    const stillEnabled = await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.enabled, true), inArray(scheduledJobs.status, ['active', 'running'])));
    const enabledDynamic = stillEnabled.filter((row) => isDynamicJob(row)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let ceilingViolations = 0;
    const excessTotal = enabledDynamic.length - cap;
    if (excessTotal > 0) {
      for (const row of enabledDynamic.slice(0, excessTotal)) {
        await db.update(scheduledJobs).set({
          enabled: false,
          status: 'paused',
          error: `cron_governor: dynamic job ceiling (${cap}) exceeded`,
          nextRunAt: null,
          updatedAt: now,
        }).where(and(eq(scheduledJobs.id, row.id), eq(scheduledJobs.enabled, true)));
        ceilingViolations++;
        actions.push({ jobId: row.id, action: 'paused', reason: `total ceiling (${cap})` });
      }
    }

    // ── Failed-storm pruning: disable failed jobs older than 7 days.
    let pruned = 0;
    for (const row of failedRows) {
      await db.update(scheduledJobs).set({
        enabled: false,
        error: (row.error ? `${row.error} | ` : '') + `cron_governor: pruned failed job after ${FAILED_JOB_MAX_AGE_DAYS}d`,
        updatedAt: now,
      }).where(and(eq(scheduledJobs.id, row.id), eq(scheduledJobs.status, 'failed')));
      pruned++;
      actions.push({ jobId: row.id, action: 'pruned', reason: 'failed storm' });
    }

    // ── Summary memory row (durable governance state the workforce can read).
    const summary = JSON.stringify({
      at: now.toISOString(),
      dynamicJobs: enabledDynamic.length,
      cap,
      frequencyFloorMinutes: DYNAMIC_JOB_FLOOR_MINUTES,
      floorViolations,
      perWorkstreamViolations,
      ceilingViolations,
      pruned,
      actions: actions.slice(0, 50),
    });
    const [existing] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(
        eq(memories.agentId, 'apex-cron-governor'),
        eq(memories.scope, 'global'),
        eq(memories.key, 'cron-governor:health'),
      ))
      .limit(1);
    if (existing) {
      await db.update(memories).set({ value: summary, updatedAt: now }).where(eq(memories.id, existing.id));
    } else {
      await db.insert(memories).values({
        id: randomUUID(),
        agentId: 'apex-cron-governor',
        scope: 'global',
        key: 'cron-governor:health',
        value: summary,
        importance: 0.7,
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      dynamicJobs: enabledDynamic.length,
      cap,
      frequencyFloorMinutes: DYNAMIC_JOB_FLOOR_MINUTES,
      floorViolations,
      perWorkstreamViolations,
      ceilingViolations,
      pruned,
      actions: actions.length,
    };
  }
}
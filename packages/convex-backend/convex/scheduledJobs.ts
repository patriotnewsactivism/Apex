import { v } from 'convex/values';
import { internalAction, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { JOB_HANDLERS } from './jobHandlers';

// ─── Scheduled Jobs (autonomous job scheduler) ──────────────────────────────
//
// Ports packages/background-jobs/src/{job-scheduler,job-executor,cron-parser}.ts.
// The old JobScheduler ran an in-process 60s setTimeout poll loop calling
// JobExecutor.execute() fire-and-forget (`.then()` without awaiting) so one
// slow job never blocked the others due that tick. Convex has no long-lived
// process to host that loop — see convex/crons.ts's one new `crons.interval`
// entry, which calls `dispatchDueJobs` below every 60s instead.
//
// dispatchDueJobs (an internalMutation) queries the by_due index once, leases
// every due job forward so an overlapping poll can't double-dispatch it, then
// fires `ctx.scheduler.runAfter(0, internal.scheduledJobs.executeJob, ...)`
// per job WITHOUT awaiting the job's completion — the direct Convex
// equivalent of the old code's un-awaited `.then()` dispatch. executeJob (an
// internalAction — it needs ctx.runAction for HealthCheckJob/LearningAnalysisJob
// and fetch for the BuildMyBot2 legs) is the ported JobExecutor.execute():
// timeout via Promise.race, retry/backoff math, and a row in jobExecutionLog
// for every attempt.

// ═══════════════════════════════════════════════════════════════════════════
// CronParser — ported verbatim from packages/background-jobs/src/cron-parser.ts
// as a pure function with zero Convex dependency (per the porting brief).
// Standard 5-field cron (minute hour day-of-month month day-of-week):
// wildcards (*), ranges (1-5), intervals (*/5), lists (1,3,5), combinations.
// ═══════════════════════════════════════════════════════════════════════════

interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

const FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 },
];

function parseCronField(field: string, min: number, max: number, fieldName: string): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const slashIndex = trimmed.indexOf('/');
    if (slashIndex !== -1) {
      const rangePart = trimmed.slice(0, slashIndex);
      const stepStr = trimmed.slice(slashIndex + 1);
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid step '${stepStr}' in ${fieldName} field '${field}'`);
      }

      let rangeMin = min;
      let rangeMax = max;
      if (rangePart !== '*') {
        const dashIndex = rangePart.indexOf('-');
        if (dashIndex !== -1) {
          rangeMin = parseInt(rangePart.slice(0, dashIndex), 10);
          rangeMax = parseInt(rangePart.slice(dashIndex + 1), 10);
        } else {
          rangeMin = parseInt(rangePart, 10);
          rangeMax = max;
        }
      }

      if (isNaN(rangeMin) || isNaN(rangeMax)) {
        throw new Error(`Invalid range in ${fieldName} field '${field}'`);
      }

      for (let i = rangeMin; i <= rangeMax; i += step) values.add(i);
      continue;
    }

    const dashIndex = trimmed.indexOf('-');
    if (dashIndex !== -1) {
      const start = parseInt(trimmed.slice(0, dashIndex), 10);
      const end = parseInt(trimmed.slice(dashIndex + 1), 10);
      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range '${trimmed}' in ${fieldName} field`);
      }
      if (start < min || end > max || start > end) {
        throw new Error(`Range ${start}-${end} out of bounds [${min}-${max}] in ${fieldName} field`);
      }
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    const num = parseInt(trimmed, 10);
    if (isNaN(num)) {
      throw new Error(`Invalid value '${trimmed}' in ${fieldName} field`);
    }
    if (num < min || num > max) {
      throw new Error(`Value ${num} out of bounds [${min}-${max}] in ${fieldName} field`);
    }
    values.add(num);
  }

  return Array.from(values).sort((a, b) => a - b);
}

export const CronParser = {
  /** @throws Error if the expression is invalid */
  parse(expression: string): CronFields {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(
        `Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}: '${expression}'`,
      );
    }
    return {
      minutes: parseCronField(parts[0], FIELD_RANGES[0].min, FIELD_RANGES[0].max, FIELD_RANGES[0].name),
      hours: parseCronField(parts[1], FIELD_RANGES[1].min, FIELD_RANGES[1].max, FIELD_RANGES[1].name),
      daysOfMonth: parseCronField(parts[2], FIELD_RANGES[2].min, FIELD_RANGES[2].max, FIELD_RANGES[2].name),
      months: parseCronField(parts[3], FIELD_RANGES[3].min, FIELD_RANGES[3].max, FIELD_RANGES[3].name),
      daysOfWeek: parseCronField(parts[4], FIELD_RANGES[4].min, FIELD_RANGES[4].max, FIELD_RANGES[4].name),
    };
  },

  /** Returns null if valid, or an error message string if invalid. */
  validate(expression: string): string | null {
    try {
      CronParser.parse(expression);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },

  /** Next run time strictly after `from`, searching forward up to 1 year.
   * Returns null if no match found (should be impossible for any valid
   * expression). */
  nextRun(expression: string, from: Date = new Date()): Date | null {
    const fields = CronParser.parse(expression);
    const maxSearchMs = 366 * 24 * 60 * 60 * 1000;
    const deadline = from.getTime() + maxSearchMs;

    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    while (candidate.getTime() < deadline) {
      const month = candidate.getMonth() + 1;
      const dayOfMonth = candidate.getDate();
      const dayOfWeek = candidate.getDay();
      const hour = candidate.getHours();
      const minute = candidate.getMinutes();

      if (!fields.months.includes(month)) {
        candidate.setMonth(candidate.getMonth() + 1, 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }

      if (!fields.daysOfMonth.includes(dayOfMonth) || !fields.daysOfWeek.includes(dayOfWeek)) {
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }

      if (!fields.hours.includes(hour)) {
        candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
        continue;
      }

      if (!fields.minutes.includes(minute)) {
        candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
        continue;
      }

      return candidate;
    }

    return null;
  },
};

/** ms-timestamp convenience wrapper around CronParser.nextRun, since
 * scheduledJobs.nextRunAt/lastRunAt/updatedAt are all epoch-ms numbers. */
function computeNextRunAt(cronExpression: string, fromMs: number): number | null {
  const next = CronParser.nextRun(cronExpression, new Date(fromMs));
  return next ? next.getTime() : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants — mirror the old JobSchedulerConfig / JobExecutorConfig defaults
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT_MS = 60_000; // old JobExecutorConfig.defaultTimeoutMs default
const MAX_DISPATCH_PER_TICK = 50; // old JobExecutorConfig.maxConcurrent default
// > DEFAULT_TIMEOUT_MS so a job still executing when the next 60s dispatch
// tick fires isn't claimed a second time — recordJobSuccess/recordJobFailure
// overwrite this lease with the real nextRunAt once execution actually finishes.
const LEASE_MS = 90_000;

// ═══════════════════════════════════════════════════════════════════════════
// Dispatcher — the target of crons.ts's new 60s interval entry
// ═══════════════════════════════════════════════════════════════════════════

/** Finds every enabled, active, due job and fires each as an independent
 * scheduled action call — never awaited here, so one slow job's execution
 * can't delay dispatching the others due this same tick (mirrors the old
 * JobScheduler.processDueJobs' un-awaited `.then()` dispatch). */
export const dispatchDueJobs = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query('scheduledJobs')
      .withIndex('by_due', (q) => q.eq('enabled', true).eq('status', 'active').lte('nextRunAt', now))
      .take(MAX_DISPATCH_PER_TICK);

    for (const job of due) {
      // Lease the job forward so an overlapping/slow-running execution can't
      // be claimed a second time by the next 60s tick. executeJob's own
      // recordJobSuccess/recordJobFailure mutations overwrite this with the
      // real recurring-reschedule or backoff-on-failure nextRunAt.
      await ctx.db.patch(job._id, { nextRunAt: now + LEASE_MS, updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.scheduledJobs.executeJob, { jobId: job._id });
    }

    return due.length;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Execution bookkeeping — new internal mutations (no equivalent existed in
// toolRegistry.ts, which only has scheduledJobs_get/list/insert/cancel and
// jobExecutionLog_list; per the porting brief these are added here instead
// of touching toolRegistry.ts)
// ═══════════════════════════════════════════════════════════════════════════

export const startJobExecution = internalMutation({
  args: { jobId: v.id('scheduledJobs'), executionId: v.string(), startedAt: v.number() },
  returns: v.id('jobExecutionLog'),
  handler: async (ctx, { jobId, executionId, startedAt }) => {
    return await ctx.db.insert('jobExecutionLog', {
      jobId,
      executionId,
      startedAt,
      status: 'running',
    });
  },
});

export const finishJobExecutionLog = internalMutation({
  args: {
    executionLogId: v.id('jobExecutionLog'),
    status: v.union(v.literal('completed'), v.literal('failed'), v.literal('timeout')),
    completedAt: v.number(),
    durationMs: v.number(),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { executionLogId, status, completedAt, durationMs, output, error }) => {
    await ctx.db.patch(executionLogId, { status, completedAt, durationMs, output, error });
    return null;
  },
});

/** On success: reset retry state, clear any prior error, and reschedule —
 * recurring (cronExpression set) jobs get their next cron-computed run time
 * and stay 'active'; one-time jobs flip to 'completed' so they drop out of
 * the by_due index scan. */
export const recordJobSuccess = internalMutation({
  args: { jobId: v.id('scheduledJobs'), completedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { jobId, completedAt }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;

    if (!job.cronExpression) {
      await ctx.db.patch(jobId, {
        status: 'completed',
        lastRunAt: completedAt,
        retryCount: 0,
        error: undefined,
        updatedAt: completedAt,
      });
      return null;
    }

    const next = computeNextRunAt(job.cronExpression, completedAt);
    if (next === null) {
      // Judgment call (deviates from the old code, which silently left
      // nextRunAt stale and re-selected the job on every poll forever): a
      // cron expression with no match inside a 1-year search window is
      // exceptional and worth surfacing rather than tight-looping the
      // dispatcher on it every 60s.
      await ctx.db.patch(jobId, {
        status: 'failed',
        error: `CronParser.nextRun found no matching time within its 1-year search window for expression '${job.cronExpression}'`,
        lastRunAt: completedAt,
        updatedAt: completedAt,
      });
      return null;
    }

    await ctx.db.patch(jobId, {
      lastRunAt: completedAt,
      retryCount: 0,
      error: undefined,
      nextRunAt: next,
      updatedAt: completedAt,
    });
    return null;
  },
});

/** On failure: exponential backoff `2^retryCount * 30_000` ms, ported
 * verbatim from the old JobExecutor. Once retryCount reaches maxRetries the
 * job is marked 'failed' (dropping out of the by_due scan) instead of
 * rescheduled. */
export const recordJobFailure = internalMutation({
  args: { jobId: v.id('scheduledJobs'), error: v.string(), completedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { jobId, error, completedAt }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;

    const newRetryCount = job.retryCount + 1;
    if (newRetryCount >= job.maxRetries) {
      await ctx.db.patch(jobId, {
        retryCount: newRetryCount,
        error,
        status: 'failed',
        lastRunAt: completedAt,
        updatedAt: completedAt,
      });
    } else {
      const backoffMs = Math.pow(2, newRetryCount) * 30_000;
      await ctx.db.patch(jobId, {
        retryCount: newRetryCount,
        error,
        nextRunAt: completedAt + backoffMs,
        lastRunAt: completedAt,
        updatedAt: completedAt,
      });
    }
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// seedDefaultJobs — ports the old api-server's seedDefaultJobs() (index.ts:52),
// which ran once at process boot. Idempotent via legacyId + by_legacyId (the
// old code used onConflictDoNothing on a stable string id for the same
// reason: an operator-disabled job must stay disabled across restarts/redeploys,
// never silently re-enabled). Only goal_review + learning_analysis were ever
// actually seeded by the old boot code; health_check is a deliberate addition
// here — the old system ran health checks on a totally separate always-on
// setInterval in the api-server process (packages/api-server/src/index.ts,
// runHealthPoll/healthInterval), which has no Convex equivalent. Routing it
// through this same scheduledJobs/by_due dispatcher instead of inventing a
// second cron mechanism is simpler and gives it the same retry/backoff/log
// behavior as every other job type for free.
// ═══════════════════════════════════════════════════════════════════════════

export const seedDefaultJobs = internalMutation({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const now = Date.now();
    const ceo = await ctx.db
      .query('agents')
      .withIndex('by_legacyId', (q) => q.eq('legacyId', 'apex-ceo-001'))
      .unique();

    const defaults: Array<{
      legacyId: string;
      name: string;
      jobType: string;
      cronExpression: string;
      targetAgentId: import('./_generated/dataModel').Id<'agents'> | undefined;
      priority: number;
    }> = [
      {
        legacyId: 'system-ceo-goal-review',
        name: 'CEO autonomous goal review',
        jobType: 'goal_review',
        cronExpression: '*/30 * * * *', // every 30 min — matches old system exactly
        targetAgentId: ceo?._id,
        priority: 4,
      },
      {
        legacyId: 'system-learning-analysis',
        name: 'Autonomous learning analysis',
        jobType: 'learning_analysis',
        cronExpression: '0 */6 * * *', // every 6h — matches old system exactly
        targetAgentId: undefined,
        priority: 6,
      },
      {
        legacyId: 'system-health-check',
        name: 'System health check',
        jobType: 'health_check',
        cronExpression: '*/5 * * * *', // every 5 min — see note above (old was a separate 60s setInterval, not a scheduledJobs row)
        targetAgentId: undefined,
        priority: 5,
      },
    ];

    const created: string[] = [];
    for (const def of defaults) {
      const existing = await ctx.db
        .query('scheduledJobs')
        .withIndex('by_legacyId', (q) => q.eq('legacyId', def.legacyId))
        .unique();
      if (existing) continue;

      const nextRunAt = computeNextRunAt(def.cronExpression, now) ?? now + 60_000;
      await ctx.db.insert('scheduledJobs', {
        legacyId: def.legacyId,
        name: def.name,
        jobType: def.jobType,
        cronExpression: def.cronExpression,
        enabled: true,
        targetAgentId: def.targetAgentId,
        payload: {},
        priority: def.priority,
        status: 'active',
        retryCount: 0,
        maxRetries: 3,
        nextRunAt,
        updatedAt: now,
      });
      created.push(def.legacyId);
    }
    return created;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// executeJob — the ported JobExecutor.execute(): timeout via Promise.race
// (same mechanism the old code used), retry/backoff, and a jobExecutionLog
// row for every attempt.
// ═══════════════════════════════════════════════════════════════════════════

export const executeJob = internalAction({
  args: { jobId: v.id('scheduledJobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery(internal.toolRegistry.scheduledJobs_get, { jobId });
    if (!job) {
      console.warn(`[scheduledJobs] executeJob: job ${jobId} not found (deleted after dispatch?)`);
      return null;
    }
    if (!job.enabled) {
      console.warn(`[scheduledJobs] executeJob: job ${jobId} ('${job.name}') is disabled, skipping`);
      return null;
    }

    const handler = JOB_HANDLERS[job.jobType];
    if (!handler) {
      // Faithful to the old JobExecutor.execute(): an unregistered job type
      // returns early WITHOUT writing a jobExecutionLog row or touching the
      // job's retry state (the old code never reached that point either).
      console.error(`[scheduledJobs] executeJob: no handler registered for job type '${job.jobType}' (job '${job.name}')`);
      return null;
    }

    // crypto.randomUUID() is the ambient Web Crypto global available in
    // Convex's default runtime — no 'node:crypto' import needed (same
    // convention toolRegistry.ts already uses).
    const executionId = crypto.randomUUID();
    const startedAt = Date.now();
    const executionLogId = await ctx.runMutation(internal.scheduledJobs.startJobExecution, {
      jobId,
      executionId,
      startedAt,
    });

    try {
      const result = await Promise.race([
        handler(ctx, job),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Job timed out after ${DEFAULT_TIMEOUT_MS}ms`)), DEFAULT_TIMEOUT_MS),
        ),
      ]);

      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      const output = typeof result === 'string' ? result : JSON.stringify(result);

      await ctx.runMutation(internal.scheduledJobs.finishJobExecutionLog, {
        executionLogId,
        status: 'completed',
        completedAt,
        durationMs,
        output,
      });
      await ctx.runMutation(internal.scheduledJobs.recordJobSuccess, { jobId, completedAt });
    } catch (err) {
      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMsg.includes('timed out');

      await ctx.runMutation(internal.scheduledJobs.finishJobExecutionLog, {
        executionLogId,
        status: isTimeout ? 'timeout' : 'failed',
        completedAt,
        durationMs,
        error: errorMsg,
      });
      await ctx.runMutation(internal.scheduledJobs.recordJobFailure, { jobId, error: errorMsg, completedAt });
    }

    return null;
  },
});

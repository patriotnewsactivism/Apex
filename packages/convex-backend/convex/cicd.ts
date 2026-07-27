import { v } from 'convex/values';
import { internalMutation, internalQuery, mutation } from './_generated/server';
import { internal } from './_generated/api';

// ─── External Jobs (CI/CD worker contract) ──────────────────────────────────
//
// M5: the full contract between Convex and the standalone `packages/cicd-worker`
// process — the one piece of Apex that intentionally stays OFF Convex, because
// it needs a real persistent filesystem/git checkout and the ability to spawn
// arbitrary OS processes (pnpm test/lint/build, git, a real headless browser),
// none of which a Convex function can do. Convex only holds the queue; the
// worker does the actual work and calls back in with the result.
//
// Flow: dispatchTool() (toolRegistry.ts) → enqueueJob → worker's poll loop
// calls claimNextJob → worker executes the real command/git-op/fetch → worker
// calls reportJobResult → that wakes the waiting task via
// internal.agentLoop.resumeToolCall, the same join-and-resume mechanism
// approvals.resolve already uses.
//
// Auth: claimNextJob/reportJobResult are called by an always-on external
// process, not a browser client, so they're gated by a shared secret
// (CICD_WORKER_SECRET, set via `npx convex env set`) rather than left
// world-callable — anyone with the deployment URL could otherwise claim/forge
// job results. This is deliberately NOT the Convex deploy key (that's for
// schema/function pushes only and must never live in an always-running
// worker process — see the migration plan's credential-separation note).

const JOB_TYPE = v.union(
  v.literal('test'), v.literal('lint'), v.literal('build'), v.literal('deploy'), v.literal('rollback'),
  v.literal('git_status'), v.literal('create_branch'), v.literal('push'), v.literal('create_pr'),
  v.literal('run_shell'), v.literal('read_file'), v.literal('write_file'), v.literal('list_dir'),
  v.literal('run_sandbox'), v.literal('browser_check'),
);

const EXTERNAL_JOB_DOC = v.object({
  _id: v.id('externalJobs'),
  _creationTime: v.number(),
  jobType: JOB_TYPE,
  status: v.union(v.literal('queued'), v.literal('claimed'), v.literal('running'), v.literal('succeeded'), v.literal('failed')),
  payload: v.any(),
  result: v.optional(v.any()),
  error: v.optional(v.string()),
  requestingTaskId: v.optional(v.id('tasks')),
  requestingAgentId: v.optional(v.id('agents')),
  toolCallId: v.optional(v.string()),
  claimedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  timeoutAt: v.number(),
});

function requireWorkerSecret(provided: string): void {
  const expected = process.env.CICD_WORKER_SECRET;
  if (!expected) {
    throw new Error('CICD_WORKER_SECRET is not set on this Convex deployment — run `npx convex env set CICD_WORKER_SECRET <value>` before the worker can claim jobs.');
  }
  if (provided !== expected) {
    throw new Error('Invalid worker secret');
  }
}

export const enqueueJob = internalMutation({
  args: {
    jobType: JOB_TYPE,
    payload: v.any(),
    requestingTaskId: v.optional(v.id('tasks')),
    requestingAgentId: v.optional(v.id('agents')),
    toolCallId: v.optional(v.string()),
    timeoutMs: v.optional(v.number()),
  },
  returns: v.id('externalJobs'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('externalJobs', {
      jobType: args.jobType,
      status: 'queued',
      payload: args.payload,
      requestingTaskId: args.requestingTaskId,
      requestingAgentId: args.requestingAgentId,
      toolCallId: args.toolCallId,
      timeoutAt: Date.now() + (args.timeoutMs ?? 60_000),
    });
  },
});

export const getJob = internalQuery({
  args: { jobId: v.id('externalJobs') },
  returns: v.union(EXTERNAL_JOB_DOC, v.null()),
  handler: async (ctx, { jobId }) => ctx.db.get(jobId),
});

// ─── claimNextJob — called by the worker's poll loop ────────────────────────
//
// Atomically claims the single oldest 'queued' job (Convex mutations are
// transactional, so there's no race between two worker replicas both reading
// 'queued' and both patching the same row — the second patch would see a
// changed document and this mutation would OCC-retry). Returns null if
// nothing is queued, so the worker just sleeps and polls again.
export const claimNextJob = mutation({
  args: { workerSecret: v.string() },
  returns: v.union(EXTERNAL_JOB_DOC, v.null()),
  handler: async (ctx, { workerSecret }) => {
    requireWorkerSecret(workerSecret);
    const next = await ctx.db
      .query('externalJobs')
      .withIndex('by_status', (q) => q.eq('status', 'queued'))
      .order('asc')
      .first();
    if (!next) return null;

    await ctx.db.patch(next._id, { status: 'claimed', claimedAt: Date.now() });
    return await ctx.db.get(next._id);
  },
});

// ─── reportJobResult — the worker's callback once it's actually run the job ─
//
// Persists the outcome, then wakes the waiting agent task immediately via the
// same scheduler.runAfter(0, resumeToolCall, ...) pattern approvals.resolve
// already uses — zero added latency beyond the mutation itself, no polling
// on the Convex side.
export const reportJobResult = mutation({
  args: {
    workerSecret: v.string(),
    jobId: v.id('externalJobs'),
    success: v.boolean(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { workerSecret, jobId, success, result, error }) => {
    requireWorkerSecret(workerSecret);
    const job = await ctx.db.get(jobId);
    if (!job) return null; // already deleted/expired — nothing to wake

    // Idempotency: a worker retry (e.g. its own process restarted before the
    // HTTP response landed) reporting the same job twice must not resume the
    // same task a second time.
    if (job.status === 'succeeded' || job.status === 'failed') return null;

    await ctx.db.patch(jobId, {
      status: success ? 'succeeded' : 'failed',
      result,
      error,
      completedAt: Date.now(),
    });

    if (job.requestingTaskId && job.toolCallId) {
      await ctx.scheduler.runAfter(0, internal.agentLoop.resumeToolCall, {
        taskId: job.requestingTaskId,
        toolCallId: job.toolCallId,
        kind: 'externalJob' as const,
        externalResult: success ? result : undefined,
        externalError: success ? undefined : (error ?? 'External job failed with no error message'),
      });
    }
    return null;
  },
});

// ─── Timeout sweep — the crons.ts entry that catches a job the worker never
// claimed, or claimed and then died mid-execution without ever reporting
// back (crash, OOM, Railway restart). Without this, a task would wait on
// that join forever. ────────────────────────────────────────────────────────
export const sweepTimedOutJobs = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const overdue = await ctx.db
      .query('externalJobs')
      .withIndex('by_timeout', (q) => q.eq('status', 'queued').lte('timeoutAt', now))
      .take(50);
    const overdueClaimed = await ctx.db
      .query('externalJobs')
      .withIndex('by_timeout', (q) => q.eq('status', 'claimed').lte('timeoutAt', now))
      .take(50);

    for (const job of [...overdue, ...overdueClaimed]) {
      await ctx.db.patch(job._id, {
        status: 'failed',
        error: `Timed out (no worker response before timeoutAt=${job.timeoutAt})`,
        completedAt: now,
      });
      if (job.requestingTaskId && job.toolCallId) {
        await ctx.scheduler.runAfter(0, internal.agentLoop.resumeToolCall, {
          taskId: job.requestingTaskId,
          toolCallId: job.toolCallId,
          kind: 'externalJob' as const,
          externalError: 'CI/CD job timed out — no worker reported a result in time',
        });
      }
    }
    return overdue.length + overdueClaimed.length;
  },
});

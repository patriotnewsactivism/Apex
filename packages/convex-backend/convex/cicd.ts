import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

// ─── External Jobs (CI/CD worker contract) ──────────────────────────────────
//
// M3 stub: just enough for tool actions to hand off filesystem/shell/browser
// work (readFile, writeFile, runShell, run_tests, etc. — anything that needs
// a real OS process, which Convex functions cannot provide) to the standalone
// CI/CD worker built in M5. M5 adds claimNextJob/reportJobResult/the
// timeout-sweep cron on top of this same externalJobs table.

const JOB_TYPE = v.union(
  v.literal('test'), v.literal('lint'), v.literal('build'), v.literal('deploy'), v.literal('rollback'),
  v.literal('git_status'), v.literal('create_branch'), v.literal('push'), v.literal('create_pr'),
  v.literal('run_shell'), v.literal('read_file'), v.literal('write_file'), v.literal('list_dir'),
  v.literal('run_sandbox'), v.literal('browser_check'),
);

export const enqueueJob = internalMutation({
  args: {
    jobType: JOB_TYPE,
    payload: v.any(),
    requestingTaskId: v.optional(v.id('tasks')),
    requestingAgentId: v.optional(v.id('agents')),
    timeoutMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('externalJobs', {
      jobType: args.jobType,
      status: 'queued',
      payload: args.payload,
      requestingTaskId: args.requestingTaskId,
      requestingAgentId: args.requestingAgentId,
      timeoutAt: Date.now() + (args.timeoutMs ?? 60_000),
    });
  },
});

export const getJob = internalQuery({
  args: { jobId: v.id('externalJobs') },
  handler: async (ctx, { jobId }) => ctx.db.get(jobId),
});

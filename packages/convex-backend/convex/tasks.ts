import { v } from 'convex/values';
import { query, internalMutation, internalQuery } from './_generated/server';

// ─── Tasks ───────────────────────────────────────────────────────────────────
//
// Ports packages/core/src/task-queue.ts's TaskQueue class. The old in-memory
// `memoryQueue` fallback (used when Postgres was briefly unreachable) is
// dropped — Convex's db IS the durable store; there's no "DB offline, keep
// going in memory" mode for a stateless function invocation to fall back to.

const TASK_STATUS = v.union(
  v.literal('pending'), v.literal('in_progress'), v.literal('blocked'),
  v.literal('awaiting_approval'), v.literal('done'), v.literal('failed'), v.literal('cancelled'),
);

export const get = query({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => ctx.db.get(taskId),
});

export const list = query({
  args: { status: v.optional(TASK_STATUS) },
  handler: async (ctx, { status }) => {
    const all = await ctx.db.query('tasks').order('desc').collect();
    return status ? all.filter((t) => t.status === status) : all;
  },
});

export const listByGoal = query({
  args: { goalId: v.id('goals') },
  handler: async (ctx, { goalId }) => {
    return await ctx.db.query('tasks').withIndex('by_goal', (q) => q.eq('goalId', goalId)).collect();
  },
});

/** Create a new task and enqueue it (defaults mirror the old Drizzle column defaults). */
export const enqueue = internalMutation({
  args: {
    assignedAgentId: v.id('agents'),
    createdByAgentId: v.optional(v.id('agents')),
    goalId: v.optional(v.id('goals')),
    parentTaskId: v.optional(v.id('tasks')),
    title: v.string(),
    description: v.string(),
    priority: v.optional(v.number()),
    context: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert('tasks', {
      goalId: args.goalId,
      parentTaskId: args.parentTaskId,
      title: args.title,
      description: args.description,
      status: 'pending',
      priority: args.priority ?? 5,
      assignedAgentId: args.assignedAgentId,
      createdByAgentId: args.createdByAgentId ?? args.assignedAgentId,
      updatedAt: now,
      nextRetryAt: 0,
      retryCount: 0,
      maxRetries: 3,
    });
  },
});

/** Ports BaseAgent.delegate()'s idempotent create: if a task with the same
 * (goalId, title, assignedAgentId) already exists in ANY state, return its id
 * instead of creating a duplicate — prevents a retry loop (e.g. the CEO's
 * "Process Goal" task re-running) from spawning fresh retryCount=0 children
 * on every pass, which would bypass maxRetries and crash-loop. */
export const delegate = internalMutation({
  args: {
    assignedAgentId: v.id('agents'),
    createdByAgentId: v.id('agents'),
    goalId: v.optional(v.id('goals')),
    parentTaskId: v.optional(v.id('tasks')),
    title: v.string(),
    description: v.string(),
    priority: v.optional(v.number()),
    context: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    if (args.goalId) {
      const candidates = await ctx.db.query('tasks').withIndex('by_goal', (q) => q.eq('goalId', args.goalId)).collect();
      const existing = candidates.find((t) => t.title === args.title && t.assignedAgentId === args.assignedAgentId);
      if (existing) return existing._id;
    }

    const now = Date.now();
    return await ctx.db.insert('tasks', {
      goalId: args.goalId,
      parentTaskId: args.parentTaskId,
      title: args.title,
      description: args.description,
      status: 'pending',
      priority: args.priority ?? 5,
      assignedAgentId: args.assignedAgentId,
      createdByAgentId: args.createdByAgentId,
      updatedAt: now,
      nextRetryAt: 0,
      retryCount: 0,
      maxRetries: 3,
      context: args.context,
    });
  },
});

/** Atomically claim the highest-priority pending, due task for this agent. */
export const dequeueFor = internalMutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }) => {
    const due = await ctx.db
      .query('tasks')
      .withIndex('by_agent_status_retry', (q) =>
        q.eq('assignedAgentId', agentId).eq('status', 'pending').lte('nextRetryAt', Date.now()))
      .take(50);

    if (due.length === 0) return null;

    const next = due.sort((a, b) => a.priority - b.priority || a._creationTime - b._creationTime)[0];
    const now = Date.now();
    await ctx.db.patch(next._id, { status: 'in_progress', startedAt: now, updatedAt: now });
    return { ...next, status: 'in_progress' as const, startedAt: now };
  },
});

export const complete = internalMutation({
  args: { taskId: v.id('tasks'), result: v.string() },
  handler: async (ctx, { taskId, result }) => {
    await ctx.db.patch(taskId, { status: 'done', result, completedAt: Date.now(), updatedAt: Date.now() });
  },
});

/** True when `error` is a whole-chain LLM capacity/rate-limit exhaustion that
 * retrying on a backoff window cannot fix (every provider 429/402/401'd). */
function isCapacityExhaustion(error: string): boolean {
  if (!error.includes('All LLM providers failed')) return false;
  return /(\b429\b|\b402\b|\b401\b|rate limit|insufficient credits|quota|tokens per day)/i.test(error);
}

/** Fail a task, optionally retry with exponential backoff (2s, 4s, 8s … capped
 * at 5 minutes). `nextRetryAt` is written to the row so ANY agent's dequeue
 * respects the window, not just the one that hit the failure. */
export const fail = internalMutation({
  args: { taskId: v.id('tasks'), error: v.string() },
  handler: async (ctx, { taskId, error }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return;

    const canRetry = task.retryCount < task.maxRetries && !isCapacityExhaustion(error);
    const now = Date.now();
    if (canRetry) {
      const retryDelayMs = Math.min(Math.pow(2, task.retryCount) * 1000, 300_000);
      await ctx.db.patch(taskId, {
        status: 'pending',
        retryCount: task.retryCount + 1,
        errorMessage: error,
        nextRetryAt: now + retryDelayMs,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(taskId, { status: 'failed', errorMessage: error, updatedAt: now });
    }
  },
});

export const block = internalMutation({
  args: { taskId: v.id('tasks'), reason: v.string() },
  handler: async (ctx, { taskId, reason }) => {
    await ctx.db.patch(taskId, { status: 'blocked', errorMessage: reason, updatedAt: Date.now() });
  },
});

export const unblock = internalMutation({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => {
    await ctx.db.patch(taskId, { status: 'pending', errorMessage: undefined, updatedAt: Date.now() });
  },
});

/** Mark a task awaiting human approval for a gated tool call. */
export const awaitApproval = internalMutation({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => {
    await ctx.db.patch(taskId, { status: 'awaiting_approval', updatedAt: Date.now() });
  },
});

/** Resume a task that was blocked/pending-retry, back to the pending queue
 * for a fresh dequeue. NOT used to resume an in-flight iteration loop after
 * an approval/external-job resolves — that must go back to 'in_progress'
 * instead (see markInProgress), since 'pending' would make the SAME agent's
 * own tick loop eligible to dequeue and double-process it concurrently. */
export const resume = internalMutation({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => {
    await ctx.db.patch(taskId, { status: 'pending', updatedAt: Date.now() });
  },
});

/** Transition a task's display status back to 'in_progress' once all of an
 * iteration's pending approvals/external-jobs have resolved and the tool
 * loop is continuing. Deliberately distinct from `resume` (which sets
 * 'pending') — see that function's comment for why. */
export const markInProgress = internalMutation({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => {
    await ctx.db.patch(taskId, { status: 'in_progress', updatedAt: Date.now() });
  },
});

/** How many tasks this agent currently has in flight — the Convex-native
 * replacement for the old in-process `inFlight` Map size check that gated
 * BaseAgent.start()'s top-up loop against its configured concurrency. */
export const countInProgress = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }) => {
    const rows = await ctx.db
      .query('tasks')
      .withIndex('by_agent_status_retry', (q) => q.eq('assignedAgentId', agentId).eq('status', 'in_progress'))
      .collect();
    return rows.length;
  },
});

/** Boot-time recovery: reset any tasks orphaned mid-flight (e.g. by a
 * maintenance-window cutover or a crashed agent chain) back to pending so
 * they get re-picked up. Mirrors the old api-server startup reset. */
export const resetOrphanedInProgress = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orphaned = await ctx.db.query('tasks').collect();
    const inProgress = orphaned.filter((t) => t.status === 'in_progress');
    for (const t of inProgress) {
      await ctx.db.patch(t._id, { status: 'pending', updatedAt: Date.now() });
    }
    return inProgress.length;
  },
});

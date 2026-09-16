import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

// ─── Task Runs ───────────────────────────────────────────────────────────────
//
// Durable step-wise tool-loop state (see plan §3 / agentLoop.ts). Exactly one
// row per task, created on its first iteration and patched (never
// re-inserted) on every subsequent one — NOT an append-only per-iteration log.

const JOIN = v.object({
  toolCallId: v.string(),
  toolName: v.string(),
  args: v.any(),
  kind: v.union(v.literal('approval'), v.literal('externalJob')),
  refId: v.string(),
});

const STATUS = v.union(
  v.literal('running'), v.literal('awaiting_approval'), v.literal('awaiting_external_job'),
  v.literal('done'), v.literal('failed'),
);

export const getByTask = internalQuery({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => {
    return await ctx.db.query('taskRuns').withIndex('by_task', (q) => q.eq('taskId', taskId)).unique();
  },
});

export const upsert = internalMutation({
  args: {
    taskId: v.id('tasks'),
    agentId: v.id('agents'),
    iteration: v.number(),
    history: v.any(),
    status: STATUS,
    pendingJoins: v.optional(v.array(JOIN)),
    partialToolResults: v.optional(v.array(v.any())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query('taskRuns').withIndex('by_task', (q) => q.eq('taskId', args.taskId)).unique();
    const fields = { ...args, updatedAt: Date.now() };
    if (existing) {
      // `replace` (full-document overwrite), not `patch` (shallow merge) —
      // callers that transition out of a pending-joins state must have
      // pendingJoins/partialToolResults actually CLEARED when they omit
      // them, not left stale from a previous iteration. replace guarantees
      // that regardless of patch's undefined-vs-absent-key semantics.
      await ctx.db.replace(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert('taskRuns', fields);
  },
});

/** A retried task (tasks.fail's retry path) must start its next attempt with
 * fresh history — the old in-process model never persisted history across
 * attempts either, so nothing is actually lost by clearing it here. Without
 * this, a re-dequeued retry would find its own stale row and resume mid-old-
 * conversation instead of starting over. */
export const deleteByTask = internalMutation({
  args: { taskId: v.id('tasks') },
  handler: async (ctx, { taskId }) => {
    const existing = await ctx.db.query('taskRuns').withIndex('by_task', (q) => q.eq('taskId', taskId)).unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

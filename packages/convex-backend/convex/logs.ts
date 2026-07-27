import { v } from 'convex/values';
import { query, internalMutation } from './_generated/server';

// ─── Logs ────────────────────────────────────────────────────────────────────
//
// Ports the DB-write half of packages/core/src/memory.ts's AgentLogger.log.
// The console.log-with-emoji and the onLog WebSocket-broadcast callback are
// Node-side/action-layer concerns (M3) — this file is just the persisted
// record, which the dashboard now reads live via `listByAgent`/`listByTask`
// instead of the old WebSocket `log` event.

const LOG_LEVEL = v.union(
  v.literal('debug'), v.literal('info'), v.literal('warn'), v.literal('error'),
  v.literal('thinking'), v.literal('acting'),
);

export const append = internalMutation({
  args: {
    agentId: v.optional(v.id('agents')),
    taskId: v.optional(v.id('tasks')),
    goalId: v.optional(v.id('goals')),
    level: LOG_LEVEL,
    message: v.string(),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('logs', { ...args, timestamp: Date.now() });
  },
});

export const listByAgent = query({
  args: { agentId: v.id('agents'), limit: v.optional(v.number()) },
  handler: async (ctx, { agentId, limit }) => {
    return await ctx.db
      .query('logs')
      .withIndex('by_agent_time', (q) => q.eq('agentId', agentId))
      .order('desc')
      .take(limit ?? 200);
  },
});

export const listByTask = query({
  args: { taskId: v.id('tasks'), limit: v.optional(v.number()) },
  handler: async (ctx, { taskId, limit }) => {
    return await ctx.db
      .query('logs')
      .withIndex('by_task_time', (q) => q.eq('taskId', taskId))
      .order('desc')
      .take(limit ?? 200);
  },
});

/** All-agents recent stream — the dashboard's LogStream panel today reduces
 * a raw WebSocket event feed into "the last N log lines across everyone";
 * this is the direct live-query equivalent. */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db.query('logs').order('desc').take(limit ?? 200);
  },
});

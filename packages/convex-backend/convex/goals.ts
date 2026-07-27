import { v } from 'convex/values';
import { query, internalMutation } from './_generated/server';

// ─── Goals ───────────────────────────────────────────────────────────────────

export const get = query({
  args: { goalId: v.id('goals') },
  handler: async (ctx, { goalId }) => ctx.db.get(goalId),
});

export const list = query({
  args: { status: v.optional(v.union(
    v.literal('active'), v.literal('paused'), v.literal('completed'), v.literal('cancelled'),
  )) },
  handler: async (ctx, { status }) => {
    if (status) {
      return await ctx.db.query('goals').withIndex('by_status', (q) => q.eq('status', status)).collect();
    }
    return await ctx.db.query('goals').collect();
  },
});

export const listByProject = query({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    return await ctx.db.query('goals').withIndex('by_project', (q) => q.eq('projectId', projectId)).collect();
  },
});

export const create = internalMutation({
  args: {
    projectId: v.optional(v.id('projects')),
    title: v.string(),
    description: v.string(),
    priority: v.optional(v.number()),
    assignedAgentId: v.optional(v.id('agents')),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('goals', {
      projectId: args.projectId,
      title: args.title,
      description: args.description,
      status: 'active',
      priority: args.priority ?? 5,
      assignedAgentId: args.assignedAgentId,
    });
  },
});

export const updateStatus = internalMutation({
  args: { goalId: v.id('goals'), status: v.union(
    v.literal('active'), v.literal('paused'), v.literal('completed'), v.literal('cancelled'),
  ) },
  handler: async (ctx, { goalId, status }) => {
    await ctx.db.patch(goalId, { status });
  },
});

export const complete = internalMutation({
  args: { goalId: v.id('goals'), result: v.string() },
  handler: async (ctx, { goalId, result }) => {
    await ctx.db.patch(goalId, { status: 'completed', result, completedAt: Date.now() });
  },
});

import { v } from 'convex/values';
import { query, internalMutation } from './_generated/server';

// ─── Projects (registry) ────────────────────────────────────────────────────

export const get = query({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => ctx.db.get(projectId),
});

export const list = query({
  args: {},
  handler: async (ctx) => ctx.db.query('projects').collect(),
});

/** Idempotent upsert-by-slug — mirrors the old onConflictDoUpdate seeding
 * pattern (e.g. registering 'buildmybot2' as a managed project on boot). */
export const upsertByLegacyId = internalMutation({
  args: {
    legacyId: v.string(),
    name: v.string(),
    repository: v.optional(v.string()),
    purpose: v.string(),
    priority: v.union(v.literal('critical'), v.literal('high'), v.literal('normal'), v.literal('low')),
    status: v.union(v.literal('active'), v.literal('paused'), v.literal('archived')),
    autonomyLevel: v.union(
      v.literal('manual'), v.literal('assisted'), v.literal('supervisor'),
      v.literal('full_autonomous'), v.literal('experimental'),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('projects')
      .withIndex('by_legacyId', (q) => q.eq('legacyId', args.legacyId))
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert('projects', { ...args, updatedAt: now });
  },
});

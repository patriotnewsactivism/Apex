import { v } from 'convex/values';
import { query, mutation, internalQuery, internalMutation } from './_generated/server';

// ─── Agents ──────────────────────────────────────────────────────────────────
//
// `legacyId` is the stable role slug (e.g. 'apex-ceo-001') the old Postgres
// schema used as its primary key — Convex's `_id` is opaque and assigned at
// insert, so seeding/upserting the fixed 13-agent roster by a known constant
// goes through `upsertByLegacyId` instead of relying on `_id` equality.

export const getByLegacyId = internalQuery({
  args: { legacyId: v.string() },
  handler: async (ctx, { legacyId }) => {
    return await ctx.db
      .query('agents')
      .withIndex('by_legacyId', (q) => q.eq('legacyId', legacyId))
      .unique();
  },
});

export const get = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }) => ctx.db.get(agentId),
});

export const list = query({
  args: {},
  handler: async (ctx) => ctx.db.query('agents').collect(),
});

export const listByRole = internalQuery({
  args: { role: v.string() },
  handler: async (ctx, { role }) => {
    return await ctx.db
      .query('agents')
      .withIndex('by_role', (q) => q.eq('role', role))
      .collect();
  },
});

/** Upsert-by-legacyId — used to seed/reconcile the fixed agent roster on boot. */
export const upsertByLegacyId = internalMutation({
  args: {
    legacyId: v.string(),
    name: v.string(),
    role: v.string(),
    tier: v.number(),
    parentLegacyId: v.optional(v.string()),
    systemPrompt: v.string(),
    model: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('agents')
      .withIndex('by_legacyId', (q) => q.eq('legacyId', args.legacyId))
      .unique();

    let parentId;
    if (args.parentLegacyId) {
      const parent = await ctx.db
        .query('agents')
        .withIndex('by_legacyId', (q) => q.eq('legacyId', args.parentLegacyId))
        .unique();
      parentId = parent?._id;
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        role: args.role,
        tier: args.tier,
        parentId,
        systemPrompt: args.systemPrompt,
        model: args.model,
        provider: args.provider,
      });
      return existing._id;
    }

    return await ctx.db.insert('agents', {
      legacyId: args.legacyId,
      name: args.name,
      role: args.role,
      tier: args.tier,
      parentId,
      status: 'idle',
      systemPrompt: args.systemPrompt,
      model: args.model,
      provider: args.provider,
    });
  },
});

export const updateStatus = internalMutation({
  args: { agentId: v.id('agents'), status: v.union(
    v.literal('idle'), v.literal('thinking'), v.literal('acting'),
    v.literal('blocked'), v.literal('done'), v.literal('error'),
  ) },
  handler: async (ctx, { agentId, status }) => {
    await ctx.db.patch(agentId, { status, lastActiveAt: Date.now() });
  },
});

/** Lightweight heartbeat — bumps lastActiveAt only, without asserting a
 * status value. Used by agentLoop's watchdog to detect a chain that died
 * silently (an uncaught error killed it before it could reschedule itself). */
export const touchHeartbeat = internalMutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }) => {
    await ctx.db.patch(agentId, { lastActiveAt: Date.now() });
  },
});

/** All agents whose heartbeat has gone stale — used by the watchdog cron to
 * re-kick a tick chain that died. */
export const listStale = internalQuery({
  args: { staleMs: v.number() },
  handler: async (ctx, { staleMs }) => {
    const cutoff = Date.now() - staleMs;
    const all = await ctx.db.query('agents').collect();
    return all.filter((a) => !a.lastActiveAt || a.lastActiveAt < cutoff);
  },
});

export const patchMetadata = internalMutation({
  args: { agentId: v.id('agents'), metadata: v.any() },
  handler: async (ctx, { agentId, metadata }) => {
    await ctx.db.patch(agentId, { metadata });
  },
});

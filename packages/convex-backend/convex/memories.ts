import { v } from 'convex/values';
import { query, internalMutation, internalQuery } from './_generated/server';

// ─── Memory ──────────────────────────────────────────────────────────────────
//
// Ports the DB side of packages/core/src/memory.ts's MemoryManager. Embedding
// generation is an external LLM call, which only Convex *actions* may make —
// so `upsert`/`recall` here take an already-computed embedding/queryEmbedding
// as a plain argument. The M3 action layer (convex/llm.ts) is responsible for
// calling out to the embeddings API and then calling these as ctx.runMutation
// /ctx.runQuery, mirroring the split MemoryManager.remember()/recall() used to
// do inline. The brute-force cosine-similarity ranking is kept as-is (table
// is small); Convex's native vectorSearch is an optional fast-follow.

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(vecA.length, vecB.length);
  for (let i = 0; i < len; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

const SCOPE = v.union(v.literal('agent'), v.literal('project'), v.literal('global'));

/** Upsert-by-(agentId,key), mirroring the old Drizzle "select then
 * update-or-insert" pattern. */
export const upsert = internalMutation({
  args: {
    agentId: v.id('agents'),
    key: v.string(),
    value: v.string(),
    embedding: v.optional(v.array(v.number())),
    scope: v.optional(SCOPE),
    importance: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const expiresAt = args.ttlMs ? now + args.ttlMs : undefined;

    const existing = await ctx.db
      .query('memories')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .filter((q) => q.eq(q.field('key'), args.key))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.value,
        embedding: args.embedding ?? existing.embedding,
        importance: args.importance ?? existing.importance,
        tags: args.tags ?? existing.tags,
        updatedAt: now,
        expiresAt: expiresAt ?? existing.expiresAt,
      });
      return existing._id;
    }

    return await ctx.db.insert('memories', {
      agentId: args.agentId,
      scope: args.scope ?? 'agent',
      key: args.key,
      value: args.value,
      embedding: args.embedding,
      importance: args.importance ?? 0.5,
      tags: args.tags ?? [],
      updatedAt: now,
      expiresAt,
    });
  },
});

/** Ranked recall given a precomputed query embedding — mirrors the old
 * cosine-similarity * 0.8 + importance * 0.2 scoring, threshold 0.1. */
export const recallByEmbedding = internalQuery({
  args: { agentId: v.id('agents'), queryEmbedding: v.array(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { agentId, queryEmbedding, limit }) => {
    const now = Date.now();
    const own = await ctx.db.query('memories').withIndex('by_agent', (q) => q.eq('agentId', agentId)).collect();
    const shared = await ctx.db.query('memories').collect(); // small table — filtered below
    const candidates = [...own, ...shared.filter((m) => m.scope === 'global' || m.scope === 'project')];

    const seen = new Set<string>();
    const active = candidates.filter((m) => {
      if (seen.has(m._id)) return false;
      seen.add(m._id);
      return !m.expiresAt || m.expiresAt > now;
    });

    const scored = active.map((m) => {
      const similarity = m.embedding ? cosineSimilarity(queryEmbedding, m.embedding) : 0;
      return { memory: m, score: similarity * 0.8 + m.importance * 0.2 };
    });

    return scored
      .filter((s) => s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit ?? 10)
      .map((s) => s.memory);
  },
});

/** Keyword fallback recall (used when embedding generation itself failed). */
export const recallByKeyword = internalQuery({
  args: { agentId: v.id('agents'), keyword: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { agentId, keyword, limit }) => {
    const now = Date.now();
    const rows = await ctx.db.query('memories').withIndex('by_agent', (q) => q.eq('agentId', agentId)).collect();
    const lower = keyword.toLowerCase();
    return rows
      .filter((m) => (!m.expiresAt || m.expiresAt > now) && (m.key.toLowerCase().includes(lower) || m.value.toLowerCase().includes(lower)))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit ?? 10);
  },
});

export const getAll = internalQuery({
  args: { agentId: v.id('agents'), scope: v.optional(SCOPE) },
  handler: async (ctx, { agentId, scope }) => {
    const now = Date.now();
    const rows = await ctx.db.query('memories').withIndex('by_agent', (q) => q.eq('agentId', agentId)).collect();
    return rows
      .filter((m) => (!scope || m.scope === scope) && (!m.expiresAt || m.expiresAt > now))
      .sort((a, b) => b.importance - a.importance);
  },
});

export const forget = internalMutation({
  args: { agentId: v.id('agents'), key: v.string() },
  handler: async (ctx, { agentId, key }) => {
    const existing = await ctx.db
      .query('memories')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .filter((q) => q.eq(q.field('key'), key))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

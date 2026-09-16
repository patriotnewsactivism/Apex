import { v } from 'convex/values';
import { query, internalMutation } from './_generated/server';

// ─── Messages (inter-agent) ──────────────────────────────────────────────────

export const send = internalMutation({
  args: {
    fromAgentId: v.id('agents'),
    toAgentId: v.id('agents'),
    subject: v.string(),
    body: v.string(),
    replyToId: v.optional(v.id('messages')),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('messages', { ...args, read: false });
  },
});

export const inbox = query({
  args: { agentId: v.id('agents'), unreadOnly: v.optional(v.boolean()) },
  handler: async (ctx, { agentId, unreadOnly }) => {
    const rows = await ctx.db.query('messages').withIndex('by_to_agent', (q) => q.eq('toAgentId', agentId)).collect();
    return unreadOnly ? rows.filter((m) => !m.read) : rows;
  },
});

export const sent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }) => {
    return await ctx.db.query('messages').withIndex('by_from_agent', (q) => q.eq('fromAgentId', agentId)).collect();
  },
});

export const markRead = internalMutation({
  args: { messageId: v.id('messages') },
  handler: async (ctx, { messageId }) => {
    await ctx.db.patch(messageId, { read: true });
  },
});

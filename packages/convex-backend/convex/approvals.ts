import { v } from 'convex/values';
import { query, mutation, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';

// ─── Human Approval Gate ─────────────────────────────────────────────────────
//
// Ports the DB side of packages/core/src/base-agent.ts's requestHumanApproval.
// The old busy-wait (`while(Date.now()<deadline) { sleep(1000); check row }`
// inside one long-lived function call) has no Convex equivalent and isn't
// ported — `request` just writes the row and returns; the agent action that
// called it schedules its own resume via a one-shot `ctx.scheduler.runAfter`
// (see convex/agentLoop.ts, M3) instead of polling. `resolve` below is the
// other half: it's a PUBLIC mutation because a human clicks Approve/Reject
// directly from the dashboard, not through an agent action.

export const get = query({
  args: { approvalId: v.id('approvals') },
  handler: async (ctx, { approvalId }) => ctx.db.get(approvalId),
});

export const listPending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('approvals').withIndex('by_status', (q) => q.eq('status', 'pending')).collect();
  },
});

export const request = internalMutation({
  args: {
    taskId: v.id('tasks'),
    toolCallId: v.string(),
    agentId: v.id('agents'),
    toolName: v.string(),
    toolArgs: v.any(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const approvalId = await ctx.db.insert('approvals', { ...args, status: 'pending' });
    await ctx.runMutation(internal.tasks.awaitApproval, { taskId: args.taskId });
    return approvalId;
  },
});

/** Human decision from the dashboard. Wakes the waiting agent immediately —
 * no polling latency, unlike the old 1s-granularity busy-wait. Hands off
 * entirely to agentLoop.resumeToolCall, which decides what happens next
 * (the approved tool might itself need an external-worker round-trip, or
 * there may be other tool calls from the same LLM turn still pending) —
 * this mutation must NOT also touch tasks.* status itself, or it'd race
 * with resumeToolCall's own transition back to 'in_progress'. */
export const resolve = mutation({
  args: { approvalId: v.id('approvals'), decision: v.union(v.literal('approved'), v.literal('rejected')), reviewerNote: v.optional(v.string()) },
  handler: async (ctx, { approvalId, decision, reviewerNote }) => {
    const approval = await ctx.db.get(approvalId);
    if (!approval || approval.status !== 'pending') return;

    await ctx.db.patch(approvalId, { status: decision, reviewedAt: Date.now(), reviewerNote });
    await ctx.scheduler.runAfter(0, internal.agentLoop.resumeToolCall, {
      taskId: approval.taskId,
      toolCallId: approval.toolCallId,
      kind: 'approval',
      approved: decision === 'approved',
    });
  },
});

/** Scheduled once at request time (from agentLoop) for a one-shot timeout,
 * replacing the old 300-iteration sleep-and-check loop. */
export const expireIfStillPending = internalMutation({
  args: { approvalId: v.id('approvals') },
  handler: async (ctx, { approvalId }) => {
    const approval = await ctx.db.get(approvalId);
    if (!approval || approval.status !== 'pending') return;

    await ctx.db.patch(approvalId, { status: 'rejected' });
    await ctx.scheduler.runAfter(0, internal.agentLoop.resumeToolCall, {
      taskId: approval.taskId,
      toolCallId: approval.toolCallId,
      kind: 'approval',
      approved: false,
    });
  },
});

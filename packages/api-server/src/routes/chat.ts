import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db, goals, approvals, logs, agents as agentsTable, voiceChatSessions, voiceChatTurns } from '@workspace/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createLLMClient, getDefaultLLMConfig, getLLMCapacityResumeAt, isLLMIntentionalPause } from '@workspace/core';
import type { LLMMessage, LLMTool, LLMToolCall } from '@workspace/core';
import type { ApexCEO } from '@workspace/agents';

// ─── Don's Chat: a real conversation with Apex, not a ticket window ─────
//
// The old QuickChat behavior treated every message typed here as a work
// order: it always called POST /api/goals and echoed a canned "Got it,
// deployed as goal ..." line, no matter what was actually typed. That's why
// it felt like it "only takes orders" — because that's literally all it
// did. There was no LLM in the loop for this surface at all.
//
// This route puts a real LLM turn (same multi-provider chain the swarm
// itself runs on) between what Don types and what comes back, gives it a
// live snapshot of the swarm's actual state, and gives it a small toolset so
// it can look things up instead of guessing. create_goal is the only
// write it can do — everything else is read-only. It decides for itself
// whether a message is a question (answer it) or an order (deploy it).

const chatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const chatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(chatTurnSchema).max(30).optional().default([]),
  // The Apex screen Don is currently viewing, so "this", "that graph", "the
  // thing on my screen" resolve against what he is actually looking at.
  page: z.string().max(120).optional(),
});

export const CHAT_SYSTEM_PROMPT = `You are Apex, talking directly with Don — the founder who built you and the whole
portfolio you run operations for. This is his Chat window: a real conversation, not a command line.

You are a capable agent in your own right, not a dispatcher. Handle things yourself whenever you can:

- Answer like a sharp, well-informed chief of staff who actually knows what's going on, not a status bot.
  Give detailed, specific, conversational answers. Reference real numbers, agent names, and goal titles from
  the live snapshot below — never a vague "things are going well."
- Handle it yourself first. Questions, status checks, thinking out loud, "what's your read on X", quick
  lookups, explanations, judgments, drafting, planning, anything that fits in a conversation — answer it
  directly and completely, right here. Use get_pending_approvals / get_recent_goals / get_recent_activity
  to pull real current detail instead of guessing or repeating only what's in the snapshot below.
  Do NOT create a goal for a question. Delegating something you could have answered yourself is a failure.
- Reserve the swarm for genuinely complex work. Only call create_goal when Don is handing you work that is
  truly multi-step, long-running, or needs specialist agents (real code changes, investigations across
  repos, anything that outlives this conversation). If a request is simple enough that you can just DO it
  in this reply, do it. If you're on the fence, say what you'd do, do the part you can do now, and ask
  whether he wants it deployed to the swarm as a goal.
- When you do deploy a goal, tell him what you deployed and why, in your own words.
- If there's a backlog of pending approvals or escalations, proactively mention it when relevant — Don has said
  he loses track of when these back up, so don't make him ask.
- Be honest about uncertainty. If you don't actually know something, say so and offer to look it up rather than
  inventing a plausible-sounding answer.
- Keep replies conversational length — a few sentences to a few short paragraphs, not a wall of bullet points,
  unless he's asked for a list.`;

export const CHAT_TOOLS: LLMTool[] = [
  {
    name: 'create_goal',
    description:
      'Deploy a new work order to the Apex agent swarm. Only call this when Don is clearly instructing action to be taken — never for a question or a status check.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short (<80 char) title for the goal.' },
        description: { type: 'string', description: 'Full description of what should be done.' },
        priority: { type: 'number', description: '1 (most urgent) to 10 (least). Default 5.' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'get_pending_approvals',
    description:
      "Get the real current count and detail of pending approvals (agents genuinely blocked waiting on a decision) and escalations (an agent flagged something for Don's attention but kept working).",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_recent_goals',
    description: 'List the most recent goals/work orders and their current status.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max rows, default 10, max 25.' } },
    },
  },
  {
    name: 'get_recent_activity',
    description:
      'Get the most recent warning/error-level log lines across the whole swarm, to explain what has actually been happening operationally.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max rows, default 15, max 40.' } },
    },
  },
  {
    name: 'approve_pending_approval',
    description:
      'Approve a pending gated approval (an agent is genuinely BLOCKED waiting on this — e.g. runShell, deploy_to_environment, create_pull_request). Only call this when Don has clearly said yes/approve/go ahead for a SPECIFIC approval you already told him about via get_pending_approvals.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The approval id from get_pending_approvals.' },
        note: { type: 'string', description: 'Optional short note on why it was approved.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'reject_pending_approval',
    description:
      'Reject a pending gated approval. Only call this when Don has clearly said no/reject/deny for a SPECIFIC approval you already told him about via get_pending_approvals.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The approval id from get_pending_approvals.' },
        note: { type: 'string', description: 'Optional short note on why it was rejected.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'acknowledge_escalation',
    description:
      "Acknowledge/clear a pending escalation (an FYI ask — nothing is blocked, an agent just flagged something). Use this once Don has heard about it and doesn't need it left in the queue.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The escalation id from get_pending_approvals.' },
        note: { type: 'string', description: 'Optional short note.' },
      },
      required: ['id'],
    },
  },
];

export async function buildLiveSnapshot(): Promise<string> {
  const [approvalRows, escalationRows, activeGoalRows, agentRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), eq(approvals.kind, 'approval'))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), eq(approvals.kind, 'escalation'))),
    db.select().from(goals).where(eq(goals.status, 'active')).orderBy(desc(goals.createdAt)).limit(5),
    db.select().from(agentsTable),
  ]);

  const pendingApprovals = approvalRows[0]?.count ?? 0;
  const pendingEscalations = escalationRows[0]?.count ?? 0;
  const workingAgents = agentRows.filter((a) => a.status === 'thinking' || a.status === 'acting');

  const lines = [
    `Pending gated approvals (agents blocked, need a decision): ${pendingApprovals}`,
    `Pending escalations (FYI asks, nothing blocked): ${pendingEscalations}`,
    `Agents currently working: ${workingAgents.length}/${agentRows.length}${
      workingAgents.length ? ' — ' + workingAgents.map((a) => `${a.name} (${a.role})`).join(', ') : ''
    }`,
    `Active goals (${activeGoalRows.length} shown, most recent first):`,
    ...activeGoalRows.map((g) => `  - [P${g.priority}] ${g.title}`),
  ];
  if (activeGoalRows.length === 0) lines.push('  (none active right now)');
  return lines.join('\n');
}

export async function executeTool(
  call: { name: string; args: Record<string, unknown> },
  ceo: ApexCEO,
): Promise<Record<string, unknown>> {
  switch (call.name) {
    case 'create_goal': {
      const title = String(call.args.title ?? '').slice(0, 200);
      const description = String(call.args.description ?? '');
      const priority = Number(call.args.priority ?? 5);
      if (!title || description.length < 5) {
        return { error: 'title and description are required' };
      }
      const goalId = await ceo.submitGoal(
        title,
        description,
        Number.isFinite(priority) ? Math.min(10, Math.max(1, Math.floor(priority))) : 5,
      );
      return { goalId, title, deployed: true };
    }
    case 'get_pending_approvals': {
      const rows = await db
        .select()
        .from(approvals)
        .where(eq(approvals.status, 'pending'))
        .orderBy(desc(approvals.createdAt))
        .limit(30);
      return {
        approvals: rows
          .filter((r) => r.kind === 'approval')
          .map((r) => ({ id: r.id, toolName: r.toolName, reason: r.reason, createdAt: r.createdAt })),
        escalations: rows
          .filter((r) => r.kind === 'escalation')
          .map((r) => ({ id: r.id, reason: r.reason, occurrences: r.occurrences, createdAt: r.createdAt })),
      };
    }
    case 'get_recent_goals': {
      const limit = Math.min(25, Math.max(1, Number(call.args.limit ?? 10)));
      const rows = await db.select().from(goals).orderBy(desc(goals.createdAt)).limit(limit);
      return {
        goals: rows.map((g) => ({
          id: g.id,
          title: g.title,
          status: g.status,
          priority: g.priority,
          createdAt: g.createdAt,
          result: g.result?.slice(0, 300),
        })),
      };
    }
    case 'get_recent_activity': {
      const limit = Math.min(40, Math.max(1, Number(call.args.limit ?? 15)));
      const rows = await db
        .select()
        .from(logs)
        .where(sql`${logs.level} in ('warn', 'error')`)
        .orderBy(desc(logs.timestamp))
        .limit(limit);
      return {
        activity: rows.map((l) => ({
          level: l.level,
          message: l.message,
          agentId: l.agentId,
          timestamp: l.timestamp,
        })),
      };
    }
    case 'approve_pending_approval': {
      const id = String(call.args.id ?? '');
      const note = call.args.note ? String(call.args.note) : undefined;
      const [resolved] = await db.update(approvals)
        .set({ status: 'approved', reviewedAt: new Date(), reviewerNote: note })
        .where(and(eq(approvals.id, id), eq(approvals.kind, 'approval'), eq(approvals.status, 'pending')))
        .returning({ id: approvals.id });
      if (!resolved) return { error: 'That approval is not pending (already resolved, or wrong id).' };
      return { approved: true, id };
    }
    case 'reject_pending_approval': {
      const id = String(call.args.id ?? '');
      const note = call.args.note ? String(call.args.note) : undefined;
      const [resolved] = await db.update(approvals)
        .set({ status: 'rejected', reviewedAt: new Date(), reviewerNote: note })
        .where(and(eq(approvals.id, id), eq(approvals.kind, 'approval'), eq(approvals.status, 'pending')))
        .returning({ id: approvals.id });
      if (!resolved) return { error: 'That approval is not pending (already resolved, or wrong id).' };
      return { rejected: true, id };
    }
    case 'acknowledge_escalation': {
      const id = String(call.args.id ?? '');
      const note = call.args.note ? String(call.args.note) : undefined;
      const [resolved] = await db.update(approvals)
        .set({ status: 'acknowledged', reviewedAt: new Date(), reviewerNote: note })
        .where(and(eq(approvals.id, id), eq(approvals.kind, 'escalation'), eq(approvals.status, 'pending')))
        .returning({ id: approvals.id });
      if (!resolved) return { error: 'That escalation is not pending (already resolved, or wrong id).' };
      return { acknowledged: true, id };
    }
    default:
      return { error: `Unknown tool: ${call.name}` };
  }
}

export function createChatRouter(ceo: ApexCEO) {
  const router = Router();
  const llm = createLLMClient(getDefaultLLMConfig('CEO'));

  router.post('/message', async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { message, history, page } = parsed.data;

    try {
      const snapshot = await buildLiveSnapshot();
      const screenContext = page
        ? `\n\nDon's current screen: the "${page}" page. When he says "this", "that", or "it", he usually means something on that screen.\n`
        : '';
      const llmHistory: LLMMessage[] = [
        { role: 'system', content: `${CHAT_SYSTEM_PROMPT}${screenContext}\n\nCurrent live snapshot:\n${snapshot}` },
        ...history.map((h): LLMMessage => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
      ];

      let goalCreated: { id: string; title: string } | undefined;
      const MAX_TURNS = 5;
      // Stable only for this HTTP conversation/tool loop. Gemini uses it to
      // preserve native Interactions state across local tool execution without
      // leaking one user's chat state into the next request.
      const conversationId = `chat-${randomUUID()}`;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // interactive: true — Don is synchronously waiting on this reply, so
        // it skips the 24h smoothing ramp that exists to stop an unattended
        // background agent from front-loading a day's budget. It still can't
        // spend past the hard daily caps or the per-minute provider rate
        // limit; see LLMExecutionContext.interactive.
        const response = await llm.complete(llmHistory, CHAT_TOOLS, {
          role: 'CEO',
          interactive: true,
          conversationId,
        });
        llmHistory.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

        if (response.toolCalls.length === 0) {
          return res.json({
            reply: response.content || "I don't have anything more to add on that.",
            goalCreated,
          });
        }

        for (const call of response.toolCalls) {
          let result: Record<string, unknown>;
          try {
            result = await executeTool(call, ceo);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
          if (call.name === 'create_goal' && result.goalId) {
            goalCreated = { id: String(result.goalId), title: String(result.title ?? call.args.title ?? '') };
          }
          llmHistory.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(result),
          });
        }
      }

      return res.json({
        reply: 'That took a few lookups — deploying it as a goal so the swarm can dig in properly.',
        goalCreated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A genuine capacity pause here means the interactive bypass above still
      // wasn't enough — the HARD daily cap (not just pacing) is actually
      // reached, or every provider is otherwise unavailable. That is a normal,
      // expected state, not a server bug, so it gets a conversational reply
      // instead of the raw internal message string reaching Don's chat window.
      if (isLLMIntentionalPause(message)) {
        const resumeAt = getLLMCapacityResumeAt(message);
        const resumeClock = resumeAt
          ? resumeAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })
          : null;
        return res.json({
          reply: resumeClock
            ? `I'm out of today's LLM budget for the moment — it resumes around ${resumeClock}. Try me again after that, or ask something smaller I can still answer from what I already know.`
            : `I'm out of today's LLM budget for the moment. Try me again shortly.`,
        });
      }
      console.error('[chat] POST /message error:', err);
      return res.status(500).json({ error: message });
    }
  });

  // ── GET /voice-sessions — durable history of live browser voice calls ────
  //
  // Everything a live-voice call (live-voice.ts) actually said, as real rows
  // instead of only living in QuickChat's React state until the tab closes.
  // Session rows exist even for a call that never connected (written before
  // Deepgram is contacted — see live-voice.ts), so a run of failed attempts
  // is visible here too, not just successful ones.
  router.get('/voice-sessions', async (req, res) => {
    try {
      const limitParam = Number(req.query.limit);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;

      const sessions = await db
        .select()
        .from(voiceChatSessions)
        .orderBy(desc(voiceChatSessions.startedAt))
        .limit(limit);

      if (sessions.length === 0) {
        return res.json({ sessions: [] });
      }

      const sessionIds = sessions.map((s) => s.id);
      const turns = await db
        .select()
        .from(voiceChatTurns)
        .where(inArray(voiceChatTurns.sessionId, sessionIds))
        .orderBy(voiceChatTurns.createdAt);

      const turnsBySession = new Map<string, typeof turns>();
      for (const turn of turns) {
        const existing = turnsBySession.get(turn.sessionId);
        if (existing) existing.push(turn);
        else turnsBySession.set(turn.sessionId, [turn]);
      }

      return res.json({
        sessions: sessions.map((s) => ({ ...s, turns: turnsBySession.get(s.id) ?? [] })),
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

import { Router } from 'express';
import { z } from 'zod';
import { db, goals, approvals, logs, agents as agentsTable } from '@workspace/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createLLMClient, getDefaultLLMConfig } from '@workspace/core';
import type { LLMMessage, LLMTool, LLMToolCall } from '@workspace/core';
import type { ApexCEO } from '@workspace/agents';

// ─── Don's Quick Chat: a real conversation with Apex, not a ticket window ─────
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
});

const CHAT_SYSTEM_PROMPT = `You are Apex, talking directly with Don — the founder who built you and the whole
portfolio you run operations for. This is his Quick Chat window: a real conversation, not a command line.

How to behave:
- Answer like a sharp, well-informed chief of staff who actually knows what's going on, not a status bot.
  Give detailed, specific, conversational answers. Reference real numbers, agent names, and goal titles from
  the live snapshot below — never a vague "things are going well."
- If Don is genuinely handing you a new work order or instruction to act on, call create_goal to deploy it to
  the swarm, then tell him what you deployed and why, in your own words.
- If he's asking a question, checking status, thinking out loud, or wants your read on something — just answer.
  Do NOT create a goal for a question. Use get_pending_approvals / get_recent_goals / get_recent_activity to pull
  real current detail instead of guessing or repeating only what's in the snapshot below.
- If there's a backlog of pending approvals or escalations, proactively mention it when relevant — Don has said
  he loses track of when these back up, so don't make him ask.
- Be honest about uncertainty. If you don't actually know something, say so and offer to look it up rather than
  inventing a plausible-sounding answer.
- Keep replies conversational length — a few sentences to a few short paragraphs, not a wall of bullet points,
  unless he's asked for a list.`;

const CHAT_TOOLS: LLMTool[] = [
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
];

async function buildLiveSnapshot(): Promise<string> {
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

async function executeTool(call: LLMToolCall, ceo: ApexCEO): Promise<Record<string, unknown>> {
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
    const { message, history } = parsed.data;

    try {
      const snapshot = await buildLiveSnapshot();
      const llmHistory: LLMMessage[] = [
        { role: 'system', content: `${CHAT_SYSTEM_PROMPT}\n\nCurrent live snapshot:\n${snapshot}` },
        ...history.map((h): LLMMessage => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
      ];

      let goalCreated: { id: string; title: string } | undefined;
      const MAX_TURNS = 5;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await llm.complete(llmHistory, CHAT_TOOLS);
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
      console.error('[chat] POST /message error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

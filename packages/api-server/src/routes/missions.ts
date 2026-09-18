// Mission management API. Missions are APEX goals with missionType='revenue_ops'
// in goal.result (D1) — there is no separate missions table.

import { Router } from 'express';
import { db, goals, tasks, approvals } from '@workspace/db';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

const CreateMissionSchema = z.object({
  objective: z.string().min(10).max(500),
  targetDefinition: z.record(z.unknown()),
  qualificationRules: z.record(z.unknown()),
  allowedChannels: z.array(z.enum(['call', 'email', 'sms'])).min(1),
  policy: z.object({
    budgetCents: z.number().int().positive(),
    approveBeforePivot: z.boolean(),
    firstTouchOptIn: z.enum(['manual', 'auto_with_warn']),
    requireApprovalForNewCampaigns: z.boolean().optional(),
    requireApprovalForOfferChange: z.boolean().optional(),
  }),
  deadlineAt: z.string().datetime().optional(),
  title: z.string().min(5).max(200).optional(),
  projectId: z.string().optional(),
  assignedAgentId: z.string().optional(),
});

type MissionPayload = {
  missionStatus: string;
  objective: string;
  targetDefinition: Record<string, unknown>;
  qualificationRules: Record<string, unknown>;
  allowedChannels: string[];
  policy: Record<string, unknown>;
  budgetCents: number;
  spentCents: number;
  deadlineAt?: string;
  startedAt?: string;
  updatedAt?: string;
  channels: string[];
  approveBeforePivot: boolean;
  firstTouchOptIn: string;
  missionType: string;
  cancelledReason?: string;
};

function deriveEffectiveStatus(goalStatus: string, missionStatus: string): string {
  if (goalStatus === 'cancelled') return 'cancelled';
  if (goalStatus === 'completed') return 'completed';
  if (goalStatus === 'paused') return 'paused';
  return missionStatus || 'unknown';
}

function parseMissionPayload(result: string | null): MissionPayload {
  let parsed: Record<string, unknown> = {};
  if (result) {
    try {
      parsed = JSON.parse(result) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const policy = (parsed.policy as Record<string, unknown> | undefined) ?? {};
  return {
    missionStatus: typeof parsed.missionStatus === 'string' ? parsed.missionStatus : 'unknown',
    objective: typeof parsed.objective === 'string' ? parsed.objective : '',
    targetDefinition: (parsed.targetDefinition as Record<string, unknown> | undefined) ?? {},
    qualificationRules: (parsed.qualificationRules as Record<string, unknown> | undefined) ?? {},
    allowedChannels: Array.isArray(parsed.allowedChannels) ? parsed.allowedChannels as string[] : [],
    policy,
    budgetCents: Number(policy.budgetCents ?? parsed.budgetCents ?? 0),
    spentCents: Number(parsed.spentCents ?? 0),
    deadlineAt: typeof parsed.deadlineAt === 'string' ? parsed.deadlineAt : undefined,
    startedAt: typeof parsed.startsAt === 'string' ? parsed.startsAt : undefined,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    channels: Array.isArray(parsed.channels) ? parsed.channels as string[] : [],
    approveBeforePivot: Boolean(parsed.approveBeforePivot ?? false),
    firstTouchOptIn: typeof parsed.firstTouchOptIn === 'string' ? parsed.firstTouchOptIn : 'manual',
    missionType: typeof parsed.missionType === 'string' ? parsed.missionType : '',
    cancelledReason: typeof parsed.cancelledReason === 'string' ? parsed.cancelledReason : undefined,
  };
}

function missionFilter() {
  return sql`${goals.result}::text LIKE ${'%missionType":"revenue_ops"%'}`;
}

function routeParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return undefined;
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function withUpdatedAt(payload: MissionPayload): MissionPayload {
  return { ...payload, updatedAt: new Date().toISOString() };
}

export function createMissionsRouter(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    try {
      const parsed = CreateMissionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid request',
          details: parsed.error.flatten(),
        });
      }

      const args = parsed.data;
      const missionId = randomUUID();
      const now = new Date().toISOString();

      const missionPayload: MissionPayload = {
        objective: args.objective,
        targetDefinition: args.targetDefinition,
        qualificationRules: args.qualificationRules,
        allowedChannels: args.allowedChannels,
        policy: {
          budgetCents: args.policy.budgetCents,
          approveBeforePivot: args.policy.approveBeforePivot,
          firstTouchOptIn: args.policy.firstTouchOptIn,
          requireApprovalForNewCampaigns: args.policy.requireApprovalForNewCampaigns ?? false,
          requireApprovalForOfferChange: args.policy.requireApprovalForOfferChange ?? false,
        },
        budgetCents: args.policy.budgetCents,
        spentCents: 0,
        startedAt: now,
        deadlineAt: args.deadlineAt,
        updatedAt: now,
        missionStatus: 'draft',
        channels: args.allowedChannels,
        approveBeforePivot: args.policy.approveBeforePivot,
        firstTouchOptIn: args.policy.firstTouchOptIn,
        missionType: 'revenue_ops',
      };

      const title = args.title || `Revenue Ops Mission: ${args.objective.slice(0, 60)}`;

      await db.insert(goals).values({
        id: missionId,
        title,
        description: args.objective,
        status: 'active',
        priority: 5,
        projectId: args.projectId,
        assignedAgentId: args.assignedAgentId,
        result: JSON.stringify(missionPayload),
        createdAt: new Date(),
      });

      return res.status(201).json({
        missionId,
        status: 'draft',
        title,
        objective: args.objective,
        budgetCents: args.policy.budgetCents,
        deadlineAt: args.deadlineAt,
        message: 'Mission created in draft status.',
      });
    } catch (err) {
      console.error('POST /api/missions error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    try {
      const { status, projectId, limit = '50', offset = '0' } = req.query;

      const limitNum = Math.min(Math.max(1, parseInt(String(limit), 10) || 50), 200);
      const offsetNum = Math.max(0, parseInt(String(offset), 10) || 0);

      const conditions = [missionFilter()];

      if (status && typeof status === 'string') {
        if ([
          'draft', 'validating', 'ready', 'running', 'waiting_approval',
          'paused', 'blocked', 'budget_exhausted', 'completed', 'cancelled', 'failed',
        ].includes(status)) {
          conditions.push(sql`${goals.result}::text LIKE ${`%missionStatus":"${status}"%`}`);
        }
      }

      if (projectId && typeof projectId === 'string') {
        conditions.push(eq(goals.projectId, projectId));
      }

      const whereClause = and(...conditions);

      const missions = await db
        .select()
        .from(goals)
        .where(whereClause)
        .orderBy(desc(goals.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const totalResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(goals)
        .where(whereClause);

      const total = Number(totalResult[0]?.count ?? 0);

      const enriched = missions.map((m) => {
        const payload = parseMissionPayload(m.result);
        return {
          missionId: m.id,
          title: m.title,
          description: m.description,
          goalStatus: m.status,
          missionStatus: payload.missionStatus,
          effectiveStatus: deriveEffectiveStatus(m.status, payload.missionStatus),
          objective: payload.objective,
          budgetCents: payload.budgetCents,
          spentCents: payload.spentCents,
          remainingCents: Math.max(0, payload.budgetCents - payload.spentCents),
          allowedChannels: payload.allowedChannels,
          deadlineAt: payload.deadlineAt,
          projectId: m.projectId,
          assignedAgentId: m.assignedAgentId,
          createdAt: iso(m.createdAt),
          updatedAt: payload.updatedAt ?? iso(m.createdAt),
          completedAt: iso(m.completedAt),
        };
      });

      return res.json({
        missions: enriched,
        total,
        limit: limitNum,
        offset: offsetNum,
      });
    } catch (err) {
      console.error('GET /api/missions error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const missions = await db
        .select()
        .from(goals)
        .where(missionFilter());

      const stats = {
        total: missions.length,
        byStatus: {
          draft: 0,
          validating: 0,
          ready: 0,
          running: 0,
          waiting_approval: 0,
          paused: 0,
          blocked: 0,
          budget_exhausted: 0,
          completed: 0,
          cancelled: 0,
          failed: 0,
        } as Record<string, number>,
        totalBudgetCents: 0,
        totalSpentCents: 0,
        activeMissions: 0,
      };

      for (const m of missions) {
        const payload = parseMissionPayload(m.result);
        const status = payload.missionStatus;
        if (stats.byStatus[status] !== undefined) {
          stats.byStatus[status]++;
        }
        stats.totalBudgetCents += payload.budgetCents;
        stats.totalSpentCents += payload.spentCents;
        if (['running', 'ready', 'validating', 'paused', 'waiting_approval', 'blocked', 'budget_exhausted'].includes(status)) {
          stats.activeMissions++;
        }
      }

      return res.json(stats);
    } catch (err) {
      console.error('GET /api/missions/stats error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.get('/:missionId', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.missionId);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });

      const [mission] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, missionId))
        .limit(1);

      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      const payload = parseMissionPayload(mission.result);

      const missionTasks = await db
        .select()
        .from(tasks)
        .where(eq(tasks.goalId, missionId))
        .orderBy(desc(tasks.createdAt));

      const activeTasks = missionTasks.filter((t) =>
        ['pending', 'in_progress', 'blocked', 'awaiting_approval'].includes(t.status),
      );
      const completedTasks = missionTasks.filter((t) =>
        ['done', 'failed', 'cancelled'].includes(t.status),
      );

      const taskIds = missionTasks.map((t) => t.id);
      const missionApprovals = taskIds.length === 0
        ? []
        : await db
          .select()
          .from(approvals)
          .where(and(
            eq(approvals.kind, 'approval'),
            eq(approvals.status, 'pending'),
            inArray(approvals.taskId, taskIds),
          ))
          .orderBy(desc(approvals.createdAt));

      return res.json({
        missionId: mission.id,
        title: mission.title,
        description: mission.description,
        goalStatus: mission.status,
        missionStatus: payload.missionStatus,
        effectiveStatus: deriveEffectiveStatus(mission.status, payload.missionStatus),
        objective: payload.objective,
        targetDefinition: payload.targetDefinition,
        qualificationRules: payload.qualificationRules,
        allowedChannels: payload.allowedChannels,
        policy: payload.policy,
        budgetCents: payload.budgetCents,
        spentCents: payload.spentCents,
        remainingCents: Math.max(0, payload.budgetCents - payload.spentCents),
        deadlineAt: payload.deadlineAt,
        startedAt: payload.startedAt,
        channels: payload.channels,
        approveBeforePivot: payload.approveBeforePivot,
        firstTouchOptIn: payload.firstTouchOptIn,
        projectId: mission.projectId,
        assignedAgentId: mission.assignedAgentId,
        createdAt: iso(mission.createdAt),
        updatedAt: payload.updatedAt ?? iso(mission.createdAt),
        completedAt: iso(mission.completedAt),
        activeTasks: activeTasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          assignedAgentId: t.assignedAgentId,
          context: t.context,
          createdAt: iso(t.createdAt),
          updatedAt: iso(t.updatedAt),
        })),
        completedTasks: completedTasks.length,
        totalTasks: missionTasks.length,
        pendingApprovals: missionApprovals.map((a) => ({
          id: a.id,
          reason: a.reason,
          status: a.status,
          toolName: a.toolName,
          createdAt: iso(a.createdAt),
        })),
      });
    } catch (err) {
      console.error('GET /api/missions/:missionId error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.patch('/:missionId', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.missionId);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });
      const updates = (req.body ?? {}) as {
        title?: string;
        deadlineAt?: string;
        budgetCents?: number;
        allowedChannels?: string[];
      };

      const [mission] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, missionId))
        .limit(1);

      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      const payload = parseMissionPayload(mission.result);
      const resultUpdates: Partial<MissionPayload> = {};

      if (updates.deadlineAt !== undefined) {
        resultUpdates.deadlineAt = updates.deadlineAt;
      }
      if (updates.budgetCents !== undefined) {
        if (updates.budgetCents < payload.spentCents) {
          return res.status(400).json({
            error: 'Budget cannot be reduced below spent amount',
          });
        }
        resultUpdates.policy = { ...payload.policy, budgetCents: updates.budgetCents };
        resultUpdates.budgetCents = updates.budgetCents;
      }
      if (updates.allowedChannels !== undefined) {
        resultUpdates.allowedChannels = updates.allowedChannels;
        resultUpdates.channels = updates.allowedChannels;
      }

      const newResult = withUpdatedAt({
        ...payload,
        ...resultUpdates,
        missionType: 'revenue_ops',
      });

      await db.update(goals).set({
        ...(typeof updates.title === 'string' ? { title: updates.title } : {}),
        result: JSON.stringify(newResult),
      }).where(eq(goals.id, missionId));

      return res.json({
        missionId,
        message: 'Mission updated successfully.',
        updated: {
          title: updates.title,
          deadlineAt: resultUpdates.deadlineAt,
          budgetCents: resultUpdates.budgetCents,
          allowedChannels: resultUpdates.allowedChannels,
        },
      });
    } catch (err) {
      console.error('PATCH /api/missions/:missionId error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.post('/:missionId/submit', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.missionId);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

      const [mission] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, missionId))
        .limit(1);

      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      const payload = parseMissionPayload(mission.result);
      if (payload.missionStatus !== 'draft') {
        return res.status(400).json({
          error: `Mission is not in draft status (current: ${payload.missionStatus}). Only draft missions can be submitted.`,
        });
      }

      const updatedPayload = withUpdatedAt({ ...payload, missionStatus: 'validating' });
      await db.update(goals).set({
        result: JSON.stringify(updatedPayload),
      }).where(eq(goals.id, missionId));

      const taskId = randomUUID();
      await db.insert(tasks).values({
        id: taskId,
        goalId: missionId,
        title: 'Submit mission for validation',
        description: reason || `Validate mission: ${mission.title}`,
        status: 'awaiting_approval',
        assignedAgentId: mission.assignedAgentId,
        createdByAgentId: 'system',
      });

      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        taskId,
        agentId: mission.assignedAgentId || 'system',
        toolName: 'submit_mission_for_validation',
        toolArgs: { missionId },
        reason: reason || `Mission validation request: ${mission.title}`,
        status: 'pending',
        kind: 'approval',
      });

      return res.status(201).json({
        missionId,
        status: 'validating',
        approvalId,
        message: 'Mission submitted for validation. Awaiting approval.',
      });
    } catch (err) {
      console.error('POST /api/missions/:missionId/submit error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.post('/:missionId/pause', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.missionId);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

      const [mission] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, missionId))
        .limit(1);

      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      const payload = parseMissionPayload(mission.result);
      if (payload.missionStatus !== 'running') {
        return res.status(400).json({
          error: `Mission is not running (current: ${payload.missionStatus}). Only running missions can be paused.`,
        });
      }

      const updatedPayload = withUpdatedAt({ ...payload, missionStatus: 'paused' });
      await db.update(goals).set({
        status: 'paused',
        result: JSON.stringify(updatedPayload),
      }).where(eq(goals.id, missionId));

      await db.update(tasks).set({
        status: 'blocked',
        updatedAt: new Date(),
      }).where(and(
        eq(tasks.goalId, missionId),
        inArray(tasks.status, ['in_progress', 'pending']),
      ));

      return res.json({
        missionId,
        status: 'paused',
        pausedAt: new Date().toISOString(),
        reason,
        message: 'Mission paused.',
      });
    } catch (err) {
      console.error('POST /api/missions/:missionId/pause error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.post('/:missionId/resume', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.missionId);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

      const [mission] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, missionId))
        .limit(1);

      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      const payload = parseMissionPayload(mission.result);
      if (payload.missionStatus !== 'paused') {
        return res.status(400).json({
          error: `Mission is not paused (current: ${payload.missionStatus}). Only paused missions can be resumed.`,
        });
      }

      const updatedPayload = withUpdatedAt({ ...payload, missionStatus: 'running' });
      await db.update(goals).set({
        status: 'active',
        result: JSON.stringify(updatedPayload),
      }).where(eq(goals.id, missionId));

      await db.update(tasks).set({
        status: 'pending',
        updatedAt: new Date(),
      }).where(and(
        eq(tasks.goalId, missionId),
        eq(tasks.status, 'blocked'),
      ));

      return res.json({
        missionId,
        status: 'running',
        resumedAt: new Date().toISOString(),
        reason,
        message: 'Mission resumed.',
      });
    } catch (err) {
      console.error('POST /api/missions/:missionId/resume error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.post('/:missionId/cancel', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.missionId);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';

      if (reason.length < 10) {
        return res.status(400).json({
          error: 'Cancellation reason must be at least 10 characters.',
        });
      }

      const [mission] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, missionId))
        .limit(1);

      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      const payload = parseMissionPayload(mission.result);
      const updatedPayload = withUpdatedAt({
        ...payload,
        missionStatus: 'cancelled',
        cancelledReason: reason,
      });
      await db.update(goals).set({
        status: 'cancelled',
        result: JSON.stringify(updatedPayload),
        completedAt: new Date(),
      }).where(eq(goals.id, missionId));

      await db.update(tasks).set({
        status: 'cancelled',
        result: `Mission cancelled: ${reason}`,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(tasks.goalId, missionId),
        inArray(tasks.status, ['pending', 'in_progress', 'blocked', 'awaiting_approval']),
      ));

      return res.json({
        missionId,
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        reason,
        message: 'Mission cancelled.',
      });
    } catch (err) {
      console.error('POST /api/missions/:missionId/cancel error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.post('/:missionId/budget-exhaust', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.missionId);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });
      const spentCents = req.body?.spentCents;

      if (spentCents === undefined || typeof spentCents !== 'number') {
        return res.status(400).json({
          error: 'spentCents is required and must be a number.',
        });
      }

      const [mission] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, missionId))
        .limit(1);

      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      const payload = parseMissionPayload(mission.result);
      if (spentCents < payload.budgetCents) {
        return res.status(400).json({
          error: `Cannot exhaust budget: spentCents (${spentCents}) < budgetCents (${payload.budgetCents}).`,
        });
      }
      if (payload.missionStatus !== 'running') {
        return res.status(400).json({
          error: `Mission is not running (current: ${payload.missionStatus}). Only running missions can become budget_exhausted.`,
        });
      }

      const updatedPayload = withUpdatedAt({ ...payload, missionStatus: 'budget_exhausted', spentCents });
      await db.update(goals).set({
        result: JSON.stringify(updatedPayload),
      }).where(eq(goals.id, missionId));

      await db.update(tasks).set({
        status: 'blocked',
        errorMessage: 'Mission budget exhausted',
        updatedAt: new Date(),
      }).where(and(
        eq(tasks.goalId, missionId),
        eq(tasks.status, 'pending'),
      ));

      return res.json({
        missionId,
        status: 'budget_exhausted',
        spentCents,
        budgetCents: payload.budgetCents,
        exhaustedAt: new Date().toISOString(),
        message: 'Mission budget exhausted.',
      });
    } catch (err) {
      console.error('POST /api/missions/:missionId/budget-exhaust error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  router.post('/:missionId/budget-increase', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.missionId);
      if (!missionId) return res.status(400).json({ error: 'missionId is required' });
      const { newBudgetCents, approvedBy } = req.body ?? {};

      if (newBudgetCents === undefined || typeof newBudgetCents !== 'number') {
        return res.status(400).json({
          error: 'newBudgetCents is required and must be a number.',
        });
      }

      const [mission] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, missionId))
        .limit(1);

      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      const payload = parseMissionPayload(mission.result);
      if (newBudgetCents <= payload.budgetCents) {
        return res.status(400).json({
          error: `New budget (${newBudgetCents}) must be greater than current budget (${payload.budgetCents}).`,
        });
      }
      if (payload.missionStatus !== 'budget_exhausted') {
        return res.status(400).json({
          error: `Mission is not budget_exhausted (current: ${payload.missionStatus}). Only budget_exhausted missions can be resumed with budget increase.`,
        });
      }

      const updatedPayload = withUpdatedAt({
        ...payload,
        missionStatus: 'running',
        policy: { ...payload.policy, budgetCents: newBudgetCents },
        budgetCents: newBudgetCents,
      });
      await db.update(goals).set({
        result: JSON.stringify(updatedPayload),
      }).where(eq(goals.id, missionId));

      await db.update(tasks).set({
        status: 'pending',
        errorMessage: null,
        updatedAt: new Date(),
      }).where(and(
        eq(tasks.goalId, missionId),
        eq(tasks.status, 'blocked'),
        eq(tasks.errorMessage, 'Mission budget exhausted'),
      ));

      return res.json({
        missionId,
        status: 'running',
        previousBudgetCents: payload.budgetCents,
        newBudgetCents,
        resumedAt: new Date().toISOString(),
        approvedBy: approvedBy || 'manual',
        message: 'Mission budget increased and mission resumed.',
      });
    } catch (err) {
      console.error('POST /api/missions/:missionId/budget-increase error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  return router;
}

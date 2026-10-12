import { Router } from 'express';
import { z } from 'zod';
import { db, goals, tasks } from '@workspace/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ApexCEO } from '@workspace/agents';

/** Task statuses that still represent live work on a goal. */
const OPEN_TASK_STATUSES = ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const;

const submitGoalSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  priority: z.number().int().min(1).max(10).optional().default(5),
  projectId: z.string().min(2).max(60).optional(), // scopes this goal to a project in the registry (GET /api/projects)
});

export function createGoalsRouter(ceo: ApexCEO) {
  const router = Router();

  // GET /api/goals — list all goals
  router.get('/', async (_req, res) => {
    try {
      const allGoals = await db.select().from(goals).orderBy(desc(goals.createdAt));
      res.json({ goals: allGoals });
    } catch (err) {
      res.json({ goals: [] });
    }
  });

  // GET /api/goals/:id — get goal by id
  router.get('/:id', async (req, res) => {
    const [goal] = await db.select().from(goals).where(eq(goals.id, req.params.id)).limit(1);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    return res.json({ goal });
  });

  // POST /api/goals — submit new goal
  router.post('/', async (req, res) => {
    try {
      const parsed = submitGoalSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }

      const { title, description, priority, projectId } = parsed.data;
      const goalId = await ceo.submitGoal(title, description, priority, projectId);
      return res.status(201).json({ goalId, message: 'Goal submitted to APEX CEO' });
    } catch (err) {
      console.error('[goals] POST / error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/goals/:id — update status
  router.patch('/:id', async (req, res) => {
    const schema = z.object({ status: z.enum(['active', 'paused', 'cancelled']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid status' });
    
    await db.update(goals).set({ status: parsed.data.status }).where(eq(goals.id, req.params.id));

    // Cancelling a goal must also cancel the work it owns. Without this the
    // goal reads cancelled while its tasks stay pending forever, so the task
    // backlog only ever grows and the task_backlog_high governor (>50 pending)
    // latches degraded with no way to clear it. Rows are set to 'cancelled',
    // never deleted, so history and attribution are preserved.
    //
    // Deliberately NOT done for 'paused': a paused goal can resume, and its
    // pending tasks are still legitimate work. Only an explicit cancellation
    // means the work is dead. Tasks that were already done/failed/cancelled are
    // left untouched.
    let cancelledTasks = 0;
    if (parsed.data.status === 'cancelled') {
      const cancelled = await db
        .update(tasks)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(tasks.goalId, req.params.id), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
        .returning({ id: tasks.id });
      cancelledTasks = cancelled.length;
    }

    return res.json({ updated: true, cancelledTasks });
  });

  return router;
}

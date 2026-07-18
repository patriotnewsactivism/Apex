import { Router } from 'express';
import { db, tasks } from '@workspace/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

export function createTasksRouter() {
  const router = Router();

  // GET /api/tasks
  router.get('/', async (req, res) => {
    const { status, agentId, goalId, limit = '50' } = req.query;

    const conditions = [];
    if (status) conditions.push(eq(tasks.status, String(status)));
    if (agentId) conditions.push(eq(tasks.assignedAgentId, String(agentId)));
    if (goalId) conditions.push(eq(tasks.goalId, String(goalId)));

    // BUG FIX 2026-07-18: `conditions` was built above but never applied — this
    // previously always returned the N most recent tasks system-wide regardless
    // of status/agentId/goalId filters. Now actually filters when any are given.
    let query = db.select().from(tasks).$dynamic();
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    const allTasks = await query.orderBy(desc(tasks.createdAt)).limit(parseInt(String(limit), 10));
    res.json({ tasks: allTasks });
  });

  // GET /api/tasks/:id
  router.get('/:id', async (req, res) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, req.params.id)).limit(1);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ task });
  });

  // PATCH /api/tasks/:id
  router.patch('/:id', async (req, res) => {
    const schema = z.object({
      status: z.enum(['pending', 'in_progress', 'blocked', 'cancelled', 'done']).optional(),
      priority: z.number().int().min(1).max(10).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    
    await db.update(tasks).set({ ...parsed.data, updatedAt: new Date() }).where(eq(tasks.id, req.params.id));
    return res.json({ updated: true });
  });

  return router;
}

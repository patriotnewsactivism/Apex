import { Router } from 'express';
import { db, logs } from '@workspace/db';
import { desc, eq, and, gte } from 'drizzle-orm';

export function createLogsRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const { agentId, taskId, level, since, limit = '100' } = req.query;
      const rawLimit = parseInt(String(limit), 10);
      const safeLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;

      const conditions = [];
      if (agentId) conditions.push(eq(logs.agentId, String(agentId)));
      if (taskId) conditions.push(eq(logs.taskId, String(taskId)));
      if (level) conditions.push(eq(logs.level, String(level)));
      if (since) {
        const sinceDate = new Date(String(since));
        if (!Number.isNaN(sinceDate.getTime())) {
          conditions.push(gte(logs.timestamp, sinceDate));
        }
      }

      let query = db.select().from(logs).orderBy(desc(logs.timestamp)).$dynamic();
      if (conditions.length > 0) {
        const drizzle = await import('drizzle-orm');
        query = query.where(drizzle.and(...conditions)) as typeof query;
      }

      const rows = await query.limit(safeLimit);
      res.json({ logs: rows.reverse() }); // oldest first for display
    } catch (err) {
      console.error('[logs] list error:', err);
      res.status(500).json({ logs: [], error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

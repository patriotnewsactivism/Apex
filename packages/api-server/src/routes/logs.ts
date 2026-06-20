import { Router } from 'express';
import { db, logs } from '@workspace/db';
import { desc, eq, and, gte } from 'drizzle-orm';

export function createLogsRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    const { agentId, taskId, level, since, limit = '100' } = req.query;
    
    const rows = await db.select().from(logs)
      .orderBy(desc(logs.timestamp))
      .limit(parseInt(String(limit), 10));

    res.json({ logs: rows.reverse() }); // oldest first for display
  });

  return router;
}

export function createMemoryRouter() {
  const router = Router();
  // Alias — memory routes are on /api/agents/:id/memory
  return router;
}

export function createToolsRouter() {
  const router = Router();

  // POST /api/tools/:name — manually invoke a tool
  router.post('/:name', async (req, res) => {
    const { getToolRegistry } = await import('@workspace/core');
    const registry = getToolRegistry(process.env.WORKSPACE_ROOT ?? process.cwd());
    const result = await registry.execute(req.params.name, req.body, {
      agentId: 'manual',
      workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(),
      requestApproval: async () => true, // manual invocation auto-approves
    });
    res.json(result);
  });

  return router;
}

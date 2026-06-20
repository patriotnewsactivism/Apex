import { Router } from 'express';

export function createToolsRouter() {
  const router = Router();

  // POST /api/tools/:name — manually invoke a registered tool
  router.post('/:name', async (req, res) => {
    const { getToolRegistry } = await import('@workspace/core');
    const registry = getToolRegistry(process.env.WORKSPACE_ROOT ?? process.cwd());
    const result = await registry.execute(req.params.name, req.body, {
      agentId: 'manual-console',
      workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(),
      requestApproval: async () => true,
    });
    res.json(result);
  });

  // GET /api/tools — list available tools
  router.get('/', async (_req, res) => {
    const { getToolRegistry } = await import('@workspace/core');
    const registry = getToolRegistry(process.env.WORKSPACE_ROOT ?? process.cwd());
    const tools = registry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      requiresApproval: t.requiresApproval,
    }));
    res.json({ tools });
  });

  return router;
}

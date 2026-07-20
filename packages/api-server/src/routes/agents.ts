import { Router } from 'express';
import { db, agents, memories } from '@workspace/db';
import { eq } from 'drizzle-orm';
import type { BaseAgent } from '@workspace/core';

export function createAgentsRouter(workforce: Map<string, BaseAgent>) {
  const router = Router();

  // GET /api/agents — list all agents with live status
  router.get('/', async (_req, res) => {
    try {
      const dbAgents = await db.select().from(agents);
      const agentsWithStatus = dbAgents.map((a) => {
        const live = workforce.get(a.id);
        return { ...a, liveStatus: live?.getStatus() ?? a.status };
      });
      res.json({ agents: agentsWithStatus });
    } catch (err) {
      const memoryAgents = Array.from(workforce.values()).map((agent) => ({
        id: agent.getId(),
        name: agent.getName(),
        role: agent.getRole(),
        tier: agent.getTier(),
        status: agent.getStatus(),
        liveStatus: agent.getStatus(),
      }));
      res.json({ agents: memoryAgents });
    }
  });

  // GET /api/agents/:id
  router.get('/:id', async (req, res) => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id)).limit(1);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const live = workforce.get(req.params.id);
    return res.json({ agent: { ...agent, liveStatus: live?.getStatus() ?? agent.status } });
  });

  // GET /api/agents/:id/memory
  router.get('/:id/memory', async (req, res) => {
    const mems = await db.select().from(memories).where(eq(memories.agentId, req.params.id));
    return res.json({ memories: mems });
  });

  // DELETE /api/agents/:id/memory/:key
  router.delete('/:id/memory/:key', async (req, res) => {
    await db.delete(memories).where(eq(memories.agentId, req.params.id));
    return res.json({ deleted: true });
  });

  return router;
}

import { Router } from 'express';
import { db, agents, memories } from '@workspace/db';
import { eq, and } from 'drizzle-orm';
import {
  getProviderCatalog,
  paidLLMFallbackEnabled,
  type BaseAgent,
} from '@workspace/core';

function getRuntimeRouting() {
  const catalog = getProviderCatalog();
  const primary = catalog[0];
  const paidEnabled = paidLLMFallbackEnabled(process.env.APEX_PAID_LLM_MODE);
  const routeLabel = catalog
    .map((provider) =>
      provider.paid
        ? `${provider.name} (${paidEnabled ? 'paid enabled' : 'paid off'})`
        : provider.name,
    )
    .join(' → ');

  return {
    model: primary?.model ?? 'unconfigured',
    provider: 'free-first-router',
    routeLabel,
  };
}

export function createAgentsRouter(workforce: Map<string, BaseAgent>) {
  const router = Router();

  // GET /api/agents — list all agents with live status and the CURRENT shared
  // inference route. Do not expose the historical model/provider columns as if
  // they were runtime truth: old rows can survive routing migrations for years.
  router.get('/', async (_req, res) => {
    const routing = getRuntimeRouting();
    try {
      const dbAgents = await db.select().from(agents);
      const agentsWithStatus = dbAgents.map((a) => {
        const live = workforce.get(a.id);
        return {
          ...a,
          ...routing,
          liveStatus: live?.getStatus() ?? a.status,
          concurrency: live?.currentConcurrency ?? a.metadata?.concurrency ?? 1,
          maxIterations: live?.maxIterations ?? 20,
        };
      });
      res.json({ agents: agentsWithStatus });
    } catch (err) {
      const memoryAgents = Array.from(workforce.values()).map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        tier: agent.tier,
        status: agent.getStatus(),
        liveStatus: agent.getStatus(),
        concurrency: agent.currentConcurrency,
        maxIterations: agent.maxIterations,
        ...routing,
      }));
      res.json({ agents: memoryAgents });
    }
  });

  // GET /api/agents/:id
  router.get('/:id', async (req, res) => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id)).limit(1);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const live = workforce.get(req.params.id);
    return res.json({
      agent: {
        ...agent,
        ...getRuntimeRouting(),
        liveStatus: live?.getStatus() ?? agent.status,
        concurrency: live?.currentConcurrency ?? agent.metadata?.concurrency ?? 1,
        maxIterations: live?.maxIterations ?? 20,
      },
    });
  });

  // PATCH /api/agents/:id — reconfigure an agent at runtime (concurrency, maxIterations)
  router.patch('/:id', async (req, res) => {
    try {
      const { concurrency, maxIterations } = req.body as {
        concurrency?: number;
        maxIterations?: number;
      };

      const [existing] = await db.select().from(agents).where(eq(agents.id, req.params.id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      // Merge overrides into the metadata jsonb for persistence across reboots
      const currentMeta = (existing.metadata as Record<string, unknown> | null) ?? {};
      const newMeta = { ...currentMeta };
      if (concurrency !== undefined) newMeta.concurrency = concurrency;
      if (maxIterations !== undefined) newMeta.maxIterations = maxIterations;

      await db.update(agents).set({ metadata: newMeta }).where(eq(agents.id, req.params.id));

      // Apply to the in-memory instance for immediate effect
      const live = workforce.get(req.params.id);
      const applied: Record<string, unknown> = {};
      if (live) {
        const reconfigureOpts: { concurrency?: number; maxIterations?: number } = {};
        if (concurrency !== undefined) reconfigureOpts.concurrency = concurrency;
        if (maxIterations !== undefined) reconfigureOpts.maxIterations = maxIterations;
        live.reconfigure(reconfigureOpts);
        applied.concurrency = live.currentConcurrency;
        applied.maxIterations = live.maxIterations;
      }

      res.json({
        success: true,
        agentId: req.params.id,
        applied,
        persisted: newMeta,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/agents/:id/memory
  router.get('/:id/memory', async (req, res) => {
    const mems = await db.select().from(memories).where(eq(memories.agentId, req.params.id));
    return res.json({ memories: mems });
  });

  // DELETE /api/agents/:id/memory/:key
  router.delete('/:id/memory/:key', async (req, res) => {
    try {
      await db
        .delete(memories)
        .where(and(eq(memories.agentId, req.params.id), eq(memories.key, req.params.key)));
      return res.json({ deleted: true });
    } catch (err) {
      console.error('[agents] memory delete error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

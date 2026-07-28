import { Router } from 'express';
import {
  db,
  taskOutcomes,
  learningInsights,
  strategyRecommendations,
  performanceBaselines,
  agents,
} from '@workspace/db';
import { PatternDetector, InsightGenerator, StrategyOptimizer } from '@workspace/learning-system';
import { eq, desc, gte, ilike } from 'drizzle-orm';
import type { BaseAgent } from '@workspace/core';

// ─── Learning API Routes ───────────────────────────────────────────────────────
//
// Exposes outcomes, insights, recommendations, and baselines.
// Protected by requireAdminAuth (mounted under /api in the main server).

export function createLearningRouter(workforce?: Map<string, BaseAgent>): Router {
  const router = Router();

  // GET /api/learning/outcomes — list recent task execution outcomes
  router.get('/outcomes', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '50'), 10);
      const role = req.query.role as string | undefined;

      const baseQuery = db.select().from(taskOutcomes);
      const rows = role
        ? await baseQuery.where(eq(taskOutcomes.role, role)).orderBy(desc(taskOutcomes.recordedAt)).limit(limit)
        : await baseQuery.orderBy(desc(taskOutcomes.recordedAt)).limit(limit);

      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/learning/insights — list active learning insights
  router.get('/insights', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '20'), 10);
      const rows = await db
        .select()
        .from(learningInsights)
        .orderBy(desc(learningInsights.createdAt))
        .limit(limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/learning/analyze — trigger manual pattern detection & insight generation
  router.post('/analyze', async (_req, res) => {
    try {
      const detector = new PatternDetector(5); // Match documented >=5 sample threshold
      const patterns = await detector.detectPatterns(30);

      const insightGen = new InsightGenerator();
      const insightsCreated = await insightGen.generateInsights(patterns);

      const optimizer = new StrategyOptimizer();
      const recsCreated = await optimizer.generateRecommendations(patterns);

      res.json({
        success: true,
        patternsDetected: patterns.length,
        insightsCreated,
        recommendationsCreated: recsCreated,
        patterns,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/learning/recommendations — list strategy recommendations
  router.get('/recommendations', async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const baseQuery = db.select().from(strategyRecommendations);
      const rows = status
        ? await baseQuery.where(eq(strategyRecommendations.status, status)).orderBy(desc(strategyRecommendations.createdAt))
        : await baseQuery.orderBy(desc(strategyRecommendations.createdAt));
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/learning/recommendations/:id/respond — approve or reject a strategy recommendation
  router.post('/recommendations/:id/respond', async (req, res) => {
    try {
      const { action, note } = req.body as { action: 'approve' | 'reject'; note?: string };
      if (!['approve', 'reject'].includes(action)) {
        res.status(400).json({ error: "action must be 'approve' or 'reject'" });
        return;
      }

      const status = action === 'approve' ? 'approved' : 'rejected';
      await db
        .update(strategyRecommendations)
        .set({
          status,
          reviewedAt: new Date(),
          reviewerNote: note ?? null,
        })
        .where(eq(strategyRecommendations.id, req.params.id));

      res.json({ success: true, id: req.params.id, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/learning/recommendations/:id/apply — execute an approved recommendation
  router.post('/recommendations/:id/apply', async (req, res) => {
    try {
      const [rec] = await db
        .select()
        .from(strategyRecommendations)
        .where(eq(strategyRecommendations.id, req.params.id))
        .limit(1);

      if (!rec) {
        res.status(404).json({ error: 'Recommendation not found' });
        return;
      }
      if (rec.status === 'rejected') {
        res.status(400).json({ error: 'Cannot apply a rejected recommendation' });
        return;
      }

      const applied: Record<string, unknown> = {};

      if (rec.recommendationType === 'tool_optimization') {
        // Title format: "Optimize task concurrency for role <ROLE>"
        // Find agents matching that role and bump concurrency
        const roleMatch = rec.title.match(/role\s+(\S+)/i);
        const role = roleMatch?.[1];
        if (role) {
          const matching = await db.select().from(agents).where(ilike(agents.role, role));
          for (const a of matching) {
            const currentMeta = (a.metadata as Record<string, unknown> | null) ?? {};
            const currentConcurrency = (currentMeta.concurrency as number) ??
              workforce?.get(a.id)?.currentConcurrency ?? 1;
            const newConcurrency = Math.min(currentConcurrency + 1, 10);

            const newMeta = { ...currentMeta, concurrency: newConcurrency };
            await db.update(agents).set({ metadata: newMeta, updatedAt: new Date() }).where(eq(agents.id, a.id));

            const live = workforce?.get(a.id);
            if (live) {
              live.reconfigure({ concurrency: newConcurrency });
            }
            applied[a.id] = { role: a.role, concurrency: currentConcurrency + '→' + newConcurrency };
          }
        }
      }

      // Mark as applied
      await db
        .update(strategyRecommendations)
        .set({ status: 'applied', reviewedAt: new Date() })
        .where(eq(strategyRecommendations.id, req.params.id));

      res.json({ success: true, id: req.params.id, status: 'applied', changes: applied });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/learning/baselines — list performance baselines
  router.get('/baselines', async (_req, res) => {
    try {
      const rows = await db.select().from(performanceBaselines);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

import { Router } from 'express';
import {
  db,
  taskOutcomes,
  learningInsights,
  strategyRecommendations,
  performanceBaselines,
} from '@workspace/db';
import { PatternDetector, InsightGenerator, StrategyOptimizer, cleanupDuplicateStrategies } from '@workspace/learning-system';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
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
      const allowedStatuses = ['pending', 'approved', 'applied', 'rejected', 'superseded'];
      const requestedStatuses = String(req.query.status ?? 'pending').split(',').filter((status) => allowedStatuses.includes(status));
      const statuses = requestedStatuses.length > 0 ? requestedStatuses : ['pending'];
      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize ?? '25'), 10) || 25));
      const search = String(req.query.search ?? '').trim().slice(0, 100);
      const recommendationType = String(req.query.type ?? '').trim().slice(0, 64);
      const filters = [inArray(strategyRecommendations.status, statuses)];
      if (recommendationType) filters.push(eq(strategyRecommendations.recommendationType, recommendationType));
      if (search) filters.push(or(ilike(strategyRecommendations.title, `%${search}%`), ilike(strategyRecommendations.text, `%${search}%`))!);
      const where = and(...filters);

      const [items, totals] = await Promise.all([
        db.select({
          recommendation: strategyRecommendations,
          duplicateCount: sql<number>`CASE WHEN ${strategyRecommendations.fingerprint} IS NULL THEN 0 ELSE GREATEST((
            SELECT count(*) - 1 FROM strategy_recommendations duplicate
            WHERE duplicate.fingerprint = ${strategyRecommendations.fingerprint}
          ), 0) END`,
        }).from(strategyRecommendations).where(where).orderBy(desc(strategyRecommendations.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
        db.select({ value: count() }).from(strategyRecommendations).where(where),
      ]);
      const total = Number(totals[0]?.value ?? 0);
      res.json({
        items: items.map(({ recommendation, duplicateCount }) => ({ ...recommendation, duplicateCount: Number(duplicateCount) })),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/recommendations/cleanup', async (req, res) => {
    try {
      const execute = req.body?.execute === true;
      if (execute && req.body?.confirm !== 'CLEAN_DUPLICATE_STRATEGIES') {
        res.status(400).json({ error: 'Execute mode requires explicit confirmation' });
        return;
      }
      const summary = await cleanupDuplicateStrategies(!execute);
      console.log('[strategy-cleanup]', JSON.stringify(summary));
      res.json(summary);
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
      if (rec.status !== 'approved') {
        res.status(400).json({ error: `Recommendation must be approved before apply (current status: ${rec.status})` });
        return;
      }

      if (rec.proposedAction === 'increase_task_concurrency' || /concurrenc/i.test(`${rec.title} ${rec.text}`)) {
        res.status(409).json({ error: 'Concurrency increases are blocked while failure and rate-limit evidence is elevated' });
        return;
      }
      res.status(422).json({ error: 'This strategy requires a separately reviewed implementation before it can be marked applied' });
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

import { Router } from 'express';
import {
  db,
  taskOutcomes,
  learningInsights,
  strategyRecommendations,
  performanceBaselines,
} from '@workspace/db';
import {
  PatternDetector,
  InsightGenerator,
  StrategyOptimizer,
  cleanupDuplicateStrategies,
  attemptApplyStrategyRecommendation,
  BusinessOutcomeEvaluator,
  type BusinessOutcomeEvidenceRow,
} from '@workspace/learning-system';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { BaseAgent } from '@workspace/core';
import { outcomeBatchSchema } from '../outcome-ledger/types.js';
import { assignExperiment, createExperiment, ingestOutcomeEvent } from '../outcome-ledger/store.js';
import {
  getAttributionFunnel,
  getBusinessEvaluationEvidence,
  getOutcomeDashboard,
  listCanonicalOutcomes,
  listExperiments,
} from '../outcome-ledger/analytics.js';

// ─── Learning API Routes ───────────────────────────────────────────────────────
//
// Exposes execution learning plus the canonical business Outcome Ledger.
// Protected by requireAdminAuth. The middleware makes one narrow exception:
// portfolio service tokens may POST outcome-ledger/events only.

export function createLearningRouter(workforce?: Map<string, BaseAgent>): Router {
  const router = Router();

  // GET /api/learning/outcomes — legacy task-execution outcomes.
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

  router.get('/insights', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '20'), 10);
      const rows = await db.select().from(learningInsights).orderBy(desc(learningInsights.createdAt)).limit(limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/analyze', async (_req, res) => {
    try {
      const detector = new PatternDetector(5);
      const patterns = await detector.detectPatterns(30);
      const insightGen = new InsightGenerator();
      const insightsCreated = await insightGen.generateInsights(patterns);
      const optimizer = new StrategyOptimizer();
      const recsCreated = await optimizer.generateRecommendations(patterns);
      res.json({ success: true, patternsDetected: patterns.length, insightsCreated, recommendationsCreated: recsCreated, patterns });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

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

  router.post('/recommendations/:id/respond', async (req, res) => {
    try {
      const { action, note } = req.body as { action: 'approve' | 'reject'; note?: string };
      if (!['approve', 'reject'].includes(action)) {
        res.status(400).json({ error: "action must be 'approve' or 'reject'" });
        return;
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      await db.update(strategyRecommendations).set({ status, reviewedAt: new Date(), reviewerNote: note ?? null }).where(eq(strategyRecommendations.id, req.params.id));
      res.json({ success: true, id: req.params.id, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/recommendations/:id/apply', async (req, res) => {
    try {
      const result = await attemptApplyStrategyRecommendation(req.params.id);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ applied: true, recommendation: result.recommendation });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/baselines', async (_req, res) => {
    try {
      res.json(await db.select().from(performanceBaselines));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Canonical Outcome Ledger ─────────────────────────────────────────────

  router.post('/outcome-ledger/events', async (req, res) => {
    try {
      const parsed = outcomeBatchSchema.parse(req.body);
      const events = 'events' in parsed ? parsed.events : [parsed];
      const ingested = [];
      for (const event of events) ingested.push(await ingestOutcomeEvent(event));
      res.status(202).json({ accepted: ingested.length, events: ingested });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'Invalid outcome event', detail: message });
    }
  });

  router.get('/outcome-ledger/dashboard', async (req, res) => {
    try {
      res.json(await getOutcomeDashboard(String(req.query.tenant ?? '').trim() || null, req.query.window));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/outcome-ledger/outcomes', async (req, res) => {
    try {
      res.json(await listCanonicalOutcomes(String(req.query.tenant ?? '').trim() || null, req.query.limit));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/outcome-ledger/attribution', async (req, res) => {
    try {
      res.json(await getAttributionFunnel(String(req.query.tenant ?? '').trim() || null, req.query.window));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/outcome-ledger/experiments', async (req, res) => {
    try {
      res.json(await listExperiments(String(req.query.tenant ?? '').trim() || null));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/outcome-ledger/experiments', async (req, res) => {
    try {
      res.status(201).json(await createExperiment(req.body));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/outcome-ledger/experiments/:id/assignments', async (req, res) => {
    try {
      res.status(201).json(await assignExperiment(req.params.id, req.body));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/outcome-ledger/evaluation', async (req, res) => {
    try {
      const evidence = await getBusinessEvaluationEvidence(String(req.query.tenant ?? '').trim() || null, req.query.window);
      const evaluator = new BusinessOutcomeEvaluator();
      res.json({ ...evidence, metric: 'business_outcome_score', evaluations: evaluator.evaluate(evidence.rows as BusinessOutcomeEvidenceRow[]) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

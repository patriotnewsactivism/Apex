import { v } from 'convex/values';
import { internalAction, internalMutation } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';

// ─── Convex port of packages/learning-system/src/{pattern-detector,
// insight-generator,strategy-optimizer,outcome-analyzer}.ts ─────────────────
//
// The old system was four Drizzle-backed classes (PatternDetector,
// InsightGenerator, StrategyOptimizer, OutcomeAnalyzer) run by a
// LearningAnalysisJob on a schedule. Convex has no long-lived process to hold
// class instances, so the statistical algorithms are ported as plain,
// side-effect-free functions operating on an already-fetched array of
// `taskOutcomes` docs — exactly the "pure/testable" shape the migration plan
// calls for. Only `runAnalysis` (bottom of file) touches the database, via
// ctx.runQuery/ctx.runMutation, matching this codebase's action/query/mutation
// split (see agentLoop.ts). No Node built-ins are needed anywhere here (the
// old insight-generator.ts/strategy-optimizer.ts each imported `crypto` but
// never actually called it — dead imports left over from an earlier draft),
// so this file needs no "use node" and stays on the default V8 runtime.
//
// Table-shape notes vs. the old Postgres schema (see schema.ts's own
// "Translation notes" header for the general rule): `taskOutcomes.recordedAt`
// doesn't exist in the Convex schema — `_creationTime` is the equivalent
// row-creation timestamp, so the 30-day window in `runAnalysis` filters on
// that instead.

// ─── PatternDetector port ───────────────────────────────────────────────────

export interface DetectedPattern {
  name: string;
  category: 'success' | 'failure' | 'duration' | 'approval';
  targetRole?: string;
  confidence: number;
  sampleSize: number;
  description: string;
  evidence: Record<string, unknown>;
}

interface RoleStats {
  total: number;
  failed: number;
  totalDuration: number;
}

function groupByRole(outcomes: Doc<'taskOutcomes'>[]): Record<string, RoleStats> {
  const map: Record<string, RoleStats> = {};
  for (const o of outcomes) {
    if (!map[o.role]) map[o.role] = { total: 0, failed: 0, totalDuration: 0 };
    map[o.role].total++;
    if (!o.success) map[o.role].failed++;
    map[o.role].totalDuration += o.durationMs;
  }
  return map;
}

/**
 * Detect recurring statistical patterns across a window of task outcomes:
 * per-role failure/success rates, recurring error categories, and per-role
 * duration bottlenecks. Ported verbatim from PatternDetector.detectPatterns —
 * the only change is that the 30-day window filter and the DB fetch happen
 * in the caller (runAnalysis) rather than inside this function, so this stays
 * a pure function of its input array.
 *
 * `minSampleSize` mirrors the old constructor's `minSampleThreshold` (default
 * 5 in every call site that constructed a PatternDetector) — below this many
 * outcomes overall, or below it for a given role/error-type bucket, no
 * pattern fires. This guards against a handful of early Convex rows producing
 * a false-positive "100% failure rate" or "100% success rate" pattern.
 */
export function detectPatterns(outcomes: Doc<'taskOutcomes'>[], minSampleSize = 5): DetectedPattern[] {
  if (outcomes.length < minSampleSize) {
    return [];
  }

  const patterns: DetectedPattern[] = [];

  // 1. Per-role failure/success rates.
  const roleStats = groupByRole(outcomes);
  for (const [role, stats] of Object.entries(roleStats)) {
    if (stats.total >= minSampleSize) {
      const failureRate = stats.failed / stats.total;
      if (failureRate > 0.3) {
        // >30% failure rate
        patterns.push({
          name: `high_failure_rate_${role.toLowerCase()}`,
          category: 'failure',
          targetRole: role,
          confidence: Math.min(1.0, 0.6 + stats.total * 0.05),
          sampleSize: stats.total,
          description: `Role '${role}' has a high failure rate of ${(failureRate * 100).toFixed(1)}% (${stats.failed}/${stats.total} failed)`,
          evidence: { role, total: stats.total, failed: stats.failed, failureRate },
        });
      } else if (failureRate === 0 && stats.total >= minSampleSize) {
        patterns.push({
          name: `perfect_success_rate_${role.toLowerCase()}`,
          category: 'success',
          targetRole: role,
          confidence: 0.9,
          sampleSize: stats.total,
          description: `Role '${role}' achieved 100% success rate across ${stats.total} tasks`,
          evidence: { role, total: stats.total },
        });
      }
    }
  }

  // 2. Recurring error types.
  const errorTypeCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.errorType) {
      errorTypeCounts.set(outcome.errorType, (errorTypeCounts.get(outcome.errorType) ?? 0) + 1);
    }
  }
  for (const [errType, count] of errorTypeCounts) {
    if (count >= minSampleSize) {
      patterns.push({
        name: `recurring_error_${errType}`,
        category: 'failure',
        confidence: Math.min(0.95, 0.5 + count * 0.08),
        sampleSize: count,
        description: `Recurring error category '${errType}' detected ${count} times`,
        evidence: { errorType: errType, count, totalOutcomes: outcomes.length },
      });
    }
  }

  // 3. Per-role duration bottlenecks.
  const avgDuration = outcomes.reduce((sum, o) => sum + o.durationMs, 0) / outcomes.length;
  for (const [role, stats] of Object.entries(roleStats)) {
    if (stats.total >= minSampleSize) {
      const roleAvgDuration = stats.totalDuration / stats.total;
      if (roleAvgDuration > avgDuration * 2 && roleAvgDuration > 15_000) {
        patterns.push({
          name: `duration_bottleneck_${role.toLowerCase()}`,
          category: 'duration',
          targetRole: role,
          confidence: 0.85,
          sampleSize: stats.total,
          description: `Role '${role}' avg task duration (${(roleAvgDuration / 1000).toFixed(1)}s) is >2x system average (${(avgDuration / 1000).toFixed(1)}s)`,
          evidence: { role, roleAvgDurationMs: roleAvgDuration, systemAvgDurationMs: avgDuration },
        });
      }
    }
  }

  return patterns;
}

// ─── OutcomeAnalyzer port ───────────────────────────────────────────────────
//
// Neither PatternDetector nor InsightGenerator actually import from
// outcome-analyzer.ts in the old codebase — its static methods were used
// upstream, by whatever called OutcomeAnalyzer.recordOutcome() to derive
// complexity/satisfactionMetric/errorType/tags *before* the old
// `record_outcome`-equivalent insert. The M3 `record_outcome` tool
// (toolRegistry.ts ~line 1480) doesn't call this derivation either — it
// inserts whatever complexity/satisfactionMetric/tags the caller passed in,
// verbatim. These four pure functions are ported here anyway (exported, unused
// by `runAnalysis` below) so that gap can be closed later — e.g. by having
// `record_outcome` call `classifyError`/`calculateComplexity`/
// `calculateSatisfactionMetric`/`generateOutcomeTags` on its inputs before
// inserting — without re-deriving the math from the old package again.

/** Estimated task complexity (0.0-1.0) based on description length and iteration/tool-call counts. */
export function calculateComplexity(description = '', iterations = 1, toolExecutions = 0): number {
  let score = 0.2;
  if (description.length > 500) score += 0.2;
  if (iterations > 3) score += 0.3;
  if (toolExecutions > 5) score += 0.3;
  return Math.min(1.0, score);
}

/** Overall satisfaction metric (0.0-1.0) for a completed task. */
export function calculateSatisfactionMetric(success: boolean, iterations = 1, errorType?: string): number {
  if (!success) {
    if (errorType === 'timeout') return 0.2;
    if (errorType === 'rejection') return 0.4;
    return 0.1;
  }
  // Success — penalty for excessive iterations.
  if (iterations > 10) return 0.7;
  if (iterations > 5) return 0.85;
  return 1.0;
}

/** Classify a raw error string into one of the standard error categories. */
export function classifyError(errorMessage?: string): string | null {
  if (!errorMessage) return null;
  const lower = errorMessage.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('rejected') || lower.includes('denied')) return 'rejection';
  if (lower.includes('max iterations')) return 'max_iterations_exceeded';
  if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit';
  if (lower.includes('network') || lower.includes('fetch failed')) return 'network_error';
  if (lower.includes('syntax') || lower.includes('parse')) return 'parse_error';
  return 'execution_error';
}

/** Generate descriptive tags for indexing an outcome row. */
export function generateOutcomeTags(taskTitle = '', role = 'unknown', success: boolean, errorType?: string | null): string[] {
  const safeRole = (role || 'unknown').toLowerCase();
  const tags: string[] = [safeRole, success ? 'status:success' : 'status:failure'];
  if (errorType) tags.push(`error:${errorType}`);
  const lowerTitle = (taskTitle || '').toLowerCase();
  if (lowerTitle.includes('swarm')) tags.push('feature:swarm');
  if (lowerTitle.includes('refactor') || lowerTitle.includes('build')) tags.push('type:dev');
  if (lowerTitle.includes('review') || lowerTitle.includes('test')) tags.push('type:qa');
  return tags;
}

// ─── InsightGenerator port ──────────────────────────────────────────────────

interface InsightDraft {
  insightType: 'pattern' | 'improvement' | 'warning';
  title: string;
  description: string;
  confidence: number;
  evidence: Record<string, unknown>;
}

/**
 * Turn detected patterns into learning-insight drafts. Ported from
 * InsightGenerator.generateInsights's per-pattern mapping (category ->
 * insightType, title/description/confidence/evidence passthrough). The old
 * 30-day `expiresAt` TTL and the `insight-{name}-{date}` dedupe key are NOT
 * reproduced here — see the comment on `insertNewInsights` below for why and
 * how duplicates are still avoided.
 */
function buildInsightDrafts(patterns: DetectedPattern[]): InsightDraft[] {
  return patterns.map((pattern) => ({
    insightType: pattern.category === 'success' ? 'pattern' : pattern.category === 'failure' ? 'warning' : 'improvement',
    title: `Pattern: ${pattern.name.replace(/_/g, ' ')}`,
    description: pattern.description,
    confidence: pattern.confidence,
    evidence: pattern.evidence,
  }));
}

// ─── StrategyOptimizer port ─────────────────────────────────────────────────

interface RecommendationDraft {
  recommendationType: 'tool_optimization' | 'delegation_improvement' | 'error_mitigation';
  title: string;
  text: string;
  expectedImpact: string;
  confidence: number;
}

/**
 * Turn detected patterns into advisory strategy-recommendation drafts.
 * Ported from StrategyOptimizer.generateRecommendations — only 'failure'
 * (-> error_mitigation) and 'duration' (-> tool_optimization) patterns
 * produce a recommendation, exactly as in the old code; 'success' and
 * 'approval' patterns never do.
 */
function buildRecommendationDrafts(patterns: DetectedPattern[]): RecommendationDraft[] {
  const drafts: RecommendationDraft[] = [];
  for (const pattern of patterns) {
    if (pattern.category === 'failure' && pattern.targetRole) {
      drafts.push({
        recommendationType: 'error_mitigation',
        title: `Mitigate failures for role ${pattern.targetRole}`,
        text: `Enable strict human approval for high-risk tools assigned to ${pattern.targetRole} and adjust retry count from 3 to 5 to handle transient errors.`,
        expectedImpact: `Expected to reduce ${pattern.targetRole} failure rate from current level (${pattern.description})`,
        confidence: pattern.confidence,
      });
    } else if (pattern.category === 'duration' && pattern.targetRole) {
      drafts.push({
        recommendationType: 'tool_optimization',
        title: `Optimize task concurrency for role ${pattern.targetRole}`,
        text: `Increase task concurrency setting for role ${pattern.targetRole} to allow parallel swarm execution and reduce queue bottlenecks.`,
        expectedImpact: `Expected to reduce overall task completion latency for ${pattern.targetRole}`,
        confidence: pattern.confidence,
      });
    }
  }
  return drafts;
}

// ─── strategyRecommendations insert (NEW — toolRegistry.ts has list/get/
// markApplied for this table but no insert mutation; StrategyOptimizer is the
// first thing that ever needs to create one, so it's added here rather than
// in toolRegistry.ts, which this migration must not touch) ──────────────────

export const insertStrategyRecommendation = internalMutation({
  args: {
    recommendationType: v.union(
      v.literal('tool_optimization'),
      v.literal('delegation_improvement'),
      v.literal('error_mitigation'),
    ),
    title: v.string(),
    text: v.string(),
    expectedImpact: v.string(),
    confidence: v.number(),
  },
  returns: v.id('strategyRecommendations'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('strategyRecommendations', {
      recommendationType: args.recommendationType,
      title: args.title,
      text: args.text,
      expectedImpact: args.expectedImpact,
      confidence: args.confidence,
      status: 'pending',
    });
  },
});

// ─── Wiring: fetch existing rows once per run, insert only what's new ───────
//
// The old InsightGenerator/StrategyOptimizer relied on Postgres
// `onConflictDoNothing()` against a deterministic id (`insight-{name}-{date}`
// for insights; `rec-{type}-{role}-{now.getTime()}` for recommendations) to
// avoid duplicate rows across repeated runs. Neither of the existing Convex
// mutations this file must reuse (`learningInsights_insert`,
// and the new `insertStrategyRecommendation` above) take a caller-supplied id
// to dedupe on — and the old recommendation id actually embedded
// `now.getTime()`, which made it unique on every single run and meant
// onConflictDoNothing never once fired in practice (a latent bug in the old
// code: a recurring cron re-running StrategyOptimizer against a
// still-failing role would silently pile up a fresh duplicate row every
// time). Rather than port that bug, this version checks each pattern's
// deterministic title against the rows already in the table before deciding
// whether to insert, once per `runAnalysis` call:
//   - insights: skip if a row with the same title already exists (an insight
//     never expires here anyway, since `learningInsights_insert` doesn't
//     accept `expiresAt` — see comment above the mutation in toolRegistry.ts).
//   - recommendations: skip only if a 'pending' or 'approved' row with the
//     same title already exists — once a human has rejected or applied one,
//     a fresh occurrence of the same pattern is allowed to raise it again.

async function insertNewInsights(ctx: ActionCtx, patterns: DetectedPattern[]): Promise<number> {
  const drafts = buildInsightDrafts(patterns);
  if (drafts.length === 0) return 0;

  const existing: Doc<'learningInsights'>[] = await ctx.runQuery(internal.toolRegistry.learningInsights_list, { limit: 500 });
  const existingTitles = new Set(existing.map((i) => i.title));

  let created = 0;
  for (const draft of drafts) {
    if (existingTitles.has(draft.title)) continue;
    await ctx.runMutation(internal.toolRegistry.learningInsights_insert, {
      insightType: draft.insightType,
      title: draft.title,
      description: draft.description,
      confidence: draft.confidence,
      evidence: draft.evidence,
      applied: false,
    });
    existingTitles.add(draft.title); // guard against two patterns in the same run sharing a title
    created++;
  }
  return created;
}

async function insertNewRecommendations(ctx: ActionCtx, patterns: DetectedPattern[]): Promise<number> {
  const drafts = buildRecommendationDrafts(patterns);
  if (drafts.length === 0) return 0;

  const existing: Doc<'strategyRecommendations'>[] = await ctx.runQuery(internal.toolRegistry.strategyRecommendations_list, {});
  const openTitles = new Set(
    existing.filter((r) => r.status === 'pending' || r.status === 'approved').map((r) => r.title),
  );

  let created = 0;
  for (const draft of drafts) {
    if (openTitles.has(draft.title)) continue;
    await ctx.runMutation(internal.learning.insertStrategyRecommendation, {
      recommendationType: draft.recommendationType,
      title: draft.title,
      text: draft.text,
      expectedImpact: draft.expectedImpact,
      confidence: draft.confidence,
    });
    openTitles.add(draft.title);
    created++;
  }
  return created;
}

// ─── runAnalysis: the LearningAnalysisJob port ──────────────────────────────
//
// Matches the old LearningAnalysisJob.execute()'s pipeline: fetch recent
// outcomes -> detect patterns (>=5-sample threshold, 30-day window) -> turn
// patterns into insights -> turn patterns into strategy recommendations ->
// return counts. Called by jobHandlers.ts's LearningAnalysisJob handler via
// `ctx.runAction(internal.learning.runAnalysis, {})`.

const ANALYSIS_WINDOW_DAYS = 30;
const MIN_SAMPLE_SIZE = 5;

export const runAnalysis = internalAction({
  args: {},
  returns: v.object({
    patternsDetected: v.number(),
    insightsCreated: v.number(),
    recommendationsCreated: v.number(),
    analyzedAt: v.number(),
  }),
  handler: async (ctx) => {
    const all: Doc<'taskOutcomes'>[] = await ctx.runQuery(internal.toolRegistry.taskOutcomes_listAll, {});

    const since = Date.now() - ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const windowed = all.filter((o) => o._creationTime >= since);

    const patterns = detectPatterns(windowed, MIN_SAMPLE_SIZE);

    const insightsCreated = await insertNewInsights(ctx, patterns);
    const recommendationsCreated = await insertNewRecommendations(ctx, patterns);

    return {
      patternsDetected: patterns.length,
      insightsCreated,
      recommendationsCreated,
      analyzedAt: Date.now(),
    };
  },
});

// ─── StrategyOptimizer ─────────────────────────────────────────────────────────
//
// Formulates evidence-led strategy recommendations based on measured patterns.
// Stable identities prevent every learning run from restating the same advice.

import { db, strategyRecommendations, type NewStrategyRecommendation } from '@workspace/db';
import { sql } from 'drizzle-orm';
import type { DetectedPattern } from './pattern-detector.js';
import { strategyFingerprint, type StrategySemantics } from './strategy-fingerprint.js';

export class StrategyOptimizer {
  /**
   * Generate advisory strategy recommendations from detected patterns.
   * Inserts new recommendations with status 'pending' awaiting human review.
   */
  async generateRecommendations(patterns: DetectedPattern[]): Promise<number> {
    let createdCount = 0;
    const now = new Date();

    for (const pattern of patterns) {
      if (pattern.category === 'failure' && pattern.targetRole) {
        const semantics: StrategySemantics = {
          recommendationType: 'error_mitigation',
          affectedRole: pattern.targetRole,
          failureCategory: typeof pattern.evidence.errorType === 'string' ? pattern.evidence.errorType : 'role_failure_rate',
          proposedAction: 'cluster_and_mitigate_causal_failures',
          insightType: pattern.category,
        };
        const fingerprint = strategyFingerprint(semantics);
        const id = `rec-error-${fingerprint.slice(0, 24)}`;
        const record: NewStrategyRecommendation = {
          id,
          recommendationType: 'error_mitigation',
          title: `Mitigate failures for role ${pattern.targetRole}`,
          text: `Cluster the ${pattern.targetRole} failures by the first causal error, reproduce the largest cluster, and change the smallest responsible prompt, tool contract, or code path. Validate against the failed examples plus a successful control before changing retry or approval policy.`,
          expectedImpact: `Reduce the measured ${pattern.targetRole} failure mode without adding blanket approval friction or retry cost (${pattern.description})`,
          confidence: pattern.confidence,
          status: 'pending',
          fingerprint,
          lifecycleKey: fingerprint,
          affectedRole: semantics.affectedRole,
          failureCategory: semantics.failureCategory,
          proposedAction: semantics.proposedAction,
          insightType: semantics.insightType,
          evidence: pattern.evidence,
          occurrences: 1,
          firstObservedAt: now,
          lastObservedAt: now,
          createdAt: now,
        };

        const inserted = await this.upsertEvidence(record, now);
        createdCount += inserted.length;
      } else if (pattern.category === 'duration' && pattern.targetRole) {
        const semantics: StrategySemantics = {
          recommendationType: 'tool_optimization',
          affectedRole: pattern.targetRole,
          failureCategory: 'latency_bottleneck',
          proposedAction: 'remove_dominant_latency_source',
          insightType: pattern.category,
        };
        const fingerprint = strategyFingerprint(semantics);
        const id = `rec-duration-${fingerprint.slice(0, 24)}`;
        const record: NewStrategyRecommendation = {
          id,
          recommendationType: 'tool_optimization',
          title: `Remove the dominant latency source for ${pattern.targetRole}`,
          text: `Measure queue wait, LLM round trips, tool duration, and rework separately for ${pattern.targetRole}; optimize the largest contributor first. Prefer tighter context, reusable evidence, or smaller independently verifiable tasks. Increase concurrency only when queue wait is proven dominant and provider budgets have headroom.`,
          expectedImpact: `Reduce ${pattern.targetRole} completion latency without creating duplicated work, provider throttling, or a larger failure blast radius`,
          confidence: pattern.confidence,
          status: 'pending',
          fingerprint,
          lifecycleKey: fingerprint,
          affectedRole: semantics.affectedRole,
          failureCategory: semantics.failureCategory,
          proposedAction: semantics.proposedAction,
          insightType: semantics.insightType,
          evidence: pattern.evidence,
          occurrences: 1,
          firstObservedAt: now,
          lastObservedAt: now,
          createdAt: now,
        };

        const inserted = await this.upsertEvidence(record, now);
        createdCount += inserted.length;
      }
    }

    return createdCount;
  }

  private async upsertEvidence(record: NewStrategyRecommendation, now: Date) {
    return db
      .insert(strategyRecommendations)
      .values(record)
      .onConflictDoUpdate({
        target: strategyRecommendations.lifecycleKey,
        targetWhere: sql`${strategyRecommendations.lifecycleKey} IS NOT NULL`,
        set: {
          evidence: record.evidence,
          expectedImpact: record.expectedImpact,
          confidence: record.confidence,
          lastObservedAt: now,
          occurrences: sql`${strategyRecommendations.occurrences} + 1`,
        },
      })
      // Only a newly inserted pending row counts as a new recommendation. An
      // approved/applied/rejected lifecycle merely receives fresher evidence.
      .returning({ id: strategyRecommendations.id, inserted: sql<boolean>`xmax = 0` })
      .then((rows) => rows.filter((row) => row.inserted));
  }
}

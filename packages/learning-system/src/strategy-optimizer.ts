// ─── StrategyOptimizer ─────────────────────────────────────────────────────────
//
// Formulates evidence-led strategy recommendations based on measured patterns.
// Stable identities prevent every learning run from restating the same advice.

import crypto from 'crypto';
import { db, strategyRecommendations, type NewStrategyRecommendation } from '@workspace/db';
import type { DetectedPattern } from './pattern-detector.js';

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
        const fingerprint = crypto.createHash('sha256')
          .update(`failure:${pattern.targetRole}:${pattern.description}`)
          .digest('hex').slice(0, 16);
        const id = `rec-error-${pattern.targetRole.toLowerCase()}-${fingerprint}`;
        const record: NewStrategyRecommendation = {
          id,
          recommendationType: 'error_mitigation',
          title: `Mitigate failures for role ${pattern.targetRole}`,
          text: `Cluster the ${pattern.targetRole} failures by the first causal error, reproduce the largest cluster, and change the smallest responsible prompt, tool contract, or code path. Validate against the failed examples plus a successful control before changing retry or approval policy.`,
          expectedImpact: `Reduce the measured ${pattern.targetRole} failure mode without adding blanket approval friction or retry cost (${pattern.description})`,
          confidence: pattern.confidence,
          status: 'pending',
          createdAt: now,
        };

        const inserted = await db.insert(strategyRecommendations).values(record).onConflictDoNothing().returning({ id: strategyRecommendations.id });
        createdCount += inserted.length;
      } else if (pattern.category === 'duration' && pattern.targetRole) {
        const fingerprint = crypto.createHash('sha256')
          .update(`duration:${pattern.targetRole}:${pattern.description}`)
          .digest('hex').slice(0, 16);
        const id = `rec-duration-${pattern.targetRole.toLowerCase()}-${fingerprint}`;
        const record: NewStrategyRecommendation = {
          id,
          recommendationType: 'tool_optimization',
          title: `Remove the dominant latency source for ${pattern.targetRole}`,
          text: `Measure queue wait, LLM round trips, tool duration, and rework separately for ${pattern.targetRole}; optimize the largest contributor first. Prefer tighter context, reusable evidence, or smaller independently verifiable tasks. Increase concurrency only when queue wait is proven dominant and provider budgets have headroom.`,
          expectedImpact: `Reduce ${pattern.targetRole} completion latency without creating duplicated work, provider throttling, or a larger failure blast radius`,
          confidence: pattern.confidence,
          status: 'pending',
          createdAt: now,
        };

        const inserted = await db.insert(strategyRecommendations).values(record).onConflictDoNothing().returning({ id: strategyRecommendations.id });
        createdCount += inserted.length;
      }
    }

    return createdCount;
  }
}

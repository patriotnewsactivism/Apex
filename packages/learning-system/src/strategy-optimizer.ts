// ─── StrategyOptimizer ─────────────────────────────────────────────────────────
//
// Formulates actionable strategy recommendations based on learning insights.
// All recommendations are advisory — human approval is strictly required
// before any recommendation is applied per ROADMAP.md governance rules.

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
        const id = `rec-error-${pattern.targetRole.toLowerCase()}-${now.getTime()}`;
        const record: NewStrategyRecommendation = {
          id,
          recommendationType: 'error_mitigation',
          title: `Mitigate failures for role ${pattern.targetRole}`,
          text: `Enable strict human approval for high-risk tools assigned to ${pattern.targetRole} and adjust retry count from 3 to 5 to handle transient errors.`,
          expectedImpact: `Expected to reduce ${pattern.targetRole} failure rate from current level (${pattern.description})`,
          confidence: pattern.confidence,
          status: 'pending',
          createdAt: now,
        };

        await db.insert(strategyRecommendations).values(record).onConflictDoNothing().catch(() => {});
        createdCount++;
      } else if (pattern.category === 'duration' && pattern.targetRole) {
        const id = `rec-duration-${pattern.targetRole.toLowerCase()}-${now.getTime()}`;
        const record: NewStrategyRecommendation = {
          id,
          recommendationType: 'tool_optimization',
          title: `Optimize task concurrency for role ${pattern.targetRole}`,
          text: `Increase task concurrency setting for role ${pattern.targetRole} to allow parallel swarm execution and reduce queue bottlenecks.`,
          expectedImpact: `Expected to reduce overall task completion latency for ${pattern.targetRole}`,
          confidence: pattern.confidence,
          status: 'pending',
          createdAt: now,
        };

        await db.insert(strategyRecommendations).values(record).onConflictDoNothing().catch(() => {});
        createdCount++;
      }
    }

    return createdCount;
  }
}

// ─── InsightGenerator ──────────────────────────────────────────────────────────
//
// Converts statistical patterns detected by PatternDetector into actionable,
// expiring learning insights stored in the learning_insights database table.
// Default expiration is 30 days per ROADMAP.md spec.

import crypto from 'crypto';
import { db, learningInsights, type NewLearningInsight } from '@workspace/db';
import type { DetectedPattern } from './pattern-detector.js';

export class InsightGenerator {
  /**
   * Generate insights from detected patterns and insert them into DB.
   * Skips duplicate active insights for the same pattern name.
   */
  async generateInsights(patterns: DetectedPattern[]): Promise<number> {
    let createdCount = 0;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30-day TTL

    for (const pattern of patterns) {
      const insightId = `insight-${pattern.name}-${now.toISOString().slice(0, 10)}`;

      const insightType: 'pattern' | 'improvement' | 'warning' =
        pattern.category === 'success'
          ? 'pattern'
          : pattern.category === 'failure'
            ? 'warning'
            : 'improvement';

      const record: NewLearningInsight = {
        id: insightId,
        insightType,
        title: `Pattern: ${pattern.name.replace(/_/g, ' ')}`,
        description: pattern.description,
        confidence: pattern.confidence,
        evidence: pattern.evidence,
        applied: false,
        createdAt: now,
        expiresAt,
      };

      try {
        await db.insert(learningInsights).values(record).onConflictDoNothing();
        createdCount++;
      } catch (err) {
        console.error(`[InsightGenerator] Failed to save insight ${insightId}:`, err);
      }
    }

    return createdCount;
  }
}

// ─── RiskDetector ─────────────────────────────────────────────────────────────
//
// Detects systemic portfolio risks, performance bottlenecks, and degradation trends.

import { db, riskAssessments, taskOutcomes } from '@workspace/db';
import { gte } from 'drizzle-orm';
import crypto from 'crypto';

export class RiskDetector {
  /** Conduct automated risk assessment over portfolio targets. */
  async riskAssessment(target: string = 'global') {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const outcomes = await db
      .select()
      .from(taskOutcomes)
      .where(gte(taskOutcomes.recordedAt, since));

    const total = outcomes.length;
    const failures = outcomes.filter((o) => !o.success).length;
    const failureRate = total > 0 ? failures / total : 0;
    const confidence = total > 0 ? Math.min(0.95, 0.65 + total * 0.025) : 0.3;

    let riskLevel = 'low';
    let details = 'All portfolio systems operating within normal parameters.';

    if (failureRate > 0.3) {
      riskLevel = 'high';
      details = `High failure rate detected (${(failureRate * 100).toFixed(1)}%) across recent task outcomes.`;
    } else if (failureRate > 0.15) {
      riskLevel = 'medium';
      details = `Moderate failure rate detected (${(failureRate * 100).toFixed(1)}%). Recommended monitoring.`;
    }

    const riskId = `risk-${crypto.randomUUID().slice(0, 8)}`;
    const persistedRecord = {
      id: riskId,
      target,
      riskLevel,
      details,
      createdAt: new Date(),
    };

    await db.insert(riskAssessments).values(persistedRecord).catch(() => {});

    return {
      ...persistedRecord,
      sampleSize: total,
      failureRate,
      confidence,
      advisoryOnly: true,
      actionsTriggered: [],
    };
  }
}

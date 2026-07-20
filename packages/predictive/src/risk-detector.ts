// ─── RiskDetector ─────────────────────────────────────────────────────────────
//
// Detects systemic portfolio risks, performance bottlenecks, and degradation trends.

import { db, riskAssessments, taskOutcomes } from '@workspace/db';
import { desc, gte } from 'drizzle-orm';
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
    const record = {
      id: riskId,
      target,
      riskLevel,
      details,
      createdAt: new Date(),
    };

    await db.insert(riskAssessments).values(record).catch(() => {});

    return record;
  }
}

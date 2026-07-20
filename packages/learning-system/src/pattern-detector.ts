// ─── PatternDetector ──────────────────────────────────────────────────────────
//
// Detects statistical patterns, success/failure trends, and duration bottlenecks
// across task execution outcomes. Requires >=5 sample outcomes before firing a
// pattern to avoid false positives on small datasets.

import { db, taskOutcomes, type TaskOutcome } from '@workspace/db';
import { desc, gte } from 'drizzle-orm';

export interface DetectedPattern {
  name: string;
  category: 'success' | 'failure' | 'duration' | 'approval';
  targetRole?: string;
  confidence: number;
  sampleSize: number;
  description: string;
  evidence: Record<string, unknown>;
}

export class PatternDetector {
  private minSampleSize: number;

  constructor(minSampleSize: number = 5) {
    this.minSampleSize = minSampleSize;
  }

  /** Run pattern detection over recent task outcomes. */
  async detectPatterns(days: number = 30): Promise<DetectedPattern[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const outcomes = await db
      .select()
      .from(taskOutcomes)
      .where(gte(taskOutcomes.recordedAt, since))
      .orderBy(desc(taskOutcomes.recordedAt));

    if (outcomes.length < this.minSampleSize) {
      return [];
    }

    const patterns: DetectedPattern[] = [];

    // 1. Detect role failure rates
    const roleStats = this.groupByRole(outcomes);
    for (const [role, stats] of Object.entries(roleStats)) {
      if (stats.total >= this.minSampleSize) {
        const failureRate = stats.failed / stats.total;
        if (failureRate > 0.3) { // >30% failure rate
          patterns.push({
            name: `high_failure_rate_${role.toLowerCase()}`,
            category: 'failure',
            targetRole: role,
            confidence: Math.min(1.0, 0.6 + stats.total * 0.05),
            sampleSize: stats.total,
            description: `Role '${role}' has a high failure rate of ${(failureRate * 100).toFixed(1)}% (${stats.failed}/${stats.total} failed)`,
            evidence: { role, total: stats.total, failed: stats.failed, failureRate },
          });
        } else if (failureRate === 0 && stats.total >= this.minSampleSize) {
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

    // 2. Detect recurring error types
    const errorTypeCounts = new Map<string, number>();
    for (const outcome of outcomes) {
      if (outcome.errorType) {
        errorTypeCounts.set(outcome.errorType, (errorTypeCounts.get(outcome.errorType) ?? 0) + 1);
      }
    }
    for (const [errType, count] of errorTypeCounts) {
      if (count >= this.minSampleSize) {
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

    // 3. Detect high duration bottlenecks
    const avgDuration = outcomes.reduce((sum, o) => sum + o.durationMs, 0) / outcomes.length;
    for (const [role, stats] of Object.entries(roleStats)) {
      if (stats.total >= this.minSampleSize) {
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

  private groupByRole(outcomes: TaskOutcome[]) {
    const map: Record<string, { total: number; failed: number; totalDuration: number }> = {};
    for (const o of outcomes) {
      if (!map[o.role]) map[o.role] = { total: 0, failed: 0, totalDuration: 0 };
      map[o.role].total++;
      if (!o.success) map[o.role].failed++;
      map[o.role].totalDuration += o.durationMs;
    }
    return map;
  }
}

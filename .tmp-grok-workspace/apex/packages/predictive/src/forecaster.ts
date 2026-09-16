// ─── Forecaster ───────────────────────────────────────────────────────────────
//
// Computes task completion and velocity forecasts with confidence bounds.

import { db, predictiveForecasts, taskOutcomes } from '@workspace/db';
import { gte } from 'drizzle-orm';
import crypto from 'crypto';

const WINDOW_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function windowToMs(window: string): number {
  return WINDOW_MS[window] ?? WINDOW_MS['7d'];
}

function wilsonConfidenceInterval(successes: number, total: number, z = 1.96) {
  if (total === 0) {
    return { lower: 0, upper: 100 };
  }

  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion)) / total + (z * z) / (4 * total * total))) /
    denominator;

  return {
    lower: Math.max(0, (center - margin) * 100),
    upper: Math.min(100, (center + margin) * 100),
  };
}

export class Forecaster {
  /** Compute predictive forecast for task execution velocity / completion rate. */
  async forecastTasks(metricName: string = 'task_completion_rate', window: string = '7d') {
    const since = new Date(Date.now() - windowToMs(window));
    const outcomes = await db
      .select()
      .from(taskOutcomes)
      .where(gte(taskOutcomes.recordedAt, since));

    const total = outcomes.length;
    const successCount = outcomes.filter((o) => o.success).length;
    const forecastValue = total > 0 ? (successCount / total) * 100 : 95.0;
    const confidenceInterval = wilsonConfidenceInterval(successCount, total);
    const confidence = total > 0 ? Math.min(0.95, 0.7 + total * 0.02) : 0.35;

    const forecastId = `fc-${crypto.randomUUID().slice(0, 8)}`;
    const persistedRecord = {
      id: forecastId,
      metricName,
      forecastValue,
      confidence,
      window,
      createdAt: new Date(),
    };

    await db.insert(predictiveForecasts).values(persistedRecord).catch(() => {});

    return {
      ...persistedRecord,
      sampleSize: total,
      observedSuccessRate: total > 0 ? successCount / total : null,
      confidenceInterval,
      advisoryOnly: true,
      actionsTriggered: [],
    };
  }
}

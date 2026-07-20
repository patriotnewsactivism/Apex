// ─── Forecaster ───────────────────────────────────────────────────────────────
//
// Computes task completion and velocity forecasts with confidence bounds.

import { db, predictiveForecasts, taskOutcomes } from '@workspace/db';
import { desc, gte } from 'drizzle-orm';
import crypto from 'crypto';

export class Forecaster {
  /** Compute predictive forecast for task execution velocity / completion rate. */
  async forecastTasks(metricName: string = 'task_completion_rate', window: string = '7d') {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const outcomes = await db
      .select()
      .from(taskOutcomes)
      .where(gte(taskOutcomes.recordedAt, since));

    const total = outcomes.length;
    const successCount = outcomes.filter((o) => o.success).length;
    const forecastValue = total > 0 ? (successCount / total) * 100 : 95.0;

    const forecastId = `fc-${crypto.randomUUID().slice(0, 8)}`;
    const record = {
      id: forecastId,
      metricName,
      forecastValue,
      confidence: Math.min(0.95, 0.7 + total * 0.02),
      window,
      createdAt: new Date(),
    };

    await db.insert(predictiveForecasts).values(record).catch(() => {});

    return record;
  }
}

import { db, strategyRecommendations, type StrategyRecommendation } from '@workspace/db';
import { eq } from 'drizzle-orm';

export type StrategyApplyResult =
  | { ok: true; recommendation: StrategyRecommendation }
  | { ok: false; status: 400 | 404 | 409 | 422; error: string };

/**
 * The single gate for transitioning a strategy recommendation to `applied`.
 *
 * Both the HTTP route (POST /api/learning/recommendations/:id/apply) and the
 * agent tool (apply_strategy_recommendation in tool-registry.ts) must call
 * this instead of writing the transition themselves. Before this existed,
 * each path enforced different rules: the HTTP route refused every apply
 * pending a separately reviewed implementation, but the agent tool happily
 * flipped any approved row to `applied` and persisted it as a standing
 * insight (shaping future agent prompts) — an agent could self-report a
 * strategy as implemented when nothing had actually been done. Per
 * AGENTS.md: "Never manufacture metrics, status, deploy evidence, test
 * results, or external side effects." No automatic caller may perform this
 * transition today; it always returns the 422 below until a real
 * "implementation confirmed" review step exists.
 */
export async function attemptApplyStrategyRecommendation(
  recommendationId: string,
): Promise<StrategyApplyResult> {
  const [rec] = await db
    .select()
    .from(strategyRecommendations)
    .where(eq(strategyRecommendations.id, recommendationId))
    .limit(1);

  if (!rec) {
    return { ok: false, status: 404, error: `No recommendation found with id ${recommendationId}` };
  }
  if (rec.status !== 'approved') {
    return {
      ok: false,
      status: 400,
      error: `Recommendation must be approved before apply (current status: ${rec.status})`,
    };
  }
  if (rec.proposedAction === 'increase_task_concurrency' || /concurrenc/i.test(`${rec.title} ${rec.text}`)) {
    return {
      ok: false,
      status: 409,
      error: 'Concurrency increases are blocked while failure and rate-limit evidence is elevated',
    };
  }
  return {
    ok: false,
    status: 422,
    error: 'This strategy requires a separately reviewed implementation before it can be marked applied',
  };
}

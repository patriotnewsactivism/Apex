import { db, strategyRecommendations, type StrategyRecommendation } from '@workspace/db';
import { desc, eq, sql } from 'drizzle-orm';
import { inferLegacyStrategySemantics, strategyFingerprint } from './strategy-fingerprint.js';

export interface StrategyCleanupSummary {
  dryRun: boolean;
  totalRowsExamined: number;
  semanticGroupsFound: number;
  canonicalRecordsRetained: number;
  pendingDuplicatesSuperseded: number;
  unsafeConcurrencyItemsRejected: number;
  pendingCountBefore: number;
  pendingCountAfter: number;
  uniquePendingForReview: Array<{ id: string; title: string; fingerprint: string }>;
}

function statusRank(status: string): number {
  if (status === 'applied') return 5;
  if (status === 'approved') return 4;
  // Rejection is durable negative memory. An identical later pending row must
  // not outrank and reopen it without a materially different fingerprint.
  if (status === 'rejected') return 3;
  if (status === 'pending') return 2;
  return 0;
}

function newestBest(rows: StrategyRecommendation[]): StrategyRecommendation {
  return [...rows].sort((a, b) =>
    statusRank(b.status) - statusRank(a.status) || b.createdAt.getTime() - a.createdAt.getTime(),
  )[0]!;
}

/** Transactional and idempotent; no strategy record is physically deleted. */
export async function cleanupDuplicateStrategies(dryRun: boolean): Promise<StrategyCleanupSummary> {
  return db.transaction(async (tx) => {
    // Blocks concurrent inserts until canonical lifecycle keys are established.
    await tx.execute(sql`LOCK TABLE strategy_recommendations IN SHARE ROW EXCLUSIVE MODE`);
    const rows = await tx.select().from(strategyRecommendations).orderBy(desc(strategyRecommendations.createdAt));
    const groups = new Map<string, { rows: StrategyRecommendation[]; semantics: ReturnType<typeof inferLegacyStrategySemantics> }>();

    for (const row of rows) {
      const semantics = inferLegacyStrategySemantics(row);
      const fingerprint = strategyFingerprint(semantics);
      const group = groups.get(fingerprint) ?? { rows: [], semantics };
      group.rows.push(row);
      groups.set(fingerprint, group);
    }

    const pendingBefore = rows.filter((row) => row.status === 'pending').length;
    let pendingDuplicatesSuperseded = 0;
    let unsafeConcurrencyItemsRejected = 0;
    const uniquePendingForReview: StrategyCleanupSummary['uniquePendingForReview'] = [];
    const now = new Date();

    if (!dryRun) {
      await tx.update(strategyRecommendations).set({ lifecycleKey: null });
    }

    for (const [fingerprint, group] of groups) {
      const canonical = newestBest(group.rows);
      const unsafeConcurrency = group.semantics.proposedAction === 'increase_task_concurrency';
      const hasReviewedCanonical = ['approved', 'applied', 'rejected'].includes(canonical.status);

      for (const row of group.rows) {
        if (row.status !== 'pending') continue;
        if (row.id === canonical.id && !hasReviewedCanonical && !unsafeConcurrency) {
          uniquePendingForReview.push({ id: row.id, title: row.title, fingerprint });
          continue;
        }
        pendingDuplicatesSuperseded++;
        if (unsafeConcurrency) unsafeConcurrencyItemsRejected++;
      }

      if (dryRun) continue;

      for (const row of group.rows) {
        const isRetainedPending = row.id === canonical.id && !hasReviewedCanonical && !unsafeConcurrency;
        const isPendingDuplicate = row.status === 'pending' && !isRetainedPending;
        await tx.update(strategyRecommendations).set({
          fingerprint,
          lifecycleKey: row.id === canonical.id ? fingerprint : null,
          affectedRole: group.semantics.affectedRole ?? null,
          failureCategory: group.semantics.failureCategory ?? null,
          proposedAction: group.semantics.proposedAction,
          insightType: group.semantics.insightType ?? null,
          status: isPendingDuplicate ? (unsafeConcurrency ? 'rejected' : 'superseded') : row.status,
          supersededById: isPendingDuplicate ? canonical.id : row.supersededById,
          supersededAt: isPendingDuplicate ? now : row.supersededAt,
          supersedeReason: isPendingDuplicate ? 'duplicate_strategy_cleanup' : row.supersedeReason,
        }).where(eq(strategyRecommendations.id, row.id));
      }
    }

    const pendingAfter = dryRun
      ? uniquePendingForReview.length
      : Number((await tx.select({ count: sql<number>`count(*)` }).from(strategyRecommendations).where(eq(strategyRecommendations.status, 'pending')))[0]?.count ?? 0);

    return {
      dryRun,
      totalRowsExamined: rows.length,
      semanticGroupsFound: groups.size,
      canonicalRecordsRetained: groups.size,
      pendingDuplicatesSuperseded,
      unsafeConcurrencyItemsRejected,
      pendingCountBefore: pendingBefore,
      pendingCountAfter: pendingAfter,
      uniquePendingForReview,
    };
  });
}

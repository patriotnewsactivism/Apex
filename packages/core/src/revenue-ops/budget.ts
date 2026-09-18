// ─── Revenue Operations Budget Guard ────────────────────────────────────────────
//
// Budget enforcement for revenue-ops missions. Every spend action calls
// checkMissionBudget before executing. Spend is recorded in usage_ledger and
// cached in goal.result.spentCents.
//
// Authoritative spend = SUM(usage_ledger.amount_cents WHERE mission_id = ?).
// spentCents in goal.result is a cached convenience that tracks the same value.

import { db } from '@workspace/db';
import { eq, sql, sum } from 'drizzle-orm';
import { usageLedger, goals } from '@workspace/db';
import type { MissionPayload } from '@workspace/db';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface BudgetCheckResult {
  allowed: boolean;
  remainingCents: number;
  budgetCents: number;
  spentCents: number;
  reason?: string;
}

export interface RecordSpendInput {
  organizationId: string;
  missionId: string;
  taskId?: string;
  provider: string;
  category: string;
  quantity?: number;
  unit?: string;
  amountCents: number;
  externalReference?: string;
}

// ─── Budget check ───────────────────────────────────────────────────────────────

export async function checkMissionBudget(
  missionId: string,
  estimatedCostCents: number,
): Promise<BudgetCheckResult> {
  // Read mission goal
  const [goal] = await db
    .select({ result: goals.result })
    .from(goals)
    .where(eq(goals.id, missionId))
    .limit(1);

  if (!goal?.result) {
    // No mission payload = no budget tracking. Allow (will be caught by other checks).
    return {
      allowed: true,
      remainingCents: Infinity,
      budgetCents: 0,
      spentCents: 0,
      reason: 'No mission budget configured — allow with caution.',
    };
  }

  const payload = JSON.parse(goal.result) as MissionPayload;
  const budgetCents = payload.budgetCents ?? 0;
  const spentCents = payload.spentCents ?? 0;

  // Also compute authoritative spent from usage_ledger
  const [ledgerRow] = await db
    .select({ total: sum(usageLedger.amountCents) })
    .from(usageLedger)
    .where(eq(usageLedger.missionId, missionId))
    .limit(1);

  const authoritativeSpent =
    typeof ledgerRow?.total === 'number' ? ledgerRow.total : spentCents;

  const remainingCents = Math.max(0, budgetCents - authoritativeSpent);

  if (estimatedCostCents > remainingCents) {
    return {
      allowed: false,
      remainingCents,
      budgetCents,
      spentCents: authoritativeSpent,
      reason: `Estimated cost ${estimatedCostCents}¢ exceeds remaining budget ${remainingCents}¢ (budget ${budgetCents}¢, spent ${authoritativeSpent}¢).`,
    };
  }

  return {
    allowed: true,
    remainingCents,
    budgetCents,
    spentCents: authoritativeSpent,
  };
}

// ─── Record spend ───────────────────────────────────────────────────────────────

export async function recordSpend(input: RecordSpendInput): Promise<void> {
  const now = new Date();

  await db.insert(usageLedger).values({
    organizationId: input.organizationId,
    missionId: input.missionId,
    taskId: input.taskId ?? null,
    provider: input.provider,
    category: input.category,
    quantity: input.quantity != null ? String(input.quantity) : null,
    unit: input.unit ?? null,
    amountCents: input.amountCents,
    externalReference: input.externalReference ?? null,
    createdAt: now,
  });

  // Update cached spentCents in mission goal.result
  await updateMissionSpentCents(input.organizationId, input.missionId);
}

// ─── Update cached spentCents ───────────────────────────────────────────────────

export async function updateMissionSpentCents(
  organizationId: string,
  missionId: string,
): Promise<void> {
  // Compute authoritative total from usage_ledger
  const [ledgerRow] = await db
    .select({ total: sum(usageLedger.amountCents) })
    .from(usageLedger)
    .where(eq(usageLedger.missionId, missionId))
    .limit(1);

  const totalSpent = typeof ledgerRow?.total === 'number' ? ledgerRow.total : 0;

  // Read current goal
  const [goal] = await db
    .select({ id: goals.id, result: goals.result })
    .from(goals)
    .where(eq(goals.id, missionId))
    .limit(1);

  if (!goal?.result) return;

  const payload = JSON.parse(goal.result) as MissionPayload;
  payload.spentCents = totalSpent;

  // Update display status based on budget state
  if (totalSpent >= payload.budgetCents && payload.budgetCents > 0) {
    payload.displayStatus = 'budget_exhausted';
  }

  await db
    .update(goals)
    .set({
      result: JSON.stringify(payload),
    })
    .where(eq(goals.id, missionId));
}

// ─── Get mission budget overview ────────────────────────────────────────────────

export async function getMissionBudgetOverview(
  missionId: string,
): Promise<{
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  utilizationPct: number;
  byProvider: Record<string, number>;
  byCategory: Record<string, number>;
}> {
  const [goal] = await db
    .select({ result: goals.result })
    .from(goals)
    .where(eq(goals.id, missionId))
    .limit(1);

  const payload = goal?.result ? JSON.parse(goal.result) as MissionPayload : null;
  const budgetCents = payload?.budgetCents ?? 0;

  // Authoritative spent from ledger
  const [totalRow] = await db
    .select({ total: sum(usageLedger.amountCents) })
    .from(usageLedger)
    .where(eq(usageLedger.missionId, missionId))
    .limit(1);

  const spentCents = typeof totalRow?.total === 'number' ? totalRow.total : 0;
  const remainingCents = Math.max(0, budgetCents - spentCents);
  const utilizationPct =
    budgetCents > 0 ? Math.round((spentCents / budgetCents) * 1000) / 10 : 0;

  // By provider
  const [byProviderRows] = await db
    .select({ provider: usageLedger.provider, total: sum(usageLedger.amountCents) })
    .from(usageLedger)
    .where(eq(usageLedger.missionId, missionId))
    .groupBy(usageLedger.provider)
    .limit(100);

  const byProvider: Record<string, number> = {};
  // Handle the case where byProviderRows might be an array or a single row
  const rows = Array.isArray(byProviderRows) ? byProviderRows : [];
  // If it's a single object (common with limit(1) and groupBy), wrap it
  const providerRows = rows.length > 0 ? rows : [];

  for (const row of providerRows) {
    if (row.provider && typeof row.total === 'number') {
      byProvider[row.provider] = row.total;
    }
  }

  // By category
  const [byCategoryRows] = await db
    .select({ category: usageLedger.category, total: sum(usageLedger.amountCents) })
    .from(usageLedger)
    .where(eq(usageLedger.missionId, missionId))
    .groupBy(usageLedger.category)
    .limit(100);

  const byCategory: Record<string, number> = {};
  const catRows = Array.isArray(byCategoryRows) ? byCategoryRows : [];
  for (const row of catRows) {
    if (row.category && typeof row.total === 'number') {
      byCategory[row.category] = row.total;
    }
  }

  return {
    budgetCents,
    spentCents,
    remainingCents,
    utilizationPct,
    byProvider,
    byCategory,
  };
}

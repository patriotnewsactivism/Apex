/** Durable per-day Exa request ceiling. Paid search fails closed when the
 * shared quota ledger is unavailable, leaving other web-search providers live.
 */
import { db, llmRequestUsageDaily } from '@workspace/db';
import { sql, and, eq } from 'drizzle-orm';
import { centralDay } from './brightdata-budget.js';

export const DEFAULT_EXA_SEARCH_DAILY_CAP = 100;
export const EXA_SEARCH_BUDGET_ACCOUNT = 'search:exa';

export function exaSearchDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXA_SEARCH_DAILY_REQUEST_CAP;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EXA_SEARCH_DAILY_CAP;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_EXA_SEARCH_DAILY_CAP;
}

export async function reserveExaSearch(): Promise<{ allowed: boolean; detail?: string }> {
  const cap = exaSearchDailyCap();
  if (cap === 0) return { allowed: false, detail: 'daily request cap reached (disabled)' };
  const day = `ct:${centralDay()}`;
  try {
    const rows = await db.insert(llmRequestUsageDaily)
      .values({ day, account: EXA_SEARCH_BUDGET_ACCOUNT, requests: 1, succeeded: 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: { requests: sql`${llmRequestUsageDaily.requests} + 1`, updatedAt: new Date() },
      })
      .returning({ requests: llmRequestUsageDaily.requests });
    if (Number(rows[0]?.requests ?? 1) <= cap) return { allowed: true };
    // Refuse and return reservations above the cap; this is atomic across replicas.
    await db.update(llmRequestUsageDaily)
      .set({ requests: sql`GREATEST(${llmRequestUsageDaily.requests} - 1, 0)`, updatedAt: new Date() })
      .where(and(eq(llmRequestUsageDaily.day, day), eq(llmRequestUsageDaily.account, EXA_SEARCH_BUDGET_ACCOUNT)));
    return { allowed: false, detail: `daily request cap reached (${cap}/day CT)` };
  } catch (error) {
    console.warn('[exa-search] Cannot verify request cap; paid search disabled for this request:',
      error instanceof Error ? error.message : String(error));
    return { allowed: false, detail: 'daily request cap check unavailable' };
  }
}

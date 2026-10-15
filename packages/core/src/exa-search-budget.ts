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

/** Where reservations are counted. The default is the shared Postgres ledger;
 *  tests swap in an in-memory store so the cap paths run without a database. */
export interface ExaSearchBudgetStore {
  /** Atomically add one reservation for `day` and return the new total. */
  increment(day: string): Promise<number>;
  /** Give one reservation back (used when a reservation lands above the cap). */
  decrement(day: string): Promise<void>;
}

export const postgresExaSearchBudgetStore: ExaSearchBudgetStore = {
  async increment(day) {
    const rows = await db.insert(llmRequestUsageDaily)
      .values({ day, account: EXA_SEARCH_BUDGET_ACCOUNT, requests: 1, succeeded: 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: { requests: sql`${llmRequestUsageDaily.requests} + 1`, updatedAt: new Date() },
      })
      .returning({ requests: llmRequestUsageDaily.requests });
    return Number(rows[0]?.requests ?? 1);
  },
  async decrement(day) {
    await db.update(llmRequestUsageDaily)
      .set({ requests: sql`GREATEST(${llmRequestUsageDaily.requests} - 1, 0)`, updatedAt: new Date() })
      .where(and(eq(llmRequestUsageDaily.day, day), eq(llmRequestUsageDaily.account, EXA_SEARCH_BUDGET_ACCOUNT)));
  },
};

let activeStore: ExaSearchBudgetStore = postgresExaSearchBudgetStore;

/** Test seam: pass a store to use it, or nothing to restore the Postgres ledger. */
export function __setExaSearchBudgetStoreForTests(store?: ExaSearchBudgetStore): void {
  activeStore = store ?? postgresExaSearchBudgetStore;
}

/** Reserve one Exa request against today's cap. Never throws: any failure to
 *  read or write the ledger is reported as "not allowed" so the caller skips
 *  Exa (fail closed for paid search) and moves on to the next provider. */
export async function reserveExaSearch(
  store: ExaSearchBudgetStore = activeStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ allowed: boolean; detail?: string }> {
  const cap = exaSearchDailyCap(env);
  if (cap === 0) return { allowed: false, detail: 'daily request cap reached (disabled)' };
  const day = `ct:${centralDay()}`;
  try {
    if (await store.increment(day) <= cap) return { allowed: true };
    // Refuse and return reservations above the cap; this is atomic across replicas.
    await store.decrement(day).catch(() => undefined);
    return { allowed: false, detail: `daily request cap reached (${cap}/day CT)` };
  } catch (error) {
    console.warn('[exa-search] Cannot verify request cap; paid search disabled for this request:',
      error instanceof Error ? error.message : String(error));
    return { allowed: false, detail: 'daily request cap check unavailable' };
  }
}

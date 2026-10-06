// ─── Bright Data daily request budget ─────────────────────────────────────────
//
// Bright Data bills every /request call (Web Unlocker: $1.50 per 1,000 on the
// operator's account, 2026-10-06), including calls that time out or come back
// with an upstream error. The operator approved a hard spend ceiling of
// $3/day, so this module caps the number of Bright Data requests per Central
// Time day (BRIGHT_DATA_DAILY_REQUEST_CAP, default 2000).
//
// The count is persisted in llm_request_usage_daily — the existing durable
// per-day request counter — so a redeploy or restart cannot hand out a second
// allowance. Rows use day = "ct:YYYY-MM-DD" (Central Time) and account =
// "search:brightdata". The "ct:" prefix keeps them out of the LLM request
// ledger, which only ever reads and resets rows whose day is a bare UTC date.
//
// Every request is reserved BEFORE it is sent with an atomic UPSERT that
// returns the new total, so concurrent searches (and several replicas) cannot
// overshoot the cap. When the cap is reached Bright Data is unavailable until
// the next midnight Central Time; that is logged once, not per call.

export const BRIGHT_DATA_DAILY_REQUEST_CAP_ENV = 'BRIGHT_DATA_DAILY_REQUEST_CAP';
export const DEFAULT_BRIGHT_DATA_DAILY_REQUEST_CAP = 2000;
export const BRIGHT_DATA_BUDGET_ACCOUNT = 'search:brightdata';
const TIME_ZONE = 'America/Chicago';

export interface BrightDataBudgetStore {
  /** Atomically add one request for `dayKey` and return the new total. */
  increment(dayKey: string): Promise<number>;
  /** Give back a reservation that was refused (over the cap) and never sent. */
  decrement(dayKey: string): Promise<void>;
  /** Record that a sent request returned usable results. */
  succeed(dayKey: string): Promise<void>;
  /** Current total for `dayKey` (0 when no row). */
  read(dayKey: string): Promise<number>;
}

export interface BrightDataReservation {
  allowed: boolean;
  /** Requests counted for today, including this one when allowed. */
  used: number;
  cap: number;
  /** Central Time calendar day, YYYY-MM-DD. */
  day: string;
  /** ISO timestamp of the next midnight Central Time. */
  resetsAt: string;
}

/** Parse BRIGHT_DATA_DAILY_REQUEST_CAP. Missing or invalid → default. 0 turns Bright Data off. */
export function brightDataDailyRequestCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[BRIGHT_DATA_DAILY_REQUEST_CAP_ENV] ?? '').trim();
  if (!raw) return DEFAULT_BRIGHT_DATA_DAILY_REQUEST_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_BRIGHT_DATA_DAILY_REQUEST_CAP;
  return Math.floor(n);
}

/** Central Time calendar day for `now`, as YYYY-MM-DD. */
export function centralDay(now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/** The next midnight in Central Time after `now` (DST-safe). */
export function nextCentralMidnight(now: number = Date.now()): Date {
  const today = centralDay(now);
  // Step forward an hour at a time until the Central day changes, then back
  // off to the exact minute; at most ~25 iterations plus 60.
  let t = now;
  while (centralDay(t) === today) t += 3_600_000;
  t -= 3_600_000;
  while (centralDay(t) === today) t += 60_000;
  const d = new Date(t);
  d.setUTCSeconds(0, 0);
  return d;
}

export function brightDataBudgetDayKey(day: string): string {
  return `ct:${day}`;
}

const databaseStore: BrightDataBudgetStore = {
  async increment(dayKey) {
    const [{ db, llmRequestUsageDaily }, { sql }] = await Promise.all([import('@workspace/db'), import('drizzle-orm')]);
    const rows = await db
      .insert(llmRequestUsageDaily)
      .values({ day: dayKey, account: BRIGHT_DATA_BUDGET_ACCOUNT, requests: 1, succeeded: 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: { requests: sql`${llmRequestUsageDaily.requests} + 1`, updatedAt: new Date() },
      })
      .returning({ requests: llmRequestUsageDaily.requests });
    return Number(rows[0]?.requests ?? 1);
  },
  async decrement(dayKey) {
    const [{ db, llmRequestUsageDaily }, { sql, and, eq }] = await Promise.all([import('@workspace/db'), import('drizzle-orm')]);
    await db
      .update(llmRequestUsageDaily)
      .set({ requests: sql`GREATEST(${llmRequestUsageDaily.requests} - 1, 0)`, updatedAt: new Date() })
      .where(and(eq(llmRequestUsageDaily.day, dayKey), eq(llmRequestUsageDaily.account, BRIGHT_DATA_BUDGET_ACCOUNT)));
  },
  async succeed(dayKey) {
    const [{ db, llmRequestUsageDaily }, { sql, and, eq }] = await Promise.all([import('@workspace/db'), import('drizzle-orm')]);
    await db
      .update(llmRequestUsageDaily)
      .set({ succeeded: sql`${llmRequestUsageDaily.succeeded} + 1`, updatedAt: new Date() })
      .where(and(eq(llmRequestUsageDaily.day, dayKey), eq(llmRequestUsageDaily.account, BRIGHT_DATA_BUDGET_ACCOUNT)));
  },
  async read(dayKey) {
    const [{ db, llmRequestUsageDaily }, { and, eq }] = await Promise.all([import('@workspace/db'), import('drizzle-orm')]);
    const rows = await db
      .select({ requests: llmRequestUsageDaily.requests })
      .from(llmRequestUsageDaily)
      .where(and(eq(llmRequestUsageDaily.day, dayKey), eq(llmRequestUsageDaily.account, BRIGHT_DATA_BUDGET_ACCOUNT)));
    return Number(rows[0]?.requests ?? 0);
  },
};

let store: BrightDataBudgetStore = databaseStore;
let state = { day: '', used: 0, exhausted: false, warned: false, storeFailedWarned: false };

function rollover(now: number): void {
  const day = centralDay(now);
  if (state.day !== day) state = { day, used: 0, exhausted: false, warned: false, storeFailedWarned: false };
}

function warnExhausted(cap: number, now: number): void {
  if (state.warned) return;
  state.warned = true;
  console.warn(
    `[brightdata-budget] Daily Bright Data request cap reached (${state.used}/${cap} for ${state.day} CT). ` +
      `Bright Data is unavailable until ${nextCentralMidnight(now).toISOString()} (midnight CT). Set ${BRIGHT_DATA_DAILY_REQUEST_CAP_ENV} to change the cap.`,
  );
}

/**
 * Reserve one Bright Data request for today. Call immediately before sending;
 * a reservation counts as a billed attempt whatever the response turns out to
 * be. Returns allowed=false once the Central Time day's cap is reached.
 */
export async function reserveBrightDataRequest(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<BrightDataReservation> {
  rollover(now);
  const cap = brightDataDailyRequestCap(env);
  const resetsAt = nextCentralMidnight(now).toISOString();
  const refuse = (): BrightDataReservation => {
    state.exhausted = true;
    warnExhausted(cap, now);
    return { allowed: false, used: state.used, cap, day: state.day, resetsAt };
  };
  if (state.exhausted || state.used >= cap) return refuse();

  const dayKey = brightDataBudgetDayKey(state.day);
  let used: number;
  try {
    used = await store.increment(dayKey);
  } catch (err) {
    // The database is the source of truth. If it is unreachable, keep
    // counting in memory so the cap still holds for this process.
    if (!state.storeFailedWarned) {
      state.storeFailedWarned = true;
      console.warn(`[brightdata-budget] Could not persist the Bright Data request count (${err instanceof Error ? err.message : String(err)}); counting in memory for now.`);
    }
    used = state.used + 1;
  }
  if (used > cap) {
    state.used = cap;
    store.decrement(dayKey).catch(() => undefined);
    return refuse();
  }
  state.used = Math.max(state.used, used);
  return { allowed: true, used: state.used, cap, day: state.day, resetsAt };
}

/** Record that a Bright Data request returned usable results (best effort). */
export function recordBrightDataSuccess(now: number = Date.now()): void {
  store.succeed(brightDataBudgetDayKey(centralDay(now))).catch(() => undefined);
}

/** Today's count and cap, refreshed from the database when it is reachable. */
export async function brightDataBudgetSnapshot(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<{ day: string; used: number; cap: number; exhausted: boolean; resetsAt: string }> {
  rollover(now);
  try {
    state.used = Math.max(state.used, await store.read(brightDataBudgetDayKey(state.day)));
  } catch {
    /* keep the in-memory count */
  }
  const cap = brightDataDailyRequestCap(env);
  return { day: state.day, used: state.used, cap, exhausted: state.exhausted || state.used >= cap, resetsAt: nextCentralMidnight(now).toISOString() };
}

/** Test hook: swap the persistence layer and clear in-memory state. */
export function __setBrightDataBudgetStoreForTests(next: BrightDataBudgetStore | null): void {
  store = next ?? databaseStore;
  state = { day: '', used: 0, exhausted: false, warned: false, storeFailedWarned: false };
}

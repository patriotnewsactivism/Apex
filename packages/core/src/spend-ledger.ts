/**
 * Daily USD spend ledger — observability for paid inference.
 *
 * GLM 5.3 FlashX is an operator-approved unrestricted continuity route.
 * This ledger records actual paid usage for dashboards, projections, and
 * auditability, but its historical budget/pacing helpers no longer gate
 * FlashX routing. OpenRouter/Z.ai billing and upstream limits are authoritative.
 *
 * The helper functions remain for backward-compatible telemetry surfaces and
 * historical diagnostics. Do not use them to disable or pace FlashX without
 * a new operator decision.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** Money is held in micro-dollars so a day of additions cannot drift the way
 *  repeated float arithmetic on fractions of a cent does. */
const MICROS_PER_USD = 1_000_000;

interface LedgerState {
  day: string;
  /** Micro-dollars spent today, by provider. */
  providers: Record<string, number>;
}

const LEDGER_PATH =
  process.env.APEX_SPEND_LEDGER_PATH ?? '/tmp/apex/spend-ledger.json';
const UTC_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_SPEND_USD = 2;
/** Enough to let a restart do useful paid work at once without allowing the
 *  whole day's budget to leave in the first minutes. */
const DEFAULT_BURST_USD = 0.15;

function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

function emptyState(day = utcDay()): LedgerState {
  return { day, providers: {} };
}

function load(): LedgerState {
  try {
    if (!existsSync(LEDGER_PATH)) return emptyState();
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as LedgerState;
    if (!parsed || typeof parsed.day !== 'string' || typeof parsed.providers !== 'object') {
      return emptyState();
    }
    if (parsed.day !== utcDay()) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

let state: LedgerState = load();
let databasePersistenceReady = false;

function persist(): void {
  try {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    writeFileSync(LEDGER_PATH, JSON.stringify(state), 'utf8');
  } catch {
    // In-memory accounting still works for this process.
  }
}

function rolloverIfNeeded(at: number = Date.now()): void {
  const today = utcDay(at);
  if (state.day !== today) {
    state = emptyState(today);
    persist();
  }
}

/** Daily budget in micro-dollars. 0 disables paid spend outright. */
export function dailySpendCapMicros(): number {
  const raw = process.env.APEX_DAILY_SPEND_USD;
  if (raw === undefined || raw.trim() === '') {
    return Math.round(DEFAULT_DAILY_SPEND_USD * MICROS_PER_USD);
  }
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) {
    return Math.round(DEFAULT_DAILY_SPEND_USD * MICROS_PER_USD);
  }
  return Math.round(usd * MICROS_PER_USD);
}

function spendPacingEnabled(): boolean {
  const normalized = (process.env.APEX_SPEND_PACING_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'disabled', 'no'].includes(normalized);
}

function burstMicros(cap: number): number {
  const raw = process.env.APEX_SPEND_PACING_BURST_USD;
  const usd =
    raw === undefined || raw.trim() === '' ? DEFAULT_BURST_USD : Number(raw);
  const micros = Number.isFinite(usd)
    ? Math.max(0, Math.round(usd * MICROS_PER_USD))
    : Math.round(DEFAULT_BURST_USD * MICROS_PER_USD);
  return Math.min(cap, micros);
}

export type SpendCapacityReason = 'disabled' | 'available' | 'paced' | 'daily_cap';

export interface SpendCapacityWindow {
  capMicros: number;
  spentMicros: number;
  /** Budget the pacing ramp has released so far today. */
  releasedMicros: number;
  availableMicros: number;
  allowed: boolean;
  reason: SpendCapacityReason;
  resumeAt: string | null;
}

/**
 * Pure UTC-day pacing calculation, the same burst-then-ramp shape the token and
 * request ledgers use, so all three behave identically to an operator.
 *
 * Pacing matters more here than anywhere else: a budget denominated in money
 * has no natural rate limit of its own, so without a ramp a busy hour can spend
 * the day's entire allowance and leave the workforce on free models from
 * mid-morning onward.
 */
export function calculateSpendCapacityWindow(input: {
  capMicros: number;
  spentMicros: number;
  requestedMicros?: number;
  at?: number;
  pacingEnabled?: boolean;
  burstMicros?: number;
}): SpendCapacityWindow {
  const at = input.at ?? Date.now();
  const capMicros = Number.isFinite(input.capMicros)
    ? Math.max(0, Math.floor(input.capMicros))
    : 0;
  const spentMicros = Number.isFinite(input.spentMicros)
    ? Math.max(0, Math.floor(input.spentMicros))
    : 0;
  const requestedMicros = Number.isFinite(input.requestedMicros)
    ? Math.max(0, Math.floor(input.requestedMicros ?? 0))
    : 0;

  // A zero cap is not "uncapped" here, unlike the request ledger: money must
  // fail closed. 0 means spend nothing, which is the free-only posture.
  if (capMicros === 0) {
    return {
      capMicros,
      spentMicros,
      releasedMicros: 0,
      availableMicros: 0,
      allowed: false,
      reason: 'disabled',
      resumeAt: null,
    };
  }

  const date = new Date(at);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const nextDay = dayStart + UTC_DAY_MS;
  const elapsed = Math.min(UTC_DAY_MS, Math.max(0, at - dayStart));
  const burst = Math.min(
    capMicros,
    Number.isFinite(input.burstMicros)
      ? Math.max(0, Math.floor(input.burstMicros ?? 0))
      : burstMicros(capMicros),
  );
  const pacing = input.pacingEnabled ?? spendPacingEnabled();
  const toAccrue = Math.max(0, capMicros - burst);
  const releasedMicros = pacing
    ? Math.min(capMicros, Math.floor(burst + (toAccrue * elapsed) / UTC_DAY_MS))
    : capMicros;
  const availableMicros = Math.max(0, releasedMicros - spentMicros);
  const target = spentMicros + requestedMicros;

  if (spentMicros >= capMicros || target > capMicros) {
    return {
      capMicros,
      spentMicros,
      releasedMicros,
      availableMicros,
      allowed: false,
      reason: 'daily_cap',
      resumeAt: new Date(nextDay).toISOString(),
    };
  }

  if (target > releasedMicros) {
    const requiredElapsed =
      toAccrue > 0
        ? Math.ceil((Math.max(0, target - burst) * UTC_DAY_MS) / toAccrue)
        : UTC_DAY_MS;
    const resumeAt = Math.min(nextDay, dayStart + requiredElapsed);
    return {
      capMicros,
      spentMicros,
      releasedMicros,
      availableMicros,
      allowed: false,
      reason: 'paced',
      resumeAt: new Date(Math.max(at + 1_000, resumeAt)).toISOString(),
    };
  }

  return {
    capMicros,
    spentMicros,
    releasedMicros,
    availableMicros,
    allowed: true,
    reason: 'available',
    resumeAt: null,
  };
}

async function persistDatabaseDelta(day: string, provider: string, micros: number): Promise<void> {
  try {
    const [{ db, llmSpendDaily }, { sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    await db
      .insert(llmSpendDaily)
      .values({ day, provider, spentMicros: micros, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmSpendDaily.day, llmSpendDaily.provider],
        set: {
          spentMicros: sql`${llmSpendDaily.spentMicros} + ${micros}`,
          updatedAt: new Date(),
        },
      });
    databasePersistenceReady = true;
  } catch {
    databasePersistenceReady = false;
  }
}

/**
 * Hydrate today's spend from Postgres before agents start.
 *
 * Load-bearing for the same reason the request ledger's is, and with money at
 * stake rather than quota: Cloud Run replaces the container on every deploy, so
 * a memory-only spend ledger would hand the workforce a fresh full budget after
 * each one. Three deploys in a day would authorize three days of spend.
 */
export async function initializeSpendLedgerPersistence(): Promise<boolean> {
  try {
    rolloverIfNeeded();
    const [{ db, llmSpendDaily }, { eq, sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    const rows = await db.select().from(llmSpendDaily).where(eq(llmSpendDaily.day, state.day));
    for (const row of rows) {
      state.providers[row.provider] = Math.max(
        state.providers[row.provider] ?? 0,
        row.spentMicros,
      );
    }
    await Promise.all(
      Object.entries(state.providers).map(([provider, micros]) =>
        db
          .insert(llmSpendDaily)
          .values({ day: state.day, provider, spentMicros: micros, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [llmSpendDaily.day, llmSpendDaily.provider],
            set: {
              spentMicros: sql`GREATEST(${llmSpendDaily.spentMicros}, ${micros})`,
              updatedAt: new Date(),
            },
          }),
      ),
    );
    persist();
    databasePersistenceReady = true;
    return true;
  } catch {
    databasePersistenceReady = false;
    return false;
  }
}

/** Record the cost of one paid response. */
export function recordSpend(provider: string, usd: number): void {
  try {
    rolloverIfNeeded();
    const micros = Number.isFinite(usd) ? Math.max(0, Math.round(usd * MICROS_PER_USD)) : 0;
    if (micros === 0) return;
    state.providers[provider] = (state.providers[provider] ?? 0) + micros;
    persist();
    void persistDatabaseDelta(state.day, provider, micros);
  } catch {
    // Spend accounting must never take inference down.
  }
}

export function spentMicrosToday(): number {
  rolloverIfNeeded();
  let sum = 0;
  for (const micros of Object.values(state.providers)) sum += micros;
  return sum;
}

/**
 * Can a paid request be issued right now?
 *
 * `requestedUsd` is the caller's estimate of what the call will cost. Charging
 * an estimate up front and the real figure afterwards is deliberate: the true
 * cost is only known once the response returns, and a budget that only counts
 * settled requests would let an unbounded number start concurrently.
 */
export function spendCapacityWindow(
  requestedUsd = 0,
  at: number = Date.now(),
  pacingEnabled?: boolean,
): SpendCapacityWindow {
  rolloverIfNeeded(at);
  return calculateSpendCapacityWindow({
    capMicros: dailySpendCapMicros(),
    spentMicros: spentMicrosToday(),
    requestedMicros: Math.max(0, Math.round(requestedUsd * MICROS_PER_USD)),
    at,
    pacingEnabled,
  });
}

/**
 * Headroom kept free so the cap is a ceiling rather than an approximate one.
 *
 * Cost is only known after a response returns, so a check with no lookahead
 * authorizes a call while `spent < cap` and then books its cost on top —
 * overshooting by up to one call. Measured: a $2.00 cap settled at $2.0004,
 * and with APEX_MAX_CONCURRENT_LLM_CALLS in flight the overshoot multiplies.
 *
 * Requiring this much headroom before admitting a paid call means the last one
 * admitted still lands inside the cap. It costs at most this much unspent
 * budget per day, which is the right trade for a limit that actually holds.
 */
const DEFAULT_CALL_RESERVE_USD = 0.01;

function callReserveUsd(): number {
  const raw = process.env.APEX_SPEND_CALL_RESERVE_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CALL_RESERVE_USD;
  const usd = Number(raw);
  return Number.isFinite(usd) && usd >= 0 ? usd : DEFAULT_CALL_RESERVE_USD;
}

/** The same window paidSpendAvailable() checks, but with resumeAt/reason
 *  intact for a caller that needs to explain — not just gate on — a paid
 *  route currently being unaffordable (e.g. a workspace-wide capacity pause
 *  when the free tier is also exhausted at the same moment). `pacingEnabled:
 *  false` skips the smoothing ramp and checks only the hard daily $ cap —
 *  for an interactive human request, which cannot cause the runaway burn the
 *  ramp exists to prevent. */
export function paidSpendCapacityWindow(
  at: number = Date.now(),
  pacingEnabled?: boolean,
): SpendCapacityWindow {
  return spendCapacityWindow(callReserveUsd(), at, pacingEnabled);
}

/** True when paid inference has budget right now. False drops the paid rung
 *  from the routing order, leaving APEX on free models alone.
 *  `pacingEnabled: false` checks only the hard daily $ cap, skipping the
 *  smoothing ramp — see paidSpendCapacityWindow(). */
export function paidSpendAvailable(at: number = Date.now(), pacingEnabled?: boolean): boolean {
  return paidSpendCapacityWindow(at, pacingEnabled).allowed;
}

export interface SpendLedgerSnapshot {
  day: string;
  persistence: 'postgres+memory' | 'memory-only';
  spentUsd: number;
  capUsd: number;
  releasedUsd: number;
  remainingUsd: number;
  pacingEnabled: boolean;
  state: SpendCapacityReason;
  resumeAt: string | null;
  /** Spend/day at today's rate. Null before enough of the day has elapsed for
   *  extrapolation to mean anything. */
  projectedUsd: number | null;
  providers: Array<{ provider: string; spentUsd: number }>;
}

function usd(micros: number): number {
  return Math.round((micros / MICROS_PER_USD) * 10_000) / 10_000;
}

export function getSpendLedgerSnapshot(at: number = Date.now()): SpendLedgerSnapshot {
  rolloverIfNeeded(at);
  const window = spendCapacityWindow(0, at);
  const date = new Date(at);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const elapsed = Math.max(0, at - dayStart);
  const spent = spentMicrosToday();
  return {
    day: state.day,
    persistence: databasePersistenceReady ? 'postgres+memory' : 'memory-only',
    spentUsd: usd(spent),
    capUsd: usd(window.capMicros),
    releasedUsd: usd(window.releasedMicros),
    remainingUsd: usd(Math.max(0, window.capMicros - spent)),
    pacingEnabled: spendPacingEnabled(),
    state: window.reason,
    resumeAt: window.resumeAt,
    projectedUsd:
      elapsed >= 15 * 60 * 1000 ? usd(Math.round((spent * UTC_DAY_MS) / elapsed)) : null,
    providers: Object.entries(state.providers)
      .map(([provider, micros]) => ({ provider, spentUsd: usd(micros) }))
      .sort((a, b) => b.spentUsd - a.spentUsd),
  };
}

export async function resetSpendLedger(): Promise<void> {
  const day = state.day;
  state = emptyState();
  persist();
  try {
    const [{ db, llmSpendDaily }, { eq }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    await db.delete(llmSpendDaily).where(eq(llmSpendDaily.day, day));
  } catch {
    databasePersistenceReady = false;
  }
}

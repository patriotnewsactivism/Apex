/**
 * Daily USD spend ledger for paid inference.
 *
 * APEX_DAILY_SPEND_USD is a process-local hard cap on aggregate metered
 * spend: every provider recordSpend has booked, including historic Qwen.
 * Dropping that history would silently raise available continuity dollars.
 * Default 0 spends nothing. In-flight reservations are deducted until
 * release. This is not a distributed lock, and tryReservePaidSpend does not
 * admit Qwen direct calls — the caller routes that plan separately.
 *
 * Background admission may use the cap minus APEX_SPEND_PRIORITY_RESERVE_PCT
 * (default 25). Operator-priority calls may use the full hard cap. Pacing
 * is unchanged.
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
  /** Prompt tokens served from provider-side prefix cache today, by provider.
   *  Nous caches automatically (input_cache_read pricing); tracking the hit
   *  rate shows how much paid input is being avoided. */
  cachedTokens: Record<string, number>;
}

const LEDGER_PATH =
  process.env.APEX_SPEND_LEDGER_PATH ?? '/tmp/apex/spend-ledger.json';
const UTC_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_SPEND_USD = 0;
/** Enough to let a restart do useful paid work at once without allowing the
 *  whole day's budget to leave in the first minutes. */
const DEFAULT_BURST_USD = 0;

function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

function emptyState(day = utcDay()): LedgerState {
  return { day, providers: {}, cachedTokens: {} };
}

function isCountMap(value: unknown): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function load(): LedgerState {
  try {
    if (!existsSync(LEDGER_PATH)) return emptyState();
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as Partial<LedgerState> | null;
    if (!parsed || typeof parsed.day !== 'string' || !isCountMap(parsed.providers)) {
      return emptyState();
    }
    if (parsed.day !== utcDay()) return emptyState();
    // A same-day file written before cachedTokens existed has no such map.
    // Kept as-is, every recordCachedTokens call would throw into its catch and
    // getSpendLedgerSnapshot() would throw on Object.entries(undefined).
    return {
      day: parsed.day,
      providers: parsed.providers,
      cachedTokens: isCountMap(parsed.cachedTokens) ? parsed.cachedTokens : {},
    };
  } catch {
    return emptyState();
  }
}

let state: LedgerState = load();
let databasePersistenceReady = false;

/** Process-local in-flight holds. Not persisted and not cleared on day rollover:
 *  an in-flight call must keep reducing admission after UTC midnight, and
 *  release() must not refund booked spend or credit the new day twice. */
interface InFlightHold {
  id: number;
  micros: number;
}
let inFlightHolds: InFlightHold[] = [];
let nextHoldId = 1;

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
    // Holds stay. Clearing them here would replenish the new day's budget
    // while yesterday's calls are still in flight.
  }
}

/** Aggregate daily cap in micro-dollars. 0 spends nothing (fail closed). */
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

export function recordCachedTokens(provider: string, tokens: number): void {
  try {
    rolloverIfNeeded();
    const n = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
    if (n === 0) return;
    state.cachedTokens[provider] = (state.cachedTokens[provider] ?? 0) + n;
    persist();
  } catch {
    // Cached-token accounting must never take inference down.
  }
}

export function spentMicrosToday(): number {
  rolloverIfNeeded();
  return bookedMicros();
}

function bookedMicros(): number {
  let sum = 0;
  for (const micros of Object.values(state.providers)) {
    if (typeof micros === 'number' && Number.isFinite(micros)) sum += micros;
  }
  return sum;
}

function heldMicrosTotal(): number {
  let sum = 0;
  for (const hold of inFlightHolds) sum += hold.micros;
  return sum;
}

/** Booked aggregate spend plus in-flight holds. Holds are not a second copy of spend. */
function committedMicros(): number {
  return bookedMicros() + heldMicrosTotal();
}

/**
 * Probe whether a paid request fits the aggregate hard cap right now.
 * Outstanding reservations are included. This does not itself hold.
 */
export function spendCapacityWindow(
  requestedUsd = 0,
  at: number = Date.now(),
  pacingEnabled?: boolean,
): SpendCapacityWindow {
  rolloverIfNeeded(at);
  const capMicros = dailySpendCapMicros();
  const spentMicros = committedMicros();
  if (!Number.isFinite(requestedUsd) || requestedUsd < 0) {
    return {
      capMicros,
      spentMicros,
      releasedMicros: 0,
      availableMicros: 0,
      allowed: false,
      reason: capMicros === 0 ? 'disabled' : 'daily_cap',
      resumeAt: null,
    };
  }
  return calculateSpendCapacityWindow({
    capMicros,
    spentMicros,
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

export type SpendPriority = 'background' | 'operator';

/** Percent of the hard cap held back from background dispatch. Invalid values stay at 25. */
export function priorityReservePct(): number {
  const raw = process.env.APEX_SPEND_PRIORITY_RESERVE_PCT;
  if (raw === undefined || raw.trim() === '') return 25;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 25;
  return pct;
}

function resolvePriority(priority: SpendPriority | undefined, fallback: SpendPriority): SpendPriority {
  return priority === 'operator' || priority === 'background' ? priority : fallback;
}

function backgroundCapMicros(capMicros: number): number {
  const reserve = Math.ceil((capMicros * priorityReservePct()) / 100);
  return Math.max(0, capMicros - reserve);
}

function applyBackgroundCeiling(
  window: SpendCapacityWindow,
  priority: SpendPriority,
  at: number,
  requestedMicros: number,
): SpendCapacityWindow {
  if (priority !== 'background' || window.capMicros <= 0 || window.reason === 'disabled') return window;
  const ceiling = backgroundCapMicros(window.capMicros);
  const committed = window.spentMicros;
  const availableMicros = Math.max(0, Math.min(window.availableMicros, ceiling - committed));
  if (!window.allowed && window.reason === 'paced') {
    return { ...window, availableMicros };
  }
  if (committed >= ceiling || committed + requestedMicros > ceiling) {
    const date = new Date(at);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return {
      ...window,
      availableMicros,
      allowed: false,
      reason: 'daily_cap',
      resumeAt: new Date(dayStart + UTC_DAY_MS).toISOString(),
    };
  }
  return { ...window, availableMicros };
}

function isQwenDirectProvider(provider: string | undefined): boolean {
  return typeof provider === 'string' && /qwen/i.test(provider);
}

/**
 * Same gate as paidSpendAvailable(), with resumeAt/reason.
 *
 * Existing 1- and 2-argument calls keep the full hard cap so operator-lane
 * and request-ledger probes do not lose the protected reserve. Pass
 * `'background'` to apply it. The optional fourth argument is an exact
 * lookahead; omit it to keep the $0.01 call reserve. In-flight holds are
 * always deducted. Pacing math is unchanged.
 */
export function paidSpendCapacityWindow(
  at: number = Date.now(),
  pacingEnabled?: boolean,
  priority?: SpendPriority,
  requestedUsd?: number,
): SpendCapacityWindow {
  const estimate = requestedUsd === undefined ? callReserveUsd() : requestedUsd;
  const resolved = resolvePriority(priority, 'operator');
  const window = spendCapacityWindow(estimate, at, pacingEnabled);
  const requestedMicros = Number.isFinite(estimate) && estimate >= 0
    ? Math.max(0, Math.round(estimate * MICROS_PER_USD))
    : 0;
  return applyBackgroundCeiling(window, resolved, at, requestedMicros);
}

/** Full hard cap unless priority is `'background'`. */
export function paidSpendAvailable(
  at: number = Date.now(),
  pacingEnabled?: boolean,
  priority?: SpendPriority,
): boolean {
  return paidSpendCapacityWindow(at, pacingEnabled, priority).allowed;
}

export interface SpendLedgerSnapshot {
  day: string;
  /** True: this snapshot's allowed/reason gates paid continuity. Not observational. */
  enforced: boolean;
  /** Aggregate recorded dollars. Historic Qwen stays inside the cap. */
  capScope: 'aggregate-metered-spend';
  qwenCountedInCap: true;
  /** This reserve API does not admit Qwen direct. The caller handles that route. */
  qwenDirectAdmitted: false;
  /** Reservations are process-local. There is no cluster-wide lock. */
  distributedHardCap: false;
  processLocalReservations: true;
  persistence: 'postgres+memory' | 'memory-only';
  spentUsd: number;
  reservedUsd: number;
  availableUsd: number;
  backgroundAvailableUsd: number;
  capUsd: number;
  priorityReservePct: number;
  priorityReserveUsd: number;
  releasedUsd: number;
  remainingUsd: number;
  pacingEnabled: boolean;
  state: SpendCapacityReason;
  resumeAt: string | null;
  /** Spend/day at today's rate. Null before enough of the day has elapsed for
   *  extrapolation to mean anything. */
  projectedUsd: number | null;
  providers: Array<{ provider: string; spentUsd: number }>;
  /** Prompt tokens served from provider-side prefix cache today, by provider. */
  cachedTokens: Array<{ provider: string; tokens: number }>;
  dispatch: {
    processLocal: true;
    distributedHardCap: false;
    background: { allowed: boolean; reason: SpendCapacityReason; availableUsd: number; resumeAt: string | null };
    operator: { allowed: boolean; reason: SpendCapacityReason; availableUsd: number; resumeAt: string | null };
  };
}

function usd(micros: number): number {
  return Math.round((micros / MICROS_PER_USD) * 10_000) / 10_000;
}

export function getSpendLedgerSnapshot(at: number = Date.now()): SpendLedgerSnapshot {
  rolloverIfNeeded(at);
  const full = spendCapacityWindow(0, at);
  const background = paidSpendCapacityWindow(at, undefined, 'background');
  const operator = paidSpendCapacityWindow(at, undefined, 'operator');
  const date = new Date(at);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const elapsed = Math.max(0, at - dayStart);
  const spent = bookedMicros();
  const held = heldMicrosTotal();
  const reservePct = priorityReservePct();
  const reserveMicros = Math.ceil((full.capMicros * reservePct) / 100);
  const gate = (window: SpendCapacityWindow) => ({
    allowed: window.allowed,
    reason: window.reason,
    availableUsd: usd(window.availableMicros),
    resumeAt: window.resumeAt,
  });
  return {
    day: state.day,
    enforced: true,
    capScope: 'aggregate-metered-spend',
    qwenCountedInCap: true,
    qwenDirectAdmitted: false,
    distributedHardCap: false,
    processLocalReservations: true,
    persistence: databasePersistenceReady ? 'postgres+memory' : 'memory-only',
    spentUsd: usd(spent),
    reservedUsd: usd(held),
    availableUsd: usd(operator.availableMicros),
    backgroundAvailableUsd: usd(background.availableMicros),
    capUsd: usd(full.capMicros),
    priorityReservePct: reservePct,
    priorityReserveUsd: usd(reserveMicros),
    releasedUsd: usd(full.releasedMicros),
    remainingUsd: usd(Math.max(0, full.capMicros - spent)),
    pacingEnabled: spendPacingEnabled(),
    state: background.reason,
    resumeAt: background.resumeAt,
    projectedUsd:
      elapsed >= 15 * 60 * 1000 ? usd(Math.round((spent * UTC_DAY_MS) / elapsed)) : null,
    providers: Object.entries(state.providers)
      .map(([provider, micros]) => ({ provider, spentUsd: usd(micros) }))
      .sort((a, b) => b.spentUsd - a.spentUsd),
    cachedTokens: Object.entries(state.cachedTokens)
      .map(([provider, tokens]) => ({ provider, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    dispatch: {
      processLocal: true,
      distributedHardCap: false,
      background: gate(background),
      operator: gate(operator),
    },
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

export interface PaidSpendReservation extends SpendCapacityWindow {
  held: boolean;
  heldMicros: number;
  heldUsd: number;
  priority: SpendPriority;
  processLocal: true;
  distributedHardCap: false;
  /** Idempotent. Drops the in-flight hold only. Does not book or refund spend. */
  release: () => void;
}

function deniedReservation(
  window: SpendCapacityWindow,
  priority: SpendPriority,
): PaidSpendReservation {
  return {
    ...window,
    allowed: false,
    held: false,
    heldMicros: 0,
    heldUsd: 0,
    priority,
    processLocal: true,
    distributedHardCap: false,
    release() {},
  };
}

/**
 * Synchronously reserve paid-continuity headroom before fetch.
 *
 * Process-local only — not a distributed hard cap. The check and the hold
 * happen before this function returns; it never awaits.
 *
 * Does not admit Qwen direct. Do not call it for that route. Recorded Qwen
 * dollars already in the ledger still count toward the aggregate cap.
 *
 * Default priority is background (cap minus the operator reserve). Pass
 * `{ priority: 'operator' }` to use the full hard cap. Pacing is unchanged.
 *
 * Caller books the actual cost with recordSpend exactly once, then release()
 * in finally. Success order: recordSpend(actual), then release(). release()
 * is idempotent and must not be treated as a booking.
 */
export function tryReservePaidSpend(
  requestedUsd: number,
  options?: {
    priority?: SpendPriority;
    at?: number;
    pacingEnabled?: boolean;
    provider?: string;
  },
): PaidSpendReservation {
  const at = options?.at ?? Date.now();
  const priority = resolvePriority(options?.priority, 'background');
  const pacingEnabled = options?.pacingEnabled;
  if (isQwenDirectProvider(options?.provider)) {
    const window = spendCapacityWindow(0, at, pacingEnabled);
    return deniedReservation({ ...window, reason: 'disabled', allowed: false, resumeAt: null }, priority);
  }
  if (!Number.isFinite(requestedUsd) || requestedUsd < 0) {
    return deniedReservation(spendCapacityWindow(requestedUsd, at, pacingEnabled), priority);
  }
  const estimate = Math.max(requestedUsd, callReserveUsd());
  const window = paidSpendCapacityWindow(at, pacingEnabled, priority, estimate);
  if (!window.allowed || window.capMicros <= 0) {
    return deniedReservation(window, priority);
  }
  const micros = Math.max(0, Math.round(estimate * MICROS_PER_USD));
  if (micros <= 0) {
    return {
      ...window,
      held: false,
      heldMicros: 0,
      heldUsd: 0,
      priority,
      processLocal: true,
      distributedHardCap: false,
      release() {},
    };
  }
  const id = nextHoldId++;
  inFlightHolds.push({ id, micros });
  let released = false;
  return {
    ...window,
    allowed: true,
    held: true,
    heldMicros: micros,
    heldUsd: usd(micros),
    priority,
    processLocal: true,
    distributedHardCap: false,
    release() {
      if (released) return;
      released = true;
      const index = inFlightHolds.findIndex((hold) => hold.id === id);
      if (index >= 0) inFlightHolds.splice(index, 1);
    },
  };
}

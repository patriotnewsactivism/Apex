/** 
 * Token ledger — observable per-provider token accounting plus optional caps.
 *
 * Free-first routing lives in llm-client.ts. This module records usage but does
 * not assume that a large token allowance is free. APEX's default cost control
 * is provider-side free quotas plus fail-closed paid routing.
 *
 * By default there is NO workspace token cap. Providers with an explicit cap
 * are paced across the UTC day so a restart/startup swarm cannot spend the
 * entire allowance before the rest of the business day begins:
 *   APEX_TOKEN_CAP_TOTAL=0
 *   APEX_TOKEN_CAPS=groq:200000
 *   APEX_TOKEN_PACING_ENABLED=true
 *   APEX_TOKEN_PACING_BURST_TOKENS=12000
 *
 * Operators may add token caps as secondary operational controls, but paid
 * Mistral remains independently disabled unless APEX_PAID_LLM_MODE is enabled.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface ProviderDaySpend {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

interface LedgerState {
  day: string;
  providers: Record<string, ProviderDaySpend>;
}

const LEDGER_PATH =
  process.env.APEX_TOKEN_LEDGER_PATH ?? "/tmp/apex/token-ledger.json";
const UTC_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PACING_BURST_TOKENS = 12_000;
const CAPACITY_PROBE_TOKENS = 4_096;

const providerReservations = new Map<string, number>();
let totalReservations = 0;

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
    providerReservations.clear();
    totalReservations = 0;
    persist();
  }
}

function parseCaps(): Record<string, number> {
  const raw = process.env.APEX_TOKEN_CAPS;
  if (!raw?.trim()) return {};

  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [name, value] = part.split(':').map((piece) => piece?.trim());
    const cap = Number(value);
    if (name && Number.isFinite(cap) && cap > 0) out[name] = cap;
  }
  return out;
}

function totalCap(): number {
  const raw = process.env.APEX_TOKEN_CAP_TOTAL;
  if (raw === undefined || raw.trim() === '') return 0;
  const cap = Number(raw);
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
}

function tokenPacingEnabled(): boolean {
  const normalized = (process.env.APEX_TOKEN_PACING_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "disabled", "no"].includes(normalized);
}

function pacingBurstTokens(cap: number): number {
  const raw = Number(
    process.env.APEX_TOKEN_PACING_BURST_TOKENS ?? DEFAULT_PACING_BURST_TOKENS,
  );
  const configured = Number.isFinite(raw)
    ? Math.max(0, Math.floor(raw))
    : DEFAULT_PACING_BURST_TOKENS;
  return Math.min(cap, configured);
}

export type TokenCapacityReason =
  | "uncapped"
  | "available"
  | "paced"
  | "daily_cap";

export interface TokenCapacityWindow {
  cap: number;
  usedTokens: number;
  reservedTokens: number;
  requestedTokens: number;
  pacingAllowance: number;
  availableTokens: number | null;
  allowed: boolean;
  reason: TokenCapacityReason;
  resumeAt: string | null;
}

/** Pure UTC-day pacing calculation used by the runtime and deterministic CI.
 * The allowance grows continuously from one small burst through the full cap.
 * `reservedTokens` closes the concurrency race where several agents used to
 * pass the same cap check before any of their responses were recorded. */
export function calculateTokenCapacityWindow(input: {
  cap: number;
  usedTokens: number;
  reservedTokens?: number;
  requestedTokens?: number;
  at?: number;
  pacingEnabled?: boolean;
  burstTokens?: number;
}): TokenCapacityWindow {
  const at = input.at ?? Date.now();
  const cap = Number.isFinite(input.cap)
    ? Math.max(0, Math.floor(input.cap))
    : 0;
  const usedTokens = Number.isFinite(input.usedTokens)
    ? Math.max(0, Math.floor(input.usedTokens))
    : 0;
  const reservedTokens = Number.isFinite(input.reservedTokens)
    ? Math.max(0, Math.floor(input.reservedTokens ?? 0))
    : 0;
  const requestedTokens = Number.isFinite(input.requestedTokens)
    ? Math.max(0, Math.floor(input.requestedTokens ?? 0))
    : 0;

  if (cap === 0) {
    return {
      cap,
      usedTokens,
      reservedTokens,
      requestedTokens,
      pacingAllowance: 0,
      availableTokens: null,
      allowed: true,
      reason: "uncapped",
      resumeAt: null,
    };
  }

  const date = new Date(at);
  const dayStart = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  const nextDay = dayStart + UTC_DAY_MS;
  const elapsed = Math.min(UTC_DAY_MS, Math.max(0, at - dayStart));
  const burst = Math.min(
    cap,
    Number.isFinite(input.burstTokens)
      ? Math.max(0, Math.floor(input.burstTokens ?? 0))
      : pacingBurstTokens(cap),
  );
  const pacing = input.pacingEnabled ?? tokenPacingEnabled();
  const tokensToAccrue = Math.max(0, cap - burst);
  const pacingAllowance = pacing
    ? Math.min(cap, Math.floor(burst + (tokensToAccrue * elapsed) / UTC_DAY_MS))
    : cap;
  const committed = usedTokens + reservedTokens;
  const target = committed + requestedTokens;
  const availableTokens = Math.max(0, pacingAllowance - committed);

  if (committed >= cap || target > cap) {
    return {
      cap,
      usedTokens,
      reservedTokens,
      requestedTokens,
      pacingAllowance,
      availableTokens,
      allowed: false,
      reason: "daily_cap",
      resumeAt: new Date(nextDay).toISOString(),
    };
  }

  if (target > pacingAllowance) {
    const requiredElapsed =
      tokensToAccrue > 0
        ? Math.ceil((Math.max(0, target - burst) * UTC_DAY_MS) / tokensToAccrue)
        : UTC_DAY_MS;
    const resumeAt = Math.min(nextDay, dayStart + requiredElapsed);
    return {
      cap,
      usedTokens,
      reservedTokens,
      requestedTokens,
      pacingAllowance,
      availableTokens,
      allowed: false,
      reason: "paced",
      resumeAt: new Date(Math.max(at + 1_000, resumeAt)).toISOString(),
    };
  }

  return {
    cap,
    usedTokens,
    reservedTokens,
    requestedTokens,
    pacingAllowance,
    availableTokens,
    allowed: true,
    reason: "available",
    resumeAt: null,
  };
}

export interface TokenCapacityReservation extends TokenCapacityWindow {
  release: () => void;
}

function makeReservation(
  window: TokenCapacityWindow,
  reserve: () => void,
  release: () => void,
): TokenCapacityReservation {
  let released = false;
  if (window.allowed && window.cap > 0 && window.requestedTokens > 0) reserve();
  return {
    ...window,
    release: () => {
      if (released) return;
      released = true;
      if (window.allowed && window.cap > 0 && window.requestedTokens > 0)
        release();
    },
  };
}

/** Atomically reserves expected workspace capacity for one in-flight request. */
export function reserveTotalTokenCapacity(
  requestedTokens: number,
): TokenCapacityReservation {
  rolloverIfNeeded();
  const requested = Math.max(0, Math.floor(requestedTokens));
  const window = calculateTokenCapacityWindow({
    cap: totalCap(),
    usedTokens: totalTokensToday(),
    reservedTokens: totalReservations,
    requestedTokens: requested,
  });
  return makeReservation(
    window,
    () => {
      totalReservations += requested;
    },
    () => {
      totalReservations = Math.max(0, totalReservations - requested);
    },
  );
}

/** Atomically reserves expected capacity for one provider request. */
export function reserveProviderTokenCapacity(
  providerName: string,
  requestedTokens: number,
): TokenCapacityReservation {
  rolloverIfNeeded();
  const requested = Math.max(0, Math.floor(requestedTokens));
  const reserved = providerReservations.get(providerName) ?? 0;
  const window = calculateTokenCapacityWindow({
    cap: parseCaps()[providerName] ?? 0,
    usedTokens: providerTokensToday(providerName),
    reservedTokens: reserved,
    requestedTokens: requested,
  });
  return makeReservation(
    window,
    () => {
      providerReservations.set(providerName, reserved + requested);
    },
    () => {
      const remaining = Math.max(
        0,
        (providerReservations.get(providerName) ?? 0) - requested,
      );
      if (remaining === 0) providerReservations.delete(providerName);
      else providerReservations.set(providerName, remaining);
    },
  );
}

async function persistDatabaseDelta(
  day: string,
  provider: string,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  try {
    const [{ db, llmTokenUsageDaily }, { sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    await db
      .insert(llmTokenUsageDaily)
      .values({ day, provider, promptTokens, completionTokens, calls: 1, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmTokenUsageDaily.day, llmTokenUsageDaily.provider],
        set: {
          promptTokens: sql`${llmTokenUsageDaily.promptTokens} + ${promptTokens}`,
          completionTokens: sql`${llmTokenUsageDaily.completionTokens} + ${completionTokens}`,
          calls: sql`${llmTokenUsageDaily.calls} + 1`,
          updatedAt: new Date(),
        },
      });
    databasePersistenceReady = true;
  } catch {
    databasePersistenceReady = false;
  }
}

/** Hydrate today's counters from Postgres before agents start. */
export async function initializeTokenLedgerPersistence(): Promise<boolean> {
  try {
    rolloverIfNeeded();
    const [{ db, llmTokenUsageDaily }, { eq, sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    const rows = await db
      .select()
      .from(llmTokenUsageDaily)
      .where(eq(llmTokenUsageDaily.day, state.day));

    for (const row of rows) {
      const local = state.providers[row.provider];
      state.providers[row.provider] = {
        promptTokens: Math.max(local?.promptTokens ?? 0, row.promptTokens),
        completionTokens: Math.max(local?.completionTokens ?? 0, row.completionTokens),
        calls: Math.max(local?.calls ?? 0, row.calls),
      };
    }

    await Promise.all(
      Object.entries(state.providers).map(([provider, spend]) =>
        db
          .insert(llmTokenUsageDaily)
          .values({ day: state.day, provider, ...spend, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [llmTokenUsageDaily.day, llmTokenUsageDaily.provider],
            set: {
              promptTokens: sql`GREATEST(${llmTokenUsageDaily.promptTokens}, ${spend.promptTokens})`,
              completionTokens: sql`GREATEST(${llmTokenUsageDaily.completionTokens}, ${spend.completionTokens})`,
              calls: sql`GREATEST(${llmTokenUsageDaily.calls}, ${spend.calls})`,
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

export function recordTokenUsage(
  providerName: string,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): void {
  try {
    rolloverIfNeeded();
    const rawPromptTokens = Number(usage?.promptTokens ?? 0);
    const rawCompletionTokens = Number(usage?.completionTokens ?? 0);
    const promptTokens = Number.isFinite(rawPromptTokens)
      ? Math.max(0, Math.floor(rawPromptTokens))
      : 0;
    const completionTokens = Number.isFinite(rawCompletionTokens)
      ? Math.max(0, Math.floor(rawCompletionTokens))
      : 0;

    const entry = state.providers[providerName] ??
      (state.providers[providerName] = { promptTokens: 0, completionTokens: 0, calls: 0 });
    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.calls += 1;
    persist();
    void persistDatabaseDelta(state.day, providerName, promptTokens, completionTokens);
  } catch {
    // Token accounting must never take inference down.
  }
}

export function providerTokensToday(providerName: string): number {
  rolloverIfNeeded();
  const entry = state.providers[providerName];
  return entry ? entry.promptTokens + entry.completionTokens : 0;
}

export function totalTokensToday(): number {
  rolloverIfNeeded();
  let sum = 0;
  for (const entry of Object.values(state.providers)) {
    sum += entry.promptTokens + entry.completionTokens;
  }
  return sum;
}

export function isProviderOverDailyCap(providerName: string): boolean {
  const cap = parseCaps()[providerName];
  return Boolean(cap && providerTokensToday(providerName) >= cap);
}

export function isTotalDailyCapReached(): boolean {
  const cap = totalCap();
  return Boolean(cap && totalTokensToday() >= cap);
}

export function msUntilDailyReset(at: number = Date.now()): number {
  const date = new Date(at);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1_000, next - at);
}

export interface TokenLedgerSnapshot {
  day: string;
  persistence: 'postgres+memory' | 'memory-only';
  totalTokens: number;
  totalCap: number;
  totalCapReached: boolean;
  pacing: {
    enabled: boolean;
    burstTokens: number;
    total: TokenCapacityWindow;
    nextResumeAt: string | null;
  };
  providers: Array<{
    provider: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    calls: number;
    cap: number;
    capReached: boolean;
    percentOfCap: number | null;
    pacing: TokenCapacityWindow;
  }>;
}

export function getTokenLedgerSnapshot(): TokenLedgerSnapshot {
  rolloverIfNeeded();
  const caps = parseCaps();
  const providerNames = new Set([
    ...Object.keys(state.providers),
    ...Object.keys(caps),
    ...providerReservations.keys(),
  ]);
  const providers = [...providerNames]
    .map((provider) => {
      const entry = state.providers[provider] ?? {
        promptTokens: 0,
        completionTokens: 0,
        calls: 0,
      };
      const totalTokens = entry.promptTokens + entry.completionTokens;
      const cap = caps[provider] ?? 0;
      const pacing = calculateTokenCapacityWindow({
        cap,
        usedTokens: totalTokens,
        reservedTokens: providerReservations.get(provider) ?? 0,
        requestedTokens: CAPACITY_PROBE_TOKENS,
      });
      return {
        provider,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens,
        calls: entry.calls,
        cap,
        capReached: cap > 0 && totalTokens >= cap,
        percentOfCap:
          cap > 0 ? Math.round((totalTokens / cap) * 1000) / 10 : null,
        pacing,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const cap = totalCap();
  const totalTokens = providers.reduce(
    (sum, provider) => sum + provider.totalTokens,
    0,
  );
  const totalPacing = calculateTokenCapacityWindow({
    cap,
    usedTokens: totalTokens,
    reservedTokens: totalReservations,
    requestedTokens: CAPACITY_PROBE_TOKENS,
  });
  const nextResumeAt =
    [totalPacing, ...providers.map((provider) => provider.pacing)]
      .filter((window) => !window.allowed && window.resumeAt)
      .map((window) => window.resumeAt as string)
      .sort()[0] ?? null;
  return {
    day: state.day,
    persistence: databasePersistenceReady ? 'postgres+memory' : 'memory-only',
    totalTokens,
    totalCap: cap,
    totalCapReached: cap > 0 && totalTokens >= cap,
    pacing: {
      enabled: tokenPacingEnabled(),
      burstTokens:
        cap > 0 ? pacingBurstTokens(cap) : DEFAULT_PACING_BURST_TOKENS,
      total: totalPacing,
      nextResumeAt,
    },
    providers,
  };
}

export async function resetTokenLedger(): Promise<void> {
  const day = state.day;
  state = emptyState();
  providerReservations.clear();
  totalReservations = 0;
  persist();
  try {
    const [{ db, llmTokenUsageDaily }, { eq }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    await db.delete(llmTokenUsageDaily).where(eq(llmTokenUsageDaily.day, day));
  } catch {
    databasePersistenceReady = false;
  }
}

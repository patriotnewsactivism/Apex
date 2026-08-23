/**
 * Token ledger — proactive per-provider token accounting and daily budget caps.
 *
 * Every successful inference call records prompt + completion usage. State is
 * kept in memory, mirrored to a local file as a fast fallback, and reconciled
 * with Postgres so replacing a Lightsail container does not reset the current
 * UTC day's accounting.
 *
 * Routing policy lives in llm-client.ts. This module knows only provider names
 * and budgets; it must never introduce a provider that the router does not
 * allow.
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

const LEDGER_PATH = process.env.APEX_TOKEN_LEDGER_PATH ?? '/tmp/apex/token-ledger.json';

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
    // In-memory accounting still enforces caps for this process.
  }
}

function rolloverIfNeeded(): void {
  const today = utcDay();
  if (state.day !== today) {
    state = emptyState(today);
    persist();
  }
}

// ─── Caps ─────────────────────────────────────────────────────────────────────
//
// APEX's 2026-08-23 intelligence policy gives Mistral the bulk of worker
// traffic and targets up to 33M tokens/day for that account. The workspace
// backstop must therefore sit ABOVE 33M or it would stop the entire workforce
// before Mistral can reach its intended allowance.
//
// Environment values can override these defaults without a code deploy:
//   APEX_TOKEN_CAP_TOTAL=40000000
//   APEX_TOKEN_CAPS=mistral:33000000,google-gemini:5000000
//
// No default caps are guessed for Gemini/Cohere/Qwen/Kilo. Add them only from
// actual account limits or a deliberate spend budget. Setting a configured cap
// to 0 (or omitting it) means no APEX-side provider cap.

const DEFAULT_TOTAL_DAILY_CAP = 40_000_000;
const DEFAULT_PROVIDER_CAPS: Readonly<Record<string, number>> = {
  mistral: 33_000_000,
};

function parseCaps(): Record<string, number> {
  const raw = process.env.APEX_TOKEN_CAPS;
  if (raw === undefined || raw.trim() === '') {
    return { ...DEFAULT_PROVIDER_CAPS };
  }

  // An explicitly supplied list is authoritative. This makes it possible to
  // disable/change the Mistral cap deliberately without a code change.
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [name, value] = part.split(':').map((piece) => piece?.trim());
    const cap = Number(value);
    if (!name || !Number.isFinite(cap)) continue;
    if (cap > 0) out[name] = cap;
  }
  return out;
}

function totalCap(): number {
  const raw = process.env.APEX_TOKEN_CAP_TOTAL;
  const cap = raw === undefined || raw.trim() === '' ? DEFAULT_TOTAL_DAILY_CAP : Number(raw);
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
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

// ─── Public API ───────────────────────────────────────────────────────────────

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

    // Reconcile any larger local counters captured while Postgres was offline.
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

/** Skip a provider before making a guaranteed-over-budget HTTP request. */
export function isProviderOverDailyCap(providerName: string): boolean {
  const cap = parseCaps()[providerName];
  return Boolean(cap && providerTokensToday(providerName) >= cap);
}

/** Pause workspace-wide inference when the runaway backstop is reached. */
export function isTotalDailyCapReached(): boolean {
  const cap = totalCap();
  return Boolean(cap && totalTokensToday() >= cap);
}

/** Milliseconds until next UTC midnight, the natural reset for daily caps. */
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
  providers: Array<{
    provider: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    calls: number;
    cap: number;
    capReached: boolean;
    percentOfCap: number | null;
  }>;
}

export function getTokenLedgerSnapshot(): TokenLedgerSnapshot {
  rolloverIfNeeded();
  const caps = parseCaps();
  const providers = Object.entries(state.providers)
    .map(([provider, entry]) => {
      const totalTokens = entry.promptTokens + entry.completionTokens;
      const cap = caps[provider] ?? 0;
      return {
        provider,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens,
        calls: entry.calls,
        cap,
        capReached: cap > 0 && totalTokens >= cap,
        percentOfCap: cap > 0 ? Math.round((totalTokens / cap) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const cap = totalCap();
  const totalTokens = providers.reduce((sum, provider) => sum + provider.totalTokens, 0);
  return {
    day: state.day,
    persistence: databasePersistenceReady ? 'postgres+memory' : 'memory-only',
    totalTokens,
    totalCap: cap,
    totalCapReached: cap > 0 && totalTokens >= cap,
    providers,
  };
}

/** Test/ops escape hatch: wipe today's local and durable counters. */
export async function resetTokenLedger(): Promise<void> {
  const day = state.day;
  state = emptyState();
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

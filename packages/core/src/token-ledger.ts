/**
 * Token ledger — proactive per-provider token accounting and daily budget caps.
 *
 * WHY THIS EXISTS (added 2026-08-19)
 * ----------------------------------
 * Every token-protection mechanism in llm-client.ts up to this point is
 * REACTIVE: the circuit breaker, the daily-quota keyword sniff, the
 * unclassified-429 streak escalation and the global backoff all only fire
 * AFTER a provider has already refused a request. `LLMResponse.usage` was
 * parsed on every single call and then thrown away — nothing in the system
 * ever knew how many tokens the workforce had actually spent today, per
 * provider or in total.
 *
 * That is precisely how the workforce "exhausts tokens and stops being
 * autonomous": 13 agents × up to 20 agentic iterations × a 60k-char history
 * spend a free tier's whole daily allowance on churn, discover it only by
 * collecting 429s across the entire chain, and then the workforce goes dead
 * until a human notices.
 *
 * This module makes spend a first-class, observable, ENFORCED quantity:
 *   1. Every served call records real usage (provider, model, day, tokens).
 *   2. A provider over its configured daily cap is skipped BEFORE the HTTP
 *      call, so the chain moves to a provider that still has budget instead
 *      of burning a request on a guaranteed 429.
 *   3. A total daily cap can pause LLM spend workspace-wide (soft-pause: the
 *      call fails fast with a clear reason instead of silently hammering).
 *   4. State is mirrored to Postgres and hydrated at boot, so replacing a
 *      Lightsail container cannot reset the day's counters. A local file is
 *      retained only as a fast process-level fallback when the DB is offline.
 *
 * Deliberately dependency-free and synchronous-ish (fire-and-forget disk
 * writes): it sits on the hot path of every LLM call and must never be able
 * to throw, block, or need the DB to be up.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface ProviderDaySpend {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

interface LedgerState {
  /** UTC day key, e.g. "2026-08-19". Counters reset when this rolls over. */
  day: string;
  /** provider name → spend for `day` */
  providers: Record<string, ProviderDaySpend>;
}

const LEDGER_PATH =
  process.env.APEX_TOKEN_LEDGER_PATH ?? '/tmp/apex/token-ledger.json';

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
    // A ledger from a previous UTC day is not an error — it is simply spent.
    if (parsed.day !== utcDay()) return emptyState();
    return parsed;
  } catch {
    // Corrupt/unreadable ledger must never take the workforce down.
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
    // Best effort only: in-memory accounting still enforces caps this process.
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
// Configured entirely by env so a cap can be changed without a code deploy
// (a real constraint here: shipping code means CodeBuild + a Lightsail
// deployment, see AGENTS.md).
//
//   APEX_TOKEN_CAP_TOTAL=30000000           → total tokens/day, all providers
//   APEX_TOKEN_CAPS=mistral:20000000,groq:400000,google-gemini:1500000
//
// Defaults apply when the deployment variables are not configured. Set either
// value explicitly to 0 to disable that cap. Caps count prompt + completion
// tokens, because provider TPD limits and paid usage count both.
//
// The total default was 2M until 2026-08-22, when it was measured throttling
// production: real spend that day was 2,160,261 tokens, the cap was hit at
// ~07:00 UTC, and every complete() call for the following 17 hours failed
// fast while the free tiers still had quota to give. Mistral's free tier
// alone is ~33M tokens/day, so the "safe" default was holding a 13-agent
// workforce to roughly 6% of the capacity it already had — and because the
// default is hardcoded rather than deployed, nothing in the environment
// revealed the number that was doing it.
//
// A low TOTAL cap is the wrong instrument anyway: it stops the whole
// workforce dead rather than shifting load. Per-provider APEX_TOKEN_CAPS is
// what spreads spend across the chain; the total is a runaway backstop and
// should sit above normal operation, not inside it. Paid spend is bounded
// separately by APEX_PAID_TOKEN_CAP and paid providers stay off unless
// APEX_PAID_LLM_MODE is explicitly set, so this default governs free-tier
// spend only.
const DEFAULT_TOTAL_DAILY_CAP = 30_000_000;
const DEFAULT_PAID_DAILY_CAP = 250_000;

function parseCaps(): Record<string, number> {
  const out: Record<string, number> = {};
  const paidRaw = process.env.APEX_PAID_TOKEN_CAP;
  const paidCap = paidRaw === undefined || paidRaw.trim() === ''
    ? DEFAULT_PAID_DAILY_CAP
    : Number(paidRaw);
  if (Number.isFinite(paidCap) && paidCap > 0) {
    out['openrouter-paid-anchor'] = paidCap;
  }

  const raw = process.env.APEX_TOKEN_CAPS;
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [name, value] = part.split(':').map((s) => s?.trim());
    const n = Number(value);
    if (name && Number.isFinite(n) && n > 0) out[name] = n;
  }
  return out;
}

function totalCap(): number {
  const raw = process.env.APEX_TOKEN_CAP_TOTAL;
  const n = raw === undefined || raw.trim() === '' ? DEFAULT_TOTAL_DAILY_CAP : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
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

/** Hydrate today's in-memory counters from Postgres before agents start.
 * Returns false when the DB is unavailable; local accounting still works. */
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

    // If the local fallback captured usage during a prior DB interruption,
    // reconcile the larger counters back into Postgres before work resumes.
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
    const promptTokens = Number.isFinite(rawPromptTokens) ? Math.max(0, Math.floor(rawPromptTokens)) : 0;
    const completionTokens = Number.isFinite(rawCompletionTokens)
      ? Math.max(0, Math.floor(rawCompletionTokens))
      : 0;
    const entry =
      state.providers[providerName] ??
      (state.providers[providerName] = { promptTokens: 0, completionTokens: 0, calls: 0 });
    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.calls += 1;
    persist();
    void persistDatabaseDelta(state.day, providerName, promptTokens, completionTokens);
  } catch {
    /* never throw on the hot path */
  }
}

export function providerTokensToday(providerName: string): number {
  rolloverIfNeeded();
  const e = state.providers[providerName];
  return e ? e.promptTokens + e.completionTokens : 0;
}

export function totalTokensToday(): number {
  rolloverIfNeeded();
  let sum = 0;
  for (const e of Object.values(state.providers)) sum += e.promptTokens + e.completionTokens;
  return sum;
}

/** True when this provider has already spent its configured daily allowance.
 *  Checked BEFORE the HTTP call so the chain skips it instead of paying a
 *  guaranteed-fail request out of the provider's per-day REQUEST quota. */
export function isProviderOverDailyCap(providerName: string): boolean {
  const cap = parseCaps()[providerName];
  if (!cap) return false;
  return providerTokensToday(providerName) >= cap;
}

/** True when the workspace-wide daily cap is reached. Callers should fail the
 *  request fast with this reason rather than walking the whole chain. */
export function isTotalDailyCapReached(): boolean {
  const cap = totalCap();
  if (!cap) return false;
  return totalTokensToday() >= cap;
}

/** Milliseconds until the next UTC midnight — the natural reset point for
 *  every daily cap, and the correct cooldown length for "this provider is out
 *  of budget for today" (as opposed to the 4h heuristic used when the reason
 *  is only inferred from an error string). */
export function msUntilDailyReset(at: number = Date.now()): number {
  const next = Date.UTC(
    new Date(at).getUTCFullYear(),
    new Date(at).getUTCMonth(),
    new Date(at).getUTCDate() + 1,
  );
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

/** Observable state for `GET /api/tokens` and the dashboard. Answers the
 *  question no one could answer before: where did today's tokens go? */
export function getTokenLedgerSnapshot(): TokenLedgerSnapshot {
  rolloverIfNeeded();
  const caps = parseCaps();
  const providers = Object.entries(state.providers)
    .map(([provider, e]) => {
      const total = e.promptTokens + e.completionTokens;
      const cap = caps[provider] ?? 0;
      return {
        provider,
        promptTokens: e.promptTokens,
        completionTokens: e.completionTokens,
        totalTokens: total,
        calls: e.calls,
        cap,
        capReached: cap > 0 && total >= cap,
        percentOfCap: cap > 0 ? Math.round((total / cap) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const cap = totalCap();
  const total = providers.reduce((s, p) => s + p.totalTokens, 0);
  return {
    day: state.day,
    persistence: databasePersistenceReady ? 'postgres+memory' : 'memory-only',
    totalTokens: total,
    totalCap: cap,
    totalCapReached: cap > 0 && total >= cap,
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

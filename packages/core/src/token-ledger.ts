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
 *   4. State is persisted to disk so a container restart does not reset the
 *      day's counters (the failure mode that made caps meaningless before:
 *      Lightsail redeploys are frequent).
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
//   APEX_TOKEN_CAP_TOTAL=8000000            → total tokens/day, all providers
//   APEX_TOKEN_CAPS=mistral:30000000,groq:400000,gemini:1000000
//
// 0 or unset = no cap (previous behavior, exactly). Caps count prompt +
// completion tokens, because every free tier that has a TPD limit counts both.

function parseCaps(): Record<string, number> {
  const raw = process.env.APEX_TOKEN_CAPS;
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [name, value] = part.split(':').map((s) => s?.trim());
    const n = Number(value);
    if (name && Number.isFinite(n) && n > 0) out[name] = n;
  }
  return out;
}

function totalCap(): number {
  const n = Number(process.env.APEX_TOKEN_CAP_TOTAL ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function recordTokenUsage(
  providerName: string,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): void {
  try {
    rolloverIfNeeded();
    const entry =
      state.providers[providerName] ??
      (state.providers[providerName] = { promptTokens: 0, completionTokens: 0, calls: 0 });
    entry.promptTokens += Math.max(0, usage?.promptTokens ?? 0);
    entry.completionTokens += Math.max(0, usage?.completionTokens ?? 0);
    entry.calls += 1;
    persist();
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
    totalTokens: total,
    totalCap: cap,
    totalCapReached: cap > 0 && total >= cap,
    providers,
  };
}

/** Test/ops escape hatch: wipe today's counters (e.g. after rotating keys). */
export function resetTokenLedger(): void {
  state = emptyState();
  persist();
}

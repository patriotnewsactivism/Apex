/**
 * Request ledger — daily accounting and pacing for LLM REQUEST COUNT.
 *
 * WHY THIS EXISTS
 * ------------------------------------------------------------------
 * token-ledger.ts meters tokens. Every cap, pacing window and capacity pause
 * in APEX is denominated in tokens. That matches a paid provider, which bills
 * per token.
 *
 * It does not match the constraint APEX actually runs into. OpenRouter's free
 * allowance is rationed per REQUEST — a fixed number of calls per account per
 * UTC day, regardless of how large or small each one is. A workspace can sit
 * far under every token cap it has and still be refused, because the thing
 * that ran out was never being counted.
 *
 * That is exactly what happened: ~5,000 requests/day against a 3,000/day
 * allowance, with no counter anywhere in the process aware of either number.
 * So this module is deliberately a second, parallel ledger rather than a field
 * added to the first — the two denominations bind independently, and a request
 * budget has to keep working when no token cap is configured at all (the
 * default).
 *
 * Counting rule: EVERY upstream attempt counts, including ones that fail.
 * A 429, a timeout and a 500 all consumed the allowance. recordTokenUsage()
 * runs only on success (it has no usage figures to record otherwise), so
 * reusing its `calls` column here would undercount by exactly the fallback
 * cascade — the requests most worth seeing.
 *
 * Configuration:
 *   APEX_REQUEST_CAP_TOTAL=2600     workspace requests/day (0 disables)
 *   APEX_REQUEST_CAPS=OPENROUTER_API_KEY:1000,OPENROUTER_API_KEY_2:1000
 *   APEX_REQUEST_PACING_ENABLED=true
 *   APEX_REQUEST_PACING_BURST=150
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * An account is identified by a fingerprint of its KEY, not by the env var
 * holding it.
 *
 * This matters because the two are not one-to-one. APEX reads OpenRouter keys
 * from five env names (OPENROUTER_FREE_API_KEY, OPENROUTER_API_KEY,
 * OPENROUTER_API_KEY_2, OPENROUTER_API_KEY_3, OPENROUTER_BYOK_API_KEY) across
 * three real accounts — and the BYOK rung is explicitly documented as needing
 * to belong to an account that already appears elsewhere in that list. Keying
 * on the env name would split one account's spend across several rows, so a
 * per-account cap of 1,000 set on two names that hold the same key would
 * authorize 2,000 requests against an account that allows 1,000. The cap would
 * read as enforced and be wrong in the direction that costs you the day.
 *
 * The fingerprint is a truncated SHA-256 of the key. It is used only as a
 * grouping identity and a database key; it is NEVER reported — `/health` and
 * every log line show the env names, which are not secrets.
 */
export interface RequestAccountDay {
  /** Upstream attempts started, whatever their outcome. */
  requests: number;
  /** Attempts that returned a usable response. */
  succeeded: number;
}

/** Stable, non-reversible grouping identity for one provider credential. */
export function accountFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/** Env names currently holding this key — the human-readable label for an
 *  account, resolved from live process.env rather than stored, so a key moved
 *  between variables relabels itself instead of going stale. */
function envNamesForFingerprint(fingerprint: string): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !name.endsWith('_API_KEY') && !/_API_KEY_\d+$/.test(name)) continue;
    if (accountFingerprint(value) === fingerprint) names.push(name);
  }
  return names.sort();
}

interface LedgerState {
  day: string;
  accounts: Record<string, RequestAccountDay>;
}

const LEDGER_PATH =
  process.env.APEX_REQUEST_LEDGER_PATH ?? '/tmp/apex/request-ledger.json';
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/** Free-tier reality as of 2026-09: three OpenRouter accounts, 1,000/day each
 *  once a $10 deposit lifts them off the ~200/day base tier. The default sits
 *  under that ceiling rather than on it, because this ledger cannot see
 *  requests made outside this process (a second revision mid-rollout, a local
 *  run, the chat route on another instance) and the penalty for guessing high
 *  is a hard 429 wall with no allowance left to recover on. */
const DEFAULT_TOTAL_CAP = 2_600;
/** Enough to get real work done immediately after a restart without letting a
 *  startup swarm eat the morning. ~1.4h of the steady-state rate. */
const DEFAULT_PACING_BURST = 150;

function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

function emptyState(day = utcDay()): LedgerState {
  return { day, accounts: {} };
}

function load(): LedgerState {
  try {
    if (!existsSync(LEDGER_PATH)) return emptyState();
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as LedgerState;
    if (!parsed || typeof parsed.day !== 'string' || typeof parsed.accounts !== 'object') {
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

function parseCaps(): Record<string, number> {
  const raw = process.env.APEX_REQUEST_CAPS;
  if (!raw?.trim()) return {};
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [name, value] = part.split(':').map((piece) => piece?.trim());
    const cap = Number(value);
    if (name && Number.isFinite(cap) && cap > 0) out[name] = Math.floor(cap);
  }
  return out;
}

export function totalRequestCap(): number {
  const raw = process.env.APEX_REQUEST_CAP_TOTAL;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TOTAL_CAP;
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap < 0) return DEFAULT_TOTAL_CAP;
  return Math.floor(cap);
}

function requestPacingEnabled(): boolean {
  const normalized = (process.env.APEX_REQUEST_PACING_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'disabled', 'no'].includes(normalized);
}

function pacingBurst(cap: number): number {
  const raw = process.env.APEX_REQUEST_PACING_BURST;
  const configured =
    raw === undefined || raw.trim() === '' ? DEFAULT_PACING_BURST : Number(raw);
  const burst = Number.isFinite(configured)
    ? Math.max(0, Math.floor(configured))
    : DEFAULT_PACING_BURST;
  return Math.min(cap, burst);
}

export type RequestCapacityReason =
  | 'uncapped'
  | 'available'
  | 'paced'
  | 'daily_cap';

export interface RequestCapacityWindow {
  cap: number;
  usedRequests: number;
  /** Requests this window would have to admit to say yes. */
  requestedRequests: number;
  /** Requests released so far today under the pacing ramp. */
  pacingAllowance: number;
  availableRequests: number | null;
  allowed: boolean;
  reason: RequestCapacityReason;
  resumeAt: string | null;
}

/**
 * Pure UTC-day pacing calculation, mirroring the token ledger's shape so the
 * two behave identically from an operator's point of view: a small burst at
 * midnight, then a straight-line ramp releasing the rest of the cap across the
 * day.
 *
 * Pacing is the part that does the actual slowing down. A hard cap alone lets
 * the workforce sprint through the whole allowance before noon and then sit
 * dead until the UTC rollover — technically under budget, useless in practice.
 * The ramp converts "2,600 per day" into "about 108 per hour", which is what
 * makes agents wait between turns without any cadence being hand-tuned.
 */
export function calculateRequestCapacityWindow(input: {
  cap: number;
  usedRequests: number;
  requestedRequests?: number;
  at?: number;
  pacingEnabled?: boolean;
  burstRequests?: number;
}): RequestCapacityWindow {
  const at = input.at ?? Date.now();
  const cap = Number.isFinite(input.cap) ? Math.max(0, Math.floor(input.cap)) : 0;
  const usedRequests = Number.isFinite(input.usedRequests)
    ? Math.max(0, Math.floor(input.usedRequests))
    : 0;
  const requestedRequests = Number.isFinite(input.requestedRequests)
    ? Math.max(0, Math.floor(input.requestedRequests ?? 1))
    : 1;

  if (cap === 0) {
    return {
      cap,
      usedRequests,
      requestedRequests,
      pacingAllowance: 0,
      availableRequests: null,
      allowed: true,
      reason: 'uncapped',
      resumeAt: null,
    };
  }

  const date = new Date(at);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const nextDay = dayStart + UTC_DAY_MS;
  const elapsed = Math.min(UTC_DAY_MS, Math.max(0, at - dayStart));
  const burst = Math.min(
    cap,
    Number.isFinite(input.burstRequests)
      ? Math.max(0, Math.floor(input.burstRequests ?? 0))
      : pacingBurst(cap),
  );
  const pacing = input.pacingEnabled ?? requestPacingEnabled();
  const toAccrue = Math.max(0, cap - burst);
  const pacingAllowance = pacing
    ? Math.min(cap, Math.floor(burst + (toAccrue * elapsed) / UTC_DAY_MS))
    : cap;
  const target = usedRequests + requestedRequests;
  const availableRequests = Math.max(0, pacingAllowance - usedRequests);

  if (usedRequests >= cap || target > cap) {
    return {
      cap,
      usedRequests,
      requestedRequests,
      pacingAllowance,
      availableRequests,
      allowed: false,
      reason: 'daily_cap',
      resumeAt: new Date(nextDay).toISOString(),
    };
  }

  if (target > pacingAllowance) {
    const requiredElapsed =
      toAccrue > 0
        ? Math.ceil((Math.max(0, target - burst) * UTC_DAY_MS) / toAccrue)
        : UTC_DAY_MS;
    const resumeAt = Math.min(nextDay, dayStart + requiredElapsed);
    return {
      cap,
      usedRequests,
      requestedRequests,
      pacingAllowance,
      availableRequests,
      allowed: false,
      reason: 'paced',
      resumeAt: new Date(Math.max(at + 1_000, resumeAt)).toISOString(),
    };
  }

  return {
    cap,
    usedRequests,
    requestedRequests,
    pacingAllowance,
    availableRequests,
    allowed: true,
    reason: 'available',
    resumeAt: null,
  };
}

async function persistDatabaseDelta(day: string, account: string, succeeded: boolean): Promise<void> {
  try {
    const [{ db, llmRequestUsageDaily }, { sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    await db
      .insert(llmRequestUsageDaily)
      .values({ day, account, requests: 1, succeeded: succeeded ? 1 : 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: {
          requests: sql`${llmRequestUsageDaily.requests} + 1`,
          succeeded: sql`${llmRequestUsageDaily.succeeded} + ${succeeded ? 1 : 0}`,
          updatedAt: new Date(),
        },
      });
    databasePersistenceReady = true;
  } catch {
    databasePersistenceReady = false;
  }
}

/**
 * Hydrate today's counters from Postgres before agents start.
 *
 * Load-bearing, not a nicety: Cloud Run replaces the container on every deploy
 * and may restart it at will. A budget that only lived in /tmp would reset to
 * zero on each restart, so a day with several deploys would quietly authorize
 * several full allowances — the exact failure this ledger exists to prevent.
 */
export async function initializeRequestLedgerPersistence(): Promise<boolean> {
  try {
    rolloverIfNeeded();
    const [{ db, llmRequestUsageDaily }, { eq, sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    const rows = await db
      .select()
      .from(llmRequestUsageDaily)
      .where(eq(llmRequestUsageDaily.day, state.day));

    for (const row of rows) {
      const local = state.accounts[row.account];
      state.accounts[row.account] = {
        requests: Math.max(local?.requests ?? 0, row.requests),
        succeeded: Math.max(local?.succeeded ?? 0, row.succeeded),
      };
    }

    await Promise.all(
      Object.entries(state.accounts).map(([account, day]) =>
        db
          .insert(llmRequestUsageDaily)
          .values({ day: state.day, account, ...day, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
            set: {
              requests: sql`GREATEST(${llmRequestUsageDaily.requests}, ${day.requests})`,
              succeeded: sql`GREATEST(${llmRequestUsageDaily.succeeded}, ${day.succeeded})`,
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

/** Record one upstream attempt against the account that served it. Takes the
 *  API key so the caller never handles the fingerprint; the key itself is
 *  hashed immediately and never stored, logged or reported. */
export function recordProviderRequest(apiKey: string, succeeded: boolean): void {
  try {
    rolloverIfNeeded();
    const account = accountFingerprint(apiKey);
    const entry =
      state.accounts[account] ?? (state.accounts[account] = { requests: 0, succeeded: 0 });
    entry.requests += 1;
    if (succeeded) entry.succeeded += 1;
    persist();
    void persistDatabaseDelta(state.day, account, succeeded);
  } catch {
    // Request accounting must never take inference down.
  }
}

export function accountRequestsToday(account: string): number {
  rolloverIfNeeded();
  return state.accounts[account]?.requests ?? 0;
}

export function totalRequestsToday(): number {
  rolloverIfNeeded();
  let sum = 0;
  for (const entry of Object.values(state.accounts)) sum += entry.requests;
  return sum;
}

/** Workspace-wide budget check for one more request. */
export function requestCapacityWindow(at: number = Date.now()): RequestCapacityWindow {
  rolloverIfNeeded(at);
  return calculateRequestCapacityWindow({
    cap: totalRequestCap(),
    usedRequests: totalRequestsToday(),
    requestedRequests: 1,
    at,
  });
}

/**
 * Resolve the configured cap for an account.
 *
 * Operators write APEX_REQUEST_CAPS against env NAMES, because that is what
 * they can see and reason about, while spend is tracked against the account
 * fingerprint. When several names hold the same key they are one account, so
 * the strictest cap among them wins — summing them would recreate exactly the
 * over-authorization this fingerprinting exists to prevent.
 */
function capForFingerprint(fingerprint: string): number {
  const caps = parseCaps();
  const applicable = envNamesForFingerprint(fingerprint)
    .map((name) => caps[name])
    .filter((cap): cap is number => Number.isFinite(cap) && cap > 0);
  if (applicable.length === 0) return caps[fingerprint] ?? 0;
  return Math.min(...applicable);
}

/** Per-account budget check, for accounts given an explicit cap. Takes the
 *  API key itself so callers never have to know about fingerprinting. */
export function accountCapacityWindow(
  apiKey: string,
  at: number = Date.now(),
): RequestCapacityWindow {
  rolloverIfNeeded(at);
  const fingerprint = accountFingerprint(apiKey);
  return calculateRequestCapacityWindow({
    cap: capForFingerprint(fingerprint),
    usedRequests: accountRequestsToday(fingerprint),
    requestedRequests: 1,
    at,
  });
}

export function isRequestBudgetExhausted(at: number = Date.now()): boolean {
  const cap = totalRequestCap();
  return cap > 0 && totalRequestsToday() >= cap;
}

export interface RequestLedgerSnapshot {
  day: string;
  persistence: 'postgres+memory' | 'memory-only';
  totalRequests: number;
  totalCap: number;
  totalCapReached: boolean;
  /** Requests/day this workspace is on course for if the current rate holds.
   *  The number to compare against the provider allowance. */
  projectedDailyRequests: number | null;
  pacing: {
    enabled: boolean;
    burstRequests: number;
    total: RequestCapacityWindow;
    nextResumeAt: string | null;
  };
  accounts: Array<{
    /** The env var name(s) currently holding this account's key. Never the
     *  fingerprint — that is an internal grouping identity derived from the
     *  key, and this payload is served without authentication. */
    account: string;
    requests: number;
    succeeded: number;
    failed: number;
    cap: number;
    capReached: boolean;
    percentOfCap: number | null;
    pacing: RequestCapacityWindow;
  }>;
}

export function getRequestLedgerSnapshot(at: number = Date.now()): RequestLedgerSnapshot {
  rolloverIfNeeded(at);
  const fingerprints = new Set(Object.keys(state.accounts));
  const accounts = [...fingerprints]
    .map((fingerprint) => {
      const entry = state.accounts[fingerprint] ?? { requests: 0, succeeded: 0 };
      const cap = capForFingerprint(fingerprint);
      const envNames = envNamesForFingerprint(fingerprint);
      return {
        // A fingerprint with no live env name is a key that was rotated or
        // removed mid-day; its spend still counts toward the workspace total,
        // so say so rather than dropping the row or leaking the hash.
        account: envNames.length > 0 ? envNames.join(' + ') : '(retired key)',
        requests: entry.requests,
        succeeded: entry.succeeded,
        failed: Math.max(0, entry.requests - entry.succeeded),
        cap,
        capReached: cap > 0 && entry.requests >= cap,
        percentOfCap: cap > 0 ? Math.round((entry.requests / cap) * 1000) / 10 : null,
        pacing: calculateRequestCapacityWindow({
          cap,
          usedRequests: entry.requests,
          requestedRequests: 1,
          at,
        }),
      };
    })
    .sort((a, b) => b.requests - a.requests);

  const cap = totalRequestCap();
  const totalRequests = accounts.reduce((sum, entry) => sum + entry.requests, 0);
  const totalPacing = calculateRequestCapacityWindow({
    cap,
    usedRequests: totalRequests,
    requestedRequests: 1,
    at,
  });

  // Straight-line projection from the day's elapsed fraction. Honest only once
  // enough of the day has passed for the rate to mean anything; before that it
  // amplifies a single burst into a fictional daily figure.
  const date = new Date(at);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const elapsed = Math.max(0, at - dayStart);
  const projectedDailyRequests =
    elapsed >= 15 * 60 * 1000
      ? Math.round((totalRequests * UTC_DAY_MS) / elapsed)
      : null;

  const nextResumeAt =
    [totalPacing, ...accounts.map((entry) => entry.pacing)]
      .filter((window) => !window.allowed && window.resumeAt)
      .map((window) => window.resumeAt as string)
      .sort()[0] ?? null;

  return {
    day: state.day,
    persistence: databasePersistenceReady ? 'postgres+memory' : 'memory-only',
    totalRequests,
    totalCap: cap,
    totalCapReached: cap > 0 && totalRequests >= cap,
    projectedDailyRequests,
    pacing: {
      enabled: requestPacingEnabled(),
      burstRequests: cap > 0 ? pacingBurst(cap) : DEFAULT_PACING_BURST,
      total: totalPacing,
      nextResumeAt,
    },
    accounts,
  };
}

export async function resetRequestLedger(): Promise<void> {
  const day = state.day;
  state = emptyState();
  persist();
  try {
    const [{ db, llmRequestUsageDaily }, { eq }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    await db.delete(llmRequestUsageDaily).where(eq(llmRequestUsageDaily.day, day));
  } catch {
    databasePersistenceReady = false;
  }
}

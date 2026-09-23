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
 *   APEX_REQUEST_CAP_TOTAL=2000     workspace requests/day (0 disables)
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
 * from OPENROUTER_FREE_API_KEY, OPENROUTER_API_KEY, OPENROUTER_API_KEY_2,
 * OPENROUTER_API_KEY_3, and OPENROUTER_API_KEY_4. Extra env names for the same
 * key or account are credential redundancy, not extra capacity. Keying on the env name would split one
 * account's spend across several rows, so a per-account cap of 1,000 set on
 * two names that hold the same key would authorize 2,000 requests against an
 * account that allows 1,000. The cap would read as enforced and be wrong in
 * the direction that costs you the day.
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

/** Conservative workspace default. Actual account capacity is resolved from
 *  the live OpenRouter account identities reported by the credit probe. The
 *  credential roster includes OPENROUTER_API_KEY_3 and _4; duplicate keys or
 *  multiple keys from one account still collapse into one quota bucket. */
const DEFAULT_TOTAL_CAP = 2_775;
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

/**
 * Free requests/day a single OpenRouter account allows, once a $10 deposit
 * lifts it off the ~200/day base tier.
 */
const DEFAULT_FREE_RPD_PER_ACCOUNT = 1_000;

function freeRequestsPerAccount(): number {
  const raw = process.env.APEX_FREE_RPD_PER_ACCOUNT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_FREE_RPD_PER_ACCOUNT;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_FREE_RPD_PER_ACCOUNT;
}

/**
 * Which OpenRouter ACCOUNT each configured key belongs to, keyed by the key's
 * fingerprint, as resolved by the credit probe. Pushed in rather than pulled,
 * because provider-credits.ts already imports accountFingerprint from this
 * module and reaching back would make the cycle.
 *
 * WHY THE LEDGER HAS TO KNOW THIS
 * ------------------------------------------------------------------
 * The free allowance is metered per ACCOUNT, but this ledger fingerprints
 * KEYS — so two distinct keys issued by one account look like two accounts to
 * the load balancer and to any cap expressed as "accounts x 1,000".
 *
 * That is not hypothetical, and it cost both. On 2026-09-14 the probe found 3
 * live keys across 2 accounts: OPENROUTER_FREE_API_KEY and OPENROUTER_API_KEY_2
 * belong to one account and draw on one bucket.
 *
 *   - The CAP read 2,800 against a true ceiling of 2,000, so APEX would have
 *     spent the difference collecting 429s while its budget still showed room.
 *   - The BALANCER levelled the three keys, which loads a two-key account twice
 *     as hard as a one-key account. Measured that day at 14:30 UTC: 508 + 508 =
 *     1,016 requests through the shared account, already past its 1,000/day
 *     ceiling, while the other sat at 737 with 263 of its own going unused.
 */
let observedAccountByFingerprint: ReadonlyMap<string, string> = new Map();

export function setObservedAccounts(
  identities: ReadonlyMap<string, string> | null,
): void {
  observedAccountByFingerprint =
    identities && identities.size > 0 ? new Map(identities) : new Map();
}

export function getObservedAccountCount(): number | null {
  if (observedAccountByFingerprint.size === 0) return null;
  return new Set(observedAccountByFingerprint.values()).size;
}

/**
 * Every configured key sharing an OpenRouter account with this one, itself
 * included — the set the free tier meters as a single bucket.
 *
 * A key the probe has not resolved stays its own account. Guessing a grouping
 * would merge two independent accounts into one counter and halve the
 * workspace's apparent capacity, which is the more expensive way to be wrong.
 */
function accountSiblings(fingerprint: string): string[] {
  const account = observedAccountByFingerprint.get(fingerprint);
  if (account === undefined) return [fingerprint];
  const siblings: string[] = [];
  for (const [candidate, id] of observedAccountByFingerprint) {
    if (id === account) siblings.push(candidate);
  }
  return siblings;
}

/** Public identity of the OpenRouter account behind a key, once the probe has
 *  resolved it. Two keys reporting the same value share one free bucket. */
export function observedAccountFor(fingerprint: string): string | null {
  return observedAccountByFingerprint.get(fingerprint) ?? null;
}

/** Requests today across the whole account a key draws on. Read-only: the
 *  caller owns day rollover, so a snapshot built at a synthetic instant cannot
 *  be rolled out from under itself mid-build. */
function requestsAcrossAccount(fingerprint: string): number {
  let sum = 0;
  for (const sibling of accountSiblings(fingerprint)) {
    sum += state.accounts[sibling]?.requests ?? 0;
  }
  return sum;
}

/**
 * Workspace-wide hard ceiling.
 *
 * This must remain distinct from any one provider's allowance. OpenRouter
 * accounts have their own per-account caps (accountCapacityWindow), while
 * direct BYOK providers such as Groq or Gemini have independent quota pools.
 * Clamping the WORKSPACE ceiling to the number of observed OpenRouter accounts
 * made APEX report a 2,775 cap while silently enforcing 2,000 when only two
 * OpenRouter accounts were observed. Keep the operator's workspace ceiling
 * authoritative; provider-specific gates decide whether a particular route is
 * currently available beneath it.
 */
export function effectiveRequestCap(): number {
  return totalRequestCap();
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
 * The ramp converts "2,900 per day" into "about 121 per hour", which is what
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

async function persistDatabaseRequestDelta(day: string, account: string): Promise<void> {
  try {
    const [{ db, llmRequestUsageDaily }, { sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    await db
      .insert(llmRequestUsageDaily)
      .values({ day, account, requests: 1, succeeded: 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: {
          requests: sql`${llmRequestUsageDaily.requests} + 1`,
          updatedAt: new Date(),
        },
      });
    databasePersistenceReady = true;
  } catch {
    databasePersistenceReady = false;
  }
}

async function persistDatabaseSuccessDelta(day: string, account: string): Promise<void> {
  try {
    const [{ db, llmRequestUsageDaily }, { sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    // This UPSERT is safe even if the asynchronous request-reservation write
    // has not reached Postgres yet; the later request delta brings requests
    // back to 1 while this row preserves the successful outcome.
    await db
      .insert(llmRequestUsageDaily)
      .values({ day, account, requests: 0, succeeded: 1, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: {
          succeeded: sql`${llmRequestUsageDaily.succeeded} + 1`,
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

const PAID_REQUEST_ACCOUNT_PREFIX = 'paid-provider:';
const DIRECT_REQUEST_ACCOUNT_PREFIX = 'direct-provider:';

export type DirectRequestPool = 'groq' | 'gemini';

const DIRECT_POOL_DEFAULTS: Record<DirectRequestPool, { cap: number; ratePerMinute: number; burst: number }> = {
  // Groq publishes 1,000 RPD for GPT-OSS 120B on the base limits page. Keep
  // 10% headroom for calls made outside this APEX process.
  groq: { cap: 900, ratePerMinute: 8, burst: 25 },
  // Gemini's exact RPD is project/model/tier specific and must be read from AI
  // Studio. Start conservatively until APEX can ingest the live quota headers.
  gemini: { cap: 500, ratePerMinute: 5, burst: 20 },
};

const directRecentRequests: Record<DirectRequestPool, number[]> = {
  groq: [],
  gemini: [],
};

function directAccountId(pool: DirectRequestPool, provider: string): string {
  return `${DIRECT_REQUEST_ACCOUNT_PREFIX}${pool}:${provider}`;
}

function isDirectAccount(account: string): boolean {
  return account.startsWith(DIRECT_REQUEST_ACCOUNT_PREFIX);
}

function isPaidAccount(account: string): boolean {
  return account.startsWith(PAID_REQUEST_ACCOUNT_PREFIX);
}

function directPoolForAccount(account: string): DirectRequestPool | null {
  if (!isDirectAccount(account)) return null;
  const rest = account.slice(DIRECT_REQUEST_ACCOUNT_PREFIX.length);
  const pool = rest.split(':', 1)[0];
  return pool === 'groq' || pool === 'gemini' ? pool : null;
}

function reserveRequestAccount(
  account: string,
  countInOpenRouterRateWindow = true,
): void {
  try {
    rolloverIfNeeded();
    const now = Date.now();
    if (countInOpenRouterRateWindow) {
      pruneRateWindow(now);
      recentRequests.push(now);
      const recent = recentAccountRequests.get(account) ?? [];
      pruneSpecificRateWindow(recent, now);
      recent.push(now);
      recentAccountRequests.set(account, recent);
    }
    const entry =
      state.accounts[account] ?? (state.accounts[account] = { requests: 0, succeeded: 0 });
    // Reservation happens synchronously before fetch(). With no await between
    // the capacity check and this increment, concurrent agent turns cannot all
    // observe the same final slot and overshoot the daily cap.
    entry.requests += 1;
    persist();
    void persistDatabaseRequestDelta(state.day, account);
  } catch {
    // Request accounting must never take inference down.
  }
}

function markRequestAccountSucceeded(account: string): void {
  try {
    rolloverIfNeeded();
    const entry = state.accounts[account];
    if (!entry) return;
    entry.succeeded = Math.min(entry.requests, entry.succeeded + 1);
    persist();
    void persistDatabaseSuccessDelta(state.day, account);
  } catch {
    // Outcome accounting must never take inference down.
  }
}

export function reserveProviderRequest(apiKey: string): void {
  reserveRequestAccount(accountFingerprint(apiKey));
}

export function markProviderRequestSucceeded(apiKey: string): void {
  markRequestAccountSucceeded(accountFingerprint(apiKey));
}

export function reservePaidProviderRequest(provider: string): void {
  // Paid continuity has its own dollar ledger and pacing window. Counting it
  // in the OpenRouter *free* request ramp turns the continuity route into the
  // very stall it is meant to prevent: a paid request can consume a free slot,
  // then a paced free pool blocks paid work too. It remains in the all-provider
  // emergency ceiling below, but must not consume the free daily or RPM pool.
  reserveRequestAccount(`${PAID_REQUEST_ACCOUNT_PREFIX}${provider}`, false);
}

export function markPaidProviderRequestSucceeded(provider: string): void {
  markRequestAccountSucceeded(`${PAID_REQUEST_ACCOUNT_PREFIX}${provider}`);
}

export function reserveDirectProviderRequest(
  pool: DirectRequestPool,
  provider: string,
): void {
  const now = Date.now();
  const recent = directRecentRequests[pool];
  pruneSpecificRateWindow(recent, now);
  recent.push(now);
  reserveRequestAccount(directAccountId(pool, provider), false);
}

export function markDirectProviderRequestSucceeded(
  pool: DirectRequestPool,
  provider: string,
): void {
  markRequestAccountSucceeded(directAccountId(pool, provider));
}

/** Backward-compatible one-shot accounting helpers used by verification code.
 * Runtime inference uses reserve*() BEFORE fetch and mark*Succeeded() after. */
export function recordProviderRequest(apiKey: string, succeeded: boolean): void {
  reserveProviderRequest(apiKey);
  if (succeeded) markProviderRequestSucceeded(apiKey);
}

export function recordPaidProviderRequest(provider: string, succeeded: boolean): void {
  reservePaidProviderRequest(provider);
  if (succeeded) markPaidProviderRequestSucceeded(provider);
}

export function recordDirectProviderRequest(
  pool: DirectRequestPool,
  provider: string,
  succeeded: boolean,
): void {
  reserveDirectProviderRequest(pool, provider);
  if (succeeded) markDirectProviderRequestSucceeded(pool, provider);
}

/**
 * Requests today against the ACCOUNT a key draws on — the sum over every key
 * the probe says shares it, because that shared bucket is what the free tier
 * actually meters. Equals the key's own count when it is alone on its account,
 * or whenever the probe has not resolved the mapping.
 *
 * This is the number the load balancer sorts on, so metering it per key rather
 * than per account is what drove one account past its ceiling while another
 * went unused.
 */
export function accountRequestsToday(fingerprint: string): number {
  rolloverIfNeeded();
  return requestsAcrossAccount(fingerprint);
}

/** Requests against the OpenRouter FREE pool only. This is the pool governed by
 * APEX_REQUEST_CAP_TOTAL=2775. Direct BYOK and paid-continuity requests are
 * intentionally excluded so both add independent capacity instead of consuming
 * the free allowance. All attempts still count toward the emergency ceiling. */
export function totalRequestsToday(): number {
  rolloverIfNeeded();
  let sum = 0;
  for (const [account, entry] of Object.entries(state.accounts)) {
    if (!isDirectAccount(account) && !isPaidAccount(account)) sum += entry.requests;
  }
  return sum;
}

export function allProviderRequestsToday(): number {
  rolloverIfNeeded();
  let sum = 0;
  for (const entry of Object.values(state.accounts)) sum += entry.requests;
  return sum;
}

export function directProviderRequestsToday(pool: DirectRequestPool): number {
  rolloverIfNeeded();
  let sum = 0;
  for (const [account, entry] of Object.entries(state.accounts)) {
    if (directPoolForAccount(account) === pool) sum += entry.requests;
  }
  return sum;
}

/** Workspace-wide budget check for one more request. `pacingEnabled: false`
 *  (e.g. an interactive human request) skips the smoothing ramp and checks
 *  only the hard daily cap — the per-minute rate limit below still applies
 *  either way. Omit to use the configured default. */
export function requestCapacityWindow(
  at: number = Date.now(),
  pacingEnabled?: boolean,
): RequestCapacityWindow {
  rolloverIfNeeded(at);
  const daily = calculateRequestCapacityWindow({
    cap: effectiveRequestCap(),
    usedRequests: totalRequestsToday(),
    requestedRequests: 1,
    at,
    pacingEnabled,
  });
  if (!daily.allowed) return daily;

  // Short-window limit. Reported as `paced` rather than `daily_cap` because it
  // clears in seconds, not at the UTC rollover — the agent loop's capacity
  // latch sleeps until resumeAt, and a wrong one here would park the workforce
  // for hours over a limit that lifts almost immediately.
  const resumeAt = rateLimitResumeAt(at);
  if (resumeAt === null) return daily;
  return {
    ...daily,
    allowed: false,
    reason: 'paced',
    resumeAt: new Date(Math.max(at + 1_000, resumeAt)).toISOString(),
  };
}

/**
 * Paid continuity is governed by the spend ledger, not by OpenRouter's free
 * request allowance. It stays inside the emergency all-provider ceiling and
 * the provider's minimum-dispatch interval, but a paced free pool must never
 * veto an enabled, in-budget paid fallback.
 */
export function paidProviderCapacityWindow(): RequestCapacityWindow {
  return calculateRequestCapacityWindow({
    cap: 0,
    usedRequests: 0,
    requestedRequests: 1,
    pacingEnabled: false,
  });
}

function directPoolNumber(
  pool: DirectRequestPool,
  suffix: 'CAP' | 'RATE_PER_MIN' | 'PACING_BURST',
  fallback: number,
): number {
  const raw = process.env[`APEX_${pool.toUpperCase()}_REQUEST_${suffix}`];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function directProviderRequestCap(pool: DirectRequestPool): number {
  return directPoolNumber(pool, 'CAP', DIRECT_POOL_DEFAULTS[pool].cap);
}

export function directProviderRatePerMinute(pool: DirectRequestPool): number {
  return directPoolNumber(pool, 'RATE_PER_MIN', DIRECT_POOL_DEFAULTS[pool].ratePerMinute);
}

function directProviderBurst(pool: DirectRequestPool): number {
  return directPoolNumber(pool, 'PACING_BURST', DIRECT_POOL_DEFAULTS[pool].burst);
}

function pruneSpecificRateWindow(recent: number[], at: number): void {
  const cutoff = at - RATE_WINDOW_MS;
  while (recent.length > 0 && recent[0] <= cutoff) recent.shift();
}

function directRateLimitResumeAt(pool: DirectRequestPool, at: number): number | null {
  const limit = directProviderRatePerMinute(pool);
  if (limit <= 0) return null;
  const recent = directRecentRequests[pool];
  pruneSpecificRateWindow(recent, at);
  if (recent.length < limit) return null;
  return recent[0] + RATE_WINDOW_MS;
}

/** Independent quota window for direct BYOK providers. */
export function directProviderCapacityWindow(
  pool: DirectRequestPool,
  at: number = Date.now(),
  pacingEnabled?: boolean,
): RequestCapacityWindow {
  rolloverIfNeeded(at);
  const cap = directProviderRequestCap(pool);
  const daily = calculateRequestCapacityWindow({
    cap,
    usedRequests: directProviderRequestsToday(pool),
    requestedRequests: 1,
    at,
    pacingEnabled,
    burstRequests: Math.min(cap, directProviderBurst(pool)),
  });
  if (!daily.allowed) return daily;

  const resumeAt = directRateLimitResumeAt(pool, at);
  if (resumeAt === null) return daily;
  return {
    ...daily,
    allowed: false,
    reason: 'paced',
    resumeAt: new Date(Math.max(at + 1_000, resumeAt)).toISOString(),
  };
}

/** Emergency cross-provider ceiling. This is deliberately higher than the
 * OpenRouter budget so BYOK adds capacity, but low enough that a retry storm
 * can never return APEX to a five-figure request day. */
const DEFAULT_EMERGENCY_TOTAL_CAP = 4_500;

export function emergencyTotalRequestCap(): number {
  const raw = process.env.APEX_EMERGENCY_REQUEST_CAP_TOTAL;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMERGENCY_TOTAL_CAP;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_EMERGENCY_TOTAL_CAP;
}

export function emergencyRequestCapacityWindow(at: number = Date.now()): RequestCapacityWindow {
  rolloverIfNeeded(at);
  return calculateRequestCapacityWindow({
    cap: emergencyTotalRequestCap(),
    usedRequests: allProviderRequestsToday(),
    requestedRequests: 1,
    at,
    pacingEnabled: false,
    burstRequests: emergencyTotalRequestCap(),
  });
}

/**
 * Resolve the configured cap for an account.
 *
 * Operators write APEX_REQUEST_CAPS against env NAMES, because that is what
 * they can see and reason about, while spend is tracked against the account
 * fingerprint. Confirmed sibling keys and aliases share one account, so
 * the strictest cap among them wins — summing them would recreate exactly the
 * over-authorization this fingerprinting exists to prevent.
 */
function capForFingerprint(fingerprint: string): number {
  const caps = parseCaps();
  const applicable = accountSiblings(fingerprint)
    .flatMap((sibling) => [caps[sibling], ...envNamesForFingerprint(sibling).map((name) => caps[name])])
    .filter((cap): cap is number => Number.isFinite(cap) && cap > 0);
  if (applicable.length === 0) return 0;
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
  const daily = calculateRequestCapacityWindow({
    cap: capForFingerprint(fingerprint),
    usedRequests: requestsAcrossAccount(fingerprint),
    requestedRequests: 1,
    at,
  });
  if (!daily.allowed) return daily;
  const recent = accountRecentRequests(fingerprint, at);
  const limit = accountRatePerMinute();
  if (limit <= 0 || recent.length < limit) return daily;
  return { ...daily, allowed: false, reason: 'paced',
    resumeAt: new Date(recent[recent.length - limit] + RATE_WINDOW_MS).toISOString() };
}

// ─── Short-window rate limiting ──────────────────────────────────────────────
//
// The daily ramp above bounds the DAY's total. It does not bound the RATE, and
// on 2026-09-12 that distinction cost the whole allowance in 26 minutes.
//
// The ramp releases `burst + cap x (elapsed / day)`, so a deploy at 17:20 UTC
// starts with ~2,000 requests already accrued and unspent — no throttle at all.
// APEX issued 1,388 requests in 26 minutes (~53/min), blew past OpenRouter's
// per-minute free-tier limit, collected 459 rate-limit failures, and parked
// every provider until the next UTC reset. Under budget for the day, and still
// a total outage.
//
// So the daily cap and the rate limit protect against different things and
// both are needed: the cap stops the day being overspent, this stops any
// single minute triggering the provider's own limiter.
const recentRequests: number[] = [];
const recentAccountRequests = new Map<string, number[]>();

function accountRatePerMinute(): number {
  const raw = Number(process.env.APEX_ACCOUNT_REQUEST_RATE_PER_MIN ?? 15);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15;
}

function accountRecentRequests(fingerprint: string, at: number): number[] {
  return accountSiblings(fingerprint).flatMap(sibling => {
    const recent = recentAccountRequests.get(sibling) ?? [];
    pruneSpecificRateWindow(recent, at);
    return recent;
  }).sort((a, b) => a - b);
}
const RATE_WINDOW_MS = 60_000;
/** Below OpenRouter's typical 20/min free-tier ceiling, with headroom for the
 *  retry a failure triggers. Sustained throughput is still governed by the
 *  daily ramp — this only clips instantaneous bursts. */
const DEFAULT_RATE_PER_MIN = 15;

function ratePerMinute(): number {
  const raw = process.env.APEX_REQUEST_RATE_PER_MIN;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RATE_PER_MIN;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RATE_PER_MIN;
  return Math.floor(value);
}

function pruneRateWindow(at: number): void {
  const cutoff = at - RATE_WINDOW_MS;
  while (recentRequests.length > 0 && recentRequests[0] <= cutoff) recentRequests.shift();
}

/** Requests issued in the last 60 seconds. */
export function requestsInLastMinute(at: number = Date.now()): number {
  pruneRateWindow(at);
  return recentRequests.length;
}

/** When the short window is full, the moment the oldest request ages out. */
export function rateLimitResumeAt(at: number = Date.now()): number | null {
  const limit = ratePerMinute();
  if (limit <= 0) return null;
  pruneRateWindow(at);
  if (recentRequests.length < limit) return null;
  return recentRequests[0] + RATE_WINDOW_MS;
}

export function isRequestBudgetExhausted(at: number = Date.now()): boolean {
  const cap = effectiveRequestCap();
  return cap > 0 && totalRequestsToday() >= cap;
}

export interface RequestLedgerSnapshot {
  day: string;
  persistence: 'postgres+memory' | 'memory-only';
  totalRequests: number;
  totalCap: number;
  totalCapReached: boolean;
  /** Cap as configured, before the observed-account clamp. */
  configuredCap: number;
  /** Distinct OpenRouter accounts the credit probe found, or null if it has
   *  not reported. This is provider-capacity telemetry only; it no longer
   *  changes the workspace hard ceiling. */
  observedAccounts: number | null;
  /** Requests issued in the last 60s, against the short-window limit. */
  lastMinute: number;
  ratePerMinute: number;
  /** Requests/day this workspace is on course for if the current rate holds.
   *  The number to compare against the provider allowance. */
  projectedDailyRequests: number | null;
  /** All upstream attempts across OpenRouter + independent BYOK pools. */
  allProviderRequests: number;
  emergencyCap: number;
  directProviders: Array<{
    pool: DirectRequestPool;
    requests: number;
    cap: number;
    remaining: number | null;
    lastMinute: number;
    ratePerMinute: number;
    projectedDailyRequests: number | null;
    pacing: RequestCapacityWindow;
  }>;
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
    /** Public identity of the OpenRouter account this key belongs to, once the
     *  credit probe has resolved it. Rows sharing a value share one free daily
     *  bucket — which is the thing two env names cannot tell you. */
    openRouterAccount: string | null;
    requests: number;
    /** Requests today across every key on that account: what the free tier
     *  meters and what the balancer levels. Equals `requests` when this key is
     *  alone on its account. */
    accountRequests: number;
    lastMinute: number;
    ratePerMinute: number;
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
  const fingerprints = new Set([...Object.keys(state.accounts), ...observedAccountByFingerprint.keys()]);
  const accounts = [...fingerprints]
    .map((fingerprint) => {
      const entry = state.accounts[fingerprint] ?? { requests: 0, succeeded: 0 };
      const directPool = directPoolForAccount(fingerprint);
      const directProvider = directPool
        ? fingerprint.slice(`${DIRECT_REQUEST_ACCOUNT_PREFIX}${directPool}:`.length)
        : null;
      const paidProvider = fingerprint.startsWith(PAID_REQUEST_ACCOUNT_PREFIX)
        ? fingerprint.slice(PAID_REQUEST_ACCOUNT_PREFIX.length)
        : null;
      const cap = directPool
        ? directProviderRequestCap(directPool)
        : paidProvider
          ? 0
          : capForFingerprint(fingerprint);
      const envNames = directPool || paidProvider ? [] : envNamesForFingerprint(fingerprint);
      const accountRequests = directPool || paidProvider ? entry.requests : requestsAcrossAccount(fingerprint);
      return {
        account: directPool
          ? `${directProvider ?? directPool} (BYOK:${directPool})`
          : paidProvider
            ? `${paidProvider} (paid)`
            : envNames.length > 0
              ? envNames.join(' + ')
              : '(retired key)',
        openRouterAccount: directPool || paidProvider ? null : observedAccountFor(fingerprint),
        requests: entry.requests,
        accountRequests,
        lastMinute: directPool || paidProvider ? 0 : accountRecentRequests(fingerprint, at).length,
        ratePerMinute: directPool || paidProvider ? 0 : accountRatePerMinute(),
        succeeded: entry.succeeded,
        failed: Math.max(0, entry.requests - entry.succeeded),
        cap,
        capReached: cap > 0 && accountRequests >= cap,
        percentOfCap: cap > 0 ? Math.round((accountRequests / cap) * 1000) / 10 : null,
        pacing: (() => {
          const daily = calculateRequestCapacityWindow({ cap, usedRequests: accountRequests, requestedRequests: 1, at });
          const recent = directPool || paidProvider ? [] : accountRecentRequests(fingerprint, at);
          const limit = accountRatePerMinute();
          return daily.allowed && limit > 0 && recent.length >= limit
            ? { ...daily, allowed: false, reason: 'paced' as const,
                resumeAt: new Date(recent[recent.length - limit] + RATE_WINDOW_MS).toISOString() }
            : daily;
        })(),
      };
    })
    .filter((entry) => !entry.account.includes('(BYOK:'))
    .sort((a, b) => b.requests - a.requests);

  const cap = effectiveRequestCap();
  // Keep the operator-visible free-pool total on the same accounting path as
  // requestCapacityWindow(). `accounts` also includes the paid-continuity row
  // for auditability, but paid traffic must not make the free pool look spent.
  const totalRequests = totalRequestsToday();
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

  const directProviders = (['groq', 'gemini'] as const).map((pool) => {
    const requests = directProviderRequestsToday(pool);
    const providerCap = directProviderRequestCap(pool);
    const recent = directRecentRequests[pool];
    pruneSpecificRateWindow(recent, at);
    return {
      pool,
      requests,
      cap: providerCap,
      remaining: providerCap > 0 ? Math.max(0, providerCap - requests) : null,
      lastMinute: recent.length,
      ratePerMinute: directProviderRatePerMinute(pool),
      projectedDailyRequests:
        elapsed >= 15 * 60 * 1000
          ? Math.round((requests * UTC_DAY_MS) / elapsed)
          : null,
      pacing: directProviderCapacityWindow(pool, at),
    };
  });

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
    configuredCap: totalRequestCap(),
    observedAccounts: getObservedAccountCount(),
    lastMinute: requestsInLastMinute(at),
    ratePerMinute: ratePerMinute(),
    projectedDailyRequests,
    allProviderRequests: allProviderRequestsToday(),
    emergencyCap: emergencyTotalRequestCap(),
    directProviders,
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

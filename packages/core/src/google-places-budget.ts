// ─── Google Places (New) spend guards ─────────────────────────────────────────
//
// Caps every billed Places request (each searchText page counts as one) so
// APEX cannot quietly walk past Google's free monthly allowance. Counts are
// persisted in the existing llm_request_usage_daily table:
//
//   daily:   day = "utc:YYYY-MM-DD", account = "places:google"
//   monthly: day = "mo:YYYY-MM",     account = "places:google:monthly"
//
// The "utc:" and "mo:" prefixes keep these rows out of the LLM request
// ledger, which only ever reads and resets rows whose day is a bare UTC
// date. No new table or migration is required.
//
// Hitting a cap is not an outage. The provider is skipped and reported as
// "google: daily cap reached" or "google: monthly free cap reached", which
// the lead-search capacity classifier treats as unconfigured. Circuit
// breakers and campaign failure accounting must not fire.
//
// Lead-search sweeps and the campaign runner stay off Google until
// GOOGLE_PLACES_SWEEPS_ENABLED=true (default false). Direct / on-demand
// lookups still run and still obey the caps. Sweeps stay off until a lead
// pack passes QC.

import { createHash } from 'crypto';

export const GOOGLE_PLACES_DAILY_REQUEST_CAP_ENV = 'GOOGLE_PLACES_DAILY_REQUEST_CAP';
export const GOOGLE_PLACES_MONTHLY_FREE_CAP_ENV = 'GOOGLE_PLACES_MONTHLY_FREE_CAP';
export const GOOGLE_PLACES_MONTHLY_WARN_AT_ENV = 'GOOGLE_PLACES_MONTHLY_WARN_AT';
export const GOOGLE_PLACES_ALLOW_OVER_FREE_CAP_ENV = 'GOOGLE_PLACES_ALLOW_OVER_FREE_CAP';
export const GOOGLE_PLACES_MAX_PAGES_ENV = 'GOOGLE_PLACES_MAX_PAGES';
export const GOOGLE_PLACES_SWEEPS_ENABLED_ENV = 'GOOGLE_PLACES_SWEEPS_ENABLED';

export const DEFAULT_GOOGLE_PLACES_DAILY_REQUEST_CAP = 10;
export const DEFAULT_GOOGLE_PLACES_MONTHLY_FREE_CAP = 1000;
export const DEFAULT_GOOGLE_PLACES_MONTHLY_WARN_AT = 500;
export const DEFAULT_GOOGLE_PLACES_MAX_PAGES = 1;

export const GOOGLE_PLACES_DAILY_ACCOUNT = 'places:google';
export const GOOGLE_PLACES_MONTHLY_ACCOUNT = 'places:google:monthly';

export const GOOGLE_PLACES_DAILY_CAP_NOTE = 'google: daily cap reached';
export const GOOGLE_PLACES_MONTHLY_CAP_NOTE = 'google: monthly free cap reached';
export const GOOGLE_PLACES_SWEEPS_DISABLED_NOTE = 'google: sweeps disabled';
export const GOOGLE_PLACES_LEDGER_UNAVAILABLE_NOTE = 'google: spend cap check unavailable, treated as not set';

export const CAMPAIGN_RUNNER_AGENT_ID = 'apex-campaign-runner';

/** Current searchText field mask: Enterprise SKU, no Atmosphere fields. */
export const GOOGLE_PLACES_FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.primaryTypeDisplayName',
  'places.rating',
  'places.userRatingCount',
  'nextPageToken',
] as const;

/**
 * Atmosphere-tier fields from Google's Places API (New) Place Data Fields
 * table (developers.google.com/maps/documentation/places/web-service/data-fields,
 * last updated 2026-11-09). Requesting any of these on Text Search upgrades
 * the call to the Enterprise + Atmosphere SKU.
 */
export const GOOGLE_PLACES_ATMOSPHERE_FIELDS = [
  'allowsDogs',
  'curbsidePickup',
  'delivery',
  'dineIn',
  'editorialSummary',
  'evChargeAmenitySummary',
  'evChargeOptions',
  'fuelOptions',
  'generativeSummary',
  'goodForChildren',
  'goodForGroups',
  'goodForWatchingSports',
  'liveMusic',
  'menuForChildren',
  'neighborhoodSummary',
  'outdoorSeating',
  'parkingOptions',
  'paymentOptions',
  'reservable',
  'restroom',
  'reviews',
  'reviewSummary',
  'routingSummaries',
  'servesBeer',
  'servesBreakfast',
  'servesBrunch',
  'servesCocktails',
  'servesCoffee',
  'servesDessert',
  'servesDinner',
  'servesLunch',
  'servesVegetarianFood',
  'servesWine',
  'takeout',
] as const;

export function atmosphereFieldsInMask(mask: readonly string[] = GOOGLE_PLACES_FIELD_MASK): string[] {
  const tokens = new Set(
    mask.flatMap((entry) => entry.split(',').map((part) => part.trim().replace(/^places\./, '')).filter(Boolean)),
  );
  return GOOGLE_PLACES_ATMOSPHERE_FIELDS.filter((field) => tokens.has(field));
}

function envInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env[name] ?? '').trim().toLowerCase());
}

export function googlePlacesDailyRequestCap(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, GOOGLE_PLACES_DAILY_REQUEST_CAP_ENV, DEFAULT_GOOGLE_PLACES_DAILY_REQUEST_CAP);
}

export function googlePlacesMonthlyFreeCap(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, GOOGLE_PLACES_MONTHLY_FREE_CAP_ENV, DEFAULT_GOOGLE_PLACES_MONTHLY_FREE_CAP);
}

export function googlePlacesMonthlyWarnAt(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, GOOGLE_PLACES_MONTHLY_WARN_AT_ENV, DEFAULT_GOOGLE_PLACES_MONTHLY_WARN_AT);
}

export function googlePlacesAllowOverFreeCap(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, GOOGLE_PLACES_ALLOW_OVER_FREE_CAP_ENV);
}

export function googlePlacesMaxPages(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger(env, GOOGLE_PLACES_MAX_PAGES_ENV, DEFAULT_GOOGLE_PLACES_MAX_PAGES);
}

export function googlePlacesSweepsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, GOOGLE_PLACES_SWEEPS_ENABLED_ENV);
}

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** UTC calendar month, YYYY-MM. */
export function utcMonth(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function googlePlacesDailyDayKey(day: string = utcDay()): string {
  return `utc:${day}`;
}

export function googlePlacesMonthlyDayKey(month: string = utcMonth()): string {
  return `mo:${month}`;
}

export function maskGooglePlacesQuery(query: string): { truncated: string; hash: string } {
  const normalized = query.replace(/\s+/g, ' ').trim();
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const truncated = normalized.length <= 48 ? normalized : `${normalized.slice(0, 45)}…`;
  return { truncated, hash };
}

export function isGooglePlacesSweepRequest(input: {
  sweep?: boolean;
  agentId?: string | null;
  taskTitle?: string | null;
  taskDescription?: string | null;
}): boolean {
  if (input.sweep === true) return true;
  if (input.agentId === CAMPAIGN_RUNNER_AGENT_ID) return true;
  if (input.taskTitle && /lead generation sweep/i.test(input.taskTitle)) return true;
  if (input.taskDescription && /AUTONOMOUS LEAD-GEN SWEEP/i.test(input.taskDescription)) return true;
  return false;
}

/** True when a sweep/campaign call must skip Google (default: yes). */
export function shouldSkipGooglePlacesForSweep(
  input: Parameters<typeof isGooglePlacesSweepRequest>[0],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isGooglePlacesSweepRequest(input) && !googlePlacesSweepsEnabled(env);
}

/** Campaign runner: Google is a usable structured source only when sweeps are on. */
export function googlePlacesUsableForSweeps(env: NodeJS.ProcessEnv = process.env): boolean {
  return googlePlacesSweepsEnabled(env);
}

export interface GooglePlacesBudgetStore {
  increment(dayKey: string, account: string): Promise<number>;
  decrement(dayKey: string, account: string): Promise<void>;
  read(dayKey: string, account: string): Promise<number>;
}

const databaseStore: GooglePlacesBudgetStore = {
  async increment(dayKey, account) {
    const [{ db, llmRequestUsageDaily }, { sql }] = await Promise.all([import('@workspace/db'), import('drizzle-orm')]);
    const rows = await db
      .insert(llmRequestUsageDaily)
      .values({ day: dayKey, account, requests: 1, succeeded: 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: { requests: sql`${llmRequestUsageDaily.requests} + 1`, updatedAt: new Date() },
      })
      .returning({ requests: llmRequestUsageDaily.requests });
    return Number(rows[0]?.requests ?? 1);
  },
  async decrement(dayKey, account) {
    const [{ db, llmRequestUsageDaily }, { sql, and, eq }] = await Promise.all([import('@workspace/db'), import('drizzle-orm')]);
    await db
      .update(llmRequestUsageDaily)
      .set({ requests: sql`GREATEST(${llmRequestUsageDaily.requests} - 1, 0)`, updatedAt: new Date() })
      .where(and(eq(llmRequestUsageDaily.day, dayKey), eq(llmRequestUsageDaily.account, account)));
  },
  async read(dayKey, account) {
    const [{ db, llmRequestUsageDaily }, { and, eq }] = await Promise.all([import('@workspace/db'), import('drizzle-orm')]);
    const rows = await db
      .select({ requests: llmRequestUsageDaily.requests })
      .from(llmRequestUsageDaily)
      .where(and(eq(llmRequestUsageDaily.day, dayKey), eq(llmRequestUsageDaily.account, account)));
    return Number(rows[0]?.requests ?? 0);
  },
};

export type GooglePlacesCapReason = 'daily_cap' | 'monthly_free_cap' | 'ledger_unavailable';

export interface GooglePlacesReservation {
  allowed: boolean;
  reason?: GooglePlacesCapReason;
  /** Diagnostic without the "google: " prefix when refused; empty when allowed. */
  detail: string;
  /** Full provider note, e.g. "google: daily cap reached". */
  note: string;
  dayCount: number;
  monthCount: number;
  dailyCap: number;
  monthlyCap: number;
  day: string;
  month: string;
}

export interface GooglePlacesWarning {
  month: string;
  used: number;
  cap: number;
  warnAt: number;
  message: string;
}

export interface GooglePlacesWarningSink {
  warn(warning: GooglePlacesWarning): void | Promise<void>;
}

const defaultWarningSink: GooglePlacesWarningSink = {
  async warn(warning) {
    console.warn(warning.message);
    if (process.env.NODE_ENV === 'test') return;
    try {
      const [{ db, approvals, logs }, { and, eq }, { randomUUID }] = await Promise.all([
        import('@workspace/db'),
        import('drizzle-orm'),
        import('crypto'),
      ]);
      const now = new Date();
      const subject = `Google Places monthly usage is ${warning.used}/${warning.cap} (UTC ${warning.month})`;
      const dedupeKey = `google-places-monthly-warn:${warning.month}`;
      const toolArgs = {
        subject,
        detail: warning.message,
        urgency: 'medium',
        category: 'provider_billing',
        provider: 'google_places',
        used: warning.used,
        cap: warning.cap,
        warnAt: warning.warnAt,
        month: warning.month,
      };
      const reason = `[MEDIUM · provider_billing] ${subject}`;
      const [existing] = await db
        .select({ id: approvals.id, occurrences: approvals.occurrences })
        .from(approvals)
        .where(and(eq(approvals.kind, 'escalation'), eq(approvals.status, 'pending'), eq(approvals.dedupeKey, dedupeKey)))
        .limit(1);
      if (existing) {
        await db
          .update(approvals)
          .set({ occurrences: (existing.occurrences ?? 1) + 1, lastOccurredAt: now, toolArgs, reason })
          .where(eq(approvals.id, existing.id));
      } else {
        await db.insert(approvals).values({
          id: randomUUID(),
          taskId: 'system',
          agentId: 'system:google-places-budget',
          toolName: 'google_places_budget',
          toolArgs,
          reason,
          status: 'pending',
          kind: 'escalation',
          dedupeKey,
          occurrences: 1,
          lastOccurredAt: now,
          createdAt: now,
        });
      }
      await db.insert(logs).values({
        agentId: 'system:google-places-budget',
        level: 'warn',
        message: warning.message,
        data: { used: warning.used, cap: warning.cap, warnAt: warning.warnAt, month: warning.month },
      });
    } catch (error) {
      console.warn(
        '[google-places] could not persist the monthly usage warning:',
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};

interface MemoryState {
  day: string;
  month: string;
  dayUsed: number;
  monthUsed: number;
  dayExhausted: boolean;
  monthExhausted: boolean;
  warnedMonth: string | null;
  storeFailedWarned: boolean;
}

function emptyState(): MemoryState {
  return {
    day: '',
    month: '',
    dayUsed: 0,
    monthUsed: 0,
    dayExhausted: false,
    monthExhausted: false,
    warnedMonth: null,
    storeFailedWarned: false,
  };
}

let store: GooglePlacesBudgetStore = databaseStore;
let warningSink: GooglePlacesWarningSink = defaultWarningSink;
let state = emptyState();
const taskSweepCache = new Map<string, boolean>();

function rollover(now: number): void {
  const day = utcDay(now);
  const month = utcMonth(now);
  if (state.day !== day) {
    state.day = day;
    state.dayUsed = 0;
    state.dayExhausted = false;
    state.storeFailedWarned = false;
  }
  if (state.month !== month) {
    state.month = month;
    state.monthUsed = 0;
    state.monthExhausted = false;
    if (state.warnedMonth !== month) state.warnedMonth = null;
  }
}

function capNote(reason: GooglePlacesCapReason): { detail: string; note: string } {
  if (reason === 'daily_cap') return { detail: 'daily cap reached', note: GOOGLE_PLACES_DAILY_CAP_NOTE };
  if (reason === 'monthly_free_cap') return { detail: 'monthly free cap reached', note: GOOGLE_PLACES_MONTHLY_CAP_NOTE };
  return { detail: 'spend cap check unavailable, treated as not set', note: GOOGLE_PLACES_LEDGER_UNAVAILABLE_NOTE };
}

function refused(
  reason: GooglePlacesCapReason,
  counts: { dayCount: number; monthCount: number; dailyCap: number; monthlyCap: number; day: string; month: string },
): GooglePlacesReservation {
  const { detail, note } = capNote(reason);
  return { allowed: false, reason, detail, note, ...counts };
}

async function emitMonthlyWarning(opts: {
  month: string;
  used: number;
  cap: number;
  warnAt: number;
}): Promise<void> {
  if (opts.warnAt <= 0 || opts.used < opts.warnAt) return;
  if (state.warnedMonth === opts.month) return;
  state.warnedMonth = opts.month;
  const message =
    `[google-places] Monthly free-tier warning: ${opts.used}/${opts.cap} billed requests in UTC ${opts.month} ` +
    `(threshold ${opts.warnAt}). Google Places will stop at the monthly cap unless ` +
    `${GOOGLE_PLACES_ALLOW_OVER_FREE_CAP_ENV}=true. Matthew wants to be told before costs start.`;
  await warningSink.warn({ ...opts, message });
}

function logBilledRequest(query: string, reservation: GooglePlacesReservation): void {
  const masked = maskGooglePlacesQuery(query);
  console.info(
    `[google-places] billed request day=${reservation.dayCount}/${reservation.dailyCap} ` +
      `month=${reservation.monthCount}/${reservation.monthlyCap} utc_day=${reservation.day} ` +
      `utc_month=${reservation.month} query="${masked.truncated}" hash=${masked.hash}`,
  );
}

/**
 * Reserve one billed Places request (one searchText page) against the UTC
 * daily and monthly caps. Call immediately before sending the page. A
 * reservation counts as a billed attempt. Never throws; fails closed when
 * the ledger cannot be read, skipping Google rather than risking uncounted
 * spend.
 */
export async function reserveGooglePlacesRequest(
  opts: { query?: string; now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<GooglePlacesReservation> {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  rollover(now);
  const dailyCap = googlePlacesDailyRequestCap(env);
  const monthlyCap = googlePlacesMonthlyFreeCap(env);
  const warnAt = googlePlacesMonthlyWarnAt(env);
  const allowOver = googlePlacesAllowOverFreeCap(env);
  const day = state.day;
  const month = state.month;
  const counts = (dayCount: number, monthCount: number) => ({
    dayCount,
    monthCount,
    dailyCap,
    monthlyCap,
    day,
    month,
  });

  if (dailyCap === 0 || state.dayExhausted || state.dayUsed >= dailyCap) {
    state.dayExhausted = true;
    return refused('daily_cap', counts(state.dayUsed, state.monthUsed));
  }
  if (!allowOver && monthlyCap === 0) {
    state.monthExhausted = true;
    return refused('monthly_free_cap', counts(state.dayUsed, state.monthUsed));
  }
  if (!allowOver && (state.monthExhausted || state.monthUsed >= monthlyCap)) {
    state.monthExhausted = true;
    return refused('monthly_free_cap', counts(state.dayUsed, state.monthUsed));
  }

  const dayKey = googlePlacesDailyDayKey(day);
  const monthKey = googlePlacesMonthlyDayKey(month);
  let dayCount: number;
  try {
    dayCount = await store.increment(dayKey, GOOGLE_PLACES_DAILY_ACCOUNT);
  } catch (error) {
    if (!state.storeFailedWarned) {
      state.storeFailedWarned = true;
      console.warn(
        '[google-places] cannot verify spend caps; skipping Google for this request:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return refused('ledger_unavailable', counts(state.dayUsed, state.monthUsed));
  }

  if (dayCount > dailyCap) {
    state.dayUsed = dailyCap;
    state.dayExhausted = true;
    await store.decrement(dayKey, GOOGLE_PLACES_DAILY_ACCOUNT).catch(() => undefined);
    return refused('daily_cap', counts(dailyCap, state.monthUsed));
  }

  let monthCount: number;
  try {
    monthCount = await store.increment(monthKey, GOOGLE_PLACES_MONTHLY_ACCOUNT);
  } catch (error) {
    await store.decrement(dayKey, GOOGLE_PLACES_DAILY_ACCOUNT).catch(() => undefined);
    if (!state.storeFailedWarned) {
      state.storeFailedWarned = true;
      console.warn(
        '[google-places] cannot verify the monthly spend cap; skipping Google for this request:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return refused('ledger_unavailable', counts(state.dayUsed, state.monthUsed));
  }

  if (!allowOver && monthCount > monthlyCap) {
    state.monthUsed = monthlyCap;
    state.monthExhausted = true;
    await Promise.all([
      store.decrement(monthKey, GOOGLE_PLACES_MONTHLY_ACCOUNT).catch(() => undefined),
      store.decrement(dayKey, GOOGLE_PLACES_DAILY_ACCOUNT).catch(() => undefined),
    ]);
    return refused('monthly_free_cap', counts(dayCount - 1, monthlyCap));
  }

  state.dayUsed = Math.max(state.dayUsed, dayCount);
  state.monthUsed = Math.max(state.monthUsed, monthCount);
  const reservation: GooglePlacesReservation = {
    allowed: true,
    detail: '',
    note: '',
    ...counts(state.dayUsed, state.monthUsed),
  };
  await emitMonthlyWarning({ month, used: state.monthUsed, cap: monthlyCap, warnAt });
  logBilledRequest(opts.query ?? '', reservation);
  return reservation;
}

export async function googlePlacesBudgetSnapshot(
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ day: string; month: string; dayUsed: number; monthUsed: number; dailyCap: number; monthlyCap: number; dayExhausted: boolean; monthExhausted: boolean }> {
  rollover(now);
  try {
    state.dayUsed = Math.max(state.dayUsed, await store.read(googlePlacesDailyDayKey(state.day), GOOGLE_PLACES_DAILY_ACCOUNT));
    state.monthUsed = Math.max(state.monthUsed, await store.read(googlePlacesMonthlyDayKey(state.month), GOOGLE_PLACES_MONTHLY_ACCOUNT));
  } catch {
    /* keep the in-memory count */
  }
  const dailyCap = googlePlacesDailyRequestCap(env);
  const monthlyCap = googlePlacesMonthlyFreeCap(env);
  const allowOver = googlePlacesAllowOverFreeCap(env);
  return {
    day: state.day,
    month: state.month,
    dayUsed: state.dayUsed,
    monthUsed: state.monthUsed,
    dailyCap,
    monthlyCap,
    dayExhausted: state.dayExhausted || state.dayUsed >= dailyCap,
    monthExhausted: !allowOver && (state.monthExhausted || state.monthUsed >= monthlyCap),
  };
}

const taskLookup: { fn?: (taskId: string) => Promise<{ title?: string | null; description?: string | null } | null> } = {};

async function defaultTaskLookup(taskId: string): Promise<{ title?: string | null; description?: string | null } | null> {
  if (process.env.NODE_ENV === 'test') return null;
  try {
    const [{ db, tasks }, { eq }] = await Promise.all([import('@workspace/db'), import('drizzle-orm')]);
    const [row] = await db
      .select({ title: tasks.title, description: tasks.description })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/** True when this tool call is a campaign/sweep and must not spend Google. */
export async function shouldSkipGooglePlacesCall(input: {
  sweep?: boolean;
  agentId?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  taskDescription?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = input.env ?? process.env;
  if (googlePlacesSweepsEnabled(env)) return false;
  if (isGooglePlacesSweepRequest(input)) return true;
  const taskId = input.taskId?.trim();
  if (!taskId) return false;
  if (taskSweepCache.has(taskId)) {
    return taskSweepCache.get(taskId) === true;
  }
  const row = await (taskLookup.fn ?? defaultTaskLookup)(taskId);
  const skip = isGooglePlacesSweepRequest({
    agentId: input.agentId,
    taskTitle: row?.title,
    taskDescription: row?.description,
  });
  taskSweepCache.set(taskId, skip);
  return skip;
}

/** Test hook: swap the persistence layer, warning sink, and memory. */
export function __setGooglePlacesBudgetStoreForTests(next?: GooglePlacesBudgetStore | null): void {
  store = next ?? databaseStore;
  state = emptyState();
  taskSweepCache.clear();
}

export function __setGooglePlacesWarningSinkForTests(sink?: GooglePlacesWarningSink | null): void {
  warningSink = sink ?? defaultWarningSink;
  state.warnedMonth = null;
}

export function __setGooglePlacesTaskLookupForTests(
  fn?: ((taskId: string) => Promise<{ title?: string | null; description?: string | null } | null>) | null,
): void {
  taskLookup.fn = fn ?? undefined;
  taskSweepCache.clear();
}

export function __resetGooglePlacesBudgetForTests(): void {
  store = databaseStore;
  warningSink = defaultWarningSink;
  state = emptyState();
  taskSweepCache.clear();
  taskLookup.fn = undefined;
}

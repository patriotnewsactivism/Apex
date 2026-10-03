/**
 * Direct Tavily credit budget for APEX lead search.
 *
 * APEX used to reach Tavily through BuildMyBot's shared account (the
 * `buildmybot-tavily-proxy` route), so every APEX lead search spent
 * BuildMyBot's monthly credits. When that plan hit its limit, every campaign
 * shard failed, retried, and logged — ~1,200 error lines in ten minutes.
 *
 * This module gives APEX its own Tavily account (TAVILY_API_KEY) with a hard
 * monthly credit budget sized for the free Researcher plan:
 *
 *   - search_depth is forced to `basic` (1 credit). `advanced` (2 credits) is
 *     only used when APEX_TAVILY_ADVANCED_ENABLED=true AND budget remains.
 *   - credits are reserved BEFORE a request (so parallel campaign shards can
 *     never overshoot) and persisted per UTC calendar month in the existing
 *     `llm_request_usage_daily` table (day = 'YYYY-MM', account =
 *     'tavily:direct'). No migration is needed; every existing reader of that
 *     table filters on a 'YYYY-MM-DD' day, so the month row is invisible to it.
 *   - at the stop line (budget − reserve, default 1000 − 50 = 950) APEX stops
 *     calling Tavily and returns a clean "deferred until <month start>"
 *     diagnostic instead of an HTTP error.
 *   - Tavily's own GET /usage (free) is used to reconcile: the larger of the
 *     local and remote counts wins, so usage from the dashboard or another
 *     client is respected.
 *   - plan-limit / disabled-account responses (432/433/402/401/403) mark the
 *     direct key unavailable for a cooldown, so a dead account is probed
 *     occasionally instead of on every search.
 *
 * It also owns the BuildMyBot-proxy switch (APEX_TAVILY_PROXY_ENABLED) and a
 * tiny shared "lead discovery paused" note that the campaign runner sets and
 * /api/health/detail reads.
 */

export type TavilySearchDepth = 'basic' | 'advanced';
export type TavilyProxyMode = 'auto' | 'on' | 'off';

export const TAVILY_LEDGER_ACCOUNT = 'tavily:direct';
const DEFAULT_MONTHLY_CREDITS = 1000;
const DEFAULT_RESERVE_CREDITS = 50;
const DEFAULT_RECONCILE_MIN = 30;
const DEFAULT_LIMIT_COOLDOWN_MIN = 60;

type Env = Record<string, string | undefined>;

export interface TavilyBudgetConfig {
  monthlyCredits: number;
  reserveCredits: number;
  /** Highest credit count APEX may reach this month (monthly − reserve). */
  stopAt: number;
  advancedEnabled: boolean;
  proxyMode: TavilyProxyMode;
  directKeyConfigured: boolean;
  reconcileMinutes: number;
  limitCooldownMinutes: number;
}

function intFromEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function boolFromEnv(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export function tavilyProxyMode(env: Env = process.env): TavilyProxyMode {
  const raw = env.APEX_TAVILY_PROXY_ENABLED?.trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (['1', 'true', 'yes', 'on'].includes(raw)) return 'on';
  if (['0', 'false', 'no', 'off'].includes(raw)) return 'off';
  return 'auto';
}

export function getTavilyBudgetConfig(env: Env = process.env): TavilyBudgetConfig {
  const monthlyCredits = intFromEnv(env, 'APEX_TAVILY_MONTHLY_CREDITS', DEFAULT_MONTHLY_CREDITS, 0, 10_000_000);
  const reserveCredits = intFromEnv(env, 'APEX_TAVILY_CREDIT_RESERVE', DEFAULT_RESERVE_CREDITS, 0, monthlyCredits);
  return {
    monthlyCredits,
    reserveCredits,
    stopAt: Math.max(0, monthlyCredits - reserveCredits),
    advancedEnabled: boolFromEnv(env, 'APEX_TAVILY_ADVANCED_ENABLED', false),
    proxyMode: tavilyProxyMode(env),
    directKeyConfigured: Boolean(env.TAVILY_API_KEY?.trim()),
    reconcileMinutes: intFromEnv(env, 'APEX_TAVILY_USAGE_RECONCILE_MIN', DEFAULT_RECONCILE_MIN, 1, 24 * 60),
    limitCooldownMinutes: intFromEnv(env, 'APEX_TAVILY_LIMIT_COOLDOWN_MIN', DEFAULT_LIMIT_COOLDOWN_MIN, 1, 7 * 24 * 60),
  };
}

/**
 * Whether webSearch may call BuildMyBot's Tavily proxy.
 *   - APEX_TAVILY_PROXY_ENABLED=false → never (even with no direct key).
 *   - APEX_TAVILY_PROXY_ENABLED=true  → allowed as a fallback after the direct key.
 *   - unset / auto (default)          → only when NO direct TAVILY_API_KEY exists,
 *     so installing APEX's own key automatically stops spending BuildMyBot's credits.
 */
export function tavilyProxyEnabled(env: Env = process.env): boolean {
  const mode = tavilyProxyMode(env);
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return !env.TAVILY_API_KEY?.trim();
}

export function tavilyProxyConfigured(env: Env = process.env): boolean {
  return Boolean(env.BUILDMYBOT_TAVILY_PROXY_URL?.trim() && env.BUILDMYBOT_TAVILY_PROXY_SECRET?.trim());
}

export function currentTavilyMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function nextTavilyMonthStart(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)); // Date.UTC month is 0-based, so m == next month
}

export function creditsForDepth(depth: TavilySearchDepth): number {
  return depth === 'advanced' ? 2 : 1;
}

// ─── Persistence seam ────────────────────────────────────────────────────────

export interface TavilyUsageStore {
  load(month: string): Promise<number>;
  add(month: string, credits: number): Promise<void>;
}

const dbStore: TavilyUsageStore = {
  async load(month) {
    if (process.env.NODE_ENV === 'test') return 0;
    const [{ db, llmRequestUsageDaily }, { and, eq }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    const [row] = await db
      .select({ requests: llmRequestUsageDaily.requests })
      .from(llmRequestUsageDaily)
      .where(and(eq(llmRequestUsageDaily.day, month), eq(llmRequestUsageDaily.account, TAVILY_LEDGER_ACCOUNT)))
      .limit(1);
    return row?.requests ?? 0;
  },
  async add(month, credits) {
    if (process.env.NODE_ENV === 'test' || credits <= 0) return;
    const [{ db, llmRequestUsageDaily }, { sql }] = await Promise.all([
      import('@workspace/db'),
      import('drizzle-orm'),
    ]);
    await db
      .insert(llmRequestUsageDaily)
      .values({ day: month, account: TAVILY_LEDGER_ACCOUNT, requests: credits, succeeded: 1, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: {
          requests: sql`${llmRequestUsageDaily.requests} + ${credits}`,
          succeeded: sql`${llmRequestUsageDaily.succeeded} + 1`,
          updatedAt: new Date(),
        },
      });
  },
};

// ─── State ───────────────────────────────────────────────────────────────────

interface RemoteUsage {
  at: string;
  planUsage: number | null;
  planLimit: number | null;
  keyUsage: number | null;
  plan: string | null;
  paygoLimit: number | null;
  error?: string;
}

interface TavilyState {
  month: string;
  used: number;
  reserved: number;
  hydrated: boolean;
  hydrating: Promise<void> | null;
  lastReconcileAt: number;
  reconciling: Promise<void> | null;
  remote: RemoteUsage | null;
  unavailableUntil: number;
  unavailableReason: string | null;
  searches: number;
  deferredForBudget: number;
  lastDeferralLogAt: number;
  exhaustedLoggedForMonth: string | null;
}

let store: TavilyUsageStore = dbStore;
let fetchImpl: typeof fetch = (...args) => fetch(...args);
let nowFn: () => number = () => Date.now();

function freshState(month = currentTavilyMonth(new Date(nowFn()))): TavilyState {
  return {
    month,
    used: 0,
    reserved: 0,
    hydrated: false,
    hydrating: null,
    lastReconcileAt: 0,
    reconciling: null,
    remote: null,
    unavailableUntil: 0,
    unavailableReason: null,
    searches: 0,
    deferredForBudget: 0,
    lastDeferralLogAt: 0,
    exhaustedLoggedForMonth: null,
  };
}

let state: TavilyState = freshState();

function rollMonth(): void {
  const month = currentTavilyMonth(new Date(nowFn()));
  if (month !== state.month) {
    const carry = { unavailableUntil: state.unavailableUntil, unavailableReason: state.unavailableReason };
    state = freshState(month);
    // A plan-limit cooldown is about the account, not our counter; a new
    // calendar month may or may not be a new Tavily billing cycle, so keep
    // the cooldown and let it expire naturally.
    Object.assign(state, carry);
  }
}

async function hydrate(): Promise<void> {
  rollMonth();
  if (state.hydrated) return;
  if (!state.hydrating) {
    const month = state.month;
    state.hydrating = (async () => {
      try {
        const persisted = await store.load(month);
        if (state.month === month) state.used = Math.max(state.used, persisted);
      } catch (err) {
        console.warn('[tavily-budget] could not load persisted usage; counting from in-process state:', err instanceof Error ? err.message : String(err));
      } finally {
        if (state.month === month) {
          state.hydrated = true;
          state.hydrating = null;
        }
      }
    })();
  }
  await state.hydrating;
}

function effectiveStopAt(cfg: TavilyBudgetConfig): number {
  // If Tavily reports a lower plan limit than we were configured for, respect it.
  const planLimit = state.remote?.planLimit;
  if (typeof planLimit === 'number' && planLimit > 0 && planLimit < cfg.monthlyCredits) {
    return Math.max(0, planLimit - cfg.reserveCredits);
  }
  return cfg.stopAt;
}

/** Resolve the depth a request may actually use. Basic unless advanced is
 *  explicitly enabled AND there is room for 2 credits under the stop line. */
export function resolveTavilySearchDepth(requested: TavilySearchDepth, env: Env = process.env): TavilySearchDepth {
  if (requested !== 'advanced') return 'basic';
  const cfg = getTavilyBudgetConfig(env);
  if (!cfg.advancedEnabled) return 'basic';
  return state.used + state.reserved + 2 <= effectiveStopAt(cfg) ? 'advanced' : 'basic';
}

export type TavilyReservation =
  | { ok: true; id: number; month: string; credits: number; depth: TavilySearchDepth }
  | { ok: false; code: 'budget_exhausted' | 'unavailable'; retryAt: string; detail: string };

let reservationSeq = 0;

/**
 * Reserve credits for one Tavily request. Returns ok:false (never throws)
 * when the monthly stop line or an account cooldown blocks the call.
 */
export async function reserveTavilyCredits(
  requestedDepth: TavilySearchDepth = 'basic',
  env: Env = process.env,
): Promise<TavilyReservation> {
  await hydrate();
  maybeReconcileInBackground(env);
  const cfg = getTavilyBudgetConfig(env);
  const now = nowFn();

  if (state.unavailableUntil > now) {
    return {
      ok: false,
      code: 'unavailable',
      retryAt: new Date(state.unavailableUntil).toISOString(),
      detail: `tavily: unavailable until ${new Date(state.unavailableUntil).toISOString()} (${state.unavailableReason ?? 'provider limit'})`,
    };
  }

  const depth = resolveTavilySearchDepth(requestedDepth, env);
  const credits = creditsForDepth(depth);
  const stopAt = effectiveStopAt(cfg);
  if (state.used + state.reserved + credits > stopAt) {
    state.deferredForBudget += 1;
    const retryAt = nextTavilyMonthStart(state.month).toISOString();
    if (state.exhaustedLoggedForMonth !== state.month) {
      state.exhaustedLoggedForMonth = state.month;
      console.log(
        `[tavily-budget] monthly credit budget reached (${state.used}/${cfg.monthlyCredits} used, stop at ${stopAt}). ` +
          `Direct Tavily searches deferred until ${retryAt}.`,
      );
    }
    return {
      ok: false,
      code: 'budget_exhausted',
      retryAt,
      detail: `tavily: monthly credit budget reached (${state.used}/${cfg.monthlyCredits}, stop at ${stopAt}); deferred until ${retryAt}`,
    };
  }

  state.reserved += credits;
  reservationSeq += 1;
  return { ok: true, id: reservationSeq, month: state.month, credits, depth };
}

/**
 * Settle a reservation. `charged` is true when Tavily answered 2xx (Tavily
 * does not bill failed requests). `actualCredits` overrides the estimate when
 * the response carried `usage.credits`.
 */
export async function settleTavilyCredits(
  reservation: Extract<TavilyReservation, { ok: true }>,
  outcome: { charged: boolean; actualCredits?: number | null },
): Promise<void> {
  if (state.month === reservation.month) {
    state.reserved = Math.max(0, state.reserved - reservation.credits);
  }
  if (!outcome.charged) return;
  const credits =
    typeof outcome.actualCredits === 'number' && Number.isFinite(outcome.actualCredits) && outcome.actualCredits >= 0
      ? Math.ceil(outcome.actualCredits)
      : reservation.credits;
  if (state.month === reservation.month) {
    state.used += credits;
    state.searches += 1;
  }
  try {
    await store.add(reservation.month, credits);
  } catch (err) {
    console.warn('[tavily-budget] usage persist failed (in-process count still enforced):', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Record a non-2xx direct-Tavily response. Plan-limit / disabled / auth
 * failures park the key for APEX_TAVILY_LIMIT_COOLDOWN_MIN (default 60 min).
 * Returns true only on the transition into the unavailable state, so callers
 * log once instead of once per search.
 */
export function noteTavilyFailure(status: number, body: string, env: Env = process.env): boolean {
  const cfg = getTavilyBudgetConfig(env);
  let cooldownMs = 0;
  let reason = '';
  if (status === 432 || status === 433) {
    cooldownMs = cfg.limitCooldownMinutes * 60_000;
    reason = `HTTP ${status} plan/pay-as-you-go limit`;
  } else if (status === 402) {
    cooldownMs = cfg.limitCooldownMinutes * 60_000;
    reason = /disabled/i.test(body) ? 'HTTP 402 account disabled (unpaid balance)' : 'HTTP 402 payment required';
  } else if (status === 401 || status === 403) {
    cooldownMs = cfg.limitCooldownMinutes * 60_000;
    reason = `HTTP ${status} key rejected`;
  } else if (status === 429) {
    cooldownMs = 60_000;
    reason = 'HTTP 429 rate limited';
  } else if (status >= 500) {
    cooldownMs = 30_000;
    reason = `HTTP ${status} upstream error`;
  }
  if (cooldownMs <= 0) return false;
  const until = nowFn() + cooldownMs;
  const wasAvailable = state.unavailableUntil <= nowFn();
  if (until > state.unavailableUntil) {
    state.unavailableUntil = until;
    state.unavailableReason = reason;
  }
  if (wasAvailable) {
    console.warn(
      `[tavily-budget] direct Tavily unavailable until ${new Date(state.unavailableUntil).toISOString()}: ${reason}. ` +
        `${body.replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  }
  return wasAvailable;
}

export function tavilyDirectAvailableNow(): boolean {
  return state.unavailableUntil <= nowFn();
}

// ─── Remote reconcile (GET /usage — free) ────────────────────────────────────

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function reconcileTavilyUsage(env: Env = process.env): Promise<RemoteUsage | null> {
  const key = env.TAVILY_API_KEY?.trim();
  if (!key) return null;
  await hydrate();
  const month = state.month;
  state.lastReconcileAt = nowFn();
  try {
    const res = await fetchImpl('https://api.tavily.com/usage', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      state.remote = { at: new Date(nowFn()).toISOString(), planUsage: null, planLimit: null, keyUsage: null, plan: null, paygoLimit: null, error: `HTTP ${res.status}` };
      noteTavilyFailure(res.status, body, env);
      return state.remote;
    }
    const data = (await res.json()) as {
      key?: { usage?: unknown };
      account?: { current_plan?: unknown; plan_usage?: unknown; plan_limit?: unknown; paygo_limit?: unknown };
    };
    const remote: RemoteUsage = {
      at: new Date(nowFn()).toISOString(),
      planUsage: num(data.account?.plan_usage),
      planLimit: num(data.account?.plan_limit),
      keyUsage: num(data.key?.usage),
      plan: typeof data.account?.current_plan === 'string' ? data.account.current_plan : null,
      paygoLimit: num(data.account?.paygo_limit),
    };
    state.remote = remote;
    const remoteUsed = remote.planUsage ?? remote.keyUsage;
    if (remoteUsed !== null && state.month === month && remoteUsed > state.used) {
      state.used = remoteUsed;
    }
    return remote;
  } catch (err) {
    state.remote = {
      at: new Date(nowFn()).toISOString(),
      planUsage: null,
      planLimit: null,
      keyUsage: null,
      plan: null,
      paygoLimit: null,
      error: err instanceof Error ? err.message : String(err),
    };
    return state.remote;
  }
}

function maybeReconcileInBackground(env: Env): void {
  if (process.env.NODE_ENV === 'test' && !reconcileInTests) return;
  if (!env.TAVILY_API_KEY?.trim() || state.reconciling) return;
  const cfg = getTavilyBudgetConfig(env);
  if (nowFn() - state.lastReconcileAt < cfg.reconcileMinutes * 60_000) return;
  state.reconciling = reconcileTavilyUsage(env)
    .catch(() => null)
    .then(() => {
      state.reconciling = null;
    });
}

// ─── Lead-discovery pause note (written by the campaign runner) ──────────────

let leadDiscoveryPause: { until: string; reason: string; since: string; skippedTicks: number } | null = null;

export function noteLeadDiscoveryPaused(until: Date, reason: string): boolean {
  const fresh = !leadDiscoveryPause || new Date(leadDiscoveryPause.until).getTime() <= nowFn();
  leadDiscoveryPause = {
    until: until.toISOString(),
    reason: reason.slice(0, 300),
    since: fresh ? new Date(nowFn()).toISOString() : leadDiscoveryPause!.since,
    skippedTicks: fresh ? 0 : leadDiscoveryPause!.skippedTicks,
  };
  return fresh;
}

export function noteLeadDiscoveryTickSkipped(): void {
  if (leadDiscoveryPause) leadDiscoveryPause.skippedTicks += 1;
}

export function clearLeadDiscoveryPause(): void {
  leadDiscoveryPause = null;
}

export function getLeadDiscoveryPause(): { until: string; reason: string; since: string; skippedTicks: number } | null {
  if (leadDiscoveryPause && new Date(leadDiscoveryPause.until).getTime() <= nowFn()) return null;
  return leadDiscoveryPause ? { ...leadDiscoveryPause } : null;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export function getTavilyStatus(env: Env = process.env) {
  rollMonth();
  const cfg = getTavilyBudgetConfig(env);
  const stopAt = effectiveStopAt(cfg);
  const proxyEnabled = tavilyProxyEnabled(env);
  const proxyConfigured = tavilyProxyConfigured(env);
  const route = cfg.directKeyConfigured
    ? proxyEnabled && proxyConfigured
      ? 'direct+proxy-fallback'
      : 'direct'
    : proxyEnabled && proxyConfigured
      ? 'buildmybot-proxy'
      : 'none';
  return {
    route,
    directKeyConfigured: cfg.directKeyConfigured,
    proxy: { mode: cfg.proxyMode, enabled: proxyEnabled, configured: proxyConfigured },
    searchDepth: cfg.advancedEnabled ? 'basic (advanced allowed when budget remains)' : 'basic (forced)',
    budget: {
      month: state.month,
      used: state.used,
      reserved: state.reserved,
      monthlyCredits: cfg.monthlyCredits,
      reserveCredits: cfg.reserveCredits,
      stopAt,
      remaining: Math.max(0, stopAt - state.used - state.reserved),
      exhausted: state.used + state.reserved + 1 > stopAt,
      resetsAt: nextTavilyMonthStart(state.month).toISOString(),
      persisted: state.hydrated,
      searchesThisProcess: state.searches,
      deferredThisProcess: state.deferredForBudget,
    },
    availability: {
      available: state.unavailableUntil <= nowFn(),
      unavailableUntil: state.unavailableUntil > nowFn() ? new Date(state.unavailableUntil).toISOString() : null,
      reason: state.unavailableUntil > nowFn() ? state.unavailableReason : null,
    },
    remoteUsage: state.remote,
    leadDiscoveryPause: getLeadDiscoveryPause(),
  };
}

// ─── Test seams ──────────────────────────────────────────────────────────────

let reconcileInTests = false;

export function __setTavilyBudgetTestHooks(hooks: {
  store?: TavilyUsageStore;
  fetch?: typeof fetch;
  now?: () => number;
  reconcileInTests?: boolean;
}): void {
  if (hooks.store) store = hooks.store;
  if (hooks.fetch) fetchImpl = hooks.fetch;
  if (hooks.now) nowFn = hooks.now;
  if (hooks.reconcileInTests !== undefined) reconcileInTests = hooks.reconcileInTests;
}

export function __resetTavilyBudgetForTests(): void {
  store = dbStore;
  fetchImpl = (...args) => fetch(...args);
  nowFn = () => Date.now();
  reconcileInTests = false;
  state = freshState();
  leadDiscoveryPause = null;
  reservationSeq = 0;
}

// ─── Web-search provider router: cache → SearXNG → capped free-credit APIs ───
//
// Order (see tool-registry webSearch):
//   1. Query cache (Postgres lead_search_cache, TTL WEB_SEARCH_CACHE_TTL_DAYS,
//      default 14, clamped to 7–30). Postgres rather than Valkey: the cache
//      already lives there, it survives container recreation and is in the DB
//      backups, and APEX gains no new runtime dependency. Valkey stays private
//      to SearXNG's limiter.
//   2. Self-hosted SearXNG (SEARXNG_URL, e.g. http://searxng:8080). Free, so
//      it also runs in freeOnly mode. Guarded by a circuit breaker only.
//   3. Exa → Brave → Bright Data, each with a HARD MONTHLY request cap set at
//      ~90% of the provider's free monthly allowance, persisted in
//      llm_request_usage_daily (day = "mo:YYYY-MM" UTC, account =
//      "search:<provider>:monthly") so a restart cannot reset it, plus a
//      circuit breaker. The "mo:" prefix keeps rows out of the LLM ledger,
//      which only reads bare UTC dates.
import { db, llmRequestUsageDaily } from '@workspace/db';
import { sql, and, eq } from 'drizzle-orm';

// ── Cache TTL ────────────────────────────────────────────────────────────────
export const WEB_SEARCH_CACHE_TTL_ENV = 'WEB_SEARCH_CACHE_TTL_DAYS';
export const DEFAULT_WEB_SEARCH_CACHE_TTL_DAYS = 14;
export const MIN_WEB_SEARCH_CACHE_TTL_DAYS = 7;
export const MAX_WEB_SEARCH_CACHE_TTL_DAYS = 30;

export function webSearchCacheTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[WEB_SEARCH_CACHE_TTL_ENV] ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_WEB_SEARCH_CACHE_TTL_DAYS;
  return Math.min(MAX_WEB_SEARCH_CACHE_TTL_DAYS, Math.max(MIN_WEB_SEARCH_CACHE_TTL_DAYS, n));
}

// ── Monthly caps ─────────────────────────────────────────────────────────────
export type CappedSearchProvider = 'exa' | 'brave' | 'brightdata';

/** ~90% of each provider's free monthly allowance (verified 2026-10-20):
 *  - Exa: $10 free credit/month (exa.ai/pricing); Search is $7/1k requests at
 *    the worst-case "auto" rate → ~1,428 requests → 1,280.
 *  - Brave: $5 free credit/month at $5/1k requests
 *    (api-dashboard.search.brave.com/documentation/pricing) → 1,000 → 900.
 *  - Bright Data: 5,000 free credits/month, 1 credit per Web Unlocker/SERP
 *    request (docs.brightdata.com/general/account/billing-and-pricing/free-tier)
 *    → 4,500. */
export const DEFAULT_MONTHLY_SEARCH_CAPS: Record<CappedSearchProvider, number> = {
  exa: 1280,
  brave: 900,
  brightdata: 4500,
};
export const MONTHLY_CAP_ENV: Record<CappedSearchProvider, string> = {
  exa: 'EXA_SEARCH_MONTHLY_REQUEST_CAP',
  brave: 'BRAVE_SEARCH_MONTHLY_REQUEST_CAP',
  brightdata: 'BRIGHT_DATA_MONTHLY_REQUEST_CAP',
};

export function monthlySearchCap(provider: CappedSearchProvider, env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[MONTHLY_CAP_ENV[provider]] ?? '').trim();
  if (!raw) return DEFAULT_MONTHLY_SEARCH_CAPS[provider];
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MONTHLY_SEARCH_CAPS[provider];
}

/** UTC calendar month key, "mo:YYYY-MM" (free allowances renew on the 1st). */
export function monthKey(now: number = Date.now()): string {
  return `mo:${new Date(now).toISOString().slice(0, 7)}`;
}
export function monthlyAccount(provider: CappedSearchProvider): string {
  return `search:${provider}:monthly`;
}

export interface MonthlySearchBudgetStore {
  increment(month: string, account: string): Promise<number>;
  decrement(month: string, account: string): Promise<void>;
}

export const postgresMonthlySearchBudgetStore: MonthlySearchBudgetStore = {
  async increment(month, account) {
    const rows = await db.insert(llmRequestUsageDaily)
      .values({ day: month, account, requests: 1, succeeded: 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [llmRequestUsageDaily.day, llmRequestUsageDaily.account],
        set: { requests: sql`${llmRequestUsageDaily.requests} + 1`, updatedAt: new Date() },
      })
      .returning({ requests: llmRequestUsageDaily.requests });
    return Number(rows[0]?.requests ?? 1);
  },
  async decrement(month, account) {
    await db.update(llmRequestUsageDaily)
      .set({ requests: sql`GREATEST(${llmRequestUsageDaily.requests} - 1, 0)`, updatedAt: new Date() })
      .where(and(eq(llmRequestUsageDaily.day, month), eq(llmRequestUsageDaily.account, account)));
  },
};

let monthlyStore: MonthlySearchBudgetStore = postgresMonthlySearchBudgetStore;
export function __setMonthlySearchBudgetStoreForTests(store?: MonthlySearchBudgetStore): void {
  monthlyStore = store ?? postgresMonthlySearchBudgetStore;
}

/** Reserve one request against the provider's monthly cap BEFORE sending it.
 *  Never throws; fails closed (not allowed) if the ledger is unreachable. */
export async function reserveMonthlySearch(
  provider: CappedSearchProvider,
  opts: { store?: MonthlySearchBudgetStore; env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<{ allowed: boolean; detail?: string }> {
  const store = opts.store ?? monthlyStore;
  const cap = monthlySearchCap(provider, opts.env);
  if (cap === 0) return { allowed: false, detail: 'monthly request cap is 0 (disabled)' };
  const month = monthKey(opts.now);
  const account = monthlyAccount(provider);
  try {
    if (await store.increment(month, account) <= cap) return { allowed: true };
    await store.decrement(month, account).catch(() => undefined);
    return { allowed: false, detail: `monthly request cap reached (${cap}/${month.slice(3)} UTC)` };
  } catch (error) {
    console.warn(`[search-router] cannot verify ${provider} monthly cap; skipping provider:`,
      error instanceof Error ? error.message : String(error));
    return { allowed: false, detail: 'monthly request cap check unavailable' };
  }
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
/** Opens after `threshold` consecutive failures for `cooldownMs`, then lets one
 *  probe through (half-open); a success closes it, a failure re-opens it. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  constructor(
    readonly name: string,
    private readonly threshold = 3,
    private readonly cooldownMs = 5 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}
  canRequest(): boolean { return this.clock() >= this.openUntil; }
  isOpen(): boolean { return !this.canRequest(); }
  success(): void { this.failures = 0; this.openUntil = 0; }
  failure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.openUntil = this.clock() + this.cooldownMs;
      this.failures = this.threshold - 1; // half-open: next failure re-opens
      console.warn(`[search-router] circuit open for ${this.name} for ${Math.round(this.cooldownMs / 1000)}s`);
    }
  }
  reset(): void { this.failures = 0; this.openUntil = 0; }
}

export const searxngBreaker = new CircuitBreaker(
  'searxng',
  Number(process.env.SEARXNG_BREAKER_FAILURES) || 3,
  (Number(process.env.SEARXNG_BREAKER_COOLDOWN_SECONDS) || 120) * 1000,
);

// ── SearXNG client ───────────────────────────────────────────────────────────
export interface WebResult { title: string; url: string; snippet: string }

export class SearxngError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'SearxngError'; }
}

export async function searchSearxng(
  query: string,
  options: { baseUrl?: string; maxResults?: number; fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<WebResult[]> {
  const base = (options.baseUrl ?? process.env.SEARXNG_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new SearxngError(0, 'SEARXNG_URL not set');
  const n = Math.max(1, Math.min(50, Math.trunc(options.maxResults ?? 10)));
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en-US&safesearch=0`;
  const res = await (options.fetcher ?? fetch)(url, {
    headers: {
      Accept: 'application/json',
      // The limiter needs a client IP; APEX is a trusted internal client.
      'X-Forwarded-For': '127.0.0.1',
      'X-Real-IP': '127.0.0.1',
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
  });
  if (!res.ok) throw new SearxngError(res.status, `searxng HTTP ${res.status}`);
  const data = await res.json() as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
  const seen = new Set<string>();
  const out: WebResult[] = [];
  for (const r of Array.isArray(data.results) ? data.results : []) {
    if (typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url) || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({
      title: typeof r.title === 'string' && r.title ? r.title : r.url,
      url: r.url,
      snippet: typeof r.content === 'string' ? r.content : '',
    });
    if (out.length >= n) break;
  }
  return out;
}

/** Give back a reservation that was never billed (e.g. an auth/payment
 *  refusal). Never throws. */
export async function releaseMonthlySearch(
  provider: CappedSearchProvider,
  opts: { store?: MonthlySearchBudgetStore; now?: number } = {},
): Promise<void> {
  const store = opts.store ?? monthlyStore;
  await store.decrement(monthKey(opts.now), monthlyAccount(provider)).catch((error) => {
    console.warn(`[search-router] could not release ${provider} monthly reservation:`,
      error instanceof Error ? error.message : String(error));
  });
}

/** Auth / payment refusals: retrying cannot succeed until an operator fixes
 *  the account, so they must not consume the cap and should open the breaker
 *  for a long time. 407 = Bright Data proxy/zone authentication required. */
export const AUTH_OR_PAYMENT_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 407]);
export function isAuthOrPaymentFailure(status: number): boolean {
  return AUTH_OR_PAYMENT_STATUSES.has(status);
}

/** BRIGHT_DATA_AUTH_FAILURE_COOLDOWN_MINUTES, default 360 (6 h). */
export function brightDataAuthFailureCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.BRIGHT_DATA_AUTH_FAILURE_COOLDOWN_MINUTES ?? '').trim() || NaN);
  return (Number.isFinite(n) && n > 0 ? n : 360) * 60_000;
}

/**
 * Search router: cache TTL bounds, persisted monthly caps, circuit breaker,
 * SearXNG client, and the webSearch provider order
 * (SearXNG → Exa → Brave → Bright Data). No network, no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  DEFAULT_MONTHLY_SEARCH_CAPS,
  __setMonthlySearchBudgetStoreForTests,
  monthKey,
  monthlySearchCap,
  reserveMonthlySearch,
  searchSearxng,
  searxngBreaker,
  webSearchCacheTtlDays,
  type MonthlySearchBudgetStore,
} from '../../../core/src/search-router.js';
import { __setExaSearchBudgetStoreForTests } from '../../../core/src/exa-search-budget.js';
import { __setBrightDataBudgetStoreForTests } from '../../../core/src/brightdata-budget.js';
import { isAuthOrPaymentFailure, brightDataAuthFailureCooldownMs, releaseMonthlySearch } from '../../../core/src/search-router.js';
import { getToolRegistry, leadSearchCacheSpec, __resetWebSearchCooldownsForTests } from '../../../core/src/tool-registry.js';

function memStore(): MonthlySearchBudgetStore & { rows: Map<string, number> } {
  const rows = new Map<string, number>();
  return {
    rows,
    async increment(m, a) { const k = `${m}|${a}`; const v = (rows.get(k) ?? 0) + 1; rows.set(k, v); return v; },
    async decrement(m, a) { const k = `${m}|${a}`; rows.set(k, Math.max(0, (rows.get(k) ?? 0) - 1)); },
  };
}

describe('cache TTL', () => {
  it('defaults to 14 days and clamps to 7–30', () => {
    expect(webSearchCacheTtlDays({})).toBe(14);
    expect(webSearchCacheTtlDays({ WEB_SEARCH_CACHE_TTL_DAYS: '3' })).toBe(7);
    expect(webSearchCacheTtlDays({ WEB_SEARCH_CACHE_TTL_DAYS: '90' })).toBe(30);
    expect(webSearchCacheTtlDays({ WEB_SEARCH_CACHE_TTL_DAYS: '21' })).toBe(21);
    expect(webSearchCacheTtlDays({ WEB_SEARCH_CACHE_TTL_DAYS: 'x' })).toBe(14);
  });
  it('caches ordinary (non-fast) webSearch with the TTL', () => {
    const spec = leadSearchCacheSpec('webSearch', { query: 'roofers Dallas' });
    expect(spec?.cacheKind).toBe('web');
    expect(spec?.ttlMs).toBe(14 * 86_400_000);
    expect(leadSearchCacheSpec('webSearch', { query: 'roofers Dallas', fast: true })?.cacheKind).toBe('web_fast');
  });
});

describe('monthly caps', () => {
  it('uses ~90% of free tiers by default', () => {
    expect(DEFAULT_MONTHLY_SEARCH_CAPS).toEqual({ exa: 1280, brave: 900, brightdata: 4500 });
    expect(monthlySearchCap('brave', { BRAVE_SEARCH_MONTHLY_REQUEST_CAP: '10' })).toBe(10);
    expect(monthlySearchCap('brave', { BRAVE_SEARCH_MONTHLY_REQUEST_CAP: '-1' })).toBe(900);
  });
  it('refuses past the cap and survives a "restart" (same store, new call)', async () => {
    const store = memStore();
    const env = { EXA_SEARCH_MONTHLY_REQUEST_CAP: '2' };
    const now = Date.UTC(2026, 9, 20);
    expect((await reserveMonthlySearch('exa', { store, env, now })).allowed).toBe(true);
    expect((await reserveMonthlySearch('exa', { store, env, now })).allowed).toBe(true);
    const third = await reserveMonthlySearch('exa', { store, env, now });
    expect(third.allowed).toBe(false);
    expect(store.rows.get('mo:2026-10|search:exa:monthly')).toBe(2);
    // next month resets
    expect((await reserveMonthlySearch('exa', { store, env, now: Date.UTC(2026, 10, 1) })).allowed).toBe(true);
    expect(monthKey(now)).toBe('mo:2026-10');
  });
  it('fails closed when the ledger is down', async () => {
    const store: MonthlySearchBudgetStore = { async increment() { throw new Error('ECONNREFUSED'); }, async decrement() {} };
    expect((await reserveMonthlySearch('brave', { store, env: {} })).allowed).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('opens after N failures, half-opens after cooldown, closes on success', () => {
    let t = 0;
    const b = new CircuitBreaker('x', 2, 1000, () => t);
    b.failure(); expect(b.canRequest()).toBe(true);
    b.failure(); expect(b.canRequest()).toBe(false);
    t = 1000; expect(b.canRequest()).toBe(true);
    b.failure(); expect(b.canRequest()).toBe(false);
    t = 2000; b.success(); b.failure(); expect(b.canRequest()).toBe(true);
  });
});

describe('searchSearxng', () => {
  it('parses JSON results and dedupes', async () => {
    const fetcher = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain('format=json');
      return new Response(JSON.stringify({ results: [
        { title: 'A', url: 'https://a.example', content: 'a' },
        { title: 'A dup', url: 'https://a.example' },
        { title: 'bad', url: 'javascript:x' },
        { url: 'https://b.example' },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await searchSearxng('q', { baseUrl: 'http://searxng:8080/', fetcher });
    expect(r).toEqual([
      { title: 'A', url: 'https://a.example', snippet: 'a' },
      { title: 'https://b.example', url: 'https://b.example', snippet: '' },
    ]);
  });
});

describe('webSearch provider order', () => {
  const KEYS = ['SEARXNG_URL', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'EXA_API_KEY', 'BRIGHT_DATA_API_KEY', 'BRIGHT_DATA_ZONE'];
  const saved: Record<string, string | undefined> = {};
  let store: ReturnType<typeof memStore>;
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    store = memStore();
    __setMonthlySearchBudgetStoreForTests(store);
    let n = 0;
    __setExaSearchBudgetStoreForTests({ async increment() { return ++n; }, async decrement() { n--; } });
    __resetWebSearchCooldownsForTests();
    searxngBreaker.reset();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __setMonthlySearchBudgetStoreForTests();
    __setExaSearchBudgetStoreForTests();
    vi.unstubAllGlobals();
  });

  function stub(searx: 'ok' | 'down'): string[] {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('http://searxng:8080')) {
        return searx === 'ok'
          ? new Response(JSON.stringify({ results: [{ title: 'S', url: 'https://s.example', content: 's' }] }), { status: 200 })
          : new Response('busy', { status: 503 });
      }
      if (url.includes('api.exa.ai')) return new Response(JSON.stringify({ results: [{ title: 'E', url: 'https://e.example', highlights: ['e'] }] }), { status: 200 });
      if (url.includes('api.search.brave.com')) return new Response(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://b.example', description: 'b' }] } }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    return calls;
  }
  const run = (args: Record<string, unknown> = {}) =>
    getToolRegistry().get('webSearch')!.execute({ query: 'roofing Dallas', maxResults: 5, ...args }) as Promise<{ provider: string; diagnostics?: string[] }>;

  it('uses SearXNG first and never touches paid providers when it answers', async () => {
    Object.assign(process.env, { SEARXNG_URL: 'http://searxng:8080', EXA_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'k' });
    const calls = stub('ok');
    expect((await run()).provider).toBe('searxng');
    expect(calls.some((c) => c.includes('exa.ai') || c.includes('brave.com'))).toBe(false);
  });
  it('falls to Exa before Brave, counting the monthly cap', async () => {
    Object.assign(process.env, { SEARXNG_URL: 'http://searxng:8080', EXA_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'k' });
    stub('down');
    expect((await run()).provider).toBe('exa');
    expect([...store.rows.entries()].find(([k]) => k.endsWith('search:exa:monthly'))?.[1]).toBe(1);
  });
  it('skips Exa at its monthly cap and uses Brave', async () => {
    Object.assign(process.env, { SEARXNG_URL: 'http://searxng:8080', EXA_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'k', EXA_SEARCH_MONTHLY_REQUEST_CAP: '0' });
    stub('down');
    const r = await run();
    delete process.env.EXA_SEARCH_MONTHLY_REQUEST_CAP;
    expect(r.provider).toBe('brave');
  });
});

describe('Bright Data auth/payment refusals', () => {
  const KEYS = ['SEARXNG_URL', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'EXA_API_KEY', 'BRIGHT_DATA_API_KEY', 'BRIGHT_DATA_ZONE'];
  const saved: Record<string, string | undefined> = {};
  let store: ReturnType<typeof memStore>;
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, { BRIGHT_DATA_API_KEY: 'k', BRIGHT_DATA_ZONE: 'z' });
    store = memStore();
    __setMonthlySearchBudgetStoreForTests(store);
    let d = 0;
    __setBrightDataBudgetStoreForTests({
      async increment() { return ++d; }, async decrement() { d--; }, async succeed() {}, async read() { return d; },
    });
    __resetWebSearchCooldownsForTests();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __setMonthlySearchBudgetStoreForTests();
    __setBrightDataBudgetStoreForTests(null);
    vi.unstubAllGlobals();
  });
  const bdMonthly = () => [...store.rows.entries()].find(([k]) => k.endsWith('search:brightdata:monthly'))?.[1] ?? 0;
  function stubBd(mode: { inner?: number; outer?: number }): string[] {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input); calls.push(url);
      if (url.includes('api.brightdata.com')) {
        if (mode.outer) return new Response('{"error":"auth"}', { status: mode.outer });
        return new Response(JSON.stringify({ status_code: mode.inner, body: '' }), { status: 200 });
      }
      if (url.includes('api.duckduckgo.com')) return new Response('{}', { status: 200 });
      return new Response('<html></html>', { status: 200 });
    }));
    return calls;
  }
  const run = () => getToolRegistry().get('webSearch')!.execute({ query: 'roofing Dallas', maxResults: 5 }) as Promise<{ provider: string; diagnostics?: string[] }>;
  const bdCalls = (c: string[]) => c.filter((u) => u.includes('api.brightdata.com')).length;

  it('classifies 401/402/403/407 as auth/payment failures', () => {
    for (const s of [401, 402, 403, 407]) expect(isAuthOrPaymentFailure(s)).toBe(true);
    for (const s of [200, 429, 500, 502]) expect(isAuthOrPaymentFailure(s)).toBe(false);
    expect(brightDataAuthFailureCooldownMs({})).toBe(360 * 60_000);
    expect(brightDataAuthFailureCooldownMs({ BRIGHT_DATA_AUTH_FAILURE_COOLDOWN_MINUTES: '60' })).toBe(3_600_000);
  });

  for (const inner of [401, 402, 403, 407]) {
    it(`inner ${inner}: refunds the monthly slot, no retry, breaker stays open`, async () => {
      const calls = stubBd({ inner });
      const r = await run();
      expect(bdCalls(calls)).toBe(1);
      expect(bdMonthly()).toBe(0);
      expect(r.diagnostics?.some((d) => d.includes(`HTTP ${inner}`) && d.includes('breaker open'))).toBe(true);
      await run();
      expect(bdCalls(calls)).toBe(1); // breaker skipped Bright Data
      expect(bdMonthly()).toBe(0);
    });
  }

  it('outer 407 from api.brightdata.com also refunds and opens the breaker', async () => {
    const calls = stubBd({ outer: 407 });
    await run(); await run();
    expect(bdCalls(calls)).toBe(1);
    expect(bdMonthly()).toBe(0);
  });

  it('a transient inner 502 still counts toward the cap', async () => {
    stubBd({ inner: 502 });
    await run();
    expect(bdMonthly()).toBeGreaterThan(0);
  });

  it('releaseMonthlySearch never throws', async () => {
    __setMonthlySearchBudgetStoreForTests({ async increment() { return 1; }, async decrement() { throw new Error('down'); } });
    await expect(releaseMonthlySearch('brightdata')).resolves.toBeUndefined();
  });
});

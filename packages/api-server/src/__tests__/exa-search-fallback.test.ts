/**
 * Exa is a capped, paid web-search fallback. When it cannot be used — no key,
 * the daily budget spent, the quota ledger unreachable, or Exa itself failing
 * — webSearch must skip to the next provider (or return an empty, explained
 * result) and never throw to the caller. Brave out of credit (HTTP 402) must
 * likewise just move on. No network, no database: fetch and the budget store
 * are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToolRegistry, __resetWebSearchCooldownsForTests } from '../../../core/src/tool-registry.js';
import {
  __setExaSearchBudgetStoreForTests,
  reserveExaSearch,
  type ExaSearchBudgetStore,
} from '../../../core/src/exa-search-budget.js';
import { __setMonthlySearchBudgetStoreForTests } from '../../../core/src/search-router.js';

type Call = { url: string };
const KEYS = ['BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'EXA_API_KEY', 'BRIGHT_DATA_API_KEY', 'BRIGHT_DATA_ZONE', 'EXA_SEARCH_DAILY_REQUEST_CAP'] as const;
const saved: Record<string, string | undefined> = {};

function memoryStore(start = 0): ExaSearchBudgetStore & { n: number } {
  const s = { n: start, async increment() { s.n += 1; return s.n; }, async decrement() { s.n = Math.max(0, s.n - 1); } };
  return s;
}
const brokenStore: ExaSearchBudgetStore = {
  async increment() { throw new Error('connect ECONNREFUSED'); },
  async decrement() { throw new Error('connect ECONNREFUSED'); },
};

function stubFetch(exa: 'ok' | 'empty' | 402 | 'throw'): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url });
    if (url.includes('api.search.brave.com')) {
      return new Response('{"type":"ErrorResponse","error":{"status":402,"detail":"Prepaid credit balance is insufficient"}}', { status: 402 });
    }
    if (url.includes('api.exa.ai')) {
      if (exa === 'throw') throw new TypeError('fetch failed');
      if (exa === 402) return new Response('{"error":"credits"}', { status: 402 });
      const results = exa === 'ok' ? [{ title: 'Acme Roofing', url: 'https://acme.example', highlights: ['Roofing in Dallas'] }] : [];
      return new Response(JSON.stringify({ results, requestId: 'r1' }), { status: 200 });
    }
    // DuckDuckGo fallbacks: nothing found.
    if (url.includes('api.duckduckgo.com')) return new Response('{}', { status: 200 });
    return new Response('<html><body></body></html>', { status: 200 });
  }));
  return calls;
}

async function webSearch(args: Record<string, unknown> = {}) {
  const tool = getToolRegistry().get('webSearch');
  if (!tool) throw new Error('webSearch tool not registered');
  return tool.execute({ query: 'roofing contractor Dallas Texas', maxResults: 5, ...args }) as Promise<{
    provider: string; results: unknown[]; diagnostics?: string[];
  }>;
}
const exaCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('api.exa.ai')).length;

describe('Exa web-search fallback degrades gracefully', () => {
  beforeEach(() => {
    // Monthly caps are persisted in Postgres; use an in-memory ledger here.
    { let m = 0; __setMonthlySearchBudgetStoreForTests({ async increment() { return ++m; }, async decrement() { m--; } }); }
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.BRAVE_SEARCH_API_KEY = 'test-brave';
    __resetWebSearchCooldownsForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __setExaSearchBudgetStoreForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Brave 402 + no EXA_API_KEY: skips Exa, no throw, explains why', async () => {
    const calls = stubFetch('ok');
    const r = await webSearch();
    expect(exaCalls(calls)).toBe(0);
    expect(r.provider).toBe('none');
    expect(r.results).toEqual([]);
    expect(r.diagnostics?.some((d) => d.startsWith('brave: HTTP 402'))).toBe(true);
    expect(r.diagnostics).toContain('exa: EXA_API_KEY not set');
  });

  it('Brave 402 then Exa answers: Exa results are returned', async () => {
    process.env.EXA_API_KEY = 'test-exa';
    __setExaSearchBudgetStoreForTests(memoryStore());
    stubFetch('ok');
    const r = await webSearch();
    expect(r.provider).toBe('exa');
    expect(r.results).toHaveLength(1);
  });

  it('Exa daily budget exhausted: no Exa request is made, search continues', async () => {
    process.env.EXA_API_KEY = 'test-exa';
    process.env.EXA_SEARCH_DAILY_REQUEST_CAP = '3';
    const store = memoryStore(3);
    __setExaSearchBudgetStoreForTests(store);
    const calls = stubFetch('ok');
    const r = await webSearch();
    expect(exaCalls(calls)).toBe(0);
    expect(store.n).toBe(3); // the over-cap reservation was given back
    expect(r.provider).toBe('none');
    expect(r.diagnostics?.some((d) => d.includes('exa: daily request cap reached (3/day CT)'))).toBe(true);
  });

  it('Exa cap set to 0: Exa is disabled without touching the ledger', async () => {
    process.env.EXA_API_KEY = 'test-exa';
    process.env.EXA_SEARCH_DAILY_REQUEST_CAP = '0';
    __setExaSearchBudgetStoreForTests(brokenStore);
    const calls = stubFetch('ok');
    const r = await webSearch();
    expect(exaCalls(calls)).toBe(0);
    expect(r.diagnostics?.some((d) => d.includes('exa: daily request cap reached (disabled)'))).toBe(true);
  });

  it('quota tracking unavailable: Exa fails closed, search continues, no throw', async () => {
    process.env.EXA_API_KEY = 'test-exa';
    __setExaSearchBudgetStoreForTests(brokenStore);
    const calls = stubFetch('ok');
    const r = await webSearch();
    expect(exaCalls(calls)).toBe(0);
    expect(r.provider).toBe('none');
    expect(r.diagnostics).toContain('exa: daily request cap check unavailable');
  });

  it('Exa out of credit (402): breaker opens, next search skips Exa entirely', async () => {
    process.env.EXA_API_KEY = 'test-exa';
    __setExaSearchBudgetStoreForTests(memoryStore());
    const calls = stubFetch(402);
    const first = await webSearch();
    expect(first.diagnostics).toContain('exa: HTTP 402');
    expect(exaCalls(calls)).toBe(1);
    const second = await webSearch();
    expect(exaCalls(calls)).toBe(1);
    expect(second.diagnostics).toContain('exa: temporarily skipped by provider circuit breaker');
    expect(second.results).toEqual([]);
  });

  it('Exa network error or zero results: continues to the next provider', async () => {
    process.env.EXA_API_KEY = 'test-exa';
    __setExaSearchBudgetStoreForTests(memoryStore());
    stubFetch('throw');
    const a = await webSearch();
    expect(a.diagnostics?.some((d) => d.startsWith('exa: '))).toBe(true);
    expect(a.provider).toBe('none');
    __resetWebSearchCooldownsForTests();
    stubFetch('empty');
    const b = await webSearch();
    expect(b.diagnostics).toContain('exa: 200 but zero results');
  });

  it('freeOnly mode never calls Exa', async () => {
    process.env.EXA_API_KEY = 'test-exa';
    __setExaSearchBudgetStoreForTests(memoryStore());
    const calls = stubFetch('ok');
    const r = await webSearch({ freeOnly: true });
    expect(exaCalls(calls)).toBe(0);
    expect(r.diagnostics).toContain('exa: skipped by freeOnly mode');
  });

  it('reserveExaSearch never throws, even if the store throws', async () => {
    await expect(reserveExaSearch(brokenStore, { EXA_SEARCH_DAILY_REQUEST_CAP: '5' })).resolves.toEqual({
      allowed: false, detail: 'daily request cap check unavailable',
    });
    const s = memoryStore();
    await expect(reserveExaSearch(s, { EXA_SEARCH_DAILY_REQUEST_CAP: '1' })).resolves.toEqual({ allowed: true });
    const over = await reserveExaSearch(s, { EXA_SEARCH_DAILY_REQUEST_CAP: '1' });
    expect(over.allowed).toBe(false);
    expect(s.n).toBe(1);
  });
});

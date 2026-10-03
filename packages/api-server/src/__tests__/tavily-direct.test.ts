import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTavilyBudgetForTests,
  __setTavilyBudgetTestHooks,
  getTavilyBudgetConfig,
  getTavilyStatus,
  noteTavilyFailure,
  reconcileTavilyUsage,
  reserveTavilyCredits,
  resolveTavilySearchDepth,
  settleTavilyCredits,
  tavilyProxyEnabled,
  type TavilyUsageStore,
} from '../../../core/src/tavily-budget.js';
import { __resetWebSearchProviderCooldownsForTests, getToolRegistry, getWebSearchProviderCooldowns } from '../../../core/src/tool-registry.js';
import type { ToolContext } from '../../../core/src/types.js';

const PROXY_URL = 'https://bmb.example.test/api/integrations/apex/tavily-search';

function memoryStore(initial = 0): TavilyUsageStore & { rows: Map<string, number>; adds: Array<[string, number]> } {
  const rows = new Map<string, number>();
  const adds: Array<[string, number]> = [];
  return {
    rows,
    adds,
    async load(month) {
      return rows.get(month) ?? initial;
    },
    async add(month, credits) {
      adds.push([month, credits]);
      rows.set(month, (rows.get(month) ?? initial) + credits);
    },
  };
}

const ctx: ToolContext = { agentId: 'test', workspaceRoot: process.cwd(), requestApproval: async () => false };

async function webSearch(args: Record<string, unknown>) {
  const tool = getToolRegistry().get('webSearch');
  if (!tool) throw new Error('webSearch missing');
  return tool.execute(args, ctx) as Promise<{
    provider: string;
    results: unknown[];
    diagnostics?: string[];
    searchUnavailable?: { providers: string[]; retryAt: string };
  }>;
}

type Call = { url: string; body: Record<string, unknown> | null };

/** fetch stub: Tavily/proxy behaviour supplied per test, DuckDuckGo always empty. */
function stubFetch(handlers: { tavily?: () => Response; proxy?: () => Response }) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (url === 'https://api.tavily.com/search') {
      if (!handlers.tavily) throw new Error('unexpected tavily call');
      return handlers.tavily();
    }
    if (url === PROXY_URL) {
      if (!handlers.proxy) throw new Error('unexpected proxy call');
      return handlers.proxy();
    }
    if (url.startsWith('https://lite.duckduckgo.com')) return new Response('<html></html>', { status: 200 });
    if (url.startsWith('https://api.duckduckgo.com')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const okTavily = (credits = 1) => () =>
  new Response(
    JSON.stringify({ results: [{ title: 'Acme Roofing', url: 'https://acme.example', content: 'roofing' }], usage: { credits } }),
    { status: 200 },
  );

function setSearchEnv(env: Record<string, string>) {
  for (const key of [
    'TAVILY_API_KEY',
    'BRAVE_SEARCH_API_KEY',
    'BUILDMYBOT_TAVILY_PROXY_URL',
    'BUILDMYBOT_TAVILY_PROXY_SECRET',
    'APEX_TAVILY_PROXY_ENABLED',
    'APEX_TAVILY_MONTHLY_CREDITS',
    'APEX_TAVILY_CREDIT_RESERVE',
    'APEX_TAVILY_ADVANCED_ENABLED',
  ]) {
    vi.stubEnv(key, env[key] ?? '');
  }
}

beforeEach(() => {
  __resetTavilyBudgetForTests();
  __resetWebSearchProviderCooldownsForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('tavily budget config + proxy switch', () => {
  it('defaults to a 1000-credit month with a 50-credit reserve (stop at 950), basic only, proxy auto', () => {
    const cfg = getTavilyBudgetConfig({});
    expect(cfg).toMatchObject({ monthlyCredits: 1000, reserveCredits: 50, stopAt: 950, advancedEnabled: false, proxyMode: 'auto' });
  });

  it('auto proxy mode turns the BuildMyBot proxy off as soon as a direct key exists', () => {
    expect(tavilyProxyEnabled({ TAVILY_API_KEY: 'tvly-x' })).toBe(false);
    expect(tavilyProxyEnabled({})).toBe(true);
    expect(tavilyProxyEnabled({ APEX_TAVILY_PROXY_ENABLED: 'false' })).toBe(false);
    expect(tavilyProxyEnabled({ APEX_TAVILY_PROXY_ENABLED: 'true', TAVILY_API_KEY: 'tvly-x' })).toBe(true);
  });

  it('forces basic depth unless advanced is explicitly enabled and budget remains', () => {
    expect(resolveTavilySearchDepth('advanced', {})).toBe('basic');
    expect(resolveTavilySearchDepth('advanced', { APEX_TAVILY_ADVANCED_ENABLED: 'true' })).toBe('advanced');
    expect(
      resolveTavilySearchDepth('advanced', { APEX_TAVILY_ADVANCED_ENABLED: 'true', APEX_TAVILY_MONTHLY_CREDITS: '1', APEX_TAVILY_CREDIT_RESERVE: '0' }),
    ).toBe('basic');
  });
});

describe('tavily credit ledger', () => {
  it('charges only successful requests, honours usage.credits, and persists per calendar month', async () => {
    const store = memoryStore();
    __setTavilyBudgetTestHooks({ store, now: () => Date.parse('2026-10-03T21:00:00Z') });
    const a = await reserveTavilyCredits('basic', {});
    if (!a.ok) throw new Error('expected reservation');
    await settleTavilyCredits(a, { charged: false });
    const b = await reserveTavilyCredits('basic', {});
    if (!b.ok) throw new Error('expected reservation');
    await settleTavilyCredits(b, { charged: true, actualCredits: 1 });
    expect(store.adds).toEqual([['2026-10', 1]]);
    expect(getTavilyStatus({}).budget).toMatchObject({ month: '2026-10', used: 1, reserved: 0, remaining: 949 });
  });

  it('stops at the 950 line, defers cleanly until next month, and parallel callers cannot overshoot', async () => {
    __setTavilyBudgetTestHooks({ store: memoryStore(947), now: () => Date.parse('2026-10-03T21:00:00Z') });
    const results = await Promise.all(Array.from({ length: 6 }, () => reserveTavilyCredits('basic', {})));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const denied = results.find((r) => !r.ok);
    expect(denied).toMatchObject({ ok: false, code: 'budget_exhausted', retryAt: '2026-11-01T00:00:00.000Z' });
    expect(getTavilyStatus({}).budget.exhausted).toBe(true);
  });

  it('starts a fresh count when the UTC calendar month rolls over', async () => {
    let now = Date.parse('2026-10-31T23:59:00Z');
    __setTavilyBudgetTestHooks({ store: memoryStore(0), now: () => now });
    const a = await reserveTavilyCredits('basic', {});
    if (!a.ok) throw new Error('expected');
    await settleTavilyCredits(a, { charged: true });
    expect(getTavilyStatus({}).budget.used).toBe(1);
    now = Date.parse('2026-11-01T00:01:00Z');
    expect(getTavilyStatus({}).budget).toMatchObject({ month: '2026-11', used: 0 });
  });

  it('reconciles with Tavily GET /usage (larger count wins, lower plan limit respected)', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ key: { usage: 400 }, account: { current_plan: 'Researcher', plan_usage: 420, plan_limit: 500 } }), { status: 200 }),
    );
    __setTavilyBudgetTestHooks({ store: memoryStore(10), fetch: fetchStub as unknown as typeof fetch });
    await reconcileTavilyUsage({ TAVILY_API_KEY: 'tvly-test' });
    const status = getTavilyStatus({ TAVILY_API_KEY: 'tvly-test' });
    expect(status.budget.used).toBe(420);
    expect(status.budget.stopAt).toBe(450); // plan 500 − reserve 50
    expect(status.remoteUsage).toMatchObject({ plan: 'Researcher', planUsage: 420, planLimit: 500 });
  });

  it('parks the key after a plan-limit / disabled-account response and reports it once', async () => {
    __setTavilyBudgetTestHooks({ store: memoryStore() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(noteTavilyFailure(402, 'Your account is currently disabled', {})).toBe(true);
    expect(noteTavilyFailure(432, 'exceeds your plan', {})).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const r = await reserveTavilyCredits('basic', {});
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('webSearch routing', () => {
  it('with a direct key, uses Tavily basic depth and never calls the BuildMyBot proxy (auto mode)', async () => {
    setSearchEnv({ TAVILY_API_KEY: 'tvly-test', BUILDMYBOT_TAVILY_PROXY_URL: PROXY_URL, BUILDMYBOT_TAVILY_PROXY_SECRET: 's' });
    const store = memoryStore();
    __setTavilyBudgetTestHooks({ store });
    const calls = stubFetch({ tavily: okTavily(1) });
    const res = await webSearch({ query: 'roofing Birmingham AL' }); // non-fast: used to be 'advanced'
    expect(res.provider).toBe('tavily');
    expect(calls.some((c) => c.url === PROXY_URL)).toBe(false);
    const tavilyCall = calls.find((c) => c.url === 'https://api.tavily.com/search');
    expect(tavilyCall?.body).toMatchObject({ search_depth: 'basic', include_usage: true });
    expect(store.adds).toEqual([[expect.stringMatching(/^\d{4}-\d{2}$/), 1]]);
  });

  it('APEX_TAVILY_PROXY_ENABLED=false never calls the proxy even with no direct key', async () => {
    setSearchEnv({ BUILDMYBOT_TAVILY_PROXY_URL: PROXY_URL, BUILDMYBOT_TAVILY_PROXY_SECRET: 's', APEX_TAVILY_PROXY_ENABLED: 'false' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = stubFetch({});
    const res = await webSearch({ query: 'roofing Birmingham AL', fast: true });
    expect(calls.some((c) => c.url === PROXY_URL)).toBe(false);
    expect(res.diagnostics).toContain('buildmybot-tavily: disabled by APEX_TAVILY_PROXY_ENABLED');
  });

  it('opens a long breaker on the proxy when it relays a Tavily 432, then stops calling it', async () => {
    setSearchEnv({ BUILDMYBOT_TAVILY_PROXY_URL: PROXY_URL, BUILDMYBOT_TAVILY_PROXY_SECRET: 's' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = stubFetch({
      proxy: () =>
        new Response(
          JSON.stringify({ error: 'Tavily search failed with HTTP 432', detail: "This request exceeds your plan's set usage limit." }),
          { status: 502 },
        ),
    });
    const first = await webSearch({ query: 'us news Juneau AK', fast: true });
    expect(first.searchUnavailable?.providers).toEqual(['buildmybot-tavily']);
    const until = Date.parse(getWebSearchProviderCooldowns()['buildmybot-tavily']);
    expect(until - Date.now()).toBeGreaterThan(50 * 60 * 1000); // long-open (default 1 h), not 30 s

    for (let i = 0; i < 20; i += 1) {
      const r = await webSearch({ query: `us news city ${i}`, fast: true });
      expect(r.searchUnavailable?.providers).toEqual(['buildmybot-tavily']);
    }
    expect(calls.filter((c) => c.url === PROXY_URL)).toHaveLength(1);
    // One breaker line + at most one rate-limited "all providers empty" line — not 21+21.
    const proxyLines = warn.mock.calls.filter((c) => String(c[0]).includes('buildmybot-tavily'));
    expect(proxyLines.length).toBeLessThanOrEqual(2);
  });

  it('defers without any HTTP call when the monthly budget is spent', async () => {
    setSearchEnv({ TAVILY_API_KEY: 'tvly-test' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setTavilyBudgetTestHooks({ store: memoryStore(950) });
    const calls = stubFetch({});
    const res = await webSearch({ query: 'plumbers Tulsa OK', fast: true });
    expect(calls.some((c) => c.url === 'https://api.tavily.com/search')).toBe(false);
    expect(res.diagnostics?.some((d) => d.includes('monthly credit budget reached'))).toBe(true);
    expect(res.searchUnavailable).toMatchObject({ providers: ['tavily'] });
  });

  it('falls back to the proxy only when explicitly enabled and the direct key is parked', async () => {
    setSearchEnv({ TAVILY_API_KEY: 'tvly-test', BUILDMYBOT_TAVILY_PROXY_URL: PROXY_URL, BUILDMYBOT_TAVILY_PROXY_SECRET: 's', APEX_TAVILY_PROXY_ENABLED: 'true' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setTavilyBudgetTestHooks({ store: memoryStore() });
    const calls = stubFetch({
      tavily: () => new Response(JSON.stringify({ detail: { error: 'Your account is currently disabled.' } }), { status: 402 }),
      proxy: () => new Response(JSON.stringify({ provider: 'buildmybot-tavily-proxy', results: [{ title: 'A', url: 'https://a.example' }] }), { status: 200 }),
    });
    const res = await webSearch({ query: 'roofing Mesa AZ', fast: true });
    expect(res.provider).toBe('buildmybot-tavily-proxy');
    expect(calls.filter((c) => c.url === 'https://api.tavily.com/search')).toHaveLength(1);
    expect(getTavilyStatus().availability.available).toBe(false);
  });
});

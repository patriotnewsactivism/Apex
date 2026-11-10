/**
 * Google Places spend guards: UTC daily/monthly caps (each searchText page
 * counts), the 500 monthly warning, the 1000 stop and its override, max pages,
 * not-configured treatment, sweep skip, and the Atmosphere field-mask guard.
 * No network, no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GOOGLE_PLACES_DAILY_REQUEST_CAP,
  DEFAULT_GOOGLE_PLACES_MAX_PAGES,
  DEFAULT_GOOGLE_PLACES_MONTHLY_FREE_CAP,
  DEFAULT_GOOGLE_PLACES_MONTHLY_WARN_AT,
  GOOGLE_PLACES_ATMOSPHERE_FIELDS,
  GOOGLE_PLACES_DAILY_ACCOUNT,
  GOOGLE_PLACES_DAILY_CAP_NOTE,
  GOOGLE_PLACES_FIELD_MASK,
  GOOGLE_PLACES_LEDGER_UNAVAILABLE_NOTE,
  GOOGLE_PLACES_MONTHLY_ACCOUNT,
  GOOGLE_PLACES_MONTHLY_CAP_NOTE,
  GOOGLE_PLACES_SWEEPS_DISABLED_NOTE,
  __resetGooglePlacesBudgetForTests,
  __setGooglePlacesBudgetStoreForTests,
  __setGooglePlacesTaskLookupForTests,
  __setGooglePlacesWarningSinkForTests,
  atmosphereFieldsInMask,
  googlePlacesAllowOverFreeCap,
  googlePlacesDailyDayKey,
  googlePlacesDailyRequestCap,
  googlePlacesMaxPages,
  googlePlacesMonthlyDayKey,
  googlePlacesMonthlyFreeCap,
  googlePlacesMonthlyWarnAt,
  googlePlacesSweepsEnabled,
  isGooglePlacesSweepRequest,
  maskGooglePlacesQuery,
  reserveGooglePlacesRequest,
  shouldSkipGooglePlacesCall,
  shouldSkipGooglePlacesForSweep,
  utcDay,
  utcMonth,
  type GooglePlacesBudgetStore,
  type GooglePlacesWarning,
} from '../../../core/src/google-places-budget.js';
import { decideSegmentFailure } from '../../../background-jobs/src/campaign-runner.js';
import { classifyLeadDiscoveryFailure, discoveryZeroMessage } from '../../../background-jobs/src/lead-search-capacity.js';
import { getToolRegistry } from '../../../core/src/tool-registry.js';
import { resetDirectoryProviderKeyState } from '../../../core/src/lead-provider-keys.js';

const VALID_GOOGLE = `AIza${'g'.repeat(35)}`;
const NOW = Date.UTC(2026, 10, 10, 14, 30, 0); // 2026-11-10 14:30 UTC

function memStore(): GooglePlacesBudgetStore & { rows: Map<string, number> } {
  const rows = new Map<string, number>();
  return {
    rows,
    async increment(day, account) {
      const k = `${day}|${account}`;
      const v = (rows.get(k) ?? 0) + 1;
      rows.set(k, v);
      return v;
    },
    async decrement(day, account) {
      const k = `${day}|${account}`;
      rows.set(k, Math.max(0, (rows.get(k) ?? 0) - 1));
    },
    async read(day, account) {
      return rows.get(`${day}|${account}`) ?? 0;
    },
  };
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...extra };
}

const lookupCtx = {
  agentId: 'operator-chat',
  workspaceRoot: '/tmp',
  requestApproval: async () => false,
};

const campaignCtx = {
  agentId: 'apex-campaign-runner',
  workspaceRoot: '/tmp',
  requestApproval: async () => false,
};

describe('Google Places env defaults', () => {
  it('defaults: daily 10, monthly 1000, warn at 500, max pages 1, sweeps off', () => {
    expect(googlePlacesDailyRequestCap({})).toBe(DEFAULT_GOOGLE_PLACES_DAILY_REQUEST_CAP);
    expect(googlePlacesDailyRequestCap({})).toBe(10);
    expect(googlePlacesMonthlyFreeCap({})).toBe(DEFAULT_GOOGLE_PLACES_MONTHLY_FREE_CAP);
    expect(googlePlacesMonthlyFreeCap({})).toBe(1000);
    expect(googlePlacesMonthlyWarnAt({})).toBe(DEFAULT_GOOGLE_PLACES_MONTHLY_WARN_AT);
    expect(googlePlacesMonthlyWarnAt({})).toBe(500);
    expect(googlePlacesMaxPages({})).toBe(DEFAULT_GOOGLE_PLACES_MAX_PAGES);
    expect(googlePlacesMaxPages({})).toBe(1);
    expect(googlePlacesSweepsEnabled({})).toBe(false);
    expect(googlePlacesAllowOverFreeCap({})).toBe(false);
  });

  it('parses overrides and rejects invalid values', () => {
    expect(googlePlacesDailyRequestCap({ GOOGLE_PLACES_DAILY_REQUEST_CAP: '7' })).toBe(7);
    expect(googlePlacesDailyRequestCap({ GOOGLE_PLACES_DAILY_REQUEST_CAP: '-1' })).toBe(10);
    expect(googlePlacesDailyRequestCap({ GOOGLE_PLACES_DAILY_REQUEST_CAP: 'nope' })).toBe(10);
    expect(googlePlacesMonthlyFreeCap({ GOOGLE_PLACES_MONTHLY_FREE_CAP: '50' })).toBe(50);
    expect(googlePlacesMonthlyWarnAt({ GOOGLE_PLACES_MONTHLY_WARN_AT: '200' })).toBe(200);
    expect(googlePlacesMaxPages({ GOOGLE_PLACES_MAX_PAGES: '3' })).toBe(3);
    expect(googlePlacesMaxPages({ GOOGLE_PLACES_MAX_PAGES: '0' })).toBe(0);
    expect(googlePlacesSweepsEnabled({ GOOGLE_PLACES_SWEEPS_ENABLED: 'true' })).toBe(true);
    expect(googlePlacesSweepsEnabled({ GOOGLE_PLACES_SWEEPS_ENABLED: '1' })).toBe(true);
    expect(googlePlacesSweepsEnabled({ GOOGLE_PLACES_SWEEPS_ENABLED: 'false' })).toBe(false);
    expect(googlePlacesAllowOverFreeCap({ GOOGLE_PLACES_ALLOW_OVER_FREE_CAP: 'true' })).toBe(true);
  });
});

describe('Atmosphere field-mask guard', () => {
  it('the current mask is Enterprise-only and contains no Atmosphere fields', () => {
    expect(atmosphereFieldsInMask(GOOGLE_PLACES_FIELD_MASK)).toEqual([]);
  });

  it('fails if any Atmosphere-tier field is added to the mask', () => {
    expect(GOOGLE_PLACES_ATMOSPHERE_FIELDS).toContain('reviews');
    expect(GOOGLE_PLACES_ATMOSPHERE_FIELDS).toContain('generativeSummary');
    expect(GOOGLE_PLACES_ATMOSPHERE_FIELDS).toContain('editorialSummary');
    expect(atmosphereFieldsInMask([...GOOGLE_PLACES_FIELD_MASK, 'places.reviews'])).toEqual(['reviews']);
    expect(atmosphereFieldsInMask(['places.generativeSummary', 'places.displayName'])).toEqual(['generativeSummary']);
  });
});

describe('UTC counting and caps', () => {
  let store: ReturnType<typeof memStore>;
  let warnings: GooglePlacesWarning[];

  beforeEach(() => {
    store = memStore();
    warnings = [];
    __setGooglePlacesBudgetStoreForTests(store);
    __setGooglePlacesWarningSinkForTests({ warn: (w) => { warnings.push(w); } });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetGooglePlacesBudgetForTests();
  });

  it('counts each reserved page against both the UTC day and month', async () => {
    const a = await reserveGooglePlacesRequest({ query: 'hvac dallas', now: NOW, env: env({ GOOGLE_PLACES_DAILY_REQUEST_CAP: '10' }) });
    const b = await reserveGooglePlacesRequest({ query: 'hvac austin', now: NOW, env: env({ GOOGLE_PLACES_DAILY_REQUEST_CAP: '10' }) });
    expect(a.allowed && b.allowed).toBe(true);
    expect(a.dayCount).toBe(1);
    expect(b.dayCount).toBe(2);
    expect(b.monthCount).toBe(2);
    expect(a.day).toBe('2026-11-10');
    expect(a.month).toBe('2026-11');
    expect(store.rows.get(`${googlePlacesDailyDayKey('2026-11-10')}|${GOOGLE_PLACES_DAILY_ACCOUNT}`)).toBe(2);
    expect(store.rows.get(`${googlePlacesMonthlyDayKey('2026-11')}|${GOOGLE_PLACES_MONTHLY_ACCOUNT}`)).toBe(2);
  });

  it('stops at the daily cap and rolls back the unsent reservation', async () => {
    const e = env({ GOOGLE_PLACES_DAILY_REQUEST_CAP: '2', GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000' });
    expect((await reserveGooglePlacesRequest({ now: NOW, env: e })).allowed).toBe(true);
    expect((await reserveGooglePlacesRequest({ now: NOW, env: e })).allowed).toBe(true);
    const third = await reserveGooglePlacesRequest({ now: NOW, env: e });
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('daily_cap');
    expect(third.note).toBe(GOOGLE_PLACES_DAILY_CAP_NOTE);
    expect(third.detail).toBe('daily cap reached');
    expect(await store.read(googlePlacesDailyDayKey('2026-11-10'), GOOGLE_PLACES_DAILY_ACCOUNT)).toBe(2);
    expect(await store.read(googlePlacesMonthlyDayKey('2026-11'), GOOGLE_PLACES_MONTHLY_ACCOUNT)).toBe(2);
  });

  it('warns once when monthly usage reaches the warning threshold', async () => {
    const e = env({
      GOOGLE_PLACES_DAILY_REQUEST_CAP: '100',
      GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000',
      GOOGLE_PLACES_MONTHLY_WARN_AT: '500',
    });
    store.rows.set(`${googlePlacesMonthlyDayKey('2026-11')}|${GOOGLE_PLACES_MONTHLY_ACCOUNT}`, 498);
    const at499 = await reserveGooglePlacesRequest({ now: NOW, env: e });
    expect(at499.allowed && at499.monthCount === 499).toBe(true);
    expect(warnings).toHaveLength(0);
    const at500 = await reserveGooglePlacesRequest({ now: NOW, env: e });
    expect(at500.monthCount).toBe(500);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.used).toBe(500);
    expect(warnings[0]!.warnAt).toBe(500);
    expect(warnings[0]!.message).toMatch(/500\/1000/);
    const at501 = await reserveGooglePlacesRequest({ now: NOW, env: e });
    expect(at501.monthCount).toBe(501);
    expect(warnings).toHaveLength(1);
  });

  it('stops at the monthly free cap unless the override is set', async () => {
    const e = env({
      GOOGLE_PLACES_DAILY_REQUEST_CAP: '100',
      GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000',
    });
    store.rows.set(`${googlePlacesMonthlyDayKey('2026-11')}|${GOOGLE_PLACES_MONTHLY_ACCOUNT}`, 999);
    const atCap = await reserveGooglePlacesRequest({ now: NOW, env: e });
    expect(atCap.allowed && atCap.monthCount === 1000).toBe(true);
    const over = await reserveGooglePlacesRequest({ now: NOW, env: e });
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe('monthly_free_cap');
    expect(over.note).toBe(GOOGLE_PLACES_MONTHLY_CAP_NOTE);
    expect(await store.read(googlePlacesMonthlyDayKey('2026-11'), GOOGLE_PLACES_MONTHLY_ACCOUNT)).toBe(1000);
    expect(await store.read(googlePlacesDailyDayKey('2026-11-10'), GOOGLE_PLACES_DAILY_ACCOUNT)).toBe(1);

    const overEnv = env({
      GOOGLE_PLACES_DAILY_REQUEST_CAP: '100',
      GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000',
      GOOGLE_PLACES_ALLOW_OVER_FREE_CAP: 'true',
    });
    // Reset in-memory exhausted flag after the stop, keep the store counts.
    __setGooglePlacesBudgetStoreForTests(store);
    const allowed = await reserveGooglePlacesRequest({ now: NOW, env: overEnv });
    expect(allowed.allowed).toBe(true);
    expect(allowed.monthCount).toBe(1001);
  });

  it('fails closed when the ledger cannot be reached', async () => {
    __setGooglePlacesBudgetStoreForTests({
      increment: async () => { throw new Error('db down'); },
      decrement: async () => undefined,
      read: async () => { throw new Error('db down'); },
    });
    const result = await reserveGooglePlacesRequest({ now: NOW, env: env() });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ledger_unavailable');
    expect(result.note).toBe(GOOGLE_PLACES_LEDGER_UNAVAILABLE_NOTE);
  });

  it('masks the query in the billed-request log (no key, truncated + hashed)', () => {
    const masked = maskGooglePlacesQuery('hvac contractor Dallas Texas after hours answering');
    expect(masked.truncated.length).toBeLessThanOrEqual(48);
    expect(masked.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(masked.truncated).not.toMatch(/AIza/);
  });
});

describe('not-configured treatment and campaign skip', () => {
  it('cap and sweep notes are unconfigured, not an outage, and do not close the campaign', () => {
    for (const note of [
      GOOGLE_PLACES_DAILY_CAP_NOTE,
      GOOGLE_PLACES_MONTHLY_CAP_NOTE,
      GOOGLE_PLACES_SWEEPS_DISABLED_NOTE,
      GOOGLE_PLACES_LEDGER_UNAVAILABLE_NOTE,
    ]) {
      const message = discoveryZeroMessage('hvac Dallas, TX', [
        'yelp: YELP_API_KEY not set',
        note,
        'tomtom: TOMTOM_API_KEY not set',
        'brave: BRAVE_SEARCH_API_KEY not set',
        'OSM: no known category tag for "hvac Dallas, TX"',
      ]);
      const classified = classifyLeadDiscoveryFailure(message);
      expect(classified.providerOutage, note).toBe(false);
      expect(classified.unavailable).toEqual([]);
      const decision = decideSegmentFailure({ message, attempts: 1, maxAttempts: 3 });
      expect(decision.kind, note).not.toBe('capacity_pause');
    }
  });

  it('recognizes campaign and lead-gen sweep calls, and leaves on-demand lookups alone', () => {
    expect(isGooglePlacesSweepRequest({ sweep: true })).toBe(true);
    expect(isGooglePlacesSweepRequest({ agentId: 'apex-campaign-runner' })).toBe(true);
    expect(isGooglePlacesSweepRequest({ taskTitle: 'Lead generation sweep' })).toBe(true);
    expect(isGooglePlacesSweepRequest({ taskDescription: 'AUTONOMOUS LEAD-GEN SWEEP — run a research session now.' })).toBe(true);
    expect(isGooglePlacesSweepRequest({ agentId: 'operator-chat', sweep: false })).toBe(false);
    expect(shouldSkipGooglePlacesForSweep({ sweep: true }, {})).toBe(true);
    expect(shouldSkipGooglePlacesForSweep({ sweep: true }, { GOOGLE_PLACES_SWEEPS_ENABLED: 'true' })).toBe(false);
  });
});

describe('searchBusinessDirectory integration', () => {
  let store: ReturnType<typeof memStore>;
  let placesCalls: number;

  beforeEach(() => {
    store = memStore();
    placesCalls = 0;
    __setGooglePlacesBudgetStoreForTests(store);
    __setGooglePlacesWarningSinkForTests({ warn: () => undefined });
    resetDirectoryProviderKeyState();
    process.env.GOOGLE_PLACES_API_KEY = VALID_GOOGLE;
    delete process.env.YELP_API_KEY;
    delete process.env.TOMTOM_API_KEY;
    process.env.LEAD_SEARCH_CACHE_ENABLED = 'false';
    process.env.GOOGLE_PLACES_DAILY_REQUEST_CAP = '10';
    process.env.GOOGLE_PLACES_MONTHLY_FREE_CAP = '1000';
    process.env.GOOGLE_PLACES_MAX_PAGES = '1';
    delete process.env.GOOGLE_PLACES_SWEEPS_ENABLED;
    delete process.env.GOOGLE_PLACES_ALLOW_OVER_FREE_CAP;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://places.googleapis.com/')) {
        placesCalls += 1;
        return new Response(JSON.stringify({
          places: [{ displayName: { text: `Biz ${placesCalls}` }, nationalPhoneNumber: '555-0100', websiteUri: 'https://example.com', formattedAddress: 'Dallas, TX' }],
          nextPageToken: placesCalls < 5 ? 'more' : undefined,
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetDirectoryProviderKeyState();
    __resetGooglePlacesBudgetForTests();
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_DAILY_REQUEST_CAP;
    delete process.env.GOOGLE_PLACES_MONTHLY_FREE_CAP;
    delete process.env.GOOGLE_PLACES_MAX_PAGES;
    delete process.env.GOOGLE_PLACES_SWEEPS_ENABLED;
    delete process.env.LEAD_SEARCH_CACHE_ENABLED;
  });

  it('on-demand lookups follow the caps and default to one page', async () => {
    const result = await getToolRegistry().execute('searchBusinessDirectory', { query: 'hvac Dallas TX' }, lookupCtx);
    expect(result.success).toBe(true);
    expect(placesCalls).toBe(1);
    const data = result.data as { provider?: string; businesses?: unknown[] };
    expect(data.provider).toBe('google');
    expect(data.businesses?.length).toBe(1);
  });

  it('GOOGLE_PLACES_MAX_PAGES limits billed pages', async () => {
    process.env.GOOGLE_PLACES_MAX_PAGES = '3';
    process.env.GOOGLE_PLACES_DAILY_REQUEST_CAP = '10';
    const result = await getToolRegistry().execute('searchBusinessDirectory', { query: 'hvac Dallas TX' }, lookupCtx);
    expect(result.success).toBe(true);
    expect(placesCalls).toBe(3);
    const data = result.data as { businesses?: unknown[] };
    expect(data.businesses?.length).toBe(3);
  });

  it('counts each page and stops further Google pages once the daily cap is hit, without erroring', async () => {
    process.env.GOOGLE_PLACES_MAX_PAGES = '3';
    process.env.GOOGLE_PLACES_DAILY_REQUEST_CAP = '2';
    const result = await getToolRegistry().execute('searchBusinessDirectory', { query: 'hvac Dallas TX' }, lookupCtx);
    expect(result.success).toBe(true);
    expect(placesCalls).toBe(2);
    const data = result.data as { provider?: string; businesses?: unknown[] };
    expect(data.provider).toBe('google');
    expect(data.businesses?.length).toBe(2);
  });

  it('when the cap is already hit, skips Google as not-configured and does not call Places', async () => {
    process.env.GOOGLE_PLACES_DAILY_REQUEST_CAP = '1';
    await reserveGooglePlacesRequest({ query: 'prior', now: Date.now(), env: process.env });
    placesCalls = 0;
    const result = await getToolRegistry().execute('searchBusinessDirectory', { query: 'hvac Dallas TX' }, lookupCtx);
    expect(result.success).toBe(true);
    expect(placesCalls).toBe(0);
    const data = result.data as { attempts?: string[]; provider?: string };
    expect(data.attempts).toContain(GOOGLE_PLACES_DAILY_CAP_NOTE);
    expect(data.provider).toBe('none');
    const message = discoveryZeroMessage('hvac Dallas TX', data.attempts ?? []);
    expect(classifyLeadDiscoveryFailure(message).providerOutage).toBe(false);
  });

  it('campaign/sweep calls skip Google while sweeps are off, without erroring the campaign', async () => {
    const result = await getToolRegistry().execute(
      'searchBusinessDirectory',
      { query: 'hvac Dallas TX', sweep: true },
      campaignCtx,
    );
    expect(result.success).toBe(true);
    expect(placesCalls).toBe(0);
    const data = result.data as { attempts?: string[] };
    expect(data.attempts).toContain(GOOGLE_PLACES_SWEEPS_DISABLED_NOTE);
    const message = discoveryZeroMessage('hvac Dallas TX', data.attempts ?? []);
    expect(classifyLeadDiscoveryFailure(message).providerOutage).toBe(false);
    expect(decideSegmentFailure({ message, attempts: 1, maxAttempts: 3 }).kind).not.toBe('capacity_pause');
  });

  it('campaign/sweep calls use Google when GOOGLE_PLACES_SWEEPS_ENABLED=true, still under the caps', async () => {
    process.env.GOOGLE_PLACES_SWEEPS_ENABLED = 'true';
    const result = await getToolRegistry().execute(
      'searchBusinessDirectory',
      { query: 'hvac Dallas TX', sweep: true },
      campaignCtx,
    );
    expect(result.success).toBe(true);
    expect(placesCalls).toBe(1);
    const data = result.data as { provider?: string };
    expect(data.provider).toBe('google');
  });

  it('a lead-gen sweep task is skipped even without the sweep flag', async () => {
    __setGooglePlacesTaskLookupForTests(async () => ({
      title: 'Lead generation sweep',
      description: 'AUTONOMOUS LEAD-GEN SWEEP — run a research session now.',
    }));
    expect(await shouldSkipGooglePlacesCall({
      agentId: 'apex-lead-research-001',
      taskId: 'task-sweep-1',
      env: {},
    })).toBe(true);
    const result = await getToolRegistry().execute(
      'searchBusinessDirectory',
      { query: 'hvac Dallas TX' },
      { ...lookupCtx, agentId: 'apex-lead-research-001', taskId: 'task-sweep-1' },
    );
    expect(placesCalls).toBe(0);
    const data = result.data as { attempts?: string[] };
    expect(data.attempts).toContain(GOOGLE_PLACES_SWEEPS_DISABLED_NOTE);
    __setGooglePlacesTaskLookupForTests(null);
  });
});

describe('UTC helpers', () => {
  it('stores counts under prefixed day keys, not bare UTC dates', () => {
    expect(utcDay(NOW)).toBe('2026-11-10');
    expect(utcMonth(NOW)).toBe('2026-11');
    expect(googlePlacesDailyDayKey('2026-11-10')).toBe('utc:2026-11-10');
    expect(googlePlacesMonthlyDayKey('2026-11')).toBe('mo:2026-11');
  });
});

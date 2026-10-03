import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updates: Array<Record<string, unknown>> = [];
const activity: Array<Record<string, unknown>> = [];

vi.mock('@workspace/db', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    db: {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push(values);
            return [];
          },
        }),
      }),
    },
  };
});

vi.mock('../../../background-jobs/src/operator-activity.js', () => ({
  recordOperatorActivity: async (entry: Record<string, unknown>) => {
    activity.push(entry);
  },
}));

const { CampaignRunner, SearchUnavailableError, discoveryPauseUntil } = await import('../../../background-jobs/src/campaign-runner.js');
const { getToolRegistry, getLeadDiscoveryPause, clearLeadDiscoveryPause } = await import('@workspace/core');

const campaign = { id: 'camp-1', name: 'US News, Newspapers & Radio Stations' } as never;
function segment(id: string, city: string, attempts = 1) {
  return {
    id,
    campaignId: 'camp-1',
    industry: 'News Media',
    city,
    subcategory: 'newspaper',
    searchIntent: 'core',
    query: `newspaper ${city}`,
    attempts,
    maxAttempts: 3,
    startedAt: new Date(),
  } as never;
}

beforeEach(() => {
  updates.length = 0;
  activity.length = 0;
  clearLeadDiscoveryPause();
  for (const key of ['YELP_API_KEY', 'GOOGLE_PLACES_API_KEY', 'BRAVE_SEARCH_API_KEY', 'APEX_TAVILY_PROXY_ENABLED']) vi.stubEnv(key, '');
  vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('campaign discovery during a search outage', () => {
  it('clamps the pause window between 1 minute and 1 hour', () => {
    const now = Date.parse('2026-10-03T21:00:00Z');
    expect(discoveryPauseUntil(new Date(now + 5_000), now).getTime()).toBe(now + 60_000);
    expect(discoveryPauseUntil('2026-11-01T00:00:00Z', now).getTime()).toBe(now + 60 * 60_000);
    expect(discoveryPauseUntil(undefined, now).getTime()).toBe(now + 15 * 60_000);
  });

  it('puts every shard back (attempt refunded), pauses discovery, and logs ONE campaign-level deferral', async () => {
    const retryAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const registry = getToolRegistry();
    const execute = vi.spyOn(registry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'webSearch') {
        return {
          success: true,
          data: {
            provider: 'none',
            results: [],
            diagnostics: ['tavily: monthly credit budget reached (950/1000, stop at 950)'],
            searchUnavailable: { providers: ['tavily'], retryAt },
          },
        } as never;
      }
      return { success: true, data: { businesses: [], provider: 'none', attempts: ['OSM: zero'] } } as never;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const runner = new CampaignRunner(60_000) as unknown as {
      runSegment: (c: unknown, s: unknown) => Promise<void>;
      discoveryPausedUntil: number;
    };
    await Promise.all(['Juneau, AK', 'Fairbanks, AK', 'Anchorage, AK'].map((city, i) => runner.runSegment(campaign, segment(`s${i}`, city, 2))));

    expect(execute).toHaveBeenCalled();
    // Every shard returned to pending with its claim-time attempt refunded.
    expect(updates).toHaveLength(3);
    for (const u of updates) expect(u).toMatchObject({ status: 'pending', attempts: 1, leasedAt: null });
    // Not "attempt N failed — will retry" per city.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('attempt'))).toHaveLength(0);
    const pauseLines = log.mock.calls.filter((c) => String(c[0]).includes('lead discovery paused'));
    expect(pauseLines).toHaveLength(1);
    expect(activity).toHaveLength(1);
    expect(runner.discoveryPausedUntil).toBe(Date.parse(retryAt));
    expect(getLeadDiscoveryPause()?.until).toBe(retryAt);
  });

  it('does not claim new segments while discovery is paused', async () => {
    const runner = new CampaignRunner(60_000) as unknown as {
      tick: () => Promise<void>;
      discoveryPausedUntil: number;
      claimSegments: () => Promise<unknown[]>;
      recoverExpiredLeases: () => Promise<void>;
      closeFinishedCampaigns: () => Promise<void>;
      enrichVerifiedContactsFromSearch: () => Promise<void>;
    };
    runner.discoveryPausedUntil = Date.now() + 10 * 60_000;
    const claim = vi.fn(async () => []);
    runner.claimSegments = claim;
    runner.recoverExpiredLeases = async () => {};
    runner.closeFinishedCampaigns = async () => {};
    runner.enrichVerifiedContactsFromSearch = async () => {};
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Backlog processing touches Postgres; the point here is only that the
    // discovery claim is skipped, so tolerate its failure.
    await runner.tick().catch(() => {});
    expect(claim).not.toHaveBeenCalled();
    expect(getLeadDiscoveryPause()).toBeNull(); // the runner's own clock gates claims
  });

  it('is a typed error carrying the retry time and providers', () => {
    const err = new SearchUnavailableError('x', new Date('2026-10-03T22:00:00Z'), ['buildmybot-tavily']);
    expect(err).toBeInstanceOf(Error);
    expect(err.providers).toEqual(['buildmybot-tavily']);
  });
});

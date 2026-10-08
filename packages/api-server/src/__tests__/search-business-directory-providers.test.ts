import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToolRegistry } from '../../../core/src/tool-registry.js';
import { resetDirectoryProviderKeyState } from '../../../core/src/lead-provider-keys.js';
import type { ToolContext } from '../../../core/src/types.js';

/**
 * Observability contract for searchBusinessDirectory provider failures.
 *
 * A configured-but-failing provider must surface as an *errored* attempt
 * (e.g. "yelp: HTTP 429"), never as a genuine empty result ("yelp: no
 * results"). The tool must still fall through to the next provider, return
 * provider:'none' with total:0 when every provider fails, and never throw.
 */
describe('searchBusinessDirectory provider-failure observability', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetDirectoryProviderKeyState();
    // Configure all four providers so none is skipped as "not set".
    vi.stubEnv('YELP_API_KEY', 'a'.repeat(128));
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'AIza' + 'b'.repeat(35));
    vi.stubEnv('TOMTOM_API_KEY', 'tomtom-test-key');
    vi.stubEnv('LEAD_PROVIDER_KEY_FORMAT_CHECK', 'off');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  function context(): ToolContext {
    return {
      agentId: 'test-agent',
      workspaceRoot: '/tmp',
      requestApproval: async () => false,
    };
  }

  async function search(query: string) {
    const tool = getToolRegistry().get('searchBusinessDirectory');
    if (!tool) throw new Error('Missing tool searchBusinessDirectory');
    return tool.execute({ query, refresh: true }, context()) as Promise<{
      total: number;
      provider: string;
      attempts?: string[];
      businesses?: unknown[];
    }>;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('records a Yelp non-OK status in attempts[]', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.yelp.com')) {
        return new Response('{"error":{"code":"RATE_LIMITED"}}', { status: 429 });
      }
      if (url.includes('places.googleapis.com')) {
        return jsonResponse({ places: [] });
      }
      if (url.includes('api.tomtom.com')) {
        return jsonResponse({ results: [] });
      }
      if (url.includes('overpass')) {
        return jsonResponse({ elements: [] });
      }
      if (url.includes('nominatim')) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    }));

    const result = await search('bail bonds Houston Texas');
    expect(result.attempts).toBeDefined();
    expect(result.attempts!.some((a) => /yelp: HTTP 429/.test(a))).toBe(true);
  });

  it('records a Google throw message in attempts[]', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.yelp.com')) {
        return jsonResponse({ businesses: [] });
      }
      if (url.includes('places.googleapis.com')) {
        throw new Error('google places quota exceeded');
      }
      if (url.includes('api.tomtom.com')) {
        return jsonResponse({ results: [] });
      }
      if (url.includes('overpass')) {
        return jsonResponse({ elements: [] });
      }
      if (url.includes('nominatim')) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    }));

    const result = await search('HVAC contractor Dallas Texas');
    expect(result.attempts).toBeDefined();
    expect(result.attempts!.some((a) => /google: .*quota exceeded/i.test(a))).toBe(true);
  });

  it('returns provider:none with total:0 and >=4 attempts when all providers fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.yelp.com')) {
        return new Response('rate limited', { status: 429 });
      }
      if (url.includes('places.googleapis.com')) {
        throw new Error('google down');
      }
      if (url.includes('api.tomtom.com')) {
        return new Response('tomtom error', { status: 500 });
      }
      if (url.includes('overpass')) {
        return new Response('overpass down', { status: 503 });
      }
      if (url.includes('nominatim')) {
        return new Response('geocode fail', { status: 500 });
      }
      return jsonResponse({});
    }));

    const result = await search('personal injury lawyer Miami FL');
    expect(result.total).toBe(0);
    expect(result.provider).toBe('none');
    expect(result.attempts!.length).toBeGreaterThanOrEqual(4);
  });
});

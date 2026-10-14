import assert from 'node:assert/strict';
import { searchExaWeb, ExaSearchError } from '../packages/core/src/exa-search.js';

async function main() {
  let request: Record<string, unknown> = {};
  let requestedUrl = '';
  const fakeFetch: typeof fetch = async (url, init) => {
    requestedUrl = String(url);
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'redacted-test-key');
    return Response.json({
      requestId: 'test-123',
      costDollars: { total: 0.01 },
      results: [
        { title: 'Source one', url: 'https://example.com/one',
          highlights: ['Grounded passage one', 'Grounded passage two'],
          publishedDate: '2026-10-11T12:00:00Z' },
        { title: 'Invalid result', url: 'not-a-url', highlights: ['discard me'] },
      ],
    });
  };
  const defaultSearch = await searchExaWeb('APEX information', 'redacted-test-key', { fetcher: fakeFetch });
  assert.equal(requestedUrl, 'https://api.exa.ai/search');
  assert.deepEqual(request, {
    query: 'APEX information', type: 'auto', contents: { highlights: true },
  });
  assert.equal(defaultSearch.results.length, 1);
  assert.equal(defaultSearch.results[0].snippet, 'Grounded passage one … Grounded passage two');
  assert.equal(defaultSearch.results[0].publishedDate, '2026-10-11T12:00:00Z');
  assert.equal(defaultSearch.requestId, 'test-123');

  await searchExaWeb('Texas roofing businesses', 'redacted-test-key', {
    maxResults: 25, fast: true, fetcher: fakeFetch,
  });
  assert.deepEqual(request, {
    query: 'Texas roofing businesses', type: 'fast',
    contents: { highlights: true }, numResults: 25,
  });

  await assert.rejects(
    () => searchExaWeb('failing search', 'redacted-test-key', {
      fetcher: async () => new Response('', { status: 429 }),
    }),
    (error: unknown) => error instanceof ExaSearchError && error.status === 429,
  );
  console.log('PASS: Exa request shapes, highlight extraction, metadata and HTTP errors');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

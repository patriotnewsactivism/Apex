/** Exa's canonical POST /search API, documented by the build-with-exa skill.
 * Raw HTTP avoids extra SDK overhead in the APEX core process.
 */
export interface ExaWebResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface ExaWebResponse {
  results: ExaWebResult[];
  requestId?: string;
  costDollars?: unknown;
}

export class ExaSearchError extends Error {
  constructor(public readonly status: number) {
    super(`Exa search returned HTTP ${status}`);
    this.name = 'ExaSearchError';
  }
}

export async function searchExaWeb(
  query: string,
  apiKey: string,
  options: { maxResults?: number; fast?: boolean; fetcher?: typeof fetch } = {},
): Promise<ExaWebResponse> {
  if (!query.trim()) throw new Error('Exa search query cannot be empty');
  if (!apiKey.trim()) throw new Error('Exa API key is not configured');
  const n = options.maxResults;
  const count = n === undefined ? undefined : Math.max(1, Math.min(100, Math.trunc(n)));
  const request = {
    query,
    type: options.fast ? 'fast' : 'auto',
    contents: { highlights: true },
    ...(count !== undefined && count !== 10 ? { numResults: count } : {}),
  };
  const response = await (options.fetcher ?? fetch)('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(15_000),
  });
  // Do not log provider bodies or credentials.
  if (!response.ok) throw new ExaSearchError(response.status);
  const payload = await response.json() as {
    results?: Array<{ title?: unknown; url?: unknown; highlights?: unknown; publishedDate?: unknown }>;
    requestId?: unknown;
    costDollars?: unknown;
  };
  const results: ExaWebResult[] = [];
  for (const item of Array.isArray(payload.results) ? payload.results : []) {
    if (typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue;
    const highlights = Array.isArray(item.highlights)
      ? item.highlights.filter((value): value is string => typeof value === 'string')
      : typeof item.highlights === 'string' ? [item.highlights] : [];
    const result: ExaWebResult = {
      title: typeof item.title === 'string' ? item.title : item.url,
      url: item.url,
      // Keep the downstream LLM context and token spend bounded.
      snippet: highlights.join(' … ').slice(0, 1600),
    };
    if (typeof item.publishedDate === 'string') result.publishedDate = item.publishedDate;
    results.push(result);
  }
  return {
    results,
    ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {}),
    ...(payload.costDollars !== undefined ? { costDollars: payload.costDollars } : {}),
  };
}

/**
 * Brave LLM Context contact enrichment.
 *
 * The ordinary contact-enrichment path is two calls: webSearch returns links,
 * then each site is fetched. Brave's /res/v1/llm/context returns the extracted
 * page content (text chunks, structured data, code) for up to `count` results
 * in one call, so a domain-scoped query yields the specific page text an
 * enrichment pass can read a decision-maker name, email, or phone from.
 *
 * Same key as the rest of Brave. No new credential.
 *
 * Env:
 *   BRAVE_SEARCH_API_KEY   (required; the same key as /res/v1/web/search)
 *   BRAVE_LLM_CONTEXT_ENABLED  default "true" — set "false" to disable
 */
import * as crypto from 'node:crypto';

export interface LlmContextSource {
  url: string;
  title: string | null;
  snippets: string[];
}

export interface LlmContextResult {
  ok: boolean;
  sources: LlmContextSource[];
  /** Raw "sources" metadata (age, hostname) keyed by URL. */
  meta: Record<string, { hostname?: string | null; age?: unknown }>;
  diagnostics?: string[];
}

const ENDPOINT = 'https://api.search.brave.com/res/v1/llm/context';

function sortUnique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function extractEmails(text: string): string[] {
  return sortUnique(
    text
      .match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)
      ?.filter((e) => !/\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|example\.com|sentry\.io|schema\.org/i.test(e))
      ?? [],
  ).slice(0, 10);
}

function extractPhones(text: string): string[] {
  return sortUnique(
    text
      .match(/\+?1?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{4}/g)
      ?.filter((p) => p.replace(/\D/g, '').length >= 10)
      ?? [],
  ).slice(0, 10);
}

/**
 * Ask Brave's LLM Context API for the extracted content of a company's site.
 * `query` is a domain-scoped search, e.g. `site:acme.com "Acme Roofing"`.
 * Returns the highest-ranked URL's snippets plus a metadata summary.
 */
export async function braveLlmContext(
  options: { query: string; count?: number },
): Promise<LlmContextResult> {
  const enabled = String(process.env.BRAVE_LLM_CONTEXT_ENABLED ?? 'true').toLowerCase();
  if (enabled === 'false' || enabled === '0' || enabled === 'no') {
    return { ok: false, sources: [], meta: {}, diagnostics: ['brave-llm-context disabled by env'] };
  }
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) {
    return { ok: false, sources: [], meta: {}, diagnostics: ['brave-llm-context: BRAVE_SEARCH_API_KEY not set'] };
  }
  const count = Math.max(1, Math.min(50, options.count ?? 20));
  try {
    const params = new URLSearchParams({
      q: options.query,
      count: String(count),
      maximum_number_of_urls: String(count),
      maximum_number_of_tokens: '4096',
      maximum_number_of_snippets: '20',
      maximum_number_of_tokens_per_url: '2048',
      context_threshold_mode: 'balanced',
    });
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        sources: [],
        meta: {},
        diagnostics: [`brave-llm-context: HTTP ${res.status} ${body.slice(0, 200)}`.trim()],
      };
    }
    const data = (await res.json()) as {
      grounding?: { generic?: Array<{ url?: string; title?: string; snippets?: unknown }> };
      sources?: Record<string, { hostname?: string | null; age?: unknown }>;
    };
    const sources: LlmContextSource[] = (data.grounding?.generic ?? [])
      .filter((g): g is { url: string; title?: string; snippets?: unknown } => typeof g?.url === 'string' && g.url.length > 0)
      .map((g) => ({
        url: g.url,
        title: g.title ?? null,
        snippets: Array.isArray(g.snippets)
          ? g.snippets.map((s) => String(s ?? '')).filter(Boolean).slice(0, 5)
          : [],
      }));
    return { ok: sources.length > 0, sources, meta: data.sources ?? {} };
  } catch (error) {
    return {
      ok: false,
      sources: [],
      meta: {},
      diagnostics: [`brave-llm-context: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/** Feed the extracted content through to concrete contact fields (best effort). */
export function parseContactFields(sources: LlmContextSource[]): {
  emails: string[];
  phones: string[];
  /** First plausible organization/decision-maker line across all snippets. */
  lines: string[];
} {
  const allText = sources.map((s) => s.snippets.join('\n')).join('\n');
  return {
    emails: extractEmails(allText),
    phones: extractPhones(allText),
    lines: allText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 50),
  };
}

/** Deterministic nonce so identical requests still walk a fresh circuit breaker. */
export function llmContextCacheKey(query: string): string {
  return crypto.createHash('sha256').update(`llm-context:${query}`).digest('hex');
}

/**
 * Decision-maker search ladder.
 *
 * For one lead and one role (owner/executive, marketing, editorial, sales) run
 * cheap, high-provenance steps first and stop at the first role-appropriate
 * person. Everything fetched or found is written to a per-domain research
 * cache so a later lookup for ANOTHER role answers from stored people first and
 * only runs the steps that have not run yet.
 *
 * Exhaustion rule (the only way a lead becomes `cant_locate`):
 *   - every applicable step finished with status `no_result`; and
 *   - no step ended in `error_transient` (timeouts, 429, 5xx, fetch budget).
 *     A transient error means `pending_retry`, never `cant_locate`.
 *   - Steps that cannot run because a provider is not configured are recorded
 *     as `skipped_missing_config`. They do not block exhaustion, but the
 *     outcome records them (`skippedForConfig`) so a later config change can
 *     reopen the search (`fullLadder: false`).
 *   - Steps that do not apply (masthead pages for a roofer) are
 *     `not_applicable`.
 *
 * Zero LLM calls. Network access is injected (`LadderDeps`) so tests and the
 * dry-run backfill can control it.
 */
import { headings, pageTitle, sameOriginLinks, visibleText } from './lead-quality/html.js';
import { industryProfileId } from './lead-quality/industry.js';
import {
  dedupePeople,
  extractPeopleFromPage,
  peopleFromSearchResult,
  selectForRole,
  bestBelowBarCandidate,
  type BelowBarCandidate,
  type VerifyContext,
  type DecisionMakerRole,
  type ExtractionMethod,
  type PersonRecord,
} from './lead-quality/people.js';

export { DECISION_MAKER_ROLES, ROLE_TITLE_PRIORITY, selectForRole, type DecisionMakerRole, type PersonRecord } from './lead-quality/people.js';

export const LADDER_VERSION = 'dm-ladder-2026-10-03-v1';

// ─── Types ─────────────────────────────────────────────────────────────────

export type LadderStep =
  | 'structured_scrape'
  | 'homepage_structured'
  | 'team_pages'
  | 'masthead_pages'
  | 'site_search'
  | 'web_people'
  | 'web_search'
  | 'hunter_domain_search';

export const LADDER_STEPS: LadderStep[] = [
  'structured_scrape',
  'homepage_structured',
  'team_pages',
  'masthead_pages',
  'site_search',
  'web_people',
  'web_search',
  'hunter_domain_search',
];

const ROLE_SPECIFIC_STEPS = new Set<LadderStep>(['site_search', 'web_search']);

export type StepStatus = 'found' | 'no_result' | 'skipped_missing_config' | 'not_applicable' | 'error_transient';

export interface StepAttempt {
  step: LadderStep;
  status: StepStatus;
  ranAt: string;
  scope: 'role_agnostic' | 'role_specific';
  fromCache: boolean;
  detail?: string;
  providers?: Array<{ provider: string; status: StepStatus | 'cached'; detail?: string }>;
}

export type DecisionMakerOutcome =
  | {
      status: 'found'; name: string; title: string; sourceUrl: string; method: ExtractionMethod; confidence: number; fromCache: boolean;
      /** Authority tier of the title (1 owner/CEO … 3 director). */
      tier?: number;
      /** How the name cleared the bar: first-party roster/JSON-LD, corroborated third party, or company-direct. */
      verifiedBy?: 'first_party' | 'corroborated' | 'company_direct';
      corroboratedBy?: string[];
      /** Who found it: the ladder at insert/backfill, or the name-finder queue. */
      source?: 'ladder' | 'name_finder_research' | 'email_reply' | 'phone_call' | 'operator_entry';
    }
  | { status: 'cant_locate'; reason: string; fullLadder: boolean; skippedForConfig: LadderStep[]; candidate?: BelowBarCandidate | null }
  | { status: 'pending_retry'; reason: string };

export interface DecisionMakerRoleSearch {
  role: DecisionMakerRole;
  ladderVersion: string;
  stepsTried: StepAttempt[];
  outcome: DecisionMakerOutcome;
  reason: string;
  exhaustedAt: string | null;
  searchedAt: string;
}

export interface DecisionMakerSearch {
  ladderVersion: string;
  /** Summary across roles: found if any role found; cant_locate only when every role is cant_locate. */
  outcome: DecisionMakerOutcome;
  reason: string;
  exhaustedAt: string | null;
  stepsTried: StepAttempt[];
  primaryRole: DecisionMakerRole;
  roles: Partial<Record<DecisionMakerRole, DecisionMakerRoleSearch>>;
}

// Per-domain research cache (persisted to lead_research_cache, see domain-research-store.ts).

export interface PageRecord {
  url: string;
  fetchedAt: string;
  expiresAt: string;
  status: 'ok' | 'http_error' | 'transient_error';
  httpStatus: number | null;
  bytes: number;
  title: string | null;
  textExcerpt: string;
  links: string[];
  peopleFound: number;
  transientFailures: number;
}

export interface SearchRecord {
  provider: string;
  query: string;
  ranAt: string;
  expiresAt: string;
  status: 'ok' | 'transient_error';
  results: Array<{ title: string; url: string; snippet: string }>;
}

export interface LadderStepRecord {
  step: LadderStep;
  ranAt: string;
  status: StepStatus;
  ladderVersion: string;
  scope: 'role_agnostic' | 'role_specific';
  role?: DecisionMakerRole;
  queries?: string[];
}

export interface LayerCounter { hits: number; misses: number }

export interface DomainResearch {
  version: 1;
  domain: string;
  pages: Record<string, PageRecord>;
  people: PersonRecord[];
  searches: Record<string, SearchRecord>;
  ladderSteps: Record<string, LadderStepRecord>;
  layerStats: { pages: LayerCounter; people: LayerCounter; search: LayerCounter };
  updatedAt: string;
}

export const CACHE_LIMITS = {
  maxPages: 30,
  maxPeople: 200,
  maxSearches: 60,
  maxTextExcerpt: 4000,
  maxLinksPerPage: 40,
  maxHtmlBytes: 400_000,
  pageTtlMs: 14 * 24 * 60 * 60 * 1000,
  httpErrorTtlMs: 7 * 24 * 60 * 60 * 1000,
  transientTtlMs: 60 * 60 * 1000,
  searchTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxTransientFailuresPerPage: 3,
} as const;

export function emptyDomainResearch(domain: string, now = new Date()): DomainResearch {
  return {
    version: 1,
    domain,
    pages: {},
    people: [],
    searches: {},
    ladderSteps: {},
    layerStats: { pages: { hits: 0, misses: 0 }, people: { hits: 0, misses: 0 }, search: { hits: 0, misses: 0 } },
    updatedAt: now.toISOString(),
  };
}

export interface DomainResearchStore {
  load(cacheKey: string, domain: string): Promise<DomainResearch>;
  save(cacheKey: string, research: DomainResearch): Promise<void>;
}

export class InMemoryDomainResearchStore implements DomainResearchStore {
  readonly rows = new Map<string, DomainResearch>();
  async load(cacheKey: string, domain: string): Promise<DomainResearch> {
    const row = this.rows.get(cacheKey);
    return row ? structuredClone(row) : emptyDomainResearch(domain);
  }
  async save(cacheKey: string, research: DomainResearch): Promise<void> {
    this.rows.set(cacheKey, structuredClone(research));
  }
}

// ─── Network deps ──────────────────────────────────────────────────────────

export type FetchResult =
  | { kind: 'ok'; url: string; status: number; html: string }
  | { kind: 'http_error'; url: string; status: number }
  | { kind: 'transient_error'; url: string; status: number | null; message: string };

export interface SearchProvider {
  id: string;
  configured(): boolean;
  search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

export class TransientProviderError extends Error {}

export interface HunterPerson { name: string; title: string; email: string | null; confidence: number; sourceUrl: string }

export interface LadderDeps {
  fetchPage(url: string): Promise<FetchResult>;
  searchProviders: SearchProvider[];
  hunter?: { configured(): boolean; domainSearch(domain: string): Promise<HunterPerson[]> };
  now?: () => Date;
  /** Max network page fetches in one ladder run (pipeline latency guard). */
  maxFetchesPerRun?: number;
}

const UA = 'APEX-LeadVerifier/1.0 (+https://apex.donmatthews.live)';

/** Default fetcher: timeout, size cap, optional per-domain spacing. */
export function createHttpFetcher(options: { timeoutMs?: number; perDomainDelayMs?: number } = {}): (url: string) => Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? Number(process.env.LEAD_CONTACT_PAGE_TIMEOUT_MS ?? 3500);
  const delay = options.perDomainDelayMs ?? Number(process.env.APEX_DM_LADDER_PER_DOMAIN_DELAY_MS ?? 0);
  const nextSlot = new Map<string, number>();
  return async (url: string) => {
    let host = '';
    try { host = new URL(url).hostname; } catch { return { kind: 'http_error', url, status: 0 }; }
    if (delay > 0) {
      const now = Date.now();
      const slot = Math.max(now, nextSlot.get(host) ?? 0);
      nextSlot.set(host, slot + delay);
      if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    }
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        return { kind: 'transient_error', url, status: response.status, message: `http_${response.status}` };
      }
      if (!response.ok) return { kind: 'http_error', url, status: response.status };
      const type = response.headers.get('content-type') ?? '';
      if (type && !/html|xml|text\/plain/i.test(type)) return { kind: 'http_error', url, status: 415 };
      const html = (await response.text()).slice(0, CACHE_LIMITS.maxHtmlBytes);
      return { kind: 'ok', url: response.url || url, status: response.status, html };
    } catch (err) {
      const code = String(((err as { cause?: { code?: string } })?.cause?.code) ?? (err as NodeJS.ErrnoException)?.code ?? '');
      // NXDOMAIN and certificate failures do not fix themselves on retry.
      if (/^(?:ENOTFOUND|CERT_|ERR_TLS_CERT|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED|ERR_SSL)/.test(code)) {
        return { kind: 'http_error', url, status: 0 };
      }
      return { kind: 'transient_error', url, status: null, message: err instanceof Error ? err.message.slice(0, 120) : 'fetch_failed' };
    }
  };
}

// ─── Search provider adapters (skip cleanly when unconfigured) ─────────────

async function jsonOrTransient(response: Response): Promise<unknown> {
  // 401/402/403 from a search API means blocked or out of credits: retry later,
  // never evidence that the company has no decision maker.
  if (response.status === 429 || response.status >= 500 || [401, 402, 403].includes(response.status)) {
    throw new TransientProviderError(`http_${response.status}`);
  }
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

export function tavilyProvider(): SearchProvider {
  return {
    id: 'tavily',
    configured: () => Boolean(process.env.TAVILY_API_KEY),
    async search(query) {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
        body: JSON.stringify({ query, max_results: 8, search_depth: 'basic' }),
        signal: AbortSignal.timeout(8000),
      }).catch((err) => { throw new TransientProviderError(String(err)); });
      const body = (await jsonOrTransient(response)) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      return (body.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: (r.content ?? '').slice(0, 400) }));
    },
  };
}

export function braveProvider(): SearchProvider {
  return {
    id: 'brave',
    configured: () => Boolean(process.env.BRAVE_SEARCH_API_KEY),
    async search(query) {
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(query)}`, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': String(process.env.BRAVE_SEARCH_API_KEY) },
        signal: AbortSignal.timeout(8000),
      }).catch((err) => { throw new TransientProviderError(String(err)); });
      const body = (await jsonOrTransient(response)) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      return (body.web?.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: (r.description ?? '').slice(0, 400) }));
    },
  };
}

/** Free, keyless, but scraping-based: OFF unless APEX_DM_LADDER_DDG_ENABLED=true. */
export function duckDuckGoHtmlProvider(): SearchProvider {
  return {
    id: 'duckduckgo_html',
    configured: () => process.env.APEX_DM_LADDER_DDG_ENABLED === 'true',
    async search(query) {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: AbortSignal.timeout(8000),
      }).catch((err) => { throw new TransientProviderError(String(err)); });
      if (response.status === 429 || response.status === 202 || response.status === 403 || response.status >= 500) throw new TransientProviderError(`blocked_http_${response.status}`);
      if (!response.ok) throw new Error(`http_${response.status}`);
      const html = await response.text();
      // DDG answers bots with a 200 "anomaly"/captcha page (seen from the box on Oct 3).
      if (/anomaly|captcha|unusual traffic/i.test(html) && !/result__a/.test(html)) throw new TransientProviderError('blocked_anomaly_page');
      return parseDuckDuckGoHtml(html);
    },
  };
}

export function parseDuckDuckGoHtml(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<div[^>]+class=["'][^"']*\bresult\b/).slice(1);
  for (const block of blocks.slice(0, 10)) {
    const a = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url = a[1]!;
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]!); } catch { /* keep */ } }
    const snippet = block.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/i)?.[1] ?? '';
    out.push({ title: visibleText(a[2]!, 300), url, snippet: visibleText(snippet, 400) });
  }
  return out;
}

export function hunterClient(): NonNullable<LadderDeps['hunter']> {
  return {
    configured: () => Boolean(process.env.HUNTER_API_KEY),
    async domainSearch(domain) {
      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&type=personal&limit=10`;
      const response = await fetch(url, {
        headers: { 'X-API-KEY': String(process.env.HUNTER_API_KEY) },
        signal: AbortSignal.timeout(8000),
      }).catch((err) => { throw new TransientProviderError(String(err)); });
      const body = (await jsonOrTransient(response)) as { data?: { emails?: Array<{ value?: string; first_name?: string; last_name?: string; position?: string; confidence?: number; sources?: Array<{ uri?: string }> }> } };
      return (body.data?.emails ?? [])
        .filter((e) => e.first_name && e.last_name && e.position)
        .map((e) => ({
          name: `${e.first_name} ${e.last_name}`,
          title: e.position!,
          email: e.value ?? null,
          confidence: Math.max(0, Math.min(1, (e.confidence ?? 50) / 100)),
          sourceUrl: e.sources?.[0]?.uri ?? `https://hunter.io/domain-search/${domain}`,
        }));
    },
  };
}

export function defaultSearchProviders(): SearchProvider[] {
  return [tavilyProvider(), braveProvider(), duckDuckGoHtmlProvider()];
}

export function defaultLadderDeps(overrides: Partial<LadderDeps> = {}): LadderDeps {
  return {
    fetchPage: createHttpFetcher(),
    searchProviders: defaultSearchProviders(),
    hunter: hunterClient(),
    maxFetchesPerRun: Number(process.env.APEX_DM_LADDER_MAX_FETCHES ?? 10),
    ...overrides,
  };
}

// ─── Roles ─────────────────────────────────────────────────────────────────

const ROLE_QUERY_TERMS: Record<DecisionMakerRole, { site: string[]; web: string }> = {
  owner_executive: { site: ['owner', 'president'], web: 'owner OR president OR CEO OR founder' },
  marketing: { site: ['marketing director'], web: '"marketing director" OR "director of marketing" OR CMO' },
  editorial: { site: ['editor'], web: '"editor in chief" OR "managing editor" OR "news director" OR "executive editor"' },
  sales: { site: ['advertising', 'sales manager'], web: '"advertising director" OR "sales director" OR "sales manager"' },
};

export function defaultRolesForIndustry(industry: string | null | undefined): DecisionMakerRole[] {
  const configured = (process.env.APEX_DM_LADDER_ROLES ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is DecisionMakerRole => ['owner_executive', 'marketing', 'editorial', 'sales'].includes(r));
  if (configured.length > 0) return configured;
  return industryProfileId(industry) === 'news_media' ? ['editorial', 'owner_executive'] : ['owner_executive'];
}

// ─── Runner ────────────────────────────────────────────────────────────────

export interface LadderLead {
  companyName: string;
  website: string | null | undefined;
  industry?: string | null;
  city?: string | null;
  cacheKey: string;
  domain: string;
  /** Step 0: decision maker already found by verifyBusinessWebsiteIdentity's structured scrape. */
  structuredScrape?: { name: string | null; title: string | null; sourceUrl: string | null } | null;
}

const TEAM_LINK = /\b(?:about|team|staff|leadership|management|people|who-we-are|who we are|our-story|our story|company|executives?|board|founders?|meet)\b/i;
const TEAM_PATHS = ['/about', '/about-us', '/team', '/our-team', '/staff', '/leadership', '/management', '/people', '/who-we-are', '/company'];
const MASTHEAD_LINK = /\b(?:masthead|staff|newsroom|editorial|contact|about-us|about us|meet-the-team|our-team|news team|directory)\b/i;
const MASTHEAD_PATHS = ['/masthead', '/staff', '/about/staff', '/about/masthead', '/contact', '/contact-us', '/newsroom', '/staff-directory', '/about-us/staff', '/meet-the-team', '/news-team'];

class RunContext {
  fetches = 0;
  budgetHit = false;
  /** Set when the homepage is permanently unreachable (NXDOMAIN, TLS, 4xx). */
  siteDead = false;
  constructor(
    readonly research: DomainResearch,
    readonly deps: LadderDeps,
    readonly now: Date,
    readonly org: { companyName: string; domain: string },
  ) {}

  /** Verification bar context: this company, its registrable domain, now. */
  get verifyContext(): VerifyContext {
    return { companyName: this.org.companyName, domain: this.org.domain, now: this.now };
  }

  get budget(): number { return this.deps.maxFetchesPerRun ?? 10; }

  /** Fetch through the page cache. Returns null when the run budget is spent. */
  async page(url: string, kind: 'homepage' | 'team' | 'masthead' | 'site_search'): Promise<PageRecord | null> {
    const key = normalizePageKey(url);
    const cached = this.research.pages[key];
    if (cached && Date.parse(cached.expiresAt) > this.now.getTime()) {
      this.research.layerStats.pages.hits++;
      return cached;
    }
    if (cached?.status === 'transient_error' && cached.transientFailures >= CACHE_LIMITS.maxTransientFailuresPerPage) {
      // Gave up on this page after repeated transient failures: treat as permanent.
      return { ...cached, status: 'http_error' };
    }
    if (this.fetches >= this.budget) { this.budgetHit = true; return null; }
    this.fetches++;
    this.research.layerStats.pages.misses++;
    const result = await this.deps.fetchPage(url);
    const nowIso = this.now.toISOString();
    let record: PageRecord;
    if (result.kind === 'ok') {
      const people = extractPeopleFromPage(result.html, result.url, kind, nowIso, this.org);
      this.addPeople(people);
      const base = result.url;
      const links = [
        ...sameOriginLinks(result.html, base, TEAM_LINK, 20),
        ...sameOriginLinks(result.html, base, MASTHEAD_LINK, 20),
      ];
      record = {
        url: result.url,
        fetchedAt: nowIso,
        expiresAt: new Date(this.now.getTime() + CACHE_LIMITS.pageTtlMs).toISOString(),
        status: 'ok',
        httpStatus: result.status,
        bytes: result.html.length,
        title: pageTitle(result.html) || headings(result.html, 1)[0] || null,
        textExcerpt: visibleText(result.html, CACHE_LIMITS.maxTextExcerpt),
        links: [...new Set(links)].slice(0, CACHE_LIMITS.maxLinksPerPage),
        peopleFound: people.length,
        transientFailures: 0,
      };
    } else if (result.kind === 'http_error') {
      record = {
        url, fetchedAt: nowIso, expiresAt: new Date(this.now.getTime() + CACHE_LIMITS.httpErrorTtlMs).toISOString(),
        status: 'http_error', httpStatus: result.status, bytes: 0, title: null, textExcerpt: '', links: [], peopleFound: 0, transientFailures: 0,
      };
    } else {
      record = {
        url, fetchedAt: nowIso, expiresAt: new Date(this.now.getTime() + CACHE_LIMITS.transientTtlMs).toISOString(),
        status: 'transient_error', httpStatus: result.status, bytes: 0, title: null, textExcerpt: '', links: [], peopleFound: 0,
        transientFailures: (cached?.transientFailures ?? 0) + 1,
      };
    }
    this.research.pages[key] = record;
    if (normalizePageKey(record.url) !== key && record.status === 'ok') this.research.pages[normalizePageKey(record.url)] = record;
    return record;
  }

  addPeople(people: PersonRecord[]): void {
    if (people.length === 0) return;
    this.research.people = dedupePeople([...this.research.people, ...people]).slice(-CACHE_LIMITS.maxPeople);
  }
}

export function normalizePageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.hostname.replace(/^www\./, '')}${path}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function homepageOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const u = new URL(website.includes('://') ? website : `https://${website}`);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

function stepKey(step: LadderStep, role: DecisionMakerRole): string {
  return ROLE_SPECIFIC_STEPS.has(step) ? `${step}|${role}` : step;
}

function completedRecord(research: DomainResearch, step: LadderStep, role: DecisionMakerRole): LadderStepRecord | null {
  const rec = research.ladderSteps[stepKey(step, role)];
  if (!rec || rec.ladderVersion !== LADDER_VERSION) return null;
  if (rec.status === 'error_transient') return null;
  // Config-skipped steps are re-evaluated every run: the key may now exist.
  if (rec.status === 'skipped_missing_config') return null;
  return rec;
}

type StepRun = { status: StepStatus; detail?: string; providers?: StepAttempt['providers']; queries?: string[] };

async function runPageStep(ctx: RunContext, urls: string[], kind: 'team' | 'masthead' | 'site_search'): Promise<StepRun> {
  if (urls.length === 0) return { status: 'no_result', detail: 'no_candidate_pages' };
  let transient = 0;
  let ok = 0;
  const pages = await Promise.all(urls.map((u) => ctx.page(u, kind)));
  for (const p of pages) {
    if (!p) { transient++; continue; }
    if (p.status === 'transient_error') transient++;
    else if (p.status === 'ok') ok++;
  }
  if (transient > 0) return { status: 'error_transient', detail: ctx.budgetHit ? 'fetch_budget_exhausted' : `transient_fetch_errors:${transient}` };
  return { status: 'no_result', detail: `pages_ok:${ok}/${urls.length}` };
}

function teamCandidateUrls(ctx: RunContext, homepage: string, pattern: RegExp, paths: string[], limit: number): string[] {
  const home = ctx.research.pages[normalizePageKey(homepage)];
  const fromNav = (home?.links ?? []).filter((l) => pattern.test(l));
  const fromPaths = paths.map((p) => { try { return new URL(p, homepage).toString(); } catch { return null; } }).filter((u): u is string => Boolean(u));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...fromNav, ...fromPaths]) {
    const k = normalizePageKey(u);
    if (k === normalizePageKey(homepage) || seen.has(k)) continue;
    seen.add(k);
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

function isSiteDead(ctx: RunContext, homepage: string): boolean {
  const home = ctx.research.pages[normalizePageKey(homepage)];
  return Boolean(home && home.status === 'http_error');
}

async function runSearchQuery(ctx: RunContext, lead: LadderLead, role: DecisionMakerRole, query: string, stopOnRoleMatch: boolean): Promise<StepRun> {
  const providers: NonNullable<StepAttempt['providers']> = [];
  let anyRan = false;
  let transient = false;
  for (const provider of ctx.deps.searchProviders) {
    if (!provider.configured()) { providers.push({ provider: provider.id, status: 'skipped_missing_config' }); continue; }
    anyRan = true;
    const key = `${provider.id}|${query.toLowerCase()}`;
    const cached = ctx.research.searches[key];
    let results: SearchRecord['results'];
    if (cached && cached.status === 'ok' && Date.parse(cached.expiresAt) > ctx.now.getTime()) {
      ctx.research.layerStats.search.hits++;
      results = cached.results;
      providers.push({ provider: provider.id, status: 'cached' });
    } else {
      ctx.research.layerStats.search.misses++;
      try {
        results = (await provider.search(query)).slice(0, 10);
        ctx.research.searches[key] = {
          provider: provider.id, query, ranAt: ctx.now.toISOString(),
          expiresAt: new Date(ctx.now.getTime() + CACHE_LIMITS.searchTtlMs).toISOString(), status: 'ok', results,
        };
        providers.push({ provider: provider.id, status: 'no_result' });
      } catch (err) {
        const isTransient = err instanceof TransientProviderError;
        providers.push({ provider: provider.id, status: isTransient ? 'error_transient' : 'no_result', detail: err instanceof Error ? err.message.slice(0, 80) : 'error' });
        if (isTransient) transient = true;
        continue;
      }
    }
    const found = results.flatMap((r) => peopleFromSearchResult(r, lead.companyName, ctx.now.toISOString(), lead.domain));
    ctx.addPeople(found);
    if (stopOnRoleMatch && selectForRole(ctx.research.people, role, ctx.verifyContext)) return { status: 'found', providers, queries: [query] };
  }
  if (!anyRan) return { status: 'skipped_missing_config', detail: 'no_search_provider_configured', providers, queries: [query] };
  if (transient) return { status: 'error_transient', providers, queries: [query] };
  return { status: 'no_result', providers, queries: [query] };
}

async function runStep(step: LadderStep, lead: LadderLead, role: DecisionMakerRole, ctx: RunContext): Promise<StepRun> {
  const homepage = homepageOf(lead.website);
  const isNews = industryProfileId(lead.industry) === 'news_media';
  switch (step) {
    case 'structured_scrape': {
      const s = lead.structuredScrape;
      if (!s) return { status: 'not_applicable', detail: 'no_identity_scrape_supplied' };
      if (s.name && s.title) {
        ctx.addPeople([{ name: s.name, title: s.title, sourceUrl: s.sourceUrl ?? homepage ?? '', method: 'structured_scrape', methodConfidence: 0.9, seenAt: ctx.now.toISOString() }]);
      }
      return { status: 'no_result' };
    }
    case 'homepage_structured': {
      if (!homepage) return { status: 'not_applicable', detail: 'no_website' };
      const page = await ctx.page(homepage, 'homepage');
      if (!page) return { status: 'error_transient', detail: 'fetch_budget_exhausted' };
      if (page.status === 'transient_error') return { status: 'error_transient', detail: `homepage_${page.httpStatus ?? 'network'}` };
      if (page.status !== 'ok') {
        ctx.siteDead = true;
        return { status: 'no_result', detail: `site_unreachable_permanent:http_${page.httpStatus}` };
      }
      return { status: 'no_result' };
    }
    case 'team_pages': {
      if (!homepage) return { status: 'not_applicable', detail: 'no_website' };
      if (ctx.siteDead || isSiteDead(ctx, homepage)) return { status: 'not_applicable', detail: 'site_unreachable_permanent' };
      return runPageStep(ctx, teamCandidateUrls(ctx, homepage, TEAM_LINK, TEAM_PATHS, 6), 'team');
    }
    case 'masthead_pages': {
      if (!homepage) return { status: 'not_applicable', detail: 'no_website' };
      if (ctx.siteDead || isSiteDead(ctx, homepage)) return { status: 'not_applicable', detail: 'site_unreachable_permanent' };
      if (!isNews && role !== 'editorial') return { status: 'not_applicable', detail: 'not_news_media' };
      return runPageStep(ctx, teamCandidateUrls(ctx, homepage, MASTHEAD_LINK, MASTHEAD_PATHS, 6), 'masthead');
    }
    case 'site_search': {
      if (!homepage) return { status: 'not_applicable', detail: 'no_website' };
      if (ctx.siteDead || isSiteDead(ctx, homepage)) return { status: 'not_applicable', detail: 'site_unreachable_permanent' };
      const queries = ROLE_QUERY_TERMS[role].site;
      const urls = queries.flatMap((q) => [
        new URL(`/?s=${encodeURIComponent(q)}`, homepage).toString(),
        new URL(`/search?q=${encodeURIComponent(q)}`, homepage).toString(),
      ]);
      const run = await runPageStep(ctx, urls, 'site_search');
      return { ...run, queries };
    }
    case 'web_people': {
      // One shared, role-agnostic query per company; every role reuses its results.
      const query = `site:${lead.domain} (team OR staff OR leadership OR owner OR president OR publisher OR editor OR director OR manager)`;
      return runSearchQuery(ctx, lead, role, query, false);
    }
    case 'web_search': {
      const query = `"${lead.companyName}" ${ROLE_QUERY_TERMS[role].web}${lead.city ? ` ${lead.city.split(',')[0]}` : ''}`;
      return runSearchQuery(ctx, lead, role, query, true);
    }
    case 'hunter_domain_search': {
      if (!ctx.deps.hunter?.configured()) return { status: 'skipped_missing_config', detail: 'HUNTER_API_KEY_unset' };
      try {
        const people = await ctx.deps.hunter.domainSearch(lead.domain);
        ctx.addPeople(people.map((p) => ({
          name: p.name, title: p.title, sourceUrl: p.sourceUrl, method: 'hunter_domain_search' as const,
          methodConfidence: Math.round(0.7 * p.confidence * 100) / 100 || 0.35, email: p.email, seenAt: ctx.now.toISOString(),
        })));
        return { status: 'no_result' };
      } catch (err) {
        return err instanceof TransientProviderError
          ? { status: 'error_transient', detail: err.message.slice(0, 80) }
          : { status: 'no_result', detail: err instanceof Error ? err.message.slice(0, 80) : 'hunter_error' };
      }
    }
  }
}

/**
 * Run (or resume) the ladder for one role. Mutates and returns `research`;
 * the caller persists it. Pure with respect to I/O other than `deps`.
 */
export async function runDecisionMakerLadderForRole(
  lead: LadderLead,
  role: DecisionMakerRole,
  research: DomainResearch,
  deps: LadderDeps,
): Promise<DecisionMakerRoleSearch> {
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const ctx = new RunContext(research, deps, now, { companyName: lead.companyName, domain: lead.domain });
  const stepsTried: StepAttempt[] = [];

  const finish = (outcome: DecisionMakerOutcome): DecisionMakerRoleSearch => {
    research.updatedAt = nowIso;
    const reason = outcome.status === 'found' ? `found_via_${outcome.method}` : outcome.reason;
    return {
      role,
      ladderVersion: LADDER_VERSION,
      stepsTried,
      outcome,
      reason,
      exhaustedAt: outcome.status === 'cant_locate' ? nowIso : null,
      searchedAt: nowIso,
    };
  };
  const foundOutcome = (fromCache: boolean): DecisionMakerOutcome | null => {
    const sel = selectForRole(research.people, role, ctx.verifyContext);
    if (!sel) return null;
    const v = sel.verification;
    return {
      status: 'found', name: sel.person.name, title: sel.person.title, sourceUrl: sel.person.sourceUrl, method: sel.person.method,
      confidence: sel.confidence, fromCache, tier: sel.tier,
      verifiedBy: v.onDomain ? 'first_party' : v.corroboratedBy.length ? 'corroborated' : 'company_direct',
      corroboratedBy: v.corroboratedBy.length ? v.corroboratedBy : undefined,
      source: 'ladder',
    };
  };

  // Seed from step 0 before consulting stored people so a fresh identity scrape is not lost.
  if (lead.structuredScrape?.name && lead.structuredScrape.title) {
    ctx.addPeople([{ name: lead.structuredScrape.name, title: lead.structuredScrape.title, sourceUrl: lead.structuredScrape.sourceUrl ?? homepageOf(lead.website) ?? '', method: 'structured_scrape', methodConfidence: 0.9, seenAt: nowIso }]);
  }

  // 1. Answer from stored people first.
  const fromStore = foundOutcome(true);
  if (fromStore) {
    research.layerStats.people.hits++;
    stepsTried.push({ step: 'structured_scrape', status: 'found', ranAt: nowIso, scope: 'role_agnostic', fromCache: true, detail: 'answered_from_cached_people' });
    return finish(fromStore);
  }
  research.layerStats.people.misses++;

  // 2. Run only steps that have not completed for this ladder version.
  for (const step of LADDER_STEPS) {
    const scope = ROLE_SPECIFIC_STEPS.has(step) ? 'role_specific' : 'role_agnostic';
    const done = completedRecord(research, step, role);
    if (done) {
      stepsTried.push({ step, status: done.status === 'found' ? 'no_result' : done.status, ranAt: done.ranAt, scope, fromCache: true, detail: 'step_already_completed_for_domain' });
      continue;
    }
    const run = await runStep(step, lead, role, ctx);
    let status = run.status;
    if (status !== 'error_transient' && status !== 'skipped_missing_config' && status !== 'not_applicable' && selectForRole(research.people, role, ctx.verifyContext)) status = 'found';
    stepsTried.push({ step, status, ranAt: nowIso, scope, fromCache: false, detail: run.detail, providers: run.providers });
    // not_applicable is role/industry dependent, so it is not persisted as "done" for the domain.
    if (status !== 'not_applicable') {
      research.ladderSteps[stepKey(step, role)] = {
        step, ranAt: nowIso, status, ladderVersion: LADDER_VERSION, scope,
        ...(scope === 'role_specific' ? { role, queries: run.queries } : {}),
      };
    }
    if (status === 'found') {
      const outcome = foundOutcome(false);
      if (outcome) return finish(outcome);
    }
  }

  const exhausted = exhaustionOutcome(stepsTried);
  // Below-bar people are kept on the needs-name record, never promoted.
  if (exhausted.status === 'cant_locate') exhausted.candidate = bestBelowBarCandidate(research.people, ctx.verifyContext);
  return finish(exhausted);
}

/** The exhaustion rule, isolated so it can be tested directly. */
export function exhaustionOutcome(stepsTried: StepAttempt[]): DecisionMakerOutcome {
  const transient = stepsTried.filter((s) => s.status === 'error_transient');
  if (transient.length > 0) {
    return { status: 'pending_retry', reason: `transient_errors:${transient.map((s) => `${s.step}${s.detail ? `(${s.detail})` : ''}`).join(',')}` };
  }
  const skipped = stepsTried.filter((s) => s.status === 'skipped_missing_config').map((s) => s.step);
  const ran = stepsTried.filter((s) => s.status === 'no_result').map((s) => s.step);
  const notApplicable = stepsTried.filter((s) => s.status === 'not_applicable').map((s) => s.step);
  const missing = LADDER_STEPS.filter((step) => !stepsTried.some((s) => s.step === step));
  if (missing.length > 0) return { status: 'pending_retry', reason: `steps_not_run:${missing.join(',')}` };
  if (ran.length === 0) return { status: 'pending_retry', reason: 'no_applicable_step_ran' };
  return {
    status: 'cant_locate',
    reason: `no_role_match_after_ladder; ran=${ran.join(',')}${skipped.length ? `; skipped_missing_config=${skipped.join(',')}` : ''}${notApplicable.length ? `; not_applicable=${notApplicable.join(',')}` : ''}`,
    fullLadder: skipped.length === 0,
    skippedForConfig: skipped,
  };
}

/** Combine per-role searches into the persisted decisionMakerSearch summary. */
export function summarizeDecisionMakerSearch(roles: DecisionMakerRoleSearch[], primaryRole: DecisionMakerRole): DecisionMakerSearch {
  const found = roles.find((r) => r.outcome.status === 'found');
  const pending = roles.find((r) => r.outcome.status === 'pending_retry');
  const chosen = found ?? pending ?? roles[0]!;
  const allCantLocate = roles.length > 0 && roles.every((r) => r.outcome.status === 'cant_locate');
  return {
    ladderVersion: LADDER_VERSION,
    outcome: chosen.outcome,
    reason: chosen.reason,
    exhaustedAt: allCantLocate ? chosen.exhaustedAt : null,
    stepsTried: chosen.stepsTried,
    primaryRole,
    roles: Object.fromEntries(roles.map((r) => [r.role, r])),
  };
}

/** Run the ladder for several roles against one cached domain record and persist it. */
export async function runDecisionMakerLadder(
  lead: LadderLead,
  roles: DecisionMakerRole[],
  store: DomainResearchStore,
  deps: LadderDeps,
): Promise<{ search: DecisionMakerSearch; research: DomainResearch }> {
  const research = await store.load(lead.cacheKey, lead.domain);
  const results: DecisionMakerRoleSearch[] = [];
  for (const role of roles) {
    results.push(await runDecisionMakerLadderForRole(lead, role, research, deps));
  }
  pruneResearch(research, deps.now?.() ?? new Date());
  await store.save(lead.cacheKey, research);
  return { search: summarizeDecisionMakerSearch(results, roles[0] ?? 'owner_executive'), research };
}

/** Enforce TTL and size limits before persisting. */
export function pruneResearch(research: DomainResearch, now: Date): void {
  const pages = Object.entries(research.pages)
    .filter(([, p]) => Date.parse(p.expiresAt) > now.getTime() || p.status === 'transient_error')
    .sort(([, a], [, b]) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))
    .slice(0, CACHE_LIMITS.maxPages);
  research.pages = Object.fromEntries(pages);
  const searches = Object.entries(research.searches)
    .filter(([, s]) => Date.parse(s.expiresAt) > now.getTime())
    .sort(([, a], [, b]) => Date.parse(b.ranAt) - Date.parse(a.ranAt))
    .slice(0, CACHE_LIMITS.maxSearches);
  research.searches = Object.fromEntries(searches);
  research.people = research.people.slice(-CACHE_LIMITS.maxPeople);
}

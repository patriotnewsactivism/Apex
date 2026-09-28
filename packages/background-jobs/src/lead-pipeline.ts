import { randomUUID } from 'crypto';
import { and, asc, eq, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import {
  db,
  leadResearchCache,
  researchedLeads,
} from '@workspace/db';
import { emitApexEvent, normalizeIndustry } from '@workspace/core';

export const LEAD_PIPELINE_STATES = [
  'DISCOVERED',
  'BASIC_ENRICHMENT',
  'CONTACT_FOUND',
  'QUALIFIED',
  'DEEP_RESEARCH',
  'CAMPAIGN_READY',
] as const;

export type LeadPipelineState = typeof LEAD_PIPELINE_STATES[number];

const NEXT_STATE: Partial<Record<LeadPipelineState, LeadPipelineState>> = {
  DISCOVERED: 'BASIC_ENRICHMENT',
  BASIC_ENRICHMENT: 'CONTACT_FOUND',
  CONTACT_FOUND: 'QUALIFIED',
  QUALIFIED: 'DEEP_RESEARCH',
  DEEP_RESEARCH: 'CAMPAIGN_READY',
};

const STATE_TIMESTAMP: Partial<Record<LeadPipelineState, keyof typeof researchedLeads.$inferInsert>> = {
  DISCOVERED: 'discoveredAt',
  BASIC_ENRICHMENT: 'basicEnrichedAt',
  CONTACT_FOUND: 'contactFoundAt',
  QUALIFIED: 'qualifiedAt',
  DEEP_RESEARCH: 'deepResearchedAt',
  CAMPAIGN_READY: 'campaignReadyAt',
};

const SERVICE_SUBCATEGORIES: Record<string, string[]> = {
  'bail bond': ['bail bonds', 'bail bondsman', '24 hour bail bonds', 'surety bail bonds'],
  locksmith: ['locksmith', 'emergency locksmith', '24 hour locksmith', 'mobile locksmith'],
  roofing: ['roof repair', 'roof replacement', 'storm damage roofing', 'commercial roofing'],
  hvac: ['ac repair', 'hvac contractor', 'furnace repair', 'emergency hvac'],
  plumbing: ['emergency plumber', 'water heater repair', 'drain cleaning', 'plumbing contractor'],
  dental: ['family dentist', 'cosmetic dentist', 'emergency dentist', 'dental implants'],
  medspa: ['medical spa', 'botox clinic', 'laser hair removal', 'aesthetic clinic'],
  legal: ['personal injury lawyer', 'family law attorney', 'criminal defense attorney', 'estate planning attorney'],
  default: ['company', 'service provider', 'contractor', 'local business'],
};

const SEARCH_INTENTS = ['directory', 'near me', 'top rated', 'best', 'open now'] as const;
const LIVE_DEMO_SEARCH_INTENTS = ['directory', 'near me', 'top rated'] as const;

export interface SearchShard {
  industry: string;
  city: string;
  subcategory: string;
  searchIntent: string;
  query: string;
}

export interface LeadPipelineConfig {
  liveDemoMode: boolean;
  discoveryConcurrency: number;
  stageConcurrency: number;
  shardsPerCell: number;
  segmentBatchSize: number;
  maxDirectoryResultsPerShard: number;
  leaseMs: number;
  initialQualificationMaxWords: number;
}

export function getLeadPipelineConfig(): LeadPipelineConfig {
  const liveDemoMode = process.env.LIVE_DEMO_MODE === 'true' || process.env.LIVE_DEMO_MODE === '1';
  return {
    liveDemoMode,
    discoveryConcurrency: Number(process.env.LEAD_DISCOVERY_CONCURRENCY ?? (liveDemoMode ? 8 : 3)),
    stageConcurrency: Number(process.env.LEAD_STAGE_CONCURRENCY ?? (liveDemoMode ? 12 : 5)),
    shardsPerCell: Number(process.env.LEAD_SHARDS_PER_CELL ?? (liveDemoMode ? 8 : 12)),
    segmentBatchSize: Number(process.env.LEAD_SEGMENT_BATCH_SIZE ?? (liveDemoMode ? 10 : 6)),
    maxDirectoryResultsPerShard: Number(process.env.LEAD_DIRECTORY_RESULTS_PER_SHARD ?? (liveDemoMode ? 12 : 25)),
    leaseMs: Number(process.env.LEAD_PIPELINE_LEASE_MS ?? 2 * 60 * 1000),
    initialQualificationMaxWords: Number(process.env.LEAD_INITIAL_QUALIFICATION_WORDS ?? (liveDemoMode ? 28 : 55)),
  };
}

export function subcategoriesForIndustry(industry: string): string[] {
  const normalized = normalizeIndustry(industry)?.toLowerCase() ?? industry.toLowerCase();
  for (const [key, values] of Object.entries(SERVICE_SUBCATEGORIES)) {
    if (key !== 'default' && normalized.includes(key)) return values;
  }

  // Unknown industries must still search for that industry. Generic fallback
  // queries such as "company Dallas" produced unrelated SEO pages.
  const clean = normalized
    .replace(/\b(?:business|businesses|company|companies)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return SERVICE_SUBCATEGORIES.default;
  return [clean, `${clean} company`, `${clean} service`, `local ${clean}`];
}

export function generateSearchShards(
  industries: string[],
  cities: string[],
  options: { liveDemoMode?: boolean; shardsPerCell?: number } = {},
): SearchShard[] {
  const liveDemoMode = options.liveDemoMode ?? getLeadPipelineConfig().liveDemoMode;
  const intents = liveDemoMode ? LIVE_DEMO_SEARCH_INTENTS : SEARCH_INTENTS;
  const maxPerCell = options.shardsPerCell ?? getLeadPipelineConfig().shardsPerCell;
  const shards: SearchShard[] = [];

  for (const rawIndustry of industries) {
    const industry = normalizeIndustry(rawIndustry) ?? rawIndustry.trim();
    if (!industry) continue;
    for (const city of cities.map((c) => c.trim()).filter(Boolean)) {
      const cell: SearchShard[] = [];
      for (const subcategory of subcategoriesForIndustry(industry)) {
        for (const searchIntent of intents) {
          const query = searchIntent === 'directory'
            ? `${subcategory} ${city}`
            : `${searchIntent} ${subcategory} ${city}`;
          cell.push({ industry, city, subcategory, searchIntent, query });
        }
      }
      shards.push(...cell.slice(0, maxPerCell));
    }
  }

  return shards;
}

export function normalizeLeadDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function canonicalHomepageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return null;
  }
}

export function companyNameFromDomain(url: string | null | undefined): string | null {
  const domain = normalizeLeadDomain(url);
  if (!domain) return null;
  const label = domain.split('.')[0] ?? '';
  if (!label) return null;
  return label
    .replace(/[-_]+/g, ' ')
    .replace(/\b(co|llc|inc|corp)\b/gi, (m) => m.toUpperCase())
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

export function isSeoLikeCompanyName(name: string, city?: string | null): boolean {
  const value = name.trim().toLowerCase();
  if (!value) return true;
  const cityName = (city ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  const generic = /(?:^|\b)(?:#?1|top|best|near me|official|trusted|premier|quality|affordable|professional|local|emergency|residential|commercial|services?|roof repair|roof replacement|roofing company|roofing contractor|installation|financing|reviews?|free estimate)(?:\b|$)/i;
  if (generic.test(value)) return true;
  if (cityName.length >= 4 && value.includes(cityName)) return true;
  return value.length > 70 || value.split(/\s+/).length > 9;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, '–')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function companyNameFromSearchResultTitle(title: string, website: string, city?: string | null): string {
  const candidates: string[] = [];
  for (const match of title.matchAll(/\(([^()]{3,80})\)/g)) {
    candidates.push(decodeHtmlText(match[1] ?? ''));
  }
  candidates.push(...title.split(/\s+(?:\||–|—|-)\s+/).map(decodeHtmlText).filter(Boolean));
  const usable = candidates.filter((name) => !isSeoLikeCompanyName(name, city));
  return usable[usable.length - 1] ?? companyNameFromDomain(website) ?? title.trim();
}

function jsonLdBusinessName(html: string): string | null {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  const businessType = /organization|localbusiness|corporation|professionalservice|homeandconstructionbusiness|roofingcontractor|legalservice|dentist|locksmith|plumber/i;
  const walk = (value: unknown): string | null => {
    if (Array.isArray(value)) {
      for (const item of value) { const found = walk(item); if (found) return found; }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const rawType = row['@type'];
    const types = Array.isArray(rawType) ? rawType.join(' ') : String(rawType ?? '');
    if (businessType.test(types) && typeof row.name === 'string' && row.name.trim()) return row.name.trim();
    if (row['@graph']) return walk(row['@graph']);
    return null;
  };
  for (const script of scripts) {
    const body = script.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try { const found = walk(JSON.parse(body)); if (found) return decodeHtmlText(found); } catch {}
  }
  return null;
}

function metaContent(html: string, key: string): string | null {
  const safeKey = key.replace(/[^a-z0-9:_-]/gi, '');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${safeKey}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${safeKey}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) { const match = html.match(pattern); if (match?.[1]) return decodeHtmlText(match[1]); }
  return null;
}

function industryAffinity(industry: string | null | undefined, text: string): boolean {
  const normalized = (normalizeIndustry(industry ?? '') ?? industry ?? '').toLowerCase();
  if (!normalized) return true;
  const haystack = text.toLowerCase();
  const checks: Array<[RegExp, RegExp]> = [
    [/roof/, /\broof(?:ing|er|ers| repair| replacement)?\b/],
    [/bail/, /\bbail\b|bondsman/],
    [/locksmith/, /\blocksmith\b|lock repair|lockout/],
    [/hvac/, /\bhvac\b|air condition|heating|furnace/],
    [/plumb/, /\bplumb(?:er|ing)?\b|water heater|drain/],
    [/dental|dentist/, /\bdent(?:al|ist|istry)\b|orthodont/],
    [/medspa|medical spa/, /med(?:ical)? spa|botox|aesthetic|laser hair/],
    [/legal|law|attorney/, /\blaw\b|lawyer|attorney|legal/],
  ];
  for (const [industryPattern, contentPattern] of checks) if (industryPattern.test(normalized)) return contentPattern.test(haystack);
  const meaningful = normalized.split(/\s+/).filter((token) => token.length >= 4 && !['business','company','service','services','emergency'].includes(token));
  return meaningful.length === 0 || meaningful.some((token) => haystack.includes(token));
}

function normalizeBusinessEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase().replace(/^mailto:/i, '').split('?')[0] ?? '';
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return null;
  if (/(?:example\.com|example\.org|domain\.com|yourdomain|sentry|wixpress|cloudflare)/i.test(email)) return null;
  if (/^(?:noreply|no-reply|donotreply|do-not-reply)@/i.test(email)) return null;
  return email;
}

function normalizeUsBusinessPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim().replace(/^tel:/i, '').split(/[;,?]/)[0] ?? '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15 && raw.startsWith('+')) return `+${digits}`;
  return null;
}

function publicContactsFromHtml(html: string): { email: string | null; phone: string | null } {
  const emails = [
    ...Array.from(html.matchAll(/href=["']mailto:([^"'?#\s>]+)/gi), (m) => m[1] ?? ''),
    ...Array.from(decodeHtmlText(html).matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi), (m) => m[0] ?? ''),
  ];
  const phones = [
    ...Array.from(html.matchAll(/href=["']tel:([^"'?#>]+)/gi), (m) => m[1] ?? ''),
    ...Array.from(decodeHtmlText(html).matchAll(/(?:\+?1[\s.()-]*)?(?:\d{3}[\s.()-]*){2}\d{4}/g), (m) => m[0] ?? ''),
  ];
  return {
    email: emails.map(normalizeBusinessEmail).find((value): value is string => Boolean(value)) ?? null,
    phone: phones.map(normalizeUsBusinessPhone).find((value): value is string => Boolean(value)) ?? null,
  };
}

function structuredDecisionMakerFromHtml(html: string): { name: string; title: string } | null {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  const seniority = /\b(owner|founder|co-founder|president|ceo|chief executive|managing partner|managing member|principal|partner)\b/i;

  const walk = (value: unknown): { name: string; title: string } | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const rawType = row['@type'];
    const types = Array.isArray(rawType) ? rawType.join(' ') : String(rawType ?? '');
    const name = typeof row.name === 'string' ? decodeHtmlText(row.name) : '';
    const title = typeof row.jobTitle === 'string' ? decodeHtmlText(row.jobTitle) : '';
    if (/\bPerson\b/i.test(types) && name && title && seniority.test(title)) {
      return { name, title };
    }
    for (const child of Object.values(row)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };

  for (const script of scripts) {
    const body = script.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      const found = walk(JSON.parse(body));
      if (found) return found;
    } catch {
      // Ignore malformed third-party JSON-LD.
    }
  }
  return null;
}

function sameOriginContactLinks(html: string, homepage: string): string[] {
  const base = new URL(homepage);
  const candidates: string[] = [];
  for (const match of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    const href = match[1]?.trim();
    if (!href || !/(?:contact|about|team|staff|leadership)/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.origin !== base.origin || !/^https?:$/.test(url.protocol)) continue;
      url.hash = '';
      candidates.push(url.toString());
    } catch {}
  }

  // Some sites hide useful contact/team pages behind JS navigation. Probe a
  // few conventional first-party paths before paying an external enrichment
  // provider. These direct website requests are cheap and high-provenance.
  for (const suffix of ['/contact', '/contact-us', '/about', '/about-us', '/team', '/staff']) {
    try {
      const url = new URL(suffix, base);
      candidates.push(url.toString());
    } catch {}
  }
  return [...new Set(candidates)].slice(0, 4);
}

export async function inspectFirstPartyContactUrl(url: string): Promise<{
  url: string;
  email: string | null;
  phone: string | null;
  decisionMaker: { name: string; title: string } | null;
} | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'APEX-LeadVerifier/1.0 (+https://apex.donmatthews.live)' },
      signal: AbortSignal.timeout(Number(process.env.LEAD_CONTACT_PAGE_TIMEOUT_MS ?? 2500)),
    });
    if (!response.ok) return null;
    const html = (await response.text()).slice(0, 250000);
    const contacts = publicContactsFromHtml(html);
    return {
      url: response.url || url,
      ...contacts,
      decisionMaker: structuredDecisionMakerFromHtml(html),
    };
  } catch {
    return null;
  }
}

export interface BusinessWebsiteIdentity {
  status: 'verified' | 'mismatch' | 'unverified';
  canonicalName: string | null;
  homepage: string | null;
  checkedAt: string;
  reason: string;
  contactEmail: string | null;
  contactPhone: string | null;
  contactSourceUrl: string | null;
  contactCheckedAt: string;
  contactScanVersion: '2026-09-28-v2';
  decisionMakerName: string | null;
  decisionMakerTitle: string | null;
  decisionMakerSourceUrl: string | null;
}

export async function verifyBusinessWebsiteIdentity(input: {
  website?: string | null;
  industry?: string | null;
  city?: string | null;
  currentName?: string | null;
}): Promise<BusinessWebsiteIdentity> {
  const homepage = canonicalHomepageUrl(input.website);
  const checkedAt = new Date().toISOString();
  const emptyContacts = {
    contactEmail: null,
    contactPhone: null,
    contactSourceUrl: null,
    contactCheckedAt: checkedAt,
    contactScanVersion: '2026-09-28-v2' as const,
    decisionMakerName: null,
    decisionMakerTitle: null,
    decisionMakerSourceUrl: null,
  };
  if (!homepage) {
    return {
      status: 'unverified',
      canonicalName: input.currentName?.trim() || null,
      homepage: null,
      checkedAt,
      reason: 'missing_or_invalid_website',
      ...emptyContacts,
    };
  }

  try {
    const response = await fetch(homepage, {
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'APEX-LeadVerifier/1.0 (+https://apex.donmatthews.live)' },
      signal: AbortSignal.timeout(Number(process.env.LEAD_WEBSITE_VERIFY_TIMEOUT_MS ?? 3500)),
    });
    if (!response.ok) {
      return {
        status: 'unverified',
        canonicalName: companyNameFromDomain(homepage) ?? input.currentName?.trim() ?? null,
        homepage,
        checkedAt,
        reason: `http_${response.status}`,
        ...emptyContacts,
      };
    }

    const finalHomepage = canonicalHomepageUrl(response.url || homepage) ?? homepage;
    const raw = (await response.text()).slice(0, 350000);
    const title = decodeHtmlText(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const canonicalName =
      jsonLdBusinessName(raw) ||
      metaContent(raw, 'og:site_name') ||
      metaContent(raw, 'application-name') ||
      companyNameFromSearchResultTitle(title, finalHomepage, input.city) ||
      companyNameFromDomain(finalHomepage) ||
      input.currentName?.trim() ||
      null;

    const homepageContacts = publicContactsFromHtml(raw);
    const homepageDecisionMaker = structuredDecisionMakerFromHtml(raw);
    let contactEmail = homepageContacts.email;
    let contactPhone = homepageContacts.phone;
    let contactSourceUrl: string | null = (contactEmail || contactPhone) ? finalHomepage : null;
    let decisionMakerName = homepageDecisionMaker?.name ?? null;
    let decisionMakerTitle = homepageDecisionMaker?.title ?? null;
    let decisionMakerSourceUrl: string | null = homepageDecisionMaker ? finalHomepage : null;

    if (!contactEmail || !contactPhone || !decisionMakerName) {
      const contactLinks = sameOriginContactLinks(raw, finalHomepage);
      const pages = await Promise.all(contactLinks.map(inspectFirstPartyContactUrl));
      for (const page of pages) {
        if (!page) continue;
        if (!contactEmail && page.email) {
          contactEmail = page.email;
          contactSourceUrl = page.url;
        }
        if (!contactPhone && page.phone) {
          contactPhone = page.phone;
          contactSourceUrl ??= page.url;
        }
        if (!decisionMakerName && page.decisionMaker) {
          decisionMakerName = page.decisionMaker.name;
          decisionMakerTitle = page.decisionMaker.title;
          decisionMakerSourceUrl = page.url;
        }
        if (contactEmail && contactPhone && decisionMakerName) break;
      }
    }

    const visible = decodeHtmlText(raw.slice(0, 150000));
    if (!industryAffinity(input.industry, `${title} ${visible}`)) {
      return {
        status: 'mismatch',
        canonicalName,
        homepage: finalHomepage,
        checkedAt,
        reason: 'homepage_does_not_match_target_industry',
        contactEmail,
        contactPhone,
        contactSourceUrl,
        contactCheckedAt: checkedAt,
        contactScanVersion: '2026-09-28-v2',
        decisionMakerName,
        decisionMakerTitle,
        decisionMakerSourceUrl,
      };
    }

    return {
      status: 'verified',
      canonicalName,
      homepage: finalHomepage,
      checkedAt,
      reason: 'homepage_and_industry_verified',
      contactEmail,
      contactPhone,
      contactSourceUrl,
      contactCheckedAt: checkedAt,
      contactScanVersion: '2026-09-28-v2',
      decisionMakerName,
      decisionMakerTitle,
      decisionMakerSourceUrl,
    };
  } catch (err) {
    return {
      status: 'unverified',
      canonicalName: companyNameFromDomain(homepage) ?? input.currentName?.trim() ?? null,
      homepage,
      checkedAt,
      reason: err instanceof Error ? err.message.slice(0, 180) : 'website_fetch_failed',
      ...emptyContacts,
    };
  }
}
export function makeResearchCacheKey(input: {
  companyName: string;
  website?: string | null;
  city?: string | null;
}): string {
  const domain = normalizeLeadDomain(input.website);
  if (domain) return `domain:${domain}`;
  return `company:${input.companyName.trim().toLowerCase()}|${(input.city ?? '').trim().toLowerCase()}`;
}

export function dedupeDiscoveredBusinesses<T extends { companyName: string; website?: string | null; city?: string | null }>(
  businesses: T[],
  knownDomains: Set<string>,
): { fresh: T[]; duplicates: number } {
  const seen = new Set<string>();
  const fresh: T[] = [];
  let duplicates = 0;

  for (const business of businesses) {
    const domain = normalizeLeadDomain(business.website);
    const key = domain ?? makeResearchCacheKey(business);
    if (domain && knownDomains.has(domain)) {
      duplicates++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    fresh.push(business);
  }

  return { fresh, duplicates };
}

export async function getKnownLeadDomains(): Promise<Set<string>> {
  const rows = await db.select({ website: researchedLeads.website }).from(researchedLeads);
  const domains = new Set<string>();
  for (const row of rows) {
    const domain = normalizeLeadDomain(row.website);
    if (domain) domains.add(domain);
  }
  return domains;
}

export interface DiscoveredLeadInput {
  companyName: string;
  website?: string;
  industry?: string;
  city?: string;
  phone?: string;
  source?: string;
  campaignId?: string;
  campaignSegmentId?: string;
  researchedByAgentId: string;
  metadata?: Record<string, unknown>;
}

export async function insertDiscoveredLead(input: DiscoveredLeadInput) {
  const now = new Date();
  const cacheKey = makeResearchCacheKey(input);
  const domain = normalizeLeadDomain(input.website);
  const [cached] = await db
    .select()
    .from(leadResearchCache)
    .where(eq(leadResearchCache.cacheKey, cacheKey))
    .limit(1);

  if (cached) {
    await db
      .update(leadResearchCache)
      .set({ hitCount: sql`${leadResearchCache.hitCount} + 1`, updatedAt: now })
      .where(eq(leadResearchCache.cacheKey, cacheKey));
  }

  const cachedContact = cached?.contactResearch as {
    decisionMakerName?: string;
    contactEmail?: string;
    contactPhone?: string;
    contactSourceUrl?: string;
    contactResearchStatus?: 'pending' | 'partial' | 'complete' | 'unavailable';
  } | null;

  const cachedCampaignDraft = cached?.campaignDraft as Record<string, unknown> | null;
  const cachedBasic = cached?.basicEnrichment as Record<string, unknown> | null;
  const cachedVerification = cachedBasic?.['businessVerification'] as { status?: string } | undefined;
  const cachedHasContact = Boolean(cachedContact?.contactEmail || cachedContact?.contactPhone || input.phone);
  const readyFromCache = Boolean(
    cachedCampaignDraft &&
    cachedHasContact &&
    cachedVerification?.status === 'verified',
  );
  const state: LeadPipelineState = readyFromCache ? 'CAMPAIGN_READY' : 'DISCOVERED';

  const [lead] = await db
    .insert(researchedLeads)
    .values({
      id: randomUUID(),
      companyName: input.companyName,
      website: input.website,
      industry: normalizeIndustry(input.industry) ?? input.industry,
      city: input.city,
      contactPhone: input.phone ?? cachedContact?.contactPhone,
      decisionMakerName: cachedContact?.decisionMakerName,
      contactEmail: cachedContact?.contactEmail,
      contactSourceUrl: cachedContact?.contactSourceUrl,
      contactResearchStatus: cachedContact?.contactResearchStatus ?? (input.phone ? 'partial' : 'pending'),
      contactResearchedAt: cachedContact ? now : null,
      fitReason: makeFastFitReason(input.industry, input.city, input.companyName),
      outreachAngle: readyFromCache && typeof cachedCampaignDraft?.['firstTouch'] === 'string'
        ? String(cachedCampaignDraft['firstTouch'])
        : makeShortOutreachAngle(input.companyName, input.industry, input.city),
      status: readyFromCache ? 'qualified' : 'new',
      pipelineState: state,
      pipelineStateChangedAt: now,
      discoveredAt: now,
      ...(readyFromCache
        ? {
            basicEnrichedAt: now,
            contactFoundAt: now,
            qualifiedAt: now,
            deepResearchedAt: now,
            campaignReadyAt: now,
            campaignDraft: cachedCampaignDraft,
          }
        : {}),
      researchCacheKey: cacheKey,
      campaignId: input.campaignId,
      campaignSegmentId: input.campaignSegmentId,
      source: input.source,
      pipelineMetadata: {
        ...input.metadata,
        normalizedDomain: domain,
        cacheHit: Boolean(cached),
      },
      researchedByAgentId: input.researchedByAgentId,
      createdAt: now,
    })
    .returning();

  emitApexEvent({
    type: 'lead:discovered',
    leadId: lead.id,
    campaignId: input.campaignId ?? null,
    companyName: lead.companyName,
    website: lead.website ?? null,
    industry: lead.industry ?? null,
    city: lead.city ?? null,
    pipelineState: lead.pipelineState,
    cacheHit: Boolean(cached),
    timestamp: now.toISOString(),
  });

  if (readyFromCache) {
    emitLeadState(lead.id, input.campaignId ?? null, 'CAMPAIGN_READY', now);
  }

  return lead;
}

export async function processLeadPipelineBacklog(options: {
  campaignId?: string;
  stageConcurrency?: number;
  leaseMs?: number;
} = {}): Promise<{ advanced: number; byState: Record<string, number> }> {
  const stageConcurrency = options.stageConcurrency ?? getLeadPipelineConfig().stageConcurrency;
  const leaseMs = options.leaseMs ?? getLeadPipelineConfig().leaseMs;
  const byState: Record<string, number> = {};
  let advanced = 0;

  for (const state of LEAD_PIPELINE_STATES) {
    if (state === 'CAMPAIGN_READY') continue;
    const claimed = await claimLeadsForState(state, {
      campaignId: options.campaignId,
      limit: stageConcurrency,
      leaseMs,
    });
    if (claimed.length === 0) continue;

    const results = await Promise.allSettled(claimed.map((lead) => advanceLeadPipeline(lead.id, state)));
    const count = results.filter((r) => r.status === 'fulfilled').length;
    byState[state] = count;
    advanced += count;
  }

  if (advanced > 0) {
    emitApexEvent({
      type: 'lead:pipeline:metrics',
      campaignId: options.campaignId ?? null,
      advanced,
      byState,
      timestamp: new Date().toISOString(),
    });
  }

  return { advanced, byState };
}

async function claimLeadsForState(
  state: LeadPipelineState,
  options: { campaignId?: string; limit: number; leaseMs: number },
) {
  const now = new Date();
  const conditions = [
    eq(researchedLeads.pipelineState, state),
    sql`${researchedLeads.status} <> 'rejected'`,
    or(isNull(researchedLeads.pipelineLeaseExpiresAt), lt(researchedLeads.pipelineLeaseExpiresAt, now)),
  ];
  if (state === 'CONTACT_FOUND') {
    // Do not manufacture "qualified" prospects that have no reachable public
    // contact path. They remain parked for the enrichment backlog.
    conditions.push(
      or(
        sql`${researchedLeads.contactEmail} IS NOT NULL`,
        sql`${researchedLeads.contactPhone} IS NOT NULL`,
      ),
    );
  }
  if (state === 'QUALIFIED' || state === 'DEEP_RESEARCH') {
    conditions.push(eq(researchedLeads.status, 'qualified'));
  }
  if (options.campaignId) conditions.push(eq(researchedLeads.campaignId, options.campaignId));

  const candidates = await db
    .select({ id: researchedLeads.id })
    .from(researchedLeads)
    .where(and(...conditions))
    .orderBy(asc(researchedLeads.createdAt))
    .limit(options.limit);

  const claimed = [];
  const leaseUntil = new Date(Date.now() + options.leaseMs);
  for (const candidate of candidates) {
    const [row] = await db
      .update(researchedLeads)
      .set({ pipelineLeaseExpiresAt: leaseUntil })
      .where(and(eq(researchedLeads.id, candidate.id), eq(researchedLeads.pipelineState, state)))
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

async function advanceLeadPipeline(leadId: string, expectedState: LeadPipelineState): Promise<void> {
  const [lead] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, leadId)).limit(1);
  if (!lead || lead.pipelineState !== expectedState) return;
  const next = NEXT_STATE[expectedState];
  if (!next) return;

  const now = new Date();
  const cacheKey = lead.researchCacheKey ?? makeResearchCacheKey({
    companyName: lead.companyName,
    website: lead.website,
    city: lead.city,
  });
  const domain = normalizeLeadDomain(lead.website);
  const [cached] = await db.select().from(leadResearchCache).where(eq(leadResearchCache.cacheKey, cacheKey)).limit(1);

  let identity: BusinessWebsiteIdentity | null = null;
  let stageLead = lead;
  if (next === 'BASIC_ENRICHMENT' && lead.website) {
    identity = await verifyBusinessWebsiteIdentity({
      website: lead.website,
      industry: lead.industry,
      city: lead.city,
      currentName: lead.companyName,
    });
    const betterName = identity.canonicalName?.trim();
    stageLead = {
      ...lead,
      companyName: betterName && (identity.status === 'verified' || isSeoLikeCompanyName(lead.companyName, lead.city))
        ? betterName
        : lead.companyName,
      website: identity.homepage ?? lead.website,
      decisionMakerName: lead.decisionMakerName ?? identity.decisionMakerName,
      contactEmail: lead.contactEmail ?? identity.contactEmail,
      contactPhone: lead.contactPhone ?? identity.contactPhone,
      contactSourceUrl: lead.contactSourceUrl ?? identity.contactSourceUrl ?? identity.decisionMakerSourceUrl,
      contactResearchStatus:
        (lead.contactEmail ?? identity.contactEmail) && (lead.contactPhone ?? identity.contactPhone)
          ? 'complete'
          : (lead.contactEmail || lead.contactPhone || identity.contactEmail || identity.contactPhone)
            ? 'partial'
            : lead.contactResearchStatus,
    };
  }

  const update = buildStageUpdate(next, stageLead, cached);
  if (identity) {
    update.companyName = stageLead.companyName;
    update.website = stageLead.website;
    update.decisionMakerName = stageLead.decisionMakerName;
    update.contactEmail = stageLead.contactEmail;
    update.contactPhone = stageLead.contactPhone;
    update.contactSourceUrl = stageLead.contactSourceUrl;
    update.contactResearchStatus = stageLead.contactResearchStatus;
    update.contactResearchedAt = identity.contactEmail || identity.contactPhone ? now : lead.contactResearchedAt;
    update.enrichment = {
      ...((update.enrichment as Record<string, unknown> | null) ?? {}),
      businessVerification: identity,
      summary: `${stageLead.companyName} is a ${stageLead.industry ?? 'local'} business in ${stageLead.city ?? 'its market'}.`,
    };
    if (identity.status === 'mismatch') {
      update.status = 'rejected';
      update.qualificationScore = 0;
    }
  }
  const timestampColumn = STATE_TIMESTAMP[next];

  await db
    .update(researchedLeads)
    .set({
      ...update,
      ...(timestampColumn ? { [timestampColumn]: now } : {}),
      pipelineState: next,
      pipelineStateChangedAt: now,
      pipelineLeaseExpiresAt: null,
      researchCacheKey: cacheKey,
      pipelineMetadata: {
        ...(lead.pipelineMetadata ?? {}),
        normalizedDomain: domain,
        lastAdvancedFrom: expectedState,
        lastAdvancedAt: now.toISOString(),
      },
    })
    .where(and(eq(researchedLeads.id, lead.id), eq(researchedLeads.pipelineState, expectedState)));

  await upsertResearchCache(cacheKey, stageLead, next, update);
  emitLeadState(lead.id, lead.campaignId ?? null, next, now);
}

function buildStageUpdate(
  next: LeadPipelineState,
  lead: typeof researchedLeads.$inferSelect,
  cached: typeof leadResearchCache.$inferSelect | undefined,
): Partial<typeof researchedLeads.$inferInsert> {
  if (next === 'BASIC_ENRICHMENT') {
    return {
      enrichment: {
        ...(lead.enrichment ?? {}),
        ...(cached?.basicEnrichment ?? {}),
        normalizedDomain: normalizeLeadDomain(lead.website),
        summary: `${lead.companyName} is a ${lead.industry ?? 'local'} business in ${lead.city ?? 'its market'}.`,
      },
      fitReason: lead.fitReason || makeFastFitReason(lead.industry, lead.city, lead.companyName),
    };
  }

  if (next === 'CONTACT_FOUND') {
    const cachedContact = cached?.contactResearch as {
      decisionMakerName?: string;
      contactEmail?: string;
      contactPhone?: string;
      contactSourceUrl?: string;
      contactResearchStatus?: 'pending' | 'partial' | 'complete' | 'unavailable';
    } | null;
    const hasContact = Boolean(lead.contactEmail || lead.contactPhone || cachedContact?.contactEmail || cachedContact?.contactPhone);
    return {
      decisionMakerName: lead.decisionMakerName ?? cachedContact?.decisionMakerName,
      contactEmail: lead.contactEmail ?? cachedContact?.contactEmail,
      contactPhone: lead.contactPhone ?? cachedContact?.contactPhone,
      contactSourceUrl: lead.contactSourceUrl ?? cachedContact?.contactSourceUrl,
      contactResearchStatus: cachedContact?.contactResearchStatus ?? (hasContact ? 'partial' : 'pending'),
      contactResearchedAt: hasContact ? new Date() : lead.contactResearchedAt,
    };
  }

  if (next === 'QUALIFIED') {
    const score = scoreLead(lead);
    return {
      qualificationScore: score,
      status: score >= 55 ? 'qualified' : 'rejected',
      fitReason: trimWords(lead.fitReason || makeFastFitReason(lead.industry, lead.city, lead.companyName)),
      outreachAngle: lead.outreachAngle ?? makeShortOutreachAngle(lead.companyName, lead.industry, lead.city),
    };
  }

  if (next === 'DEEP_RESEARCH') {
    return {
      enrichment: {
        ...(lead.enrichment ?? {}),
        deepResearch: {
          generatedAt: new Date().toISOString(),
          notes: [
            'Confirm current services, service area, and leadership before live outreach.',
            'Prioritize speed-to-lead, missed-call coverage, and after-hours response angles.',
          ],
        },
      },
    };
  }

  if (next === 'CAMPAIGN_READY') {
    const draft = {
      firstTouch: lead.outreachAngle ?? makeShortOutreachAngle(lead.companyName, lead.industry, lead.city),
      emailSubject: `${lead.companyName} speed-to-lead coverage`,
      callOpener:
        `Hi, this is Don's team. We found ${lead.companyName} while mapping ${lead.industry ?? 'local service'} operators in ${lead.city ?? 'your market'}, and wanted to compare notes on missed calls and after-hours lead capture.`,
      nextBestAction: lead.contactEmail ? 'email' : lead.contactPhone ? 'call' : 'research_contact',
    };
    return {
      campaignDraft: draft,
      outreachAngle: lead.outreachAngle ?? String(draft.firstTouch),
    };
  }

  return {};
}

async function upsertResearchCache(
  cacheKey: string,
  lead: typeof researchedLeads.$inferSelect,
  state: LeadPipelineState,
  update: Partial<typeof researchedLeads.$inferInsert>,
): Promise<void> {
  const now = new Date();
  const base = {
    cacheKey,
    normalizedDomain: normalizeLeadDomain(lead.website),
    companyName: lead.companyName,
    website: lead.website,
    industry: lead.industry,
    city: lead.city,
    updatedAt: now,
  };
  const staged = cachePayloadForState(state, lead, update);
  await db
    .insert(leadResearchCache)
    .values({
      ...base,
      ...staged,
      hitCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: leadResearchCache.cacheKey,
      set: {
        ...base,
        ...staged,
        hitCount: sql`${leadResearchCache.hitCount} + 1`,
        updatedAt: now,
      },
    });
}

function cachePayloadForState(
  state: LeadPipelineState,
  lead: typeof researchedLeads.$inferSelect,
  update: Partial<typeof researchedLeads.$inferInsert>,
): Partial<typeof leadResearchCache.$inferInsert> {
  if (state === 'BASIC_ENRICHMENT') return { basicEnrichment: update.enrichment ?? lead.enrichment ?? {} };
  if (state === 'CONTACT_FOUND') {
    return {
      contactResearch: {
        decisionMakerName: update.decisionMakerName ?? lead.decisionMakerName,
        contactEmail: update.contactEmail ?? lead.contactEmail,
        contactPhone: update.contactPhone ?? lead.contactPhone,
        contactSourceUrl: update.contactSourceUrl ?? lead.contactSourceUrl,
        contactResearchStatus: update.contactResearchStatus ?? lead.contactResearchStatus,
      },
    };
  }
  if (state === 'QUALIFIED') {
    return { qualification: { score: update.qualificationScore, fitReason: update.fitReason ?? lead.fitReason } };
  }
  if (state === 'DEEP_RESEARCH') return { deepResearch: (update.enrichment as Record<string, unknown>)?.['deepResearch'] as Record<string, unknown> ?? {} };
  if (state === 'CAMPAIGN_READY') return { campaignDraft: update.campaignDraft ?? lead.campaignDraft ?? {} };
  return {};
}

function emitLeadState(
  leadId: string,
  campaignId: string | null,
  pipelineState: LeadPipelineState,
  at: Date,
): void {
  emitApexEvent({
    type: 'lead:state',
    leadId,
    campaignId,
    pipelineState,
    timestamp: at.toISOString(),
  });
}

export function makeFastFitReason(industry: string | null | undefined, city: string | null | undefined, companyName: string): string {
  return `${companyName} fits the ${industry ?? 'local service'} ICP in ${city ?? 'its market'}: inbound calls, slow response, and after-hours gaps are likely revenue leaks APEX and BuildMyBot can address.`;
}

export function makeShortOutreachAngle(companyName: string, industry?: string | null, city?: string | null): string {
  return `Show ${companyName} how to capture and follow up with ${industry ?? 'service'} leads in ${city ?? 'their market'} before competitors respond.`;
}

function scoreLead(lead: typeof researchedLeads.$inferSelect): number {
  const verification = (lead.enrichment as Record<string, unknown> | null)?.['businessVerification'] as
    | { status?: string }
    | undefined;
  if (verification?.status !== 'verified') return 0;
  if (!lead.contactEmail && !lead.contactPhone) return 0;

  let score = 55;
  if (lead.website) score += 15;
  if (lead.contactEmail || lead.contactPhone) score += 15;
  if (lead.industry) score += 10;
  if (lead.city) score += 5;
  if ((lead.fitReason ?? '').length > 80) score += 10;
  return Math.min(100, score);
}

function trimWords(text: string): string {
  const maxWords = getLeadPipelineConfig().initialQualificationMaxWords;
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(' ')}.`;
}

let webIdentityRepairRunning = false;

function replaceCompanyNameText(value: string | null | undefined, oldName: string, newName: string): string | null | undefined {
  if (!value || oldName === newName) return value;
  return value.split(oldName).join(newName);
}

export async function repairWebLeadIdentityBatch(limit = 16): Promise<{ checked: number; renamed: number; mismatched: number; contactsAdded: number }> {
  if (webIdentityRepairRunning) return { checked: 0, renamed: 0, mismatched: 0, contactsAdded: 0 };
  webIdentityRepairRunning = true;
  try {
    const batchSize = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = await db
      .select()
      .from(researchedLeads)
      .where(
        and(
          sql`${researchedLeads.status} <> 'rejected'`,
          sql`${researchedLeads.website} IS NOT NULL`,
          or(
            like(researchedLeads.source, 'web:%'),
            like(researchedLeads.source, 'cache:web:%'),
            and(
              sql`${researchedLeads.contactEmail} IS NULL`,
              sql`${researchedLeads.contactPhone} IS NULL`,
            ),
          ),
          sql`COALESCE(${researchedLeads.enrichment}->'businessVerification'->>'contactScanVersion', '') <> '2026-09-28-v2'`,
        ),
      )
      .orderBy(asc(researchedLeads.createdAt))
      .limit(batchSize);

    let renamed = 0;
    let mismatched = 0;
    let contactsAdded = 0;
    await runPool(rows, Math.min(8, batchSize), async (lead) => {
      const identity = await verifyBusinessWebsiteIdentity({
        website: lead.website,
        industry: lead.industry,
        city: lead.city,
        currentName: lead.companyName,
      });
      const oldName = lead.companyName;
      const decisionMakerName = lead.decisionMakerName ?? identity.decisionMakerName;
      const contactEmail = lead.contactEmail ?? identity.contactEmail;
      const contactPhone = lead.contactPhone ?? identity.contactPhone;
      const contactSourceUrl = lead.contactSourceUrl ?? identity.contactSourceUrl ?? identity.decisionMakerSourceUrl;
      if ((!lead.contactEmail && contactEmail) || (!lead.contactPhone && contactPhone)) contactsAdded++;
      const candidate = identity.canonicalName?.trim();
      const newName = candidate && (identity.status === 'verified' || isSeoLikeCompanyName(oldName, lead.city))
        ? candidate
        : oldName;
      if (newName !== oldName) renamed++;
      if (identity.status === 'mismatch') mismatched++;

      const existingDraft = (lead.campaignDraft ?? {}) as Record<string, unknown>;
      const campaignDraft = Object.keys(existingDraft).length > 0
        ? {
            ...existingDraft,
            ...(typeof existingDraft.firstTouch === 'string' ? { firstTouch: replaceCompanyNameText(existingDraft.firstTouch, oldName, newName) } : {}),
            ...(typeof existingDraft.emailSubject === 'string' ? { emailSubject: replaceCompanyNameText(existingDraft.emailSubject, oldName, newName) } : {}),
            ...(typeof existingDraft.callOpener === 'string' ? { callOpener: replaceCompanyNameText(existingDraft.callOpener, oldName, newName) } : {}),
          }
        : lead.campaignDraft;

      await db.update(researchedLeads).set({
        companyName: newName,
        website: identity.homepage ?? lead.website,
        decisionMakerName,
        contactEmail,
        contactPhone,
        contactSourceUrl,
        contactResearchStatus: contactEmail && contactPhone ? 'complete' : contactEmail || contactPhone ? 'partial' : lead.contactResearchStatus,
        contactResearchedAt: contactEmail || contactPhone ? new Date() : lead.contactResearchedAt,
        enrichment: {
          ...(lead.enrichment ?? {}),
          businessVerification: identity,
          normalizedDomain: normalizeLeadDomain(identity.homepage ?? lead.website),
          summary: `${newName} is a ${lead.industry ?? 'local'} business in ${lead.city ?? 'its market'}.`,
        },
        fitReason: replaceCompanyNameText(lead.fitReason, oldName, newName) ?? lead.fitReason,
        outreachAngle: replaceCompanyNameText(lead.outreachAngle, oldName, newName) ?? lead.outreachAngle,
        campaignDraft,
        ...(identity.status === 'mismatch' ? { status: 'rejected', qualificationScore: 0 } : {}),
        updatedAt: new Date(),
      }).where(eq(researchedLeads.id, lead.id));

      if (lead.researchCacheKey) {
        await db.update(leadResearchCache).set({
          companyName: newName,
          website: identity.homepage ?? lead.website,
          basicEnrichment: {
            ...((lead.enrichment as Record<string, unknown> | null) ?? {}),
            businessVerification: identity,
          },
          contactResearch: {
            decisionMakerName,
            contactEmail,
            contactPhone,
            contactSourceUrl,
            contactResearchStatus: contactEmail && contactPhone ? 'complete' : contactEmail || contactPhone ? 'partial' : lead.contactResearchStatus,
          },
          updatedAt: new Date(),
        }).where(eq(leadResearchCache.cacheKey, lead.researchCacheKey));
      }
    });

    if (rows.length > 0) {
      console.log(`[lead-identity] checked=${rows.length} renamed=${renamed} mismatched=${mismatched} contactsAdded=${contactsAdded}`);
    }
    return { checked: rows.length, renamed, mismatched, contactsAdded };
  } finally {
    webIdentityRepairRunning = false;
  }
}

export interface PipelineBenchmarkResult {
  totalInput: number;
  uniqueDiscovered: number;
  duplicatesSuppressed: number;
  timeToFirstLeadMs: number;
  campaignReadyLatencyMs: number;
  throughputPerSecond: number;
  maxDiscoveryConcurrency: number;
  maxStageConcurrency: number;
}

export async function simulateStreamingPipeline(input: {
  totalCandidates: number;
  duplicateEvery?: number;
  discoveryConcurrency: number;
  stageConcurrency: number;
  discoveryDelayMs: number;
  stageDelayMs: number;
}): Promise<PipelineBenchmarkResult> {
  const started = Date.now();
  let activeDiscovery = 0;
  let maxDiscoveryConcurrency = 0;
  let activeStages = 0;
  let maxStageConcurrency = 0;
  let firstLeadAt = 0;
  let readyAt = 0;
  const seen = new Set<string>();
  let duplicatesSuppressed = 0;
  let uniqueDiscovered = 0;
  const stageSemaphore = createSemaphore(input.stageConcurrency);

  const candidates = Array.from({ length: input.totalCandidates }, (_, index) => {
    const dupeEvery = input.duplicateEvery ?? 0;
    const keyIndex = dupeEvery > 0 && index > 0 && index % dupeEvery === 0 ? index - 1 : index;
    return { key: `domain-${keyIndex}.example`, index };
  });

  await runPool(candidates, input.discoveryConcurrency, async (candidate) => {
    activeDiscovery++;
    maxDiscoveryConcurrency = Math.max(maxDiscoveryConcurrency, activeDiscovery);
    await sleep(input.discoveryDelayMs);
    activeDiscovery--;

    if (seen.has(candidate.key)) {
      duplicatesSuppressed++;
      return;
    }
    seen.add(candidate.key);
    uniqueDiscovered++;
    if (!firstLeadAt) firstLeadAt = Date.now();

    for (const _stage of LEAD_PIPELINE_STATES.slice(1)) {
      const release = await stageSemaphore.acquire();
      activeStages++;
      maxStageConcurrency = Math.max(maxStageConcurrency, activeStages);
      await sleep(input.stageDelayMs);
      activeStages--;
      release();
    }
    readyAt = Date.now();
  });

  const finished = Date.now();
  return {
    totalInput: input.totalCandidates,
    uniqueDiscovered,
    duplicatesSuppressed,
    timeToFirstLeadMs: firstLeadAt ? firstLeadAt - started : 0,
    campaignReadyLatencyMs: readyAt ? readyAt - started : 0,
    throughputPerSecond: uniqueDiscovered / Math.max(0.001, (finished - started) / 1000),
    maxDiscoveryConcurrency,
    maxStageConcurrency,
  };
}

function createSemaphore(limit: number): { acquire(): Promise<() => void> } {
  let active = 0;
  const waiters: Array<(release: () => void) => void> = [];
  const release = () => {
    active--;
    const next = waiters.shift();
    if (!next) return;
    active++;
    next(release);
  };
  return {
    acquire() {
      if (active < Math.max(1, limit)) {
        active++;
        return Promise.resolve(release);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

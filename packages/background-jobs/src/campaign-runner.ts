import { randomUUID } from 'crypto';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  db,
  campaignSegments,
  leadCampaigns,
  researchedLeads,
  leadResearchCache,
} from '@workspace/db';
import {
  createLLMClient,
  emitApexEvent,
  getDefaultLLMConfig,
  getToolRegistry,
  normalizeIndustry,
  type ResearchedLeadInput,
  type ToolContext,
} from '@workspace/core';
import { citiesForStates, allStateCodes } from './us-geo.js';
import {
  dedupeDiscoveredBusinesses,
  canonicalHomepageUrl,
  companyNameFromSearchResultTitle,
  generateSearchShards,
  subcategoriesForIndustry,
  getKnownLeadDomains,
  getLeadPipelineConfig,
  normalizeLeadDomain,
  insertDiscoveredLead,
  processLeadPipelineBacklog,
  repairWebLeadIdentityBatch,
  inspectFirstPartyContactUrl,
} from './lead-pipeline.js';
import { recordOperatorActivity } from './operator-activity.js';

// ─── Campaign Runner ──────────────────────────────────────────────────────────
//
// Works a lead campaign's territory one (industry x city) segment at a time.
//
// This is a DETERMINISTIC loop, not an LLM plan, and that is the whole point.
// Before campaigns existed, "go find leads" was a goal handed to the CEO, who
// decomposed it however the model decided that run. That path is where the
// 2026-08-22 failure rate lived: 15 tasks done against 115 failed, nearly all
// of them "All LLM providers failed". A lead hunt should not stop because a
// free tier ran out of tokens.
//
// So the model is used in exactly one place — writing the fit reason and
// outreach angle for a batch — and even there a template fallback keeps the
// campaign moving. Everything that actually FINDS a business is a structured
// directory call with no model involved:
//
//   claim segment -> searchBusinessDirectory -> drop known websites
//                 -> ONE qualify call per SEGMENT (not per lead)
//                 -> saveResearchedLeadsBatch -> update counters -> emit
//
// Cost scales with territory, not with lead count, and a total provider outage
// degrades the copy rather than halting the hunt.

/** How long a claimed segment may stay in_progress before another runner may
 *  take it. Matches the task-queue lease window in api-server/src/index.ts. */
const SEGMENT_LEASE_MS = 10 * 60 * 1000;

/** A campaign with no progress for this long is reported as stalled. It stays
 *  'running' in the table — this is a read-time judgement, not a state change,
 *  so a slow directory is never mistaken for a dead runner or vice versa. */
export const STALL_AFTER_MS = 15 * 60 * 1000;

/** Directory results per segment. Yelp caps at 20/call, Google at 20, so this
 *  is a ceiling rather than a target. */
const MAX_PER_SEGMENT = 25;

export interface CampaignProgress {
  campaignId: string;
  name: string;
  status: string;
  /** running | stalled | paused | completed | completed_short | cancelled | failed */
  displayStatus: string;
  targetLeads: number;
  leadsSaved: number;
  /** 0-1, capped at 1 so an over-delivering campaign never renders past full. */
  leadProgress: number;
  segmentsTotal: number;
  segmentsDone: number;
  segmentsFailed: number;
  segmentsRemaining: number;
  coverage: number;
  duplicatesSkipped: number;
  /** Mean leads saved per completed segment. null until one completes —
   *  a yield computed from zero segments is a divide-by-zero, not a zero. */
  yieldPerSegment: number | null;
  /** null when it cannot be honestly estimated (no completed segments yet, or
   *  yield so far is zero). Never a fabricated number. */
  etaMs: number | null;
  lastProgressAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Compute live progress from campaign + segment rows.
 *
 * Deliberately derived at read time and never stored: a cached percentage goes
 * stale the moment a segment lands, and a stored ETA is a number that looks
 * authoritative while being wrong.
 */
export function computeCampaignProgress(
  campaign: typeof leadCampaigns.$inferSelect,
  segments: Array<typeof campaignSegments.$inferSelect>,
  now: number = Date.now(),
  usableLeadCount?: number,
): CampaignProgress {
  const done = segments.filter((s) => s.status === 'done' || s.status === 'exhausted');
  const failed = segments.filter((s) => s.status === 'failed');
  const rawLeadsSaved = segments.reduce((n, s) => n + (s.saved ?? 0), 0);
  const leadsSaved = usableLeadCount ?? rawLeadsSaved;
  const duplicates = segments.reduce((n, s) => n + (s.duplicates ?? 0), 0);
  const remaining = segments.length - done.length - failed.length;

  const yieldPerSegment = done.length > 0 ? leadsSaved / done.length : null;

  // Mean wall-clock across segments that recorded both ends. Only segments
  // that actually completed contribute — an in-flight one has no duration yet.
  const durations = done
    .filter((s) => s.startedAt && s.completedAt)
    .map((s) => s.completedAt!.getTime() - s.startedAt!.getTime())
    .filter((ms) => ms > 0);
  const avgSegmentMs = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : null;

  let etaMs: number | null = null;
  if (yieldPerSegment && yieldPerSegment > 0 && avgSegmentMs && remaining > 0) {
    const stillNeeded = Math.max(0, campaign.targetLeads - leadsSaved);
    const segmentsNeeded = Math.min(remaining, Math.ceil(stillNeeded / yieldPerSegment));
    etaMs = Math.round(segmentsNeeded * avgSegmentMs);
  }

  const stalled =
    campaign.status === 'running' &&
    campaign.lastProgressAt != null &&
    now - campaign.lastProgressAt.getTime() > STALL_AFTER_MS;

  return {
    campaignId: campaign.id,
    name: campaign.name,
    status: campaign.status,
    displayStatus: stalled ? 'stalled' : campaign.status,
    targetLeads: campaign.targetLeads,
    leadsSaved,
    leadProgress: campaign.targetLeads > 0
      ? Math.min(1, leadsSaved / campaign.targetLeads)
      : 0,
    segmentsTotal: segments.length,
    segmentsDone: done.length,
    segmentsFailed: failed.length,
    segmentsRemaining: remaining,
    coverage: segments.length > 0 ? (done.length + failed.length) / segments.length : 0,
    duplicatesSkipped: duplicates,
    yieldPerSegment,
    etaMs,
    lastProgressAt: campaign.lastProgressAt?.toISOString() ?? null,
    startedAt: campaign.startedAt?.toISOString() ?? null,
    completedAt: campaign.completedAt?.toISOString() ?? null,
  };
}

export async function countUsableCampaignLeads(campaignId: string): Promise<number> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(researchedLeads)
    .where(
      and(
        eq(researchedLeads.campaignId, campaignId),
        eq(researchedLeads.pipelineState, 'CAMPAIGN_READY'),
        eq(researchedLeads.status, 'qualified'),
        sql`(${researchedLeads.contactEmail} IS NOT NULL OR ${researchedLeads.contactPhone} IS NOT NULL)`,
        sql`${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'`,
      ),
    );
  return Number(row?.count ?? 0);
}

export interface CreateCampaignInput {
  name: string;
  industries: string[];
  /** Explicit cities, e.g. "Dallas TX". Combined with states/national below,
   *  not replaced by them — a caller can mix a hand-picked city with whole
   *  states in one campaign. */
  cities: string[];
  /** Two-letter USPS codes (e.g. "TX", "CA") — expands to that state's 3
   *  principal cities via STATE_CITIES instead of typing them out. */
  states?: string[];
  /** Every state's principal cities — the "all 50 states" shorthand. Combines
   *  with cities/states rather than overriding them, though in practice it
   *  already covers everything they would add. */
  national?: boolean;
  targetLeads?: number;
  goalId?: string;
  projectId?: string;
  pushToBuildmybot?: boolean;
  createdByAgentId?: string;
  notes?: string;
}

/** Safety ceiling on territory size. The API currently allows at most 20
 * industries combined with national targeting plus up to 50 explicit cities,
 * which tops out below this value. Keeping a guard here protects direct tool
 * callers from accidentally creating an unbounded cross product while allowing
 * national multi-industry campaigns to run as one consolidated campaign. */
export const MAX_CAMPAIGN_SEGMENTS = 5_000;

/** Insert large territories in bounded batches so campaign creation does not
 * build one oversized SQL statement. */
const SEGMENT_INSERT_BATCH = 500;

/**
 * Create a campaign and enqueue its territory as the cross product of
 * industries x cities. Industries are normalized first, so a caller passing
 * "Real Estate Brokerage" and "realtor" gets one segment per city, not two.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<{
  campaignId: string;
  segments: number;
  industries: string[];
  cities: string[];
}> {
  const industries = [...new Set(
    input.industries.map((i) => normalizeIndustry(i)).filter((i): i is string => Boolean(i)),
  )];
  const explicitCities = input.cities.map((c) => c.trim()).filter(Boolean);
  const expandedCities = input.national
    ? citiesForStates(allStateCodes())
    : citiesForStates(input.states ?? []);
  const cities = [...new Set([...explicitCities, ...expandedCities])];

  if (industries.length === 0) throw new Error('At least one industry is required.');
  if (cities.length === 0) {
    throw new Error('At least one city, state, or national=true is required.');
  }

  const config = getLeadPipelineConfig();
  const cells = generateSearchShards(industries, cities, {
    liveDemoMode: config.liveDemoMode,
    shardsPerCell: config.shardsPerCell,
  });
  if (cells.length > MAX_CAMPAIGN_SEGMENTS) {
    throw new Error(
      `That territory is ${cells.length} query shards (${industries.length} industries x ${cities.length} cities); ` +
        `the safety ceiling is ${MAX_CAMPAIGN_SEGMENTS}. Narrow the territory or split it into multiple campaigns.`,
    );
  }

  const campaignId = randomUUID();
  const now = new Date();

  await db.insert(leadCampaigns).values({
    id: campaignId,
    name: input.name,
    goalId: input.goalId,
    projectId: input.projectId ?? 'buildmybot',
    icp: { industries, cities, notes: input.notes },
    targetLeads: input.targetLeads ?? 100,
    status: 'running',
    pushToBuildmybot: input.pushToBuildmybot ?? false,
    createdAt: now,
    startedAt: now,
    lastProgressAt: now,
    createdByAgentId: input.createdByAgentId,
  });

  for (let offset = 0; offset < cells.length; offset += SEGMENT_INSERT_BATCH) {
    const batch = cells.slice(offset, offset + SEGMENT_INSERT_BATCH);
    await db.insert(campaignSegments).values(
      batch.map((cell) => ({
        id: randomUUID(),
        campaignId,
        industry: cell.industry,
        city: cell.city,
        subcategory: cell.subcategory,
        searchIntent: cell.searchIntent,
        query: cell.query,
        status: 'pending',
        createdAt: now,
      })),
    );
  }

  emitApexEvent({
    type: 'campaign:started',
    campaignId,
    name: input.name,
    targetLeads: input.targetLeads ?? 100,
    segments: cells.length,
  });

  return { campaignId, segments: cells.length, industries, cities };
}

interface DirectoryBusiness {
  name?: string;
  n?: string;
  website?: string;
  w?: string;
  industry?: string;
  i?: string;
  city?: string;
  c?: string;
  phone?: string;
  p?: string;
  address?: string;
}

/** searchBusinessDirectory returns three different shapes depending on which
 *  provider answered — Yelp uses single-letter keys to save tokens, Google and
 *  OSM use full names. Normalize once here so the rest of the runner does not
 *  care who answered. */
export function readBusiness(b: DirectoryBusiness): DirectoryLead | null {
  const companyName = (b.name ?? b.n ?? '').trim();
  if (!companyName) return null;
  const website = (b.website ?? b.w ?? '').trim() || undefined;
  return {
    companyName,
    website,
    industry: (b.industry ?? b.i ?? '').trim() || undefined,
    city: (b.city ?? b.c ?? '').trim() || undefined,
    phone: (b.phone ?? b.p ?? '').trim() || undefined,
  };
}

/** What the directory step knows about a business, before qualification. */
export interface DirectoryLead {
  companyName: string;
  website?: string;
  industry?: string;
  city?: string;
  phone?: string;
}

/**
 * How much of a contact path a directory row actually gives us.
 *
 * Never 'complete': this loop reads a business directory and stops there. It
 * does not open the company site, so it never has a verified decision maker
 * or email, and claiming otherwise would mark leads as fully enriched that
 * the enrichment pass still needs to work.
 */
function contactStatusFor(b: DirectoryLead): ResearchedLeadInput['contactResearchStatus'] {
  return b.phone || b.website ? 'partial' : 'unavailable';
}

/**
 * Every field saveResearchedLeadsBatch requires that has nothing to do with
 * the model. Typed as the tool's own input type so that adding a required
 * field to researchedLeadInputSchema breaks `pnpm run typecheck:production`
 * here, which is the whole reason this producer is typed at all.
 *
 * Module level, not a closure inside qualifyBatch, so the payload shape can
 * be verified against the real schema with no LLM and no database.
 */
export function campaignLeadBase(
  segment: Pick<typeof campaignSegments.$inferSelect, 'industry' | 'city'>,
  b: DirectoryLead,
): Omit<ResearchedLeadInput, 'fitReason' | 'outreachAngle'> {
  return {
    companyName: b.companyName,
    website: b.website,
    industry: segment.industry,
    city: b.city || segment.city,
    contactPhone: b.phone,
    contactResearchStatus: contactStatusFor(b),
  };
}

/**
 * The copy used when the qualification model is unavailable or unparseable.
 *
 * outreachAngle here was `undefined`, which is what made the fallback worse
 * than useless: the angle is required, so the one path built to keep the hunt
 * alive through a provider outage produced a payload guaranteed to be
 * rejected. A plainer opener is the entire point of a fallback.
 */
export function templateCopyFor(
  segment: Pick<typeof campaignSegments.$inferSelect, 'industry' | 'city'>,
  b: DirectoryLead,
): Pick<ResearchedLeadInput, 'fitReason' | 'outreachAngle'> {
  return {
    fitReason:
      `${segment.industry} business in ${segment.city} — BuildMyBot's ICP for speed-to-lead: ` +
      `missed inbound calls, slow first response, and no after-hours coverage. ` +
      `Not yet individually qualified (${b.companyName} was captured from a directory search).`,
    outreachAngle:
      `Ask ${b.companyName} what happens to a ${segment.industry.toLowerCase()} call that comes in ` +
      `after hours or while the crew is on a job — then show BuildMyBot answering it in ` +
      `${b.city || segment.city} and booking the appointment.`,
  };
}

/** A failure the same inputs will reproduce exactly, so a retry is pure
 *  waste. Right now that means a tool rejecting our arguments: the registry
 *  validates every call against the tool's Zod schema before executing it,
 *  and a payload that fails that check fails it every time. */
export function isDeterministicFailure(message: string): boolean {
  const allDiscoveryProvidersMissing =
    message.includes('YELP_API_KEY not set') &&
    message.includes('GOOGLE_PLACES_API_KEY not set') &&
    message.includes('TOMTOM_API_KEY not set') &&
    message.includes('TAVILY_API_KEY not set') &&
    message.includes('BRAVE_SEARCH_API_KEY not set');
  const osmCannotAnswer = message.includes('OSM: no known category tag');

  return (
    message.startsWith('Invalid args for ') ||
    message.startsWith('Unknown tool: ') ||
    (allDiscoveryProvidersMissing && osmCannotAnswer)
  );
}

/** Strip to a comparable hostname so "https://www.acme.com/" and
 *  "http://acme.com" are recognized as the same company. */
function domainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

const LEGACY_GENERIC_SUBCATEGORIES = ['company', 'service provider', 'contractor', 'local business'] as const;

export function effectiveSegmentSearch(segment: Pick<
  typeof campaignSegments.$inferSelect,
  'industry' | 'city' | 'subcategory' | 'searchIntent' | 'query'
>): { subcategory: string; query: string; repairedLegacyGeneric: boolean } {
  const specific = subcategoriesForIndustry(segment.industry);
  const legacyIndex = LEGACY_GENERIC_SUBCATEGORIES.indexOf(
    segment.subcategory as (typeof LEGACY_GENERIC_SUBCATEGORIES)[number],
  );

  // Older campaigns stored generic shards before an industry-specific mapping
  // existed. Do not keep burning those stored queries forever: remap each of
  // the four generic buckets onto the industry's current specific taxonomy.
  if (legacyIndex >= 0 && specific.some((value) => !LEGACY_GENERIC_SUBCATEGORIES.includes(
    value as (typeof LEGACY_GENERIC_SUBCATEGORIES)[number],
  ))) {
    const subcategory = specific[legacyIndex % specific.length];
    const query = segment.searchIntent === 'directory'
      ? `${subcategory} ${segment.city}`
      : `${segment.searchIntent} ${subcategory} ${segment.city}`;
    return { subcategory, query, repairedLegacyGeneric: true };
  }

  return {
    subcategory: segment.subcategory,
    query: segment.query ?? `${segment.searchIntent} ${segment.subcategory} ${segment.city}`,
    repairedLegacyGeneric: false,
  };
}

const SEARCH_DIRECTORY_HOSTS = [
  'yelp.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'yellowpages.com',
  'mapquest.com',
  'bbb.org',
  'chamberofcommerce.com',
  'manta.com',
] as const;

export function businessFromWebResult(result: { title?: string; url?: string; snippet?: string }, city: string): DirectoryBusiness | null {
  const url = result.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
  if (!host || SEARCH_DIRECTORY_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
    return null;
  }

  const homepage = canonicalHomepageUrl(url);
  if (!homepage) return null;

  // Search engines return PAGE titles, not necessarily company names. That is
  // why the UI showed things like "#1 Roofing Company In Northeast Ohio".
  // Pick a brand-looking title segment when one exists; otherwise fall back to
  // the official site's domain identity. The asynchronous BASIC_ENRICHMENT
  // stage then verifies the homepage and upgrades this to JSON-LD/OG identity.
  const rawTitle = result.title?.trim() ?? '';
  const name = companyNameFromSearchResultTitle(rawTitle, homepage, city);
  if (!name) return null;

  return {
    name,
    website: homepage,
    city,
  };
}

export class CampaignRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly toolContext: ToolContext;
  private knownDomainsCache: Set<string> | null = null;
  private knownDomainsRefreshedAt = 0;
  private knownDomainsLoad: Promise<Set<string>> | null = null;
  private contactSearchRunning = false;
  private contactSearchLastRunAt = 0;
  private contactSearchZeroYieldStreak = 0;
  private contactSearchBackoffUntil = 0;
  private contactSearchLastSummaryAt = 0;
  private readonly repairedCampaignIds = new Set<string>();

  constructor(
    private readonly intervalMs = Number(
      process.env.LEAD_CAMPAIGN_INTERVAL_MS ??
      (getLeadPipelineConfig().liveDemoMode ? 2_000 : 5_000),
    ),
  ) {
    this.toolContext = {
      agentId: 'apex-campaign-runner',
      workspaceRoot: process.cwd(),
      // The runner only ever calls read/write tools that are not approval
      // gated. Refusing here rather than auto-approving means that if a gated
      // tool is ever wired in by mistake it fails loudly instead of silently
      // acquiring authority this loop was never meant to have.
      requestApproval: async () => false,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        console.error('[campaigns] tick failed:', err instanceof Error ? err.message : String(err)),
      );
    }, this.intervalMs);
    console.log(`[campaigns] Runner started (every ${Math.max(0.1, this.intervalMs / 1000).toFixed(1)}s)`);
    // Do not sit idle for a full interval after boot/deploy. Start one pass
    // immediately, then the normal interval keeps the runner moving.
    setTimeout(() => {
      this.tick().catch((err) =>
        console.error('[campaigns] prewarm tick failed:', err instanceof Error ? err.message : String(err)),
      );
    }, 250).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: recover expired leases, discover across query shards, then
   *  advance asynchronous enrichment/contact/qualification/research stages. */
  async tick(): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      const config = getLeadPipelineConfig();
      void repairWebLeadIdentityBatch(Number(process.env.LEAD_IDENTITY_REPAIR_BATCH ?? 16))
        .catch((err) => console.warn('[lead-identity] background repair failed:', err instanceof Error ? err.message : String(err)));
      void this.enrichVerifiedContactsFromSearch(Number(process.env.LEAD_CONTACT_SEARCH_BATCH ?? 6))
        .catch((err) => console.warn('[lead-contact-search] background search failed:', err instanceof Error ? err.message : String(err)));
      await this.recoverExpiredLeases();
      const claimed = await this.claimSegments(config.segmentBatchSize);
      if (claimed.length === 0) {
        await processLeadPipelineBacklog({
          stageConcurrency: config.stageConcurrency,
          leaseMs: config.leaseMs,
        });
        await this.closeFinishedCampaigns();
        return;
      }
      await Promise.allSettled(claimed.map((item) => this.runSegment(item.campaign, item.segment)));
      await processLeadPipelineBacklog({
        stageConcurrency: config.stageConcurrency,
        leaseMs: config.leaseMs,
      });
      await this.closeFinishedCampaigns();
    } finally {
      this.running = false;
    }
  }

  /**
   * Second-pass contact recovery for verified businesses. First-party crawling
   * handles the obvious homepage/contact/about/team pages. For the remainder,
   * use the existing fast cached Tavily/Brave path to discover hidden official
   * pages, then fetch only same-domain URLs. No LLM and no guessed contact data.
   */
  private async enrichVerifiedContactsFromSearch(limit: number): Promise<void> {
    if (this.contactSearchRunning) return;
    // This lane is specifically a Tavily/Brave recovery pass. When neither
    // provider is configured, do not issue guaranteed-fail searches for every
    // candidate on every interval; first-party crawling remains active in the
    // normal lead pipeline and this lane resumes automatically once a key is set.
    if (!process.env.TAVILY_API_KEY && !process.env.BRAVE_SEARCH_API_KEY) return;
    const nowMs = Date.now();
    const intervalMs = Math.max(15_000, Number(process.env.LEAD_CONTACT_SEARCH_INTERVAL_MS ?? 60_000));
    if (nowMs < this.contactSearchBackoffUntil) return;
    if (nowMs - this.contactSearchLastRunAt < intervalMs) return;
    this.contactSearchLastRunAt = nowMs;
    this.contactSearchRunning = true;
    try {
      const batchSize = Math.max(1, Math.min(20, Math.trunc(limit)));
      const version = '2026-09-28-contact-web-v1';
      const candidates = await db
        .select()
        .from(researchedLeads)
        .where(
          and(
            sql`${researchedLeads.status} <> 'rejected'`,
            sql`${researchedLeads.website} IS NOT NULL`,
            sql`${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'`,
            or(
              isNull(researchedLeads.contactEmail),
              isNull(researchedLeads.contactPhone),
            ),
            sql`COALESCE(${researchedLeads.enrichment}->'contactWebSearch'->>'version', '') <> ${version}`,
          ),
        )
        .orderBy(asc(researchedLeads.createdAt))
        .limit(batchSize);

      if (candidates.length === 0) return;
      const registry = getToolRegistry();
      let emailsAdded = 0;
      let phonesAdded = 0;
      let decisionMakersAdded = 0;
      let fullyReachable = 0;
      let stillIncomplete = 0;
      let cacheHits = 0;

      await Promise.all(candidates.map(async (lead) => {
        const domain = normalizeLeadDomain(lead.website);
        if (!domain) return;
        const result = await registry.execute(
          'webSearch',
          {
            query: `site:${domain} "${lead.companyName}" contact phone email`,
            maxResults: 6,
            fast: true,
            freeOnly: true,
          },
          this.toolContext,
        );

        const payload = result.success
          ? result.data as {
              provider?: string;
              cacheHit?: boolean;
              results?: Array<{ title?: string; url?: string; snippet?: string }>;
            }
          : null;

        const urls = [...new Set((payload?.results ?? [])
          .map((row) => row.url?.trim())
          .filter((url): url is string => {
            if (!url) return false;
            try {
              return normalizeLeadDomain(url) === domain;
            } catch {
              return false;
            }
          }))].slice(0, 3);

        const pages = await Promise.all(urls.map((url) => inspectFirstPartyContactUrl(url)));
        let contactEmail = lead.contactEmail;
        let contactPhone = lead.contactPhone;
        let decisionMakerName = lead.decisionMakerName;
        let contactSourceUrl = lead.contactSourceUrl;
        let decisionMakerTitle: string | null = null;
        let decisionMakerSourceUrl: string | null = null;

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
        }

        if (!lead.contactEmail && contactEmail) emailsAdded++;
        if (!lead.contactPhone && contactPhone) phonesAdded++;
        if (!lead.decisionMakerName && decisionMakerName) decisionMakersAdded++;
        if (contactEmail && contactPhone) fullyReachable++;
        else stillIncomplete++;
        if (payload?.cacheHit) cacheHits++;

        const now = new Date();
        const foundAny = Boolean(contactEmail || contactPhone);
        const enrichment = {
          ...(lead.enrichment ?? {}),
          contactWebSearch: {
            version,
            checkedAt: now.toISOString(),
            provider: payload?.provider ?? null,
            cacheHit: Boolean(payload?.cacheHit),
            resultsScanned: urls.length,
            foundEmail: Boolean(!lead.contactEmail && contactEmail),
            foundPhone: Boolean(!lead.contactPhone && contactPhone),
            foundDecisionMaker: Boolean(!lead.decisionMakerName && decisionMakerName),
            decisionMakerTitle,
            decisionMakerSourceUrl,
          },
        };

        await db
          .update(researchedLeads)
          .set({
            decisionMakerName,
            contactEmail,
            contactPhone,
            contactSourceUrl,
            contactResearchStatus: contactEmail && contactPhone ? 'complete' : foundAny ? 'partial' : lead.contactResearchStatus,
            contactResearchedAt: now,
            enrichment,
          })
          .where(eq(researchedLeads.id, lead.id));

        if (lead.researchCacheKey) {
          await db
            .update(leadResearchCache)
            .set({
              contactResearch: {
                decisionMakerName,
                contactEmail,
                contactPhone,
                contactSourceUrl,
                contactResearchStatus: contactEmail && contactPhone ? 'complete' : foundAny ? 'partial' : lead.contactResearchStatus,
              },
              updatedAt: now,
            })
            .where(eq(leadResearchCache.cacheKey, lead.researchCacheKey));
        }

        console.log(
          `[lead-contact-search] ${lead.companyName}: pages=${urls.length} email=${Boolean(contactEmail)} phone=${Boolean(contactPhone)} decisionMaker=${Boolean(decisionMakerName)} provider=${payload?.cacheHit ? 'cache:' : ''}${payload?.provider ?? 'none'}`,
        );
      }));

      const contactAdds = emailsAdded + phonesAdded;
      if (contactAdds === 0) {
        this.contactSearchZeroYieldStreak += 1;
      } else {
        this.contactSearchZeroYieldStreak = 0;
        this.contactSearchBackoffUntil = 0;
      }

      // Repeated zero-yield scans of a large backlog create noise and burn
      // provider/CPU capacity without improving the prospect pool. Back off
      // progressively after three dry batches, capped at 15 minutes. A later
      // successful batch immediately clears the backoff.
      if (contactAdds === 0 && this.contactSearchZeroYieldStreak >= 3) {
        const exponent = Math.min(4, this.contactSearchZeroYieldStreak - 2);
        const backoffMs = Math.min(
          15 * 60_000,
          Math.max(intervalMs, intervalMs * (2 ** exponent)),
        );
        this.contactSearchBackoffUntil = Date.now() + backoffMs;
      }

      const idleSummaryMs = Math.max(
        5 * 60_000,
        Number(process.env.LEAD_CONTACT_SEARCH_IDLE_SUMMARY_MS ?? 15 * 60_000),
      );
      const shouldLog =
        contactAdds > 0 ||
        decisionMakersAdded > 0 ||
        Date.now() - this.contactSearchLastSummaryAt >= idleSummaryMs;

      if (shouldLog) {
        this.contactSearchLastSummaryAt = Date.now();
        const backoffMinutes = this.contactSearchBackoffUntil > Date.now()
          ? Math.ceil((this.contactSearchBackoffUntil - Date.now()) / 60_000)
          : 0;
        await recordOperatorActivity({
          category: 'contact_recovery',
          agentId: 'apex-campaign-runner',
          message:
            contactAdds > 0 || decisionMakersAdded > 0
              ? `Contact recovery checked ${candidates.length} verified business${candidates.length === 1 ? '' : 'es'}: ` +
                `${emailsAdded} new email${emailsAdded === 1 ? '' : 's'}, ${phonesAdded} new phone number${phonesAdded === 1 ? '' : 's'}, ` +
                `${decisionMakersAdded} sourced decision maker${decisionMakersAdded === 1 ? '' : 's'}; ` +
                `${fullyReachable} now have both email and phone, ${stillIncomplete} still need more contact research.`
              : `Contact recovery checked ${candidates.length} verified businesses and found no new email or phone data. ` +
                `APEX is backing this lane off${backoffMinutes ? ` for about ${backoffMinutes} minute${backoffMinutes === 1 ? '' : 's'}` : ''} instead of repeatedly scanning low-yield records.`,
          data: {
            checked: candidates.length,
            emailsAdded,
            phonesAdded,
            decisionMakersAdded,
            fullyReachable,
            stillIncomplete,
            cacheHits,
            zeroYieldStreak: this.contactSearchZeroYieldStreak,
            backoffUntil: this.contactSearchBackoffUntil || null,
            lane: 'free_cached_web_plus_first_party',
          },
        });
      }
    } finally {
      this.contactSearchRunning = false;
    }
  }

  /**
   * Loading every known website from Postgres once per segment was O(N×M)
   * database work during large campaigns. Keep a short-lived shared cache for
   * the runner and update it as new leads are inserted.
   */
  private async knownDomains(): Promise<Set<string>> {
    const now = Date.now();
    if (this.knownDomainsCache && now - this.knownDomainsRefreshedAt <= 30_000) {
      return this.knownDomainsCache;
    }

    // Six segments can arrive here on the same event-loop turn. Without a
    // shared in-flight promise they each loaded their own Set, defeating the
    // reservation logic and allowing identical domains to be inserted by
    // neighboring shards. One loader, one shared Set.
    if (!this.knownDomainsLoad) {
      this.knownDomainsLoad = getKnownLeadDomains()
        .then((domains) => {
          this.knownDomainsCache = domains;
          this.knownDomainsRefreshedAt = Date.now();
          return domains;
        })
        .finally(() => {
          this.knownDomainsLoad = null;
        });
    }
    return this.knownDomainsLoad;
  }

  /** A runner that dies mid-segment leaves it in_progress forever. Same
   *  lease-expiry pattern the task queue already uses. */
  private async recoverExpiredLeases(): Promise<void> {
    const cutoff = new Date(Date.now() - SEGMENT_LEASE_MS);
    const stale = await db
      .update(campaignSegments)
      .set({ status: 'pending', leasedAt: null })
      .where(
        and(
          eq(campaignSegments.status, 'in_progress'),
          or(isNull(campaignSegments.leasedAt), lt(campaignSegments.leasedAt, cutoff)),
        ),
      )
      .returning({ id: campaignSegments.id });
    if (stale.length > 0) {
      console.warn(`[campaigns] Recovered ${stale.length} segment(s) from an expired lease`);
      void recordOperatorActivity({
        category: 'campaign',
        level: 'warn',
        agentId: 'apex-campaign-runner',
        message: `Recovered ${stale.length} campaign search segment${stale.length === 1 ? '' : 's'} that had been left stuck after a restart or timeout. They were put back in line to run again.`,
        data: { recoveredSegments: stale.length },
      });
    }
  }

  /**
   * Repair campaign rows created before an industry-specific shard mapping
   * existed. Zero-result rows that were incorrectly marked exhausted are
   * re-queued; pending rows are rewritten so the dashboard/database reflect
   * the query the runner will actually execute.
   */
  private async repairLegacyGenericSegments(campaignId: string): Promise<void> {
    if (this.repairedCampaignIds.has(campaignId)) return;

    const candidates = await db
      .select()
      .from(campaignSegments)
      .where(
        and(
          eq(campaignSegments.campaignId, campaignId),
          or(eq(campaignSegments.status, 'pending'), eq(campaignSegments.status, 'exhausted')),
        ),
      )
      .limit(MAX_CAMPAIGN_SEGMENTS);

    let repaired = 0;
    let requeued = 0;
    for (const segment of candidates) {
      const effective = effectiveSegmentSearch(segment);
      if (!effective.repairedLegacyGeneric) continue;
      const wasFalseExhaustion = segment.status === 'exhausted' && (segment.saved ?? 0) === 0;
      await db
        .update(campaignSegments)
        .set({
          subcategory: effective.subcategory,
          query: effective.query,
          ...(wasFalseExhaustion
            ? {
                status: 'pending' as const,
                leasedAt: null,
                completedAt: null,
                lastError: 'Requeued after industry-specific search-shard repair.',
              }
            : {}),
        })
        .where(eq(campaignSegments.id, segment.id));
      repaired++;
      if (wasFalseExhaustion) requeued++;
    }

    if (repaired > 0) {
      console.warn(
        `[campaigns] Repaired ${repaired} legacy generic segment(s) for campaign ${campaignId}; requeued ${requeued} false exhaustion(s)`,
      );
    }
    this.repairedCampaignIds.add(campaignId);
  }

  /** Atomically claim the next pending segment of a running campaign.
   *  The conditional UPDATE is the claim: two runners racing cannot both
   *  match status='pending' on the same row. */
  private async claimSegments(limit: number): Promise<Array<{
    campaign: typeof leadCampaigns.$inferSelect;
    segment: typeof campaignSegments.$inferSelect;
  }>> {
    const [campaign] = await db
      .select()
      .from(leadCampaigns)
      .where(eq(leadCampaigns.status, 'running'))
      .orderBy(asc(leadCampaigns.createdAt))
      .limit(1);
    if (!campaign) return [];

    await this.repairLegacyGenericSegments(campaign.id);

    const nextSegments = await db
      .select()
      .from(campaignSegments)
      .where(and(eq(campaignSegments.campaignId, campaign.id), eq(campaignSegments.status, 'pending')))
      .orderBy(asc(campaignSegments.createdAt))
      .limit(limit);
    if (nextSegments.length === 0) return [];

    const now = new Date();
    const claimed: Array<{
      campaign: typeof leadCampaigns.$inferSelect;
      segment: typeof campaignSegments.$inferSelect;
    }> = [];
    for (const next of nextSegments) {
      const [row] = await db
        .update(campaignSegments)
        .set({
          status: 'in_progress',
          leasedAt: now,
          startedAt: next.startedAt ?? now,
          attempts: (next.attempts ?? 0) + 1,
        })
        .where(and(eq(campaignSegments.id, next.id), eq(campaignSegments.status, 'pending')))
        .returning();
      if (row) claimed.push({ campaign, segment: row });
    }

    return claimed;
  }

  private async runSegment(
    campaign: typeof leadCampaigns.$inferSelect,
    segment: typeof campaignSegments.$inferSelect,
  ): Promise<void> {
    const label = `${segment.industry} / ${segment.city}`;
    const segmentStartedAt = Date.now();
    try {
      const registry = getToolRegistry();
      const config = getLeadPipelineConfig();
      const effectiveSearch = effectiveSegmentSearch(segment);
      const query = effectiveSearch.query;

      const maxResults = Math.min(MAX_PER_SEGMENT, config.maxDirectoryResultsPerShard);
      type DiscoveryCandidate = {
        source: 'directory' | 'web';
        provider: string;
        businesses: DirectoryBusiness[];
        diagnostics: string[];
      };

      const runDirectory = async (): Promise<DiscoveryCandidate> => {
        try {
          const result = await registry.execute('searchBusinessDirectory', { query }, this.toolContext);
          if (!result.success) {
            return {
              source: 'directory',
              provider: 'none',
              businesses: [],
              diagnostics: [result.error ?? 'searchBusinessDirectory failed'],
            };
          }
          const payload = result.data as {
            businesses?: DirectoryBusiness[];
            provider?: string;
            attempts?: string[];
            error?: string;
            cacheHit?: boolean;
            cacheCoalesced?: boolean;
          };
          const baseProvider = payload.provider ?? 'unknown';
          return {
            source: 'directory',
            provider: payload.cacheHit ? `cache:${baseProvider}` : baseProvider,
            businesses: (payload.businesses ?? []).slice(0, maxResults),
            diagnostics: [
              ...(payload.attempts ?? []),
              ...(payload.error ? [payload.error] : []),
            ],
          };
        } catch (err) {
          return {
            source: 'directory',
            provider: 'none',
            businesses: [],
            diagnostics: [err instanceof Error ? err.message : String(err)],
          };
        }
      };

      const runFastWeb = async (): Promise<DiscoveryCandidate> => {
        try {
          const result = await registry.execute(
            'webSearch',
            {
              query: `${query} official business website`,
              maxResults,
              fast: true,
            },
            this.toolContext,
          );
          if (!result.success) {
            return {
              source: 'web',
              provider: 'none',
              businesses: [],
              diagnostics: [result.error ?? 'webSearch failed'],
            };
          }
          const payload = result.data as {
            provider?: string;
            results?: Array<{ title?: string; url?: string; snippet?: string }>;
            diagnostics?: string[];
            suggestion?: string;
            cacheHit?: boolean;
            cacheCoalesced?: boolean;
          };
          const businesses = (payload.results ?? [])
            .map((item) => businessFromWebResult(item, segment.city))
            .filter((item): item is DirectoryBusiness => item !== null)
            .slice(0, maxResults);
          return {
            source: 'web',
            provider: businesses.length > 0 ? `${payload.cacheHit ? 'cache:' : ''}web:${payload.provider ?? 'search'}` : 'none',
            businesses,
            diagnostics: [
              ...(payload.diagnostics ?? []),
              ...(payload.suggestion ? [payload.suggestion] : []),
            ],
          };
        } catch (err) {
          return {
            source: 'web',
            provider: 'none',
            businesses: [],
            diagnostics: [err instanceof Error ? err.message : String(err)],
          };
        }
      };

      // Current production has Tavily/Brave but no Yelp/Google Places. In that
      // shape, start with the fast web source and only pay the slower
      // TomTom/OSM chain when web discovery is empty. This avoids leaving
      // dozens of 20–25 second fallback requests running after Tavily already
      // produced a usable lead set.
      const hasFastWeb = Boolean(process.env.TAVILY_API_KEY || process.env.BRAVE_SEARCH_API_KEY);
      const hasFastStructured = Boolean(process.env.YELP_API_KEY || process.env.GOOGLE_PLACES_API_KEY);

      let first: DiscoveryCandidate;
      let second: DiscoveryCandidate | null = null;

      if (!hasFastWeb && !hasFastStructured) {
        // No paid/keyed fast source exists. Do NOT launch webSearch just to
        // rediscover that Tavily/Brave are unconfigured on every shard; that
        // produces no leads, doubles the work, and can flood Railway logs.
        // searchBusinessDirectory still has the keyless OSM category fallback.
        first = await runDirectory();
      } else if (hasFastWeb && !hasFastStructured) {
        first = await runFastWeb();
        if (first.businesses.length === 0) second = await runDirectory();
      } else if (hasFastStructured && !hasFastWeb) {
        first = await runDirectory();
        if (first.businesses.length === 0) second = await runFastWeb();
      } else {
        // When both fast source families are available, race them. The slower
        // task is only created in this configuration because both are expected
        // to return quickly enough that racing improves latency without a
        // buildup of long-lived OSM fallbacks.
        const directoryTask = runDirectory();
        const webTask = runFastWeb();
        first = await Promise.race([directoryTask, webTask]);
        if (first.businesses.length === 0) {
          second = await (first.source === 'directory' ? webTask : directoryTask);
        }
      }

      const chosen = first.businesses.length > 0 ? first : second;
      if (!chosen || chosen.businesses.length === 0) {
        const reasons = [...first.diagnostics, ...(second?.diagnostics ?? [])].filter(Boolean);
        throw new Error(
          `All lead discovery sources returned zero for "${query}". ${reasons.slice(0, 10).join(' | ') || 'No provider diagnostics were returned.'}`,
        );
      }

      const provider = chosen.provider;
      const raw = chosen.businesses.slice(0, maxResults);

      const found = raw.map(readBusiness).filter((b): b is NonNullable<typeof b> => b !== null);

      // Drop companies already on file before spending enrichment or model
      // work on them. Fresh businesses are inserted immediately as DISCOVERED.
      const known = await this.knownDomains();
      const { fresh, duplicates } = dedupeDiscoveredBusinesses(found, known);

      // Reserve every fresh domain synchronously BEFORE the first insert await.
      // Multiple segment promises run concurrently; adding domains only after
      // each insert allowed two shards from the same city to both decide that
      // the same 15–20 businesses were fresh and insert duplicate batches.
      const reservedDomains = new Map<DirectoryLead, string>();
      for (const business of fresh) {
        const domain = normalizeLeadDomain(business.website);
        if (domain) {
          known.add(domain);
          reservedDomains.set(business, domain);
        }
      }

      let saved = 0;
      for (const business of fresh) {
        try {
          await insertDiscoveredLead({
            companyName: business.companyName,
            website: business.website,
            industry: segment.industry,
            city: business.city || segment.city,
            phone: business.phone,
            source: provider,
            campaignId: campaign.id,
            campaignSegmentId: segment.id,
            researchedByAgentId: this.toolContext.agentId,
            metadata: {
              subcategory: effectiveSearch.subcategory,
              searchIntent: segment.searchIntent,
              query,
              liveDemoMode: config.liveDemoMode,
            },
          });
          saved++;
        } catch (err) {
          // Release the in-process reservation only when the insert failed so a
          // later shard may retry it. Successful rows stay reserved until the
          // short cache refresh confirms them from Postgres.
          const reserved = reservedDomains.get(business);
          if (reserved) known.delete(reserved);
          throw err;
        }
      }

      const now = new Date();
      // 'exhausted' vs 'done': the directory had nothing NEW here, which is a
      // real and different outcome from a segment that produced leads. Coverage
      // counts both; yield only makes sense if they are distinguishable.
      await db
        .update(campaignSegments)
        .set({
          status: saved > 0 ? 'done' : 'exhausted',
          found: found.length,
          saved,
          duplicates,
          leasedAt: null,
          completedAt: now,
          lastError: null,
        })
        .where(eq(campaignSegments.id, segment.id));

      await db
        .update(leadCampaigns)
        .set({ lastProgressAt: now })
        .where(eq(leadCampaigns.id, campaign.id));

      const segmentMs = Date.now() - segmentStartedAt;
      console.log(
        `[campaigns] ${campaign.name} · ${label}: ${found.length} found, ${saved} discovered, ${duplicates} known (${provider}) in ${segmentMs}ms`,
      );
      await recordOperatorActivity({
        category: 'lead_search',
        agentId: 'apex-campaign-runner',
        message:
          saved > 0
            ? `Searched ${segment.industry} in ${segment.city}. Found ${found.length} candidate${found.length === 1 ? '' : 's'}, saved ${saved} new one${saved === 1 ? '' : 's'} for verification, and skipped ${duplicates} already-known result${duplicates === 1 ? '' : 's'}.`
            : `Searched ${segment.industry} in ${segment.city}. Found ${found.length} candidate${found.length === 1 ? '' : 's'}, but none were new enough to save; ${duplicates} were already known or duplicates.`,
        data: {
          campaignId: campaign.id,
          segmentId: segment.id,
          industry: segment.industry,
          city: segment.city,
          found: found.length,
          saved,
          duplicates,
          provider,
          durationMs: segmentMs,
        },
      });
      await this.pruneSaturatedCell(campaign, segment);
      emitApexEvent({
        type: 'campaign:segment',
        campaignId: campaign.id,
        segmentId: segment.id,
        industry: segment.industry,
        city: segment.city,
        status: saved > 0 ? 'done' : 'exhausted',
        saved,
        found: found.length,
      });
      await this.emitProgress(campaign.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = segment.attempts ?? 1;
      // A schema rejection is deterministic: the same producer building the
      // same payload will be rejected identically next tick, so retrying it
      // buys nothing and costs another qualification model call per attempt.
      // Live on 2026-09-21 that was 3x the spend on every city in the
      // territory for a payload that could never be accepted. Retries are for
      // flaky directories and provider outages, not for our own bugs.
      const exhaustedRetries =
        isDeterministicFailure(message) || attempts >= (segment.maxAttempts ?? 3);
      await db
        .update(campaignSegments)
        .set({
          // Retryable until the budget is spent, then terminal. A permanently
          // failing segment must not block the rest of the territory.
          status: exhaustedRetries ? 'failed' : 'pending',
          leasedAt: null,
          lastError: message.slice(0, 500),
          completedAt: exhaustedRetries ? new Date() : null,
        })
        .where(eq(campaignSegments.id, segment.id));
      console.warn(
        `[campaigns] ${campaign.name} · ${label} attempt ${attempts} failed: ${message}` +
          (isDeterministicFailure(message)
            ? ' — not retryable (the payload itself is rejected), segment marked failed'
            : exhaustedRetries
              ? ' — retries exhausted, segment marked failed'
              : ' — will retry'),
      );
      await recordOperatorActivity({
        category: 'lead_search',
        level: 'warn',
        agentId: 'apex-campaign-runner',
        message: exhaustedRetries
          ? `Search for ${segment.industry} in ${segment.city} failed after ${attempts} attempt${attempts === 1 ? '' : 's'} and has been closed for this campaign. Reason: ${message.slice(0, 220)}`
          : `Search for ${segment.industry} in ${segment.city} hit a temporary problem on attempt ${attempts}. APEX will retry it. Reason: ${message.slice(0, 220)}`,
        data: { campaignId: campaign.id, segmentId: segment.id, attempts, exhaustedRetries, error: message.slice(0, 500) },
      });
    }
  }

  /**
   * Once several searches in the same industry/city are mostly returning
   * businesses already on file, stop spending the remaining query variants.
   * This is deliberately conservative so a single weak search never prunes a
   * city: require 4 completed shards, 8+ saved leads, and duplicate-heavy
   * results in at least two of the latest three shards.
   */
  private async pruneSaturatedCell(
    campaign: typeof leadCampaigns.$inferSelect,
    segment: typeof campaignSegments.$inferSelect,
  ): Promise<number> {
    const worked = await db
      .select()
      .from(campaignSegments)
      .where(
        and(
          eq(campaignSegments.campaignId, campaign.id),
          eq(campaignSegments.industry, segment.industry),
          eq(campaignSegments.city, segment.city),
          or(eq(campaignSegments.status, 'done'), eq(campaignSegments.status, 'exhausted')),
        ),
      );

    if (worked.length < 4) return 0;
    const totalSaved = worked.reduce((sum, row) => sum + (row.saved ?? 0), 0);
    if (totalSaved < 8) return 0;

    const recent = [...worked]
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
      .slice(0, 3);
    if (recent.length < 3) return 0;

    const duplicateHeavy = recent.filter((row) =>
      (row.found ?? 0) >= 5 && (row.duplicates ?? 0) / Math.max(1, row.found ?? 0) >= 0.65,
    ).length;
    const zeroNew = recent.filter((row) => (row.saved ?? 0) === 0).length;
    if (duplicateHeavy < 2 || zeroNew < 1) return 0;

    const now = new Date();
    const pruned = await db
      .update(campaignSegments)
      .set({
        status: 'exhausted',
        leasedAt: null,
        completedAt: now,
        lastError: `Pruned after city saturation: ${totalSaved} leads already saved and recent searches were mostly duplicates.`,
      })
      .where(
        and(
          eq(campaignSegments.campaignId, campaign.id),
          eq(campaignSegments.industry, segment.industry),
          eq(campaignSegments.city, segment.city),
          eq(campaignSegments.status, 'pending'),
        ),
      )
      .returning({ id: campaignSegments.id });

    if (pruned.length > 0) {
      console.log(
        `[campaigns] ${campaign.name} · ${segment.industry} / ${segment.city}: pruned ${pruned.length} saturated shard(s) after ${totalSaved} unique leads`,
      );
    }
    return pruned.length;
  }

  /**
   * Write fitReason and outreachAngle for a whole batch in ONE model call.
   *
   * Falls back to a deterministic template when the call fails or comes back
   * unparseable. That fallback is the point: a campaign that degrades to
   * plainer copy is enormously better than one that dies because a free tier
   * ran out of tokens at 07:00.
   */
  private async qualifyBatch(
    campaign: typeof leadCampaigns.$inferSelect,
    segment: typeof campaignSegments.$inferSelect,
    businesses: DirectoryLead[],
  ): Promise<ResearchedLeadInput[]> {
    const base = (b: DirectoryLead) => campaignLeadBase(segment, b);
    const template = (b: DirectoryLead) => templateCopyFor(segment, b);

    try {
      const client = createLLMClient(getDefaultLLMConfig('LEAD_RESEARCH'));
      const system =
        "You qualify outbound leads for BuildMyBot, a white-label AI chatbot and voice-agent platform " +
        "that fixes speed-to-lead for local service businesses. For each business given, write why it " +
        "fits that pain point (missed calls, slow lead response, after-hours gaps) and a first-touch angle. " +
        "Use ONLY the businesses provided. Never invent a company, a website, or a detail not given to you.";
      const user =
        `Segment: ${segment.industry} in ${segment.city}. Campaign: ${campaign.name}.\n\n` +
        `Businesses:\n${JSON.stringify(businesses, null, 2)}\n\n` +
        `Return ONLY a JSON array, one object per business IN THE SAME ORDER, shaped exactly:\n` +
        `{"fitReason": "1-2 sentences tied to a real pain point", "outreachAngle": "one concrete opener"}`;

      const res = await client.complete([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);

      const match = res.content.match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : null;
      if (Array.isArray(parsed)) {
        return businesses.map((b, i) => {
          const p = parsed[i];
          const fallback = template(b);
          return {
            ...base(b),
            fitReason:
              typeof p?.fitReason === 'string' && p.fitReason.trim()
                ? p.fitReason.trim()
                : fallback.fitReason,
            // Per field, not per lead: a model that writes a good reason and
            // drops the angle should keep the reason it wrote.
            outreachAngle:
              typeof p?.outreachAngle === 'string' && p.outreachAngle.trim()
                ? p.outreachAngle.trim()
                : fallback.outreachAngle,
          };
        });
      }
      console.warn('[campaigns] Qualification returned unparseable output — using template copy');
    } catch (err) {
      console.warn(
        `[campaigns] Qualification unavailable (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — using template copy; the hunt continues`,
      );
    }

    return businesses.map((b) => ({ ...base(b), ...template(b) }));
  }

  /** Close campaigns that have hit target or run out of territory.
   *
   *  completed vs completed_short is a real distinction: one found what it was
   *  asked for, the other worked the whole territory and came up under. A
   *  campaign that found 40 of 200 must not report the same state as one that
   *  found all 200. */
  private async closeFinishedCampaigns(): Promise<void> {
    const running = await db
      .select()
      .from(leadCampaigns)
      .where(eq(leadCampaigns.status, 'running'));

    for (const campaign of running) {
      const segments = await db
        .select()
        .from(campaignSegments)
        .where(eq(campaignSegments.campaignId, campaign.id));

      const usableLeadCount = await countUsableCampaignLeads(campaign.id);
      const progress = computeCampaignProgress(campaign, segments, Date.now(), usableLeadCount);
      const hitTarget = progress.leadsSaved >= campaign.targetLeads;
      const territoryWorked = progress.segmentsRemaining === 0;
      if (!hitTarget && !territoryWorked) continue;

      const status = hitTarget ? 'completed' : 'completed_short';
      const result = hitTarget
        ? `Target met: ${progress.leadsSaved} leads from ${progress.segmentsDone} of ${progress.segmentsTotal} segments.`
        : `Territory fully worked and came up short: ${progress.leadsSaved} of ${campaign.targetLeads} leads ` +
          `across ${progress.segmentsTotal} segments (${progress.segmentsFailed} failed, ` +
          `${progress.duplicatesSkipped} already on file). Widen the cities or industries to find more.`;

      await db
        .update(leadCampaigns)
        .set({ status, completedAt: new Date(), result })
        .where(and(eq(leadCampaigns.id, campaign.id), eq(leadCampaigns.status, 'running')));

      // Leftover pending segments stop the runner re-claiming a closed
      // campaign's territory on the next tick.
      if (hitTarget) {
        await db
          .update(campaignSegments)
          .set({ status: 'cancelled' })
          .where(and(eq(campaignSegments.campaignId, campaign.id), eq(campaignSegments.status, 'pending')));
      }

      console.log(`[campaigns] ${campaign.name} -> ${status}. ${result}`);
      await recordOperatorActivity({
        category: 'campaign',
        agentId: 'apex-campaign-runner',
        message: hitTarget
          ? `Campaign "${campaign.name}" reached its target with ${progress.leadsSaved} verified, contact-ready prospect${progress.leadsSaved === 1 ? '' : 's'}.`
          : `Campaign "${campaign.name}" finished the available territory with ${progress.leadsSaved} verified, contact-ready prospect${progress.leadsSaved === 1 ? '' : 's'} out of the ${campaign.targetLeads} requested. The remaining search area did not produce enough usable businesses.`,
        data: {
          campaignId: campaign.id,
          status,
          leadsSaved: progress.leadsSaved,
          targetLeads: campaign.targetLeads,
          segmentsDone: progress.segmentsDone,
          segmentsTotal: progress.segmentsTotal,
        },
      });
      emitApexEvent({
        type: 'campaign:completed',
        campaignId: campaign.id,
        status,
        leadsSaved: progress.leadsSaved,
        targetLeads: campaign.targetLeads,
      });
    }
  }

  private async emitProgress(campaignId: string): Promise<void> {
    const [campaign] = await db.select().from(leadCampaigns).where(eq(leadCampaigns.id, campaignId)).limit(1);
    if (!campaign) return;
    const segments = await db.select().from(campaignSegments).where(eq(campaignSegments.campaignId, campaignId));
    const usableLeadCount = await countUsableCampaignLeads(campaignId);
    const progress = computeCampaignProgress(campaign, segments, Date.now(), usableLeadCount);
    emitApexEvent({
      type: 'campaign:progress',
      campaignId,
      leadsSaved: progress.leadsSaved,
      targetLeads: progress.targetLeads,
      segmentsDone: progress.segmentsDone,
      segmentsTotal: progress.segmentsTotal,
    });
  }
}

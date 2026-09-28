import { randomUUID } from 'crypto';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
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
    segmentBatchSize: Number(process.env.LEAD_SEGMENT_BATCH_SIZE ?? (liveDemoMode ? 8 : 3)),
    maxDirectoryResultsPerShard: Number(process.env.LEAD_DIRECTORY_RESULTS_PER_SHARD ?? (liveDemoMode ? 12 : 25)),
    leaseMs: Number(process.env.LEAD_PIPELINE_LEASE_MS ?? 2 * 60 * 1000),
    initialQualificationMaxWords: Number(process.env.LEAD_INITIAL_QUALIFICATION_WORDS ?? (liveDemoMode ? 28 : 55)),
  };
}

export function subcategoriesForIndustry(industry: string): string[] {
  const normalized = normalizeIndustry(industry)?.toLowerCase() ?? industry.toLowerCase();
  for (const [key, values] of Object.entries(SERVICE_SUBCATEGORIES)) {
    if (normalized.includes(key)) return values;
  }
  return SERVICE_SUBCATEGORIES.default;
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
    contactResearchStatus?: 'partial' | 'complete' | 'unavailable';
  } | null;

  const cachedCampaignDraft = cached?.campaignDraft as Record<string, unknown> | null;
  const readyFromCache = Boolean(cachedCampaignDraft);
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
    or(isNull(researchedLeads.pipelineLeaseExpiresAt), lt(researchedLeads.pipelineLeaseExpiresAt, now)),
  ];
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
  const update = buildStageUpdate(next, lead, cached);
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

  await upsertResearchCache(cacheKey, lead, next, update);
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
      contactResearchStatus?: 'partial' | 'complete' | 'unavailable';
    } | null;
    const hasContact = Boolean(lead.contactEmail || lead.contactPhone || cachedContact?.contactEmail || cachedContact?.contactPhone);
    return {
      decisionMakerName: lead.decisionMakerName ?? cachedContact?.decisionMakerName,
      contactEmail: lead.contactEmail ?? cachedContact?.contactEmail,
      contactPhone: lead.contactPhone ?? cachedContact?.contactPhone,
      contactSourceUrl: lead.contactSourceUrl ?? cachedContact?.contactSourceUrl,
      contactResearchStatus: cachedContact?.contactResearchStatus ?? (hasContact ? 'partial' : 'unavailable'),
      contactResearchedAt: new Date(),
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
  let score = 45;
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

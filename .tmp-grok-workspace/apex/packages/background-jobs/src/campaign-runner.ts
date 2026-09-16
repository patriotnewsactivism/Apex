import { randomUUID } from 'crypto';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import {
  db,
  campaignSegments,
  leadCampaigns,
  researchedLeads,
} from '@workspace/db';
import {
  createLLMClient,
  emitApexEvent,
  getDefaultLLMConfig,
  getToolRegistry,
  normalizeIndustry,
  type ToolContext,
} from '@workspace/core';

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
): CampaignProgress {
  const done = segments.filter((s) => s.status === 'done' || s.status === 'exhausted');
  const failed = segments.filter((s) => s.status === 'failed');
  const leadsSaved = segments.reduce((n, s) => n + (s.saved ?? 0), 0);
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

export interface CreateCampaignInput {
  name: string;
  industries: string[];
  cities: string[];
  targetLeads?: number;
  goalId?: string;
  projectId?: string;
  pushToBuildmybot?: boolean;
  createdByAgentId?: string;
  notes?: string;
}

/** Hard ceiling on territory size. 20 industries x 50 cities would enqueue
 *  1,000 segments and a day of directory calls from one careless tool call. */
const MAX_SEGMENTS = 200;

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
  const cities = [...new Set(input.cities.map((c) => c.trim()).filter(Boolean))];

  if (industries.length === 0) throw new Error('At least one industry is required.');
  if (cities.length === 0) throw new Error('At least one city is required.');

  const cells: Array<{ industry: string; city: string }> = [];
  for (const industry of industries) {
    for (const city of cities) cells.push({ industry, city });
  }
  if (cells.length > MAX_SEGMENTS) {
    throw new Error(
      `That territory is ${cells.length} segments (${industries.length} industries x ${cities.length} cities); ` +
        `the ceiling is ${MAX_SEGMENTS}. Split it into several campaigns.`,
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

  await db.insert(campaignSegments).values(
    cells.map((cell) => ({
      id: randomUUID(),
      campaignId,
      industry: cell.industry,
      city: cell.city,
      status: 'pending',
      createdAt: now,
    })),
  );

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
function readBusiness(b: DirectoryBusiness): {
  companyName: string;
  website?: string;
  industry?: string;
  city?: string;
} | null {
  const companyName = (b.name ?? b.n ?? '').trim();
  if (!companyName) return null;
  const website = (b.website ?? b.w ?? '').trim() || undefined;
  return {
    companyName,
    website,
    industry: (b.industry ?? b.i ?? '').trim() || undefined,
    city: (b.city ?? b.c ?? '').trim() || undefined,
  };
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

export class CampaignRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly toolContext: ToolContext;

  constructor(private readonly intervalMs = 30_000) {
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
    console.log(`[campaigns] Runner started (every ${Math.round(this.intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: recover expired leases, then work a single segment. Single
   *  segment per tick deliberately — it bounds directory API burst and keeps
   *  each tick's failure blast radius to one cell. */
  async tick(): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      await this.recoverExpiredLeases();
      const claimed = await this.claimSegment();
      if (!claimed) {
        await this.closeFinishedCampaigns();
        return;
      }
      await this.runSegment(claimed.campaign, claimed.segment);
      await this.closeFinishedCampaigns();
    } finally {
      this.running = false;
    }
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
    }
  }

  /** Atomically claim the next pending segment of a running campaign.
   *  The conditional UPDATE is the claim: two runners racing cannot both
   *  match status='pending' on the same row. */
  private async claimSegment(): Promise<{
    campaign: typeof leadCampaigns.$inferSelect;
    segment: typeof campaignSegments.$inferSelect;
  } | null> {
    const [campaign] = await db
      .select()
      .from(leadCampaigns)
      .where(eq(leadCampaigns.status, 'running'))
      .orderBy(asc(leadCampaigns.createdAt))
      .limit(1);
    if (!campaign) return null;

    const [next] = await db
      .select()
      .from(campaignSegments)
      .where(and(eq(campaignSegments.campaignId, campaign.id), eq(campaignSegments.status, 'pending')))
      .orderBy(asc(campaignSegments.createdAt))
      .limit(1);
    if (!next) return null;

    const now = new Date();
    const [claimed] = await db
      .update(campaignSegments)
      .set({
        status: 'in_progress',
        leasedAt: now,
        startedAt: next.startedAt ?? now,
        attempts: (next.attempts ?? 0) + 1,
      })
      .where(and(eq(campaignSegments.id, next.id), eq(campaignSegments.status, 'pending')))
      .returning();
    if (!claimed) return null; // lost the race — another runner took it

    return { campaign, segment: claimed };
  }

  private async runSegment(
    campaign: typeof leadCampaigns.$inferSelect,
    segment: typeof campaignSegments.$inferSelect,
  ): Promise<void> {
    const label = `${segment.industry} / ${segment.city}`;
    try {
      const registry = getToolRegistry();
      const query = `${segment.industry} ${segment.city}`;

      const result = await registry.execute('searchBusinessDirectory', { query }, this.toolContext);
      if (!result.success) throw new Error(result.error ?? 'searchBusinessDirectory failed');

      const payload = result.data as { businesses?: DirectoryBusiness[]; provider?: string };
      const raw = (payload.businesses ?? []).slice(0, MAX_PER_SEGMENT);
      const found = raw.map(readBusiness).filter((b): b is NonNullable<typeof b> => b !== null);

      // Drop companies already on file before spending a model call on them.
      const known = await this.knownDomains();
      const fresh = found.filter((b) => {
        const d = domainOf(b.website);
        return d === null ? true : !known.has(d);
      });
      const duplicates = found.length - fresh.length;

      let saved = 0;
      if (fresh.length > 0) {
        const qualified = await this.qualifyBatch(campaign, segment, fresh);
        const save = await registry.execute(
          'saveResearchedLeadsBatch',
          { leads: qualified, campaignId: campaign.id },
          this.toolContext,
        );
        if (!save.success) throw new Error(save.error ?? 'saveResearchedLeadsBatch failed');
        const stats = save.data as { saved?: number; duplicates?: number };
        saved = stats.saved ?? 0;
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

      console.log(
        `[campaigns] ${campaign.name} · ${label}: ${found.length} found, ${saved} saved, ${duplicates} known (${payload.provider ?? 'unknown'})`,
      );
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
      const exhaustedRetries = attempts >= (segment.maxAttempts ?? 3);
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
          (exhaustedRetries ? ' — retries exhausted, segment marked failed' : ' — will retry'),
      );
    }
  }

  /** Every website already on file, as bare domains. Read per segment rather
   *  than cached for the runner's lifetime: agents and other campaigns write
   *  to this table concurrently, and a stale set means duplicate work. */
  private async knownDomains(): Promise<Set<string>> {
    const rows = await db
      .select({ website: researchedLeads.website })
      .from(researchedLeads);
    const set = new Set<string>();
    for (const r of rows) {
      const d = domainOf(r.website ?? undefined);
      if (d) set.add(d);
    }
    return set;
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
    businesses: Array<{ companyName: string; website?: string; industry?: string; city?: string }>,
  ): Promise<Array<{
    companyName: string;
    website?: string;
    industry?: string;
    city?: string;
    fitReason: string;
    outreachAngle?: string;
  }>> {
    const template = (b: { companyName: string }) => ({
      fitReason:
        `${segment.industry} business in ${segment.city} — BuildMyBot's ICP for speed-to-lead: ` +
        `missed inbound calls, slow first response, and no after-hours coverage. ` +
        `Not yet individually qualified (${b.companyName} was captured from a directory search).`,
      outreachAngle: undefined as string | undefined,
    });

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
            ...b,
            industry: segment.industry,
            city: b.city || segment.city,
            fitReason:
              typeof p?.fitReason === 'string' && p.fitReason.trim()
                ? p.fitReason.trim()
                : fallback.fitReason,
            outreachAngle:
              typeof p?.outreachAngle === 'string' && p.outreachAngle.trim()
                ? p.outreachAngle.trim()
                : undefined,
          };
        });
      }
      console.warn('[campaigns] Qualification returned unparseable output — using template copy');
    } catch (err) {
      console.warn(
        `[campaigns] Qualification unavailable (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — using template copy; the hunt continues`,
      );
    }

    return businesses.map((b) => ({
      ...b,
      industry: segment.industry,
      city: b.city || segment.city,
      ...template(b),
    }));
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

      const progress = computeCampaignProgress(campaign, segments);
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
    const progress = computeCampaignProgress(campaign, segments);
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

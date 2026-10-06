// ─── Lead search capacity ─────────────────────────────────────────────────────
//
// Decides whether a failed campaign search failed because of the search, or
// because every search source APEX pays for was unavailable at that moment.
//
// The difference matters. On 2026-10-03 a keyed search source behind
// BuildMyBot's proxy hit its usage limit at 20:34 UTC. That proxy was the only
// working search source, so every search after it came back empty. The runner
// treated each empty search as the segment's own failure and closed 799 "US
// News" searches across 73 cities in 13 minutes. None were retried after the
// outage ended, because nothing marked them as waiting.
//
// A provider outage is not a property of a segment. The runner now hands the
// attempt back, puts the segment back in line, and pauses claiming with a
// doubling backoff until a provider answers again. See campaign-runner.ts.

const DISCOVERY_ZERO_PREFIX = 'All lead discovery sources returned zero';

/** Sources APEX holds a key for, directly or through the BuildMyBot proxy.
 *  Their failures mean lost capacity. Keyless fallbacks (OSM, DuckDuckGo) are
 *  best-effort and often fail for one query only, so they never pause search:
 *  one slow city must not stall the whole territory. */
const KEYED_SOURCES = new Set(['brave', 'yelp', 'google', 'tomtom', 'serper', 'brightdata']);

const BREAKER_REASON = 'paused after an earlier failure';

/** Provider wording for an account with no credit left, whatever HTTP status
 *  carries it. Kept in step with isOutOfCreditBody in core/tool-registry.ts. */
const OUT_OF_CREDIT_TEXT =
  /not enough credits|insufficient (?:credits?|balance|funds)|credit balance is insufficient|out of credits|quota (?:exceeded|exhausted)|exceeds your plan'?s set usage limit/i;

export type DiscoverySourceState =
  /** No key, or deliberately skipped. */
  | 'unconfigured'
  /** Quota, rate limit, out of credits, 5xx, timeout, rejected key, open breaker. */
  | 'unavailable'
  /** The provider answered and had nothing. */
  | 'answered_empty'
  /** A bad request, a keyless fallback detail, or anything unrecognised. */
  | 'other';

export interface DiscoverySourceNote {
  source: string;
  keyed: boolean;
  state: DiscoverySourceState;
  /** Plain-language reason for an unavailable source, e.g. "plan usage limit (HTTP 432)". */
  reason: string | null;
}

export interface UnavailableSource {
  source: string;
  reason: string | null;
}

export interface LeadDiscoveryFailure {
  /** The runner's "All lead discovery sources returned zero" error. */
  discoveryZero: boolean;
  /** At least one keyed source was unavailable and none of them answered. */
  providerOutage: boolean;
  unavailable: UnavailableSource[];
}

function reasonForStatus(status: number): string | null {
  if (status === 429) return 'rate limited (HTTP 429)';
  if (status === 432) return 'plan usage limit reached (HTTP 432)';
  if (status === 433) return 'pay-as-you-go limit reached (HTTP 433)';
  if (status === 402) return 'out of credits (HTTP 402)';
  if (status === 401 || status === 403) return `rejected the key (HTTP ${status})`;
  if (status === 408) return 'timed out (HTTP 408)';
  if (status >= 500) return `provider error (HTTP ${status})`;
  return null;
}

function classifyNote(detail: string): Pick<DiscoverySourceNote, 'state' | 'reason'> {
  if (/\bnot set\b|configured but secret missing|skipped by freeOnly mode/i.test(detail)) {
    return { state: 'unconfigured', reason: null };
  }
  if (/circuit breaker/i.test(detail)) {
    return { state: 'unavailable', reason: BREAKER_REASON };
  }
  const http = /^HTTP (\d{3})\b/.exec(detail);
  if (http) {
    // A proxy may answer 502 while naming the upstream's real status in the
    // body; the upstream status is the one that says what happened.
    const upstream = /\bHTTP (\d{3})\b/.exec(detail.slice(http[0].length));
    const status = upstream ? Number(upstream[1]) : Number(http[1]);
    // Serper reports an exhausted account as HTTP 400 {"message":"Not enough
    // credits"}. On 2026-10-05 that read as "other", the segment was judged a
    // deterministic failure, and 27 News Directors / Women-Owned Ad Agencies
    // segments were closed after one attempt instead of waiting for capacity.
    const reason = reasonForStatus(status)
      ?? reasonForStatus(Number(http[1]))
      ?? (OUT_OF_CREDIT_TEXT.test(detail) ? `out of credits (HTTP ${http[1]})` : null);
    return reason ? { state: 'unavailable', reason } : { state: 'other', reason: null };
  }
  if (/200 but zero results|returned nothing|^0 results\b/i.test(detail)) {
    return { state: 'answered_empty', reason: null };
  }
  if (/timed? ?out|aborted|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(detail)) {
    return { state: 'unavailable', reason: 'did not respond' };
  }
  return { state: 'other', reason: null };
}

/** The error a segment fails with when no source produced a business. `notes`
 *  are the diagnostics webSearch and searchBusinessDirectory return, written
 *  as "<source>: <detail>". parseDiscoveryNotes reads them back. */
export function discoveryZeroMessage(query: string, notes: string[]): string {
  const kept = notes.filter(Boolean).slice(0, 10);
  return `${DISCOVERY_ZERO_PREFIX} for "${query}". ${kept.join(' | ') || 'No provider diagnostics were returned.'}`;
}

/** Split the runner's discovery error back into per-source notes. */
export function parseDiscoveryNotes(message: string): DiscoverySourceNote[] {
  if (!message.startsWith(DISCOVERY_ZERO_PREFIX)) return [];
  const afterQuery = message.indexOf('". ');
  const body = afterQuery >= 0 ? message.slice(afterQuery + 3) : message.slice(DISCOVERY_ZERO_PREFIX.length);
  const notes: DiscoverySourceNote[] = [];
  for (const fragment of body.split(' | ')) {
    // Summary sentences ("Every search provider failed…", "No business
    // directory API returned results…") carry no source prefix and are skipped.
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*([\s\S]*)$/.exec(fragment.trim());
    if (!match) continue;
    const source = match[1].toLowerCase();
    notes.push({ source, keyed: KEYED_SOURCES.has(source), ...classifyNote(match[2]) });
  }
  return notes;
}

export function classifyLeadDiscoveryFailure(message: string): LeadDiscoveryFailure {
  const keyed = parseDiscoveryNotes(message).filter((note) => note.keyed);
  const unavailable = keyed.filter((note) => note.state === 'unavailable');
  // A keyed source that answered with nothing is a real answer. If one did,
  // the empty result is honest even while another source is down.
  const answered = keyed.some((note) => note.state === 'answered_empty');
  return {
    discoveryZero: message.startsWith(DISCOVERY_ZERO_PREFIX),
    providerOutage: unavailable.length > 0 && !answered,
    unavailable: unavailable.map(({ source, reason }) => ({ source, reason })),
  };
}

export function describeUnavailableSources(unavailable: UnavailableSource[]): string {
  if (unavailable.length === 0) return 'no search source answered';
  const seen = new Map<string, string | null>();
  for (const item of unavailable) if (!seen.has(item.source)) seen.set(item.source, item.reason);
  return [...seen].map(([source, reason]) => (reason ? `${source}: ${reason}` : source)).join('; ');
}

// ─── Pause state ──────────────────────────────────────────────────────────────

/** First wait after an outage. Doubles on every outage that follows a single
 *  test search, up to the cap. */
export const LEAD_SEARCH_PAUSE_BASE_MS = 2 * 60 * 1000;
export const LEAD_SEARCH_PAUSE_MAX_MS = 60 * 60 * 1000;

export interface LeadSearchPauseSnapshot {
  /** True while waiting; false while the single test search is due or running. */
  paused: boolean;
  resumeAt: string;
  since: string;
  /** Consecutive pauses without any source answering. */
  pauses: number;
  unavailable: UnavailableSource[];
  summary: string;
}

/**
 * Process-local, like the webSearch circuit breaker. A restart forgets the
 * pause, so the first tick after a deploy can send one normal batch into a
 * still-down provider. Each of those segments is handed back, not failed,
 * and the pause starts again.
 */
export class LeadSearchCapacityPause {
  private pausedUntil = 0;
  private pauses = 0;
  private since: number | null = null;
  private unavailable: UnavailableSource[] = [];

  constructor(
    private readonly baseMs = LEAD_SEARCH_PAUSE_BASE_MS,
    private readonly maxMs = LEAD_SEARCH_PAUSE_MAX_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  isPaused(now = this.clock()): boolean {
    return now < this.pausedUntil;
  }

  /** Segments the next tick may claim: none while paused, then exactly one
   *  test search until a source answers, then the normal batch. */
  claimLimit(normal: number, now = this.clock()): number {
    if (this.isPaused(now)) return 0;
    return this.pauses > 0 ? Math.min(1, normal) : normal;
  }

  /** Every keyed source was unavailable for one segment. Starts a pause unless
   *  one is already running, so segments that were in flight together do not
   *  stack waits or repeat the announcement. */
  recordOutage(
    unavailable: UnavailableSource[],
    now = this.clock(),
  ): { started: boolean; resumeAt: number; waitMs: number; pauses: number } {
    this.mergeUnavailable(unavailable);
    if (this.isPaused(now)) {
      return { started: false, resumeAt: this.pausedUntil, waitMs: this.pausedUntil - now, pauses: this.pauses };
    }
    const waitMs = Math.min(this.maxMs, this.baseMs * 2 ** this.pauses);
    this.pauses += 1;
    this.since ??= now;
    this.pausedUntil = now + waitMs;
    return { started: true, resumeAt: this.pausedUntil, waitMs, pauses: this.pauses };
  }

  /** Keep the most specific reason seen for each source. Once webSearch's
   *  circuit breaker opens, later searches only report that it was skipped,
   *  which would hide the "plan usage limit" that caused it. */
  private mergeUnavailable(unavailable: UnavailableSource[]): void {
    for (const item of unavailable) {
      const known = this.unavailable.find((entry) => entry.source === item.source);
      if (!known) this.unavailable.push({ ...item });
      else if (item.reason && (!known.reason || known.reason === BREAKER_REASON)) known.reason = item.reason;
    }
  }

  /** A source answered: results, an honest empty, or a failure that is not
   *  about capacity. Ends any pause. */
  recordAnswer(now = this.clock()): { resumed: boolean; outageMs: number } {
    if (this.pauses === 0) return { resumed: false, outageMs: 0 };
    const outageMs = Math.max(0, now - (this.since ?? now));
    this.pausedUntil = 0;
    this.pauses = 0;
    this.since = null;
    this.unavailable = [];
    return { resumed: true, outageMs };
  }

  snapshot(now = this.clock()): LeadSearchPauseSnapshot | null {
    if (this.pauses === 0) return null;
    return {
      paused: this.isPaused(now),
      resumeAt: new Date(Math.max(this.pausedUntil, now)).toISOString(),
      since: new Date(this.since ?? now).toISOString(),
      pauses: this.pauses,
      unavailable: [...this.unavailable],
      summary: describeUnavailableSources(this.unavailable),
    };
  }
}

/** The runner and the campaigns API share this instance. They run in the same
 *  process (runtime-bootstrap.ts), which is how the dashboard can show why a
 *  campaign is waiting instead of calling it stalled. */
export const leadSearchCapacityPause = new LeadSearchCapacityPause();

export function getLeadSearchPauseSnapshot(): LeadSearchPauseSnapshot | null {
  return leadSearchCapacityPause.snapshot();
}

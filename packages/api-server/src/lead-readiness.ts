/**
 * Lead data sets and the contact-ready gate, shared by GET /api/leads/stats,
 * GET /api/leads?set=… and the name-finder queue.
 *
 * Two separate sets (Matthew, 2026-10-03 3:38 PM CT):
 *
 *   contact_ready  verified business, validated contact, no geo mismatch, AND a
 *                  named decision maker that cleared the verification bar:
 *                  decisionMakerSearch.outcome = found with a name, a title, a
 *                  recorded sourceUrl and verifiedBy ∈ first_party |
 *                  corroborated | company_direct.
 *   needs_name     the same, except no verified name could be located
 *                  (outcome cant_locate, or a found outcome that does not meet
 *                  the bar). These feed the name-finder queue.
 *
 * APEX_LEADS_CANT_LOCATE_COUNTS_READY (default false) is kept only as an
 * explicit override; with it unset needs-name leads never count as ready.
 *
 * legacy contact-ready (before 2026-10-03), still reported for comparison:
 *   not rejected AND (email OR phone) AND businessVerification verified
 */

export interface ReadinessLead {
  status: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  enrichment: Record<string, unknown> | null;
}

export type ReadinessBucket =
  | 'rejected'
  | 'unverified_or_no_contact'
  | 'contact_unvalidated'
  | 'geo_mismatch'
  | 'decision_maker_pending'
  | 'needs_name'
  | 'contact_ready';

export type LeadDataSet = 'contact_ready' | 'needs_name';

export interface ReadinessOptions { cantLocateCountsReady: boolean }

export function cantLocateCountsReadyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APEX_LEADS_CANT_LOCATE_COUNTS_READY === 'true' || env.APEX_LEADS_CANT_LOCATE_COUNTS_READY === '1';
}

export function isLegacyContactReady(lead: ReadinessLead): boolean {
  if (lead.status === 'rejected') return false;
  if (!lead.contactEmail && !lead.contactPhone) return false;
  const verification = lead.enrichment?.['businessVerification'] as { status?: string } | undefined;
  return verification?.status === 'verified';
}

interface FoundOutcomeShape {
  status?: string;
  name?: string;
  title?: string;
  sourceUrl?: string;
  verifiedBy?: string;
}

const VERIFIED_BY = new Set(['first_party', 'corroborated', 'company_direct']);

/** A found outcome only counts when it carries the evidence the bar requires. */
export function isVerifiedFoundOutcome(outcome: FoundOutcomeShape | undefined | null): boolean {
  return Boolean(
    outcome
    && outcome.status === 'found'
    && typeof outcome.name === 'string' && outcome.name.trim().length > 0
    && typeof outcome.title === 'string' && outcome.title.trim().length > 0
    && typeof outcome.sourceUrl === 'string' && outcome.sourceUrl.trim().length > 0
    && typeof outcome.verifiedBy === 'string' && VERIFIED_BY.has(outcome.verifiedBy),
  );
}

export function decisionMakerStatus(lead: ReadinessLead): 'found' | 'cant_locate' | 'pending' {
  const search = lead.enrichment?.['decisionMakerSearch'] as { outcome?: FoundOutcomeShape } | undefined;
  const outcome = search?.outcome;
  if (isVerifiedFoundOutcome(outcome)) return 'found';
  // A "found" without evidence (older ladder rows, hand edits) is a candidate, not a name.
  if (outcome?.status === 'found' || outcome?.status === 'cant_locate') return 'cant_locate';
  return 'pending';
}

export function hasGeoMismatch(lead: ReadinessLead): boolean {
  const check = lead.enrichment?.['locationCheck'] as { geoMismatch?: boolean } | undefined;
  return check?.geoMismatch === true;
}

export function readinessBucket(lead: ReadinessLead): Exclude<ReadinessBucket, 'contact_ready'> | 'dm_found' {
  if (lead.status === 'rejected') return 'rejected';
  if (!isLegacyContactReady(lead)) return 'unverified_or_no_contact';
  const validation = lead.enrichment?.['contactValidation'] as { validated?: boolean } | undefined;
  if (validation?.validated !== true) return 'contact_unvalidated';
  if (hasGeoMismatch(lead)) return 'geo_mismatch';
  const dm = decisionMakerStatus(lead);
  if (dm === 'found') return 'dm_found';
  if (dm === 'cant_locate') return 'needs_name';
  return 'decision_maker_pending';
}

/** Which of the two data sets a lead belongs to, if either. */
export function leadDataSet(lead: ReadinessLead): LeadDataSet | null {
  const bucket = readinessBucket(lead);
  if (bucket === 'dm_found') return 'contact_ready';
  if (bucket === 'needs_name') return 'needs_name';
  return null;
}

export function isContactReady(lead: ReadinessLead, options: ReadinessOptions): boolean {
  const bucket = readinessBucket(lead);
  return bucket === 'dm_found' || (bucket === 'needs_name' && options.cantLocateCountsReady);
}

export interface NameFinderCounts {
  total: number;
  byStatus: Record<string, number>;
  awaitingApproval: number;
}

export interface ReadinessStats {
  contactReady: number;
  needsName: number;
  legacyContactReady: number;
  cantLocateCountsReady: boolean;
  buckets: Record<ReadinessBucket, number>;
  nameFinder: NameFinderCounts;
  /** contact-ready leads whose name came from the name-finder queue, by source. */
  promotedBySource: Record<string, number>;
}

export function computeReadinessStats(leads: ReadinessLead[], options: ReadinessOptions): ReadinessStats {
  const buckets: Record<ReadinessBucket, number> = {
    rejected: 0,
    unverified_or_no_contact: 0,
    contact_unvalidated: 0,
    geo_mismatch: 0,
    decision_maker_pending: 0,
    needs_name: 0,
    contact_ready: 0,
  };
  const nameFinder: NameFinderCounts = { total: 0, byStatus: {}, awaitingApproval: 0 };
  const promotedBySource: Record<string, number> = {};
  let legacy = 0;
  let ready = 0;
  for (const lead of leads) {
    if (isLegacyContactReady(lead)) legacy++;
    const bucket = readinessBucket(lead);
    const nf = lead.enrichment?.['nameFinder'] as { status?: string; actions?: Array<{ status?: string }> } | undefined;
    if (nf?.status) {
      nameFinder.total++;
      nameFinder.byStatus[nf.status] = (nameFinder.byStatus[nf.status] ?? 0) + 1;
      if ((nf.actions ?? []).some((a) => a.status === 'awaiting_approval')) nameFinder.awaitingApproval++;
    }
    if (bucket === 'dm_found') {
      buckets.contact_ready++;
      ready++;
      const source = (lead.enrichment?.['decisionMakerSearch'] as { outcome?: { source?: string } } | undefined)?.outcome?.source;
      if (source && source !== 'ladder') promotedBySource[source] = (promotedBySource[source] ?? 0) + 1;
      continue;
    }
    buckets[bucket]++;
    if (bucket === 'needs_name' && options.cantLocateCountsReady) ready++;
  }
  return {
    contactReady: ready,
    needsName: buckets.needs_name,
    legacyContactReady: legacy,
    cantLocateCountsReady: options.cantLocateCountsReady,
    buckets,
    nameFinder,
    promotedBySource,
  };
}

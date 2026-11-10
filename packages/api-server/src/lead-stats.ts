import { sql } from 'drizzle-orm';
import type { db as Db } from '@workspace/db';
import { usableQualifiedLeadSql } from '@workspace/background-jobs/usable-campaign-leads';

/**
 * Expressions used for uniqueCompanies / uniqueDomains.
 *
 * These are byte-for-byte the same normalizers as the optional expression
 * indexes in lib/db/drizzle/20261006_lead_dedupe_indexes.sql and as
 * findExistingLeadDuplicate in packages/background-jobs/src/lead-pipeline.ts.
 * If those indexes have been applied, Postgres can use them; if not, the
 * counts still run as aggregates over ~240k rows in a single pass with the
 * other totals (see computeLeadStats). Empty normalized values are excluded
 * via nullif(..., '') so a missing website does not count as a domain.
 */
export const NORMALIZED_COMPANY_SQL = sql`nullif(lower(regexp_replace(company_name, '[^a-zA-Z0-9]', '', 'g')), '')`;
export const NORMALIZED_DOMAIN_SQL = sql`nullif(lower(regexp_replace(regexp_replace(coalesce(website, ''), '^[a-zA-Z]+://', ''), '^www\.|[/?#:].*$', '', 'g')), '')`;

export interface LeadStats {
  /**
   * @deprecated Ambiguous alias of contactReady, kept so existing clients
   * do not break. Do not treat this as rawCandidates, uniqueCompanies, or
   * usableQualified. Prefer the explicit field names below.
   */
  total: number;
  /** Contact-ready leads: not rejected, has an email or phone, website identity verified. */
  contactReady: number;
  /** Every researched_leads row, whatever its state. */
  rawCandidates: number;
  /** Distinct normalized company names across all raw rows (empty names excluded). */
  uniqueCompanies: number;
  /** Distinct normalized website domains across all raw rows (empty domains excluded). */
  uniqueDomains: number;
  pendingOrUnverified: number;
  rejected: number;
  /**
   * Leads that satisfy the campaign runner's countUsableCampaignLeads
   * predicates (any campaign). Uses the same SQL fragment, not a copy.
   */
  usableQualified: number;
  byStatus: { new: number; contacted: number; qualified: number; rejected: number };
  byPipelineState: Record<string, number>;
  byIndustry: Record<string, number>;
}

/**
 * The contact-ready definition behind GET /api/leads/stats, expressed in SQL.
 *
 * This reproduces the JavaScript the route used to run over every loaded row, so
 * the numbers do not change:
 *   - `!lead.contactEmail && !lead.contactPhone` treats null AND '' as missing,
 *     hence coalesce(x, '') <> '' rather than IS NOT NULL;
 *   - the verification status is read the same way the route read it, from
 *     enrichment.businessVerification.status.
 * The cheap predicates come first so the planner only opens the (TOASTed)
 * enrichment document for rows that could still qualify.
 */
const VISIBLE = sql`
  status <> 'rejected'
  AND (coalesce(contact_email, '') <> '' OR coalesce(contact_phone, '') <> '')
  AND enrichment -> 'businessVerification' ->> 'status' = 'verified'
`;

const rowsOf = <T>(result: unknown): T[] => result as T[];

/**
 * Summary counts over researched_leads, computed in the database.
 *
 * The route used to `select *` every lead, jsonb columns included, into Node and
 * count in JavaScript. On a table in the hundreds of thousands of rows that is
 * minutes of work and a large heap spike; the aggregate queries return a few
 * hundred bytes. uniqueCompanies / uniqueDomains / usableQualified are added
 * to the existing totals query so they do not introduce a second table scan.
 */
export async function computeLeadStats(db: typeof Db): Promise<LeadStats> {
  const [totals, industries, pipelineStates] = await Promise.all([
    db.execute(sql`
      SELECT
        count(*)::int AS raw,
        count(*) FILTER (WHERE status = 'new')::int AS s_new,
        count(*) FILTER (WHERE status = 'contacted')::int AS s_contacted,
        count(*) FILTER (WHERE status = 'qualified')::int AS s_qualified,
        count(*) FILTER (WHERE status = 'rejected')::int AS s_rejected,
        count(*) FILTER (WHERE ${VISIBLE})::int AS visible,
        count(*) FILTER (WHERE ${usableQualifiedLeadSql})::int AS usable_qualified,
        count(distinct ${NORMALIZED_COMPANY_SQL})::int AS unique_companies,
        count(distinct ${NORMALIZED_DOMAIN_SQL})::int AS unique_domains
      FROM researched_leads
    `),
    db.execute(sql`
      SELECT coalesce(nullif(industry, ''), 'Unknown') AS key, count(*)::int AS n
      FROM researched_leads
      WHERE ${VISIBLE}
      GROUP BY 1
    `),
    db.execute(sql`
      SELECT coalesce(pipeline_state, 'DISCOVERED') AS key, count(*)::int AS n
      FROM researched_leads
      WHERE ${VISIBLE}
      GROUP BY 1
    `),
  ]);

  const t = rowsOf<{
    raw: number;
    s_new: number;
    s_contacted: number;
    s_qualified: number;
    s_rejected: number;
    visible: number;
    usable_qualified: number;
    unique_companies: number;
    unique_domains: number;
  }>(totals)[0] ?? {
    raw: 0,
    s_new: 0,
    s_contacted: 0,
    s_qualified: 0,
    s_rejected: 0,
    visible: 0,
    usable_qualified: 0,
    unique_companies: 0,
    unique_domains: 0,
  };

  const toMap = (result: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const row of rowsOf<{ key: string; n: number }>(result)) out[row.key] = Number(row.n);
    return out;
  };

  return {
    // Deprecated alias — same value as contactReady, not rawCandidates.
    total: t.visible,
    contactReady: t.visible,
    rawCandidates: t.raw,
    uniqueCompanies: t.unique_companies,
    uniqueDomains: t.unique_domains,
    pendingOrUnverified: Math.max(0, t.raw - t.visible - t.s_rejected),
    rejected: t.s_rejected,
    usableQualified: t.usable_qualified,
    byStatus: { new: t.s_new, contacted: t.s_contacted, qualified: t.s_qualified, rejected: t.s_rejected },
    byPipelineState: toMap(pipelineStates),
    byIndustry: toMap(industries),
  };
}

/** Explicit inventory fields. None of these is named just "total". */
export const EXPLICIT_LEAD_STAT_FIELDS = [
  'rawCandidates',
  'uniqueCompanies',
  'uniqueDomains',
  'contactReady',
  'pendingOrUnverified',
  'rejected',
  'usableQualified',
] as const;

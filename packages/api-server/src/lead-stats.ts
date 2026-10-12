import { sql } from 'drizzle-orm';
import type { db as Db } from '@workspace/db';

export interface LeadStats {
  /** Contact-ready leads: not rejected, has an email or phone, website identity verified. */
  total: number;
  contactReady: number;
  /** Every row, whatever its state. */
  rawCandidates: number;
  pendingOrUnverified: number;
  rejected: number;
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
 * minutes of work and a large heap spike; three aggregate queries return a few
 * hundred bytes.
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
        count(*) FILTER (WHERE ${VISIBLE})::int AS visible
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
  }>(totals)[0] ?? { raw: 0, s_new: 0, s_contacted: 0, s_qualified: 0, s_rejected: 0, visible: 0 };

  const toMap = (result: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const row of rowsOf<{ key: string; n: number }>(result)) out[row.key] = Number(row.n);
    return out;
  };

  return {
    total: t.visible,
    contactReady: t.visible,
    rawCandidates: t.raw,
    pendingOrUnverified: Math.max(0, t.raw - t.visible - t.s_rejected),
    rejected: t.s_rejected,
    byStatus: { new: t.s_new, contacted: t.s_contacted, qualified: t.s_qualified, rejected: t.s_rejected },
    byPipelineState: toMap(pipelineStates),
    byIndustry: toMap(industries),
  };
}

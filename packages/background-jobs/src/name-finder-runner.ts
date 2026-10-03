/**
 * Database side of the name-finder queue: picks NEEDS-NAME leads whose
 * automatic research step is due, re-runs the decision-maker ladder for every
 * role with a larger budget, and writes the result. Email/call asks are only
 * queued (awaiting_approval); nothing here sends anything.
 *
 * Kill switch: APEX_NAME_FINDER_ENABLED=false stops the automatic research.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { db, researchedLeads } from '@workspace/db';
import { loadOutboundPolicy } from '@workspace/core';
import { DECISION_MAKER_ROLES } from './lead-quality/people.js';
import { normalizeLeadDomain, makeResearchCacheKey } from './lead-pipeline.js';
import { defaultLadderDeps, runDecisionMakerLadder } from './decision-maker-ladder.js';
import { PostgresDomainResearchStore } from './domain-research-store.js';
import { applyResearchResult, isResearchDue, readNameFinderState, type PromotionResult } from './name-finder.js';

export function nameFinderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APEX_NAME_FINDER_ENABLED !== 'false';
}

/** SQL filter for the needs-name set (mirrors lead-readiness.ts). */
export const needsNameWhere = and(
  ne(researchedLeads.status, 'rejected'),
  sql`${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'`,
  sql`(${researchedLeads.enrichment}->'contactValidation'->>'validated')::boolean is true`,
  sql`coalesce((${researchedLeads.enrichment}->'locationCheck'->>'geoMismatch')::boolean, false) = false`,
  sql`${researchedLeads.enrichment}->'decisionMakerSearch'->'outcome'->>'status' = 'cant_locate'`,
);

export async function processNameFinderQueue(limit = 4, now = new Date()): Promise<{ researched: number; promoted: number; queuedAsks: number }> {
  if (!nameFinderEnabled()) return { researched: 0, promoted: 0, queuedAsks: 0 };
  const rows = await db.select().from(researchedLeads).where(needsNameWhere).limit(Math.max(limit * 5, 20));
  const due = rows.filter((row) => isResearchDue(readNameFinderState(row), now)).slice(0, limit);
  const policy = await loadOutboundPolicy(now);
  let promoted = 0;
  let queuedAsks = 0;
  for (const lead of due) {
    const domain = normalizeLeadDomain(lead.website);
    if (!domain) continue;
    let result: PromotionResult;
    try {
      const { search } = await runDecisionMakerLadder(
        {
          companyName: lead.companyName,
          website: lead.website,
          industry: lead.industry,
          city: lead.city,
          cacheKey: lead.researchCacheKey ?? makeResearchCacheKey(lead),
          domain,
        },
        [...DECISION_MAKER_ROLES],
        new PostgresDomainResearchStore(),
        defaultLadderDeps({ maxFetchesPerRun: Number(process.env.APEX_NAME_FINDER_MAX_FETCHES ?? 20) }),
      );
      result = applyResearchResult(lead, search, policy, now);
    } catch (err) {
      console.warn('[name-finder] research failed:', err instanceof Error ? err.message : String(err));
      continue;
    }
    const before = readNameFinderState(lead)?.actions.length ?? 0;
    const after = (result.enrichment['nameFinder'] as { actions?: unknown[] } | undefined)?.actions?.length ?? 0;
    queuedAsks += Math.max(0, after - before);
    if (result.promoted) promoted++;
    await db
      .update(researchedLeads)
      .set({
        enrichment: result.enrichment,
        ...(result.promoted ? { decisionMakerName: result.decisionMakerName, title: result.title } : {}),
      })
      .where(eq(researchedLeads.id, lead.id));
  }
  return { researched: due.length, promoted, queuedAsks };
}

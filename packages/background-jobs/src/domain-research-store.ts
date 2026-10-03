/**
 * Postgres-backed DomainResearchStore over lead_research_cache's ladder
 * columns. Reads select only the columns they need so the rest of the row is
 * untouched, and writes upsert only the research columns.
 */
import { eq, sql } from 'drizzle-orm';
import { db, leadResearchCache } from '@workspace/db';
import {
  emptyDomainResearch,
  type DomainResearch,
  type DomainResearchStore,
  type LadderStepRecord,
  type PageRecord,
  type SearchRecord,
} from './decision-maker-ladder.js';
import type { PersonRecord } from './lead-quality/people.js';

export function researchFromRow(
  domain: string,
  row: {
    fetchedPages: unknown;
    people: unknown;
    searchResults: unknown;
    ladderSteps: unknown;
    layerStats: unknown;
    researchUpdatedAt: Date | null;
  } | undefined,
): DomainResearch {
  const base = emptyDomainResearch(domain);
  if (!row) return base;
  const stats = (row.layerStats ?? {}) as Partial<DomainResearch['layerStats']>;
  return {
    ...base,
    pages: (row.fetchedPages ?? {}) as Record<string, PageRecord>,
    people: Array.isArray(row.people) ? (row.people as PersonRecord[]) : [],
    searches: (row.searchResults ?? {}) as Record<string, SearchRecord>,
    ladderSteps: (row.ladderSteps ?? {}) as Record<string, LadderStepRecord>,
    layerStats: {
      pages: { hits: stats.pages?.hits ?? 0, misses: stats.pages?.misses ?? 0 },
      people: { hits: stats.people?.hits ?? 0, misses: stats.people?.misses ?? 0 },
      search: { hits: stats.search?.hits ?? 0, misses: stats.search?.misses ?? 0 },
    },
    updatedAt: row.researchUpdatedAt?.toISOString() ?? base.updatedAt,
  };
}

export class PostgresDomainResearchStore implements DomainResearchStore {
  constructor(private readonly options: { readOnly?: boolean } = {}) {}

  async load(cacheKey: string, domain: string): Promise<DomainResearch> {
    const [row] = await db
      .select({
        fetchedPages: leadResearchCache.fetchedPages,
        people: leadResearchCache.people,
        searchResults: leadResearchCache.searchResults,
        ladderSteps: leadResearchCache.ladderSteps,
        layerStats: leadResearchCache.layerStats,
        researchUpdatedAt: leadResearchCache.researchUpdatedAt,
      })
      .from(leadResearchCache)
      .where(eq(leadResearchCache.cacheKey, cacheKey))
      .limit(1);
    return researchFromRow(domain, row);
  }

  async save(cacheKey: string, research: DomainResearch): Promise<void> {
    if (this.options.readOnly) return;
    const now = new Date();
    const columns = {
      fetchedPages: research.pages as Record<string, unknown>,
      people: research.people as unknown as Array<Record<string, unknown>>,
      searchResults: research.searches as Record<string, unknown>,
      ladderSteps: research.ladderSteps as Record<string, unknown>,
      layerStats: research.layerStats as unknown as Record<string, unknown>,
      researchUpdatedAt: now,
    };
    await db
      .insert(leadResearchCache)
      .values({ cacheKey, normalizedDomain: research.domain, ...columns, hitCount: 0, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: leadResearchCache.cacheKey, set: { ...columns, updatedAt: sql`now()` } });
  }
}

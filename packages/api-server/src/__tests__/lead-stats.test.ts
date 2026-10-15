/**
 * GET /api/leads/stats counts in the database instead of loading every lead.
 *
 * The route used to `select *` all of researched_leads (jsonb columns included)
 * into Node and count in JavaScript. On a table of several hundred thousand rows
 * that took ~2 minutes and the browser gave up. These tests pin two things:
 *
 *   1. the numbers did not change: the SQL aggregate is compared against the
 *      ORIGINAL JavaScript (kept below as the reference) over the same table,
 *      plus seeded edge cases whose expected counts are written out by hand;
 *   2. the route cannot quietly go back to loading the whole table.
 *
 * Suite 1 needs no database. Suite 2 writes rows, so it is gated on a safe test
 * database exactly like lead-write-path.test.ts and skips otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inArray } from 'drizzle-orm';

const HERE = fileURLToPath(import.meta.url);
const routeSource = readFileSync(resolve(HERE, '../../routes/leads.ts'), 'utf8');

function isSafeTestDatabase(url: string | undefined): boolean {
  const raw = url?.trim();
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const testDb = /_test$|^test_|^apex_test/.test(dbName);
  return local || testDb;
}
const suite = isSafeTestDatabase(process.env.DATABASE_URL) ? describe : describe.skip;

describe('lead stats — route contract (no database)', () => {
  const handler = (() => {
    const start = routeSource.indexOf("router.get('/stats'");
    expect(start, "the /stats route must exist").toBeGreaterThan(-1);
    const rest = routeSource.slice(start);
    const end = rest.indexOf('\n  });');
    return rest.slice(0, end);
  })();

  it('does not load the whole table into memory', () => {
    expect(handler, 'a full-table select in /stats is what took ~2 minutes in production').not.toMatch(
      /from\(researchedLeads\)/,
    );
    expect(handler).not.toMatch(/db\.select\(\)/);
  });

  it('counts through computeLeadStats', () => {
    expect(handler).toMatch(/computeLeadStats\(/);
  });
});

type LeadRow = {
  status: string;
  industry: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  pipelineState: string | null;
  enrichment: unknown;
};

/** The route's original computation, verbatim, over already-loaded rows. */
function referenceStats(all: LeadRow[]) {
  const byStatus = {
    new: all.filter((l) => l.status === 'new').length,
    contacted: all.filter((l) => l.status === 'contacted').length,
    qualified: all.filter((l) => l.status === 'qualified').length,
    rejected: all.filter((l) => l.status === 'rejected').length,
  };
  const visible = all.filter((lead) => {
    if (lead.status === 'rejected') return false;
    if (!lead.contactEmail && !lead.contactPhone) return false;
    const verification = (lead.enrichment as Record<string, unknown> | null)?.['businessVerification'] as
      | { status?: string }
      | undefined;
    return verification?.status === 'verified';
  });
  const byPipelineState: Record<string, number> = {};
  const byIndustry: Record<string, number> = {};
  for (const l of visible) {
    const key = l.industry || 'Unknown';
    byIndustry[key] = (byIndustry[key] ?? 0) + 1;
    byPipelineState[l.pipelineState ?? 'DISCOVERED'] = (byPipelineState[l.pipelineState ?? 'DISCOVERED'] ?? 0) + 1;
  }
  return {
    total: visible.length,
    contactReady: visible.length,
    rawCandidates: all.length,
    pendingOrUnverified: Math.max(0, all.length - visible.length - byStatus.rejected),
    rejected: byStatus.rejected,
    byStatus,
    byPipelineState,
    byIndustry,
  };
}

suite('lead stats (researched_leads aggregates)', () => {
  let db: typeof import('@workspace/db').db;
  let researchedLeads: typeof import('@workspace/db').researchedLeads;
  let computeLeadStats: typeof import('../lead-stats.js').computeLeadStats;
  const seededIds: string[] = [];

  const tag = randomUUID().slice(0, 8);
  const INDUSTRY_A = `stats-test-${tag}-A`;
  const INDUSTRY_B = `stats-test-${tag}-B`;
  const verified = { businessVerification: { status: 'verified' } };

  beforeAll(async () => {
    ({ db, researchedLeads } = await import('@workspace/db'));
    ({ computeLeadStats } = await import('../lead-stats.js'));
  });

  afterAll(async () => {
    if (seededIds.length) await db.delete(researchedLeads).where(inArray(researchedLeads.id, seededIds));
  });

  const loadAll = async (): Promise<LeadRow[]> => (await db.select().from(researchedLeads)) as unknown as LeadRow[];

  async function seed(rows: Array<Partial<LeadRow> & { industry?: string | null }>) {
    const values = rows.map((row, i) => {
      const id = `stats-${tag}-${i}`;
      seededIds.push(id);
      return {
        id,
        companyName: `Stats Test ${tag} ${i}`,
        fitReason: 'lead-stats test row',
        researchedByAgentId: 'lead-stats-test',
        status: row.status ?? 'new',
        industry: row.industry ?? null,
        contactEmail: row.contactEmail ?? null,
        contactPhone: row.contactPhone ?? null,
        ...(row.pipelineState ? { pipelineState: row.pipelineState } : {}),
        enrichment: (row.enrichment ?? null) as Record<string, unknown> | null,
      };
    });
    await db.insert(researchedLeads).values(values);
  }

  it('matches the original JavaScript computation over the whole table, edge cases included', async () => {
    const before = await computeLeadStats(db);

    await seed([
      /* 0 */ { industry: INDUSTRY_A, contactEmail: 'a@x.test', enrichment: verified, pipelineState: 'CONTACT_FOUND' },
      /* 1 */ { industry: INDUSTRY_A, contactPhone: '+15125550101', enrichment: verified },
      /* 2 — empty-string email and no phone: JS treats '' as missing */
      { industry: INDUSTRY_A, contactEmail: '', enrichment: verified },
      /* 3 — whitespace is truthy in JS, so it counts as a contact */
      { industry: INDUSTRY_A, contactEmail: '  ', enrichment: verified },
      /* 4 — rejected never counts as contact-ready */
      { status: 'rejected', industry: INDUSTRY_A, contactEmail: 'r@x.test', enrichment: verified },
      /* 5 — not verified */
      { industry: INDUSTRY_A, contactEmail: 'u@x.test', enrichment: { businessVerification: { status: 'unverified' } } },
      /* 6 — no enrichment at all */
      { industry: INDUSTRY_A, contactEmail: 'n@x.test', enrichment: null },
      /* 7 — enrichment without a verification block */
      { industry: INDUSTRY_A, contactEmail: 'e@x.test', enrichment: {} },
      /* 8 — null industry buckets as Unknown */
      { industry: null, contactEmail: 'k1@x.test', enrichment: verified },
      /* 9 — empty industry buckets as Unknown too */
      { industry: '', contactEmail: 'k2@x.test', enrichment: verified },
      /* 10 — a numeric status is not 'verified' */
      { industry: INDUSTRY_A, contactEmail: 'num@x.test', enrichment: { businessVerification: { status: 1 } } },
      /* 11 */ { status: 'contacted', industry: INDUSTRY_B, contactEmail: 'c@x.test', enrichment: verified },
      /* 12 */ { status: 'qualified', industry: INDUSTRY_B, contactPhone: '+15125550102', enrichment: verified, pipelineState: 'QUALIFIED' },
      /* 13 — a status outside the four counted ones is still contact-ready */
      { status: 'pushed_to_buildmybot', industry: INDUSTRY_B, contactEmail: 'p@x.test', enrichment: verified },
    ]);

    const after = await computeLeadStats(db);
    const expected = referenceStats(await loadAll());

    // 1. Identical to the original computation over everything in the table.
    expect(after).toEqual(expected);

    // 2. Hand-written expectations for the seeded rows.
    expect(after.rawCandidates - before.rawCandidates, '14 rows seeded').toBe(14);
    expect(after.byIndustry[INDUSTRY_A], 'rows 0, 1 and 3 only').toBe(3);
    expect(after.byIndustry[INDUSTRY_B], 'rows 11, 12 and 13').toBe(3);
    expect((after.byIndustry['Unknown'] ?? 0) - (before.byIndustry['Unknown'] ?? 0), 'null and empty industry').toBe(2);
    expect(after.rejected - before.rejected).toBe(1);
    expect(after.byStatus.contacted - before.byStatus.contacted).toBe(1);
    expect(after.byStatus.qualified - before.byStatus.qualified).toBe(1);
    expect(after.total - before.total, 'contact-ready added: 0,1,3,8,9,11,12,13').toBe(8);
    expect(after.contactReady).toBe(after.total);
    expect((after.byPipelineState['CONTACT_FOUND'] ?? 0) - (before.byPipelineState['CONTACT_FOUND'] ?? 0)).toBe(1);
    expect((after.byPipelineState['QUALIFIED'] ?? 0) - (before.byPipelineState['QUALIFIED'] ?? 0)).toBe(1);
  });

  it('serves the same numbers over HTTP', async () => {
    const { createLeadsRouter } = await import('../routes/leads.js');
    const app = express();
    app.use('/api/leads', createLeadsRouter());
    const server: Server = createServer(app);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/leads/stats`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(await computeLeadStats(db));
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

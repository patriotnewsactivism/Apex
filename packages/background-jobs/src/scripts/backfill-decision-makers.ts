/**
 * Backfill: contact validation + decision-maker ladder for existing leads.
 *
 * NOT run automatically. Dry-run is the default and is read-only against the
 * database (it reads leads and lead_research_cache, writes nothing; only a
 * local cursor file and optional JSONL report are written to disk).
 *
 *   # read-only preview of 50 leads
 *   node packages/core/node_modules/tsx/dist/cli.mjs packages/background-jobs/src/scripts/backfill-decision-makers.ts --dry-run --limit 50
 *
 *   # write results (requires explicit --commit), resumable
 *   node packages/core/node_modules/tsx/dist/cli.mjs packages/background-jobs/src/scripts/backfill-decision-makers.ts --commit \
 *     --batch-size 100 --concurrency 4 --per-domain-delay-ms 1500 --role auto
 *
 * Options:
 *   --dry-run                 read-only (default)
 *   --commit                  persist enrichment.contactValidation/decisionMakerSearch + cache
 *   --limit N                 stop after N leads (default: all)
 *   --batch-size N            leads read per DB page (default 100)
 *   --concurrency N           leads processed in parallel (default 4)
 *   --role R[,R]              owner_executive|marketing|editorial|sales|auto (default auto = by industry)
 *   --per-domain-delay-ms N   minimum spacing between requests to one host (default 1500)
 *   --max-fetches N           page fetch budget per lead per run (default 12)
 *   --no-mx                   skip MX/A lookups
 *   --cursor-file PATH        resume position (default .backfill-dm-cursor[.dry-run].json)
 *   --reset-cursor            start from the oldest lead
 *   --out PATH                write one JSON line per lead
 *
 * Zero LLM calls. Web search uses only providers that are configured
 * (TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / APEX_DM_LADDER_DDG_ENABLED=true);
 * Hunter only when HUNTER_API_KEY is set.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { db, researchedLeads } from '@workspace/db';
import {
  createHttpFetcher,
  defaultLadderDeps,
  defaultRolesForIndustry,
  DECISION_MAKER_ROLES,
  emptyDomainResearch,
  runDecisionMakerLadder,
  type DecisionMakerRole,
  type DomainResearch,
  type DomainResearchStore,
} from '../decision-maker-ladder.js';
import { PostgresDomainResearchStore } from '../domain-research-store.js';
import { validateLeadContacts } from '../lead-quality/contact-validation.js';
import { makeResearchCacheKey, normalizeLeadDomain } from '../lead-pipeline.js';

interface Args {
  commit: boolean;
  limit: number;
  batchSize: number;
  concurrency: number;
  roles: DecisionMakerRole[] | 'auto';
  perDomainDelayMs: number;
  maxFetches: number;
  mx: boolean;
  cursorFile: string;
  resetCursor: boolean;
  out: string | null;
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${name}=`))?.split('=').slice(1).join('=');
  };
  const has = (name: string) => argv.includes(name);
  const commit = has('--commit') && !has('--dry-run');
  const roleArg = get('--role') ?? 'auto';
  const roles = roleArg === 'auto'
    ? 'auto'
    : roleArg.split(',').map((r) => r.trim()).filter((r): r is DecisionMakerRole => (DECISION_MAKER_ROLES as readonly string[]).includes(r));
  if (roles !== 'auto' && roles.length === 0) throw new Error(`--role must be auto or one of ${DECISION_MAKER_ROLES.join(',')}`);
  const num = (name: string, fallback: number) => {
    const v = get(name);
    const n = v === undefined ? fallback : Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  return {
    commit,
    limit: num('--limit', Number.POSITIVE_INFINITY),
    batchSize: Math.max(1, Math.min(1000, num('--batch-size', 100))),
    concurrency: Math.max(1, Math.min(32, num('--concurrency', 4))),
    roles,
    perDomainDelayMs: num('--per-domain-delay-ms', 1500),
    maxFetches: Math.max(1, num('--max-fetches', 12)),
    mx: !has('--no-mx'),
    cursorFile: get('--cursor-file') ?? (commit ? '.backfill-dm-cursor.json' : '.backfill-dm-cursor.dry-run.json'),
    resetCursor: has('--reset-cursor'),
    out: get('--out') ?? null,
  };
}

interface Cursor { createdAt: string; id: string; processed: number; updatedAt: string }

/** Dry-run store: reads Postgres, keeps writes in memory only (shared across leads of one domain). */
class ReadThroughMemoryStore implements DomainResearchStore {
  private readonly memory = new Map<string, DomainResearch>();
  private readonly pg = new PostgresDomainResearchStore({ readOnly: true });
  async load(cacheKey: string, domain: string): Promise<DomainResearch> {
    const hit = this.memory.get(cacheKey);
    if (hit) return structuredClone(hit);
    try { return await this.pg.load(cacheKey, domain); } catch { return emptyDomainResearch(domain); }
  }
  async save(cacheKey: string, research: DomainResearch): Promise<void> {
    this.memory.set(cacheKey, structuredClone(research));
  }
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[dm-backfill] mode=${args.commit ? 'COMMIT (writes)' : 'dry-run (read-only)'} limit=${args.limit} batch=${args.batchSize} concurrency=${args.concurrency} roles=${Array.isArray(args.roles) ? args.roles.join(',') : 'auto'} perDomainDelayMs=${args.perDomainDelayMs}`);

  let cursor: Cursor | null = null;
  if (!args.resetCursor && existsSync(args.cursorFile)) {
    cursor = JSON.parse(readFileSync(args.cursorFile, 'utf8')) as Cursor;
    console.log(`[dm-backfill] resuming after ${cursor.createdAt} / ${cursor.id} (${cursor.processed} done)`);
  }

  const store: DomainResearchStore = args.commit ? new PostgresDomainResearchStore() : new ReadThroughMemoryStore();
  const deps = defaultLadderDeps({
    fetchPage: createHttpFetcher({ perDomainDelayMs: args.perDomainDelayMs }),
    maxFetchesPerRun: args.maxFetches,
  });

  const totals: Record<string, number> = { processed: 0, found: 0, cant_locate: 0, pending_retry: 0, contactValidated: 0, contactInvalid: 0, errors: 0 };
  let processed = cursor?.processed ?? 0;
  let seen = 0;

  while (seen < args.limit) {
    const conditions = [
      sql`${researchedLeads.status} <> 'rejected'`,
      sql`${researchedLeads.website} IS NOT NULL`,
      sql`${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'`,
    ];
    if (cursor) {
      const at = new Date(cursor.createdAt);
      conditions.push(or(gt(researchedLeads.createdAt, at), and(eq(researchedLeads.createdAt, at), gt(researchedLeads.id, cursor.id)))!);
    }
    const take = Math.min(args.batchSize, args.limit - seen);
    const rows = await db
      .select({
        id: researchedLeads.id,
        companyName: researchedLeads.companyName,
        website: researchedLeads.website,
        industry: researchedLeads.industry,
        city: researchedLeads.city,
        contactEmail: researchedLeads.contactEmail,
        contactPhone: researchedLeads.contactPhone,
        decisionMakerName: researchedLeads.decisionMakerName,
        title: researchedLeads.title,
        enrichment: researchedLeads.enrichment,
        researchCacheKey: researchedLeads.researchCacheKey,
        createdAt: researchedLeads.createdAt,
      })
      .from(researchedLeads)
      .where(and(...conditions))
      .orderBy(asc(researchedLeads.createdAt), asc(researchedLeads.id))
      .limit(take);
    if (rows.length === 0) break;

    await pool(rows, args.concurrency, async (lead) => {
      try {
        const domain = normalizeLeadDomain(lead.website);
        if (!domain) return;
        const cacheKey = lead.researchCacheKey ?? makeResearchCacheKey({ companyName: lead.companyName, website: lead.website, city: lead.city });
        const verification = (lead.enrichment?.['businessVerification'] ?? {}) as { decisionMakerName?: string | null; decisionMakerTitle?: string | null; decisionMakerSourceUrl?: string | null };
        const contactValidation = await validateLeadContacts({ email: lead.contactEmail, phone: lead.contactPhone, city: lead.city, checkMx: args.mx });
        const roles = args.roles === 'auto' ? defaultRolesForIndustry(lead.industry) : args.roles;
        const { search } = await runDecisionMakerLadder(
          {
            companyName: lead.companyName, website: lead.website, industry: lead.industry, city: lead.city, cacheKey, domain,
            structuredScrape: { name: verification.decisionMakerName ?? null, title: verification.decisionMakerTitle ?? null, sourceUrl: verification.decisionMakerSourceUrl ?? null },
          },
          roles,
          store,
          deps,
        );
        totals.processed++;
        totals[search.outcome.status] = (totals[search.outcome.status] ?? 0) + 1;
        if (contactValidation.validated) totals.contactValidated++; else totals.contactInvalid++;

        if (args.commit) {
          const found = search.outcome.status === 'found' ? search.outcome : null;
          const email = contactValidation.email;
          const phone = contactValidation.phone;
          await db.update(researchedLeads).set({
            enrichment: { ...(lead.enrichment ?? {}), contactValidation, decisionMakerSearch: search },
            ...(found && !lead.decisionMakerName ? { decisionMakerName: found.name, title: found.title } : {}),
            ...(email && email.status !== 'valid' && email.status !== 'dns_error' ? { contactEmail: null } : {}),
            ...(phone ? { contactPhone: phone.status === 'valid' || phone.status === 'international' ? phone.e164 : null } : {}),
          }).where(eq(researchedLeads.id, lead.id));
        }
        if (args.out) {
          appendFileSync(args.out, `${JSON.stringify({
            id: lead.id, companyName: lead.companyName, domain, roles,
            outcome: search.outcome, steps: search.stepsTried.map((s) => `${s.step}:${s.status}${s.fromCache ? '(cached)' : ''}`),
            contact: { validated: contactValidation.validated, flags: contactValidation.flags, email: contactValidation.email?.status ?? null, phone: contactValidation.phone?.status ?? null },
          })}\n`);
        }
      } catch (err) {
        totals.errors++;
        console.warn(`[dm-backfill] ${lead.id} failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      }
    });

    seen += rows.length;
    processed += rows.length;
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAt.toISOString(), id: last.id, processed, updatedAt: new Date().toISOString() };
    writeFileSync(args.cursorFile, JSON.stringify(cursor, null, 2));
    console.log(`[dm-backfill] batch done: ${rows.length} leads; totals ${JSON.stringify(totals)}`);
    if (rows.length < take) break;
  }

  console.log(`[dm-backfill] finished (${args.commit ? 'COMMIT' : 'dry-run'}): ${JSON.stringify(totals)}`);
  process.exit(0);
}

if (process.argv[1] && /backfill-decision-makers\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('[dm-backfill] fatal', err);
    process.exit(1);
  });
}

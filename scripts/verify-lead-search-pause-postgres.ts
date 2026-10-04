/**
 * Guard: the real CampaignRunner pauses lead search on a provider outage,
 * against a real Postgres.
 *
 * verify-lead-search-capacity-pause.ts checks the decisions. This checks the
 * wiring: the runner claims nothing while paused, sends one test search after
 * the wait, writes segments back as pending with the attempt handed back,
 * records one activity line per pause, and resumes when a source answers.
 *
 * webSearch and searchBusinessDirectory are replaced with stubs that return
 * the 2026-10-03 production diagnostics, then real results. The pause runs on
 * a fake clock, so nothing here depends on how fast the machine is.
 *
 * Needs LEAD_SEARCH_TEST_DATABASE_URL pointing at a throwaway local database
 * named lead_search_test*. It runs migrate() and writes campaigns and logs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail, null, 2).slice(0, 900)}`);
}

function assertLocalTestDatabase(target: string): void {
  if (process.env.RAILWAY_ENVIRONMENT) throw new Error('Refusing to run lead search verification on Railway');
  const url = new URL(target);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !url.pathname.startsWith('/lead_search_test')) {
    throw new Error('Refusing a non-local or non-test database. Use lead_search_test on localhost.');
  }
}

const PROXY_432 =
  'buildmybot-tavily: HTTP 502 {"error":"Tavily search failed with HTTP 432","detail":"{\\"detail\\":{\\"error\\":\\"This request exceeds your plan\'s set usage limit. Please upgrade your plan or contact support@tavily.com\\"}}"}';

async function main(): Promise<void> {
  const target = process.env.LEAD_SEARCH_TEST_DATABASE_URL;
  if (!target) {
    if (process.env.CI) throw new Error('CI must set LEAD_SEARCH_TEST_DATABASE_URL');
    console.log('Set LEAD_SEARCH_TEST_DATABASE_URL to a local lead_search_test database to run this check.');
    return;
  }
  assertLocalTestDatabase(target);
  process.env.DATABASE_URL = target;
  // The production shape on 2026-10-03: no direct search keys, BuildMyBot's
  // Tavily proxy configured, OSM as the keyless fallback.
  for (const key of ['TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'YELP_API_KEY', 'GOOGLE_PLACES_API_KEY', 'TOMTOM_API_KEY']) {
    delete process.env[key];
  }
  process.env.BUILDMYBOT_TAVILY_PROXY_URL = 'https://proxy.example.test/search';
  process.env.BUILDMYBOT_TAVILY_PROXY_SECRET = 'guard-only-not-a-secret';
  process.env.LEAD_IDENTITY_REPAIR_BATCH = '0';
  // The persistent search cache would answer a re-run's "outage" searches with
  // the previous run's results and never reach the stubs.
  process.env.LEAD_SEARCH_CACHE_ENABLED = 'false';
  delete process.env.LIVE_DEMO_MODE;
  delete process.env.LEAD_SEGMENT_BATCH_SIZE;

  console.log('Verifying the campaign runner pauses lead search on a provider outage (Postgres)...\n');

  const dbMod = (await import(path.join(root, 'lib/db/src/index.ts'))) as typeof import('../lib/db/src/index.js');
  const { eq, sql } = await import(path.join(root, 'lib/db/node_modules/drizzle-orm/index.js'));
  const core = (await import(path.join(root, 'packages/core/src/index.ts'))) as typeof import('../packages/core/src/index.js');
  const runnerMod = (await import(
    path.join(root, 'packages/background-jobs/src/campaign-runner.ts')
  )) as typeof import('../packages/background-jobs/src/campaign-runner.js');
  const capacity = (await import(
    path.join(root, 'packages/background-jobs/src/lead-search-capacity.ts')
  )) as typeof import('../packages/background-jobs/src/lead-search-capacity.js');
  const { db, campaignSegments, leadCampaigns, logs } = dbMod;

  await dbMod.migrate();
  // The runner works the oldest running campaign. On a re-run, that would be
  // the previous run's; this is a throwaway test database, so retire it.
  await db.update(leadCampaigns).set({ status: 'cancelled' }).where(eq(leadCampaigns.status, 'running'));

  let mode: 'outage' | 'recovered' = 'outage';
  // Unique per run, so a re-run's businesses are new rather than "already known".
  const runId = Date.now().toString(36);
  let webCalls = 0;
  const passThrough = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
  const registry = core.getToolRegistry();
  registry.register({
    name: 'webSearch',
    description: 'guard stub',
    schema: passThrough,
    requiresApproval: false,
    async execute(args: { query: string }) {
      webCalls += 1;
      if (mode === 'outage') {
        return {
          query: args.query,
          provider: 'none',
          results: [],
          diagnostics: ['tavily: TAVILY_API_KEY not set', PROXY_432, 'brave: BRAVE_SEARCH_API_KEY not set'],
          suggestion:
            'Every search provider failed or is unconfigured — this is NOT a query problem. Rewording will not help. Report this and use another tool.',
        };
      }
      const slug = args.query.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      return {
        query: args.query,
        provider: 'buildmybot-tavily-proxy',
        results: [{ title: `Daily Ledger ${slug}`, url: `https://${slug}-${runId}.guard.test/`, snippet: 'Local news' }],
      };
    },
  } as never);
  registry.register({
    name: 'searchBusinessDirectory',
    description: 'guard stub',
    schema: passThrough,
    requiresApproval: false,
    async execute(args: { query: string }) {
      return {
        query: args.query,
        total: 0,
        businesses: [],
        provider: 'none',
        attempts: [
          'yelp: YELP_API_KEY not set',
          'google: GOOGLE_PLACES_API_KEY not set',
          'tomtom: TOMTOM_API_KEY not set',
          `OSM: no known category tag for "${args.query}"`,
        ],
        error: 'No business directory API returned results.',
      };
    },
  } as never);

  const created = await runnerMod.createCampaign({
    name: `Lead search pause guard ${Date.now()}`,
    industries: ['US News'],
    cities: ['Birmingham AL', 'Mobile AL'],
    targetLeads: 50,
  });
  const segments = () => db.select().from(campaignSegments).where(eq(campaignSegments.campaignId, created.campaignId));
  // Only this run's lines, so the check can be re-run on the same database.
  const [{ startId }] = await db.select({ startId: sql<number>`coalesce(max(${logs.id}), 0)` }).from(logs);
  const pauseLines = async () =>
    (
      await db
        .select({ message: logs.message })
        .from(logs)
        .where(sql`${logs.id} > ${startId} and ${logs.message} like 'Lead search%'`)
        .orderBy(logs.id)
    ).map((row) => row.message as string);
  check('the campaign was created with more segments than one batch', created.segments > 12, created);

  const minute = 60_000;
  let now = Date.UTC(2026, 9, 3, 20, 34);
  const pause = new capacity.LeadSearchCapacityPause(2 * minute, 60 * minute, () => now);
  const runner = new runnerMod.CampaignRunner(60 * minute, pause);

  // 1. Outage: a normal batch goes out and every search is handed back.
  await runner.tick();
  let rows = await segments();
  const handedBack = rows.filter((row) => (row.lastError ?? '').startsWith('Waiting for search capacity.'));
  check('the first tick sends a normal batch of 6 into the outage', handedBack.length === 6, handedBack.length);
  check(
    'each is back in line with its attempt handed back',
    handedBack.every((row) => row.status === 'pending' && row.attempts === 0),
    handedBack.map((row) => [row.status, row.attempts]),
  );
  check('no search was closed', rows.every((row) => row.status !== 'failed'));
  let lines = await pauseLines();
  check('one activity line covers the whole batch', lines.length === 1, lines);
  check(
    'it names the cause and the wait',
    lines[0]?.startsWith('Lead search paused for 2 minutes') === true &&
      lines[0].includes('buildmybot-tavily: plan usage limit reached (HTTP 432)'),
    lines[0],
  );

  // 2. Still inside the wait: nothing is claimed or searched.
  const before = webCalls;
  now += minute;
  await runner.tick();
  check('inside the wait the runner claims and searches nothing', webCalls === before && (await segments()).every((row) => row.status === 'pending'));

  // 3. After the wait: exactly one test search, still down, wait doubles.
  now += minute;
  await runner.tick();
  check('after the wait exactly one test search goes out', webCalls === before + 1, webCalls - before);
  lines = await pauseLines();
  check(
    'the failed test search reports the doubled wait',
    lines.length === 2 && lines[1].startsWith('Lead search is still paused') && lines[1].includes('in 4 minutes'),
    lines,
  );
  check('its attempt was handed back too', (await segments()).every((row) => row.attempts === 0 && row.status === 'pending'));

  // 4. Provider back: the next test search lands and lead search resumes.
  mode = 'recovered';
  now += 4 * minute;
  const beforeResume = webCalls;
  await runner.tick();
  rows = await segments();
  check(
    'the test search after recovery runs alone and saves a lead',
    webCalls === beforeResume + 1 && rows.filter((row) => row.status === 'done').length === 1,
    rows.map((row) => row.status),
  );
  lines = await pauseLines();
  check('a "resumed" line is recorded', lines.some((line) => line.startsWith('Lead search resumed')), lines);
  check('the pause is over', pause.snapshot() === null);

  // 5. Back to normal batches.
  await runner.tick();
  rows = await segments();
  check('the next tick runs a full batch again', rows.filter((row) => row.status === 'done').length === 7, rows.map((row) => row.status));
  check('no search was closed at any point', rows.every((row) => row.status !== 'failed'));

  console.log(
    failures === 0
      ? '\n✅ The campaign runner pauses and resumes lead search on a provider outage.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

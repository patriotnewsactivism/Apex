/**
 * Guard: the keyless lead-source fallback actually queries something real,
 * and a failed search reports why instead of blaming the query.
 *
 * Two production failures this locks down, both found 2026-09-21 in live logs:
 *
 *  1. searchBusinessDirectory's OSM fallback regex-matched the query against
 *     the OSM `name` tag across all of the US. Businesses are named "Aable
 *     Bail Bonds", not "bail bonds agency", so the "no key, always works"
 *     provider returned zero on every sweep. OSM models what a business IS in
 *     its tags (office=bail_bond), so the query must be tag-based.
 *
 *  2. webSearch swallowed non-ok HTTP responses — the catch only fires on
 *     thrown exceptions — then told the agent "try a more specific query".
 *     With Tavily and Brave both failing auth, the agent reworded the same
 *     search ten times against a dead chain and burned scarce LLM capacity.
 *
 * Pure: the tag/location parsing is executed directly. No network, no DB.
 */
import fs from 'node:fs';
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
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

async function main(): Promise<void> {
  console.log('Verifying lead-source tools...\n');

  const mod = (await import(
    path.join(root, 'packages/core/src/tool-registry.ts')
  )) as typeof import('../packages/core/src/tool-registry.js');
  const { osmTagFiltersForQuery, osmLocationFromQuery } = mod;

  // ── 1. Category → real OSM tags ──────────────────────────────────────────
  console.log('── query → OSM category tags ──');
  const bail = osmTagFiltersForQuery('bail bonds agency California');
  check(
    'bail bonds maps to office=bail_bond (the tag OSM actually uses)',
    bail.tags.includes('office=bail_bond'),
    bail,
  );
  const law = osmTagFiltersForQuery('Tampa FL personal injury law firm phone website');
  check('personal injury maps to office=lawyer', law.tags.includes('office=lawyer'), law);
  const auto = osmTagFiltersForQuery('auto body collision repair shop Charlotte North Carolina');
  check('auto body maps to shop=car_repair', auto.tags.includes('shop=car_repair'), auto);
  const vet = osmTagFiltersForQuery('Portland Oregon veterinary clinic contact phone');
  check('veterinary maps to amenity=veterinary', vet.tags.includes('amenity=veterinary'), vet);
  const newspaper = osmTagFiltersForQuery('top rated news & newspapers San Francisco, CA');
  check('newspapers map to office=newspaper', newspaper.tags.includes('office=newspaper'), newspaper);
  const radio = osmTagFiltersForQuery('radio stations Austin, TX');
  check('radio stations map to office=broadcaster', radio.tags.includes('office=broadcaster'), radio);

  const unknown = osmTagFiltersForQuery('artisanal widget refurbishment Springfield');
  check(
    'an unrecognized category yields NO tags (so the caller reports it instead of guessing)',
    unknown.tags.length === 0,
    unknown,
  );

  // ── 2. Location survives category stripping ──────────────────────────────
  console.log('\n── query → geocodable place ──');
  for (const [query, expected] of [
    ['bail bonds agency California', 'california'],
    ['auto body collision repair shop Charlotte North Carolina', 'charlotte north carolina'],
    ['Portland Oregon veterinary clinic contact phone', 'portland oregon'],
    ['pest control company Orlando FL family owned official website contact', 'orlando fl'],
    ['top rated news & newspapers San Francisco, CA', 'san francisco, ca'],
    ['near me news & newspapers San Francisco, CA', 'san francisco, ca'],
    ['open now radio stations Austin, TX', 'austin, tx'],
  ] as const) {
    const { matchedKeywords } = osmTagFiltersForQuery(query);
    const place = osmLocationFromQuery(query, matchedKeywords);
    check(`"${query}" → place "${expected}"`, place === expected, { got: place });
  }

  const placeless = osmLocationFromQuery(
    'bail bonds agency',
    osmTagFiltersForQuery('bail bonds agency').matchedKeywords,
  );
  check(
    'a query with no place resolves to empty (caller must ask for a city/state, not scan the planet)',
    placeless === '',
    { got: placeless },
  );

  // ── 3. Source-structural: the old broken shapes are gone ────────────────
  console.log('\n── regressions that must stay fixed ──');
  const src = fs.readFileSync(path.join(root, 'packages/core/src/tool-registry.ts'), 'utf8');

  check(
    'OSM no longer name-regex-matches the query across all of the United States',
    !/area\["name"="United States"\]/.test(src),
  );
  check(
    'OSM queries by tag selector inside a bounding box',
    /nwr\["\$\{key\}"="\$\{value\}"\]\(\$\{bbox\}\)/.test(src),
  );
  check(
    'Nominatim is called with an identifying User-Agent (its usage policy requires one)',
    /nominatim\.openstreetmap\.org[\s\S]{0,400}'User-Agent'/.test(src),
  );
  check(
    'searchBusinessDirectory reports per-provider attempts when it finds nothing',
    /attempts:\s*\[/.test(src),
  );
  check(
    'Overpass fails over across multiple public endpoints (a single one 503s under load)',
    /const OVERPASS_ENDPOINTS = \[/.test(src) &&
      /for \(const endpoint of OVERPASS_ENDPOINTS\)/.test(src),
  );

  // webSearch: non-ok responses must be recorded, not silently dropped.
  // The whole tool and nothing past it. A fixed 16,000-character window
  // first spilled into the next tool, then stopped short of webSearch's own
  // return once Serper and Bright Data were added (2026-10-04).
  const webSearchStart = src.indexOf("name: 'webSearch'");
  const webSearchEnd = src.indexOf("\n      name: '", webSearchStart + 1);
  const webSearchSrc = src.slice(webSearchStart, webSearchEnd < 0 ? undefined : webSearchEnd);
  check(
    'webSearch logs Brave non-ok HTTP status',
    /if \(!braveRes\.ok\)/.test(webSearchSrc),
  );
  check(
    'webSearch logs Serper and Bright Data non-ok HTTP status',
    /if \(!serperRes\.ok\)/.test(webSearchSrc) && /if \(!bdRes\.ok\)/.test(webSearchSrc),
  );
  check(
    'webSearch authenticates Serper with X-API-KEY and Bright Data with a bearer token',
    /'X-API-KEY': serperKey/.test(webSearchSrc) && /Authorization: `Bearer \$\{brightDataKey\}`/.test(webSearchSrc),
  );
  check(
    'Brave, Serper and Bright Data calls are bounded by a timeout',
    (webSearchSrc.match(/AbortSignal\.timeout/g) ?? []).length >= 3,
  );
  // Operator decision 2026-10-05 (c7a61fc): Tavily is not in the stack, so
  // neither it nor BuildMyBot's Tavily proxy may come back into the search path
  // by accident.
  check(
    'Tavily is out of the search path: webSearch calls neither Tavily nor the BuildMyBot Tavily proxy',
    !/api\.tavily\.com|TAVILY_API_KEY|BUILDMYBOT_TAVILY_PROXY/.test(webSearchSrc),
  );
  check(
    'webSearch returns diagnostics to the agent',
    /diagnostics,/.test(webSearchSrc),
  );
  check(
    'a provider-side failure does NOT tell the agent to reword the query',
    /Rewording will not help/.test(webSearchSrc),
  );

  // ── 3b. Persistent lead-search cache ────────────────────────────────────
  console.log('\n── persistent lead-search cache ──');
  check(
    'structured directory searches participate in the persistent cache',
    /name === 'searchBusinessDirectory'/.test(src) &&
      /cacheKind = 'directory'/.test(src),
  );
  check(
    'only fast lead-discovery web searches are cached; ordinary web research stays fresh',
    /name === 'webSearch' && args\.fast === true/.test(src) &&
      /Ordinary\/general webSearch remains uncached/.test(src),
  );
  check(
    'directory and web lead searches have multi-day default cache TTLs',
    /LEAD_DIRECTORY_SEARCH_CACHE_DAYS', 30/.test(src) &&
      /LEAD_WEB_SEARCH_CACHE_DAYS', 14/.test(src),
  );
  check(
    'provider search responses are stored in the durable lead_search_cache table',
    /leadSearchCache/.test(src) &&
      /\.insert\(leadSearchCache\)/.test(src) &&
      /\.update\(leadSearchCache\)/.test(src),
  );
  check(
    'cache hits increment a durable hit counter so avoided provider requests are measurable',
    /hitCount: sql/.test(src) && /leadSearchCache\.hitCount/.test(src) &&
      /\[lead-search-cache\] HIT/.test(src),
  );
  check(
    'zero-result/provider-failure responses are not stored as long-lived cache entries',
    /resultCount <= 0/.test(src) &&
      /remain retryable rather than/.test(src),
  );
  check(
    'simultaneous identical searches coalesce behind one provider request',
    /leadSearchInFlight/.test(src) &&
      /\[lead-search-cache\] COALESCE/.test(src),
  );
  check(
    'operators can explicitly bypass cache when a fresh search is needed',
    /refresh: z\.boolean\(\)\.optional\(\)/.test(src) &&
      /if \(spec\.refresh\) return null/.test(src),
  );

  const cacheMigration = path.join(root, 'lib/db/drizzle/20260928_lead_search_cache.sql');
  check('lead-search cache has a production SQL migration', fs.existsSync(cacheMigration));
  if (fs.existsSync(cacheMigration)) {
    const migration = fs.readFileSync(cacheMigration, 'utf8');
    check(
      'lead-search cache migration includes query and expiry indexes',
      /CREATE TABLE IF NOT EXISTS lead_search_cache/.test(migration) &&
        /lead_search_cache_query_idx/.test(migration) &&
        /lead_search_cache_expiry_idx/.test(migration),
    );
  }

  // ── 4. Hunter.io contact enrichment ─────────────────────────────────────
  console.log('\n── hunter contact enrichment ──');
  const tools = mod.createBuiltinTools(root);
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of ['hunterDomainSearch', 'hunterEmailFinder', 'hunterEmailVerify']) {
    const tool = byName.get(name);
    check(`${name} is registered`, Boolean(tool));
    check(
      `${name} is a read-only lookup, not approval-gated`,
      tool?.requiresApproval !== true,
    );
  }

  // Fail closed without a key: no invented contacts, and a reason the agent
  // can report instead of falling back to guessing an address pattern.
  const savedKey = process.env.HUNTER_API_KEY;
  delete process.env.HUNTER_API_KEY;
  try {
    const search = byName.get('hunterDomainSearch');
    const found = (await search!.execute({ domain: 'example.com' }, {
      agentId: 'guard', workspaceRoot: root,
    } as never)) as { contacts?: unknown[]; error?: string };
    check(
      'hunterDomainSearch without a key returns zero contacts and names the missing env var',
      (found.contacts ?? []).length === 0 && /HUNTER_API_KEY/.test(found.error ?? ''),
      found,
    );

    const finder = byName.get('hunterEmailFinder');
    const one = (await finder!.execute(
      { domain: 'example.com', firstName: 'Ada', lastName: 'Lovelace' },
      { agentId: 'guard', workspaceRoot: root } as never,
    )) as { email?: string | null; error?: string };
    check(
      'hunterEmailFinder without a key returns no email rather than a guessed pattern',
      one.email === null && /HUNTER_API_KEY/.test(one.error ?? ''),
      one,
    );
  } finally {
    if (savedKey !== undefined) process.env.HUNTER_API_KEY = savedKey;
  }

  check(
    'the Lead Researcher can actually call the Hunter tools',
    /'hunterDomainSearch'[\s\S]{0,120}'hunterEmailVerify'/.test(
      fs.readFileSync(path.join(root, 'packages/agents/src/business.ts'), 'utf8'),
    ),
  );


  // ── 5. TomTom directory provider ────────────────────────────────────────
  console.log('\n── tomtom directory provider ──');
  const { splitBusinessQuery } = mod;
  for (const [q, term, place] of [
    ['bail bonds agency Houston Texas', 'bail bonds agency', 'Houston Texas'],
    ['roofing contractor Dallas Texas', 'roofing contractor', 'Dallas Texas'],
    ['auto repair shop Charlotte North Carolina', 'auto repair shop', 'Charlotte North Carolina'],
    ['pest control company Orlando FL', 'pest control company', 'Orlando FL'],
  ] as const) {
    const got = splitBusinessQuery(q);
    check(`"${q}" → term "${term}" @ "${place}"`, got.term === term && got.place === place, got);
  }
  const noState = splitBusinessQuery('bail bonds agency');
  check(
    'no state in the query yields an empty place (search without a geo bias, never a guessed one)',
    noState.place === '' && noState.term === 'bail bonds agency',
    noState,
  );

  check(
    'TomTom geocodes the place first, then searches lat/lon/radius',
    /api\.tomtom\.com\/search\/2\/geocode/.test(src) &&
      /&lat=\$\{pos\.lat\}&lon=\$\{pos\.lon\}&radius=\$\{TOMTOM_RADIUS_METRES\}/.test(src),
  );
  check(
    'TomTom results without a phone or website never crowd out contactable ones',
    /Number\(Boolean\(b\.phone \|\| b\.website\)\)/.test(src),
  );
  check(
    'a schemeless TomTom url is normalized to a fetchable one',
    /\^https\?:\\\/\\\/\/i\.test/.test(src),
  );
  check(
    'a missing TOMTOM_API_KEY is reported as an attempt, not silence',
    /tomtom: TOMTOM_API_KEY not set/.test(src),
  );
  const settingsSrc = fs.readFileSync(path.join(root, 'packages/api-server/src/routes/settings.ts'), 'utf8');
  check(
    'TomTom is exposed in Settings → Business Search so a migrated deployment can restore the key',
    /id: 'business-search'[\s\S]{0,1600}key: 'TOMTOM_API_KEY'/.test(settingsSrc),
  );
  const campaignRunnerSrc = fs.readFileSync(path.join(root, 'packages/background-jobs/src/campaign-runner.ts'), 'utf8');
  check(
    'when no fast providers are configured, campaign discovery uses the keyless directory fallback without launching a guaranteed-fail webSearch',
    /if \(!hasFastWeb && !hasFastStructured\)[\s\S]{0,500}first = await runDirectory\(\)/.test(campaignRunnerSrc),
  );
  check(
    'contact recovery skips its search lane when no keyed web provider (Brave, Serper, Bright Data) is configured',
    /enrichVerifiedContactsFromSearch[\s\S]{0,700}!process\.env\.BRAVE_SEARCH_API_KEY && !process\.env\.SERPER_API_KEY && !process\.env\.BRIGHT_DATA_API_KEY\) return/.test(campaignRunnerSrc),
  );
  check(
    'campaign discovery treats Brave, Serper and Bright Data as fast web sources',
    /const hasFastWeb = Boolean\(\s*process\.env\.BRAVE_SEARCH_API_KEY \|\|\s*process\.env\.SERPER_API_KEY \|\|\s*process\.env\.BRIGHT_DATA_API_KEY,?\s*\)/.test(campaignRunnerSrc),
  );
  check(
    'campaign discovery and contact recovery no longer depend on Tavily or the BuildMyBot Tavily proxy',
    !/TAVILY_API_KEY|BUILDMYBOT_TAVILY_PROXY/.test(campaignRunnerSrc),
  );


  // ── 6. Geocode cache ────────────────────────────────────────────────────
  // A city's coordinates are permanent, so a repeat lookup is a request spent
  // on a known answer. TomTom's free Search tier is 2,500/month and a
  // geo-bounded directory call costs two requests, so this halves the burn.
  console.log('\n── geocode cache ──');
  const { rememberGeocode, cachedGeocode, clearGeocodeCache } = mod;

  clearGeocodeCache();
  rememberGeocode('tomtom', 'Houston Texas', '&lat=29.76&lon=-95.36&radius=40000');
  check(
    'a remembered geocode is returned on the next lookup',
    cachedGeocode('tomtom', 'Houston Texas') === '&lat=29.76&lon=-95.36&radius=40000',
  );
  check(
    'lookups are case- and whitespace-insensitive (the agent does not normalize)',
    cachedGeocode('tomtom', '  houston   TEXAS ') === '&lat=29.76&lon=-95.36&radius=40000',
  );
  check(
    'providers keep separate namespaces (a TomTom bias is not an Overpass bbox)',
    cachedGeocode('nominatim', 'Houston Texas') === undefined,
  );

  // The real property: a second directory call for the same metro must not
  // re-geocode. Counted against a stubbed fetch rather than asserted from
  // source, so a refactor that quietly drops the cache fails here.
  clearGeocodeCache();
  const realFetch = globalThis.fetch;
  let geocodeCalls = 0;
  let poiCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/search/2/geocode/')) {
      geocodeCalls += 1;
      return new Response(JSON.stringify({ results: [{ position: { lat: 29.76, lon: -95.36 } }] }), { status: 200 });
    }
    poiCalls += 1;
    return new Response(
      JSON.stringify({ results: [{ poi: { name: 'Test Bail Bonds', phone: '+1 713-000-0000', url: 'testbail.com' }, address: { municipality: 'Houston' } }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  const savedTomTom = process.env.TOMTOM_API_KEY;
  process.env.TOMTOM_API_KEY = 'guard-script-test-key';
  try {
    const directory = byName.get('searchBusinessDirectory')!;
    const ctx = { agentId: 'guard', workspaceRoot: root } as never;
    await directory.execute({ query: 'bail bonds agency Houston Texas' }, ctx);
    await directory.execute({ query: 'roofing contractor Houston Texas' }, ctx);
    await directory.execute({ query: 'medspa Houston Texas' }, ctx);
    check(
      'three searches in the same metro geocode ONCE, not three times',
      geocodeCalls === 1,
      { geocodeCalls, poiCalls },
    );
    check('each search still runs its own POI query', poiCalls === 3, { geocodeCalls, poiCalls });
  } finally {
    globalThis.fetch = realFetch;
    if (savedTomTom === undefined) delete process.env.TOMTOM_API_KEY;
    else process.env.TOMTOM_API_KEY = savedTomTom;
    clearGeocodeCache();
  }

  if (failures > 0) {
    console.error(`\n${failures} lead-source-tool check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll lead-source-tool checks passed.');
}

main();

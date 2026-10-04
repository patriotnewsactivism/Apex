/**
 * Guard: a search-provider outage pauses lead search instead of closing it.
 *
 * On 2026-10-03 at 20:34 UTC the Tavily plan behind BuildMyBot's proxy hit its
 * usage limit. The proxy was APEX's only working search source. The campaign
 * runner read every empty search as the segment's own failure, and because no
 * direct key was set and OSM has no "US News" category, isDeterministicFailure
 * called it permanent: 799 searches across 73 cities were closed after one
 * attempt in 13 minutes. Later that night "Newspapers & Radio Stations"
 * searches burned all three attempts the same way.
 *
 * This guard replays those production messages and checks that an outage
 * hands the attempt back, pauses with a doubling backoff, tests with one
 * search, and resumes when a source answers. It also drives the real webSearch
 * and searchBusinessDirectory tools against a stubbed fetch, so a change to
 * their diagnostic wording cannot silently break the classifier.
 *
 * No network, no database, no model.
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
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail, null, 2).slice(0, 1200)}`);
}

// Verbatim from production (Railway logs, deployment c967764a, 2026-10-03).
const PROXY_432 =
  'buildmybot-tavily: HTTP 502 {"error":"Tavily search failed with HTTP 432","detail":"{\\"detail\\":{\\"error\\":\\"This request exceeds your plan\'s set usage limit. Please upgrade your plan or contact support@tavily.com\\"}}"}';
const SUGGESTION =
  'Every search provider failed or is unconfigured — this is NOT a query problem. Rewording will not help. Report this and use another tool.';
const NO_KEYS = [
  'yelp: YELP_API_KEY not set',
  'google: GOOGLE_PLACES_API_KEY not set',
  'tomtom: TOMTOM_API_KEY not set',
];

async function main(): Promise<void> {
  console.log('Verifying lead search pauses on a provider outage instead of closing searches...\n');

  const capacity = (await import(
    path.join(root, 'packages/background-jobs/src/lead-search-capacity.ts')
  )) as typeof import('../packages/background-jobs/src/lead-search-capacity.js');
  const runner = (await import(
    path.join(root, 'packages/background-jobs/src/campaign-runner.ts')
  )) as typeof import('../packages/background-jobs/src/campaign-runner.js');
  const registry = (await import(
    path.join(root, 'packages/core/src/tool-registry.ts')
  )) as typeof import('../packages/core/src/tool-registry.js');

  const msg = (query: string, notes: string[]) => capacity.discoveryZeroMessage(query, notes);

  // ── The two production failures ─────────────────────────────────────────
  const usNews = msg('us news Birmingham, AL', [
    'tavily: TAVILY_API_KEY not set',
    PROXY_432,
    'brave: BRAVE_SEARCH_API_KEY not set',
    SUGGESTION,
    ...NO_KEYS,
    'OSM: no known category tag for "us news Birmingham, AL"',
  ]);
  const usNewsClass = capacity.classifyLeadDiscoveryFailure(usNews);
  check('20:34 "US News": the proxy at its Tavily plan limit is a provider outage', usNewsClass.providerOutage, usNewsClass);
  check(
    'the unavailable source is named with Tavily\'s own reason, not the proxy\'s 502',
    usNewsClass.unavailable.length === 1 &&
      usNewsClass.unavailable[0].source === 'buildmybot-tavily' &&
      usNewsClass.unavailable[0].reason === 'plan usage limit reached (HTTP 432)',
    usNewsClass.unavailable,
  );
  check(
    'it is no longer "deterministic" (this rule closed 799 searches after one attempt)',
    !runner.isDeterministicFailure(usNews),
  );
  const usNewsDecision = runner.decideSegmentFailure({ message: usNews, attempts: 1, maxAttempts: 3 });
  check(
    'the segment goes back in line and its attempt is handed back',
    usNewsDecision.kind === 'capacity_pause' && usNewsDecision.attempts === 0,
    usNewsDecision,
  );

  const radio = msg('best newspapers & radio stations company Cedar Rapids, IA', [
    'tavily: TAVILY_API_KEY not set',
    PROXY_432,
    'brave: BRAVE_SEARCH_API_KEY not set',
    SUGGESTION,
    ...NO_KEYS,
    'OSM: overpass-api.de fetch failed',
    'OSM: overpass.kumi.systems The operation was aborted due to timeout',
    'OSM: overpass.private.coffee The operation was aborted due to timeout',
  ]);
  const radioDecision = runner.decideSegmentFailure({ message: radio, attempts: 3, maxAttempts: 3 });
  check(
    '22:59 "Newspapers & Radio Stations" on attempt 3 of 3 is not closed; it waits with attempt 2 of 3',
    radioDecision.kind === 'capacity_pause' && radioDecision.attempts === 2,
    radioDecision,
  );

  const davenport = msg('newspapers & radio stations company Davenport, IA', [
    'tavily: TAVILY_API_KEY not set',
    PROXY_432,
    'brave: BRAVE_SEARCH_API_KEY not set',
    SUGGESTION,
    ...NO_KEYS,
    'OSM: overpass-api.de fetch failed',
    'OSM: 0 businesses tagged office=newspaper/office=publisher/office=broadcaster in "davenport, ia"',
  ]);
  check(
    'an empty answer from keyless OSM does not cancel the outage of the source that matters',
    capacity.classifyLeadDiscoveryFailure(davenport).providerOutage,
  );

  // ── What must stay as it was ────────────────────────────────────────────
  const noSourceAtAll = msg('us news Birmingham, AL', [
    'tavily: TAVILY_API_KEY not set',
    'brave: BRAVE_SEARCH_API_KEY not set',
    ...NO_KEYS,
    'OSM: no known category tag for "us news Birmingham, AL"',
  ]);
  const noSourceDecision = runner.decideSegmentFailure({ message: noSourceAtAll, attempts: 1, maxAttempts: 3 });
  check(
    'with no search source configured at all, the search still closes after one attempt',
    noSourceDecision.kind === 'closed' && noSourceDecision.deterministic,
    noSourceDecision,
  );

  const proxyAnsweredEmpty = msg('us news Birmingham, AL', [
    'tavily: TAVILY_API_KEY not set',
    'buildmybot-tavily: 200 but zero results',
    'brave: BRAVE_SEARCH_API_KEY not set',
    ...NO_KEYS,
    'OSM: no known category tag for "us news Birmingham, AL"',
  ]);
  check(
    'when the proxy answered with nothing, that empty is honest: closed once, no pause, no repeat Tavily spend',
    !capacity.classifyLeadDiscoveryFailure(proxyAnsweredEmpty).providerOutage &&
      runner.decideSegmentFailure({ message: proxyAnsweredEmpty, attempts: 1, maxAttempts: 3 }).kind === 'closed',
  );

  const oneDownOneAnswered = msg('roofing Dallas, TX', [
    'tavily: 200 but zero results',
    'brave: HTTP 429 {"type":"ErrorResponse"}',
    ...NO_KEYS,
  ]);
  const mixed = runner.decideSegmentFailure({ message: oneDownOneAnswered, attempts: 1, maxAttempts: 3 });
  check(
    'one source answering empty while another is rate limited is an ordinary retry, not a pause',
    !capacity.classifyLeadDiscoveryFailure(oneDownOneAnswered).providerOutage && mixed.kind === 'retry' && mixed.attempts === 1,
    mixed,
  );

  const osmOnlyFlaky = msg('roofing Dallas, TX', [
    'tavily: TAVILY_API_KEY not set',
    'brave: BRAVE_SEARCH_API_KEY not set',
    ...NO_KEYS,
    'OSM: overpass-api.de fetch failed',
    'OSM: overpass.kumi.systems The operation was aborted due to timeout',
  ]);
  check(
    'keyless OSM timing out never pauses search (one slow city must not stall the territory)',
    !capacity.classifyLeadDiscoveryFailure(osmOnlyFlaky).providerOutage &&
      runner.decideSegmentFailure({ message: osmOnlyFlaky, attempts: 1, maxAttempts: 3 }).kind === 'retry',
  );

  const badRequest = msg('roofing Dallas, TX', ['tavily: HTTP 400 {"detail":"query too long"}', ...NO_KEYS]);
  check('a 400 is about the request, not capacity', !capacity.classifyLeadDiscoveryFailure(badRequest).providerOutage);

  const rejectedKey = msg('roofing Dallas, TX', ['tavily: HTTP 401 {"detail":"invalid key"}', ...NO_KEYS]);
  check(
    'a rejected key pauses instead of closing every search until someone fixes it',
    capacity.classifyLeadDiscoveryFailure(rejectedKey).providerOutage,
  );

  const breaker = msg('roofing Dallas, TX', ['buildmybot-tavily: temporarily skipped by provider circuit breaker', ...NO_KEYS]);
  check('an open circuit breaker counts as unavailable', capacity.classifyLeadDiscoveryFailure(breaker).providerOutage);

  check(
    'schema rejections stay non-retryable',
    runner.decideSegmentFailure({ message: 'Invalid args for saveResearchedLeadsBatch: [...]', attempts: 1, maxAttempts: 3 }).kind === 'closed',
  );
  check(
    'an unrelated error on the last attempt still closes the search',
    runner.decideSegmentFailure({ message: 'insert failed: connection reset', attempts: 3, maxAttempts: 3 }).kind === 'closed',
  );

  // ── Pause state ─────────────────────────────────────────────────────────
  const minute = 60_000;
  const pause = new capacity.LeadSearchCapacityPause(2 * minute, 60 * minute);
  const t0 = Date.UTC(2026, 9, 3, 20, 34);
  const quota = [{ source: 'buildmybot-tavily', reason: 'plan usage limit reached (HTTP 432)' }];
  check('before any outage the runner claims its normal batch', pause.claimLimit(6, t0) === 6);

  const first = pause.recordOutage(quota, t0);
  check('the first outage pauses for 2 minutes and is announced', first.started && first.waitMs === 2 * minute, first);
  const sibling = pause.recordOutage([{ source: 'buildmybot-tavily', reason: 'paused after an earlier failure' }], t0 + 1_000);
  check(
    'a segment that was in flight with it neither extends the wait nor announces again',
    !sibling.started && sibling.resumeAt === first.resumeAt,
    sibling,
  );
  check(
    'the circuit-breaker note does not overwrite the real reason',
    pause.snapshot(t0 + 1_000)?.summary === 'buildmybot-tavily: plan usage limit reached (HTTP 432)',
    pause.snapshot(t0 + 1_000),
  );
  check('nothing is claimed while paused', pause.claimLimit(6, t0 + minute) === 0);
  check('after the wait, exactly one test search is claimed', pause.claimLimit(6, t0 + 2 * minute) === 1);

  const second = pause.recordOutage(quota, t0 + 2 * minute);
  check('a failed test search doubles the wait to 4 minutes', second.started && second.waitMs === 4 * minute, second);
  let t = t0 + 6 * minute;
  let last = second;
  for (let i = 0; i < 8; i++) {
    last = pause.recordOutage(quota, t);
    t += last.waitMs;
  }
  check('the wait is capped at 60 minutes', last.waitMs === 60 * minute, last);

  const snapshot = pause.snapshot(t - minute);
  check('the snapshot reports the outage', snapshot !== null && snapshot.paused && snapshot.pauses === 10, snapshot);
  const resumed = pause.recordAnswer(t);
  check('a source answering ends the pause', resumed.resumed && resumed.outageMs > 0, resumed);
  check('and the runner goes straight back to its normal batch', pause.claimLimit(6, t) === 6 && pause.snapshot(t) === null);
  check('an answer with no pause running changes nothing', !pause.recordAnswer(t).resumed);

  // ── What the operator sees ──────────────────────────────────────────────
  const campaign = {
    id: 'c1',
    name: 'US News, Newspapers & Radio Stations',
    status: 'running',
    targetLeads: 500,
    lastProgressAt: new Date(t0 - 60 * minute),
    startedAt: new Date(t0 - 120 * minute),
    completedAt: null,
  } as any;
  const outagePause = new capacity.LeadSearchCapacityPause();
  outagePause.recordOutage(quota, t0);
  const waiting = runner.computeCampaignProgress(campaign, [], t0, 0, outagePause.snapshot(t0));
  check(
    'a running campaign with no progress during an outage reads "waiting_for_search", not "stalled"',
    waiting.displayStatus === 'waiting_for_search' && waiting.searchPause?.summary.includes('HTTP 432') === true,
    waiting,
  );
  check(
    'without an outage the stall detector is unchanged',
    runner.computeCampaignProgress(campaign, [], t0, 0, null).displayStatus === 'stalled',
  );
  check(
    'a campaign the operator paused stays "paused"',
    runner.computeCampaignProgress({ ...campaign, status: 'paused' }, [], t0, 0, outagePause.snapshot(t0)).displayStatus === 'paused',
  );

  // ── webSearch circuit breaker ───────────────────────────────────────────
  check('Tavily 432 (plan limit) opens the breaker for 30 minutes', registry.webSearchCooldownMs(432) === 30 * minute);
  check('Tavily 433 (pay-as-you-go limit) opens it for 30 minutes', registry.webSearchCooldownMs(433) === 30 * minute);
  check('429 still opens it for 60 seconds', registry.webSearchCooldownMs(429) === minute);
  check('a 400 does not open it', registry.webSearchCooldownMs(400) === 0);
  check(
    "the proxy's 502 is timed by Tavily's 432 inside it",
    registry.proxiedUpstreamStatus(502, PROXY_432.slice('buildmybot-tavily: HTTP 502 '.length)) === 432,
  );
  check('a bare 502 from the proxy stays a 502', registry.proxiedUpstreamStatus(502, 'Bad Gateway') === 502);

  // ── The real tools, fetch stubbed ───────────────────────────────────────
  const fetched: string[] = [];
  const routes: Array<[string, () => Response]> = [
    ['https://proxy.example.test/', () => new Response(PROXY_432.slice('buildmybot-tavily: HTTP 502 '.length), { status: 502 })],
    ['https://lite.duckduckgo.com/', () => new Response('<html></html>', { status: 200 })],
    ['https://api.duckduckgo.com/', () => new Response('{}', { status: 200 })],
    ['https://api.yelp.com/', () => new Response('{"error":{"code":"TOO_MANY_REQUESTS_PER_SECOND"}}', { status: 429 })],
    ['https://places.googleapis.com/', () => new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })],
  ];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    return route ? route[1]() : new Response('', { status: 404 });
  }) as typeof fetch;

  for (const key of ['TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'TOMTOM_API_KEY']) delete process.env[key];
  process.env.BUILDMYBOT_TAVILY_PROXY_URL = 'https://proxy.example.test/search';
  process.env.BUILDMYBOT_TAVILY_PROXY_SECRET = 'guard-only-not-a-secret';
  process.env.YELP_API_KEY = 'guard-only-not-a-key';
  process.env.GOOGLE_PLACES_API_KEY = 'guard-only-not-a-key';

  const tools = registry.createBuiltinTools(root);
  const webSearch = tools.find((tool) => tool.name === 'webSearch');
  const directory = tools.find((tool) => tool.name === 'searchBusinessDirectory');
  check('webSearch and searchBusinessDirectory are registered', Boolean(webSearch && directory));
  if (!webSearch || !directory) {
    console.error('\nCannot continue without the tools the runner calls.');
    process.exit(1);
  }
  const ctx = { agentId: 'guard', workspaceRoot: root, requestApproval: async () => false } as any;
  type WebOut = { diagnostics?: string[]; suggestion?: string };
  type DirOut = { attempts?: string[]; error?: string };

  const proxyCalls = () => fetched.filter((url) => url.startsWith('https://proxy.example.test/')).length;
  const web1 = (await webSearch.execute({ query: 'us news Birmingham, AL official business website', maxResults: 10, fast: true }, ctx)) as WebOut;
  check(
    'webSearch reports the proxy failure with its status and body',
    proxyCalls() === 1 && (web1.diagnostics ?? []).some((d) => d.startsWith('buildmybot-tavily: HTTP 502') && d.includes('HTTP 432')),
    web1,
  );
  const web2 = (await webSearch.execute({ query: 'us news Birmingham, AL official business website', maxResults: 10, fast: true }, ctx)) as WebOut;
  check(
    'the next search skips the proxy instead of spending another request on a used-up plan',
    proxyCalls() === 1 && (web2.diagnostics ?? []).includes('buildmybot-tavily: temporarily skipped by provider circuit breaker'),
    web2,
  );
  check(
    'and tells the caller it is a provider problem, not a query problem',
    web2.suggestion?.startsWith('Every search provider failed') === true,
    web2.suggestion,
  );

  const dir = (await directory.execute({ query: 'us news Birmingham, AL' }, ctx)) as DirOut;
  check(
    'a Yelp 429 is reported as one, not as "returned nothing"',
    (dir.attempts ?? []).some((a) => a.startsWith('yelp: HTTP 429')),
    dir.attempts,
  );
  check(
    'a Google Places 429 is reported as one, not as "returned nothing"',
    (dir.attempts ?? []).some((a) => a.startsWith('google: HTTP 429')),
    dir.attempts,
  );

  const live = msg('us news Birmingham, AL', [
    ...(web1.diagnostics ?? []),
    ...(web1.suggestion ? [web1.suggestion] : []),
    ...(dir.attempts ?? []),
    ...(dir.error ? [dir.error] : []),
  ]);
  const liveClass = capacity.classifyLeadDiscoveryFailure(live);
  check(
    "the real tools' diagnostics classify as an outage naming all three sources",
    liveClass.providerOutage &&
      ['buildmybot-tavily', 'yelp', 'google'].every((source) => liveClass.unavailable.some((item) => item.source === source)),
    liveClass,
  );
  check(
    'and the runner would hand the attempt back',
    runner.decideSegmentFailure({ message: live, attempts: 1, maxAttempts: 3 }).kind === 'capacity_pause',
  );

  console.log(
    failures === 0
      ? '\n✅ Lead search pauses on provider outages and closes nothing it should not.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

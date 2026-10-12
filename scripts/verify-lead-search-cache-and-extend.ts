/**
 * Guard: lead collection keeps going without paying for the same search twice.
 *
 * Covers the 2026-10-06 lead-search-cache work:
 *   1. web_fast cache keys no longer include maxResults (v2), and still read
 *      the v1 rows already paid for (legacy keys), slicing to the caller's n;
 *   2. Hunter enrichment lookups are cached (domain search / finder / verify);
 *   3. Brave `count` never exceeds 20; larger requests page with `offset`;
 *   4. Serper's HTTP 400 "Not enough credits" opens the breaker and is a
 *      capacity outage (it closed 27 campaign segments on 2026-10-05);
 *   5. pre-insert lead de-dup keys (domain / phone / name+city);
 *   6. claim slots are shared across running campaigns;
 *   7. extending a finished/cancelled/short campaign reopens only unsearched
 *      territory and refuses requests that cannot make progress;
 *   8. a recent cached website verification is reused instead of re-fetched.
 *
 * No network, no database, no model.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail, null, 2).slice(0, 1500)}`);
}

const v1Key = (kind: string, query: string, fp: Record<string, unknown>) =>
  createHash('sha256').update(`${kind}\n${query}\n${JSON.stringify(fp)}`).digest('hex');

async function main(): Promise<void> {
  console.log('Verifying lead-search cache, de-dup, and campaign extension...\n');
  const registry = (await import(path.join(root, 'packages/core/src/tool-registry.ts'))) as typeof import('../packages/core/src/tool-registry.js');
  const capacity = (await import(path.join(root, 'packages/background-jobs/src/lead-search-capacity.ts'))) as typeof import('../packages/background-jobs/src/lead-search-capacity.js');
  const runner = (await import(path.join(root, 'packages/background-jobs/src/campaign-runner.ts'))) as typeof import('../packages/background-jobs/src/campaign-runner.js');
  const pipeline = (await import(path.join(root, 'packages/background-jobs/src/lead-pipeline.ts'))) as typeof import('../packages/background-jobs/src/lead-pipeline.js');

  // ── 1. web_fast cache keys ──────────────────────────────────────────────
  console.log('── search cache keys ──');
  const q = 'top rated it services company Trenton, NJ official business website';
  const norm = registry.normalizeLeadSearchQuery(q);
  const s20 = registry.leadSearchCacheSpec('webSearch', { query: q, fast: true, maxResults: 20 })!;
  const s25 = registry.leadSearchCacheSpec('webSearch', { query: q, fast: true, maxResults: 25 })!;
  check('a fast webSearch is cacheable', Boolean(s20) && s20.cacheKind === 'web_fast');
  check('changing maxResults no longer changes the cache key', s20.cacheKey === s25.cacheKey);
  check('freeOnly still separates the key (different provider set)',
    registry.leadSearchCacheSpec('webSearch', { query: q, fast: true, freeOnly: true })!.cacheKey !== s20.cacheKey);
  const legacy25 = v1Key('web_fast', norm, { version: '2026-09-28-v1', fast: true, freeOnly: false, maxResults: 25 });
  const legacy20 = v1Key('web_fast', norm, { version: '2026-09-28-v1', fast: true, freeOnly: false, maxResults: 20 });
  check('v1 rows written with maxResults 25 and 20 are still readable', s20.legacyCacheKeys.includes(legacy25) && s20.legacyCacheKeys.includes(legacy20), s20.legacyCacheKeys);
  check('an ordinary (non-fast) webSearch stays uncached', registry.leadSearchCacheSpec('webSearch', { query: q }) === null);
  const dirSpec = registry.leadSearchCacheSpec('searchBusinessDirectory', { query: 'family law attorney Newark, NJ' })!;
  check('directory keys are unchanged, so existing directory rows keep hitting',
    dirSpec.cacheKey === v1Key('directory', 'family law attorney newark nj', { version: '2026-09-28-v1' }));

  check('a row fetched for 25 satisfies a request for 20',
    registry.leadSearchCacheRowSatisfies({ requestFingerprint: { maxResults: 25 }, resultCount: 25 }, 20));
  check('a row fetched for 6 that came back full does NOT satisfy a request for 20',
    !registry.leadSearchCacheRowSatisfies({ requestFingerprint: { requestedResults: 6 }, resultCount: 6 }, 20));
  check('a row that came back short (provider ran out) satisfies a larger request',
    registry.leadSearchCacheRowSatisfies({ requestFingerprint: { requestedResults: 20 }, resultCount: 13 }, 25));

  // ── 2. Hunter enrichment cache ──────────────────────────────────────────
  console.log('\n── enrichment cache ──');
  const h1 = registry.leadSearchCacheSpec('hunterDomainSearch', { domain: 'https://www.AcmeLaw.com/contact' })!;
  const h2 = registry.leadSearchCacheSpec('hunterDomainSearch', { domain: 'acmelaw.com' })!;
  check('Hunter domain search is cached by normalized domain', Boolean(h1) && h1.cacheKey === h2.cacheKey && h1.cacheKind === 'hunter_domain', h1);
  const f1 = registry.leadSearchCacheSpec('hunterEmailFinder', { domain: 'acmelaw.com', firstName: 'Jane', lastName: 'Doe' })!;
  const f2 = registry.leadSearchCacheSpec('hunterEmailFinder', { domain: 'www.acmelaw.com', firstName: ' jane ', lastName: 'DOE' })!;
  check('Hunter email finder is cached by domain + name', f1.cacheKey === f2.cacheKey);
  const v = registry.leadSearchCacheSpec('hunterEmailVerify', { email: 'Jane@AcmeLaw.com' })!;
  check('email verification has a shorter default TTL (14d) than discovery (30d)', v.ttlMs === 14 * 86_400_000 && h1.ttlMs === 30 * 86_400_000);
  check('a Hunter "key not set" answer is never cached as a result',
    registry.leadSearchResultCount({ domain: 'x.com', total: 0, contacts: [], error: 'HUNTER_API_KEY is not set.' }) === 0);
  check('a found email counts as a positive result', registry.leadSearchResultCount({ domain: 'a.com', email: 'j@a.com', confidence: 91 }) === 1);
  check('a "no email found" answer does not', registry.leadSearchResultCount({ domain: 'a.com', email: null, confidence: undefined }) === 0);
  check('an "unknown" verification does not', registry.leadSearchResultCount({ email: 'j@a.com', result: 'unknown' }) === 0);
  check('a deliverable verdict does', registry.leadSearchResultCount({ email: 'j@a.com', result: 'deliverable', score: 97 }) === 1);

  // ── 3 + 4. Brave pagination, Serper credits ─────────────────────────────
  console.log('\n── providers ──');
  check('Brave plan: 25 → two pages of 20', JSON.stringify(registry.braveSearchPlan(25)) === JSON.stringify({ count: 20, pages: 2 }));
  check('Brave plan: 20 → one page of 20', JSON.stringify(registry.braveSearchPlan(20)) === JSON.stringify({ count: 20, pages: 1 }));
  check('Brave plan: 6 → one page of 6', JSON.stringify(registry.braveSearchPlan(6)) === JSON.stringify({ count: 6, pages: 1 }));
  check('Brave plan never exceeds 10 pages', registry.braveSearchPlan(5000).pages === 10);
  const serperCreditBody = '{"message":"Not enough credits","statusCode":400}';
  check('a plain 400 still does not open the breaker', registry.webSearchCooldownMs(400) === 0);
  check('Serper\'s 400 "Not enough credits" opens it for 30 minutes', registry.webSearchCooldownMs(400, serperCreditBody) === 30 * 60_000);
  check('Brave\'s 402 prepaid-balance body is recognized as out of credit',
    registry.isOutOfCreditBody('{"detail":"Prepaid credit balance is insufficient for this request. Top up to continue."}'));

  // The exact segment failure that closed 22 News Directors and 5 Women-Owned
  // Ad Agencies segments after one attempt on 2026-10-05.
  const prodMessage =
    'All lead discovery sources returned zero for "best news media New Orleans, LA". brave: BRAVE_SEARCH_API_KEY not set | ' +
    'serper: HTTP 400 {"message":"Not enough credits","statusCode":400} | Every search provider failed or is unconfigured — this is NOT a query problem. Rewording will not help. Report this and use another tool. | ' +
    'yelp: YELP_API_KEY not set | google: GOOGLE_PLACES_API_KEY not set | tomtom: TOMTOM_API_KEY not set | OSM: no known category tag for "best news media New Orleans, LA"';
  const cls = capacity.classifyLeadDiscoveryFailure(prodMessage);
  check('the 2026-10-05 Serper-credits failure is a provider outage', cls.providerOutage && cls.unavailable.some((u) => u.source === 'serper' && /credits/.test(u.reason ?? '')), cls);
  check('so the runner hands the attempt back instead of closing the segment',
    runner.decideSegmentFailure({ message: prodMessage, attempts: 1, maxAttempts: 3 }).kind === 'capacity_pause');

  // Real webSearch with a stubbed fetch.
  const fetched: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    if (url.startsWith('https://api.search.brave.com/')) {
      const u = new URL(url);
      const count = Number(u.searchParams.get('count'));
      if (count > 20) return new Response('{"error":"Count should be less than or equal to 20"}', { status: 422 });
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const results = Array.from({ length: count }, (_, i) => ({ title: `Biz ${offset}-${i}`, url: `https://biz${offset}-${i}.example.com/`, description: '' }));
      return new Response(JSON.stringify({ web: { results } }), { status: 200 });
    }
    if (url.startsWith('https://google.serper.dev/')) return new Response(serperCreditBody, { status: 400 });
    return new Response('<html></html>', { status: 200 });
  }) as typeof fetch;
  for (const key of ['BRIGHT_DATA_API_KEY', 'BRIGHT_DATA_ZONE']) delete process.env[key];
  process.env.BRAVE_SEARCH_API_KEY = 'guard-only-not-a-key';
  process.env.SERPER_API_KEY = 'guard-only-not-a-key';
  const tools = registry.createBuiltinTools(root);
  const webSearch = tools.find((t) => t.name === 'webSearch')!;
  const ctx = { agentId: 'guard', workspaceRoot: root, requestApproval: async () => false } as any;
  const out = (await webSearch.execute({ query: 'it services Albuquerque, NM official business website', maxResults: 25, fast: true }, ctx)) as { provider?: string; results?: unknown[] };
  const braveUrls = fetched.filter((u) => u.startsWith('https://api.search.brave.com/'));
  check('maxResults 25 makes two Brave calls, both with count ≤ 20', braveUrls.length === 2 && braveUrls.every((u) => Number(new URL(u).searchParams.get('count')) <= 20), braveUrls);
  check('the second Brave call pages with offset=1', new URL(braveUrls[1] ?? 'https://x/').searchParams.get('offset') === '1');
  check('and 25 Brave results come back', out.provider === 'brave' && out.results?.length === 25, out);

  delete process.env.BRAVE_SEARCH_API_KEY;
  fetched.length = 0;
  await webSearch.execute({ query: 'q1 official business website', maxResults: 10, fast: true }, ctx);
  await webSearch.execute({ query: 'q2 official business website', maxResults: 10, fast: true }, ctx);
  const serperCalls = fetched.filter((u) => u.startsWith('https://google.serper.dev/')).length;
  check('after Serper says "Not enough credits" the next search skips it', serperCalls === 1, fetched);

  // ── 5. De-dup keys ──────────────────────────────────────────────────────
  console.log('\n── lead de-dup ──');
  const k = pipeline.leadDedupeKeys({ companyName: 'Smith & Jones, P.C.', website: 'https://WWW.SmithJonesLaw.com/contact', phone: '+1 (973) 555-0142', city: ' Newark, NJ ' });
  check('domain is normalized', k.domain === 'smithjoneslaw.com', k);
  check('phone is normalized to 10 digits', k.phone === '9735550142', k);
  check('name+city is normalized', k.name === 'smithjonespc' && k.city === 'newark, nj', k);
  check('lock keys are sorted (deadlock-free ordering)', JSON.stringify(k.lockKeys) === JSON.stringify([...k.lockKeys].sort()) && k.lockKeys.length === 3);
  const fb = pipeline.leadDedupeKeys({ companyName: 'Joe', website: 'https://facebook.com/joes-roofing', phone: '000-000-0000', city: '' });
  check('a Facebook page is not a dedupe domain, junk phones and short names are ignored', fb.domain === null && fb.phone === null && fb.name === null && fb.lockKeys.length === 0, fb);
  check('normalizer agrees with SQL right(...,10) for an 11-digit US number', pipeline.normalizeLeadPhoneForDedupe('1-800-555-0199') === '8005550199');

  // ── 6. Fair share ───────────────────────────────────────────────────────
  console.log('\n── claim distribution ──');
  check('12 slots over three busy campaigns → 4/4/4', JSON.stringify(runner.fairShareClaimCounts([500, 500, 500], 12)) === '[4,4,4]');
  check('a short queue passes its share on → 2/10', JSON.stringify(runner.fairShareClaimCounts([2, 500], 12)) === '[2,10]');
  check('oldest campaign gets the remainder first → 3/3/2/2/2', JSON.stringify(runner.fairShareClaimCounts([9, 9, 9, 9, 9], 12)) === '[3,3,2,2,2]');
  check('no campaigns → nothing', JSON.stringify(runner.fairShareClaimCounts([], 12)) === '[]');

  // ── 7. Campaign extension ───────────────────────────────────────────────
  console.log('\n── campaign extension ──');
  const seg = (industry: string, city: string, subcategory: string, searchIntent: string, status: string) => ({ industry, city, subcategory, searchIntent, status });
  const campaign = { id: 'c1', name: 'Premium: Software Development - Nationwide', status: 'completed', targetLeads: 500, icp: { industries: ['Software Development'], cities: ['Austin, TX', 'Dallas, TX'] } } as any;
  const segments = [
    seg('Software Development', 'Austin, TX', 'software development', 'directory', 'done'),
    seg('Software Development', 'Austin, TX', 'software development', 'near me', 'exhausted'),
    seg('Software Development', 'Austin, TX', 'software development', 'best', 'failed'),
    seg('Software Development', 'Dallas, TX', 'software development', 'directory', 'cancelled'),
    seg('Software Development', 'Dallas, TX', 'software development', 'near me', 'cancelled'),
  ];
  const plan = runner.planCampaignExtension(campaign, segments, { targetLeads: 1500 }, 619, { liveDemoMode: false, shardsPerCell: 12 });
  check('done + exhausted segments are kept and skipped', plan.alreadyWorked === 2, plan);
  check('cancelled segments reopen, failed ones are retried', plan.reopenCancelled === 2 && plan.requeueFailed === 1 && plan.pendingAfter === 3, plan);
  const noRetry = runner.planCampaignExtension(campaign, segments, { targetLeads: 1500, retryFailed: false }, 619);
  check('retryFailed=false leaves failed segments closed', noRetry.requeueFailed === 0 && noRetry.stillFailed === 1 && noRetry.pendingAfter === 2);
  let refused = '';
  try { runner.planCampaignExtension(campaign, segments, { targetLeads: 600 }, 619); } catch (e) { refused = String(e); }
  check('a target at or below the current usable count is refused', /must be above the 619 usable leads/.test(refused), refused);
  const worked = segments.map((s) => ({ ...s, status: s.status === 'exhausted' ? 'exhausted' : 'done' }));
  refused = '';
  try { runner.planCampaignExtension({ ...campaign, status: 'completed_short' }, worked, { targetLeads: 2000 }, 717); } catch (e) { refused = String(e); }
  check('a fully worked territory is refused unless it is widened', /no unsearched territory left/.test(refused), refused);
  const widened = runner.planCampaignExtension({ ...campaign, status: 'completed_short' }, worked, { targetLeads: 2000, addCities: ['Boise, ID', 'Austin, TX'] }, 717, { liveDemoMode: false, shardsPerCell: 12 });
  check('widening adds shards only for new cities (Austin already exists)', widened.newSegments.length > 0 && widened.newSegments.every((s) => s.city === 'Boise, ID') && widened.cities.includes('Boise, ID'), widened.newSegments.slice(0, 3));
  const cancelled = runner.planCampaignExtension({ ...campaign, status: 'cancelled' }, [
    seg('Legal', 'Newark, NJ', 'personal injury lawyer', 'directory', 'done'),
    seg('Legal', 'Trenton, NJ', 'personal injury lawyer', 'directory', 'pending'),
  ], { targetLeads: 500 }, 43);
  check('a cancelled campaign with pending territory can be restarted', cancelled.alreadyPending === 1 && cancelled.pendingAfter === 1);

  // ── 8. Cached website verification ─────────────────────────────────────
  console.log('\n── website verification cache ──');
  const now = Date.UTC(2026, 9, 6, 9, 0);
  const identity = { status: 'verified', homepage: 'https://acmelaw.com/', checkedAt: new Date(now - 3 * 86_400_000).toISOString(), contactScanVersion: '2026-09-28-v2' };
  check('a recent verified scan of the same domain is reused', pipeline.reusableCachedWebsiteIdentity({ basicEnrichment: { businessVerification: identity } }, 'http://www.acmelaw.com', now)?.status === 'verified');
  check('a cached mismatch is reused (rejects without a fetch)', pipeline.reusableCachedWebsiteIdentity({ basicEnrichment: { businessVerification: { ...identity, status: 'mismatch' } } }, 'acmelaw.com', now)?.status === 'mismatch');
  check('an old scan is not', pipeline.reusableCachedWebsiteIdentity({ basicEnrichment: { businessVerification: { ...identity, checkedAt: new Date(now - 45 * 86_400_000).toISOString() } } }, 'acmelaw.com', now) === null);
  check('an unverified (timeout) scan is not', pipeline.reusableCachedWebsiteIdentity({ basicEnrichment: { businessVerification: { ...identity, status: 'unverified' } } }, 'acmelaw.com', now) === null);
  check('a scan of another domain is not', pipeline.reusableCachedWebsiteIdentity({ basicEnrichment: { businessVerification: identity } }, 'other.com', now) === null);

  console.log(failures === 0 ? '\n✅ Lead search cache, de-dup, and campaign extension behave as specified.\n' : `\n❌ ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

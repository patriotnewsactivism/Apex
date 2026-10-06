/**
 * Guard: Bright Data searches Google through a Web Unlocker zone and never
 * spends more than the operator's daily request cap.
 *
 * 2026-10-06: the Bing + data_format:"parsed" request only works on SERP-
 * product zones; on the operator's unlocker zone it returns an inner 502 with
 * an empty body, which webSearch dropped silently. The operator approved
 * Bright Data with a hard $3/day ceiling (2,000 requests at $1.50 per 1,000).
 *
 *   1. BRIGHT_DATA_DAILY_REQUEST_CAP parsing (default 2000);
 *   2. Central Time day boundaries and the next-midnight reset (DST-safe);
 *   3. the cap: atomic reservations, concurrency, persistence across restarts,
 *      one warning, no store traffic once exhausted, next-day rollover, and an
 *      in-memory fallback when the database is unreachable;
 *   4. brd_json Google body parsing;
 *   5. real webSearch with a stubbed fetch: the Google URL, no data_format,
 *      inner non-200 handled and backed off, the cap reported as lost
 *      capacity (so segments are not closed);
 *   6. source guards on the request shape and timeout.
 *
 * No network, no database.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
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

type Store = import('../packages/core/src/brightdata-budget.js').BrightDataBudgetStore;
function memoryStore(): Store & { rows: Map<string, number>; increments: number; fail: boolean } {
  const rows = new Map<string, number>();
  const s = {
    rows,
    increments: 0,
    fail: false,
    async increment(k: string) {
      if (s.fail) throw new Error('db down');
      s.increments += 1;
      const n = (rows.get(k) ?? 0) + 1;
      rows.set(k, n);
      return n;
    },
    async decrement(k: string) {
      rows.set(k, Math.max(0, (rows.get(k) ?? 0) - 1));
    },
    async succeed() {},
    async read(k: string) {
      return rows.get(k) ?? 0;
    },
  };
  return s;
}

async function main(): Promise<void> {
  console.log('Verifying Bright Data unlocker search and daily request cap...\n');
  const budget = (await import(path.join(root, 'packages/core/src/brightdata-budget.ts'))) as typeof import('../packages/core/src/brightdata-budget.js');
  const registry = (await import(path.join(root, 'packages/core/src/tool-registry.ts'))) as typeof import('../packages/core/src/tool-registry.js');
  const capacity = (await import(path.join(root, 'packages/background-jobs/src/lead-search-capacity.ts'))) as typeof import('../packages/background-jobs/src/lead-search-capacity.js');
  const runner = (await import(path.join(root, 'packages/background-jobs/src/campaign-runner.ts'))) as typeof import('../packages/background-jobs/src/campaign-runner.js');

  // ── 1. cap parsing ──────────────────────────────────────────────────────
  console.log('── cap parsing ──');
  check('default cap is 2000 ($3/day at $1.50 per 1,000)', budget.brightDataDailyRequestCap({}) === 2000 && budget.DEFAULT_BRIGHT_DATA_DAILY_REQUEST_CAP === 2000);
  check('an explicit cap is honoured', budget.brightDataDailyRequestCap({ BRIGHT_DATA_DAILY_REQUEST_CAP: '6600' }) === 6600);
  check('garbage or negative falls back to the default', budget.brightDataDailyRequestCap({ BRIGHT_DATA_DAILY_REQUEST_CAP: 'lots' }) === 2000 && budget.brightDataDailyRequestCap({ BRIGHT_DATA_DAILY_REQUEST_CAP: '-5' }) === 2000);
  check('0 turns Bright Data off', budget.brightDataDailyRequestCap({ BRIGHT_DATA_DAILY_REQUEST_CAP: '0' }) === 0);

  // ── 2. Central Time days ────────────────────────────────────────────────
  console.log('\n── Central Time day ──');
  check('04:59 UTC on Oct 7 is still Oct 6 in Chicago (CDT)', budget.centralDay(Date.UTC(2026, 9, 7, 4, 59)) === '2026-10-06');
  check('05:00 UTC on Oct 7 is Oct 7 in Chicago', budget.centralDay(Date.UTC(2026, 9, 7, 5, 0)) === '2026-10-07');
  check('next reset after 8:30 AM CDT Oct 6 is 05:00 UTC Oct 7', budget.nextCentralMidnight(Date.UTC(2026, 9, 6, 13, 30)).toISOString() === '2026-10-07T05:00:00.000Z', budget.nextCentralMidnight(Date.UTC(2026, 9, 6, 13, 30)).toISOString());
  check('in winter (CST) the reset is 06:00 UTC', budget.nextCentralMidnight(Date.UTC(2026, 11, 1, 18, 0)).toISOString() === '2026-12-02T06:00:00.000Z');
  check('rows are keyed "ct:<day>" so the LLM ledger (bare UTC dates) never reads or resets them', budget.brightDataBudgetDayKey('2026-10-06') === 'ct:2026-10-06');

  // ── 3. the cap ──────────────────────────────────────────────────────────
  console.log('\n── daily cap ──');
  const env3 = { BRIGHT_DATA_DAILY_REQUEST_CAP: '3' } as NodeJS.ProcessEnv;
  const t0 = Date.UTC(2026, 9, 6, 14, 0);
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
  try {
    let store = memoryStore();
    budget.__setBrightDataBudgetStoreForTests(store);
    const r = [];
    for (let i = 0; i < 6; i++) r.push(await budget.reserveBrightDataRequest(t0, env3));
    check('the first 3 requests of the day are allowed', r.slice(0, 3).every((x) => x.allowed), r);
    check('the 4th and later are refused', r.slice(3).every((x) => !x.allowed), r);
    check('the persisted count never exceeds the cap', store.rows.get('ct:2026-10-06') === 3, [...store.rows]);
    check('once the cap is reached, refusals make no database round trip', store.increments === 3, store.increments);
    check('exactly one warning names the cap and midnight CT', warnings.filter((w) => /cap reached/.test(w)).length === 1 && /midnight CT/.test(warnings.join(' ')), warnings);

    // Restart: same database, fresh process state.
    budget.__setBrightDataBudgetStoreForTests(store);
    const afterRestart = await budget.reserveBrightDataRequest(t0 + 60_000, env3);
    check('a restart does not grant a new allowance (count survives in the database)', !afterRestart.allowed && store.rows.get('ct:2026-10-06') === 3, { afterRestart, rows: [...store.rows] });

    const nextDay = await budget.reserveBrightDataRequest(Date.UTC(2026, 9, 7, 5, 1), env3);
    check('after midnight CT the cap resets', nextDay.allowed && nextDay.day === '2026-10-07' && store.rows.get('ct:2026-10-07') === 1, nextDay);

    // Concurrency: 10 at once against a cap of 5.
    store = memoryStore();
    budget.__setBrightDataBudgetStoreForTests(store);
    const env5 = { BRIGHT_DATA_DAILY_REQUEST_CAP: '5' } as NodeJS.ProcessEnv;
    const par = await Promise.all(Array.from({ length: 10 }, () => budget.reserveBrightDataRequest(t0, env5)));
    check('10 concurrent searches against a cap of 5 send exactly 5', par.filter((x) => x.allowed).length === 5 && store.rows.get('ct:2026-10-06') === 5, { allowed: par.filter((x) => x.allowed).length, rows: [...store.rows] });

    // Database down: in-memory counting still enforces the cap.
    store = memoryStore();
    store.fail = true;
    budget.__setBrightDataBudgetStoreForTests(store);
    const down = [];
    for (let i = 0; i < 4; i++) down.push(await budget.reserveBrightDataRequest(t0, env3));
    check('with the database unreachable the cap still holds in memory', down.filter((x) => x.allowed).length === 3, down);

    store = memoryStore();
    budget.__setBrightDataBudgetStoreForTests(store);
    const off = await budget.reserveBrightDataRequest(t0, { BRIGHT_DATA_DAILY_REQUEST_CAP: '0' } as NodeJS.ProcessEnv);
    check('cap 0 sends nothing', !off.allowed && store.increments === 0);
  } finally {
    console.warn = origWarn;
  }

  // ── 4. body parsing ─────────────────────────────────────────────────────
  console.log('\n── brd_json parsing ──');
  const googleBody = JSON.stringify({
    general: { search_engine: 'google' },
    organic: [
      { title: 'Jackson Walker LLP', link: 'https://www.jw.com/', description: 'Texas law firm' },
      { title: 'No link' },
      { title: 'Sul Lee Law Firm', link: 'https://sulleelaw.com/', description: '' },
    ],
  });
  const parsed = registry.parseBrightDataGoogleBody(googleBody);
  check('organic results become { title, url, snippet }, entries without a link are skipped', parsed.length === 2 && parsed[0].url === 'https://www.jw.com/' && parsed[0].snippet === 'Texas law firm', parsed);
  check('an empty or HTML body yields no results instead of throwing', registry.parseBrightDataGoogleBody('') .length === 0 && registry.parseBrightDataGoogleBody('<html>') .length === 0 && registry.parseBrightDataGoogleBody(undefined).length === 0);
  check('timeout is 12 s', registry.BRIGHT_DATA_TIMEOUT_MS === 12_000);

  // ── 5. real webSearch, stubbed fetch ────────────────────────────────────
  console.log('\n── webSearch ──');
  const calls: Array<{ url: string; body: any }> = [];
  let innerSeq: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://api.brightdata.com/request') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      const inner = innerSeq.length ? innerSeq.shift()! : 200;
      if (inner !== 200) return new Response(JSON.stringify({ status_code: inner, headers: {}, body: '' }), { status: 200 });
      return new Response(JSON.stringify({ status_code: 200, headers: {}, body: googleBody }), { status: 200 });
    }
    return new Response('<html></html>', { status: 200 });
  }) as typeof fetch;
  for (const key of ['BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY']) delete process.env[key];
  process.env.BRIGHT_DATA_API_KEY = 'guard-only-not-a-key';
  process.env.BRIGHT_DATA_ZONE = 'mcp_unlocker';
  process.env.BRIGHT_DATA_DAILY_REQUEST_CAP = '10';
  const ws = memoryStore();
  budget.__setBrightDataBudgetStoreForTests(ws);
  const tools = registry.createBuiltinTools(root);
  const webSearch = tools.find((t) => t.name === 'webSearch')!;
  const ctx = { agentId: 'guard', workspaceRoot: root, requestApproval: async () => false } as any;

  const ok = (await webSearch.execute({ query: 'law firm Dallas TX official business website', maxResults: 10 }, ctx)) as { provider?: string; results?: Array<{ url: string }> };
  const sent = calls[0]?.body ?? {};
  check('Bright Data results come back from Google', ok.provider === 'brightdata' && ok.results?.[0]?.url === 'https://www.jw.com/', ok);
  check('the request targets Google with brd_json=1&hl=en&gl=us', typeof sent.url === 'string' && sent.url.startsWith('https://www.google.com/search?q=law%20firm%20Dallas') && sent.url.endsWith('&brd_json=1&hl=en&gl=us'), sent);
  check('the request uses the configured zone and sends no data_format', sent.zone === 'mcp_unlocker' && !('data_format' in sent) && sent.format === 'json', sent);
  check('the request was counted against today\'s cap', [...ws.rows.values()][0] === 1, [...ws.rows]);

  const used = () => [...ws.rows.values()][0];
  // A transient inner 502 is retried once; the retry's answer is used.
  innerSeq = [502];
  const before = calls.length;
  const retried = (await webSearch.execute({ query: 'dentist Austin TX official business website', maxResults: 10 }, ctx)) as { provider?: string };
  check('a transient inner 502 is retried once and the retry\'s results are returned', retried.provider === 'brightdata' && calls.length - before === 2, { retried, calls: calls.length - before });
  check('both billed attempts are counted', used() === 3, [...ws.rows]);

  // Both attempts fail: reported as an HTTP status, breaker still closed.
  innerSeq = [502, 502];
  const bad = (await webSearch.execute({ query: 'it services Provo, UT official business website', maxResults: 10 }, ctx)) as { diagnostics?: string[]; error?: string };
  const badText = JSON.stringify(bad);
  check('an inner 502 on every attempt is reported as an HTTP status, not dropped silently', /brightdata: HTTP 502/.test(badText), bad);
  check('a failed attempt is still counted (billed)', used() === 5, [...ws.rows]);
  check(`at most ${registry.BRIGHT_DATA_MAX_ATTEMPTS} attempts per query`, registry.BRIGHT_DATA_MAX_ATTEMPTS === 2);
  innerSeq = [502, 502];
  const second = await webSearch.execute({ query: 'cpa Boise ID official business website', maxResults: 10 }, ctx);
  check('one failed query does not open the shared breaker (the next query is still sent)', !/temporarily skipped by provider circuit breaker/.test(JSON.stringify(second)) && used() === 7, { second, used: used() });

  // Persistent failure: after BRIGHT_DATA_BREAKER_AFTER_FAILURES queries in a row the breaker opens.
  innerSeq = [502, 502];
  await webSearch.execute({ query: 'roofer Tulsa OK official business website', maxResults: 10 }, ctx);
  const callsAtTrip = calls.length;
  const third = (await webSearch.execute({ query: 'insurance Reno, NV official business website', maxResults: 10 }, ctx));
  check(`after ${registry.BRIGHT_DATA_BREAKER_AFTER_FAILURES} failed queries in a row the breaker skips Bright Data instead of spending again`, calls.length === callsAtTrip && /brightdata: temporarily skipped by provider circuit breaker/.test(JSON.stringify(third)) && used() === 9, { calls: calls.length, callsAtTrip, used: used(), third });

  // Concurrency: no more than BRIGHT_DATA_MAX_CONCURRENCY requests in flight.
  {
    registry.__resetWebSearchCooldownsForTests();
    registry.__resetBrightDataFailureStreakForTests();
    process.env.BRIGHT_DATA_DAILY_REQUEST_CAP = '100';
    process.env.BRIGHT_DATA_MAX_CONCURRENCY = '3';
    let inFlight = 0; let peak = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== 'https://api.brightdata.com/request') return new Response('<html></html>', { status: 200 });
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return new Response(JSON.stringify({ status_code: 200, headers: {}, body: googleBody }), { status: 200 });
    }) as typeof fetch;
    const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => webSearch.execute({ query: `concurrency probe ${i} official business website`, maxResults: 5 }, ctx) as Promise<{ provider?: string }>));
    globalThis.fetch = realFetch;
    const served = outs.filter((o) => o.provider === 'brightdata').length;
    check('10 concurrent searches never put more than 3 Bright Data requests in flight', peak === 3, { peak, served });
    check('queued searches still complete (none dropped by the limit)', served === 10, { served });
    check('default concurrency is 3; garbage falls back to it', registry.brightDataMaxConcurrency({}) === 3 && registry.brightDataMaxConcurrency({ BRIGHT_DATA_MAX_CONCURRENCY: 'x' }) === 3 && registry.brightDataMaxConcurrency({ BRIGHT_DATA_MAX_CONCURRENCY: '5' }) === 5);
    check('no slot leaks after the burst', registry.__brightDataConcurrencyForTests().inFlight === 0 && registry.__brightDataConcurrencyForTests().waiting === 0, registry.__brightDataConcurrencyForTests());
  }

  const capMsg = 'All lead discovery sources returned zero for "us news Mesa, AZ". brave: BRAVE_SEARCH_API_KEY not set | serper: SERPER_API_KEY not set | brightdata: daily request cap reached (2000/2000); resumes at midnight CT';
  const capCls = capacity.classifyLeadDiscoveryFailure(capMsg);
  check('the cap is lost capacity (provider outage), not a segment failure', capCls.providerOutage && capCls.unavailable.some((u) => u.source === 'brightdata' && /cap/.test(u.reason ?? '')), capCls);
  check('so the runner pauses and keeps the segment instead of closing it', runner.decideSegmentFailure({ message: capMsg, attempts: 1, maxAttempts: 3 }).kind === 'capacity_pause');
  const upstreamMsg = 'All lead discovery sources returned zero for "q". serper: SERPER_API_KEY not set | brightdata: HTTP 502 (upstream status behind Bright Data 200)';
  check('an upstream 502 behind Bright Data is classified as a provider error', capacity.classifyLeadDiscoveryFailure(upstreamMsg).providerOutage);

  // ── 6. source guards ────────────────────────────────────────────────────
  console.log('\n── source ──');
  const src = readFileSync(path.join(root, 'packages/core/src/tool-registry.ts'), 'utf8');
  const block = src.slice(src.indexOf('Strategy 1c: Bright Data'), src.indexOf('Strategy 2: DuckDuckGo'));
  check('no Bing + data_format request remains', !/bing\.com/.test(block) && !/data_format/.test(block.replace(/\/\/.*$/gm, '')));
  check('every request reserves a cap slot before fetch', block.indexOf('reserveBrightDataRequest()') > 0 && block.indexOf('reserveBrightDataRequest()') < block.indexOf("fetch('https://api.brightdata.com/request'"));

  budget.__setBrightDataBudgetStoreForTests(null);
  console.log(failures === 0 ? '\n✅ Bright Data unlocker search and daily cap behave as specified.\n' : `\n❌ ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

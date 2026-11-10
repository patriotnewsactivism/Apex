/**
 * Guard: Google Places spend caps, the monthly warning, sweep skip, and the
 * Atmosphere field-mask rule. No network, no database, no model.
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
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail, null, 2).slice(0, 1500)}`);
}

const NOW = Date.UTC(2026, 10, 10, 14, 30, 0);

async function main(): Promise<void> {
  console.log('Verifying Google Places spend guards...\n');

  const budget = (await import(
    path.join(root, 'packages/core/src/google-places-budget.ts')
  )) as typeof import('../packages/core/src/google-places-budget.js');
  const capacity = (await import(
    path.join(root, 'packages/background-jobs/src/lead-search-capacity.ts')
  )) as typeof import('../packages/background-jobs/src/lead-search-capacity.js');
  const runner = (await import(
    path.join(root, 'packages/background-jobs/src/campaign-runner.ts')
  )) as typeof import('../packages/background-jobs/src/campaign-runner.js');

  console.log('── defaults and env ──');
  check('daily cap defaults to 10', budget.googlePlacesDailyRequestCap({}) === 10);
  check('monthly free cap defaults to 1000', budget.googlePlacesMonthlyFreeCap({}) === 1000);
  check('monthly warning defaults to 500', budget.googlePlacesMonthlyWarnAt({}) === 500);
  check('max pages defaults to 1', budget.googlePlacesMaxPages({}) === 1);
  check('sweeps are off by default', budget.googlePlacesSweepsEnabled({}) === false);
  check('over-free-cap override is off by default', budget.googlePlacesAllowOverFreeCap({}) === false);
  check('invalid env falls back', budget.googlePlacesDailyRequestCap({ GOOGLE_PLACES_DAILY_REQUEST_CAP: 'nope' }) === 10);
  check('warn-at is configurable', budget.googlePlacesMonthlyWarnAt({ GOOGLE_PLACES_MONTHLY_WARN_AT: '200' }) === 200);
  check('sweeps enable with true', budget.googlePlacesSweepsEnabled({ GOOGLE_PLACES_SWEEPS_ENABLED: 'true' }) === true);

  console.log('\n── Atmosphere field mask ──');
  check('current mask has no Atmosphere fields', budget.atmosphereFieldsInMask(budget.GOOGLE_PLACES_FIELD_MASK).length === 0);
  check(
    'the guard fails if reviews is added',
    budget.atmosphereFieldsInMask([...budget.GOOGLE_PLACES_FIELD_MASK, 'places.reviews']).includes('reviews'),
  );
  check('Atmosphere list includes editorialSummary and generativeSummary',
    budget.GOOGLE_PLACES_ATMOSPHERE_FIELDS.includes('editorialSummary') &&
    budget.GOOGLE_PLACES_ATMOSPHERE_FIELDS.includes('generativeSummary') &&
    budget.GOOGLE_PLACES_ATMOSPHERE_FIELDS.includes('takeout'));

  const store = (() => {
    const rows = new Map<string, number>();
    return {
      rows,
      async increment(day: string, account: string) {
        const k = `${day}|${account}`;
        const v = (rows.get(k) ?? 0) + 1;
        rows.set(k, v);
        return v;
      },
      async decrement(day: string, account: string) {
        const k = `${day}|${account}`;
        rows.set(k, Math.max(0, (rows.get(k) ?? 0) - 1));
      },
      async read(day: string, account: string) {
        return rows.get(`${day}|${account}`) ?? 0;
      },
    };
  })();
  const warnings: Array<{ used: number; message: string }> = [];
  budget.__setGooglePlacesBudgetStoreForTests(store);
  budget.__setGooglePlacesWarningSinkForTests({ warn: (w) => { warnings.push(w); } });

  console.log('\n── page-level daily and monthly counting ──');
  const envTen = { GOOGLE_PLACES_DAILY_REQUEST_CAP: '10', GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000' };
  const first = await budget.reserveGooglePlacesRequest({ query: 'hvac dallas', now: NOW, env: envTen });
  const second = await budget.reserveGooglePlacesRequest({ query: 'hvac austin', now: NOW, env: envTen });
  check('each page increments the UTC day and month counts', first.allowed && second.allowed && first.dayCount === 1 && second.dayCount === 2 && second.monthCount === 2, { first, second });
  check('counts are stored under utc: and mo: prefixes',
    store.rows.get(`${budget.googlePlacesDailyDayKey('2026-11-10')}|${budget.GOOGLE_PLACES_DAILY_ACCOUNT}`) === 2 &&
    store.rows.get(`${budget.googlePlacesMonthlyDayKey('2026-11')}|${budget.GOOGLE_PLACES_MONTHLY_ACCOUNT}`) === 2,
    [...store.rows.entries()]);

  budget.__resetGooglePlacesBudgetForTests();
  budget.__setGooglePlacesBudgetStoreForTests(store);
  budget.__setGooglePlacesWarningSinkForTests({ warn: (w) => { warnings.push(w); } });
  store.rows.clear();

  const envTwo = { GOOGLE_PLACES_DAILY_REQUEST_CAP: '2', GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000' };
  await budget.reserveGooglePlacesRequest({ now: NOW, env: envTwo });
  await budget.reserveGooglePlacesRequest({ now: NOW, env: envTwo });
  const dailyStop = await budget.reserveGooglePlacesRequest({ now: NOW, env: envTwo });
  check('daily cap returns google: daily cap reached and rolls back the extra page',
    !dailyStop.allowed && dailyStop.note === budget.GOOGLE_PLACES_DAILY_CAP_NOTE &&
    (await store.read(budget.googlePlacesDailyDayKey('2026-11-10'), budget.GOOGLE_PLACES_DAILY_ACCOUNT)) === 2,
    dailyStop);

  console.log('\n── monthly warning at 500 and stop at 1000 ──');
  budget.__resetGooglePlacesBudgetForTests();
  store.rows.clear();
  warnings.length = 0;
  budget.__setGooglePlacesBudgetStoreForTests(store);
  budget.__setGooglePlacesWarningSinkForTests({ warn: (w) => { warnings.push(w); } });
  store.rows.set(`${budget.googlePlacesMonthlyDayKey('2026-11')}|${budget.GOOGLE_PLACES_MONTHLY_ACCOUNT}`, 498);
  const warnEnv = { GOOGLE_PLACES_DAILY_REQUEST_CAP: '100', GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000', GOOGLE_PLACES_MONTHLY_WARN_AT: '500' };
  const before = await budget.reserveGooglePlacesRequest({ now: NOW, env: warnEnv });
  check('no warning below 500', before.allowed && before.monthCount === 499 && warnings.length === 0, { before, warnings });
  const atWarn = await budget.reserveGooglePlacesRequest({ now: NOW, env: warnEnv });
  check('warns once at 500', atWarn.monthCount === 500 && warnings.length === 1 && /500\/1000/.test(warnings[0]!.message), warnings);
  await budget.reserveGooglePlacesRequest({ now: NOW, env: warnEnv });
  check('the 500 warning is not repeated', warnings.length === 1);

  budget.__resetGooglePlacesBudgetForTests();
  store.rows.clear();
  budget.__setGooglePlacesBudgetStoreForTests(store);
  budget.__setGooglePlacesWarningSinkForTests({ warn: () => undefined });
  store.rows.set(`${budget.googlePlacesMonthlyDayKey('2026-11')}|${budget.GOOGLE_PLACES_MONTHLY_ACCOUNT}`, 999);
  const monthEnv = { GOOGLE_PLACES_DAILY_REQUEST_CAP: '100', GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000' };
  const atCap = await budget.reserveGooglePlacesRequest({ now: NOW, env: monthEnv });
  const over = await budget.reserveGooglePlacesRequest({ now: NOW, env: monthEnv });
  check('stops at 1000 with google: monthly free cap reached',
    atCap.allowed && atCap.monthCount === 1000 && !over.allowed && over.note === budget.GOOGLE_PLACES_MONTHLY_CAP_NOTE,
    { atCap, over });
  check('the refused monthly page is not counted',
    (await store.read(budget.googlePlacesMonthlyDayKey('2026-11'), budget.GOOGLE_PLACES_MONTHLY_ACCOUNT)) === 1000);

  budget.__setGooglePlacesBudgetStoreForTests(store);
  const overEnv = { GOOGLE_PLACES_DAILY_REQUEST_CAP: '100', GOOGLE_PLACES_MONTHLY_FREE_CAP: '1000', GOOGLE_PLACES_ALLOW_OVER_FREE_CAP: 'true' };
  const allowedOver = await budget.reserveGooglePlacesRequest({ now: NOW, env: overEnv });
  check('GOOGLE_PLACES_ALLOW_OVER_FREE_CAP=true allows requests past 1000', allowedOver.allowed && allowedOver.monthCount === 1001, allowedOver);

  console.log('\n── ledger failure, query masking, sweep skip ──');
  budget.__setGooglePlacesBudgetStoreForTests({
    increment: async () => { throw new Error('db down'); },
    decrement: async () => undefined,
    read: async () => { throw new Error('db down'); },
  });
  const closed = await budget.reserveGooglePlacesRequest({ now: NOW, env: {} });
  check('unreachable ledger fails closed as not-configured',
    !closed.allowed && closed.note === budget.GOOGLE_PLACES_LEDGER_UNAVAILABLE_NOTE, closed);

  const masked = budget.maskGooglePlacesQuery('hvac contractor Dallas Texas after hours answering service');
  check('billed-request log mask has no key and a short hash',
    masked.hash.length === 12 && masked.truncated.length <= 48 && !masked.truncated.includes('AIza'));

  check('campaign runner is a sweep', budget.isGooglePlacesSweepRequest({ agentId: 'apex-campaign-runner' }));
  check('explicit sweep flag is a sweep', budget.isGooglePlacesSweepRequest({ sweep: true }));
  check('lead-gen sweep title is a sweep', budget.isGooglePlacesSweepRequest({ taskTitle: 'Lead generation sweep' }));
  check('on-demand lookups are not sweeps', !budget.isGooglePlacesSweepRequest({ agentId: 'operator-chat' }));
  check('sweeps skip Google while the flag is off', budget.shouldSkipGooglePlacesForSweep({ sweep: true }, {}));
  check('sweeps may use Google when the flag is on', !budget.shouldSkipGooglePlacesForSweep({ sweep: true }, { GOOGLE_PLACES_SWEEPS_ENABLED: 'true' }));

  console.log('\n── not-configured treatment (no outage, no campaign error) ──');
  for (const note of [
    budget.GOOGLE_PLACES_DAILY_CAP_NOTE,
    budget.GOOGLE_PLACES_MONTHLY_CAP_NOTE,
    budget.GOOGLE_PLACES_SWEEPS_DISABLED_NOTE,
    budget.GOOGLE_PLACES_LEDGER_UNAVAILABLE_NOTE,
  ]) {
    const message = capacity.discoveryZeroMessage('hvac Dallas, TX', [
      'yelp: YELP_API_KEY not set',
      note,
      'tomtom: TOMTOM_API_KEY not set',
      'brave: BRAVE_SEARCH_API_KEY not set',
    ]);
    const classified = capacity.classifyLeadDiscoveryFailure(message);
    const decision = runner.decideSegmentFailure({ message, attempts: 1, maxAttempts: 3 });
    check(`${note} is not a provider outage`, !classified.providerOutage && classified.unavailable.length === 0, classified);
    check(`${note} does not capacity-pause the campaign`, decision.kind !== 'capacity_pause', decision);
  }

  budget.__resetGooglePlacesBudgetForTests();
  console.log(failures === 0 ? '\n✅ Google Places spend guards behave as specified.\n' : `\n❌ ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Guard: Yelp / Google Places keys are checked before use, and a bad key
 * switches its provider off quietly instead of failing every campaign search.
 *
 * 2026-10-06: YELP_API_KEY (applied from Settings) was 12 characters long. Yelp
 * Fusion keys are 128-character tokens, so every directory search got HTTP 400
 * VALIDATION_ERROR, whose body echoes "Bearer <value>". That text reached the
 * logs and campaign_segments.last_error.
 *
 * Covers: missing key, malformed key, valid-format key, a runtime 400/401
 * disabling the provider once, redaction, the warning being logged once, the
 * runner treating a disabled provider as absent, and the "all providers
 * unavailable" pause still working. No network, no database.
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

const VALID_YELP = `${'Ab3_-'.repeat(24)}Ab3_xyz9`; // 120 + 8 = 128 chars
const VALID_GOOGLE = `AIza${'Sy0_-'.repeat(7)}`; // 4 + 35 chars
const BAD_YELP = 'p@ssw0rd87$$'; // 12 chars, the shape found in production

async function main(): Promise<void> {
  console.log('Verifying directory provider key gating...\n');
  const keys = (await import(path.join(root, 'packages/core/src/lead-provider-keys.ts'))) as typeof import('../packages/core/src/lead-provider-keys.js');
  const registry = (await import(path.join(root, 'packages/core/src/tool-registry.ts'))) as typeof import('../packages/core/src/tool-registry.js');
  const capacity = (await import(path.join(root, 'packages/background-jobs/src/lead-search-capacity.ts'))) as typeof import('../packages/background-jobs/src/lead-search-capacity.js');
  const runner = (await import(path.join(root, 'packages/background-jobs/src/campaign-runner.ts'))) as typeof import('../packages/background-jobs/src/campaign-runner.js');

  check('fixture: valid Yelp fake is 128 chars', VALID_YELP.length === 128);
  check('fixture: valid Google fake is 39 chars', VALID_GOOGLE.length === 39);

  // ── Format checks ──────────────────────────────────────────────────────
  console.log('── format checks ──');
  check('missing Yelp key → disabled as "not set"', keys.validateYelpApiKey(undefined).reason === 'YELP_API_KEY not set');
  check('blank Yelp key → disabled as "not set"', keys.validateYelpApiKey('   ').key === null);
  const bad = keys.validateYelpApiKey(BAD_YELP);
  check('12-char Yelp key with "$" → disabled with a reason', bad.key === null && /not a Yelp Fusion API key/.test(bad.reason ?? '') && /12 characters/.test(bad.reason ?? ''), bad);
  check('the reason never contains the key', !(bad.reason ?? '').includes(BAD_YELP) && !(bad.masked ?? '').includes('87$$'), bad);
  check('a short key shows no characters at all', bad.masked === '12 chars, too short to show any', bad.masked);
  check('127-char Yelp key → disabled', keys.validateYelpApiKey(VALID_YELP.slice(1)).key === null);
  check('valid-format Yelp key → usable', keys.validateYelpApiKey(VALID_YELP).key === VALID_YELP);
  check('"Bearer <key>" pasted with quotes is normalised', keys.validateYelpApiKey(` "Bearer ${VALID_YELP}" `).key === VALID_YELP);
  check('valid-format key is masked to the last 4', keys.validateYelpApiKey(VALID_YELP).masked === '…xyz9');
  check('missing Google key → disabled as "not set"', keys.validateGooglePlacesApiKey('').reason === 'GOOGLE_PLACES_API_KEY not set');
  check('malformed Google key → disabled', keys.validateGooglePlacesApiKey('guard-only-not-a-key').key === null);
  check('valid-format Google key → usable', keys.validateGooglePlacesApiKey(VALID_GOOGLE).key === VALID_GOOGLE);
  process.env.LEAD_PROVIDER_KEY_FORMAT_CHECK = 'off';
  check('LEAD_PROVIDER_KEY_FORMAT_CHECK=off skips the format check (escape hatch)', keys.validateYelpApiKey(BAD_YELP).key === BAD_YELP);
  delete process.env.LEAD_PROVIDER_KEY_FORMAT_CHECK;

  // ── The real tool, stubbed network ────────────────────────────────────
  console.log('\n── searchBusinessDirectory ──');
  const warnings: string[] = [];
  keys.resetDirectoryProviderKeyState((m) => warnings.push(m));
  const fetched: string[] = [];
  let yelpResponse: () => Response = () => new Response(JSON.stringify({ businesses: [] }), { status: 200 });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    if (url.startsWith('https://api.yelp.com/')) return yelpResponse();
    if (url.startsWith('https://places.googleapis.com/')) return new Response(JSON.stringify({ places: [] }), { status: 200 });
    // Nominatim / Overpass: nothing, so the directory falls through to "none".
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  for (const key of ['TOMTOM_API_KEY', 'GOOGLE_PLACES_API_KEY']) delete process.env[key];
  process.env.YELP_API_KEY = BAD_YELP;
  const tools = registry.createBuiltinTools(root);
  const directory = tools.find((t) => t.name === 'searchBusinessDirectory')!;
  const ctx = { agentId: 'guard', workspaceRoot: root, requestApproval: async () => false } as any;
  type DirOut = { attempts?: string[]; provider?: string };
  const yelpCalls = () => fetched.filter((u) => u.startsWith('https://api.yelp.com/')).length;

  const d1 = (await directory.execute({ query: 'xyzzy consultants Boise, ID' }, ctx)) as DirOut;
  const d2 = (await directory.execute({ query: 'xyzzy consultants Reno, NV' }, ctx)) as DirOut;
  check('a malformed Yelp key sends no request to Yelp', yelpCalls() === 0, fetched);
  const yelpAttempt = (d1.attempts ?? []).find((a) => a.startsWith('yelp:')) ?? '';
  check('the attempt says the key is treated as not set', /^yelp: disabled, YELP_API_KEY treated as not set: /.test(yelpAttempt), d1.attempts);
  check('and never contains the key', !JSON.stringify([d1, d2]).includes(BAD_YELP));
  check('one warning for two searches', warnings.filter((w) => w.startsWith('[lead-provider] yelp disabled:')).length === 1, warnings);
  check('a missing Google key is still reported as "not set" with no warning spam', (d1.attempts ?? []).includes('google: GOOGLE_PLACES_API_KEY not set') && warnings.filter((w) => w.includes('google disabled')).length <= 1, { attempts: d1.attempts, warnings });
  check('runner sees Yelp as unusable', keys.directoryProviderUsable('yelp') === false);

  // Classifier: a disabled provider is unconfigured, so it never causes a pause.
  const disabledMsg = capacity.discoveryZeroMessage('xyzzy consultants Boise, ID', [
    'brave: BRAVE_SEARCH_API_KEY not set',
    ...(d1.attempts ?? []),
  ]);
  const disabledNotes = capacity.parseDiscoveryNotes(disabledMsg);
  check('classifier: disabled Yelp is "unconfigured"', disabledNotes.find((n) => n.source === 'yelp')?.state === 'unconfigured', disabledNotes);
  check('classifier: no outage, so no pause', capacity.classifyLeadDiscoveryFailure(disabledMsg).providerOutage === false);
  check('runner: with every source absent and no OSM category, it is still a deterministic failure (no retries charged)',
    runner.isDeterministicFailure(`${disabledMsg} | tomtom: TOMTOM_API_KEY not set | OSM: no known category tag for "x"`) === true);

  // Runtime rejection: valid-looking key, Yelp says 400 about Authorization.
  warnings.length = 0;
  process.env.YELP_API_KEY = VALID_YELP;
  check('a valid-format key re-enables Yelp without a restart', keys.directoryProviderUsable('yelp') === true);
  yelpResponse = () => new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', description: `'Bearer ${VALID_YELP}' does not match '^(?i)Bearer [A-Za-z0-9\\-\\_]{128}$'`, field: 'Authorization', instance: `Bearer ${VALID_YELP}` } }), { status: 400 });
  const before = yelpCalls();
  const r1 = (await directory.execute({ query: 'xyzzy consultants Fargo, ND' }, ctx)) as DirOut;
  const r2 = (await directory.execute({ query: 'xyzzy consultants Omaha, NE' }, ctx)) as DirOut;
  const r3 = (await directory.execute({ query: 'xyzzy consultants Tulsa, OK' }, ctx)) as DirOut;
  check('runtime 400 (Authorization) → exactly one Yelp request, then skipped', yelpCalls() - before === 1, fetched.slice(before));
  check('one warning for the runtime rejection', warnings.filter((w) => w.startsWith('[lead-provider] yelp disabled: Yelp rejected YELP_API_KEY (HTTP 400')).length === 1 && warnings.length === 1, warnings);
  check('the echoed key is redacted everywhere', !JSON.stringify([r1, r2, r3, warnings]).includes(VALID_YELP), [r1.attempts, warnings]);
  check('the rejected call itself is reported as "treated as not set" (no outage, no retry)', (r1.attempts ?? []).some((a) => a.startsWith('yelp: disabled, YELP_API_KEY treated as not set: Yelp rejected')), r1.attempts);
  check('later calls say the same', (r3.attempts ?? []).some((a) => a.startsWith('yelp: disabled, YELP_API_KEY treated as not set')), r3.attempts);

  // 401 and a non-auth 400.
  check('401 is an auth failure', keys.isDirectoryAuthFailure('yelp', 401, '{"error":{"code":"TOKEN_INVALID"}}'));
  check('a 400 LOCATION_NOT_FOUND is NOT an auth failure', !keys.isDirectoryAuthFailure('yelp', 400, '{"error":{"code":"LOCATION_NOT_FOUND","description":"Could not execute search, try specifying a more exact location."}}'));
  check('Google 400 "API key not valid" is an auth failure', keys.isDirectoryAuthFailure('google', 400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'));
  check('Google 429 is not (it is capacity, handled by the pause)', !keys.isDirectoryAuthFailure('google', 429, 'RESOURCE_EXHAUSTED'));
  check('redaction strips Bearer tokens and ?key=', keys.redactProviderBody('x Bearer abc.def y ?key=AIzaZZZ&z=1', null) === 'x Bearer [redacted] y ?key=[redacted]&z=1');

  // A new key value after a runtime rejection gets a fresh chance.
  process.env.YELP_API_KEY = VALID_YELP.replace(/^A/, 'B');
  check('changing the key clears the runtime disable', keys.directoryProviderUsable('yelp') === true);

  // ── "All providers unavailable" still pauses ──────────────────────────
  console.log('\n── outage path ──');
  const outage = capacity.discoveryZeroMessage('us news Birmingham, AL', [
    'brave: HTTP 402 {"detail":"Prepaid credit balance is insufficient"}',
    'serper: HTTP 400 {"message":"Not enough credits","statusCode":400}',
    'brightdata: The operation was aborted due to timeout',
    'yelp: disabled, YELP_API_KEY treated as not set: YELP_API_KEY is not a Yelp Fusion API key (expected a 128-character token of A-Z a-z 0-9 _ -; got 12 characters)',
    'google: GOOGLE_PLACES_API_KEY not set',
  ]);
  const oc = capacity.classifyLeadDiscoveryFailure(outage);
  check('paid sources down + Yelp disabled → still a provider outage', oc.providerOutage && !oc.unavailable.some((u) => u.source === 'yelp'), oc);
  check('→ capacity pause, attempt not charged', runner.decideSegmentFailure({ message: outage, attempts: 1, maxAttempts: 3 }).kind === 'capacity_pause');

  console.log(failures === 0 ? '\n✅ Directory provider keys are gated, logged once, and never leak.\n' : `\n❌ ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Guard: APEX must meter LLM REQUESTS, not only tokens.
 *
 * Production evidence (2026-09). APEX was issuing roughly 5,000 LLM requests a
 * day against an OpenRouter free-tier allowance of 3,000 (three accounts at
 * 1,000/day each). Nothing in the process noticed, because every cap, pacing
 * window and capacity pause it had was denominated in TOKENS, and the
 * allowance that was actually running out is denominated in REQUESTS — a
 * fixed number of calls per account per UTC day, whatever their size. A
 * workspace can sit at 2% of every token cap it owns and still be refused.
 *
 * So the invariant is not "there is a counter somewhere". It is that the
 * request budget is *load-bearing on the hot path*: counted on every attempt
 * including failures, checked before a request is issued, checked again before
 * an agent claims a task, hydrated from Postgres at boot, and visible without
 * credentials. Drop any one of those and the overrun becomes invisible again
 * in a different way:
 *
 *   · count successes only  -> the fallback cascade, the traffic most worth
 *                              seeing, is exactly what goes unmeasured;
 *   · no check in complete() -> the budget is a report, not a budget;
 *   · no check in the claim path -> agents pay full task-setup cost to
 *                              discover there was no allowance (capacity spin);
 *   · memory-only           -> every Cloud Run deploy hands the workforce a
 *                              fresh full day's allowance;
 *   · behind admin auth     -> the number nobody could see is the reason this
 *                              ran unnoticed for weeks.
 *
 * The pacing checks below run the real exported function rather than matching
 * source text, so a rewrite that preserves the behaviour keeps passing.
 */
import fs from 'node:fs';
import os from 'node:os';
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

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

async function main(): Promise<void> {
  console.log('Verifying the LLM request budget...\n');

  const ledger = read('packages/core/src/request-ledger.ts');
  const client = read('packages/core/src/llm-client.ts');
  const health = read('packages/api-server/src/index.ts');
  const bootstrap = read('packages/api-server/src/runtime-bootstrap.ts');

  // ── The counter exists and counts the right thing ────────────────────────
  check(
    'request-ledger.ts exports a workspace request budget',
    /export function isRequestBudgetExhausted/.test(ledger) &&
      /export function requestCapacityWindow/.test(ledger),
  );

  // Both call sites, success and failure. The failure one is the whole point:
  // a 429 spent the allowance just as surely as a 200 did.
  const recordCalls = client.match(/recordProviderRequest\(/g) ?? [];
  check(
    'every upstream attempt is counted — success AND failure paths',
    recordCalls.length >= 2 &&
      /recordProviderRequest\(credential\.key, true\)/.test(client) &&
      /recordProviderRequest\(credential\.key, false\)/.test(client),
    { callSites: recordCalls.length },
  );

  // Spend is grouped by a fingerprint of the KEY, not the env var name. APEX
  // reads OpenRouter keys from five env names across three real accounts, so
  // env-name keying would split one account across rows and let two 1,000-caps
  // authorize 2,000 requests against an account that allows 1,000. Duplicate
  // env names holding the same key must collapse to one retry bucket.
  check(
    'accounts are grouped by credential, not by env var name',
    /recordProviderRequest\(credential\.key/.test(client) &&
      /accountCapacityWindow\(credential\.key\)/.test(client),
  );
  check(
    'the key fingerprint is never reported — /health shows env names',
    /account: envNames\.length > 0 \? envNames\.join/.test(ledger) &&
      !/account: fingerprint/.test(ledger),
  );
  check(
    'the strictest cap wins when several env names hold one key',
    /Math\.min\(\.\.\.applicable\)/.test(ledger),
  );

  // The failure counter has to sit in the catch block that handles a provider
  // error, not somewhere that only runs on a clean path.
  const catchBlock = client.slice(
    client.indexOf('recordProviderRequest(credential.key, false)'),
    client.indexOf('recordProviderRequest(credential.key, false)') + 400,
  );
  check(
    'the failure counter is inside the provider catch block',
    catchBlock.includes('error as ProviderRequestError'),
  );

  // ── It gates, rather than merely reporting ───────────────────────────────
  const completeBody = client.slice(client.indexOf('  async complete('));
  const gateIndex = completeBody.indexOf('isRequestBudgetExhausted()');
  const firstCallIndex = completeBody.indexOf('await callCompatibleProvider(');
  check(
    'complete() checks the budget before issuing any request',
    gateIndex > -1 && firstCallIndex > -1 && gateIndex < firstCallIndex,
    { gateIndex, firstCallIndex },
  );
  // Order alone is not enough. `if (false && isRequestBudgetExhausted())` keeps
  // the call in the right place and disables the budget entirely — this guard
  // passed that sabotage until the condition and the throw were both asserted.
  check(
    'an exhausted budget actually refuses the call, rather than being observed',
    /if \(isRequestBudgetExhausted\(\)\) \{[\s\S]{0,400}?throw capacityPauseError\(/.test(
      completeBody,
    ),
  );
  check(
    'complete() also honours the pacing ramp, not just the hard cap',
    /const requestWindow = requestCapacityWindow\(\);[\s\S]{0,80}if \(!requestWindow\.allowed\) \{[\s\S]{0,400}?throw capacityPauseError\(/.test(
      completeBody,
    ),
  );

  // Claiming a task the workspace cannot afford to run is the capacity-spin
  // failure the diagnostics endpoint already counts deferrals for.
  const capacityProbe = client.slice(
    client.indexOf('export function llmCapacityAvailableNow('),
  );
  const probeBody = capacityProbe.slice(0, capacityProbe.indexOf('\n}\n'));
  check(
    'llmCapacityAvailableNow() consults the request budget before claiming',
    /requestCapacityWindow\(now\)\.allowed/.test(probeBody),
  );

  // ── It survives a restart ────────────────────────────────────────────────
  check(
    'the ledger hydrates from Postgres at boot',
    /initializeRequestLedgerPersistence/.test(bootstrap) &&
      /export async function initializeRequestLedgerPersistence/.test(ledger),
  );
  check(
    'a durable table backs it',
    /llm_request_usage_daily/.test(read('lib/db/src/client.ts')) &&
      /llmRequestUsageDaily/.test(read('lib/db/src/schema.ts')),
  );

  // ── It is visible without credentials ────────────────────────────────────
  const healthHandler = health.slice(
    health.indexOf('const requestLedger = getRequestLedgerSnapshot()'),
  );
  check(
    'burn rate is reported on the unauthenticated /health payload',
    /llmRequests: \{/.test(healthHandler) &&
      /projected: requestLedger\.projectedDailyRequests/.test(healthHandler),
  );
  check(
    'an exhausted request budget shows as capped/workforce_paused, not "available"',
    /requestLedger\.totalCapReached/.test(health) &&
      /!requestLedger\.pacing\.total\.allowed/.test(health),
  );

  // ── The pacing maths actually paces ──────────────────────────────────────
  // Recording below would otherwise land in the real ledger file.
  process.env.APEX_REQUEST_LEDGER_PATH = path.join(
    os.tmpdir(),
    `apex-request-budget-guard-${process.pid}.json`,
  );
  const ledgerModule = (await import(
    path.join(root, 'packages/core/src/request-ledger.ts')
  )) as typeof import('../packages/core/src/request-ledger.js');
  const { calculateRequestCapacityWindow } = ledgerModule;

  const dayStart = Date.UTC(2026, 8, 12);
  const noon = dayStart + 12 * 60 * 60 * 1000;
  const args = { cap: 2600, burstRequests: 150, pacingEnabled: true, requestedRequests: 1 };

  // A workspace that has already spent the whole allowance is refused, and
  // told to come back at the UTC rollover rather than in a minute.
  const spent = calculateRequestCapacityWindow({ ...args, usedRequests: 2600, at: noon });
  check(
    'a spent budget is refused and resumes at the UTC rollover',
    !spent.allowed &&
      spent.reason === 'daily_cap' &&
      spent.resumeAt === new Date(dayStart + 24 * 60 * 60 * 1000).toISOString(),
    spent,
  );

  // The pacing ramp is the part that slows agents down rather than stopping
  // them: by noon roughly half the allowance has been released, so a workspace
  // that already burned most of it waits instead of sprinting on.
  const released = calculateRequestCapacityWindow({ ...args, usedRequests: 0, at: noon });
  check(
    'about half the allowance is released by noon UTC',
    released.pacingAllowance > 1200 && released.pacingAllowance < 1500,
    { pacingAllowance: released.pacingAllowance },
  );
  const ahead = calculateRequestCapacityWindow({ ...args, usedRequests: 2000, at: noon });
  check(
    'running ahead of the ramp is paced, not hard-capped',
    !ahead.allowed && ahead.reason === 'paced' && Date.parse(ahead.resumeAt ?? '') > noon,
    ahead,
  );

  // A restart at 00:05 must still be able to do real work immediately.
  const justAfterMidnight = calculateRequestCapacityWindow({
    ...args,
    usedRequests: 0,
    at: dayStart + 5 * 60 * 1000,
  });
  check(
    'the burst lets a restart work immediately at the start of a UTC day',
    justAfterMidnight.allowed && justAfterMidnight.pacingAllowance >= 150,
    { pacingAllowance: justAfterMidnight.pacingAllowance },
  );

  // Turning pacing off must still respect the hard cap.
  const unpaced = calculateRequestCapacityWindow({
    ...args,
    pacingEnabled: false,
    usedRequests: 2599,
    at: dayStart + 60_000,
  });
  check(
    'disabling pacing releases the full cap but never exceeds it',
    unpaced.allowed &&
      unpaced.pacingAllowance === 2600 &&
      !calculateRequestCapacityWindow({
        ...args,
        pacingEnabled: false,
        usedRequests: 2600,
        at: dayStart + 60_000,
      }).allowed,
  );

  // cap=0 is the documented opt-out and must not accidentally block anything.
  const uncapped = calculateRequestCapacityWindow({
    cap: 0,
    usedRequests: 999_999,
    at: noon,
  });
  check(
    'cap=0 disables the budget entirely',
    uncapped.allowed && uncapped.reason === 'uncapped',
  );

  // ── Rate, not just total ─────────────────────────────────────────────────
  //
  // A day can be fully under budget and still spent, if it is spent in half an
  // hour. On 2026-09-12 the daily ramp allowed 1,388 requests in 26 minutes —
  // correct per the day's arithmetic, and it tripped OpenRouter's per-minute
  // limiter and parked every provider until the UTC reset.
  check(
    'the workspace window enforces a short-window rate limit, not only a daily cap',
    /rateLimitResumeAt/.test(ledger) &&
      /export function requestsInLastMinute/.test(ledger),
  );
  // Reason and resume-at matter as much as the block: the agent loop sleeps
  // until resumeAt, so mislabelling a 60-second limit as `daily_cap` would park
  // the workforce for hours over something that clears almost immediately.
  const rateBlock = ledger.slice(ledger.indexOf('const resumeAt = rateLimitResumeAt(at);'));
  check(
    'a rate block is reported as `paced` and resumes from the window, not the UTC rollover',
    /reason: 'paced'/.test(rateBlock.slice(0, 500)) &&
      /Math\.max\(at \+ 1_000, resumeAt\)/.test(rateBlock.slice(0, 500)),
  );
  check(
    'the short-window count is visible on /health',
    /lastMinute: requestLedger\.lastMinute/.test(health) &&
      /ratePerMinute: requestLedger\.ratePerMinute/.test(health),
  );

  // ── Load balancing across accounts ───────────────────────────────────────
  //
  // The credential loop always starts at index 0, so a static order is
  // failover, not balancing. Against a per-account daily quota that means the
  // first key absorbs everything until it is exhausted: 1,299 of 1,388
  // requests (94%) on one account on 2026-09-12, while the other two held 15
  // and 52. Three accounts delivered barely one account's worth of quota.
  check(
    'credentials are ordered least-loaded-first, so accounts share the quota',
    /accountRequestsToday\(accountFingerprint\(a\.key\)\)/.test(client) &&
      /accountRequestsToday\(accountFingerprint\(b\.key\)\)/.test(client),
  );
  check(
    'ties keep the declared order, so a fresh day is deterministic',
    /load !== 0 \? load : a\.index - b\.index/.test(client),
  );
  check(
    'duplicate env names for the same account collapse to one retry bucket',
    /seenAccounts\.has\(fingerprint\)/.test(client) &&
      /seenAccounts\.add\(fingerprint\)/.test(client),
  );

  // ── Account roster ───────────────────────────────────────────────────────
  //
  // Free throughput scales with ACCOUNTS, not models. OpenRouter's free
  // allowance is a per-account daily request budget shared across every `:free`
  // model at once (429 `free-models-per-day-high-balance`, X-RateLimit-Limit
  // 1000, limit_source `openrouter_free_tier_daily`), so adding models buys
  // nothing and adding a key buys a whole extra 1,000/day.
  const freeEnvs = client.slice(
    client.indexOf('const OPENROUTER_FREE_KEY_ENVS'),
  );
  const freeList = freeEnvs.slice(0, freeEnvs.indexOf('] as const;'));
  check(
    'the fourth account key is in the free roster',
    /'OPENROUTER_API_KEY_4'/.test(freeList),
  );
  check(
    'the dead OPENROUTER_API_KEY_3 credential is not in the free roster',
    !/'OPENROUTER_API_KEY_3'/.test(freeList),
  );
  // Paid continuity is explicitly confirmed and isolated to the funded primary
  // inference key. The optional fourth free account must never become spendable.
  check(
    'paid continuity uses only the funded primary inference key',
    /OPENROUTER_PAID_KEY_ENVS = \['OPENROUTER_API_KEY'\]/.test(client),
  );
  check(
    'the fourth account key cannot be spent as a paid credential',
    /'OPENROUTER_API_KEY_4'/.test(freeList) &&
      !/OPENROUTER_PAID_KEY_ENVS = \[[^\]]*OPENROUTER_API_KEY_4/.test(client),
  );
  check(
    'the default workspace cap matches a two-account 2x1000 free ceiling',
    /const DEFAULT_TOTAL_CAP = 2_000/.test(ledger),
  );

  const creditsSource = read('packages/core/src/provider-credits.ts');
  check(
    'the credit probe knows about every configured account key',
    /'OPENROUTER_API_KEY_4'/.test(creditsSource) &&
      /'OPENROUTER_FREE_API_KEY'/.test(creditsSource),
  );
  check(
    'the credit probe asks OpenRouter which user each live key belongs to',
    creditsSource.includes("https://openrouter.ai/api/v1/key") &&
      /creator_user_id/.test(creditsSource) &&
      /uniqueAccounts/.test(creditsSource) &&
      /sharedQuota/.test(creditsSource),
  );
  check(
    'management keys are inventory-only and cannot be used to infer',
    /OPENROUTER_MGMT_KEY/.test(creditsSource) &&
      /never auto-create/.test(creditsSource) &&
      /or rotate credentials/.test(creditsSource) &&
      /KEYS_URL/.test(creditsSource) &&
      !/api\/v1\/chat\/completions/.test(creditsSource),
  );
  check(
    'the retired BYOK paid key is not a credit-probe or runtime credential',
    !/OPENROUTER_BYOK_API_KEY/.test(client) &&
      !/OPENROUTER_BYOK_API_KEY/.test(creditsSource),
  );
  check(
    'dead OPENROUTER_API_KEY_3 is not a credit-probe credential',
    !/'OPENROUTER_API_KEY_3'/.test(creditsSource),
  );

  // ── Accounts, not keys, decide the free ceiling ──────────────────────────
  //
  // This ledger fingerprints KEYS; OpenRouter meters ACCOUNTS. Two keys issued
  // by one account therefore look like two accounts here, and any cap phrased
  // as "accounts x 1,000" silently exceeds the real ceiling. Found live on
  // 2026-09-14: 3 keys, 2 accounts, cap 2,800 against a true ceiling of 2,000.
  check(
    'the enforced cap is clamped to the accounts actually observed',
    /export function effectiveRequestCap/.test(ledger) &&
      /Math\.min\(configured, observedAccounts \* freeRequestsPerAccount\(\)\)/.test(ledger),
  );
  // The clamp must only ever lower the ceiling, and only on real data — a
  // failed probe reporting nothing must not starve the workforce.
  check(
    'a probe that has not reported leaves the configured cap untouched',
    /if \(observedAccounts === null\) return configured;/.test(ledger),
  );
  // The probe must publish WHICH account each key belongs to, not merely how
  // many there are. A count alone fixes the cap and leaves the load balancer
  // still levelling keys.
  const credits = read('packages/core/src/provider-credits.ts');
  check(
    'the credit probe publishes each key\u2019s OpenRouter account to the budget',
    /setObservedAccounts\(identities\.size > 0 \? identities : null\)/.test(credits) &&
      /new Map<string, string>\(\s*inference\.map\(\(entry, index\) => \[entry\.fingerprint, accounts\[index\]\.account\]\),/
        .test(credits),
  );
  // Every gate must consult the clamped cap; one that reads the raw configured
  // value re-opens the gap the clamp exists to close.
  const rawCapGates = (ledger.match(/cap: totalRequestCap\(\)/g) ?? []).length;
  check(
    'no capacity gate reads the unclamped configured cap',
    rawCapGates === 0,
    { rawCapGates },
  );
  check(
    'the clamp is visible on /health, not silently applied',
    /configuredCap: totalRequestCap\(\)/.test(ledger) &&
      /observedAccounts: getObservedAccountCount\(\)/.test(ledger),
  );

  // ── Load is metered per ACCOUNT, not per key ─────────────────────────────
  //
  // The free allowance is one bucket per OpenRouter USER. The balancer sorts
  // on requests-already-made-today, so if that number is per key, an account
  // holding two keys is asked for twice the work of an account holding one —
  // and the extra lands on a bucket that is already the more exhausted of the
  // two. Live on 2026-09-14: 508 + 508 = 1,016 through a 1,000/day account
  // while the other finished the window at 737.
  //
  // Run against the real module, with the shape the probe actually found:
  // keys A1 and A2 issued by one user, key B by another.
  const {
    setObservedAccounts,
    accountFingerprint,
    accountRequestsToday,
    recordProviderRequest,
    getObservedAccountCount,
    getRequestLedgerSnapshot,
  } = ledgerModule;

  const fp = (key: string): string => accountFingerprint(key);
  const [keyA1, keyA2, keyB] = ['guard-key-a1', 'guard-key-a2', 'guard-key-b'];
  const resolved = new Map([
    [fp(keyA1), 'oracct_shared'],
    [fp(keyA2), 'oracct_shared'],
    [fp(keyB), 'oracct_solo'],
  ]);
  setObservedAccounts(resolved);

  check(
    'three keys across two users count as two accounts, so the cap is theirs',
    getObservedAccountCount() === 2,
    { observedAccounts: getObservedAccountCount() },
  );

  for (let i = 0; i < 40; i += 1) recordProviderRequest(keyA1, true);
  for (let i = 0; i < 35; i += 1) recordProviderRequest(keyA2, true);
  for (let i = 0; i < 50; i += 1) recordProviderRequest(keyB, true);

  check(
    'a key reports the load of its whole account, not of itself',
    accountRequestsToday(fp(keyA1)) === 75 && accountRequestsToday(fp(keyA2)) === 75,
    { a1: accountRequestsToday(fp(keyA1)), a2: accountRequestsToday(fp(keyA2)) },
  );

  // The assertion that separates the fix from the bug. Per key, B has served
  // more than either of A's keys (50 > 40) and the balancer would reach for it
  // LAST. Per account it has served fewer than A's bucket (50 < 75), so it is
  // reached FIRST — which is the whole point, since A is the one near its
  // ceiling.
  check(
    'the emptier account outranks a busier one whose individual keys look lighter',
    accountRequestsToday(fp(keyB)) === 50 &&
      accountRequestsToday(fp(keyB)) > 40 &&
      accountRequestsToday(fp(keyB)) < accountRequestsToday(fp(keyA1)),
    { b: accountRequestsToday(fp(keyB)), a: accountRequestsToday(fp(keyA1)) },
  );

  // /health has to show the grouping, or two rows at 508 look like two healthy
  // accounts instead of one bucket 16 requests past its limit.
  const grouped = getRequestLedgerSnapshot().accounts.filter(
    (row) => row.openRouterAccount === 'oracct_shared',
  );
  check(
    'the shared bucket and its combined load are visible on /health',
    grouped.length === 2 && grouped.every((row) => row.accountRequests === 75),
    grouped.map((row) => ({
      openRouterAccount: row.openRouterAccount,
      requests: row.requests,
      accountRequests: row.accountRequests,
    })),
  );

  // Fail open, exactly as the cap does: an unresolved probe must leave each key
  // as its own account. Merging on a guess would halve the apparent capacity of
  // a workspace whose keys really are independent.
  setObservedAccounts(null);
  check(
    'an unresolved probe meters each key alone rather than guessing a grouping',
    accountRequestsToday(fp(keyA1)) === 40 &&
      accountRequestsToday(fp(keyA2)) === 35 &&
      getObservedAccountCount() === null,
    { a1: accountRequestsToday(fp(keyA1)), a2: accountRequestsToday(fp(keyA2)) },
  );
  setObservedAccounts(resolved);

  // ── Paid spend budget ────────────────────────────────────────────────────
  //
  // PR #149 restored a paid rung behind APEX_PAID_FALLBACK and costUsd was
  // already captured per response, but nothing bounded either: enabling paid
  // inference meant UNBOUNDED spend, which is how this account reached $24.28
  // against $20 of credit and 402'd every request on 2026-09-12.
  const spend = read('packages/core/src/spend-ledger.ts');
  check(
    'a daily USD spend budget exists and is paced across the day',
    /export function paidSpendAvailable/.test(spend) &&
      /export function calculateSpendCapacityWindow/.test(spend),
  );
  // The whole point of the operator's "fall back to all free if absolutely
  // necessary": an exhausted budget must remove the rung, not fail the call.
  check(
    'an exhausted spend budget DROPS the paid rung rather than erroring',
    /paidLLMFallbackEnabled\(\) && paidSpendAvailable\(\)/.test(client),
  );
  check(
    'every paid response is charged against the budget',
    /recordSpend\(/.test(client) && /provider\.paid/.test(client),
  );
  // A response OpenRouter did not price must not spend from the budget for
  // free — that is the one way a dollar cap is silently defeated.
  check(
    'an unpriced response falls back to list price, never to zero',
    /result\.costUsd \?\? estimatedCostUsd\(provider, result\.usage\)/.test(client) &&
      /usdPerMillionPrompt/.test(client),
  );
  // Money must fail closed where quota fails open: cap 0 means spend nothing.
  check(
    'a zero spend cap disables paid spend rather than meaning unlimited',
    /reason: 'disabled'/.test(spend) && /capMicros === 0/.test(spend),
  );
  check(
    'spend survives a restart (Postgres-hydrated, micro-dollar integers)',
    /initializeSpendLedgerPersistence/.test(spend) &&
      /llm_spend_daily/.test(read('lib/db/src/client.ts')),
  );
  const guardedSpendCalls = (client.match(/if \(!provider\.paid\) recordProviderRequest/g) ?? []).length;
  const allSpendCalls = (client.match(/recordProviderRequest\(/g) ?? []).length;
  check(
    'paid requests are NOT charged against the free request allowance',
    guardedSpendCalls > 0 && guardedSpendCalls === allSpendCalls,
    { guarded: guardedSpendCalls, total: allSpendCalls },
  );
  check(
    'spend is visible on /health next to the request meter',
    /llmSpend: getSpendLedgerSnapshot\(\)/.test(health),
  );

  // ── Batching: the other half of the fix ──────────────────────────────────
  //
  // Telling agents to batch tool calls is inert unless the request carries
  // parallel_tool_calls — the wire format decides whether more than one call
  // per reply is even possible, and one request per round trip is what set the
  // burn rate in the first place.
  check(
    'requests opt in to parallel tool calls when tools are sent',
    /body\.parallel_tool_calls = true/.test(client) &&
      client.indexOf('body.parallel_tool_calls') >
        client.indexOf("body.tool_choice = 'auto'"),
  );
  const agent = read('packages/core/src/base-agent.ts');
  check(
    'the standing rules instruct agents to batch their tool calls',
    /BATCH YOUR TOOL CALLS/.test(agent),
  );

  // A cadence change in bootstrap-jobs.ts only reaches a live database when the
  // definition version goes up — without that the edit ships and does nothing,
  // which is how these crons stayed frozen at their seeded values.
  const jobs = read('packages/api-server/src/bootstrap-jobs.ts');
  for (const id of [
    'system-ceo-goal-review',
    'system-delegation-followup',
    'system-work-generation',
    'system-lead-contact-enrichment',
  ]) {
    const block = jobs.slice(jobs.indexOf(`id: '${id}'`));
    const definition = block.slice(0, block.indexOf('},\n'));
    check(
      `${id} carries a systemDefinitionVersion so its cadence can be synced`,
      /systemDefinitionVersion: [1-9]/.test(definition),
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} request-budget check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll request-budget checks passed.');
}

main();

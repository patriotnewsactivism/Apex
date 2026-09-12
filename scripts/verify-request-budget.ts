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
      /recordProviderRequest\(credential\.env, true\)/.test(client) &&
      /recordProviderRequest\(credential\.env, false\)/.test(client),
    { callSites: recordCalls.length },
  );

  // The failure counter has to sit in the catch block that handles a provider
  // error, not somewhere that only runs on a clean path.
  const catchBlock = client.slice(
    client.indexOf('recordProviderRequest(credential.env, false)'),
    client.indexOf('recordProviderRequest(credential.env, false)') + 400,
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
  const { calculateRequestCapacityWindow } = (await import(
    path.join(root, 'packages/core/src/request-ledger.ts')
  )) as typeof import('../packages/core/src/request-ledger.js');

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

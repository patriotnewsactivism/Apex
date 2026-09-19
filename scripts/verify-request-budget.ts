/**
 * Guard: APEX request budgets must be enforced on the network hot path.
 *
 * Architecture:
 *   - OpenRouter pool: 2,775 requests/day
 *   - Groq BYOK: independent provider pool
 *   - Gemini BYOK: independent provider pool
 *   - Emergency all-provider ceiling: 4,500 requests/day
 *
 * Every upstream attempt is RESERVED before fetch(). Success is marked after
 * the response. That ordering makes the hard caps concurrency-safe and means
 * timeouts/429s/failures still consume the allowance they actually burned.
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
  console.log('Verifying APEX request budgets and BYOK pools...\n');

  const ledger = read('packages/core/src/request-ledger.ts');
  const client = read('packages/core/src/llm-client.ts');
  const bootstrap = read('packages/api-server/src/runtime-bootstrap.ts');
  const apiServer = read('packages/api-server/src/index.ts');
  const settings = read('packages/api-server/src/routes/settings.ts');

  // ── Operator ceilings ────────────────────────────────────────────────────
  check(
    'OpenRouter default ceiling is exactly 2,775/day',
    /const DEFAULT_TOTAL_CAP = 2_775/.test(ledger),
  );
  check(
    'the configured OpenRouter ceiling is authoritative, not silently clamped',
    /export function effectiveRequestCap\(\): number \{\s*return totalRequestCap\(\);\s*\}/.test(ledger),
  );
  check(
    'an independent emergency all-provider ceiling exists',
    /const DEFAULT_EMERGENCY_TOTAL_CAP = 4_500/.test(ledger) &&
      /export function emergencyRequestCapacityWindow/.test(ledger),
  );

  // ── Independent BYOK pools ───────────────────────────────────────────────
  check(
    'Groq and Gemini have independent durable request pools',
    /export type DirectRequestPool = 'groq' \| 'gemini'/.test(ledger) &&
      /directProviderCapacityWindow/.test(ledger) &&
      /directProviderRequestsToday/.test(ledger),
  );
  check(
    'OpenRouter free totals explicitly exclude direct BYOK and paid-continuity traffic',
    /if \(!isDirectAccount\(account\) && !isPaidAccount\(account\)\) sum \+= entry\.requests/.test(ledger),
  );
  check(
    'all-provider totals include every pool for the emergency stop',
    /export function allProviderRequestsToday/.test(ledger) &&
      /usedRequests: allProviderRequestsToday\(\)/.test(ledger),
  );
  check(
    'Groq BYOK uses GPT-OSS 120B and its own request pool',
    /name: 'groq-gpt-oss-120b-byok'/.test(client) &&
      /model: 'openai\/gpt-oss-120b'/.test(client) &&
      /requestPool: 'groq'/.test(client),
  );
  check(
    'Gemini BYOK uses the native Gemini 3.8 Interactions route',
    /name: 'gemini-3-8-flash-byok'/.test(client) &&
      /model: 'gemini-3\.8-flash'/.test(client) &&
      /protocol: 'gemini-interactions'/.test(client),
  );
  check(
    'BYOK pools have explicit runtime activation switches',
    /APEX_GROQ_BYOK_ENABLED/.test(client) &&
      /APEX_GEMINI_BYOK_ENABLED/.test(client) &&
      /APEX_GROQ_BYOK_ENABLED/.test(settings) &&
      /APEX_GEMINI_BYOK_ENABLED/.test(settings),
  );

  // ── Reservation before network dispatch ─────────────────────────────────
  check(
    'the ledger exports pre-dispatch reservation functions',
    /export function reserveProviderRequest/.test(ledger) &&
      /export function reservePaidProviderRequest/.test(ledger) &&
      /export function reserveDirectProviderRequest/.test(ledger),
  );
  check(
    'success is a separate post-response outcome update',
    /export function markProviderRequestSucceeded/.test(ledger) &&
      /export function markPaidProviderRequestSucceeded/.test(ledger) &&
      /export function markDirectProviderRequestSucceeded/.test(ledger),
  );

  const credentialLoop = client.slice(client.indexOf('for (const credential of credentials)'));
  const reserveAt = credentialLoop.indexOf('reserveProviderAttempt(provider, credential.key);');
  const networkAt = credentialLoop.indexOf('await callProvider(');
  const successAt = credentialLoop.indexOf('markProviderAttemptSucceeded(provider, credential.key);');
  check(
    'each attempt is reserved synchronously before the provider network call',
    reserveAt >= 0 && networkAt > reserveAt,
    { reserveAt, networkAt },
  );
  check(
    'success is marked only after the provider returned',
    successAt > networkAt,
    { networkAt, successAt },
  );
  check(
    'the old record-after-return helper is not used on the runtime path',
    !/recordProviderAttempt\(/.test(client),
  );
  check(
    'a fresh pool and emergency-cap check occurs immediately before reservation',
    /const emergencyAttemptWindow = emergencyRequestCapacityWindow\(Date\.now\(\)\)/.test(credentialLoop) &&
      /const freshProviderWindow = requestWindowForProvider/.test(credentialLoop),
  );
  check(
    'oversize retries require a fresh quota check and their own reservation',
    /const allWindow = emergencyRequestCapacityWindow\(Date\.now\(\)\)/.test(credentialLoop) &&
      /reserveProviderAttempt\(provider, credential\.key\);[\s\S]{0,500}?const result = await callProvider/.test(
        credentialLoop.slice(credentialLoop.indexOf('if (isRequestTooLargeError')),
      ),
  );

  // ── Durable accounting ───────────────────────────────────────────────────
  check(
    'request reservations persist independently from success outcomes',
    /persistDatabaseRequestDelta/.test(ledger) &&
      /persistDatabaseSuccessDelta/.test(ledger),
  );
  check(
    'the request ledger hydrates from Postgres before workforce operation',
    /initializeRequestLedgerPersistence/.test(bootstrap) &&
      /export async function initializeRequestLedgerPersistence/.test(ledger),
  );
  check(
    'the durable daily request table still backs the ledger',
    /llm_request_usage_daily/.test(read('lib/db/src/client.ts')) &&
      /llmRequestUsageDaily/.test(read('lib/db/src/schema.ts')),
  );

  // ── Routing and capacity probing ─────────────────────────────────────────
  const capacityProbe = client.slice(
    client.indexOf('export function llmCapacityAvailableNow('),
    client.indexOf('/**\n * Cost of one call', client.indexOf('export function llmCapacityAvailableNow(')),
  );
  check(
    'claim admission honors the emergency all-provider ceiling',
    /emergencyRequestCapacityWindow\(now\)\.allowed/.test(capacityProbe),
  );
  check(
    'claim admission checks each provider pool independently',
    /requestWindowForProvider\(provider, now\)\.allowed/.test(capacityProbe),
  );
  check(
    'provider execution also checks its own pool before credentials are tried',
    /const providerRequestWindow = requestWindowForProvider/.test(client),
  );
  check(
    'paid continuity bypasses the free request pool while remaining separately governed',
    /if \(provider\.paid\) return paidProviderCapacityWindow\(\);/.test(client) &&
      /function isPaidAccount\(account: string\)/.test(ledger) &&
      /!isDirectAccount\(account\) && !isPaidAccount\(account\)/.test(ledger),
  );

  // ── Observability ────────────────────────────────────────────────────────
  check(
    '/health exposes OpenRouter, BYOK, and emergency usage',
    /allProviderUsed: requestLedger\.allProviderRequests/.test(apiServer) &&
      /emergencyCap: requestLedger\.emergencyCap/.test(apiServer) &&
      /directProviders: requestLedger\.directProviders/.test(apiServer),
  );
  check(
    '/api/spend exposes the same provider-pool request burn',
    /allProviderUsed: requests\.allProviderRequests/.test(apiServer) &&
      /emergencyCap: requests\.emergencyCap/.test(apiServer) &&
      /directProviders: requests\.directProviders/.test(apiServer),
  );

  // ── Pure pacing math ─────────────────────────────────────────────────────
  process.env.APEX_REQUEST_LEDGER_PATH = path.join(
    os.tmpdir(),
    `apex-request-budget-guard-${process.pid}.json`,
  );
  process.env.APEX_REQUEST_CAP_TOTAL = '2775';
  process.env.APEX_GROQ_REQUEST_CAP = '900';
  process.env.APEX_GEMINI_REQUEST_CAP = '500';
  process.env.APEX_EMERGENCY_REQUEST_CAP_TOTAL = '4500';
  process.env.APEX_REQUEST_RATE_PER_MIN = '0';

  const ledgerModule = (await import(
    path.join(root, 'packages/core/src/request-ledger.ts')
  )) as typeof import('../packages/core/src/request-ledger.js');

  const {
    calculateRequestCapacityWindow,
    effectiveRequestCap,
    directProviderRequestCap,
    emergencyTotalRequestCap,
    reserveProviderRequest,
    markProviderRequestSucceeded,
    reservePaidProviderRequest,
    reserveDirectProviderRequest,
    markDirectProviderRequestSucceeded,
    paidProviderCapacityWindow,
    getRequestLedgerSnapshot,
  } = ledgerModule;

  check('runtime OpenRouter cap resolves to 2,775', effectiveRequestCap() === 2775);
  check('runtime Groq cap resolves to 900', directProviderRequestCap('groq') === 900);
  check('runtime Gemini cap resolves to 500', directProviderRequestCap('gemini') === 500);
  check('runtime emergency cap resolves to 4,500', emergencyTotalRequestCap() === 4500);

  const dayStart = Date.UTC(2026, 8, 18);
  const noon = dayStart + 12 * 60 * 60 * 1000;
  const atCap = calculateRequestCapacityWindow({
    cap: 2775,
    usedRequests: 2775,
    requestedRequests: 1,
    at: noon,
    pacingEnabled: false,
  });
  check(
    'the 2,775th exhausted OpenRouter budget refuses one more request',
    !atCap.allowed && atCap.reason === 'daily_cap',
    atCap,
  );

  // Direct BYOK and paid-continuity traffic must not consume the OpenRouter
  // FREE meter. All three still count toward the emergency all-provider cap.
  reserveProviderRequest('guard-openrouter-key');
  markProviderRequestSucceeded('guard-openrouter-key');
  reservePaidProviderRequest('guard-paid-continuity');
  reserveDirectProviderRequest('groq', 'guard-groq');
  markDirectProviderRequestSucceeded('groq', 'guard-groq');
  reserveDirectProviderRequest('gemini', 'guard-gemini');

  const snapshot = getRequestLedgerSnapshot();
  const groq = snapshot.directProviders.find((row) => row.pool === 'groq');
  const gemini = snapshot.directProviders.find((row) => row.pool === 'gemini');
  check(
    'one free + one paid + two BYOK attempts report 1 free-pool and 4 all-provider requests',
    snapshot.totalRequests === 1 && snapshot.allProviderRequests === 4,
    { freePool: snapshot.totalRequests, allProviders: snapshot.allProviderRequests },
  );
  check(
    'paid continuity does not consume the free request pacing window',
    snapshot.lastMinute === 1 && paidProviderCapacityWindow().allowed,
    { freeRequestsLastMinute: snapshot.lastMinute, paidWindow: paidProviderCapacityWindow() },
  );
  check(
    'direct pool counters remain independent',
    groq?.requests === 1 && gemini?.requests === 1,
    snapshot.directProviders,
  );
  check(
    'failed direct attempts still count while success remains an outcome field',
    gemini?.requests === 1,
    gemini,
  );

  try {
    fs.rmSync(process.env.APEX_REQUEST_LEDGER_PATH, { force: true });
  } catch {
    // best-effort cleanup only
  }

  if (failures > 0) {
    console.error(`\n❌ Request-budget verification failed: ${failures} check(s).`);
    process.exit(1);
  }
  console.log('\n✅ Request-budget verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

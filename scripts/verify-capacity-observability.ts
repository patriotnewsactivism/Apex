/**
 * Guard: /health must distinguish a stopped workforce from ordinary provider
 * throttling in the multi-pool architecture.
 *
 * OpenRouter, Groq and Gemini have independent request pools. Therefore an
 * exhausted OpenRouter pool is not a workspace stop while a configured BYOK
 * pool is still usable. llmCapacityAvailableNow() is the single runtime answer
 * to "can any route accept work?", and authenticated GET /api/health/detail
 * must report from that answer. Public GET /health stays status + build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

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

function extractCapacityState(source: string): string | null {
  const match = source.match(/const capacityState =([\s\S]{0,700}?);\n/);
  return match ? match[1] : null;
}

function main(): void {
  console.log('── Multi-pool capacity observability (/api/health/detail) ──');

  const source = fs.readFileSync(
    path.join(root, 'packages/api-server/src/index.ts'),
    'utf8',
  );
  const client = fs.readFileSync(
    path.join(root, 'packages/core/src/llm-client.ts'),
    'utf8',
  );
  const expr = extractCapacityState(source);

  check('capacityState assignment exists', Boolean(expr));
  if (!expr) process.exit(1);

  check(
    'true no-route hard cap reports capped first',
    /hardCapped\s*\n?\s*\?\s*"capped"/.test(expr),
    expr,
  );
  check(
    'no-usable-route state reports workforce_paused before per-provider pacing',
    /aggregatePaused\s*\n?\s*\?\s*"workforce_paused"/.test(expr) &&
      expr.indexOf('aggregatePaused') < expr.indexOf('pausedProviders'),
    expr,
  );
  check(
    'ordinary provider pacing remains distinct',
    /pausedProviders\.length > 0\s*\n?\s*\?\s*"paced"/.test(expr),
    expr,
  );
  check('healthy capacity reports available', /"available"/.test(expr), expr);

  check(
    'request hard-cap reporting uses the emergency all-provider ceiling but does not hide usable FlashX',
    /const emergencyRequestCapReached =\s*[\s\S]{0,180}?requestLedger\.allProviderRequests >= requestLedger\.emergencyCap/.test(source) &&
      /const hardCapped =[\s\S]{0,180}?emergencyRequestCapReached[\s\S]{0,120}?!anyLLMCapacityAvailable/.test(source),
  );

  check(
    'aggregatePaused delegates to the same runtime capacity probe agents use',
    /const anyLLMCapacityAvailable = llmCapacityAvailableNow\(\);/.test(source) &&
      /const aggregatePaused = !anyLLMCapacityAvailable;/.test(source),
  );

  const probeStart = client.indexOf('export function llmCapacityAvailableNow(');
  const probeEnd = client.indexOf('\n}\n', probeStart);
  const probe = client.slice(probeStart, probeEnd + 3);
  check(
    'capacity probe applies emergency caps to restricted routes without vetoing unrestricted continuity',
    /!provider\.unrestricted[\s\S]{0,220}!emergencyAllowed/.test(probe),
    probe,
  );
  check(
    'capacity probe applies token pacing to restricted routes without vetoing unrestricted continuity',
    /!provider\.unrestricted[\s\S]{0,260}!totalTokenPacingAllowed/.test(probe),
    probe,
  );
  check(
    'capacity probe checks each configured provider request pool independently',
    /if \(!requestWindowForProvider\(provider, now\)\.allowed\) continue;/.test(probe),
    probe,
  );

  check(
    'authenticated health detail exposes all-provider usage and each direct pool for diagnosis',
    /allProviderUsed: requestLedger\.allProviderRequests/.test(source) &&
      /emergencyCap: requestLedger\.emergencyCap/.test(source) &&
      /directProviders: requestLedger\.directProviders/.test(source),
  );
  check(
    'public /health is the minimal probe, not the capacity snapshot',
    /app\.get\('\/health', \(_req, res\) => \{\s*sendPublicHealth\(/.test(source) &&
      !/sendPublicHealth[\s\S]{0,240}llmRequests/.test(source),
  );

  if (failures > 0) {
    console.error(`\n${failures} capacity-observability check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll capacity-observability checks passed.');
}

main();

/**
 * Guard: /health must distinguish a stopped workforce from a throttled one.
 *
 * Production evidence (2026-09-08, prod SHA 53132c4). Two /health payloads,
 * both reading `llmCapacity.state: "paced"`:
 *
 *   15:19 UTC  state=paced  tasksClaimed climbing ~15/min   <- benign, two
 *                                                              Nemotron
 *                                                              providers
 *                                                              resting
 *   21:46 UTC  state=paced  tasksClaimed frozen at 2083 for <- total stall,
 *                           64 minutes                         workspace
 *                                                              allowance
 *                                                              exhausted
 *
 * Nothing else separated them: status ok, verdict ok, failures 0, poll loop
 * healthy at ~13 polls/min, one stable instance, uptime climbing.
 * `workforceParkedUntil` was null in both -- it reports the base-agent shared
 * latch, not the workspace allowance. The stall self-cleared at the 00:00 UTC
 * reset (state -> available, 12 idle agents -> 11 thinking within seconds),
 * which is the only reason it was ever attributable.
 *
 * The cause was one collapsed ternary branch:
 *
 *   aggregatePaused || pausedProviders.length > 0 ? "paced" : "available"
 *
 * `aggregatePaused` is `!tokenLedger.pacing.total.allowed` -- the exact
 * expression llmCapacityAvailableNow() uses to return false and stop every
 * agent from claiming. `pausedProviders.length > 0` means some providers rest
 * while claiming continues. Reporting both as "paced" made a total production
 * stall indistinguishable from normal throttling.
 *
 * verify-capacity-latch-release.ts named this exact gap on 2026-09-04
 * ("nothing outside the process could tell a parked workforce from an idle
 * one"). It fixed the latch; this guards the reporting.
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

/**
 * Reproduces the /health ternary from api-server/src/index.ts against the
 * source text, so the guard fails if the real branch is ever recollapsed.
 * Reading the source rather than re-implementing the logic is deliberate:
 * a hand-copied ternary would keep passing after the shipped one regressed.
 */
function extractCapacityState(source: string): string | null {
  const match = source.match(
    /const capacityState =([\s\S]{0,600}?);\n/,
  );
  return match ? match[1] : null;
}

function main(): void {
  console.log('── Capacity observability (/health) ──');

  const indexPath = path.join(root, 'packages/api-server/src/index.ts');
  const source = fs.readFileSync(indexPath, 'utf8');
  const expr = extractCapacityState(source);

  check('capacityState assignment is present in api-server/src/index.ts', Boolean(expr));
  if (!expr) {
    process.exit(1);
  }

  // The workspace-wide gate must produce its own state, evaluated BEFORE the
  // per-provider case, so a stall is never reported as ordinary throttling.
  check(
    'the workspace-wide allowance gate has its own state, not "paced"',
    /aggregatePaused\s*\n?\s*\?\s*"workforce_paused"/.test(expr),
    expr,
  );

  check(
    'aggregatePaused is tested before pausedProviders.length',
    expr.indexOf('aggregatePaused') < expr.indexOf('pausedProviders'),
    expr,
  );

  // The regression this exists to prevent: the two conditions sharing a branch.
  check(
    'aggregatePaused and pausedProviders do not share a ternary branch',
    !/aggregatePaused\s*\|\|\s*pausedProviders/.test(expr) &&
      !/pausedProviders[^?]*\|\|\s*aggregatePaused/.test(expr),
    expr,
  );

  check(
    'per-provider pacing still reports "paced"',
    /pausedProviders\.length > 0\s*\n?\s*\?\s*"paced"/.test(expr),
    expr,
  );

  check('a hard cap still reports "capped"', /hardCapped\s*\n?\s*\?\s*"capped"/.test(expr), expr);
  check('an unconstrained workspace still reports "available"', /"available"/.test(expr), expr);

  // aggregatePaused must keep tracking the same expression llmCapacityAvailableNow
  // gates on. If one drifts, /health starts lying about the other.
  check(
    'aggregatePaused is derived from tokenLedger.pacing.total.allowed',
    /const aggregatePaused = !tokenLedger\.pacing\.total\.allowed;/.test(source),
  );

  const llmClient = fs.readFileSync(
    path.join(root, 'packages/core/src/llm-client.ts'),
    'utf8',
  );
  check(
    'llmCapacityAvailableNow still gates on ledger.pacing.total.allowed',
    /llmCapacityAvailableNow[\s\S]{0,600}if \(!ledger\.pacing\.total\.allowed\) return false;/.test(
      llmClient,
    ),
  );

  if (failures > 0) {
    console.error(`\n${failures} capacity-observability check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll capacity-observability checks passed.');
}

main();

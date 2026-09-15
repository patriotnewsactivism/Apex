/**
 * Guard: POST /api/sales-ops/automate must not change global state on a
 * request it goes on to report as failed.
 *
 * The route validates its input, then (for a lead/campaign target) looks up
 * the target and 404s if it's missing, then submits a goal for the Sales org
 * to work, optionally also changing the workforce-wide autonomy preset and
 * rescheduling the CEO goal-review cadence. The autonomy change was applied
 * BEFORE ceo.submitGoal() — a database write with no rollback. If submitGoal
 * threw afterward (a DB hiccup, a queue failure), the caller received a 500
 * ("Automation failed") while the autonomy level and review cadence had
 * already changed underneath them, unannounced and unlogged as such.
 *
 * Fixed by reordering: submitGoal first, autonomy preset only after it
 * succeeds. This guard is source-structural (no live Postgres/ApexCEO in
 * CI) — it asserts the ordering and that the earlier validation/lookup
 * gates this guard doesn't touch are still in place ahead of both.
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
  console.log('Verifying sales-ops /automate side-effect ordering...\n');

  const source = read('packages/api-server/src/routes/sales-ops.ts');
  const routeStart = source.indexOf("router.post('/automate'");
  if (routeStart === -1) {
    console.error('FATAL: could not find the /automate route handler.');
    process.exit(2);
  }
  const routeEnd = source.indexOf("\n  return router;", routeStart);
  const handler = source.slice(routeStart, routeEnd === -1 ? undefined : routeEnd);

  // ── Validation still gates everything, before any lookup or side effect ──
  const validationIdx = handler.indexOf("!['lead', 'campaign', 'pipeline'].includes(type)");
  const autonomyValidationIdx = handler.indexOf('Unknown autonomy level');
  const leadLookupIdx = handler.indexOf('.from(researchedLeads)');
  const campaignLookupIdx = handler.indexOf('.from(leadCampaigns)');
  check(
    'target.type is validated before any target lookup',
    validationIdx > -1 && leadLookupIdx > -1 && validationIdx < leadLookupIdx,
    { validationIdx, leadLookupIdx },
  );
  check(
    'autonomyLevel is validated before any target lookup',
    autonomyValidationIdx > -1 && leadLookupIdx > -1 && autonomyValidationIdx < leadLookupIdx,
    { autonomyValidationIdx, leadLookupIdx },
  );

  // ── The fix itself: goal submission gates the autonomy change ────────────
  const submitGoalIdx = handler.indexOf('await ceo.submitGoal(');
  const applyPresetIdx = handler.indexOf('await applyAutonomyPreset(');
  check(
    'ceo.submitGoal() is called at all',
    submitGoalIdx > -1,
  );
  check(
    'applyAutonomyPreset() is called at all',
    applyPresetIdx > -1,
  );
  check(
    'the goal is submitted BEFORE the global autonomy preset is applied — not after',
    submitGoalIdx > -1 && applyPresetIdx > -1 && submitGoalIdx < applyPresetIdx,
    { submitGoalIdx, applyPresetIdx },
  );

  // ── A missing lead/campaign target still 404s before either side effect ──
  const leadNotFoundIdx = handler.indexOf('Lead ${target.id} not found');
  const campaignNotFoundIdx = handler.indexOf('Campaign ${target.id} not found');
  check(
    'a missing lead 404s before the goal is submitted or autonomy is touched',
    leadNotFoundIdx > -1 && leadNotFoundIdx < submitGoalIdx && leadNotFoundIdx < applyPresetIdx,
    { leadNotFoundIdx, submitGoalIdx, applyPresetIdx },
  );
  check(
    'a missing campaign 404s before the goal is submitted or autonomy is touched',
    campaignNotFoundIdx > -1 && campaignNotFoundIdx < submitGoalIdx && campaignNotFoundIdx < applyPresetIdx,
    { campaignNotFoundIdx, submitGoalIdx, applyPresetIdx },
  );

  // ── The autonomy change stays conditional on the caller actually asking ──
  const guardedApply = handler.slice(0, applyPresetIdx);
  check(
    'applying the preset is still gated on body.autonomyLevel being present',
    /if \(body\.autonomyLevel\) \{\s*$/.test(guardedApply.trimEnd()),
    { tail: guardedApply.trimEnd().slice(-60) },
  );

  if (failures > 0) {
    console.error(`\n${failures} sales-ops-automation-ordering check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll sales-ops-automation-ordering checks passed.');
}

main();

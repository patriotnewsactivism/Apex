/**
 * Guard: a researched lead cannot be saved without an outreach angle.
 *
 * outreachAngle was Zod-optional in both saveResearchedLead and
 * saveResearchedLeadsBatch since the tool was first added, even though the
 * agent's own prompt (business.ts) always said "each lead needs... a
 * suggested outreach angle". A small free model batching 10-20 leads per
 * call reliably drops an unenforced "should" field under load — the exact
 * behavior a user reported live ("why are we not figuring up an outreach
 * angle... it was always autonomous before"). And a lead saved without one
 * doesn't just look incomplete on a dashboard: campaign-runner.ts's
 * {{outreachAngle}} email-campaign merge field resolves to an empty string
 * for it, so a real outbound email goes out with a blank pitch.
 *
 * Direct execution of the real Zod schemas via tool.schema.safeParse() —
 * the exact call tool-registry.ts makes before every tool execution — not
 * just reading the source for the word "optional".
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
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

async function main(): Promise<void> {
  console.log('Verifying researched leads cannot be saved without an outreach angle...\n');

  const mod = (await import(
    path.join(root, 'packages/core/src/tool-registry.ts')
  )) as typeof import('../packages/core/src/tool-registry.js');
  const tools = mod.createBuiltinTools(root);

  const saveOne = tools.find((t) => t.name === 'saveResearchedLead');
  const saveBatch = tools.find((t) => t.name === 'saveResearchedLeadsBatch');
  check('saveResearchedLead is registered', Boolean(saveOne));
  check('saveResearchedLeadsBatch is registered', Boolean(saveBatch));
  if (!saveOne || !saveBatch) {
    console.error('\nCannot continue without both tools registered.');
    process.exit(1);
  }

  const baseLead = {
    companyName: 'Acme HVAC',
    contactResearchStatus: 'partial' as const,
    fitReason: 'Misses after-hours calls, no answering service on file.',
  };

  // ── saveResearchedLead (single) ────────────────────────────────────────
  const singleMissing = saveOne.schema.safeParse(baseLead);
  check(
    'a single lead with NO outreach angle is rejected before it reaches the DB',
    !singleMissing.success,
    singleMissing,
  );
  const singleEmpty = saveOne.schema.safeParse({ ...baseLead, outreachAngle: '' });
  check(
    'an empty-string outreach angle still satisfies the type (z.string() — matches fitReason\'s own strictness, not tightened beyond it)',
    singleEmpty.success,
  );
  const singlePresent = saveOne.schema.safeParse({
    ...baseLead,
    outreachAngle: 'Lead with "never miss another call after hours" — ties directly to their gap.',
  });
  check(
    'a lead WITH an outreach angle is accepted',
    singlePresent.success,
    singlePresent.success ? undefined : singlePresent,
  );

  // ── saveResearchedLeadsBatch (array) ───────────────────────────────────
  const batchMissing = saveBatch.schema.safeParse({ leads: [baseLead] });
  check(
    'a batch containing one lead with no outreach angle is rejected whole, not silently accepted',
    !batchMissing.success,
    batchMissing,
  );
  const batchMixed = saveBatch.schema.safeParse({
    leads: [
      { ...baseLead, outreachAngle: 'Real angle for lead one.' },
      { ...baseLead, companyName: 'Second Co' }, // missing on purpose
    ],
  });
  check(
    'one bad lead fails the WHOLE batch (Zod array semantics) — the agent gets one clear error, not a silent partial save',
    !batchMixed.success,
    batchMixed,
  );
  const batchAllPresent = saveBatch.schema.safeParse({
    leads: [
      { ...baseLead, outreachAngle: 'Angle one.' },
      { ...baseLead, companyName: 'Second Co', outreachAngle: 'Angle two.' },
    ],
  });
  check(
    'a batch where every lead has an outreach angle is accepted',
    batchAllPresent.success,
    batchAllPresent.success ? undefined : batchAllPresent,
  );

  if (failures > 0) {
    console.error(`\n${failures} lead-outreach-angle check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll lead-outreach-angle checks passed.');
}

main();

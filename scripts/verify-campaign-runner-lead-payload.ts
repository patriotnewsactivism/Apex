/**
 * Guard: the campaign runner's lead payload satisfies the tool that saves it.
 *
 * On 2026-09-21 production logs showed every campaign segment failing with
 * `Invalid args for saveResearchedLeadsBatch`, three attempts per city,
 * across the whole territory. The cause was not the model and not the
 * directory: campaign-runner.ts was written in #56 and never touched again,
 * while two later PRs added required fields to the tool it calls —
 *
 *   #124  contactResearchStatus  (runner never set it at all)
 *   #175  outreachAngle          (runner set it to `undefined` by design)
 *
 * so from #124 onward EVERY save the runner attempted was rejected by Zod
 * before reaching the database. It stayed invisible while the directory had
 * no working provider and usually returned nothing to save. The moment
 * TomTom landed (#194) and results started arriving, the runner began
 * spending a real qualification model call per segment and discarding 100%
 * of the output — an overnight bill with a stagnant lead count.
 *
 * The durable fix is a shared schema (researchedLeadInputSchema) that the
 * producer is typed against, so the next required field fails typecheck.
 * This guard is the runtime half: it builds the payload with the REAL
 * campaign-runner code and validates it with the REAL tool schema — the
 * exact safeParse tool-registry.ts runs before every execution — so a
 * refactor that breaks the contract fails in CI, not at $X/hour in prod.
 *
 * No network, no database, no model: the payload builders are pure.
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
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail, null, 2).slice(0, 900)}`);
}

async function main(): Promise<void> {
  console.log("Verifying the campaign runner's lead payload satisfies saveResearchedLeadsBatch...\n");

  const registryMod = (await import(
    path.join(root, 'packages/core/src/tool-registry.ts')
  )) as typeof import('../packages/core/src/tool-registry.js');
  const runnerMod = (await import(
    path.join(root, 'packages/background-jobs/src/campaign-runner.ts')
  )) as typeof import('../packages/background-jobs/src/campaign-runner.js');

  const tools = registryMod.createBuiltinTools(root);
  const saveBatch = tools.find((t) => t.name === 'saveResearchedLeadsBatch');
  check('saveResearchedLeadsBatch is registered', Boolean(saveBatch));
  if (!saveBatch) {
    console.error('\nCannot continue without the tool the runner calls.');
    process.exit(1);
  }

  const segment = { industry: 'Roofing', city: 'New Orleans Louisiana' };

  // What TomTom actually returns: business's own name, site and phone.
  const contactable = runnerMod.readBusiness({
    name: 'Crescent City Roofing',
    website: 'https://crescentcityroofing.com',
    phone: '504-555-0134',
    city: 'New Orleans',
  });
  // What a thin directory row looks like: a name and nothing else.
  const bare = runnerMod.readBusiness({ name: 'Bayou Roof Co' });

  check('readBusiness keeps a contactable row', Boolean(contactable));
  check('readBusiness keeps a bare row', Boolean(bare));
  if (!contactable || !bare) {
    console.error('\nCannot continue without normalized directory rows.');
    process.exit(1);
  }

  // ── The dropped phone number ───────────────────────────────────────────
  check(
    'readBusiness carries the provider phone number through (it was parsed and then discarded)',
    contactable.phone === '504-555-0134',
    contactable,
  );

  // ── The regression itself: the OLD payload must be rejected ────────────
  //
  // Reconstructed exactly as the runner built it before this fix: no
  // contactResearchStatus, outreachAngle explicitly undefined. If this ever
  // parses, the schema stopped enforcing what production depends on.
  const legacyPayload = {
    leads: [
      {
        companyName: contactable.companyName,
        website: contactable.website,
        industry: segment.industry,
        city: segment.city,
        fitReason: 'Roofing business in New Orleans Louisiana — speed-to-lead ICP.',
        outreachAngle: undefined,
      },
    ],
    campaignId: 'guard-campaign',
  };
  const legacy = saveBatch.schema.safeParse(legacyPayload);
  check(
    'the pre-fix payload (no contactResearchStatus, undefined outreachAngle) is still rejected',
    !legacy.success,
  );
  if (!legacy.success) {
    const paths = legacy.error.issues.map((i) => i.path.join('.'));
    check(
      'and it is rejected for BOTH missing required fields, not just one',
      paths.some((p) => p.endsWith('contactResearchStatus')) &&
        paths.some((p) => p.endsWith('outreachAngle')),
      paths,
    );
  }

  // ── Path 1: the model answered ─────────────────────────────────────────
  const withModelCopy = [contactable, bare].map((b) => ({
    ...runnerMod.campaignLeadBase(segment, b),
    fitReason: 'Storm-season roofer with no after-hours line listed.',
    outreachAngle: 'Open on the calls that come in during a storm week after 6pm.',
  }));
  const modelPath = saveBatch.schema.safeParse({
    leads: withModelCopy,
    campaignId: 'guard-campaign',
  });
  check(
    'the payload the runner builds when the model answers is accepted',
    modelPath.success,
    modelPath.success ? undefined : modelPath.error.issues,
  );

  // ── Path 2: the model did NOT answer ───────────────────────────────────
  //
  // This is the path that matters most and the one that was guaranteed to
  // fail. It runs precisely when free capacity is exhausted — the exact
  // condition the fallback exists to survive.
  const withTemplateCopy = [contactable, bare].map((b) => ({
    ...runnerMod.campaignLeadBase(segment, b),
    ...runnerMod.templateCopyFor(segment, b),
  }));
  const templatePath = saveBatch.schema.safeParse({
    leads: withTemplateCopy,
    campaignId: 'guard-campaign',
  });
  check(
    'the TEMPLATE-fallback payload is accepted (this is the path that ran when the model was unavailable, and it could never be saved)',
    templatePath.success,
    templatePath.success ? undefined : templatePath.error.issues,
  );
  check(
    'the template fallback writes a real outreach angle rather than undefined',
    typeof runnerMod.templateCopyFor(segment, contactable).outreachAngle === 'string' &&
      runnerMod.templateCopyFor(segment, contactable).outreachAngle.trim().length > 0,
  );

  // ── Honest contact status ──────────────────────────────────────────────
  check(
    'a row with a phone/website is marked partial, not complete — the runner never opens the company site',
    runnerMod.campaignLeadBase(segment, contactable).contactResearchStatus === 'partial',
  );
  check(
    'a row with no phone and no website is marked unavailable',
    runnerMod.campaignLeadBase(segment, bare).contactResearchStatus === 'unavailable',
  );
  check(
    'the phone reaches the save payload as contactPhone',
    runnerMod.campaignLeadBase(segment, contactable).contactPhone === '504-555-0134',
  );

  // ── Retrying our own bug is pure spend ─────────────────────────────────
  check(
    'a schema rejection is classified as non-retryable',
    runnerMod.isDeterministicFailure('Invalid args for saveResearchedLeadsBatch: [...]'),
  );
  check(
    'an unknown tool is classified as non-retryable',
    runnerMod.isDeterministicFailure('Unknown tool: saveResearchedLeadsBatch'),
  );
  check(
    'a provider outage is still retryable — retries exist for flaky directories',
    !runnerMod.isDeterministicFailure('searchBusinessDirectory failed: 503 from every endpoint'),
  );
  check(
    'a capacity pause is still retryable',
    !runnerMod.isDeterministicFailure('All LLM providers failed: free pool exhausted'),
  );

  console.log(
    failures === 0
      ? '\n✅ Campaign runner lead payload verified.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

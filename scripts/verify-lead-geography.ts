/**
 * Guard: researched leads are US-only, and the check needs positive evidence.
 *
 * saveResearchedLead and saveResearchedLeadsBatch refuse a lead outside the
 * United States with OUT_OF_SCOPE_GEOGRAPHY (packages/core/src/lead-geography.ts).
 * This pins which city strings count. A US state or territory, a state on its
 * own, or a well-known US city is in scope. A bare ambiguous name, a foreign
 * place, a missing city, and a phone with a non-+1 country code are refused,
 * each with a message the agent can act on.
 *
 * Every campaign city in us-geo.ts must pass: the campaign runner produces
 * leads for exactly those cities, so a refusal there would be a regression.
 *
 * The tools are executed too. A refusal is decided before any database read,
 * so DATABASE_URL points at a closed port: if a refusal ever touched the
 * database, the check would fail instead of writing anywhere.
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
  process.env.DATABASE_URL = 'postgres://guard:guard@127.0.0.1:9/no_database';
  console.log('Verifying researched leads are limited to the United States...\n');

  const geo = (await import(path.join(root, 'packages/core/src/lead-geography.ts'))) as typeof import('../packages/core/src/lead-geography.js');
  const { STATE_CITIES } = (await import(
    path.join(root, 'packages/background-jobs/src/us-geo.ts')
  )) as typeof import('../packages/background-jobs/src/us-geo.js');

  const verdict = (city: string | null | undefined, contactPhone?: string) => geo.checkLeadGeography({ city, contactPhone });

  const inScope = [
    'Austin', 'Austin, TX', 'Austin TX', 'austin, texas', 'Austin, TX 78701', 'Austin, TX 78701-1234',
    'Austin, Texas, United States', 'Austin, USA', 'Lima, OH', 'Lima OH', 'Peru, IN', 'Paris, TX',
    'London, KY', 'Toronto, OH', 'Brooklyn, NY 11201', 'Washington, D.C.', 'Washington DC', 'St. Louis',
    'Saint Louis, MO', 'Winston-Salem', 'Kansas City', 'Texas', 'New York', 'Albany New York',
    'San Juan, Puerto Rico', 'San Juan, PR', "Coeur d'Alene, Idaho", 'San José, CA', 'Ontario, CA',
  ];
  for (const city of inScope) {
    const result = verdict(city);
    check(`in scope: ${city}`, result.inScope, result);
  }

  const outsideUs = ['Lima, Peru', 'Lima - Peru', 'Toronto, ON', 'Toronto ON', 'London, UK', 'London, England', 'Mexico', 'Vancouver, BC'];
  for (const city of outsideUs) {
    const result = verdict(city);
    check(`outside the US: ${city}`, !result.inScope && result.reason === 'outside_us', result);
  }

  // Bare names that are not on the well-known list are ambiguous (Lima is in
  // Ohio and Peru; San Jose is in California and Costa Rica), so they need a
  // state. So does anything that names a region the check does not know.
  const unrecognized = ['Lima', 'Toronto', 'Paris', 'London', 'Birmingham', 'San Jose', 'Round Rock', 'Salem, Tamil Nadu', 'USA', '78701'];
  for (const city of unrecognized) {
    const result = verdict(city);
    check(
      `needs a state: ${city}`,
      !result.inScope && result.reason === 'unrecognized_location' && result.message.includes("'City, ST'"),
      result,
    );
  }

  for (const city of ['', '   ', null, undefined]) {
    const result = verdict(city);
    check(`a missing city is refused: ${JSON.stringify(city)}`, !result.inScope && result.reason === 'missing_location', result);
  }

  const phones: Array<[string, boolean]> = [
    ['+1 (512) 555-0100', true],
    ['(512) 555-0100', true],
    ['512.555.0100', true],
    ['001 512 555 0100', true],
    ['+51 1 234 5678', false],
    ['+44 20 7946 0958', false],
    ['0044 20 7946 0958', false],
  ];
  for (const [phone, ok] of phones) {
    const result = verdict('Austin, TX', phone);
    check(
      `Austin, TX with phone ${phone} is ${ok ? 'in scope' : 'refused'}`,
      ok ? result.inScope : !result.inScope && result.reason === 'non_us_phone',
      result,
    );
  }

  const refusal = verdict('Lima');
  check(
    'every refusal carries the code and starts its message with it',
    !refusal.inScope && refusal.code === 'OUT_OF_SCOPE_GEOGRAPHY' && refusal.message.startsWith('OUT_OF_SCOPE_GEOGRAPHY: '),
    refusal,
  );

  const campaignCities = Object.values(STATE_CITIES).flat();
  const refusedCampaignCities = campaignCities.filter((city) => !verdict(city).inScope);
  check(`all ${campaignCities.length} campaign cities in us-geo.ts are in scope`, refusedCampaignCities.length === 0, refusedCampaignCities);
  const bareCampaignCities = campaignCities.map((city) => city.replace(/,\s*[A-Z]{2}$/, ''));
  const ambiguousBare = ['Birmingham', 'Manchester', 'Santa Fe', 'Salem', 'Richmond', 'Aberdeen', 'Burlington', 'Bangor', 'Dover'];
  const refusedBare = bareCampaignCities.filter((city) => !ambiguousBare.includes(city) && !verdict(city).inScope);
  check('every unambiguous campaign city is in scope without its state', refusedBare.length === 0, refusedBare);

  // The tools themselves: the refusal is a structured result, not a thrown
  // parse error, and it is decided before the database is read.
  const registry = (await import(path.join(root, 'packages/core/src/tool-registry.ts'))) as typeof import('../packages/core/src/tool-registry.js');
  const tools = registry.createBuiltinTools(root);
  const single = tools.find((tool) => tool.name === 'saveResearchedLead');
  const batch = tools.find((tool) => tool.name === 'saveResearchedLeadsBatch');
  const ctx = { agentId: 'apex-lead-research-001', taskId: 'guard-task', workspaceRoot: root, requestApproval: async () => false };
  const lead = (over: Record<string, unknown>) => ({
    companyName: 'Guard Probe',
    website: 'https://guard-probe.example.test',
    industry: 'hvac',
    contactResearchStatus: 'unavailable',
    fitReason: 'guard',
    outreachAngle: 'guard',
    ...over,
  });

  for (const lookupOnly of [false, true]) {
    const args = single?.schema.parse(lead({ city: 'Lima', lookupOnly })) as never;
    const result = (await single?.execute(args, ctx as never)) as Record<string, unknown> | undefined;
    check(
      `saveResearchedLead refuses Lima without touching the database${lookupOnly ? ' (lookupOnly)' : ''}`,
      result?.refusedGeography === true &&
        result.saved === false &&
        result.duplicate === undefined &&
        String(result.error).startsWith('OUT_OF_SCOPE_GEOGRAPHY:') &&
        result.leadId === undefined,
      result,
    );
  }

  const batchArgs = batch?.schema.parse({
    leads: [lead({ city: 'Lima, Peru' }), lead({ city: 'Toronto, ON', website: 'https://guard-probe-2.example.test' }), lead({ city: undefined })],
  }) as never;
  const batchResult = (await batch?.execute(batchArgs, ctx as never)) as Record<string, unknown> | undefined;
  check(
    'saveResearchedLeadsBatch counts refusals apart from saves, duplicates and failures',
    batchResult?.saved === 0 &&
      batchResult.refusedGeography === 3 &&
      batchResult.duplicates === 0 &&
      batchResult.failed === 0 &&
      batchResult.total === 3 &&
      Array.isArray(batchResult.refusedDetails) &&
      (batchResult.refusedDetails as unknown[]).length === 3,
    batchResult,
  );

  console.log(
    failures === 0
      ? '\n✅ Researched leads are limited to the United States.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

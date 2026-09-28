import { readFileSync } from 'node:fs';

function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`PASS: ${label}`);
}

const schema = readFileSync('lib/db/src/schema.ts', 'utf8');
const migration = readFileSync('lib/db/src/client.ts', 'utf8');
const tools = readFileSync('packages/core/src/tool-registry.ts', 'utf8');
const agent = readFileSync('packages/agents/src/business.ts', 'utf8');
// seedDefaultJobs() (and the recurring job list it seeds, including the
// contact-enrichment sweep this check looks for) moved from index.ts to
// bootstrap-jobs.ts during #131's autonomous-OS upgrade, so both the HTTP
// server and the standalone worker entrypoint share one seeding path. Point
// this check at the file that actually owns the job list now -- this check
// silently regressed to a false pass (comparing against index.ts, which no
// longer contains the string) for as long as it read the pre-#131 location.
const scheduler = readFileSync('packages/api-server/src/bootstrap-jobs.ts', 'utf8');
const csv = readFileSync('packages/api-server/src/routes/leads.ts', 'utf8');

for (const field of ['decisionMakerName', 'contactEmail', 'contactPhone', 'contactSourceUrl', 'contactResearchStatus', 'contactResearchedAt']) {
  check(`schema persists ${field}`, schema.includes(`${field}:`));
}
check('migration upgrades existing lead tables', migration.includes('ADD COLUMN IF NOT EXISTS contact_research_status'));
check('new leads require an explicit research result', tools.includes("contactResearchStatus: z.enum(['partial', 'complete', 'unavailable'])"));
check('backlog contacts can be updated', tools.includes("name: 'updateLeadContactInfo'"));
check('pending leads can be queried', tools.includes('needsContactResearch'));
check('agent is forbidden to guess contact data', agent.includes('Never guess'));
check('agent receives the contact update tool', agent.includes("'updateLeadContactInfo'"));
check('an autonomous backlog sweep is scheduled', scheduler.includes("id: 'system-lead-contact-enrichment'"));
check('contact enrichment runs every 10 minutes', scheduler.includes("cronExpression: '*/10 * * * *'"));
check('contact enrichment uses cached fast web search for missing fields', scheduler.includes('fast=true') && scheduler.includes('persistently cached'));
check('first-party verification probes common contact pages', tools.includes("searchBusinessDirectory") && readFileSync('packages/background-jobs/src/lead-pipeline.ts', 'utf8').includes("'/contact-us'"));
check('campaign qualification requires a verified business and a real email or phone', (() => {
  const pipeline = readFileSync('packages/background-jobs/src/lead-pipeline.ts', 'utf8');
  return pipeline.includes("verification?.status !== 'verified'") &&
    pipeline.includes("!lead.contactEmail && !lead.contactPhone");
})());
check('structured first-party decision makers are retained when explicitly sourced', (() => {
  const pipeline = readFileSync('packages/background-jobs/src/lead-pipeline.ts', 'utf8');
  return pipeline.includes('structuredDecisionMakerFromHtml') &&
    pipeline.includes('decisionMakerSourceUrl');
})());
check('CSV export contains contact details', csv.includes("'Decision Maker', 'Email', 'Phone', 'Contact Source'"));

console.log('Lead contact enrichment contract verified.');

/** Deterministic verification for the Autonomous Revenue Workforce loop.
 *
 * This deliberately avoids Postgres and external providers. It verifies the
 * pure strategy contract plus the source-level wiring that makes strategy and
 * step execution durable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStrategyDraft } from '../packages/core/src/revenue-ops/workforce-loop.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

const strategy = buildStrategyDraft({
  firstName: 'Ada',
  lastName: 'Lovelace',
  title: 'Operations Director',
  email: 'ada@example.com',
  companyName: 'Acme HVAC',
  industry: 'HVAC',
  city: 'Austin',
  contactMetadata: {
    fitReason: 'After-hours calls appear to route to voicemail.',
    outreachAngle: 'Ask how emergency calls are handled after 6 PM.',
  },
  channelOrder: ['email', 'phone'],
});

check('strategy has an auditable objective', strategy.objective.includes('Acme HVAC'));
check('strategy preserves the qualified pain hypothesis', strategy.painHypothesis.includes('voicemail'));
check('strategy preserves the individualized opening angle', strategy.openingAngle.includes('after 6 PM'));
check('strategy preserves channel order', strategy.channelOrder.join(',') === 'email,phone');
check('strategy contains merge-ready personalization', strategy.personalization.firstName === 'Ada');
check('strategy has qualification criteria', strategy.qualificationCriteria.length >= 3);

const fallback = buildStrategyDraft({ companyName: 'Unknown Co', industry: 'Business' });
check('strategy remains actionable without model enrichment', fallback.openingAngle.length > 20);
check('fallback strategy still has a bounded channel plan', fallback.channelOrder.length === 4);

const schema = fs.readFileSync(path.join(root, 'lib/db/src/schema-revenue-ops.ts'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'packages/core/src/revenue-ops/workforce-loop.ts'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'packages/background-jobs/src/revenue-workforce-runner.ts'), 'utf8');

check('schema defines durable outreach strategies', schema.includes("pgTable('outreach_strategies'"));
check('schema defines durable step executions', schema.includes("pgTable('sequence_step_executions'"));
check('step execution ledger has an idempotency key', schema.includes('idempotencyKey'));
check('loop creates a relationship interaction', loop.includes('db.insert(interactions).values'));
check('loop stops external work at approval', loop.includes("status: 'awaiting_approval'"));
check('runner is wired to queue and prepare due work', runner.includes('queueNextRevenueWorkforceStep') && runner.includes('prepareDueRevenueStep'));

if (failures > 0) {
  console.error(`\n${failures} autonomous revenue workforce check(s) failed.`);
  process.exit(1);
}
console.log('\nAll autonomous revenue workforce checks passed.');

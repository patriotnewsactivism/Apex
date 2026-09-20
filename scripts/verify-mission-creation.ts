import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateMissionSchema } from '../packages/api-server/src/routes/missions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = fs.readFileSync(
  path.join(root, 'packages/dashboard/src/components/MissionsDashboard.tsx'),
  'utf8',
);
const apiClient = fs.readFileSync(path.join(root, 'packages/dashboard/src/lib/api.ts'), 'utf8');

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

console.log('Verifying revenue-operations mission creation...\n');

// Mirrors the request shown failing in the dashboard on 2026-09-20: one
// selected channel, a $100 budget, and the raw YYYY-MM-DD emitted by an HTML
// date input. The API must accept it and normalize it to the stored timestamp.
const screenshotPayload = {
  objective: 'Find 2,500 locksmiths, bail bond agencies, commercial roofing companies, and commercial property managers across all 50 states plus the District of Columbia.',
  title: '2,500 nationwide revenue prospects',
  targetDefinition: { industries: [], cities: [], employeeRange: [10, 100] },
  qualificationRules: { mustHavePhone: true, mustHaveEmail: true },
  allowedChannels: ['email'],
  policy: {
    budgetCents: 10_000,
    approveBeforePivot: true,
    firstTouchOptIn: 'manual',
    requireApprovalForNewCampaigns: true,
    requireApprovalForOfferChange: true,
  },
  deadlineAt: '2026-09-21',
};

const parsed = CreateMissionSchema.safeParse(screenshotPayload);
check('the screenshot request is accepted by the API schema', parsed.success, parsed.success ? undefined : parsed.error.flatten());
check(
  'date-only API deadlines normalize to an end-of-day ISO timestamp',
  parsed.success && parsed.data.deadlineAt === '2026-09-21T23:59:59.999Z',
  parsed.success ? parsed.data.deadlineAt : undefined,
);
check(
  'the dashboard converts its local date-picker value before sending',
  dashboard.includes('deadlineAt: deadlineDateToIso(deadlineAt)'),
);
check(
  'API validation errors identify the rejected field instead of only saying Invalid request',
  apiClient.includes('formatApiErrorDetails(err.details)') && apiClient.includes('`${field}: ${error}`'),
);

if (failures > 0) {
  console.error(`\n${failures} mission-creation check(s) failed.`);
  process.exit(1);
}

console.log('\nAll mission-creation checks passed.');

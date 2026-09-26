/**
 * Guard: rehearsal and capped-live auto-approval stay inside the sales tools,
 * and lead import does not invent contacts or drop enrichment columns.
 */
import { decideSalesOutbound, emptyOutboundPolicy, isWithinSendWindow, sameEmail, samePhone } from '../packages/core/src/outbound-policy.js';
import { mapImportRows, planLeadImport, recordsFromCsv } from '../packages/core/src/lead-import.js';
import { getSalesPlaybook, renderPlaybookTemplate } from '../packages/core/src/sales-playbooks.js';
import { buildSalesSuggestions } from '../packages/core/src/sales-suggestions.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
}

const live = {
  ...emptyOutboundPolicy(),
  mode: 'capped_live' as const,
  rehearsalEmail: 'don@example.com',
  rehearsalPhone: '+17135550199',
  postalAddress: '1 Main St, Houston, TX 77002',
  emailsSentToday: 0,
  callsPlacedToday: 0,
};
const noon = new Date('2026-09-26T17:00:00.000Z'); // 12:00 America/Chicago in September (CDT)

console.log('── rehearsal profile only ──');
{
  const policy = { ...live, mode: 'rehearsal_only' as const };
  check('rehearsal email auto-approves', decideSalesOutbound({
    toolName: 'send_email', destinationEmail: 'Don@Example.com', policy,
  }).autoApprove === true);
  check('a stranger is refused in rehearsal mode', decideSalesOutbound({
    toolName: 'send_email', destinationEmail: 'ada@clinic.example', leadId: 'l1', leadExists: true, policy,
  }).autoApprove === false);
  check('deploy is never a sales exception', decideSalesOutbound({
    toolName: 'deploy_to_environment', destinationEmail: 'don@example.com', policy,
  }).autoApprove === false);
  check('kill switch closes rehearsal', decideSalesOutbound({
    toolName: 'send_email', destinationEmail: 'don@example.com', policy: { ...policy, killSwitch: true },
  }).autoApprove === false);
  check('phone match ignores formatting', samePhone('+1 (713) 555-0199', '17135550199'));
  check('email match is case-insensitive', sameEmail(' Don@Example.com ', 'don@example.com'));
}

console.log('\n── capped live ──');
check('live email to a real lead is allowed inside the window', decideSalesOutbound({
  toolName: 'send_email',
  destinationEmail: 'ada@clinic.example',
  leadId: 'lead-1',
  leadExists: true,
  policy: live,
  now: noon,
}).autoApprove === true);
check('live email without a lead is refused', decideSalesOutbound({
  toolName: 'send_email',
  destinationEmail: 'ada@clinic.example',
  policy: live,
  now: noon,
}).autoApprove === false);
check('live email without a postal address is refused', decideSalesOutbound({
  toolName: 'send_email',
  destinationEmail: 'ada@clinic.example',
  leadId: 'lead-1',
  leadExists: true,
  policy: { ...live, postalAddress: null },
  now: noon,
}).autoApprove === false);
check('off mode refuses everyone', decideSalesOutbound({
  toolName: 'send_email',
  destinationEmail: 'don@example.com',
  policy: emptyOutboundPolicy(),
}).autoApprove === false);
check('missing policy fails closed', decideSalesOutbound({
  toolName: 'send_email',
  destinationEmail: 'don@example.com',
  policy: null,
}).autoApprove === false);
check('noon Chicago is inside 8-19', isWithinSendWindow(noon, live));

console.log('\n── playbook refuses blank required fields ──');
{
  const playbook = getSalesPlaybook('buildmybot-intro');
  check('intro playbook exists', Boolean(playbook));
  const rendered = renderPlaybookTemplate(playbook!.openEmail.subject, { companyName: '' });
  check('missing company is reported', rendered.missing.includes('companyName'));
  check('the token is not silently deleted', rendered.text.includes('{{companyName}}'));
}

console.log('\n── import keeps enrichment and dedupes ──');
{
  const csv = [
    'Company Name,Email,Phone,Decision Maker,Apollo Person Id',
    'Northside Dental,ada@northside.example,+17135550100,Ada Lopez,apollo-1',
    'Northside Dental,ada@northside.example,+17135550100,Ada Lopez,apollo-1',
    'No Contact Co,,,,',
  ].join('\n');
  const mapped = mapImportRows(recordsFromCsv(csv), 'apollo');
  check('empty contact row is skipped and both file rows stay for dedupe', mapped.leads.length === 2 && mapped.skipped.length === 1);
  check('unknown column is enrichment', mapped.leads[0]?.enrichment['Apollo Person Id'] === 'apollo-1');
  const plan = planLeadImport({
    leads: mapped.leads,
    existing: [{
      id: 'existing-1',
      contactEmail: 'ada@northside.example',
      website: null,
      decisionMakerName: null,
      contactPhone: null,
      title: null,
      linkedinUrl: null,
      employeeCount: null,
      outreachAngle: 'keep this',
      enrichment: null,
    }],
    overwrite: false,
    parseSkips: mapped.skipped,
  });
  const update = plan.rows.find((row) => row.action === 'update');
  check('existing email updates instead of inserting', update?.existingId === 'existing-1');
  check('a researched angle is not overwritten by an empty import', update?.lead.outreachAngle === 'keep this');
  check('counts include the file duplicate and the empty row as skips', plan.counts.skipped === 2 && plan.counts.updated === 1);
}

console.log('\n── suggestions name an action ──');
{
  const suggestions = buildSalesSuggestions({
    policyMode: 'off',
    killSwitch: true,
    rehearsalReady: false,
    rehearsalSucceeded: false,
    lastRehearsalError: null,
    liveUnjoinedCallId: null,
    failureGroups: [],
    queuedCampaigns: 0,
    importedWithEmail: 0,
  });
  check('kill switch suggestion can resume outbound', suggestions.some((item) => item.action === 'resume-outbound'));
}

if (failures > 0) {
  console.error(`\n${failures} sales-outbound check(s) failed.`);
  process.exit(1);
}
console.log('\nAll sales-outbound checks passed.');

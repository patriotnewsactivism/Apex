/**
 * Verifies the "gave up ≠ done" guard against the REAL strings that were
 * recorded as completed on 2026-07-29, plus the false positives that would be
 * expensive to get wrong (a genuine short "nothing to do", and a real report
 * that merely mentions a limitation).
 */
import { detectNonCompletion, detectAnnouncedButNotTaken } from '../packages/core/src/non-completion.js';

let failures = 0;
const check = (l: string, c: boolean, d?: unknown) => {
  console.log(c ? `  ✅ ${l}` : `  ❌ ${l} ${d !== undefined ? JSON.stringify(d) : ''}`);
  if (!c) failures++;
};
const must = (l: string, s: string) => { const r = detectNonCompletion(s); check(l, r !== null, r); return r; };
const mustNot = (l: string, s: string) => { const r = detectNonCompletion(s); check(l, r === null, r); };

console.log('── MUST FAIL (these were all recorded as "Task completed" live) ──');
const a = must('[frontend] "I am unable to access the code for the frontend."',
  'I am unable to access the code for the frontend.');
console.log(`      → pattern=${a?.pattern}`);
must('[devops] "I\'m sorry, I don\'t have access to the deployment/configuration changes."',
  "I'm sorry, I don't have access to the deployment/configuration changes.");
must('[lead-dev] "I have not yet received the results of my investigations."',
  'I have not yet received the results of my investigations.');
must('[backend] ERR_MODULE_NOT_FOUND dump',
  "I'm sorry, I encountered an error while running the code. The error message is: ```\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/packages/api-server/.local/sandboxes/d6d61994'\n```");
must('[qa-director] all-N/A persona report',
  '## Persona: Susan Severity: N/A Finding: N/A Suggested Fix: N/A ## Persona: Marcus Severity: N/A Finding: N/A Suggested Fix: N/A ## Persona: Accessibility reviewer Severity: N/A Finding: N/A');
must('generic "I cannot complete"', 'I cannot complete this task without repository access.');
must('"I couldn\'t find any" empty-search', "I couldn't find any qualifying businesses in that region.");

console.log('\n── MUST NOT FAIL (legitimate completions) ──');
mustNot('deliberate no-action result (the restraint prompts ask for this)',
  'System is healthy, no degraded components, backlog is empty. Nothing needs doing this cycle — recorded a note to memory and created no tasks.');
mustNot('real delivery',
  'Saved 32 qualifying HVAC leads across Dallas and Fort Worth. All persisted via saveResearchedLeadsBatch. No duplicates against the existing pipeline.');
mustNot('substantial report that MENTIONS a limitation',
  'Completed the audit of the deployment pipeline. I was unable to reach the staging host, so the figures below come from production instead. ' +
  'Test suite: 9/9 passing in 48.8s. Lint: clean. Build: 20.3s, dashboard emitted dist/index.html plus JS and CSS bundles. ' +
  'Deployment history shows 4 successful deploys in the last 24h and one automated rollback triggered by the health monitor at 03:14Z. ' +
  'Recommend raising the health-check grace period from 30s to 60s, since the rollback fired during a cold start rather than a real fault. ' +
  'No further action needed from the CTO branch this cycle; I will re-verify after the next deploy lands.');
mustNot('closing out a goal honestly with a partial',
  'Goal closed as completed. Delivered 43 leads across two industries. The Florida roofing sweep returned nothing and was re-delegated separately; that gap is noted in the goal result.');
mustNot('empty content', '');
mustNot('one N/A field in an otherwise real report',
  'Persona: Susan. Severity: Medium. Finding: checkout button unlabeled for screen readers. Suggested Fix: add aria-label. Owner: N/A');

console.log('\n── ANNOUNCED-BUT-NEVER-TAKEN (why leads stopped saving) ──');
const TOOLS = ['saveResearchedLeadsBatch', 'saveResearchedLead', 'searchBusinessDirectory', 'sendMessage'];
const mustA = (l: string, s: string) => { const r = detectAnnouncedButNotTaken(s, TOOLS); check(l, r !== null, r); return r; };
const mustNotA = (l: string, s: string) => check(l, detectAnnouncedButNotTaken(s, TOOLS) === null, detectAnnouncedButNotTaken(s, TOOLS));

const real = mustA('REAL live string: "I will now save these leads using saveResearchedLeadsBatch."',
  'I have found 20 legal firms in Miami, FL. I will now save these leads using saveResearchedLeadsBatch.');
console.log(`      → ${real?.pattern}`);
mustA('"Let me call searchBusinessDirectory"', 'Let me call searchBusinessDirectory to find more prospects.');
mustA('"Next, I will use sendMessage"', 'Analysis done. Next, I will use sendMessage to brief the COO.');

mustNotA('legitimate hand-off naming no tool', 'I have delegated this to the CTO and I will report back once they respond.');
mustNotA('past tense — work actually done', 'I called saveResearchedLeadsBatch and persisted 32 leads. No duplicates.');
mustNotA('tool named far from any intent phrase',
  'I will summarize below.\n\n' + 'Findings are extensive and detailed across many regions and industries. '.repeat(6) + '\nEarlier steps used saveResearchedLeadsBatch successfully.');
check('no tools available → cannot match', detectAnnouncedButNotTaken('I will now save these leads using saveResearchedLeadsBatch.', []) === null);

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

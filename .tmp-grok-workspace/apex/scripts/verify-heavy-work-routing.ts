// ─── Guard: heavy-work classification is advisory, never a silent reassignment ─
//
// Behavioural half: classifyWorkload() against real task-shaped phrases (both
// the examples the upgrade spec names and ordinary short tasks that must NOT
// trigger), and the advisory/nudge text builders.
// Source half: delegate()'s advisory injection never touches context.runtime
// or assignedAgentId — the one invariant that keeps this feature safe (see
// work-classifier.ts's doc comment on why silent reassignment is unsafe).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyWorkload,
  buildHeavyWorkAdvisory,
  buildHeavyWorkExecutionNudge,
} from '../packages/core/src/work-classifier.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

console.log('── Positive signals (the phases explicitly named) ──');
const heavyExamples: Array<[string, string, string]> = [
  ['test_suite', 'Run full test suite', 'Run the full repository test suite before merging.'],
  ['test_suite', 'CI', 'Please run all tests across every package.'],
  ['build', 'Ship', 'Build the project for production and verify the bundle.'],
  ['render', 'Video', 'Start rendering a video for the new campaign.'],
  ['static_analysis', 'Audit', 'Kick off a repository-wide static analysis pass.'],
  ['browser_automation', 'Crawl', 'Set up long-running browser automation to crawl the entire site.'],
  ['data_processing', 'ETL', 'We need large-scale data processing on the new export.'],
  ['integration_test', 'QA', 'Run the full integration tests against staging.'],
];
for (const [expectedCategory, title, description] of heavyExamples) {
  const result = classifyWorkload(title, description);
  check(`"${description}" is classified heavy (${expectedCategory})`, result.heavy && result.category === expectedCategory, result);
}

console.log('\n── Negative signals (ordinary short tasks must not trigger) ──');
const lightExamples: Array<[string, string]> = [
  ['Fix typo', 'Fix a typo in the README.'],
  ['Reply', 'Reply to the customer email about billing.'],
  ['One test', 'Add a unit test for the new validator function.'],
  ['Read file', 'Read config.json and summarize its contents.'],
];
for (const [title, description] of lightExamples) {
  const result = classifyWorkload(title, description);
  check(`"${description}" is NOT classified heavy`, !result.heavy, result);
}

console.log('\n── Confidence and signals are real, not fabricated ──');
check('confidence is 0 for a non-match', classifyWorkload('x', 'y').confidence === 0);
check('signals list contains the actual matched phrase, not a generic label', (() => {
  const r = classifyWorkload('t', 'Run the full repository test suite tonight.');
  return r.signals.length > 0 && r.signals.every((s) => r.category !== 'none');
})());

console.log('\n── Advisory/nudge text is non-empty and names the real category ──');
const sample = classifyWorkload('t', 'Run the full test suite.');
check('delegation-time advisory mentions the category', buildHeavyWorkAdvisory(sample).includes('test suite'));
check('delegation-time advisory recommends the existing tool by name', buildHeavyWorkAdvisory(sample).includes('run_executor_job'));
check('execution-time nudge recommends run_executor_job', buildHeavyWorkExecutionNudge(sample).includes('run_executor_job'));
check('execution-time nudge explicitly allows overriding a false-positive match',
  buildHeavyWorkExecutionNudge(sample).toLowerCase().includes('heuristic'));

console.log('\n── Advisory-only wiring (source): never a silent reassignment ──');
const agentSource = fs.readFileSync(path.join(root, 'packages/core/src/base-agent.ts'), 'utf8');

const delegateStart = agentSource.indexOf('async delegate(');
const delegateEnd = agentSource.indexOf('\n  async findAgentIdByRole', delegateStart);
const delegateBody = agentSource.slice(delegateStart, delegateEnd);
check('delegate() classifies the incoming task', delegateBody.includes('classifyWorkload(input.title, input.description)'));
check('delegate() only ever modifies the description, never assignedAgentId or context.runtime',
  (() => {
    const assignedAgentIdLines = delegateBody.split('\n').filter((line) => line.includes('assignedAgentId:'));
    return (
      delegateBody.includes('buildHeavyWorkAdvisory(classification)') &&
      !delegateBody.includes('context.runtime') &&
      assignedAgentIdLines.length > 0 &&
      assignedAgentIdLines.every((line) => line.includes('targetAgentId'))
    );
  })());
check('delegate() still assigns exactly to the caller-specified targetAgentId, classifier result notwithstanding',
  /assignedAgentId:\s*targetAgentId/.test(delegateBody));

check('the execution-time nudge only fires when this agent actually holds run_executor_job',
  agentSource.includes("this.config.tools.includes('run_executor_job')"));
check('the execution-time nudge never fires for a task already bound to the executor sandbox',
  agentSource.includes("context.runtime !== 'job' && this.config.tools.includes('run_executor_job')"));
check('the nudge only appears on a fresh execution, not on every resume (checked inside the non-checkpoint branch)',
  (() => {
    const elseIdx = agentSource.indexOf('} else {\n        // Build initial message history');
    const nudgeIdx = agentSource.indexOf("classifyWorkload(title, description)", elseIdx);
    const nextMethodIdx = agentSource.indexOf('const registry = getToolRegistry(', elseIdx);
    return elseIdx >= 0 && nudgeIdx > elseIdx && nudgeIdx < nextMethodIdx;
  })());

const classifierSource = fs.readFileSync(path.join(root, 'packages/core/src/work-classifier.ts'), 'utf8');
check('the classifier module documents why it must stay advisory-only',
  classifierSource.toLowerCase().includes('silently') || classifierSource.toLowerCase().includes('reassign'));

console.log(failures === 0 ? '\n✅ ALL HEAVY-WORK ROUTING GUARDS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

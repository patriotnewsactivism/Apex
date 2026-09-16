// ─── Guard: circular investigation is detected and forces one decision point ──
//
// Behavioural half: detectRepetition()/shouldPromptForConcreteAction() against
// synthetic tool-call logs.
// Source half: base-agent.ts wires both, each bounded to fire at most once
// per task so a model that ignores the nudge falls through to the existing
// max-iterations/non-completion guards rather than an escalating nag loop.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyToolCallForCheckpoint,
  detectRepetition,
  toolCallArgsKey,
  buildRepetitionInterventionMessage,
  shouldPromptForConcreteAction,
  buildConcreteActionPrompt,
  type ToolCallRecord,
} from '../packages/core/src/execution-budget.js';

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

function calls(...pairs: Array<[string, unknown]>): ToolCallRecord[] {
  return pairs.map(([name, args]) => ({ name, argsKey: toolCallArgsKey(args) }));
}

console.log('── Tool categorization (feeds both checkpoints and repetition detection) ──');
check('a real read-only tool is a finding', classifyToolCallForCheckpoint('webSearch') === 'finding');
check('a real state-changing tool is a decision', classifyToolCallForCheckpoint('store_artifact') === 'decision');
check('escalate_to_human is a blocker', classifyToolCallForCheckpoint('escalate_to_human') === 'blocker');
check('an unrecognized tool name is neutral, never guessed into a category', classifyToolCallForCheckpoint('some_future_tool_xyz') === 'neutral');

console.log('\n── Repetition detection ──');
check('three identical webSearch calls trigger', detectRepetition(calls(
  ['webSearch', { query: 'leads' }],
  ['webSearch', { query: 'leads' }],
  ['webSearch', { query: 'leads' }],
))?.count === 3);
check('two identical calls do not yet trigger (threshold is 3)', detectRepetition(calls(
  ['webSearch', { query: 'leads' }],
  ['webSearch', { query: 'leads' }],
)) === null);
check('argument order does not defeat detection (canonical key)', detectRepetition(calls(
  ['webSearch', { query: 'leads', region: 'US' }],
  ['webSearch', { region: 'US', query: 'leads' }],
  ['webSearch', { query: 'leads', region: 'US' }],
))?.count === 3);
check('different arguments each time never trigger', detectRepetition(calls(
  ['webSearch', { query: 'leads-1' }],
  ['webSearch', { query: 'leads-2' }],
  ['webSearch', { query: 'leads-3' }],
)) === null);
check('a polling tool (get_delegation_status) is exempt even called many times identically', detectRepetition(calls(
  ['get_delegation_status', { swarmId: 's1' }],
  ['get_delegation_status', { swarmId: 's1' }],
  ['get_delegation_status', { swarmId: 's1' }],
  ['get_delegation_status', { swarmId: 's1' }],
)) === null);
check('a decision-category tool repeated identically is exempt (its own idempotency key governs it, not this guard)', detectRepetition(calls(
  ['store_artifact', { path: 'a.txt' }],
  ['store_artifact', { path: 'a.txt' }],
  ['store_artifact', { path: 'a.txt' }],
)) === null);
check('a custom threshold is honored', detectRepetition(calls(
  ['webSearch', { q: 1 }],
  ['webSearch', { q: 1 }],
), 2)?.count === 2);
check('the intervention message names the exact offending tool and forbids repeating it',
  (() => {
    const finding = detectRepetition(calls(['readFile', { path: 'x' }], ['readFile', { path: 'x' }], ['readFile', { path: 'x' }]));
    if (!finding) return false;
    const msg = buildRepetitionInterventionMessage(finding);
    return msg.includes('readFile') && msg.toLowerCase().includes('do not call this exact tool');
  })());

console.log('\n── Budget/concrete-action nudge ──');
check('does not fire once a decision-category tool has already run', !shouldPromptForConcreteAction({ iterations: 15, toolExecutions: 10, maxIterations: 20 }, 1));
check('does not fire early in a task even with zero decisions yet', !shouldPromptForConcreteAction({ iterations: 2, toolExecutions: 1, maxIterations: 20 }, 0));
check('fires once a task has burned most of its budget on pure investigation', shouldPromptForConcreteAction({ iterations: 13, toolExecutions: 5, maxIterations: 20 }, 0));
check('the prompt states the real iteration/tool counts, not a placeholder', (() => {
  const msg = buildConcreteActionPrompt({ iterations: 13, toolExecutions: 5, maxIterations: 20 });
  return msg.includes('13 of 20') && msg.includes('5 tool calls');
})());

console.log('\n── Wiring in base-agent.ts (source): fires at most once per task ──');
const agentSource = fs.readFileSync(path.join(root, 'packages/core/src/base-agent.ts'), 'utf8');
check('repetitionIntervened bounds the nudge to a single occurrence',
  agentSource.includes('let repetitionIntervened = false;') &&
  agentSource.includes('if (!repetitionIntervened)') &&
  agentSource.includes('repetitionIntervened = true;'));
check('budgetPrompted bounds the concrete-action nudge to a single occurrence',
  agentSource.includes('let budgetPrompted = false;') &&
  agentSource.includes('!budgetPrompted &&') &&
  agentSource.includes('budgetPrompted = true;'));
check('both checks run after tool results are appended, so they see the real just-executed call log',
  agentSource.indexOf('history.push(...toolResults);') < agentSource.indexOf('detectRepetition(toolCallLog)'));

console.log(failures === 0 ? '\n✅ ALL TASK-ECONOMY GUARDS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

// ─── Guard: a warned identical read stops before it runs again ───────────────
//
// Local only. No provider calls, no production database. Tool execution is a
// BaseAgent subclass override so the loop decision is real and the tool body
// never reaches the registry, provenance, or network.
//
// DATABASE_URL is forced to a closed local port before any workspace import
// so a stray logger/status write cannot reach a configured database.

process.env.DATABASE_URL = 'postgres://127.0.0.1:1/repetition_stop_refused';
process.env.NODE_ENV = 'test';
process.env.APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK = '1';
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RAILWAY_ENVIRONMENT_NAME;
delete process.env.RAILWAY_GIT_COMMIT_SHA;
delete process.env.APEX_BUILD_SHA;

import { ApprovalYieldSignal } from '../packages/core/src/approval-continuation.js';
import { BaseAgent } from '../packages/core/src/base-agent.js';
import {
  additionalRepetitionsSinceIntervention,
  armRepetitionStop,
  buildRepeatedReadBlockMessage,
  detectRepetition,
  isStoppableRead,
  shouldBlockRepeatedRead,
  toolCallArgsKey,
  toolResultKey,
  type RepetitionFinding,
  type ToolCallRecord,
} from '../packages/core/src/execution-budget.js';
import type { AgentStatus, LLMMessage, ToolContext, ToolResult } from '../packages/core/src/types.js';

const dbUrl = new URL(process.env.DATABASE_URL);
if (dbUrl.hostname !== '127.0.0.1' || dbUrl.port !== '1') {
  throw new Error('Refusing to run with a database URL that is not the closed local probe');
}

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

function record(name: string, args: unknown, resultKey?: string): ToolCallRecord {
  return { name, argsKey: toolCallArgsKey(args), ...(resultKey === undefined ? {} : { resultKey }) };
}

console.log('── Stop arms only for a non-polling read, and not from history alone ──');
check('webSearch is a stoppable read', isStoppableRead('webSearch'));
check('readFile is a stoppable read', isStoppableRead('readFile'));
check('polling get_delegation_status is not stoppable', !isStoppableRead('get_delegation_status'));
check('decision writeFile is not stoppable', !isStoppableRead('writeFile'));
check('arbitrary runShell is not stoppable', !isStoppableRead('runShell'));
check('unrecognized custom_side_effect is not stoppable', !isStoppableRead('custom_side_effect'));

const sameArgs = { query: 'leads', region: 'US' };
const sameKey = toolCallArgsKey(sameArgs);
const historical: ToolCallRecord[] = [
  record('webSearch', sameArgs, 'same'),
  record('webSearch', { region: 'US', query: 'leads' }, 'same'),
  record('webSearch', sameArgs, 'same'),
];
const finding = detectRepetition(historical);
check('three identical reads still detect', finding?.count === 3 && finding.toolName === 'webSearch');
const armed = finding ? armRepetitionStop(finding, historical) : null;
check('arming snapshots the executed count, not a new violation', armed?.executedCountAtIntervention === 3);
check(
  'retained historical log is not an additional repetition',
  armed !== null && additionalRepetitionsSinceIntervention(armed, historical) === 0,
);
check(
  'a still-positive detectRepetition on that log does not block without a new attempt',
  armed !== null && detectRepetition(historical) !== null && !shouldBlockRepeatedRead(armed, null),
);
check(
  'the same canonical args on a new attempt would block',
  armed !== null && shouldBlockRepeatedRead(armed, { name: 'webSearch', argsKey: toolCallArgsKey({ region: 'US', query: 'leads' }) }),
);
check(
  'different args are not the warned call',
  armed !== null && !shouldBlockRepeatedRead(armed, { name: 'webSearch', argsKey: toolCallArgsKey({ query: 'other' }) }),
);
check(
  'a write is not blocked even with the warned args key',
  armed !== null && !shouldBlockRepeatedRead(armed, { name: 'writeFile', argsKey: sameKey }),
);
check(
  'a poll is not blocked even with the warned args key',
  armed !== null && !shouldBlockRepeatedRead(armed, { name: 'get_delegation_status', argsKey: sameKey }),
);

const writeFinding: RepetitionFinding = { repeated: true, toolName: 'writeFile', argsKey: '{}', count: 4 };
const pollFinding: RepetitionFinding = { repeated: true, toolName: 'get_delegation_status', argsKey: '{}', count: 9 };
const shellFinding: RepetitionFinding = { repeated: true, toolName: 'runShell', argsKey: '{}', count: 3 };
check('arming refuses a decision tool', armRepetitionStop(writeFinding, []) === null);
check('arming refuses a polling tool', armRepetitionStop(pollFinding, []) === null);
check('arming refuses an arbitrary action', armRepetitionStop(shellFinding, []) === null);

console.log('\n── Changed tool outcomes reset no-progress evidence ──');
const varying: ToolCallRecord[] = [
  record('readFile', { path: 'a.txt' }, toolResultKey({ success: true, data: { n: 1 } })),
  record('readFile', { path: 'a.txt' }, toolResultKey({ success: true, data: { n: 2 } })),
  record('readFile', { path: 'a.txt' }, toolResultKey({ success: true, data: { n: 3 } })),
];
check('three identical reads with different results do not detect', detectRepetition(varying) === null);
const stable: ToolCallRecord[] = [
  record('readFile', { path: 'a.txt' }, toolResultKey({ success: true, data: { n: 1 } })),
  record('readFile', { path: 'a.txt' }, toolResultKey({ success: true, data: { n: 1 } })),
  record('readFile', { path: 'a.txt' }, toolResultKey({ success: true, data: { n: 1 } })),
];
check('three identical reads with the same result still detect', detectRepetition(stable)?.count === 3);
check(
  'calls without a result fingerprint keep the existing args-only count',
  detectRepetition([
    record('webSearch', { query: 'leads' }),
    record('webSearch', { query: 'leads' }),
    record('webSearch', { query: 'leads' }),
  ])?.count === 3,
);
const blockMessage = armed ? buildRepeatedReadBlockMessage(armed) : '';
check(
  'the blocker names the tool and says the task is not complete',
  blockMessage.includes('webSearch') && /not complete/i.test(blockMessage) && /not executed/i.test(blockMessage),
);

type Step = Array<{ name: string; args: Record<string, unknown> }> | 'final';

class ProbeAgent extends BaseAgent {
  executions: Array<{ name: string; args: Record<string, unknown> }> = [];
  failures: string[] = [];
  completions: string[] = [];
  checkpoints = 0;
  llmCalls = 0;
  blockedHistory: LLMMessage[] | null = null;
  varyResults = false;
  yieldOnTool: string | null = null;

  constructor(private script: Step[], tools: string[]) {
    super({
      id: `repetition-stop-${Math.random().toString(16).slice(2)}`,
      name: 'Repetition stop probe',
      role: 'RESEARCH',
      tier: 2,
      systemPrompt: 'Probe. Do not call providers.',
      tools,
      maxIterations: 8,
      llm: { provider: 'test', model: 'test' },
    });
    this.memory.buildMemoryContext = async () => '';
    this.memory.remember = async () => {};
    const silent = async () => {};
    this.logger = {
      log: silent,
      thinking: silent,
      acting: silent,
      info: silent,
      warn: silent,
      error: silent,
    } as unknown as typeof this.logger;
    this.taskQueue.fail = async (_taskId: string, error: string) => {
      this.failures.push(error);
    };
    this.taskQueue.complete = async (_taskId: string, result: string) => {
      this.completions.push(result);
    };
    this.taskQueue.checkpointAndResume = async () => {
      this.checkpoints += 1;
      return true;
    };
    let issued = 0;
    this.llm.complete = async () => {
      this.llmCalls += 1;
      const step = this.script[Math.min(issued, this.script.length - 1)];
      issued += 1;
      if (step === 'final') {
        return {
          content: 'Status recorded. Nothing further to investigate.',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1 },
          model: 'test',
        };
      }
      return {
        content: '',
        toolCalls: step.map((call, index) => ({
          id: `call-${this.llmCalls}-${index}`,
          name: call.name,
          args: call.args,
        })),
        usage: { promptTokens: 1, completionTokens: 1 },
        model: 'test',
      };
    };
  }

  protected override setStatus(status: AgentStatus): void {
    this.status = status;
  }

  protected override onNoProgressReadBlocked(event: { toolName: string; argsKey: string; history: LLMMessage[] }): void {
    this.blockedHistory = event.history;
  }

  protected override async executeRegisteredTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    this.executions.push({ name, args: { ...args } });
    if (this.yieldOnTool === name) {
      throw new ApprovalYieldSignal(context.taskId ?? 'missing-task', 'approval-probe');
    }
    const n = this.executions.filter((call) => call.name === name && toolCallArgsKey(call.args) === toolCallArgsKey(args)).length;
    return {
      success: true,
      data: this.varyResults ? { n } : { snapshot: 'same' },
    };
  }

  run() {
    return this.executeTask(`task-${this.id}`, 'Probe repeated reads', 'Stop if the same read is retried after a warning.', {});
  }
}

function countTool(agent: ProbeAgent, name: string, args?: Record<string, unknown>): number {
  return agent.executions.filter((call) =>
    call.name === name && (args === undefined || toolCallArgsKey(call.args) === toolCallArgsKey(args)),
  ).length;
}

function paired(history: LLMMessage[] | null): boolean {
  if (!history || history.length < 4) return false;
  const assistants = history.filter((message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0);
  const last = assistants[assistants.length - 1];
  if (!last?.toolCalls?.length) return false;
  return last.toolCalls.every((call) =>
    history.some((message) => message.role === 'tool' && message.toolCallId === call.id),
  );
}

async function main(): Promise<void> {
  console.log('\n── BaseAgent refuses the warned read before executing it ──');
  const repeat = new ProbeAgent(
    Array.from({ length: 8 }, () => [{ name: 'webSearch', args: { query: 'leads', region: 'US' } }]),
    ['webSearch'],
  );
  const repeatResult = await repeat.run();
  check('identical read executes three times, not the fourth', countTool(repeat, 'webSearch') === 3, repeat.executions);
  check('the fourth model turn is the refused attempt, not another nudge loop', repeat.llmCalls === 4, repeat.llmCalls);
  check('the task is failed, not completed', repeatResult.success === false && repeat.completions.length === 0, repeatResult);
  check('failure went through taskQueue.fail', repeat.failures.length === 1, repeat.failures);
  check(
    'the failure is the concrete no-progress blocker',
    (repeatResult.error ?? '').includes('webSearch') && /not complete/i.test(repeatResult.error ?? '') && /not executed/i.test(repeatResult.error ?? ''),
    repeatResult.error,
  );
  check('history was not deleted and assistant/tool calls stay paired', paired(repeat.blockedHistory), repeat.blockedHistory?.map((message) => message.role));
  check('a repetition stop does not checkpoint or yield the task as done', repeat.checkpoints === 0 && repeatResult.yielded !== true);

  const trailing = new ProbeAgent(
    [
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [
        { name: 'webSearch', args: { query: 'leads' } },
        { name: 'writeFile', args: { path: 'a.txt', content: 'x' } },
      ],
    ],
    ['webSearch', 'writeFile'],
  );
  await trailing.run();
  check('a write batched after the refused read is not executed', countTool(trailing, 'writeFile') === 0, trailing.executions);
  check(
    'the blocked batch still pairs every assistant tool call',
    paired(trailing.blockedHistory) &&
      (trailing.blockedHistory ?? []).some((message) => message.role === 'tool' && message.name === 'writeFile'),
  );

  console.log('\n── Exemptions and real progress still run ──');
  const changed = new ProbeAgent(
    [...Array.from({ length: 6 }, () => [{ name: 'readFile', args: { path: 'notes.txt' } }]), 'final'],
    ['readFile'],
  );
  changed.varyResults = true;
  const changedResult = await changed.run();
  check('a changing read result resets evidence and keeps executing', countTool(changed, 'readFile') === 6, changed.executions);
  check('changed results complete instead of blocking', changedResult.success === true && changed.failures.length === 0, changedResult);

  const differentArgs = new ProbeAgent(
    [
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [{ name: 'webSearch', args: { query: 'other' } }],
      'final',
    ],
    ['webSearch'],
  );
  const differentResult = await differentArgs.run();
  check('a different query after the warning still executes', countTool(differentArgs, 'webSearch', { query: 'other' }) === 1, differentArgs.executions);
  check('different args are not a repetition failure', differentResult.success === true && differentArgs.failures.length === 0, differentResult);

  const polling = new ProbeAgent(
    [...Array.from({ length: 6 }, () => [{ name: 'get_delegation_status', args: { swarmId: 's1' } }]), 'final'],
    ['get_delegation_status'],
  );
  const pollingResult = await polling.run();
  check('polling the same status is not stopped', countTool(polling, 'get_delegation_status') === 6, polling.executions);
  check('polling completes', pollingResult.success === true && polling.failures.length === 0, pollingResult);

  const decision = new ProbeAgent(
    [...Array.from({ length: 5 }, () => [{ name: 'writeFile', args: { path: 'a.txt', content: 'x' } }]), 'final'],
    ['writeFile'],
  );
  const decisionResult = await decision.run();
  check('a repeated decision tool is not stopped', countTool(decision, 'writeFile') === 5, decision.executions);
  check('repeated writes complete', decisionResult.success === true && decision.failures.length === 0, decisionResult);

  const arbitrary = new ProbeAgent(
    [...Array.from({ length: 5 }, () => [{ name: 'custom_side_effect', args: { op: 'touch' } }]), 'final'],
    ['custom_side_effect'],
  );
  const arbitraryResult = await arbitrary.run();
  check('an arbitrary action is not hard-stopped', countTool(arbitrary, 'custom_side_effect') === 5, arbitrary.executions);
  check('arbitrary actions complete', arbitraryResult.success === true && arbitrary.failures.length === 0, arbitraryResult);

  const approval = new ProbeAgent(
    [
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [{ name: 'webSearch', args: { query: 'leads' } }],
      [{ name: 'fetchUrl', args: { url: 'https://example.invalid/status' } }],
    ],
    ['webSearch', 'fetchUrl'],
  );
  approval.yieldOnTool = 'fetchUrl';
  const approvalResult = await approval.run();
  check('an approval yield after the warning is not rewritten as a repetition failure', approvalResult.success === true && approvalResult.yielded === true, approvalResult);
  check('the yield did not fail or complete the task', approval.failures.length === 0 && approval.completions.length === 0);
  check('the yield tool was entered and the warned read was not repeated', countTool(approval, 'fetchUrl') === 1 && countTool(approval, 'webSearch') === 3);

  console.log(failures === 0 ? '\n✅ ALL REPETITION-STOP GUARDS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

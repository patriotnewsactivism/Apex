/**
 * Verifies the two fixes for the 2026-07-28 outage, against real code and a
 * real Postgres:
 *   1. request-size control (the groq 413 that broke the whole fallback chain)
 *   2. provider-failure recovery (22 tasks left permanently dead)
 *
 * DESTRUCTIVE — truncates tasks/agents. Scratch DB only, never production.
 *   DATABASE_URL=postgres://user@host:port/scratch \
 *     pnpm --filter @workspace/api-server exec tsx ../../scripts/verify-outage-resilience.ts
 */
import { randomUUID } from 'crypto';
import { db, migrate, tasks, agents } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  trimMessageHistory,
  historySize,
  isRequestTooLargeError,
  DEFAULT_HISTORY_CHAR_BUDGET,
  EMERGENCY_HISTORY_CHAR_BUDGET,
} from '../packages/core/src/llm-client.js';
import { StalledWorkRecoveryJob } from '../packages/background-jobs/src/index.js';
import type { LLMMessage, ScheduledJob } from '../packages/core/src/types.js';

let failures = 0;
const check = (l: string, c: boolean, d?: unknown) => {
  console.log(c ? `  ✅ ${l}` : `  ❌ ${l} ${d !== undefined ? JSON.stringify(d).slice(0, 300) : ''}`);
  if (!c) failures++;
};

const job = (payload: Record<string, unknown>) =>
  ({
    id: 'test-recovery', name: 't', jobType: 'stalled_work_recovery', cronExpression: '*/10 * * * *',
    enabled: true, targetAgentId: null, payload, priority: 2, status: 'active', retryCount: 0,
    maxRetries: 3, nextRunAt: new Date(), lastRunAt: null, error: null, createdAt: new Date(), updatedAt: new Date(),
  }) as unknown as ScheduledJob;

// The real error string captured from the live service on 2026-07-28.
const REAL_CAPACITY_ERROR =
  'All LLM providers failed.\n' +
  '  • cerebras (model: gpt-oss-120b, status: 429): 429 status code (no body)\n' +
  '  • groq (model: llama-3.3-70b-versatile, status: 413): 413 Request too large for model ' +
  '`llama-3.3-70b-versatile` in organization `org_01k8` service tier `on_demand` on tokens per minute (TPM)';

// Real failures from the 2026-08-22 outage. These are configuration/model
// failures rather than quota failures, but become recoverable after a key or
// deployment repair and therefore must not leave the work permanently dead.
const RETIRED_MODEL_ERROR =
  'All LLM providers failed. • openrouter-free (model: openai/gpt-oss-20b:free, status: 404): ' +
  '404 This model is unavailable for free.';
const NO_CONFIGURED_PROVIDER_ERROR =
  'All LLM providers failed. (no providers were configured or had API keys)';

async function main() {
  console.log('── 1. Request-size control (the 413 that broke the chain) ──');

  check('413 status recognized as too-large', isRequestTooLargeError(413, 'whatever'));
  check('groq TPM message recognized by text', isRequestTooLargeError(undefined, REAL_CAPACITY_ERROR));
  check('context-length phrasing recognized', isRequestTooLargeError(400, 'maximum context length exceeded'));
  check('a plain 429 is NOT treated as too-large', !isRequestTooLargeError(429, '429 status code (no body)'));

  // A realistic overgrown agent history: system + task + 40 iterations of
  // assistant/tool pairs with fat tool results (search dumps, file contents).
  const history: LLMMessage[] = [
    { role: 'system', content: 'You are the Lead Researcher. ' + 'x'.repeat(3_000) },
    { role: 'user', content: 'TASK: Find HVAC companies in Texas and save every qualifying lead.' },
  ];
  for (let i = 0; i < 40; i++) {
    history.push({ role: 'assistant', content: `Step ${i}: searching.`, toolCalls: [{ id: `c${i}`, name: 'webSearch', args: { q: `hvac ${i}` } }] });
    history.push({ role: 'tool', toolCallId: `c${i}`, name: 'webSearch', content: JSON.stringify({ results: 'y'.repeat(9_000) }) });
  }
  const before = historySize(history);
  check(`built an oversized history (${before} chars > budget ${DEFAULT_HISTORY_CHAR_BUDGET})`, before > DEFAULT_HISTORY_CHAR_BUDGET);

  const trimmed = trimMessageHistory(history);
  check('trims to within the default budget', trimmed.finalChars <= DEFAULT_HISTORY_CHAR_BUDGET, { final: trimmed.finalChars });
  check('reports that it trimmed', trimmed.trimmed === true);

  // Structural validity is the whole point: dropping messages would break
  // assistant->tool_calls pairing and turn a 413 into a hard 400.
  check('keeps EVERY message (no dropped turns)', trimmed.messages.length === history.length, {
    before: history.length, after: trimmed.messages.length,
  });
  check('system prompt preserved intact', trimmed.messages[0].role === 'system' && (trimmed.messages[0].content?.length ?? 0) > 2_000);
  check('the original task statement survives verbatim',
    trimmed.messages[1].content === 'TASK: Find HVAC companies in Texas and save every qualifying lead.');
  const toolCallCount = trimmed.messages.filter((m) => m.toolCalls && m.toolCalls.length > 0).length;
  check('all tool_calls preserved (pairing intact)', toolCallCount === 40, { toolCallCount });
  const lastTool = trimmed.messages[trimmed.messages.length - 1];
  check('most recent tool result NOT stubbed to 400 chars', (lastTool.content?.length ?? 0) > 400);

  const hard = trimMessageHistory(history, EMERGENCY_HISTORY_CHAR_BUDGET);
  check('emergency budget trims far harder', hard.finalChars <= EMERGENCY_HISTORY_CHAR_BUDGET, { final: hard.finalChars });
  check('emergency trim still keeps every message', hard.messages.length === history.length);

  const small: LLMMessage[] = [{ role: 'system', content: 'hi' }, { role: 'user', content: 'go' }];
  check('a small history is returned untouched', trimMessageHistory(small).trimmed === false);

  console.log('\n── 2. Capacity-failure recovery (work that never came back) ──');
  await migrate();
  await db.delete(tasks); await db.delete(agents);
  const now = new Date();
  await db.insert(agents).values({ id: 'apex-coo-001', name: 'COO', role: 'COO', tier: 1, status: 'idle', systemPrompt: 'x', model: 'm', provider: 'p', createdAt: now });

  const capacityDead = randomUUID();
  const retiredModelDead = randomUUID();
  const missingKeysDead = randomUUID();
  const realDefect = randomUUID();
  await db.insert(tasks).values([
    {
      id: capacityDead, title: 'Lead Generation & Outreach Campaign for BuildMyBot2', description: 'd',
      status: 'failed', priority: 5, assignedAgentId: 'apex-coo-001', createdByAgentId: 'apex-ceo-001',
      createdAt: now, updatedAt: now, retryCount: 3, maxRetries: 3, errorMessage: REAL_CAPACITY_ERROR,
    },
    {
      id: retiredModelDead, title: 'Peer review killed by retired model', description: 'd',
      status: 'failed', priority: 5, assignedAgentId: 'apex-coo-001', createdByAgentId: 'apex-ceo-001',
      createdAt: now, updatedAt: now, retryCount: 3, maxRetries: 3, errorMessage: RETIRED_MODEL_ERROR,
    },
    {
      id: missingKeysDead, title: 'Branch review killed by missing provider config', description: 'd',
      status: 'failed', priority: 5, assignedAgentId: 'apex-coo-001', createdByAgentId: 'apex-ceo-001',
      createdAt: now, updatedAt: now, retryCount: 3, maxRetries: 3, errorMessage: NO_CONFIGURED_PROVIDER_ERROR,
    },
    {
      id: realDefect, title: 'Genuinely broken task', description: 'd',
      status: 'failed', priority: 5, assignedAgentId: 'apex-coo-001', createdByAgentId: 'apex-ceo-001',
      createdAt: now, updatedAt: now, retryCount: 3, maxRetries: 3,
      errorMessage: 'TypeError: Cannot read properties of undefined (reading name)',
    },
  ]);

  const r1 = (await new StalledWorkRecoveryJob().execute(job({}))) as Record<string, number>;
  check('recovers quota, retired-model, and missing-config provider failures', r1.requeued === 3, r1);
  check('leaves the real defect alone (not a provider outage)', r1.recoverableProviderFailures === 3, r1);

  const [revived] = await db.select().from(tasks).where(eq(tasks.id, capacityDead));
  check('task is pending again', revived.status === 'pending', revived.status);
  check('retry budget reset (the failure was the provider\'s fault)', revived.retryCount === 0);
  check('stale error cleared', revived.errorMessage === null);
  check('scheduled with backoff, not immediately', (revived.nextRetryAt?.getTime() ?? 0) > Date.now() + 60_000);
  check('requeue attempt recorded in context', (revived.context as Record<string, unknown>)?.capacityRequeueCount === 1);

  const [retiredModelRevived] = await db.select().from(tasks).where(eq(tasks.id, retiredModelDead));
  check('retired-model 404 work is pending after a deployment can repair it', retiredModelRevived.status === 'pending');
  const [missingKeysRevived] = await db.select().from(tasks).where(eq(tasks.id, missingKeysDead));
  check('no-provider-config work is pending after a restart can repair it', missingKeysRevived.status === 'pending');

  const [defect] = await db.select().from(tasks).where(eq(tasks.id, realDefect));
  check('real defect still failed, untouched', defect.status === 'failed');

  // Bounded: a task that keeps dying must eventually be left for a human.
  await db.update(tasks).set({
    status: 'failed', errorMessage: REAL_CAPACITY_ERROR,
    context: { capacityRequeueCount: 3 }, updatedAt: new Date(),
  }).where(eq(tasks.id, capacityDead));
  const r2 = (await new StalledWorkRecoveryJob().execute(job({}))) as Record<string, number>;
  check('gives up after maxRequeues instead of looping forever', r2.requeued === 0 && r2.exhaustedGiveUp === 1, r2);

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

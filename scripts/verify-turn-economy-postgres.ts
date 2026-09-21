/** Opt-in real Postgres test. Only a disposable local test database is accepted.
 * No provider or production credentials are used. This creates the test schema. */
import assert from 'node:assert/strict';
const target = process.env.APEX_TURN_ECONOMY_TEST_DATABASE_URL;
if (!target) throw new Error('Set APEX_TURN_ECONOMY_TEST_DATABASE_URL to a disposable local test database');
const url = new URL(target);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.startsWith('/turn_economy_test')) {
  throw new Error('Refusing a non-local or non-test database');
}
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.APEX_WORK_BUNDLES_ENABLED = 'true';
process.env.APEX_BUNDLE_WINDOW_MS = '60000';
delete process.env.APEX_ALLOW_EPHEMERAL_QUEUE_FALLBACK;

async function main() {
  const { db, migrate, tasks, emailCampaigns, emailSends } = await import('../lib/db/src/index.js');
  const { TaskQueue } = await import('../packages/core/src/task-queue.js');
  const { readWorkBundle } = await import('../packages/core/src/turn-economy.js');
  const { campaignSnapshotTool, campaignSnapshotSchema } = await import('../packages/core/src/campaign-snapshot.js');
  const { eq, sql } = await import('../lib/db/node_modules/drizzle-orm/index.js');
  await migrate();
  const agent = `turn-test-${Date.now()}`;
  const queues = [new TaskQueue(agent), new TaskQueue(agent)];
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => queues[i % 2].enqueue({
    title: `Item ${i}`, description: `Evidence ${i}`, goalId: 'test-goal',
    context: { bundleKey: 'test-batch', campaignId: 'test-campaign' },
  })));
  const ids = new Set(results.map(task => task.id));
  assert.equal(ids.size, 2, 'forty racing enqueues form two bounded bundles');
  const persisted = await db.select().from(tasks).where(eq(tasks.assignedAgentId, agent));
  assert.equal(persisted.length, 2);
  const itemIds = persisted.flatMap(task => readWorkBundle(task.context)!.itemIds);
  assert.equal(itemIds.length, 40); assert.equal(new Set(itemIds).size, 40, 'no lost or duplicate items');
  assert.equal(await queues[0].dequeue(), null, 'collection window blocks early claim');
  // Advance persisted eligibility; a new queue instance observes the same state.
  await db.update(tasks).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(tasks.assignedAgentId, agent));
  const claims = await Promise.all(Array.from({ length: 6 }, () => new TaskQueue(agent).dequeue()));
  const winners = claims.filter(task => task !== null);
  assert.ok(winners.length >= 1 && winners.length <= 2);
  assert.equal(new Set(winners.map(task => task.id)).size, winners.length, 'competing claimers never receive the same task');
  // Existing dequeue may return null for contenders that targeted the same
  // row; the next worker lap claims the remaining row.
  if (winners.length === 1) {
    const remaining = await queues[0].dequeue();
    assert.ok(remaining);
    winners.push(remaining);
  }
  assert.equal(new Set(winners.map(task => task.id)).size, 2);
  await queues[0].enqueue({ title: 'Late item', description: 'Separate execution', goalId: 'test-goal',
    context: { bundleKey: 'test-batch', campaignId: 'test-campaign' } });
  const after = await db.select().from(tasks).where(eq(tasks.assignedAgentId, agent));
  assert.equal(after.length, 3, 'started tasks are never appended to');
  for (const claimed of winners) assert.equal(readWorkBundle(claimed.context)!.itemIds.length, 20);
  await queues[0].complete(winners[0].id, 'Verified test outcome');
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, winners[0].id)))[0].status, 'done');

  const campaignId = `${agent}-campaign`;
  await db.insert(emailCampaigns).values({ id: campaignId, name: 'Test snapshot', subjectTemplate: 'Test', bodyTemplate: 'Test', totalTargets: 3, sentCount: 1, failedCount: 1 });
  await db.insert(emailSends).values({ id: `${agent}-email`, campaignId, toEmail: 'test@example.invalid', subject: 'Test', status: 'queued' });
  assert.equal(campaignSnapshotSchema.safeParse({ campaignIds: Array(51).fill('id') }).success, false);
  const context = { agentId: agent, workspaceRoot: '.', requestApproval: async () => { throw new Error('Read requested approval'); } };
  const result = await campaignSnapshotTool.execute({ campaignIds: [campaignId, campaignId, 'missing'] }, context) as { campaigns: Array<{ queued: number; percentComplete: number }>; missingIds: string[] };
  assert.equal(result.campaigns.length, 1); assert.equal(result.campaigns[0].queued, 1);
  assert.equal(result.campaigns[0].percentComplete, 67); assert.deepEqual(result.missingIds, ['missing']);
  const sends = await db.execute(sql`SELECT count(*)::int AS count FROM email_sends WHERE campaign_id = ${campaignId}`);
  assert.equal(sends[0].count, 1, 'snapshot did not send or create any email');
  const { BaseAgent } = await import('../packages/core/src/base-agent.js');
  class SnapshotAgent extends BaseAgent {
    llmCalls = 0;
    constructor() {
      super({ id: `${agent}-reader`, name: 'Snapshot test', role: 'SALES', tier: 2,
        systemPrompt: '', tools: ['campaign_snapshot'], llm: { provider: 'test', model: 'test' } });
      this.llm.complete = async () => { this.llmCalls++; throw new Error('Unexpected LLM request'); };
      this.memory.buildMemoryContext = async () => { throw new Error('Unexpected memory/embedding lookup'); };
    }
    run(task: { id: string; title: string; description: string; context: Record<string, unknown> | null }) {
      return this.executeTask(task.id, task.title, task.description, task.context ?? {});
    }
  }
  const reader = new SnapshotAgent();
  const readerQueue = new TaskQueue(reader.id);
  const readTask = await readerQueue.enqueue({ title: 'Read campaigns', description: 'Take snapshot',
    context: { deterministicRead: { tool: 'campaign_snapshot', args: { campaignIds: [campaignId] } } } });
  await readerQueue.claimById(readTask.id);
  const readResult = await reader.run(readTask);
  assert.equal(readResult.success, true);
  assert.equal(reader.llmCalls, 0);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, readTask.id)))[0].status, 'done');
  const invalidTask = await readerQueue.enqueue({ title: 'Invalid action', description: 'Must fail closed',
    context: { deterministicRead: { tool: 'send_email', args: {} } } });
  await readerQueue.claimById(invalidTask.id);
  assert.equal((await reader.run(invalidTask)).success, false);
  assert.equal(reader.llmCalls, 0);
  console.log('Real agent deterministic path completed without LLM/memory and rejected unauthorized operations.');
  console.log('Postgres: 40 concurrent enqueues, bounded bundles, durable windows, competing claims, lifecycle and real campaign snapshot passed.');
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });

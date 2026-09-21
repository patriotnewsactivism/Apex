import assert from 'node:assert/strict';
import type { Task } from '../lib/db/src/schema.js';
import { prepareWorkBundle, appendWorkBundle, readWorkBundle, MAX_BUNDLE_ITEMS,
  recordTurnEconomy, getTurnEconomySnapshot, missingBundleItems, resolveDeterministicRead } from '../packages/core/src/turn-economy.js';

const now = Date.now();
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, title: `Review ${id}`, description: `Evidence for ${id}`, status: 'pending',
  assignedAgentId: 'sales', createdByAgentId: 'coo', goalId: 'goal', parentTaskId: 'parent',
  priority: 5, createdAt: new Date(now), updatedAt: new Date(now), startedAt: null,
  completedAt: null, dueAt: null, nextRetryAt: null, leasedAt: null,
  retryCount: 0, maxRetries: 3, result: null, errorMessage: null, resultArtifacts: null,
  context: { bundleKey: 'qualify', campaignId: 'campaign', projectId: 'project' }, ...overrides,
});
process.env.APEX_WORK_BUNDLES_ENABLED = 'false';
assert.equal(readWorkBundle(prepareWorkBundle(task('a'), now).context), null);
process.env.APEX_WORK_BUNDLES_ENABLED = 'true';
process.env.APEX_BUNDLE_WINDOW_MS = '10000';
const a = prepareWorkBundle(task('a'), now);
const b = prepareWorkBundle(task('b'), now + 1000);
const joined = appendWorkBundle(a, b, now + 1000)!;
assert.equal(joined.id, 'a');
assert.deepEqual(readWorkBundle(joined.context)?.itemIds, ['a', 'b']);
assert.equal(joined.nextRetryAt?.getTime(), now + 10000, 'deadline must never slide');
assert.match(joined.description, /Evidence for a[\s\S]*Evidence for b/);
assert.equal(appendWorkBundle(a, b, now + 10000), null, 'closed window');
assert.equal(appendWorkBundle({ ...a, status: 'in_progress' }, b, now), null);
assert.equal(appendWorkBundle({ ...a, startedAt: new Date(now) }, b, now), null);
assert.equal(appendWorkBundle({ ...a, retryCount: 1 }, b, now), null);
assert.equal(appendWorkBundle({ ...a, status: 'cancelled' }, b, now), null);
for (const overrides of [{ goalId: 'other' }, { parentTaskId: 'other' },
  { assignedAgentId: 'other' }, { createdByAgentId: 'other' }, { priority: 6 },
  { context: { ...task('a').context, projectId: 'other' } },
  { context: { ...task('a').context, campaignId: 'other' } },
  { context: { ...task('a').context, permission: 'different' } }]) {
  assert.equal(appendWorkBundle(a, prepareWorkBundle(task('b', overrides), now), now), null);
}
const reordered = prepareWorkBundle(task('b', { context: {
  projectId: 'project', campaignId: 'campaign', bundleKey: 'qualify',
} }), now);
assert.ok(appendWorkBundle(a, reordered, now), 'key order must not split scopes');
for (const context of [{ interactive: true }, { urgent: true }, { runtime: 'job' },
  { checkpoint: {} }, { deterministicRead: {} }]) {
  assert.equal(readWorkBundle(prepareWorkBundle(task('a', { context: {
    ...task('a').context, ...context,
  } }), now).context), null);
}
assert.equal(readWorkBundle(prepareWorkBundle(task('a', { priority: 2 }), now).context), null);
let full = a;
for (let i = 1; i < MAX_BUNDLE_ITEMS; i++) full = appendWorkBundle(full, prepareWorkBundle(task(`${i}`), now), now)!;
assert.equal(appendWorkBundle(full, b, now), null, 'bounded item count');
assert.equal(appendWorkBundle({ ...a, description: 'a'.repeat(12000) }, b, now), null);
assert.equal(readWorkBundle(prepareWorkBundle(task('a', { description: 'x'.repeat(12001) }), now).context), null);
process.env.APEX_BUNDLE_WINDOW_MS = '0';
assert.equal(readWorkBundle(prepareWorkBundle(task('a'), now).context), null);
const forged = prepareWorkBundle(task('a', { context: { workBundle: readWorkBundle(a.context) } }), now);
assert.equal(readWorkBundle(forged.context), null);
recordTurnEconomy('requests'); recordTurnEconomy('requests');
recordTurnEconomy('successfulTools'); recordTurnEconomy('failedTools'); recordTurnEconomy('itemsCoalesced');
assert.equal(getTurnEconomySnapshot().successfulToolsPerRequest, 0.5);
assert.equal(getTurnEconomySnapshot().scope, 'process');
assert.equal(getTurnEconomySnapshot().completedTasks, 0);
assert.equal(getTurnEconomySnapshot().itemsCoalesced, 1);
console.log('Turn Economy: scope isolation, fixed windows, bypasses, lifecycle, size bounds and honest counters passed.');

assert.deepEqual(missingBundleItems(joined.context!, 'a completed'), ['b']);
assert.deepEqual(missingBundleItems(joined.context!, 'a completed; b failed'), []);
assert.equal(resolveDeterministicRead({}, []), null);
const readContext = { deterministicRead: { tool: 'campaign_snapshot', args: { campaignIds: ['one'] } } };
assert.equal(resolveDeterministicRead(readContext, ['campaign_snapshot'])?.tool, 'campaign_snapshot');
assert.throws(() => resolveDeterministicRead(readContext, []));
assert.throws(() => resolveDeterministicRead(readContext, ['campaign_snapshot'], true));
assert.throws(() => resolveDeterministicRead({ deterministicRead: { tool: 'send_email' } }, ['send_email']));
assert.throws(() => resolveDeterministicRead({ deterministicRead: null }, ['campaign_snapshot']));
console.log('Bundle completion coverage and deterministic authorization passed.');

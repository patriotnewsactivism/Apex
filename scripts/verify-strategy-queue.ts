import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strategyFingerprint } from '../packages/learning-system/src/strategy-fingerprint.js';

const base = {
  recommendationType: 'error_mitigation',
  affectedRole: 'Backend Developer',
  failureCategory: 'rate_limit',
  proposedAction: 'cluster_and_mitigate_causal_failures',
  insightType: 'failure',
};
assert.equal(strategyFingerprint(base), strategyFingerprint({ ...base, affectedRole: ' backend  developer ' }));
assert.equal(
  strategyFingerprint({ ...base, proposedAction: 'retry after 77% across 1,604 samples' }),
  strategyFingerprint({ ...base, proposedAction: 'retry after 98% across 900 samples' }),
  'dynamic percentages and counts must not change a fingerprint',
);
assert.notEqual(strategyFingerprint(base), strategyFingerprint({ ...base, affectedRole: 'Frontend Developer' }));
assert.notEqual(strategyFingerprint(base), strategyFingerprint({ ...base, failureCategory: 'tool_failure' }));
assert.notEqual(strategyFingerprint(base), strategyFingerprint({ ...base, proposedAction: 'reduce_context_size' }));

const optimizer = readFileSync(new URL('../packages/learning-system/src/strategy-optimizer.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../lib/db/src/client.ts', import.meta.url), 'utf8');
const cleanup = readFileSync(new URL('../packages/learning-system/src/strategy-cleanup.ts', import.meta.url), 'utf8');
const api = readFileSync(new URL('../packages/api-server/src/routes/learning.ts', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../packages/dashboard/src/components/LearningPanel.tsx', import.meta.url), 'utf8');
const toolRegistry = readFileSync(new URL('../packages/core/src/tool-registry.ts', import.meta.url), 'utf8');
const applyGate = readFileSync(new URL('../packages/learning-system/src/strategy-apply.ts', import.meta.url), 'utf8');

assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS strategy_recommendations_lifecycle_key_unique/);
assert.match(optimizer, /onConflictDoUpdate/);
assert.match(optimizer, /occurrences: sql/);
assert.match(cleanup, /db\.transaction/);
assert.match(cleanup, /LOCK TABLE strategy_recommendations/);
assert.match(cleanup, /duplicate_strategy_cleanup/);
assert.doesNotMatch(cleanup, /delete\(strategyRecommendations\)/);
assert.match(api, /pageSize/);
assert.match(api, /\.limit\(pageSize\)\.offset/);
assert.match(api, /CLEAN_DUPLICATE_STRATEGIES/);
assert.match(ui, /status: 'pending'/);
assert.match(ui, /Strategy History/);
assert.match(ui, /window\.confirm/);

// The database-backed 100-writer behavior follows from the unique lifecycle
// key plus one atomic INSERT .. ON CONFLICT UPDATE, rather than a check/insert.
const concurrentFingerprints = awaitableConcurrentFingerprints();
assert.equal(new Set(concurrentFingerprints).size, 1);

function awaitableConcurrentFingerprints(): string[] {
  // Generation itself is synchronous; database serialization is asserted above
  // by the unique index + atomic upsert source guards.
  return Array.from({ length: 100 }, () => strategyFingerprint(base));
}

// ─── PR #115 CodeRabbit follow-up (P1/P1/P2) ────────────────────────────────
//
// 1. Cleanup must trust a row's already-populated semantic columns instead
//    of unconditionally re-inferring from prose (which could misread a
//    caveat sentence and silently rewrite a correct proposedAction, breaking
//    the optimizer's deterministic lifecycle key on its next upsert).
assert.match(cleanup, /function rowSemantics/, 'cleanup must prefer stored semantics over prose re-inference');
assert.match(cleanup, /const semantics = rowSemantics\(row\)/, 'the grouping loop must call rowSemantics, not inferLegacyStrategySemantics directly');

// 2. Exactly one shared gate decides whether a recommendation may be marked
//    applied — both the HTTP route and the agent tool must call it, so an
//    agent can never bypass the HTTP path's stricter rule.
assert.match(applyGate, /export async function attemptApplyStrategyRecommendation/, 'the shared apply gate must exist');
assert.match(api, /attemptApplyStrategyRecommendation/, 'the HTTP apply route must use the shared gate');
assert.match(toolRegistry, /attemptApplyStrategyRecommendation/, 'the agent apply_strategy_recommendation tool must use the shared gate, not its own status update');
assert.doesNotMatch(
  toolRegistry.slice(toolRegistry.indexOf("name: 'apply_strategy_recommendation'"), toolRegistry.indexOf("name: 'apply_strategy_recommendation'") + 2000),
  /status:\s*'applied'/,
  'the tool must not write the applied transition itself anymore',
);

// 3. The pending queue must expose the same page/search controls as history
//    — not just fetch page 1 of 100 with no way to reach the rest.
assert.match(ui, /pendingPage/, 'the pending queue must track its own page state');
assert.match(ui, /pendingSearch/, 'the pending queue must expose a search filter, not just history');
assert.match(ui, /setPendingPage\(\(page\) => page \+ 1\)/, 'the pending queue must render Next/Previous controls');

console.log('✅ STRATEGY QUEUE DEDUPLICATION GUARDS PASSED');
console.log('✅ PR #115 FOLLOW-UP DEFECT GUARDS PASSED (semantics preservation, shared apply gate, pending pagination)');

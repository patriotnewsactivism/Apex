import assert from 'node:assert/strict';
import {
  MAX_DYNAMIC_PROJECT_JOBS,
  isGenericHumanHandoffSuggestion,
  isNearDuplicate,
  opportunityFingerprint,
  opportunitySimilarity,
  opportunityValueScore,
  parseOpportunityCandidates,
  recurringProjectPolicy,
} from '../packages/core/src/opportunity-engine.js';
import { preservesImmutableRules } from '../packages/core/src/prompt-forge.js';

assert.equal(
  opportunityFingerprint('project-a', 'Add usage-based pricing', 'Meter premium workflows'),
  opportunityFingerprint('project-a', 'Usage based pricing: add', 'Meter premium workflows'),
  'fingerprints should be stable across superficial title ordering',
);
assert.notEqual(
  opportunityFingerprint('project-a', 'Add usage-based pricing'),
  opportunityFingerprint('project-b', 'Add usage-based pricing'),
  'project boundaries must be part of the fingerprint',
);

const repeated = 'Create a usage-based pricing tier for premium automation workflows';
const paraphrase = 'Premium automation should get a metered usage based pricing tier';
assert.ok(opportunitySimilarity(repeated, paraphrase) >= 0.72);
assert.ok(isNearDuplicate(paraphrase, [repeated]));
assert.equal(isGenericHumanHandoffSuggestion('Escalate this to a human', 'Ask them what to do'), true);
assert.equal(isGenericHumanHandoffSuggestion('Add a reversible preview environment', 'Validate real runtime behavior before deployment'), false);

const parsed = parseOpportunityCandidates(JSON.stringify({ opportunities: [
  {
    title: 'Instrument activation and trigger a guided first win',
    description: 'Measure the first successful outcome and remove the largest activation drop-off.',
    rationale: 'Faster time to value increases retention.',
    category: 'product_growth',
    impact: 'high',
    difficulty: 'medium',
    confidence: 0.8,
    novelty: 0.9,
    evidence: { observed: ['Activation event is not recorded'] },
    proposedPlan: { validation: ['Activation rate increases'] },
    goalTitle: 'Improve activation',
    goalDescription: 'Instrument and improve the first-value path.',
    goalPriority: 2,
  },
  {
    title: 'Hand off product strategy to a human',
    description: 'Ask a human to make the app better.',
  },
] }));
assert.equal(parsed.length, 1, 'generic human handoffs must be rejected during parsing');
assert.equal(parsed[0].category, 'product_growth');
assert.ok(opportunityValueScore(parsed[0]) >= 75, 'high-impact, novel, confident opportunities should rank highly');

assert.deepEqual(recurringProjectPolicy('active', 'full_autonomous'), {
  eligible: true,
  cronExpression: '17 */6 * * *',
});
assert.deepEqual(recurringProjectPolicy('active', 'manual'), { eligible: false, cronExpression: null });
assert.deepEqual(recurringProjectPolicy('paused', 'full_autonomous'), { eligible: false, cronExpression: null });
assert.equal(MAX_DYNAMIC_PROJECT_JOBS, 40, 'dynamic work must retain a finite global cap');

const invariants = ['Never expose secrets.', 'Deployments retain approval gates.'];
assert.equal(preservesImmutableRules(`Work efficiently.\n${invariants.join('\n')}`, invariants), true);
assert.equal(preservesImmutableRules('Work efficiently. Never expose secrets.', invariants), false);

console.log('✓ opportunity novelty, anti-handoff, ranking, schedule bounds, and prompt invariants verified');


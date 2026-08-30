import fs from 'node:fs';
import path from 'node:path';
import {
  applyControlledExploration,
  rankModelsFromStats,
  resolveComplexityObjective,
  type ModelPerformanceStats,
} from '../packages/core/src/model-intelligence.js';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
};

function stat(modelId: string, input: Partial<ModelPerformanceStats> = {}): ModelPerformanceStats {
  return {
    modelId,
    llmCalls: 10,
    generationSuccessRate: 1,
    taskSamples: 10,
    taskSuccessRate: 1,
    avgSatisfaction: 1,
    avgQuality: 1,
    avgComplexity: 0.5,
    avgLatencyMs: 1000,
    avgCostUsd: 0.01,
    avgPromptTokens: 1000,
    avgCompletionTokens: 500,
    cacheHitTokenRate: 0,
    toolCallRate: 1,
    observedScore: 0.8,
    confidence: 0.8,
    ...input,
  };
}

console.log('── Evidence threshold ──');
const candidates = ['vendor/a', 'vendor/b', 'vendor/c'];
const sparse = rankModelsFromStats({
  role: 'BACKEND',
  candidates,
  objective: 'balanced',
  minimumSamples: 5,
  stats: [
    stat('vendor/a', { taskSamples: 2, observedScore: 0.2 }),
    stat('vendor/b', { taskSamples: 2, observedScore: 0.99 }),
    stat('vendor/c', { taskSamples: 2, observedScore: 0.95 }),
  ],
});
check('sparse evidence cannot reorder the operator roster', JSON.stringify(sparse.order) === JSON.stringify(candidates), sparse);
check('sparse evidence reports zero qualified models', sparse.evidenceReadyModels === 0, sparse);

console.log('\n── Qualified adaptive ranking ──');
const qualified = rankModelsFromStats({
  role: 'BACKEND',
  candidates,
  objective: 'balanced',
  minimumSamples: 5,
  stats: [
    stat('vendor/a', { taskSamples: 12, observedScore: 0.65 }),
    stat('vendor/b', { taskSamples: 1, observedScore: 0.99 }),
    stat('vendor/c', { taskSamples: 11, observedScore: 0.92 }),
  ],
});
check('qualified evidence may reorder only qualified slots', JSON.stringify(qualified.order) === JSON.stringify(['vendor/c', 'vendor/b', 'vendor/a']), qualified);
check('under-sampled model retains its original slot', qualified.order[1] === 'vendor/b', qualified.order);
check('two models are evidence-qualified', qualified.evidenceReadyModels === 2, qualified);

console.log('\n── Operator pin authority ──');
const pinned = rankModelsFromStats({
  role: 'BACKEND',
  candidates,
  objective: 'budget',
  minimumSamples: 5,
  pinnedModel: 'vendor/a',
  stats: [
    stat('vendor/a', { taskSamples: 12, observedScore: 0.40 }),
    stat('vendor/b', { taskSamples: 12, observedScore: 0.99 }),
    stat('vendor/c', { taskSamples: 12, observedScore: 0.90 }),
  ],
});
check('explicit role pin stays first despite lower learned score', pinned.order[0] === 'vendor/a', pinned.order);
check('adaptive ranking never introduces an unselected model', pinned.order.every((id) => candidates.includes(id)) && pinned.order.length === candidates.length, pinned.order);

console.log('\n── Complexity escalation ──');
check('disabled escalation preserves base objective', resolveComplexityObjective({ baseObjective: 'balanced', targetComplexity: 0.95, enabled: false }) === 'balanced');
check('hard work escalates balanced routing to quality', resolveComplexityObjective({ baseObjective: 'balanced', targetComplexity: 0.75, enabled: true }) === 'quality');
check('hard work escalates budget routing to quality', resolveComplexityObjective({ baseObjective: 'budget', targetComplexity: 0.9, enabled: true }) === 'quality');
check('hard work escalates speed routing to quality', resolveComplexityObjective({ baseObjective: 'speed', targetComplexity: 1, enabled: true }) === 'quality');
check('routine neutral work shifts balanced routing to budget', resolveComplexityObjective({ baseObjective: 'balanced', targetComplexity: 0.25, enabled: true }) === 'budget');
check('routine explicit quality preference is preserved', resolveComplexityObjective({ baseObjective: 'quality', targetComplexity: 0.2, enabled: true }) === 'quality');
check('routine explicit speed preference is preserved', resolveComplexityObjective({ baseObjective: 'speed', targetComplexity: 0.2, enabled: true }) === 'speed');
check('middle-complexity work preserves base objective', resolveComplexityObjective({ baseObjective: 'balanced', targetComplexity: 0.5, enabled: true }) === 'balanced');
check('missing complexity cannot silently change objective', resolveComplexityObjective({ baseObjective: 'budget', enabled: true }) === 'budget');

console.log('\n── Controlled learning trials ──');
const trialStats = [
  stat('vendor/a', { taskSamples: 4, observedScore: 0.8 }),
  stat('vendor/b', { taskSamples: 2, observedScore: 0.7 }),
  stat('vendor/c', { taskSamples: 0, observedScore: null, confidence: 0 }),
];
const trialBase = {
  order: candidates,
  stats: trialStats,
  minimumSamples: 5,
  explorationRate: 0.25,
  taskId: 'task-0',
  role: 'BACKEND',
  targetComplexity: 0.35,
};
const learningTrial = applyControlledExploration(trialBase);
check('eligible deterministic trial chooses least-sampled selected model', learningTrial.explored && learningTrial.order[0] === 'vendor/c', learningTrial);
check('learning trial preserves every selected model exactly once', learningTrial.order.length === candidates.length && new Set(learningTrial.order).size === candidates.length && learningTrial.order.every((id) => candidates.includes(id)), learningTrial.order);
check('same task produces the same exploration decision', JSON.stringify(applyControlledExploration(trialBase)) === JSON.stringify(learningTrial));
check('0% exploration can never change order', applyControlledExploration({ ...trialBase, explorationRate: 0 }).explored === false);
check('high-complexity task is never used for exploration', applyControlledExploration({ ...trialBase, targetComplexity: 0.75 }).explored === false);
check('hard role pin disables exploration', applyControlledExploration({ ...trialBase, pinnedModel: 'vendor/a' }).explored === false);
check('trial rate is internally hard-capped at 25%', JSON.stringify(applyControlledExploration({ ...trialBase, explorationRate: 1 })) === JSON.stringify(learningTrial));

console.log('\n── Runtime telemetry contract ──');
const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const intelligenceSource = fs.readFileSync(path.join(root, 'packages/core/src/model-intelligence.ts'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'packages/core/src/llm-client.ts'), 'utf8');
const contextSource = fs.readFileSync(path.join(root, 'packages/core/src/model-execution-context.ts'), 'utf8');
const panelSource = fs.readFileSync(path.join(root, 'packages/dashboard/src/components/ModelRouterPanel.tsx'), 'utf8');
check('OpenRouter usage data is explicitly requested', clientSource.includes("usage: { include: true }"));
check('OpenRouter generation cost is read from usage.cost', clientSource.includes('parsed.usage?.cost'));
check('actual served model is retained separately from the diagnostic label', clientSource.includes('servedModel,') && clientSource.includes('requestedModels: [...routedModels]'));
check('task identity uses AsyncLocalStorage for concurrency-safe attribution', contextSource.includes('AsyncLocalStorage<LLMExecutionContext>'));
check('telemetry writes identifiers/metrics, not prompt or completion content', intelligenceSource.includes('never store prompt/completion content') && !intelligenceSource.includes('response.content'));
check('dashboard clearly separates static heuristic from learned evidence', panelSource.includes('Static value') && panelSource.includes('Observed Model Intelligence'));
check('adaptive UI states that unqualified models retain position', panelSource.includes('Models below the evidence threshold keep their operator-defined positions'));
check('learning-trial UI states the low-complexity and role-pin restrictions', panelSource.includes('pre-run complexity ≤ 0.5') && panelSource.includes('never when that role has a hard model pin'));
check('complexity escalation is opt-in and transparent in UI', panelSource.includes('Smart complexity escalation') && panelSource.includes('hard tasks (complexity ≥ 0.70) use the quality objective'));
check('runtime adaptive order resolves a complexity-aware objective', intelligenceSource.includes('resolveComplexityObjective({') && intelligenceSource.includes("enabled: policy?.complexityEscalation === true"));

console.log(`\n${failures === 0 ? '✅ MODEL INTELLIGENCE GUARDS PASSED' : `❌ ${failures} MODEL INTELLIGENCE GUARD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

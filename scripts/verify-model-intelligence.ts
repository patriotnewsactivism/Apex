import fs from 'node:fs';
import path from 'node:path';
import { rankModelsFromStats, type ModelPerformanceStats } from '../packages/core/src/model-intelligence.js';

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

console.log(`\n${failures === 0 ? '✅ MODEL INTELLIGENCE GUARDS PASSED' : `❌ ${failures} MODEL INTELLIGENCE GUARD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

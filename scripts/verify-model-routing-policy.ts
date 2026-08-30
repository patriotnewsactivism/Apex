import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_OPENROUTER_MODEL_CHAIN,
  OPENROUTER_MODEL_POLICY_ENV,
  getOpenRouterModelChainForRole,
  parseOpenRouterModelPolicy,
  serializeOpenRouterModelPolicy,
} from '../packages/core/src/model-routing.js';
import {
  getDefaultLLMConfig,
  getProviderOrderForRole,
} from '../packages/core/src/llm-client.js';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
};

const previousPolicy = process.env[OPENROUTER_MODEL_POLICY_ENV];

try {
  delete process.env[OPENROUTER_MODEL_POLICY_ENV];
  console.log('── Reviewed fallback ──');
  check(
    'no policy preserves the reviewed DeepSeek chain',
    JSON.stringify(getOpenRouterModelChainForRole('CEO')) === JSON.stringify(DEFAULT_OPENROUTER_MODEL_CHAIN),
    getOpenRouterModelChainForRole('CEO'),
  );
  check('no policy preserves all three guarded gateway rungs', getProviderOrderForRole('CEO').length === 3);

  console.log('\n── Policy validation ──');
  check('empty roster is rejected', parseOpenRouterModelPolicy(JSON.stringify({ version: 1, selectedModelIds: [], rolePrimary: {} })) === null);
  check('fabricated non-OpenRouter-shaped ID is rejected', parseOpenRouterModelPolicy(JSON.stringify({ version: 1, selectedModelIds: ['not-a-model'], rolePrimary: {} })) === null);

  const legacyPolicy = parseOpenRouterModelPolicy(JSON.stringify({
    version: 1,
    selectedModelIds: ['openrouter/auto', 'qwen/qwen3-coder:free'],
    rolePrimary: {},
  }));
  check('pre-intelligence saved policy remains valid', legacyPolicy !== null, legacyPolicy);
  check('pre-intelligence policy fails safe to manual routing', legacyPolicy?.routingMode === 'manual', legacyPolicy);
  check('pre-intelligence policy defaults to balanced objective', legacyPolicy?.optimizationObjective === 'balanced', legacyPolicy);
  check('pre-intelligence policy gets conservative sample threshold', legacyPolicy?.minimumSamples === 5, legacyPolicy);

  const policy = {
    version: 1 as const,
    selectedModelIds: [
      'openrouter/auto',
      'deepseek/deepseek-v4-pro-0813',
      'qwen/qwen3-coder:free',
      '~openai/gpt-latest',
    ],
    rolePrimary: {
      CEO: '~openai/gpt-latest',
      BACKEND: 'deepseek/deepseek-v4-pro-0813',
      QA: 'not-selected/model',
    },
    routingMode: 'advisor' as const,
    optimizationObjective: 'quality' as const,
    minimumSamples: 10,
  };
  const serialized = serializeOpenRouterModelPolicy(policy);
  process.env[OPENROUTER_MODEL_POLICY_ENV] = serialized;

  const parsed = parseOpenRouterModelPolicy(serialized);
  check('operator can select multiple OpenRouter models including :free variants', parsed?.selectedModelIds.length === 4, parsed);
  check('unselected role primary is discarded fail-closed', parsed?.rolePrimary.QA === undefined, parsed?.rolePrimary);
  check('routing mode survives serialization', parsed?.routingMode === 'advisor', parsed);
  check('optimization objective survives serialization', parsed?.optimizationObjective === 'quality', parsed);
  check('evidence threshold survives serialization', parsed?.minimumSamples === 10, parsed);

  const bounded = parseOpenRouterModelPolicy(JSON.stringify({
    ...policy,
    minimumSamples: 10_000,
  }));
  check('evidence threshold is bounded to 100 completed tasks/model', bounded?.minimumSamples === 100, bounded);

  console.log('\n── Runtime routing ──');
  const ceoChain = getOpenRouterModelChainForRole('CEO');
  check('CEO preferred model is moved to the front', ceoChain[0] === '~openai/gpt-latest', ceoChain);
  check('CEO retains every selected model as fallback exactly once', new Set(ceoChain).size === 4 && ceoChain.length === 4, ceoChain);
  const backendChain = getOpenRouterModelChainForRole('BACKEND');
  check('BACKEND can have a different first-choice model', backendChain[0] === 'deepseek/deepseek-v4-pro-0813', backendChain);
  check('unassigned role uses global roster priority', getOpenRouterModelChainForRole('SALES')[0] === 'openrouter/auto');
  check('custom model roster uses one paced OpenRouter gateway request', JSON.stringify(getProviderOrderForRole('CEO')) === JSON.stringify(['openrouter-deepseek-flash']), getProviderOrderForRole('CEO'));
  check('default LLM config reflects the role-selected primary model', getDefaultLLMConfig('CEO').model === '~openai/gpt-latest', getDefaultLLMConfig('CEO'));

  console.log('\n── OpenRouter native fallback wire contract ──');
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const clientSource = fs.readFileSync(path.join(root, 'packages/core/src/llm-client.ts'), 'utf8');
  const routeSource = fs.readFileSync(path.join(root, 'packages/api-server/src/routes/model-settings.ts'), 'utf8');
  check('custom routing sends an OpenRouter models array', clientSource.includes('body.models = routedModels'));
  check('actual served model is read from the OpenRouter response', clientSource.includes('const servedModel = parsed.model'));
  check('adaptive routing is explicit rather than silently enabled', clientSource.includes("policy?.routingMode === 'adaptive'"));
  check('model catalog pricing comes from live OpenRouter API', routeSource.includes("https://openrouter.ai/api/v1/models") && routeSource.includes('usdPerMillion'));
  check('efficiency is explicitly described as heuristic, not benchmark', routeSource.includes('It is not an intelligence benchmark'));
} finally {
  if (previousPolicy === undefined) delete process.env[OPENROUTER_MODEL_POLICY_ENV];
  else process.env[OPENROUTER_MODEL_POLICY_ENV] = previousPolicy;
}

console.log(`\n${failures === 0 ? '✅ MODEL ROUTING POLICY GUARDS PASSED' : `❌ ${failures} MODEL ROUTING POLICY GUARD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

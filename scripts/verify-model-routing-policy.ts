import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_OPENROUTER_MODEL_CHAIN,
  OPENROUTER_MODEL_POLICY_ENV,
  getOpenRouterModelChainForRole,
  parseOpenRouterModelPolicy,
  serializeOpenRouterModelPolicy,
  validateProductionOpenRouterModelId,
} from '../packages/core/src/model-routing.js';
import {
  FREE_POLICY_GATEWAY_NAME,
  getDefaultLLMConfig,
  getProviderCatalog,
  getProviderOrderForRole,
  providerUsesFreeCredentials,
} from '../packages/core/src/llm-client.js';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
};

const previousPolicy = process.env[OPENROUTER_MODEL_POLICY_ENV];

try {
  delete process.env[OPENROUTER_MODEL_POLICY_ENV];
  console.log('── Zero-cost fallback ──');
  check(
    'no policy preserves the guarded free model chain',
    JSON.stringify(getOpenRouterModelChainForRole('CEO')) === JSON.stringify(DEFAULT_OPENROUTER_MODEL_CHAIN),
    getOpenRouterModelChainForRole('CEO'),
  );
  check(
    'no policy preserves the whole automatic continuity chain',
    getProviderOrderForRole('CEO').length === getProviderCatalog().length,
    getProviderOrderForRole('CEO'),
  );
  check(
    'automatic default chain is the exact six-route free order',
    JSON.stringify(DEFAULT_OPENROUTER_MODEL_CHAIN) === JSON.stringify([
      'nex-agi/nex-n2.5-mini:free',
      'nex-agi/nex-n2.5-pro:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'nvidia/nemotron-3.5-lightning:free',
      'openrouter/free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ]),
    DEFAULT_OPENROUTER_MODEL_CHAIN,
  );
  check(
    'automatic default chain is entirely zero-cost',
    DEFAULT_OPENROUTER_MODEL_CHAIN.every((model) => validateProductionOpenRouterModelId(model)),
    DEFAULT_OPENROUTER_MODEL_CHAIN,
  );
  check(
    'automatic default chain contains no paid model',
    DEFAULT_OPENROUTER_MODEL_CHAIN.every((model) => model.endsWith(':free') || model === 'openrouter/free'),
    DEFAULT_OPENROUTER_MODEL_CHAIN,
  );

  console.log('\n── Policy validation ──');
  check('empty roster is rejected', parseOpenRouterModelPolicy(JSON.stringify({ version: 1, selectedModelIds: [], rolePrimary: {} })) === null);
  check('fabricated non-OpenRouter-shaped ID is rejected', parseOpenRouterModelPolicy(JSON.stringify({ version: 1, selectedModelIds: ['not-a-model'], rolePrimary: {} })) === null);

  check(
    'paid legacy saved policy is rejected',
    parseOpenRouterModelPolicy(JSON.stringify({
      version: 1,
      selectedModelIds: ['openrouter/auto', 'openai/gpt-oss-120b'],
      rolePrimary: {},
    })) === null,
  );
  check(
    'paid DeepSeek policy cannot be persisted',
    parseOpenRouterModelPolicy(JSON.stringify({ version: 1, selectedModelIds: ['deepseek/deepseek-v4-flash-0731'], rolePrimary: {} })) === null,
  );
  const freePolicy = parseOpenRouterModelPolicy(JSON.stringify({
    version: 1,
    selectedModelIds: ['nex-agi/nex-n2.5-mini:free', 'openrouter/free'],
    rolePrimary: {},
  }));
  check('persisted free-model policy is accepted', freePolicy !== null, freePolicy);
  check('openrouter/free is production-eligible', validateProductionOpenRouterModelId('openrouter/free'));
  check('pre-intelligence free policy fails safe to manual routing', freePolicy?.routingMode === 'manual', freePolicy);
  check('pre-intelligence free policy defaults to balanced objective', freePolicy?.optimizationObjective === 'balanced', freePolicy);
  check('pre-intelligence free policy gets conservative sample threshold', freePolicy?.minimumSamples === 5, freePolicy);
  check('pre-intelligence free policy cannot silently enable learning trials', freePolicy?.explorationRate === 0, freePolicy);
  check('pre-intelligence free policy cannot silently enable complexity escalation', freePolicy?.complexityEscalation === false, freePolicy);

  const policy = {
    version: 1 as const,
    selectedModelIds: [
      'nex-agi/nex-n2.5-mini:free',
      'nex-agi/nex-n2.5-pro:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/free',
    ],
    rolePrimary: {
      CEO: 'nex-agi/nex-n2.5-pro:free',
      BACKEND: 'nvidia/nemotron-3-super-120b-a12b:free',
      QA: 'not-selected/model',
    },
    routingMode: 'advisor' as const,
    optimizationObjective: 'quality' as const,
    minimumSamples: 10,
    explorationRate: 0.05,
    complexityEscalation: true,
  };
  const serialized = serializeOpenRouterModelPolicy(policy);
  process.env[OPENROUTER_MODEL_POLICY_ENV] = serialized;

  const parsed = parseOpenRouterModelPolicy(serialized);
  check('operator can explicitly select multiple production-eligible free models', parsed?.selectedModelIds.length === 4, parsed);
  check('unselected role primary is discarded fail-closed', parsed?.rolePrimary.QA === undefined, parsed?.rolePrimary);
  check('routing mode survives serialization', parsed?.routingMode === 'advisor', parsed);
  check('optimization objective survives serialization', parsed?.optimizationObjective === 'quality', parsed);
  check('evidence threshold survives serialization', parsed?.minimumSamples === 10, parsed);
  check('controlled exploration rate survives serialization', parsed?.explorationRate === 0.05, parsed);
  check('complexity escalation survives serialization', parsed?.complexityEscalation === true, parsed);

  const bounded = parseOpenRouterModelPolicy(JSON.stringify({
    ...policy,
    minimumSamples: 10_000,
    explorationRate: 1,
  }));
  check('evidence threshold is bounded to 100 completed tasks/model', bounded?.minimumSamples === 100, bounded);
  check('learning-trial traffic is hard-capped at 25%', bounded?.explorationRate === 0.25, bounded);
  const negative = parseOpenRouterModelPolicy(JSON.stringify({ ...policy, explorationRate: -5 }));
  check('negative learning-trial traffic is clamped to off', negative?.explorationRate === 0, negative);
  const falseEscalation = parseOpenRouterModelPolicy(JSON.stringify({ ...policy, complexityEscalation: 'true' }));
  check('non-boolean escalation input cannot enable escalation', falseEscalation?.complexityEscalation === false, falseEscalation);

  console.log('\n── Runtime routing ──');
  const ceoChain = getOpenRouterModelChainForRole('CEO');
  check('CEO preferred model is moved to the front', ceoChain[0] === 'nex-agi/nex-n2.5-pro:free', ceoChain);
  check('CEO retains every explicitly selected model as fallback exactly once', new Set(ceoChain).size === 4 && ceoChain.length === 4, ceoChain);
  const backendChain = getOpenRouterModelChainForRole('BACKEND');
  check('BACKEND can have a different first-choice model', backendChain[0] === 'nvidia/nemotron-3-super-120b-a12b:free', backendChain);
  check('unassigned role uses global roster priority', getOpenRouterModelChainForRole('SALES')[0] === 'nex-agi/nex-n2.5-mini:free');
  check(
    'custom FREE roster uses the free-policy gateway first, then independent BYOK continuity',
    JSON.stringify(getProviderOrderForRole('CEO')) === JSON.stringify([
      FREE_POLICY_GATEWAY_NAME,
      'groq-gpt-oss-120b-byok',
      'gemini-3-8-flash-byok',
    ]),
    getProviderOrderForRole('CEO'),
  );
  check('custom FREE policy still uses free credentials', providerUsesFreeCredentials(FREE_POLICY_GATEWAY_NAME));
  check('default LLM config reflects the role-selected primary model', getDefaultLLMConfig('CEO').model === 'nex-agi/nex-n2.5-pro:free', getDefaultLLMConfig('CEO'));
  check('default LLM config advertises the free-policy gateway during custom routing', getDefaultLLMConfig('CEO').provider === FREE_POLICY_GATEWAY_NAME, getDefaultLLMConfig('CEO'));

  console.log('\n── OpenRouter native fallback wire contract ──');
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const clientSource = fs.readFileSync(path.join(root, 'packages/core/src/llm-client.ts'), 'utf8');
  const routeSource = fs.readFileSync(path.join(root, 'packages/api-server/src/routes/model-settings.ts'), 'utf8');
  const panelSource = fs.readFileSync(path.join(root, 'packages/dashboard/src/components/ModelRouterPanel.tsx'), 'utf8');
  check('custom routing sends an OpenRouter models array', clientSource.includes('body.models = routedModels'));
  check('actual served model is read from the OpenRouter response', clientSource.includes('const servedModel = parsed.model'));
  check('adaptive routing is explicit rather than silently enabled', clientSource.includes("policy?.routingMode === 'adaptive'"));
  check('request timeout is bounded and operator-configurable', clientSource.includes('APEX_LLM_REQUEST_TIMEOUT_MS ?? 30_000'));
  check('model catalog pricing comes from live OpenRouter API', routeSource.includes("https://openrouter.ai/api/v1/models") && routeSource.includes('usdPerMillion'));
  check('efficiency is explicitly described as heuristic, not benchmark', routeSource.includes('It is not an intelligence benchmark'));
  check('intelligence API reports effective objective rather than hiding escalation', routeSource.includes('effectiveObjective') && routeSource.includes('baseObjective'));
  check('API exposes production eligibility under zero-cost mode', routeSource.includes('productionEligible'));
  check('API rejects paid production policies', routeSource.includes('zero-cost') || routeSource.includes(':free'));
  check('dashboard reset restores the six-model free chain', panelSource.includes('nex-agi/nex-n2.5-mini:free') && !panelSource.includes('DeepSeek V4 Flash -> GPT-OSS'));
  check('dashboard no longer calls free models experiment-only', !/experiment-only/.test(panelSource));
  check('dashboard defaults the catalog filter to free-only', panelSource.includes('const [freeOnly, setFreeOnly] = useState(true)'));
  const probeSource = fs.readFileSync(path.join(root, 'scripts/llm-probe.mjs'), 'utf8');
  check('diagnostic probe cannot spend money on paid providers', !/api\.mistral\.ai|api\.groq\.com|api\.cohere\.ai|api\.kilo\.ai/.test(probeSource));
} finally {
  if (previousPolicy === undefined) delete process.env[OPENROUTER_MODEL_POLICY_ENV];
  else process.env[OPENROUTER_MODEL_POLICY_ENV] = previousPolicy;
}

console.log(`\n${failures === 0 ? '✅ MODEL ROUTING POLICY GUARDS PASSED' : `❌ ${failures} MODEL ROUTING POLICY GUARD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

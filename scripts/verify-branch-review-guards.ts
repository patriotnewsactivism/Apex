/**
 * Pure regression checks for branch-review outage classification. Unlike the
 * full autonomy verification, this does not connect to or mutate a database.
 */
import {
  partitionRecoveredProviderFailures,
} from '../packages/background-jobs/src/handlers/index.js';
import {
  isLLMProviderChainFailure,
  isProviderOutageEscalation,
  isRecoverableLLMProviderFailure,
  isStaleProviderChainFailure,
  providersNamedInChainFailure,
} from '../packages/core/src/provider-failure.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

const oldAt = new Date('2026-08-22T05:03:41.000Z');
const recoveredAt = new Date('2026-08-22T06:01:43.000Z');
const newAt = new Date('2026-08-22T06:02:00.000Z');

const retiredModel =
  'All LLM providers failed. • openrouter-free (model: openai/gpt-oss-20b:free, status: 404): ' +
  '404 This model is unavailable for free.';
const noProviders =
  'All LLM providers failed. (no providers were configured or had API keys)';
const quotaFailure =
  'All LLM providers failed. • groq (status: 429): rate limit • openrouter (status: 402): insufficient credits';
const mixedCredentialFailure =
  'All LLM providers failed. • mistral (status: 401): unauthorized • groq (status: 429): rate limit';
const taskSpecificChainFailure =
  'All LLM providers failed. • mistral (status: 400): malformed tool payload';

check('retired-model 404 is recoverable after a deploy', isRecoverableLLMProviderFailure(retiredModel));
check('missing provider configuration is recoverable after a restart', isRecoverableLLMProviderFailure(noProviders));
check('quota exhaustion remains recoverable', isRecoverableLLMProviderFailure(quotaFailure));
check(
  'credential-denied chains remain human-actionable even when another provider is rate-limited',
  !isRecoverableLLMProviderFailure(mixedCredentialFailure),
);
check(
  'task-specific provider-chain failures remain actionable',
  !isRecoverableLLMProviderFailure(taskSpecificChainFailure),
);
check('all-provider failure suppresses immediate task retries', isLLMProviderChainFailure(retiredModel));
check(
  'a real task defect is not classified as provider recovery',
  !isRecoverableLLMProviderFailure('TypeError: Cannot read properties of undefined'),
);

const partitioned = partitionRecoveredProviderFailures(
  [
    { id: 'old-provider', errorMessage: retiredModel, updatedAt: oldAt },
    { id: 'real-defect', errorMessage: 'TypeError: broken task', updatedAt: oldAt },
    { id: 'task-specific-chain', errorMessage: taskSpecificChainFailure, updatedAt: oldAt },
    { id: 'fresh-provider', errorMessage: quotaFailure, updatedAt: newAt },
  ],
  recoveredAt,
);

check(
  'provider failure older than a later successful task is recovered context',
  partitioned.recovered.map((failure) => failure.id).join(',') === 'old-provider',
  partitioned,
);
check(
  'real defects and provider failures newer than the success remain actionable',
  partitioned.actionable.map((failure) => failure.id).join(',') ===
    'real-defect,task-specific-chain,fresh-provider',
  partitioned,
);

// ── Issue #166: errors are evidence only about the build that wrote them ────
const buildProviders = [
  'qwen-dashscope-byok',
  'openrouter-nex-n2-5-mini-free',
  'openrouter-nemotron-ultra',
  'openrouter-glm-5-3-flashx-paid',
];
const retiredRouteFailure =
  'All LLM providers failed or were unavailable. ' +
  'openrouter-gpt-oss-120b-paid/openai/gpt-oss-120b via OPENROUTER_API_KEY: HTTP 402 insufficient credits | ' +
  'openrouter-minimax-m3/minimax/minimax-m3 via OPENROUTER_API_KEY: HTTP 404 model is unavailable';
const currentRouteFailure =
  'All LLM providers failed or were unavailable. ' +
  'openrouter-nex-n2-5-mini-free/nex-agi/nex-n2.5-mini:free via OPENROUTER_FREE_API_KEY: HTTP 429 rate limit | ' +
  'qwen-dashscope-byok: QWEN_API_KEY';
const mixedRouteFailure =
  'All LLM providers failed or were unavailable. ' +
  'openrouter-minimax-m3/minimax/minimax-m3 via OPENROUTER_API_KEY: HTTP 404 model is unavailable | ' +
  'openrouter-nemotron-ultra/nvidia/nemotron-3-ultra-550b-a55b:free via OPENROUTER_FREE_API_KEY: HTTP 429 rate limit';

check(
  'current chain-failure format names its providers',
  providersNamedInChainFailure(currentRouteFailure).join(',') ===
    'openrouter-nex-n2-5-mini-free,qwen-dashscope-byok',
  providersNamedInChainFailure(currentRouteFailure),
);
check(
  'legacy bullet chain-failure format names its providers',
  providersNamedInChainFailure(quotaFailure).join(',') === 'groq,openrouter',
  providersNamedInChainFailure(quotaFailure),
);
check(
  'a failure naming only retired routes is stale on the current build',
  isStaleProviderChainFailure(retiredRouteFailure, buildProviders),
);
check(
  'a failure naming a current route is not stale',
  !isStaleProviderChainFailure(currentRouteFailure, buildProviders) &&
    !isStaleProviderChainFailure(mixedRouteFailure, buildProviders),
);
check(
  'a failure naming no provider carries no build evidence and is not stale',
  !isStaleProviderChainFailure(noProviders, buildProviders),
);
check('non-chain errors are never stale', !isStaleProviderChainFailure('TypeError: openrouter-x/y', buildProviders));

const withStale = partitionRecoveredProviderFailures(
  [
    { id: 'retired', errorMessage: retiredRouteFailure, updatedAt: newAt },
    { id: 'current', errorMessage: currentRouteFailure, updatedAt: newAt },
    { id: 'real-defect', errorMessage: 'TypeError: broken task', updatedAt: newAt },
  ],
  null,
  buildProviders,
);
check(
  'retired-route failure is stale, never actionable, even with no later success',
  withStale.stale.map((f) => f.id).join(',') === 'retired' &&
    withStale.actionable.map((f) => f.id).join(',') === 'current,real-defect',
  withStale,
);
check(
  'partition without build providers keeps its previous behaviour',
  partitionRecoveredProviderFailures(
    [{ id: 'retired', errorMessage: retiredRouteFailure, updatedAt: newAt }],
    null,
  ).actionable.length === 1,
);

check(
  'differently worded outage escalations share the outage signature',
  isProviderOutageEscalation('LLM provider outage — need new OpenRouter key', '') &&
    isProviderOutageEscalation('All providers failing, credits exhausted', '') &&
    isProviderOutageEscalation('Lead sweep blocked', retiredRouteFailure),
);
check(
  'unrelated escalations keep their own identity',
  !isProviderOutageEscalation('Approve Q4 marketing budget', 'Spend is above threshold') &&
    !isProviderOutageEscalation('Contract review needed', 'The provider of the venue failed to sign'),
);

console.log(failures === 0 ? '✅ ALL BRANCH-REVIEW GUARDS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

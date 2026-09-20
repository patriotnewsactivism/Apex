import fs from 'node:fs';
import path from 'node:path';
import {
  FREE_POLICY_GATEWAY_NAME,
  PAID_FALLBACK_MODEL,
  PAID_FALLBACK_PROVIDER_NAME,
  getProviderCatalog,
  getProviderOrderForRole,
  getDefaultLLMConfig,
  paidLLMFallbackEnabled,
  providerUsesFreeCredentials,
  isCapacityFailure,
  isAccountQuotaFailure,
} from '../packages/core/src/llm-client.js';
import {
  DEFAULT_OPENROUTER_MODEL_CHAIN,
  OPENROUTER_MODEL_POLICY_ENV,
} from '../packages/core/src/model-routing.js';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
};

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const clientSource = fs.readFileSync(path.join(root, 'packages/core/src/llm-client.ts'), 'utf8');

const openRouterProviders = [
  'openrouter-nex-n2-5-mini-free',
  'openrouter-nex-n2-5-pro-free',
  'openrouter-nemotron-super',
  'openrouter-nemotron-3-5-lightning-free',
  'openrouter-free-router',
  'openrouter-nemotron-ultra',
] as const;
const byokProviders = [
  'groq-gpt-oss-120b-byok',
  'gemini-3-8-flash-byok',
] as const;
const automaticProviders = [...openRouterProviders, ...byokProviders];
const runtimeProviders = [...automaticProviders, PAID_FALLBACK_PROVIDER_NAME];

const catalog = getProviderCatalog();
const openRouterCatalog = catalog.slice(0, openRouterProviders.length);
const byokCatalog = catalog.slice(openRouterProviders.length);

console.log('── Multi-pool automatic provider order ──');
check('eight automatic routes exist: six OpenRouter + two BYOK', catalog.length === 8, catalog);
check(
  'automatic provider order is exact',
  JSON.stringify(catalog.map((provider) => provider.name)) === JSON.stringify(automaticProviders),
  catalog.map((provider) => provider.name),
);
check(
  'the first six models remain the reviewed OpenRouter free chain',
  JSON.stringify(openRouterCatalog.map((provider) => provider.model)) ===
    JSON.stringify([...DEFAULT_OPENROUTER_MODEL_CHAIN]),
  openRouterCatalog.map((provider) => provider.model),
);
check(
  'Nex N2.5 Mini Free remains the production primary',
  catalog[0]?.name === 'openrouter-nex-n2-5-mini-free' &&
    catalog[0]?.model === 'nex-agi/nex-n2.5-mini:free',
  catalog[0],
);
check(
  'all six OpenRouter automatic routes remain zero-cost and use the free credential roster',
  openRouterCatalog.every((provider) =>
    provider.paid !== true &&
    provider.usesFreeCredentials === true &&
    (provider.model.endsWith(':free') || provider.model === 'openrouter/free'),
  ),
  openRouterCatalog,
);
check(
  'direct BYOK routes do not impersonate OpenRouter free credentials',
  byokCatalog.every((provider) =>
    provider.paid !== true && provider.usesFreeCredentials === false
  ),
  byokCatalog,
);
check(
  'Groq BYOK is GPT-OSS 120B with structured/parallel tools',
  byokCatalog[0]?.name === 'groq-gpt-oss-120b-byok' &&
    byokCatalog[0]?.model === 'openai/gpt-oss-120b' &&
    byokCatalog[0]?.toolCallingReliable === true &&
    byokCatalog[0]?.supportsParallelToolCalls === true,
  byokCatalog[0],
);
check(
  'Gemini BYOK is Gemini 3.8 Flash with structured/parallel tools',
  byokCatalog[1]?.name === 'gemini-3-8-flash-byok' &&
    byokCatalog[1]?.model === 'gemini-3.8-flash' &&
    byokCatalog[1]?.toolCallingReliable === true &&
    byokCatalog[1]?.supportsParallelToolCalls === true,
  byokCatalog[1],
);
check(
  'OpenRouter/free still preserves tool requirements',
  openRouterCatalog.some((provider) =>
    provider.model === 'openrouter/free' &&
    provider.requireParametersWhenToolsPresent === true &&
    provider.providerRouting?.require_parameters === true,
  ),
);
check(
  'MiniMax M3 Free is still excluded from the automatic chain',
  catalog.every((provider) => !provider.model.includes('minimax')),
);
check(
  'paid OpenRouter credentials remain isolated to the funded primary key',
  /OPENROUTER_PAID_KEY_ENVS = \['OPENROUTER_API_KEY'\]/.test(clientSource),
);
check(
  'dead OPENROUTER_API_KEY_3 remains outside the free roster',
  !/'OPENROUTER_API_KEY_3'/.test(
    clientSource.slice(
      clientSource.indexOf('OPENROUTER_FREE_KEY_ENVS'),
      clientSource.indexOf('] as const;', clientSource.indexOf('OPENROUTER_FREE_KEY_ENVS')),
    ),
  ),
);

console.log('\n── Independent request-pool routing ──');
check(
  'OpenRouter, Groq and Gemini are tagged with separate request pools',
  /requestPool: 'openrouter'/.test(clientSource) &&
    /requestPool: 'groq'/.test(clientSource) &&
    /requestPool: 'gemini'/.test(clientSource),
);
check(
  'provider admission checks each provider pool rather than one global OpenRouter window',
  /requestWindowForProvider\(provider, now\)\.allowed/.test(clientSource) &&
    /const providerRequestWindow = requestWindowForProvider/.test(clientSource),
);
check(
  'the emergency free/BYOK ceiling cannot veto unrestricted FlashX',
  /!provider\.unrestricted[\s\S]{0,180}!emergencyAllowed/.test(clientSource) &&
    /const emergencyAttemptWindow = provider\.unrestricted[\s\S]{0,120}\? null[\s\S]{0,120}: emergencyRequestCapacityWindow/.test(clientSource),
);
check(
  'FlashX is marked unrestricted from APEX token/request/spend governors',
  /name: PAID_FALLBACK_PROVIDER_NAME[\s\S]{0,260}unrestricted: true/.test(clientSource),
);
check(
  'unrestricted FlashX receives full history rather than the free-route trim',
  /const providerMessages = provider\.unrestricted \? messages : trimmed\.messages/.test(clientSource) &&
    /callProvider\([\s\S]{0,180}providerMessages/.test(clientSource),
);
check(
  'Groq and Gemini routing each have an operator activation switch',
  /activationEnv: 'APEX_GROQ_BYOK_ENABLED'/.test(clientSource) &&
    /activationEnv: 'APEX_GEMINI_BYOK_ENABLED'/.test(clientSource),
);
check(
  'native Gemini traffic is dispatched through the Interactions adapter',
  /provider\.protocol === 'gemini-interactions'/.test(clientSource) &&
    /callGeminiInteractions/.test(clientSource),
);
check(
  'OpenRouter-only metadata is not sent to direct BYOK APIs',
  /isOpenRouterProvider\(provider\) \? \{ usage: \{ include: true \} \}/.test(clientSource) &&
    /isOpenRouterProvider\(provider\) && Object\.keys\(providerRouting\)/.test(clientSource),
);

console.log('\n── Capacity/failure behavior ──');
check('HTTP 402 is a capacity failure', isCapacityFailure(402, 'Payment required') === true);
check('HTTP 429 is an account quota failure', isAccountQuotaFailure(429, 'rate limit') === true);
check(
  'OpenRouter account quota failures rotate/cool the account without poisoning direct providers',
  /isOpenRouterProvider\(provider\)[\s\S]{0,160}!provider\.paid[\s\S]{0,160}isAccountQuotaFailure/.test(clientSource) &&
    /setAccountCooldown\(credential\.key/.test(clientSource),
);
check(
  'every upstream attempt is reserved before callProvider',
  clientSource.indexOf('reserveProviderAttempt(provider, credential.key);') > -1 &&
    clientSource.indexOf('reserveProviderAttempt(provider, credential.key);') <
      clientSource.indexOf('const result = await callProvider(', clientSource.indexOf('reserveProviderAttempt(provider, credential.key);')),
);

console.log('\n── Paid FlashX continuity policy ──');
check('paid FlashX inference is enabled without an APEX activation flag', paidLLMFallbackEnabled(undefined) === true);
check(
  'paid FlashX continuity route remains last after all free/BYOK capacity',
  getProviderOrderForRole('CEO').at(-1) === PAID_FALLBACK_PROVIDER_NAME,
  getProviderOrderForRole('CEO'),
);
check(
  'paid continuity model is GLM 5.3 FlashX',
  PAID_FALLBACK_MODEL === 'z-ai/glm-5.3-flashx',
);

console.log('\n── Custom OpenRouter policy + BYOK continuity ──');
const previousPolicy = process.env[OPENROUTER_MODEL_POLICY_ENV];
process.env[OPENROUTER_MODEL_POLICY_ENV] = JSON.stringify({
  version: 1,
  selectedModelIds: ['nex-agi/nex-n2.5-mini:free', 'openrouter/free'],
  rolePrimary: {},
  routingMode: 'manual',
  optimizationObjective: 'balanced',
  minimumSamples: 5,
  explorationRate: 0,
});
check(
  'a custom FREE OpenRouter policy keeps independent BYOK fallbacks behind it',
  JSON.stringify(getProviderOrderForRole('CEO')) ===
    JSON.stringify([FREE_POLICY_GATEWAY_NAME, ...byokProviders, PAID_FALLBACK_PROVIDER_NAME]),
  getProviderOrderForRole('CEO'),
);
check('the free-policy gateway still uses OpenRouter free credentials', providerUsesFreeCredentials(FREE_POLICY_GATEWAY_NAME));
if (previousPolicy === undefined) delete process.env[OPENROUTER_MODEL_POLICY_ENV];
else process.env[OPENROUTER_MODEL_POLICY_ENV] = previousPolicy;

console.log('\n── All-unit routing ──');
for (const role of [
  'CEO', 'CTO', 'COO', 'LEAD_DEV', 'LEAD_RESEARCH', 'QA_DIRECTOR',
  'FRONTEND', 'BACKEND', 'DEVOPS', 'QA', 'SALES', 'MARKETING',
  'CUSTOMER_SUCCESS', 'RESEARCH', 'OPS', 'DOCS', 'COMMUNITY_WATCH',
]) {
  const order = getProviderOrderForRole(role);
  check(
    `${role} uses free/BYOK first with unrestricted FlashX continuity last`,
    JSON.stringify(order) === JSON.stringify(runtimeProviders),
    order,
  );
  const config = getDefaultLLMConfig(role);
  check(
    `${role} still defaults to Nex N2.5 Mini Free`,
    config.provider === 'openrouter-nex-n2-5-mini-free' &&
      config.model === 'nex-agi/nex-n2.5-mini:free',
    config,
  );
}

console.log(
  `\n${failures === 0 ? '✅ MULTI-POOL ROUTING GUARDS PASSED' : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);

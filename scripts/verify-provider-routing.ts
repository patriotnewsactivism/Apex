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
// Operator-funded paid BYOK, governed but tried first (ADR-017) — distinct
// from the unrestricted FlashX continuity route, which stays last.
const primaryPaidBYOKProvider = 'qwen-dashscope-byok' as const;
const automaticProviders = [primaryPaidBYOKProvider, ...openRouterProviders, ...byokProviders];
const runtimeProviders = [...automaticProviders, PAID_FALLBACK_PROVIDER_NAME];

const catalog = getProviderCatalog();
const primaryCatalogEntry = catalog[0];
const openRouterCatalog = catalog.slice(1, 1 + openRouterProviders.length);
const byokCatalog = catalog.slice(1 + openRouterProviders.length);

console.log('── Multi-pool automatic provider order ──');
check('nine automatic routes exist: Qwen primary + six OpenRouter + two BYOK', catalog.length === 9, catalog);
check(
  'automatic provider order is exact',
  JSON.stringify(catalog.map((provider) => provider.name)) === JSON.stringify(automaticProviders),
  catalog.map((provider) => provider.name),
);
check(
  'Qwen3.8 Flash is the primary route: paid for spend accounting, but not free-credentialed',
  primaryCatalogEntry?.name === 'qwen-dashscope-byok' &&
    primaryCatalogEntry?.model === 'qwen3.8-flash' &&
    primaryCatalogEntry?.paid === true &&
    primaryCatalogEntry?.usesFreeCredentials === false,
  primaryCatalogEntry,
);
check(
  'the next six models remain the reviewed OpenRouter free chain',
  JSON.stringify(openRouterCatalog.map((provider) => provider.model)) ===
    JSON.stringify([...DEFAULT_OPENROUTER_MODEL_CHAIN]),
  openRouterCatalog.map((provider) => provider.model),
);
check(
  'Nex N2.5 Mini Free remains the production primary of the free chain',
  openRouterCatalog[0]?.name === 'openrouter-nex-n2-5-mini-free' &&
    openRouterCatalog[0]?.model === 'nex-agi/nex-n2.5-mini:free',
  openRouterCatalog[0],
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
  'OPENROUTER_API_KEY_3 is restored to the free credential roster',
  /'OPENROUTER_API_KEY_3'/.test(
    clientSource.slice(
      clientSource.indexOf('OPENROUTER_FREE_KEY_ENVS'),
      clientSource.indexOf('] as const;', clientSource.indexOf('OPENROUTER_FREE_KEY_ENVS')),
    ),
  ),
);

console.log('\n── Independent request-pool routing ──');
check(
  'OpenRouter, Qwen, Groq and Gemini are tagged with separate request pools',
  /requestPool: 'openrouter'/.test(clientSource) &&
    /requestPool: 'qwen'/.test(clientSource) &&
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
  'FlashX can use its native 131072-token completion envelope while smaller routes stay clamped',
  /name: PAID_FALLBACK_PROVIDER_NAME[\s\S]{0,500}maxOutputTokens: 131_072/.test(clientSource) &&
    /maxOutputTokens: 16_384/.test(clientSource) &&
    /Math\.min\(131_072, Math\.max/.test(clientSource),
);
check(
  'a high FlashX output setting cannot inflate the free-route token reservation',
  /const restrictedOutputEstimate = Math\.min\([\s\S]{0,120}16_384/.test(clientSource) &&
    /estimateLLMRequestTokens\([\s\S]{0,160}restrictedOutputEstimate/.test(clientSource),
);
check(
  'Qwen, Groq and Gemini routing each have an operator activation switch',
  /activationEnv: 'APEX_QWEN_BYOK_ENABLED'/.test(clientSource) &&
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
const previousPaidFlag = process.env.APEX_PAID_FALLBACK_ENABLED;
delete process.env.APEX_PAID_FALLBACK_ENABLED;
check(
  'paid FlashX inference needs no APEX activation flag — an unset variable leaves it on',
  paidLLMFallbackEnabled(undefined) === true,
);
check(
  'paid FlashX continuity route remains last after all free/BYOK capacity',
  getProviderOrderForRole('CEO').at(-1) === PAID_FALLBACK_PROVIDER_NAME,
  getProviderOrderForRole('CEO'),
);
check(
  'paid continuity model is GLM 5.3 FlashX',
  PAID_FALLBACK_MODEL === 'z-ai/glm-5.3-flashx',
);

// The operator's off switch. Before it existed the route was appended
// unconditionally and this helper returned a literal `true`, so the only way
// to stop paid spend was unsetting OPENROUTER_API_KEY -- which is also a
// member of OPENROUTER_FREE_KEY_ENVS and would have cost a free-pool account
// at the same time. Both halves are checked: the flag must be readable AND
// the route must actually leave the chain, because a flag that only changes
// what /health reports is worse than none.
process.env.APEX_PAID_FALLBACK_ENABLED = 'false';
check(
  'APEX_PAID_FALLBACK_ENABLED=false reports the paid route as disabled',
  paidLLMFallbackEnabled(undefined) === false,
);
check(
  'APEX_PAID_FALLBACK_ENABLED=false removes the paid route from the chain entirely',
  !getProviderOrderForRole('CEO').includes(PAID_FALLBACK_PROVIDER_NAME),
  getProviderOrderForRole('CEO'),
);
check(
  'disabling paid does not remove any free or BYOK provider',
  JSON.stringify(getProviderOrderForRole('CEO')) === JSON.stringify(automaticProviders),
  getProviderOrderForRole('CEO'),
);
process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
check(
  'APEX_PAID_FALLBACK_ENABLED=true puts the paid route back, still last',
  getProviderOrderForRole('CEO').at(-1) === PAID_FALLBACK_PROVIDER_NAME,
  getProviderOrderForRole('CEO'),
);
if (previousPaidFlag === undefined) delete process.env.APEX_PAID_FALLBACK_ENABLED;
else process.env.APEX_PAID_FALLBACK_ENABLED = previousPaidFlag;

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
  'a custom FREE OpenRouter policy keeps Qwen primary and independent BYOK fallbacks behind it',
  JSON.stringify(getProviderOrderForRole('CEO')) ===
    JSON.stringify([primaryPaidBYOKProvider, FREE_POLICY_GATEWAY_NAME, ...byokProviders, PAID_FALLBACK_PROVIDER_NAME]),
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
    `${role} still defaults to Qwen3.8 Flash, the operator-funded primary route`,
    config.provider === 'qwen-dashscope-byok' &&
      config.model === 'qwen3.8-flash',
    config,
  );
}

console.log(
  `\n${failures === 0 ? '✅ MULTI-POOL ROUTING GUARDS PASSED' : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);

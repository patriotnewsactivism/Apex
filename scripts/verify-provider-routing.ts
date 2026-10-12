import fs from 'node:fs';
import path from 'node:path';
import {
  FREE_POLICY_GATEWAY_NAME,
  PAID_FALLBACK_MODEL,
  PAID_FALLBACK_PROVIDER_NAME,
  PAID_FALLBACK_PROVIDER_NAMES,
  getProviderCatalog,
  requestProviderOrder,
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
const accountExclusionSource = fs.readFileSync(
  path.join(root, 'packages/core/src/provider-account-exclusions.ts'),
  'utf8',
);

const openRouterProviders = [
  'openrouter-nemotron-super',
  'openrouter-nemotron-3-5-lightning-free',
  'openrouter-free-router',
  'openrouter-nemotron-ultra',
] as const;
const byokProviders = [
  'groq-gpt-oss-120b-byok',
  'gemini-3-8-flash-byok',
] as const;
// Free capacity first, metered QwenCloud last (operator decision 2026-10-10):
// four OpenRouter free, then Groq/Gemini BYOK, then the metered QwenCloud
// fallback, then the paid DeepSeek V4 Flash 0731 on OpenRouter alone (Apex no
// longer calls the Nous Portal provider — that access is cut off).
const automaticProviders = [...openRouterProviders, ...byokProviders, 'qwen-dashscope-byok'];
const paidProviders = ['openrouter-deepseek-v4-flash-paid'] as const;
const explicitPaidProviders = [...automaticProviders, ...paidProviders];

const catalog = getProviderCatalog();
const openRouterCatalog = catalog.slice(0, openRouterProviders.length);
const byokCatalog = catalog.slice(openRouterProviders.length, openRouterProviders.length + byokProviders.length);
const qwenCatalog = catalog.slice(openRouterProviders.length + byokProviders.length);

console.log('── Multi-pool automatic provider order ──');
check('seven automatic routes exist: four OpenRouter free + two BYOK + metered Qwen (last)', catalog.length === 7, catalog);
check(
  'automatic provider order is exact',
  JSON.stringify(catalog.map((provider) => provider.name)) === JSON.stringify(automaticProviders),
  catalog.map((provider) => provider.name),
);
check(
  'Qwen is the LAST automatic route — the metered fallback after every free pool (qwen3.8-flash)',
  qwenCatalog[0]?.name === 'qwen-dashscope-byok' && qwenCatalog[0]?.model === 'qwen3.8-flash',
  qwenCatalog[0],
);
check(
  'the next four models remain the reviewed OpenRouter free chain',
  JSON.stringify(openRouterCatalog.map((provider) => provider.model)) ===
    JSON.stringify([...DEFAULT_OPENROUTER_MODEL_CHAIN]),
  openRouterCatalog.map((provider) => provider.model),
);
check(
  'the free chain head is Nemotron 3 Super, whose :free slug is live',
  openRouterCatalog[0]?.name === 'openrouter-nemotron-super' &&
    openRouterCatalog[0]?.model === 'nvidia/nemotron-3-super-120b-a12b:free',
  openRouterCatalog[0],
);
// A rung pinned to a withdrawn `:free` slug is worse than no rung: a request is
// reserved before every dispatch, so a guaranteed-404 rung silently spends the
// daily allowance. OpenRouter moved both Nex slugs to paid-only on 2026-10-11
// and they were removed. Do not re-add one without a live 200 first.
check(
  'no provider route is pinned to the withdrawn nex-agi/nex-n2.5-*:free slugs',
  catalog.every((provider) => !provider.model.includes('nex-agi/')) &&
    DEFAULT_OPENROUTER_MODEL_CHAIN.every((model) => !model.includes('nex-agi/')),
  catalog.map((provider) => provider.model),
);
check(
  'all four OpenRouter automatic routes remain zero-cost and use the free credential roster',
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
  // 2026-10-09 operator change: DeepSeek V4 Flash 0731 paid continuity moved
  // to OpenRouter only; the Nous Portal provider was removed entirely.
  // 2026-10-09 operator change: DeepSeek V4 Flash 0731 paid continuity moved
  // to OpenRouter only; the Nous Portal provider was removed entirely. The
  // funded set is now an operator-configurable list over the configured
  // OpenRouter keys (default: three env names, overridable with
  // APEX_PAID_KEY_ENVS), and the caller filters out credentials it cannot use
  // before dispatch. The isolation this guard protects is therefore "paid
  // routing only ever draws on configured, usable OpenRouter credentials", not
  // a single hardcoded env name — which is what the old assertion checked and
  // why it went stale.
  'paid credentials draw only on the configured OpenRouter roster',
  /OPENROUTER_PAID_KEY_ENVS: readonly string\[\] = \([\s\S]{0,200}APEX_PAID_KEY_ENVS/.test(clientSource) &&
    /apiKeyEnvs: OPENROUTER_PAID_KEY_ENVS/.test(clientSource) &&
    /const usableCredentials = configuredCredentials\(provider\)\.filter\(/.test(clientSource),
);
check(
  // Each OpenRouter account keeps its own :free allowance, so the funded
  // account is in the free roster too. A free-quota 429 on it must not stop
  // its paid routing; only a credit/balance exclusion does.
  'a free-scope account exclusion does not block paid routing on the same key',
  /scope: freeRoute && kind !== "credit_exhausted" \? "free" : "all"/.test(accountExclusionSource) &&
    /if \(options\.paid !== true\) \{\s*const free = exclusionForKey\(apiKey, now, \{ free: true \}\)/.test(accountExclusionSource) &&
    /excludeOpenRouterAccountForFailure\([\s\S]{0,200}provider\.paid !== true,\s*\)/.test(clientSource),
);
check(
  'free credential roster holds exactly one key per OpenRouter account (no duplicate OPENROUTER_API_KEY_3)',
  !/'OPENROUTER_API_KEY_3'/.test(
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
  'the emergency free/BYOK ceiling cannot veto unrestricted FlashX or the QwenCloud plan',
  /function independentPlanRoute\(provider: ProviderSpec\): boolean \{\s*return provider\.unrestricted === true \|\| provider\.requestPool === 'qwen';/.test(clientSource) &&
    /!independentPlanRoute\(provider\)[\s\S]{0,180}!emergencyAllowed/.test(clientSource) &&
    /const emergencyAttemptWindow = independentPlanRoute\(provider\)[\s\S]{0,80}\? null[\s\S]{0,80}: emergencyRequestCapacityWindow/.test(clientSource),
);
check(
  'the paid route is marked unrestricted from APEX token/request/spend governors',
  /name: 'openrouter-deepseek-v4-flash-paid'[\s\S]{0,260}unrestricted: true/.test(clientSource),
);
check(
  'the paid OpenRouter route sorts by latency',
  /name: 'openrouter-deepseek-v4-flash-paid'[\s\S]{0,200}baseURL: 'https:\/\/openrouter\.ai\/api\/v1'[\s\S]{0,200}requestPool: 'openrouter'[\s\S]{0,700}providerRouting: \{ sort: 'latency' \}/.test(clientSource),
);
check(
  'unrestricted FlashX receives full history rather than the free-route trim',
  /const providerMessages = provider\.unrestricted \? messages : trimmed\.messages/.test(clientSource) &&
    /callProvider\([\s\S]{0,180}providerMessages/.test(clientSource),
);
check(
  'FlashX can use its native 131072-token completion envelope while smaller routes stay clamped',
  /name: 'openrouter-deepseek-v4-flash-paid'[\s\S]{0,500}maxOutputTokens: 131_072/.test(clientSource) &&
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
const geminiSource = fs.readFileSync(path.join(root, 'packages/core/src/gemini-interactions.ts'), 'utf8');
check(
  'Gemini Interactions uses typed text content blocks for user_input history',
  /type: 'user_input',[\s\S]{0,100}content: \[\{ type: 'text', text: message\.content \}\]/.test(geminiSource),
);
check(
  'Gemini 3.8 request no longer sends legacy temperature sampling config',
  !/generation_config:\s*\{[\s\S]{0,180}temperature:/.test(geminiSource),
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
  'OpenRouter quota failures exclude resolved accounts across routes and persist them',
  /isOpenRouterProvider\(provider\)[\s\S]{0,200}excludeOpenRouterAccountForFailure/.test(clientSource) &&
    /observedAccountFor\(fingerprint\)/.test(accountExclusionSource) &&
    /componentHealth/.test(accountExclusionSource),
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
  'paid FlashX is fail-closed by default when APEX_PAID_FALLBACK_ENABLED is unset',
  paidLLMFallbackEnabled(undefined) === false,
);
check(
  'an unset paid-fallback flag leaves only free/BYOK routes',
  JSON.stringify(getProviderOrderForRole('CEO')) === JSON.stringify(automaticProviders),
  getProviderOrderForRole('CEO'),
);
check(
  'paid continuity model is DeepSeek V4 Flash 0731 on OpenRouter',
  PAID_FALLBACK_MODEL === 'deepseek/deepseek-v4-flash-0731' &&
    JSON.stringify(PAID_FALLBACK_PROVIDER_NAMES) === JSON.stringify(paidProviders) &&
    PAID_FALLBACK_PROVIDER_NAME === paidProviders[0],
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
  paidProviders.every((name) => !getProviderOrderForRole('CEO').includes(name)),
  getProviderOrderForRole('CEO'),
);
check(
  'disabling paid does not remove any free or BYOK provider',
  JSON.stringify(getProviderOrderForRole('CEO')) === JSON.stringify(automaticProviders),
  getProviderOrderForRole('CEO'),
);
process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
check(
  'APEX_PAID_FALLBACK_ENABLED=true appends the single paid OpenRouter route, still last',
  JSON.stringify(getProviderOrderForRole('CEO')) === JSON.stringify(explicitPaidProviders),
  getProviderOrderForRole('CEO'),
);
{
  // A single OpenRouter paid route always sits last. The Nous/OpenRouter
  // 90/10 rotation is gone with the Nous Portal provider, so the paid tail is
  // stable on every request and the free/BYOK order never moves.
  const firstPaid: string[] = [];
  let freeOrderStable = true;
  for (let i = 0; i < 20; i++) {
    const order = requestProviderOrder('CEO');
    freeOrderStable &&= JSON.stringify(order.slice(0, automaticProviders.length)) === JSON.stringify(automaticProviders);
    const tail = order.slice(automaticProviders.length);
    freeOrderStable &&= tail.length === 1 && tail[0] === paidProviders[0];
    firstPaid.push(tail[0] ?? '');
  }
  check('per-request order keeps every free/BYOK route first and the paid route last', freeOrderStable);
  check(
    'the paid route is OpenRouter on every request (no Nous rotation remains)',
    firstPaid.every((name) => name === 'openrouter-deepseek-v4-flash-paid'),
    firstPaid,
  );
  check(
    'complete() dispatches in the per-request order',
    /for \(const providerName of requestProviderOrder\(this\.config\.role, pacingOverride\)\)/.test(clientSource),
  );
}
if (previousPaidFlag === undefined) delete process.env.APEX_PAID_FALLBACK_ENABLED;
else process.env.APEX_PAID_FALLBACK_ENABLED = previousPaidFlag;

console.log('\n── Custom OpenRouter policy + BYOK continuity ──');
const previousPolicy = process.env[OPENROUTER_MODEL_POLICY_ENV];
process.env[OPENROUTER_MODEL_POLICY_ENV] = JSON.stringify({
  version: 1,
  selectedModelIds: ['nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/free'],
  rolePrimary: {},
  routingMode: 'manual',
  optimizationObjective: 'balanced',
  minimumSamples: 5,
  explorationRate: 0,
});
check(
  'a custom FREE OpenRouter policy keeps the selected gateway and free fallbacks first, BYOK next, then metered Qwen last',
  JSON.stringify(getProviderOrderForRole('CEO')) ===
    JSON.stringify([
      FREE_POLICY_GATEWAY_NAME,
      'openrouter-nemotron-3-5-lightning-free',
      'openrouter-nemotron-ultra',
      ...byokProviders,
      'qwen-dashscope-byok',
    ]),
  getProviderOrderForRole('CEO'),
);
check('the free-policy gateway still uses OpenRouter free credentials', providerUsesFreeCredentials(FREE_POLICY_GATEWAY_NAME));
check(
  'under a custom policy the default config advertises the route actually attempted first (the free-policy gateway)',
  getDefaultLLMConfig('CEO').provider === FREE_POLICY_GATEWAY_NAME &&
    getDefaultLLMConfig('CEO').model === 'nvidia/nemotron-3-super-120b-a12b:free',
  getDefaultLLMConfig('CEO'),
);
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
    `${role} defaults to free/BYOK only unless paid continuity is explicitly enabled`,
    JSON.stringify(order) === JSON.stringify(automaticProviders),
    order,
  );
  const config = getDefaultLLMConfig(role);
  check(
    `${role} defaults to the free chain head (nemotron-3-super:free), not metered Qwen`,
    config.provider === 'openrouter-nemotron-super' &&
      config.model === 'nvidia/nemotron-3-super-120b-a12b:free',
    config,
  );
}

console.log(
  `\n${failures === 0 ? '✅ MULTI-POOL ROUTING GUARDS PASSED' : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);

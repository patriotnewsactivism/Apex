import fs from "node:fs";
import path from "node:path";
import {
  FREE_POLICY_GATEWAY_NAME,
  getProviderCatalog,
  getProviderOrderForRole,
  getDefaultLLMConfig,
  paidLLMFallbackEnabled,
  providerUsesFreeCredentials,
  isCapacityFailure,
  isAccountQuotaFailure,
} from "../packages/core/src/llm-client.js";
import {
  DEFAULT_OPENROUTER_MODEL_CHAIN,
  OPENROUTER_MODEL_POLICY_ENV,
} from "../packages/core/src/model-routing.js";

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
};

const expectedProviders = [
  "openrouter-nex-n2-5-mini-free",
  "openrouter-nex-n2-5-pro-free",
  "openrouter-nemotron-super",
  "openrouter-nemotron-3-5-lightning-free",
  "openrouter-free-router",
  "openrouter-nemotron-ultra",
];
const expectedModels = [...DEFAULT_OPENROUTER_MODEL_CHAIN];

const catalog = getProviderCatalog();
const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const clientSource = fs.readFileSync(path.join(root, "packages/core/src/llm-client.ts"), "utf8");
const agentSources = [
  "packages/agents/src/business.ts",
  "packages/agents/src/coo.ts",
  "packages/agents/src/cto.ts",
  "packages/agents/src/lead-developer.ts",
  "packages/agents/src/qa-director.ts",
  "packages/agents/src/specialists.ts",
  "packages/convex-backend/convex/llmConfig.ts",
].map((rel) => fs.readFileSync(path.join(root, rel), "utf8")).join("\n");

console.log("── Zero-cost OpenRouter provider allowlist ──");
check("exactly six automatic routes exist", catalog.length === 6, catalog);
check(
  "automatic provider order is exact",
  JSON.stringify(catalog.map((provider) => provider.name)) === JSON.stringify(expectedProviders),
  catalog,
);
check(
  "automatic models are pinned exactly",
  JSON.stringify(catalog.map((provider) => provider.model)) === JSON.stringify(expectedModels),
  catalog,
);
check(
  "Nex N2.5 Mini Free is the production primary",
  catalog[0]?.name === "openrouter-nex-n2-5-mini-free" &&
    catalog[0]?.model === "nex-agi/nex-n2.5-mini:free",
  catalog[0],
);
check(
  "Nemotron Ultra is last because availability has been worse",
  catalog[5]?.model === "nvidia/nemotron-3-ultra-550b-a55b:free",
  catalog[5],
);
check(
  "every automatic route is zero-cost",
  catalog.every((provider) =>
    provider.paid !== true &&
    (provider.model.endsWith(":free") || provider.model === "openrouter/free"),
  ),
  catalog,
);
check(
  "no automatic route references a paid provider",
  catalog.every((provider) =>
    provider.paid !== true &&
    !/paid|deepseek|gpt-oss|grok|bedrock|ling/i.test(provider.name) &&
    !/deepseek\/|openai\/gpt-oss|x-ai\/grok|inclusionai\/ling|minimax\//i.test(provider.model),
  ),
  catalog,
);
check(
  "every automatic route uses the free credential roster",
  catalog.every((provider) => provider.usesFreeCredentials === true),
  catalog,
);
check("all automatic routes support structured tool calling", catalog.every((provider) => provider.toolCallingReliable), catalog);
check(
  "no free route is sent parallel_tool_calls it does not advertise",
  catalog.every((provider) => provider.supportsParallelToolCalls === false),
  catalog,
);
check(
  "openrouter/free preserves tool requirements",
  catalog.some((provider) =>
    provider.model === "openrouter/free" &&
    provider.requireParametersWhenToolsPresent === true &&
    provider.providerRouting?.require_parameters === true,
  ),
  catalog.find((provider) => provider.model === "openrouter/free"),
);
check(
  "runtime sends require_parameters when openrouter/free has tools",
  clientSource.includes("providerRouting.require_parameters = true") &&
    clientSource.includes("openrouter/free"),
);
check("MiniMax M3 Free is not restored into the automatic chain", catalog.every((provider) => !provider.model.includes("minimax")));
check("paid credential lists are not used by automatic providers", !/apiKeyEnvs: OPENROUTER_PAID_KEY_ENVS/.test(clientSource));
check("paid GPT-OSS gateway is not referenced", !/openrouter-gpt-oss-120b-paid/.test(clientSource));
check(
  "duplicate keys for one account collapse to a single retry bucket",
  /seenAccounts\.has\(fingerprint\)/.test(clientSource) &&
    clientSource.includes("Multiple env names holding the same key are one account"),
);
check(
  "capacity-now skips account-cooled credentials instead of claiming work APEX cannot serve",
  /!accountCooldown\(credential\.key\)/.test(clientSource) &&
    /accountCapacityWindow\(credential\.key\)\.allowed/.test(clientSource),
);
const creditsSource = fs.readFileSync(path.join(root, "packages/core/src/provider-credits.ts"), "utf8");
check("credit probe does not read the retired BYOK paid key", !/OPENROUTER_BYOK_API_KEY/.test(creditsSource));
const probeSource = fs.readFileSync(path.join(root, "scripts/llm-probe.mjs"), "utf8");
check(
  "live probe only targets zero-cost OpenRouter models",
  expectedModels.every((model) => probeSource.includes(`"${model}"`)) &&
    !/mistral-medium|openai\/gpt-oss-120b|gemini-3\.7-flash|command-a-plus|qwen3\.7-max/.test(probeSource),
);
const convexLlm = fs.readFileSync(path.join(root, "packages/convex-backend/convex/llm.ts"), "utf8");
check(
  "experimental Convex client uses the same six free models",
  expectedModels.every((model) => convexLlm.includes(model)),
);
check(
  "experimental Convex client has no Anthropic or Qwen spend path",
  !/completeViaAnthropic|@anthropic-ai\/sdk|resolveQwenModel|qwen3\.7-max/.test(convexLlm),
);
check(
  "experimental Convex embeddings cannot spend OpenAI money",
  /Paid OpenAI embeddings are disabled/.test(convexLlm) &&
    !/text-embedding-3-small/.test(convexLlm),
);
const convexConfig = fs.readFileSync(path.join(root, "packages/convex-backend/convex/llmConfig.ts"), "utf8");
check(
  "experimental Convex config rejects paid APEX_MODEL overrides",
  /isZeroCostModel/.test(convexConfig) &&
    /:free\$\/i\.test\(modelId\)/.test(convexConfig),
);

console.log("\n── Cost/continuity policy ──");
check("paid OpenRouter inference cannot be re-enabled by env", paidLLMFallbackEnabled(undefined) === false);
check("explicit on still cannot enable paid inference", paidLLMFallbackEnabled("on") === false);
check("HTTP 402 is a capacity failure, not a paid-upgrade signal", isCapacityFailure(402, "Payment required") === true);
check("HTTP 429 is an account-quota failure that rotates accounts", isAccountQuotaFailure(429, "rate limit") === true);
check(
  "402/429 do not break to a paid provider; they rotate accounts first",
  clientSource.includes("if (capacityFailure && !isAccountQuotaFailure(status, message)) break") &&
    clientSource.includes("setAccountCooldown(credential.key"),
);

console.log("\n── Custom FREE policy gateway ──");
const previousPolicy = process.env[OPENROUTER_MODEL_POLICY_ENV];
process.env[OPENROUTER_MODEL_POLICY_ENV] = JSON.stringify({
  version: 1,
  selectedModelIds: ["nex-agi/nex-n2.5-mini:free", "openrouter/free"],
  rolePrimary: {},
  routingMode: "manual",
  optimizationObjective: "balanced",
  minimumSamples: 5,
  explorationRate: 0,
});
check(
  "a valid custom FREE policy uses the free-policy gateway, not a paid adapter",
  JSON.stringify(getProviderOrderForRole("CEO")) === JSON.stringify([FREE_POLICY_GATEWAY_NAME]),
  getProviderOrderForRole("CEO"),
);
check("the free-policy gateway uses free credentials", providerUsesFreeCredentials(FREE_POLICY_GATEWAY_NAME));
check("the free-policy gateway is not an automatic catalog route", catalog.every((provider) => provider.name !== FREE_POLICY_GATEWAY_NAME));
if (previousPolicy === undefined) delete process.env[OPENROUTER_MODEL_POLICY_ENV];
else process.env[OPENROUTER_MODEL_POLICY_ENV] = previousPolicy;

console.log("\n── All-unit routing ──");
for (const role of [
  "CEO", "CTO", "COO", "LEAD_DEV", "LEAD_RESEARCH", "QA_DIRECTOR",
  "FRONTEND", "BACKEND", "DEVOPS", "QA", "SALES", "MARKETING",
  "CUSTOMER_SUCCESS", "RESEARCH", "OPS", "DOCS", "COMMUNITY_WATCH",
]) {
  const order = getProviderOrderForRole(role);
  check(`${role} uses the free-only order`, JSON.stringify(order) === JSON.stringify(expectedProviders), order);
  const config = getDefaultLLMConfig(role);
  check(
    `${role} defaults to Nex N2.5 Mini Free via OpenRouter`,
    config.provider === "openrouter-nex-n2-5-mini-free" && config.model === "nex-agi/nex-n2.5-mini:free",
    config,
  );
}

console.log("\n── Agent metadata matches runtime ──");
check(
  "agent metadata does not advertise Ling/DeepSeek/GPT-OSS/MiniMax as primary",
  !/inclusionai\/ling|deepseek\/deepseek-v4-flash-0731|openai\/gpt-oss-120b|minimax\/minimax-m3/.test(agentSources),
);
check(
  "agent/backend defaults report Nex N2.5 Mini Free",
  /nex-agi\/nex-n2\.5-mini:free/.test(agentSources),
);

console.log(`\n${failures === 0 ? "✅ OPENROUTER ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

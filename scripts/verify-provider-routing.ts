import {
  getProviderCatalog,
  getProviderOrderForRole,
  getDefaultLLMConfig,
  paidLLMFallbackEnabled,
} from "../packages/core/src/llm-client.js";

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
};

const expectedProviders = [
  "openrouter-deepseek-v4-flash-paid",
  "openrouter-gpt-oss-120b-paid",
  "openrouter-deepseek-v3-paid",
  "openrouter-grok-4-6-bedrock",
];
const expectedModels = [
  "deepseek/deepseek-v4-flash-0731",
  "openai/gpt-oss-120b",
  "deepseek/deepseek-v3.2",
  "x-ai/grok-4.6",
];

const catalog = getProviderCatalog();
console.log("── Reliability-first OpenRouter provider allowlist ──");
check("exactly four automatic routes exist", catalog.length === 4, catalog);
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
  "DeepSeek V4 Flash is the production primary",
  catalog[0]?.name === "openrouter-deepseek-v4-flash-paid" &&
    catalog[0]?.model === "deepseek/deepseek-v4-flash-0731" &&
    catalog[0]?.paid === true,
  catalog[0],
);
check(
  "GPT-OSS 120B is the fast/cheap fallback",
  catalog[1]?.name === "openrouter-gpt-oss-120b-paid" &&
    catalog[1]?.model === "openai/gpt-oss-120b" &&
    catalog[1]?.paid === true,
  catalog[1],
);
check(
  "DeepSeek V3.2 is the secondary continuity fallback",
  catalog[2]?.name === "openrouter-deepseek-v3-paid" &&
    catalog[2]?.model === "deepseek/deepseek-v3.2" &&
    catalog[2]?.paid === true,
  catalog[2],
);
check(
  "no automatic route uses a free model",
  catalog.every((provider) => provider.paid === true && !provider.model.endsWith(":free")),
  catalog,
);
check(
  "Grok BYOK emergency rung remains pinned to regional Bedrock",
  catalog[3]?.name === "openrouter-grok-4-6-bedrock" &&
    catalog[3]?.providerRouting?.allow_fallbacks === false &&
    catalog[3]?.providerRouting?.only?.length === 1 &&
    /^amazon-bedrock\/[a-z0-9-]+$/.test(catalog[3]?.providerRouting?.only?.[0] ?? ""),
  catalog[3]?.providerRouting,
);
check("all automatic routes support structured tool calling", catalog.every((provider) => provider.toolCallingReliable), catalog);

console.log("\n── Cost/continuity policy ──");
check("paid OpenRouter inference is enabled by default", paidLLMFallbackEnabled(undefined) === true);
check("explicit off still disables paid inference", paidLLMFallbackEnabled("off") === false);

console.log("\n── All-unit routing ──");
for (const role of [
  "CEO", "CTO", "COO", "LEAD_DEV", "LEAD_RESEARCH", "QA_DIRECTOR",
  "FRONTEND", "BACKEND", "DEVOPS", "QA", "SALES", "MARKETING",
  "CUSTOMER_SUCCESS", "RESEARCH", "OPS", "DOCS", "COMMUNITY_WATCH",
]) {
  const order = getProviderOrderForRole(role);
  check(`${role} uses the reliability-first order`, JSON.stringify(order) === JSON.stringify(expectedProviders), order);
  const config = getDefaultLLMConfig(role);
  check(
    `${role} defaults to DeepSeek V4 Flash via OpenRouter`,
    config.provider === "openrouter-deepseek-v4-flash-paid" && config.model === "deepseek/deepseek-v4-flash-0731",
    config,
  );
}

console.log(`\n${failures === 0 ? "✅ OPENROUTER ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

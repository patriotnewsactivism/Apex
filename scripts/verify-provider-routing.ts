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
  "openrouter-free-agent-primary",
  "openrouter-free-agent-secondary",
  "openrouter-gpt-oss-120b-paid",
  "openrouter-deepseek-v4-flash-paid",
  "openrouter-deepseek-v3-paid",
  "openrouter-grok-4-6-bedrock",
];
const expectedModels = [
  "nex-agi/nex-n2.5-mini:free",
  "nex-agi/nex-n2.5-pro:free",
  "openai/gpt-oss-120b",
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v3.2",
  "x-ai/grok-4.6",
];
const expectedPrimaryFree = [
  "nex-agi/nex-n2.5-mini:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "poolside/laguna-s-2.1:free",
];
const expectedSecondaryFree = [
  "nex-agi/nex-n2.5-pro:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

const catalog = getProviderCatalog();
console.log("── Free-first OpenRouter provider allowlist ──");
check("exactly six automatic routes exist", catalog.length === 6, catalog);
check(
  "automatic provider order is exact",
  JSON.stringify(catalog.map((provider) => provider.name)) === JSON.stringify(expectedProviders),
  catalog,
);
check(
  "automatic primary models are pinned exactly",
  JSON.stringify(catalog.map((provider) => provider.model)) === JSON.stringify(expectedModels),
  catalog,
);
check(
  "primary free batch is exact and limited to three models",
  JSON.stringify(catalog[0]?.fallbackModels) === JSON.stringify(expectedPrimaryFree),
  catalog[0],
);
check(
  "secondary free batch is exact and limited to three models",
  JSON.stringify(catalog[1]?.fallbackModels) === JSON.stringify(expectedSecondaryFree),
  catalog[1],
);
check(
  "first two automatic routes are free-only",
  catalog.slice(0, 2).every((provider) => provider.paid === false && provider.fallbackModels?.every((model) => model.endsWith(":free"))),
  catalog.slice(0, 2),
);
check(
  "paid continuity is reached only after both free batches",
  catalog.slice(2).every((provider) => provider.paid === true),
  catalog,
);
check(
  "GPT-OSS 120B is the cheapest paid continuity rung",
  catalog[2]?.name === "openrouter-gpt-oss-120b-paid" && catalog[2]?.model === "openai/gpt-oss-120b",
  catalog[2],
);
check(
  "DeepSeek V4 Flash remains the stronger reasoning fallback",
  catalog[3]?.name === "openrouter-deepseek-v4-flash-paid" && catalog[3]?.model === "deepseek/deepseek-v4-flash-0731",
  catalog[3],
);
check(
  "Grok BYOK emergency rung remains pinned to regional Bedrock",
  catalog[5]?.name === "openrouter-grok-4-6-bedrock" &&
    catalog[5]?.providerRouting?.allow_fallbacks === false &&
    catalog[5]?.providerRouting?.only?.length === 1 &&
    /^amazon-bedrock\/[a-z0-9-]+$/.test(catalog[5]?.providerRouting?.only?.[0] ?? ""),
  catalog[5]?.providerRouting,
);
check("all automatic routes support structured tool calling", catalog.every((provider) => provider.toolCallingReliable), catalog);

console.log("\n── Cost/continuity policy ──");
check("paid continuity is enabled by default", paidLLMFallbackEnabled(undefined) === true);
check("explicit off still disables paid inference", paidLLMFallbackEnabled("off") === false);

console.log("\n── All-unit routing ──");
for (const role of [
  "CEO", "CTO", "COO", "LEAD_DEV", "LEAD_RESEARCH", "QA_DIRECTOR",
  "FRONTEND", "BACKEND", "DEVOPS", "QA", "SALES", "MARKETING",
  "CUSTOMER_SUCCESS", "RESEARCH", "OPS", "DOCS", "COMMUNITY_WATCH",
]) {
  const order = getProviderOrderForRole(role);
  check(`${role} uses the free-first order`, JSON.stringify(order) === JSON.stringify(expectedProviders), order);
  const config = getDefaultLLMConfig(role);
  check(
    `${role} defaults to Nex N2.5 Mini through the primary free batch`,
    config.provider === "openrouter-free-agent-primary" && config.model === "nex-agi/nex-n2.5-mini:free",
    config,
  );
}

console.log(`\n${failures === 0 ? "✅ OPENROUTER ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

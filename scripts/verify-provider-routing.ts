import {
  getProviderCatalog,
  getProviderOrderForRole,
  getDefaultLLMConfig,
  paidLLMFallbackEnabled,
} from "../packages/core/src/llm-client.js";

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(
    condition
      ? `  ✅ ${label}`
      : `  ❌ ${label}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
  if (!condition) failures++;
};

const catalog = getProviderCatalog();
const expectedProviders = [
  "openrouter-minimax-m3",
  "openrouter-nemotron-ultra",
  "openrouter-nemotron-super",
  "openrouter-deepseek-v4-flash-paid",
  "openrouter-gpt-oss-120b-paid",
  "openrouter-deepseek-v3-paid",
  // Operator-authorised 2026-09-07: BYOK rung billed to the operator's own
  // Amazon Bedrock account, so it survives OpenRouter credit exhaustion.
  "openrouter-grok-4-6-bedrock",
];
const expectedModels = [
  "minimax/minimax-m3:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "deepseek/deepseek-v4-flash-0731",
  "openai/gpt-oss-120b",
  "deepseek/deepseek-v3.2",
  "x-ai/grok-4.6",
];
// Tier policy 2026-09-07 (Don): leadership roles reach deepseek-v4-flash
// first on the paid tail, individual-contributor roles reach the cheaper
// gpt-oss-120b first. Both stay reachable for every role, only priority
// differs -- see HIGH_TIER_ROLES in llm-client.ts.
const HIGH_TIER_ROLES = new Set([
  "CEO", "CTO", "COO", "LEAD_DEV", "RESEARCH", "LEAD_RESEARCH", "SALES", "QA_DIRECTOR",
]);
const expectedOrderForRole = (role: string) => {
  const paidTail = HIGH_TIER_ROLES.has(role)
    ? ["openrouter-deepseek-v4-flash-paid", "openrouter-gpt-oss-120b-paid"]
    : ["openrouter-gpt-oss-120b-paid", "openrouter-deepseek-v4-flash-paid"];
  return [
    "openrouter-minimax-m3",
    "openrouter-nemotron-ultra",
    "openrouter-nemotron-super",
    ...paidTail,
    "openrouter-deepseek-v3-paid",
    "openrouter-grok-4-6-bedrock",
  ];
};

// Operator decision 2026-09-04: FREE models first — the most intelligent,
// most-reasoning free models until exhausted — then the CHEAPEST
// high-reasoning PAID models as strictly last-resort (paid tail routes
// only through the dedicated paid key; no sole paid usage without the
// operator's explicit authorization).
console.log("── OpenRouter provider allowlist (free-agent chain + cheap paid tail) ──");
check("exactly seven approved OpenRouter routes exist", catalog.length === 7, catalog);
check(
  "provider order is exact",
  JSON.stringify(catalog.map((provider) => provider.name)) === JSON.stringify(expectedProviders),
  catalog,
);
check(
  "approved models are pinned exactly",
  JSON.stringify(catalog.map((provider) => provider.model)) === JSON.stringify(expectedModels),
  catalog,
);
check(
  "MiniMax M3 Free is the primary rung",
  catalog[0]?.name === "openrouter-minimax-m3" &&
    catalog[0]?.model === "minimax/minimax-m3:free",
  catalog,
);
check(
  "Nemotron 3 Ultra Free is the orchestration fallback rung",
  catalog[1]?.name === "openrouter-nemotron-ultra" &&
    catalog[1]?.model === "nvidia/nemotron-3-ultra-550b-a55b:free",
  catalog,
);
check(
  "the first three rungs are all free-tier",
  catalog.slice(0, 3).every((provider) => provider.paid !== true),
  catalog,
);
check(
  "DeepSeek V4 Flash 0731 (paid) is Don's designated leadership-tier paid rung",
  catalog[3]?.name === "openrouter-deepseek-v4-flash-paid" &&
    catalog[3]?.model === "deepseek/deepseek-v4-flash-0731" &&
    catalog[3]?.paid === true,
  catalog,
);
check(
  "GPT-OSS 120B (paid) is Don's designated individual-contributor-tier paid rung",
  catalog[4]?.name === "openrouter-gpt-oss-120b-paid" &&
    catalog[4]?.model === "openai/gpt-oss-120b" &&
    catalog[4]?.paid === true,
  catalog,
);
check(
  "DeepSeek V3.2 (paid) is the final tool-calling-capable anchor",
  catalog[5]?.name === "openrouter-deepseek-v3-paid" &&
    catalog[5]?.model === "deepseek/deepseek-v3.2" &&
    catalog[5]?.paid === true,
  catalog,
);
// The BYOK rung is only a BYOK rung while it is pinned to a region-suffixed
// Bedrock endpoint. A bare "amazon-bedrock" slug is silently dropped by
// OpenRouter's regional-surcharge filter before `only` is applied (verified
// 2026-09-07: bare slug -> HTTP 404, "/us-west-2" -> served), so losing the
// suffix does not widen the match, it disables the rung and hands the fleet
// back the exact outage this provider was added to survive. Assert the shape
// rather than trusting a comment to survive the next edit.
check(
  "Grok 4.6 BYOK rung is pinned to a region-suffixed Bedrock endpoint",
  catalog[6]?.name === "openrouter-grok-4-6-bedrock" &&
    catalog[6]?.model === "x-ai/grok-4.6" &&
    catalog[6]?.paid === true &&
    catalog[6]?.providerRouting?.allow_fallbacks === false &&
    catalog[6]?.providerRouting?.only?.length === 1 &&
    /^amazon-bedrock\/[a-z0-9-]+$/.test(catalog[6]?.providerRouting?.only?.[0] ?? ""),
  catalog[6]?.providerRouting,
);
check(
  "all approved routes use OpenRouter logical providers",
  catalog.every((provider) => provider.name.startsWith("openrouter-")),
  catalog,
);
check(
  "all approved routes require structured tool calling",
  catalog.every((provider) => provider.toolCallingReliable),
  catalog,
);

console.log("\n── Cost policy ──");
check("OpenRouter inference is enabled by default", paidLLMFallbackEnabled(undefined) === true);
check("explicit off still disables paid fallback mode", paidLLMFallbackEnabled("off") === false);
check("explicit fallback enables inference", paidLLMFallbackEnabled("fallback") === true);

console.log("\n── All-unit routing (tier-aware paid tail) ──");
for (const role of [
  "CEO", "CTO", "COO", "LEAD_DEV", "LEAD_RESEARCH", "QA_DIRECTOR",
  "FRONTEND", "BACKEND", "DEVOPS", "QA", "SALES", "MARKETING",
  "CUSTOMER_SUCCESS", "RESEARCH", "OPS", "DOCS",
]) {
  check(
    `${role} follows the tier-correct OpenRouter order`,
    JSON.stringify(getProviderOrderForRole(role)) === JSON.stringify(expectedOrderForRole(role)),
    getProviderOrderForRole(role),
  );
  const config = getDefaultLLMConfig(role);
  check(
    `${role} defaults to MiniMax M3 Free via OpenRouter`,
    config.provider === "openrouter-minimax-m3" &&
      config.model === "minimax/minimax-m3:free",
    config,
  );
}

console.log(
  `\n${failures === 0 ? "✅ OPENROUTER ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);

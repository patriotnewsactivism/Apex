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
  "openrouter-deepseek-flash",
  "openrouter-deepseek-flash-0731",
  "openrouter-deepseek-pro",
];
const expectedModels = [
  "~deepseek/deepseek-v4-flash-latest",
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4-pro-0813",
];
const expectedOrder = [...expectedProviders];

console.log("── OpenRouter DeepSeek V4 provider allowlist ──");
check("exactly three approved OpenRouter routes exist", catalog.length === 3, catalog);
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
  "Flash Latest is the primary rung",
  catalog[0]?.name === "openrouter-deepseek-flash" &&
    catalog[0]?.model === "~deepseek/deepseek-v4-flash-latest",
  catalog,
);
check(
  "Flash 0731 is the low-cost fallback rung",
  catalog[1]?.name === "openrouter-deepseek-flash-0731" &&
    catalog[1]?.model === "deepseek/deepseek-v4-flash-0731",
  catalog,
);
check(
  "DeepSeek V4 Pro is the final heavy-reasoning rung",
  catalog[2]?.name === "openrouter-deepseek-pro" &&
    catalog[2]?.model === "deepseek/deepseek-v4-pro-0813",
  catalog,
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

console.log("\n── All-unit routing ──");
for (const role of [
  "CEO", "CTO", "COO", "LEAD_DEV", "LEAD_RESEARCH", "QA_DIRECTOR",
  "FRONTEND", "BACKEND", "DEVOPS", "QA", "SALES", "MARKETING",
  "CUSTOMER_SUCCESS", "RESEARCH", "OPS", "DOCS",
]) {
  check(
    `${role} follows the exact OpenRouter order`,
    JSON.stringify(getProviderOrderForRole(role)) === JSON.stringify(expectedOrder),
    getProviderOrderForRole(role),
  );
  const config = getDefaultLLMConfig(role);
  check(
    `${role} defaults to DeepSeek V4 Flash Latest via OpenRouter`,
    config.provider === "openrouter-deepseek-flash" &&
      config.model === "~deepseek/deepseek-v4-flash-latest",
    config,
  );
}

console.log(
  `\n${failures === 0 ? "✅ OPENROUTER ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);

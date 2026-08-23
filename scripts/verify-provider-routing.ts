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
  "google-gemini",
  "cohere",
  "poolside",
  "qwen",
  "kilo",
  "mistral",
];
const expectedModels = [
  "gemini-3.7-flash",
  "command-a-plus-05-2026",
  "poolside/laguna-s-2.1",
  "qwen3.7-max",
  "kilo-auto/free",
  "mistral-medium-3-5",
];
const expectedOrder = [...expectedProviders];

console.log("── Free-first provider allowlist ──");
check("exactly six approved providers exist", catalog.length === 6, catalog);
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
  "Mistral is the only paid rung and is last",
  catalog.filter((provider) => provider.paid).length === 1 &&
    catalog[catalog.length - 1]?.name === "mistral" &&
    catalog[catalog.length - 1]?.paid === true,
  catalog,
);
check(
  "Kilo uses Auto Free, never Auto Frontier",
  catalog.find((provider) => provider.name === "kilo")?.model === "kilo-auto/free",
  catalog,
);
check(
  "no removed legacy inference route is reachable",
  catalog.every((provider) =>
    !/groq|openrouter|cerebras|sambanova|huggingface|nvidia|anthropic|openai/i.test(provider.name),
  ),
  catalog,
);
check(
  "all approved routes require structured tool calling",
  catalog.every((provider) => provider.toolCallingReliable),
  catalog,
);

console.log("\n── Cost safety ──");
check("paid fallback is off when unset", paidLLMFallbackEnabled(undefined) === false);
check("paid fallback is off for explicit off", paidLLMFallbackEnabled("off") === false);
check("paid fallback requires explicit enablement", paidLLMFallbackEnabled("fallback") === true);

console.log("\n── All-unit routing ──");
for (const role of [
  "CEO", "CTO", "COO", "LEAD_DEV", "LEAD_RESEARCH", "QA_DIRECTOR",
  "FRONTEND", "BACKEND", "DEVOPS", "QA", "SALES", "MARKETING",
  "CUSTOMER_SUCCESS", "RESEARCH", "OPS", "DOCS",
]) {
  check(
    `${role} follows the exact free-first order`,
    JSON.stringify(getProviderOrderForRole(role)) === JSON.stringify(expectedOrder),
    getProviderOrderForRole(role),
  );
  const config = getDefaultLLMConfig(role);
  check(
    `${role} defaults to Gemini 3.7 Flash`,
    config.provider === "google-gemini" && config.model === "gemini-3.7-flash",
    config,
  );
}

console.log(
  `\n${failures === 0 ? "✅ FREE-FIRST ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);

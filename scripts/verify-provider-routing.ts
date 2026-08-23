import {
  getProviderCatalog,
  getProviderOrderForRole,
  getDefaultLLMConfig,
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
  "mistral",
  "google-gemini",
  "cohere",
  "qwen",
  "kilo",
];
const expectedModels = [
  "mistral-medium-3-5",
  "gemini-3.7-flash",
  "command-a-plus-05-2026",
  "qwen3.7-max",
  "kilo-auto/frontier",
];
const workerOrder = ["mistral", "google-gemini", "cohere", "qwen", "kilo"];
const managerOrder = ["google-gemini", "mistral", "cohere", "qwen", "kilo"];

console.log("── Five-provider allowlist ──");
check("exactly five providers exist", catalog.length === 5, catalog);
check(
  "provider allowlist and order are exact",
  JSON.stringify(catalog.map((provider) => provider.name)) === JSON.stringify(expectedProviders),
  catalog,
);
check(
  "approved models are pinned exactly",
  JSON.stringify(catalog.map((provider) => provider.model)) === JSON.stringify(expectedModels),
  catalog,
);
check(
  "no legacy provider is reachable",
  catalog.every((provider) =>
    !/groq|openrouter|cerebras|sambanova|huggingface|nvidia|anthropic|openai/i.test(provider.name),
  ),
  catalog,
);
check(
  "all five routes require structured tool calling",
  catalog.every((provider) => provider.toolCallingReliable),
  catalog,
);

console.log("\n── Worker routing ──");
for (const role of ["FRONTEND", "BACKEND", "DEVOPS", "QA", "SALES", "MARKETING", "CUSTOMER_SUCCESS", "RESEARCH", "OPS", "DOCS"]) {
  check(
    `${role} starts Mistral then follows exact fallback order`,
    JSON.stringify(getProviderOrderForRole(role)) === JSON.stringify(workerOrder),
    getProviderOrderForRole(role),
  );
  const config = getDefaultLLMConfig(role);
  check(`${role} default model is Mistral Medium 3.5`, config.provider === "mistral" && config.model === "mistral-medium-3-5", config);
}

console.log("\n── Manager/executive routing ──");
for (const role of ["CEO", "CTO", "COO", "LEAD_DEV", "LEAD_RESEARCH", "QA_DIRECTOR"]) {
  check(
    `${role} starts Gemini then follows exact oversight order`,
    JSON.stringify(getProviderOrderForRole(role)) === JSON.stringify(managerOrder),
    getProviderOrderForRole(role),
  );
  const config = getDefaultLLMConfig(role);
  check(`${role} default model is Gemini 3.7 Flash`, config.provider === "google-gemini" && config.model === "gemini-3.7-flash", config);
}

console.log(
  `\n${failures === 0 ? "✅ FIVE-PROVIDER ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);

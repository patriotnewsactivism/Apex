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

// Operator decision 2026-09-12: the automatic chain is FREE-ONLY.
//
// This guard previously asserted the exact opposite — "no automatic route uses
// a free model" — and that assertion is what this file existed to defend. It is
// reversed deliberately, not worked around, because the paid-only arrangement
// failed in production in the worst available way: the OpenRouter account ran
// out of credits ($20 purchased against $24.28 used), there was no free rung to
// fall through to, and every request returned HTTP 402 while /health reported
// `ok`. Meanwhile three accounts' worth of free daily allowance sat unused.
//
// So the invariant is not "paid" or "free" for its own sake. It is that the
// automatic chain must cost nothing to run, must be reachable, and must support
// structured tool calling — an agent workforce that cannot call tools is a
// workforce that reports fictional success.
const expectedProviders = [
  "openrouter-ling-3-flash-vl",
  "openrouter-nemotron-ultra",
  "openrouter-nemotron-super",
];
const expectedModels = [
  "inclusionai/ling-3.0-flash-vl:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

const catalog = getProviderCatalog();
console.log("── Free-only OpenRouter provider allowlist ──");
check("exactly three automatic routes exist", catalog.length === 3, catalog);
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
  "Ling 3.0 Flash VL is the production primary (highest free agentic index)",
  catalog[0]?.name === "openrouter-ling-3-flash-vl" &&
    catalog[0]?.model === "inclusionai/ling-3.0-flash-vl:free",
  catalog[0],
);
// THE invariant this file now defends. An automatic route that bills is one
// that can be switched off by an unpaid invoice, which is precisely what took
// the whole workforce down.
check(
  "no automatic route can spend money",
  catalog.every((provider) => provider.paid !== true && provider.model.endsWith(":free")),
  catalog,
);
// A dead free endpoint 404s rather than degrading, and it has happened twice:
// z-ai/glm-5.2:free (2026-09-06) and minimax/minimax-m3:free (2026-09-12) were
// both retired out from under this list. Pinning the exact slugs means a silent
// swap to a paid variant cannot slip in as a "fix".
check(
  "automatic models are pinned exactly to verified-live free slugs",
  JSON.stringify(catalog.map((provider) => provider.model)) === JSON.stringify(expectedModels),
  catalog.map((provider) => provider.model),
);
check("all automatic routes support structured tool calling", catalog.every((provider) => provider.toolCallingReliable), catalog);
// parallel_tool_calls is sent only to models whose catalog entry advertises it.
// No free model currently does, and sending it blind risks a 400 on every call
// with no paid rung left to absorb the failure.
check(
  "no free route is sent parallel_tool_calls it does not advertise",
  catalog.every((provider) => provider.supportsParallelToolCalls === false),
  catalog,
);

console.log("\n── Cost/continuity policy ──");
// Paid inference stays *available* — a persisted operator model policy still
// routes to it. It is simply no longer reachable by default.
check("paid OpenRouter inference remains available to an explicit policy", paidLLMFallbackEnabled(undefined) === true);
check("explicit off still disables paid inference", paidLLMFallbackEnabled("off") === false);

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
    `${role} defaults to Ling 3.0 Flash VL via OpenRouter`,
    config.provider === "openrouter-ling-3-flash-vl" && config.model === "inclusionai/ling-3.0-flash-vl:free",
    config,
  );
}

console.log(`\n${failures === 0 ? "✅ OPENROUTER ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

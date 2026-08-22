import {
  getProviderCatalog,
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
const paid = catalog.filter((provider) => provider.paid);
const openRouterFree = catalog.filter((provider) =>
  provider.name.startsWith("openrouter-free"),
);

console.log("── Paid-provider consent ──");
check("unset mode is fail-closed", paidLLMFallbackEnabled(undefined) === false);
check("empty mode is fail-closed", paidLLMFallbackEnabled("") === false);
check(
  "unknown/misspelled mode is fail-closed",
  paidLLMFallbackEnabled("falback") === false,
);
check("explicit off remains off", paidLLMFallbackEnabled("off") === false);
check(
  "explicit fallback enables paid routing",
  paidLLMFallbackEnabled("fallback") === true,
);

console.log("\n── Provider catalog ──");
check("exactly one provider is marked paid", paid.length === 1, paid);
check(
  "paid provider is not in the free-first tier",
  paid.every((provider) => provider.tier > 0),
  paid,
);
check(
  "exactly one OpenRouter free route exists",
  openRouterFree.length === 1,
  openRouterFree,
);
check(
  "free route uses the dynamic router",
  openRouterFree[0]?.model === "openrouter/free",
  openRouterFree,
);
check(
  "no rotating static :free model slug is pinned",
  catalog.every((provider) => !provider.model.endsWith(":free")),
  catalog.filter((provider) => provider.model.endsWith(":free")),
);

console.log(
  `\n${failures === 0 ? "✅ PROVIDER ROUTING GUARDS PASSED" : `❌ ${failures} PROVIDER ROUTING GUARD(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);

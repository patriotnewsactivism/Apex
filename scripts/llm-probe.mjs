// Live-probe the approved APEX free-first inference stack using LOCAL .env
// credentials. Prints status/model only — never key values.
//
// The script WILL NOT probe paid Mistral unless APEX_PAID_LLM_MODE is explicitly
// enabled, because even a diagnostic request must not create surprise spend.
//
// Usage: node scripts/llm-probe.mjs

import { existsSync, readFileSync } from "fs";

const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const getValue = (name) =>
  env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() || process.env[name] || "";
const enabled = (name) =>
  ["1", "true", "on", "enabled", "yes", "confirmed", "fallback"].includes(
    getValue(name).toLowerCase(),
  );

const openaiProbe = async (name, baseURL, key, model) => {
  if (!key) {
    console.log(`⚪ ${name} — skipped (credential not configured)`);
    return;
  }
  if (!baseURL) {
    console.log(`⚪ ${name} — skipped (base URL not configured)`);
    return;
  }

  const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      max_tokens: 16,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  console.log(`${response.ok ? "✅" : "❌"} ${name} [${model}] -> ${response.status}`);
};

const tests = [
  async () => {
    const primary = getValue("GEMINI_FREE_API_KEY");
    const secondary = getValue("GEMINI_FREE_API_KEY_2");
    if (!primary && !secondary) {
      console.log("⚪ google-gemini — skipped (no FREE-tier Gemini project key configured)");
      return;
    }
    if (primary) {
      await openaiProbe(
        "google-gemini/free-primary",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        primary,
        "gemini-3.7-flash",
      );
    }
    if (secondary) {
      await openaiProbe(
        "google-gemini/free-secondary",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        secondary,
        "gemini-3.7-flash",
      );
    }
  },
  () => openaiProbe(
    "cohere",
    "https://api.cohere.ai/compatibility/v1",
    getValue("COHERE_API_KEY"),
    "command-a-plus-05-2026",
  ),
  async () => {
    if (!enabled("POOLSIDE_FREE_ACCESS_CONFIRMED")) {
      console.log("⚪ poolside — skipped (free access not explicitly confirmed)");
      return;
    }
    await openaiProbe(
      "poolside",
      "https://inference.poolside.ai/v1",
      getValue("POOLSIDE_API_KEY"),
      "poolside/laguna-s-2.1",
    );
  },
  async () => {
    if (!enabled("QWEN_FREE_QUOTA_ONLY")) {
      console.log("⚪ qwen — skipped (Alibaba Free quota only not confirmed)");
      return;
    }
    await openaiProbe(
      "qwen",
      getValue("QWEN_BASE_URL") || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      getValue("QWEN_API_KEY"),
      "qwen3.7-max",
    );
  },
  () => openaiProbe(
    "kilo",
    "https://api.kilo.ai/api/gateway",
    getValue("KILO_API_KEY"),
    "kilo-auto/free",
  ),
  async () => {
    if (!enabled("APEX_PAID_LLM_MODE")) {
      console.log("⚪ mistral — skipped (paid emergency fallback is OFF)");
      return;
    }
    await openaiProbe(
      "mistral/PAID",
      "https://api.mistral.ai/v1",
      getValue("MISTRAL_API_KEY"),
      "mistral-medium-3-5",
    );
  },
];

for (const test of tests) {
  try {
    await test();
  } catch (error) {
    console.log(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
  }
}

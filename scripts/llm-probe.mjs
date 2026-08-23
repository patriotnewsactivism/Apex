// Live-probe ONLY the five approved APEX inference providers using LOCAL .env
// credentials. Prints status/model only — never key values.
//
// Usage: node scripts/llm-probe.mjs

import { existsSync, readFileSync } from "fs";

const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const getValue = (name) =>
  env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() || process.env[name] || "";

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
  () => openaiProbe(
    "mistral",
    "https://api.mistral.ai/v1",
    getValue("MISTRAL_API_KEY"),
    "mistral-medium-3-5",
  ),
  async () => {
    const primary = getValue("GEMINI_API_KEY");
    const secondary = getValue("GEMINI_API_KEY_2");
    if (!primary && !secondary) {
      console.log("⚪ google-gemini — skipped (no Gemini project key configured)");
      return;
    }
    if (primary) {
      await openaiProbe(
        "google-gemini/primary",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        primary,
        "gemini-3.7-flash",
      );
    }
    if (secondary) {
      await openaiProbe(
        "google-gemini/secondary",
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
  () => openaiProbe(
    "qwen",
    getValue("QWEN_BASE_URL"),
    getValue("QWEN_API_KEY"),
    "qwen3.7-max",
  ),
  () => openaiProbe(
    "kilo",
    "https://api.kilo.ai/api/gateway",
    getValue("KILO_API_KEY"),
    "kilo-auto/frontier",
  ),
];

for (const test of tests) {
  try {
    await test();
  } catch (error) {
    console.log(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
  }
}

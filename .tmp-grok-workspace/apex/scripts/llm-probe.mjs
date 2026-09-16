// Live-probe the ZERO-COST APEX OpenRouter chain using LOCAL .env credentials.
// Prints status/model only — never key values.
//
// This script must not spend money. It only calls OpenRouter `:free` models
// (plus exactly `openrouter/free`) with the free-account credential roster.
// Paid DeepSeek/GPT-OSS/Grok/Bedrock/Mistral/direct-provider probes are gone.
//
// Usage: node scripts/llm-probe.mjs

import { existsSync, readFileSync } from "fs";

const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const getValue = (name) =>
  env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() || process.env[name] || "";

const MODELS = [
  "nex-agi/nex-n2.5-mini:free",
  "nex-agi/nex-n2.5-pro:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "openrouter/free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

const KEY_ENVS = [
  "OPENROUTER_FREE_API_KEY",
  "OPENROUTER_API_KEY_2",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_KEY_4",
];

const seenKeys = new Set();
const credentials = KEY_ENVS
  .map((envName) => ({ envName, key: getValue(envName) }))
  .filter((entry) => Boolean(entry.key))
  .filter((entry) => {
    if (seenKeys.has(entry.key)) return false;
    seenKeys.add(entry.key);
    return true;
  });

if (credentials.length === 0) {
  console.log("⚪ openrouter — skipped (no free-account credential configured)");
  process.exit(0);
}

console.log(`Probing ${MODELS.length} zero-cost OpenRouter routes across ${credentials.length} independent account(s).`);

for (const model of MODELS) {
  for (const credential of credentials) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.key}`,
          "HTTP-Referer": "https://apex.donmatthews.live",
          "X-Title": "APEX zero-cost probe",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
          max_tokens: 16,
          ...(model === "openrouter/free"
            ? { provider: { require_parameters: true } }
            : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      console.log(
        `${response.ok ? "✅" : "❌"} ${model} via ${credential.envName} -> ${response.status}`,
      );
      if (response.status === 429 || response.status === 402) continue;
      break;
    } catch (error) {
      console.log(
        `⚠️ ${model} via ${credential.envName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

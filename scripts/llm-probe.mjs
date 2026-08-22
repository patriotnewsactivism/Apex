// Live-probe every provider in the production Postgres/Lightsail fallback
// chain using LOCAL .env keys. Prints status only — never key values.
//
// Usage: node scripts/llm-probe.mjs   (from repo root)

import { existsSync, readFileSync } from "fs";

const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const getValue = (name) =>
  env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() || "";
const openRouterHeaders = {
  "HTTP-Referer": "https://apex.donmatthews.live",
  "X-Title": "Apex",
};

const openaiProbe = async (name, url, key, model, headers = {}) => {
  if (!key) {
    console.log(
      `⚪ ${name} — skipped (no key set in .env; chain entry is a no-op)`,
    );
    return;
  }

  const response = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...headers,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      max_tokens: 16,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  console.log(
    `${response.ok ? "✅" : "❌"} ${name} [${model}] -> ${response.status}`,
  );
};

const tests = [
  () =>
    openaiProbe(
      "mistral",
      "https://api.mistral.ai/v1",
      getValue("MISTRAL_API_KEY"),
      "mistral-small-latest",
    ),
  () =>
    openaiProbe(
      "google-gemini",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      getValue("GEMINI_API_KEY"),
      "gemini-3.7-flash",
    ),
  () =>
    openaiProbe(
      "google-gemini-2",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      getValue("GEMINI_API_KEY_2"),
      "gemini-3.7-flash",
    ),
  () =>
    openaiProbe(
      "cerebras",
      "https://api.cerebras.ai/v1",
      getValue("CEREBRAS_API_KEY"),
      "gpt-oss-120b",
    ),
  () =>
    openaiProbe(
      "groq",
      "https://api.groq.com/openai/v1",
      getValue("GROQ_API_KEY"),
      "openai/gpt-oss-120b",
    ),
  () =>
    openaiProbe(
      "groq-2",
      "https://api.groq.com/openai/v1",
      getValue("GROQ_API_KEY_2"),
      "openai/gpt-oss-120b",
    ),
  () =>
    openaiProbe(
      "sambanova",
      "https://api.sambanova.ai/v1",
      getValue("SAMBANOVA_API_KEY"),
      "gpt-oss-120b",
    ),
  () =>
    openaiProbe(
      "huggingface",
      "https://router.huggingface.co/v1",
      getValue("HF_TOKEN"),
      "meta-llama/Llama-3.3-70B-Instruct",
    ),
  () =>
    openaiProbe(
      "nvidia",
      "https://integrate.api.nvidia.com/v1",
      getValue("NVIDIA_API_KEY"),
      "nvidia/nemotron-3-nano-30b-a3b",
    ),
];

const paidMode = getValue("APEX_PAID_LLM_MODE").toLowerCase();
if (["1", "true", "on", "enabled", "fallback"].includes(paidMode)) {
  tests.push(() =>
    openaiProbe(
      "openrouter-paid-anchor",
      "https://openrouter.ai/api/v1",
      getValue("OPENROUTER_API_KEY"),
      "anthropic/claude-sonnet-5",
      openRouterHeaders,
    ),
  );
} else {
  console.log(
    "⚪ openrouter-paid-anchor — skipped (paid fallback is not explicitly enabled)",
  );
}

tests.push(() =>
  openaiProbe(
    "openrouter-free-router",
    "https://openrouter.ai/api/v1",
    getValue("OPENROUTER_API_KEY"),
    "openrouter/free",
    openRouterHeaders,
  ),
);

for (const test of tests) {
  try {
    await test();
  } catch (error) {
    console.log(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
  }
}

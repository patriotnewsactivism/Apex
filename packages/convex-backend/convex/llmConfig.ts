// ─── Pure LLM config helpers ──────────────────────────────────────────────
//
// Split out of llm.ts (which is 'use node' for the openai SDK / transformers)
// so default-runtime files like agentLoop.ts can import these plain
// synchronous functions without pulling a Node-only bundle in. No Convex
// runtime directive needed here — no external deps, no ctx, nothing that
// isn't plain JS.

// Mirrors the PROVIDERS list in llm.ts (name + apiKeyEnv only — this file
// doesn't need baseURL/fallbackModel/extraHeaders since it never makes a
// request itself).
const PROVIDERS = [
  { name: 'cerebras', apiKeyEnv: 'CEREBRAS_API_KEY' },
  { name: 'groq', apiKeyEnv: 'GROQ_API_KEY' },
  { name: 'cohere', apiKeyEnv: 'COHERE_API_KEY' },
  { name: 'mistral', apiKeyEnv: 'MISTRAL_API_KEY' },
  { name: 'qwen-cloud', apiKeyEnv: 'QWENCLOUD_API_KEY' },
  { name: 'openrouter-free', apiKeyEnv: 'OPENROUTER_API_KEY' },
  { name: 'openrouter-free-2', apiKeyEnv: 'OPENROUTER_API_KEY' },
];

const TOKEN_BUDGETS: Record<string, number> = {
  CEO: 16384, CTO: 16384, COO: 16384, LEAD_DEV: 16384, RESEARCH: 16384,
  LEAD_RESEARCH: 16384, SALES: 16384, QA_DIRECTOR: 16384,
  FRONTEND: 8192, BACKEND: 8192, DEVOPS: 8192, QA: 8192,
  MARKETING: 8192, CUSTOMER_SUCCESS: 8192, DOCS: 8192, OPS: 8192,
};

const TIER_MAP: Record<string, string> = {
  CEO: 'anthropic/claude-sonnet-4-5', CTO: 'anthropic/claude-sonnet-4-5', COO: 'anthropic/claude-sonnet-4-5',
  LEAD_DEV: 'openai/gpt-4o', FRONTEND: 'openai/gpt-4o', BACKEND: 'openai/gpt-4o', DEVOPS: 'openai/gpt-4o', QA: 'openai/gpt-4o',
  RESEARCH: 'google/gemini-2.5-flash', DOCS: 'openai/gpt-4o-mini', OPS: 'openai/gpt-4o-mini',
  LEAD_RESEARCH: 'google/gemini-2.5-flash', SALES: 'openai/gpt-4o', MARKETING: 'openai/gpt-4o-mini',
  CUSTOMER_SUCCESS: 'openai/gpt-4o-mini', QA_DIRECTOR: 'openai/gpt-4o',
};

export function getDefaultLLMConfig(role: string): { model: string; temperature: number; maxTokens: number } {
  const maxTokens = TOKEN_BUDGETS[role] ?? 8192;

  const envOverride = process.env[`APEX_MODEL_${role}`];
  if (envOverride) return { model: envOverride, temperature: 0.7, maxTokens };

  const globalModel = process.env.APEX_MODEL;
  if (globalModel) return { model: globalModel, temperature: 0.7, maxTokens };

  const model = TIER_MAP[role] ?? 'openai/gpt-4o-mini';
  return { model, temperature: 0.7, maxTokens };
}

/** Which LLM fallback providers currently have an API key configured. */
export function getConfiguredProviders(): Array<{ name: string; configured: boolean }> {
  return PROVIDERS.map((p) => ({ name: p.name, configured: Boolean(process.env[p.apiKeyEnv]) }));
}

/** Env var names this client will ever read a key from — a strict allowlist
 * for the settings API so a client can only set/clear keys this client
 * actually consumes. */
export function getKnownApiKeyEnvs(): string[] {
  return PROVIDERS.map((p) => p.apiKeyEnv);
}

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
  { name: 'openrouter-nex-n2-5-mini-free', apiKeyEnv: 'OPENROUTER_FREE_API_KEY' },
  { name: 'openrouter-nex-n2-5-pro-free', apiKeyEnv: 'OPENROUTER_API_KEY_2' },
  { name: 'openrouter-nemotron-super', apiKeyEnv: 'OPENROUTER_API_KEY' },
  { name: 'openrouter-nemotron-3-5-lightning-free', apiKeyEnv: 'OPENROUTER_API_KEY_3' },
  { name: 'openrouter-free-router', apiKeyEnv: 'OPENROUTER_API_KEY_4' },
  { name: 'openrouter-nemotron-ultra', apiKeyEnv: 'OPENROUTER_API_KEY' },
];

const TOKEN_BUDGETS: Record<string, number> = {
  CEO: 16384, CTO: 16384, COO: 16384, LEAD_DEV: 16384, RESEARCH: 16384,
  LEAD_RESEARCH: 16384, SALES: 16384, QA_DIRECTOR: 16384,
  FRONTEND: 8192, BACKEND: 8192, DEVOPS: 8192, QA: 8192,
  MARKETING: 8192, CUSTOMER_SUCCESS: 8192, DOCS: 8192, OPS: 8192,
};

// No Claude/GPT/Gemini anywhere in this map (removed 2026-07-27 — see
// llm.ts's resolveQwenModel() for the full rationale). This field is COSMETIC
// for every provider except qwen-cloud/qwen-cloud-anthropic (which resolve
// their own role-aware model instead) — every other configured provider uses
// its own fixed fallbackModel, never this value. Kept accurate anyway.
const TIER_MAP: Record<string, string> = {
  CEO: 'nex-agi/nex-n2.5-mini:free', CTO: 'nex-agi/nex-n2.5-mini:free', COO: 'nex-agi/nex-n2.5-mini:free',
  LEAD_DEV: 'nex-agi/nex-n2.5-mini:free', RESEARCH: 'nex-agi/nex-n2.5-mini:free', LEAD_RESEARCH: 'nex-agi/nex-n2.5-mini:free',
  SALES: 'nex-agi/nex-n2.5-mini:free', QA_DIRECTOR: 'nex-agi/nex-n2.5-mini:free',
  FRONTEND: 'nex-agi/nex-n2.5-mini:free', BACKEND: 'nex-agi/nex-n2.5-mini:free', DEVOPS: 'nex-agi/nex-n2.5-mini:free', QA: 'nex-agi/nex-n2.5-mini:free',
  MARKETING: 'nex-agi/nex-n2.5-mini:free', CUSTOMER_SUCCESS: 'nex-agi/nex-n2.5-mini:free', DOCS: 'nex-agi/nex-n2.5-mini:free', OPS: 'nex-agi/nex-n2.5-mini:free',
};

export function getDefaultLLMConfig(role: string): { model: string; temperature: number; maxTokens: number; role: string } {
  const maxTokens = TOKEN_BUDGETS[role] ?? 8192;

  const envOverride = process.env[`APEX_MODEL_${role}`];
  if (envOverride) return { model: envOverride, temperature: 0.7, maxTokens, role };

  const globalModel = process.env.APEX_MODEL;
  if (globalModel) return { model: globalModel, temperature: 0.7, maxTokens, role };

  const model = TIER_MAP[role] ?? 'nex-agi/nex-n2.5-mini:free';
  return { model, temperature: 0.7, maxTokens, role };
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

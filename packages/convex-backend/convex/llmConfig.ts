// ─── Pure LLM config helpers ──────────────────────────────────────────────
//
// Split out of llm.ts (which is 'use node' for the openai SDK) so default-
// runtime files like agentLoop.ts can import these plain synchronous functions
// without pulling a Node-only bundle in.

const OPENROUTER_FREE_KEY_ENVS = [
  'OPENROUTER_FREE_API_KEY',
  'OPENROUTER_API_KEY_2',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY_3',
  'OPENROUTER_API_KEY_4',
  'OPENROUTER_API_KEY_5',
] as const;

const PROVIDERS = [
  { name: 'openrouter-nemotron-super' },
  { name: 'openrouter-nemotron-3-5-lightning-free' },
  { name: 'openrouter-free-router' },
  { name: 'openrouter-nemotron-ultra' },
  // Extended free-tier chain (2026-10-12): added after Nemotron quota exhausts
  { name: 'openrouter-llama-3-2-3b-free' },
  { name: 'openrouter-gemma-3-4b-free' },
  { name: 'openrouter-mistral-7b-free' },
  { name: 'openrouter-deepseek-r1-free' },
  { name: 'openrouter-qwen-2-7b-free' },
];

const TOKEN_BUDGETS: Record<string, number> = {
  CEO: 16384, CTO: 16384, COO: 16384, LEAD_DEV: 16384, RESEARCH: 16384,
  LEAD_RESEARCH: 16384, SALES: 16384, QA_DIRECTOR: 16384,
  FRONTEND: 8192, BACKEND: 8192, DEVOPS: 8192, QA: 8192,
  MARKETING: 8192, CUSTOMER_SUCCESS: 8192, DOCS: 8192, OPS: 8192,
};

const TIER_MAP: Record<string, string> = {
  CEO: 'nvidia/nemotron-3-super-120b-a12b:free', CTO: 'nvidia/nemotron-3-super-120b-a12b:free', COO: 'nvidia/nemotron-3-super-120b-a12b:free',
  LEAD_DEV: 'nvidia/nemotron-3-super-120b-a12b:free', RESEARCH: 'nvidia/nemotron-3-super-120b-a12b:free', LEAD_RESEARCH: 'nvidia/nemotron-3-super-120b-a12b:free',
  SALES: 'nvidia/nemotron-3-super-120b-a12b:free', QA_DIRECTOR: 'nvidia/nemotron-3-super-120b-a12b:free',
  FRONTEND: 'nvidia/nemotron-3-super-120b-a12b:free', BACKEND: 'nvidia/nemotron-3-super-120b-a12b:free', DEVOPS: 'nvidia/nemotron-3-super-120b-a12b:free', QA: 'nvidia/nemotron-3-super-120b-a12b:free',
  MARKETING: 'nvidia/nemotron-3-super-120b-a12b:free', CUSTOMER_SUCCESS: 'nvidia/nemotron-3-super-120b-a12b:free', DOCS: 'nvidia/nemotron-3-super-120b-a12b:free', OPS: 'nvidia/nemotron-3-super-120b-a12b:free',
};

function isZeroCostModel(modelId: string): boolean {
  return /:free$/i.test(modelId) || modelId.toLowerCase() === 'openrouter/free';
}

export function getDefaultLLMConfig(role: string): { model: string; temperature: number; maxTokens: number; role: string } {
  const maxTokens = TOKEN_BUDGETS[role] ?? 8192;
  const envOverride = (process.env[`APEX_MODEL_${role}`] ?? process.env.APEX_MODEL ?? '').trim();
  if (envOverride && isZeroCostModel(envOverride)) {
    return { model: envOverride, temperature: 0.7, maxTokens, role };
  }

  const model = TIER_MAP[role] ?? 'nvidia/nemotron-3-super-120b-a12b:free';
  return { model, temperature: 0.7, maxTokens, role };
}

/** Which LLM fallback providers currently have an API key configured. */
export function getConfiguredProviders(): Array<{ name: string; configured: boolean }> {
  const configured = OPENROUTER_FREE_KEY_ENVS.some((env) => Boolean(process.env[env]));
  return PROVIDERS.map((p) => ({ name: p.name, configured }));
}

/** Env var names this client will ever read a key from — a strict allowlist
 * for the settings API so a client can only set/clear keys this client
 * actually consumes. */
export function getKnownApiKeyEnvs(): string[] {
  return [...OPENROUTER_FREE_KEY_ENVS];
}
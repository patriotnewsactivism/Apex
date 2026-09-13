// ─── Pure LLM config helpers ──────────────────────────────────────────────
//
// Split out of llm.ts (which is 'use node' for the openai SDK) so default-
// runtime files like agentLoop.ts can import these plain synchronous functions
// without pulling a Node-only bundle in.

const OPENROUTER_FREE_KEY_ENVS = [
  'OPENROUTER_FREE_API_KEY',
  'OPENROUTER_API_KEY_2',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY_4',
] as const;

const PROVIDERS = [
  { name: 'openrouter-nex-n2-5-mini-free' },
  { name: 'openrouter-nex-n2-5-pro-free' },
  { name: 'openrouter-nemotron-super' },
  { name: 'openrouter-nemotron-3-5-lightning-free' },
  { name: 'openrouter-free-router' },
  { name: 'openrouter-nemotron-ultra' },
];

const TOKEN_BUDGETS: Record<string, number> = {
  CEO: 16384, CTO: 16384, COO: 16384, LEAD_DEV: 16384, RESEARCH: 16384,
  LEAD_RESEARCH: 16384, SALES: 16384, QA_DIRECTOR: 16384,
  FRONTEND: 8192, BACKEND: 8192, DEVOPS: 8192, QA: 8192,
  MARKETING: 8192, CUSTOMER_SUCCESS: 8192, DOCS: 8192, OPS: 8192,
};

const TIER_MAP: Record<string, string> = {
  CEO: 'nex-agi/nex-n2.5-mini:free', CTO: 'nex-agi/nex-n2.5-mini:free', COO: 'nex-agi/nex-n2.5-mini:free',
  LEAD_DEV: 'nex-agi/nex-n2.5-mini:free', RESEARCH: 'nex-agi/nex-n2.5-mini:free', LEAD_RESEARCH: 'nex-agi/nex-n2.5-mini:free',
  SALES: 'nex-agi/nex-n2.5-mini:free', QA_DIRECTOR: 'nex-agi/nex-n2.5-mini:free',
  FRONTEND: 'nex-agi/nex-n2.5-mini:free', BACKEND: 'nex-agi/nex-n2.5-mini:free', DEVOPS: 'nex-agi/nex-n2.5-mini:free', QA: 'nex-agi/nex-n2.5-mini:free',
  MARKETING: 'nex-agi/nex-n2.5-mini:free', CUSTOMER_SUCCESS: 'nex-agi/nex-n2.5-mini:free', DOCS: 'nex-agi/nex-n2.5-mini:free', OPS: 'nex-agi/nex-n2.5-mini:free',
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

  const model = TIER_MAP[role] ?? 'nex-agi/nex-n2.5-mini:free';
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

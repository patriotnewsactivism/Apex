export const OPENROUTER_MODEL_POLICY_ENV = 'APEX_OPENROUTER_MODEL_POLICY';

/**
 * Reviewed fallback chain used when no operator policy exists or a stored policy
 * is malformed. These IDs stay as the safety fallback; live pricing is never
 * hard-coded here because OpenRouter pricing can change independently of APEX.
 */
export const DEFAULT_OPENROUTER_MODEL_CHAIN = [
  '~deepseek/deepseek-v4-flash-latest',
  'deepseek/deepseek-v4-flash-0731',
  'deepseek/deepseek-v4-pro-0813',
] as const;

export type OpenRouterModelPolicy = {
  version: 1;
  /** Ordered global model roster. Large enough to cover the live OpenRouter catalog. */
  selectedModelIds: string[];
  /** Optional role-specific first choice. Global roster remains the fallback. */
  rolePrimary: Record<string, string>;
};

const MODEL_ID_PATTERN = /^~?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._~:/-]+$/;
// OpenRouter currently exposes hundreds of text models. This is an abuse/size
// ceiling, not a product limit: it is deliberately above the live catalog so an
// operator can select every available model if desired without accepting an
// unbounded authenticated JSON payload forever.
const MAX_SELECTED_MODELS = 500;

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))];
}

export function validateOpenRouterModelId(modelId: string): boolean {
  return modelId.length <= 200 && MODEL_ID_PATTERN.test(modelId);
}

export function parseOpenRouterModelPolicy(raw: string | undefined | null): OpenRouterModelPolicy | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || !Array.isArray(parsed.selectedModelIds)) return null;

    const selectedModelIds = uniqueStrings(parsed.selectedModelIds);
    if (
      selectedModelIds.length < 1 ||
      selectedModelIds.length > MAX_SELECTED_MODELS ||
      selectedModelIds.some((modelId) => !validateOpenRouterModelId(modelId))
    ) {
      return null;
    }

    const selected = new Set(selectedModelIds);
    const rolePrimary: Record<string, string> = {};
    if (parsed.rolePrimary && typeof parsed.rolePrimary === 'object' && !Array.isArray(parsed.rolePrimary)) {
      for (const [rawRole, rawModel] of Object.entries(parsed.rolePrimary as Record<string, unknown>)) {
        const role = rawRole.trim().toUpperCase();
        if (!role || role.length > 80 || typeof rawModel !== 'string') continue;
        const modelId = rawModel.trim();
        // A role may only elevate a model already admitted to the selected roster.
        if (selected.has(modelId)) rolePrimary[role] = modelId;
      }
    }

    return { version: 1, selectedModelIds, rolePrimary };
  } catch {
    return null;
  }
}

export function getActiveOpenRouterModelPolicy(): OpenRouterModelPolicy | null {
  return parseOpenRouterModelPolicy(process.env[OPENROUTER_MODEL_POLICY_ENV]);
}

export function hasCustomOpenRouterModelPolicy(): boolean {
  return getActiveOpenRouterModelPolicy() !== null;
}

export function getOpenRouterModelChainForRole(role?: string): string[] {
  const policy = getActiveOpenRouterModelPolicy();
  if (!policy) return [...DEFAULT_OPENROUTER_MODEL_CHAIN];

  const roleKey = (role ?? '').trim().toUpperCase();
  const preferred = roleKey ? policy.rolePrimary[roleKey] : undefined;
  if (!preferred) return [...policy.selectedModelIds];

  return [preferred, ...policy.selectedModelIds.filter((modelId) => modelId !== preferred)];
}

export function serializeOpenRouterModelPolicy(policy: OpenRouterModelPolicy): string {
  const reparsed = parseOpenRouterModelPolicy(JSON.stringify(policy));
  if (!reparsed) throw new Error('Invalid OpenRouter model policy');
  return JSON.stringify(reparsed);
}

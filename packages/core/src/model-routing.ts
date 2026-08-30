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

export type ModelRoutingMode = 'manual' | 'advisor' | 'adaptive';
export type ModelOptimizationObjective = 'quality' | 'balanced' | 'budget' | 'speed';

export type OpenRouterModelPolicy = {
  version: 1;
  /** Ordered global model roster. Large enough to cover the live OpenRouter catalog. */
  selectedModelIds: string[];
  /** Optional role-specific first choice. Global roster remains the fallback. */
  rolePrimary: Record<string, string>;
  /**
   * manual   = exact operator order;
   * advisor  = exact operator order plus evidence-backed recommendations in UI;
   * adaptive = evidence-qualified models may reorder automatically inside the
   *            selected roster. Role-primary pins always remain first.
   */
  routingMode: ModelRoutingMode;
  /** What adaptive/advisor ranking optimizes for. */
  optimizationObjective: ModelOptimizationObjective;
  /** Minimum completed-task outcomes required before a model may move automatically. */
  minimumSamples: number;
  /**
   * Optional fraction (0..0.25) of eligible low-complexity tasks used to gather
   * evidence for under-sampled selected models in adaptive mode. Default 0.
   */
  explorationRate: number;
  /**
   * When enabled in advisor/adaptive analysis, task complexity may change the
   * effective ranking objective: routine balanced work can optimize for budget,
   * while high-complexity work escalates to quality. Explicit role pins remain
   * stronger than this policy. Default false for backward compatibility.
   */
  complexityEscalation: boolean;
};

const MODEL_ID_PATTERN = /^~?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._~:/-]+$/;
// OpenRouter currently exposes hundreds of text models. This is an abuse/size
// ceiling, not a product limit: it is deliberately above the live catalog so an
// operator can select every available model if desired without accepting an
// unbounded authenticated JSON payload forever.
const MAX_SELECTED_MODELS = 500;
const VALID_ROUTING_MODES = new Set<ModelRoutingMode>(['manual', 'advisor', 'adaptive']);
const VALID_OBJECTIVES = new Set<ModelOptimizationObjective>(['quality', 'balanced', 'budget', 'speed']);

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

    // Backward compatibility: policies saved before the intelligence layer had
    // no routing-mode fields. They remain manual, preserving exact behavior.
    const routingMode = typeof parsed.routingMode === 'string' && VALID_ROUTING_MODES.has(parsed.routingMode as ModelRoutingMode)
      ? parsed.routingMode as ModelRoutingMode
      : 'manual';
    const optimizationObjective = typeof parsed.optimizationObjective === 'string' && VALID_OBJECTIVES.has(parsed.optimizationObjective as ModelOptimizationObjective)
      ? parsed.optimizationObjective as ModelOptimizationObjective
      : 'balanced';
    const rawMinimumSamples = Number(parsed.minimumSamples ?? 5);
    const minimumSamples = Number.isFinite(rawMinimumSamples)
      ? Math.max(2, Math.min(100, Math.round(rawMinimumSamples)))
      : 5;
    const rawExplorationRate = Number(parsed.explorationRate ?? 0);
    const explorationRate = Number.isFinite(rawExplorationRate)
      ? Math.max(0, Math.min(0.25, rawExplorationRate))
      : 0;
    const complexityEscalation = parsed.complexityEscalation === true;

    return {
      version: 1,
      selectedModelIds,
      rolePrimary,
      routingMode,
      optimizationObjective,
      minimumSamples,
      explorationRate,
      complexityEscalation,
    };
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

export function getPinnedOpenRouterModelForRole(role?: string): string | undefined {
  const policy = getActiveOpenRouterModelPolicy();
  if (!policy || !role) return undefined;
  return policy.rolePrimary[role.trim().toUpperCase()];
}

export function serializeOpenRouterModelPolicy(policy: OpenRouterModelPolicy): string {
  const reparsed = parseOpenRouterModelPolicy(JSON.stringify(policy));
  if (!reparsed) throw new Error('Invalid OpenRouter model policy');
  return JSON.stringify(reparsed);
}

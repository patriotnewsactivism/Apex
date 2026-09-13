export const OPENROUTER_MODEL_POLICY_ENV = 'APEX_OPENROUTER_MODEL_POLICY';

/** Zero-cost production fallback chain. If free capacity is exhausted, APEX pauses instead of spending money. */
export const DEFAULT_OPENROUTER_MODEL_CHAIN = [
  'nex-agi/nex-n2.5-mini:free',
  'nex-agi/nex-n2.5-pro:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'openrouter/free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
] as const;

export type ModelRoutingMode = 'manual' | 'advisor' | 'adaptive';
export type ModelOptimizationObjective = 'quality' | 'balanced' | 'budget' | 'speed';

export type OpenRouterModelPolicy = {
  version: 1;
  selectedModelIds: string[];
  rolePrimary: Record<string, string>;
  routingMode: ModelRoutingMode;
  optimizationObjective: ModelOptimizationObjective;
  minimumSamples: number;
  explorationRate: number;
  complexityEscalation?: boolean;
};

const MODEL_ID_PATTERN = /^~?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._~:/-]+$/;
const MAX_SELECTED_MODELS = 500;
const VALID_ROUTING_MODES = new Set<ModelRoutingMode>(['manual', 'advisor', 'adaptive']);
const VALID_OBJECTIVES = new Set<ModelOptimizationObjective>(['quality', 'balanced', 'budget', 'speed']);

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))];
}

export function validateOpenRouterModelId(modelId: string): boolean {
  return modelId.length <= 200 && MODEL_ID_PATTERN.test(modelId);
}

export function validateProductionOpenRouterModelId(modelId: string): boolean {
  return validateOpenRouterModelId(modelId) && (/:free$/i.test(modelId) || modelId.toLowerCase() === 'openrouter/free');
}

export function parseOpenRouterModelPolicy(raw: string | undefined | null): OpenRouterModelPolicy | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || !Array.isArray(parsed.selectedModelIds)) return null;
    const selectedModelIds = uniqueStrings(parsed.selectedModelIds);
    if (selectedModelIds.length < 1 || selectedModelIds.length > MAX_SELECTED_MODELS || selectedModelIds.some((modelId) => !validateProductionOpenRouterModelId(modelId))) return null;

    const selected = new Set(selectedModelIds);
    const rolePrimary: Record<string, string> = {};
    if (parsed.rolePrimary && typeof parsed.rolePrimary === 'object' && !Array.isArray(parsed.rolePrimary)) {
      for (const [rawRole, rawModel] of Object.entries(parsed.rolePrimary as Record<string, unknown>)) {
        const role = rawRole.trim().toUpperCase();
        if (!role || role.length > 80 || typeof rawModel !== 'string') continue;
        const modelId = rawModel.trim();
        if (selected.has(modelId)) rolePrimary[role] = modelId;
      }
    }

    const routingMode = typeof parsed.routingMode === 'string' && VALID_ROUTING_MODES.has(parsed.routingMode as ModelRoutingMode)
      ? parsed.routingMode as ModelRoutingMode : 'manual';
    const optimizationObjective = typeof parsed.optimizationObjective === 'string' && VALID_OBJECTIVES.has(parsed.optimizationObjective as ModelOptimizationObjective)
      ? parsed.optimizationObjective as ModelOptimizationObjective : 'balanced';
    const rawMinimumSamples = Number(parsed.minimumSamples ?? 5);
    const minimumSamples = Number.isFinite(rawMinimumSamples) ? Math.max(2, Math.min(100, Math.round(rawMinimumSamples))) : 5;
    const rawExplorationRate = Number(parsed.explorationRate ?? 0);
    const explorationRate = Number.isFinite(rawExplorationRate) ? Math.max(0, Math.min(0.25, rawExplorationRate)) : 0;
    const complexityEscalation = parsed.complexityEscalation === true;

    return { version: 1, selectedModelIds, rolePrimary, routingMode, optimizationObjective, minimumSamples, explorationRate, complexityEscalation };
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
  if (!reparsed) throw new Error('Invalid zero-cost OpenRouter model policy');
  return JSON.stringify(reparsed);
}

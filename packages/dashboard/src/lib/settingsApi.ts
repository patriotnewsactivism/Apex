export type IntegrationProbeStatus =
  | 'connected'
  | 'configured'
  | 'rate_limited'
  | 'billing_required'
  | 'invalid_key'
  | 'degraded';

export interface IntegrationEnvVar {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  configured: boolean;
  probeable: boolean;
}

export interface IntegrationCatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
  docsUrl?: string;
  envVars: IntegrationEnvVar[];
}

export interface IntegrationSettingsResponse {
  integrations: Array<{ key: string; configured: boolean }>;
  catalog: IntegrationCatalogItem[];
}

export interface IntegrationProbeResult {
  key: string;
  status: IntegrationProbeStatus;
  detail: string;
  httpStatus?: number;
}

export interface WorkforceRecoveryResult {
  ok: boolean;
  recoveredTasks: number;
  resetAgentRows: number;
  skippedTasks: number;
  note: string;
}

export type ModelRoutingMode = 'manual' | 'advisor' | 'adaptive';
export type ModelOptimizationObjective = 'quality' | 'balanced' | 'budget' | 'speed';

export interface OpenRouterModelPolicy {
  version: 1;
  selectedModelIds: string[];
  rolePrimary: Record<string, string>;
  routingMode: ModelRoutingMode;
  optimizationObjective: ModelOptimizationObjective;
  minimumSamples: number;
  /** Older dashboard state may omit this; server defaults to 0. */
  explorationRate?: number;
}

export interface OpenRouterModelCatalogItem {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  pricing: {
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    request: number | null;
  };
  capabilities: {
    toolCalling: boolean;
    structuredOutput: boolean;
    reasoning: boolean;
    vision: boolean;
    inputModalities: string[];
    outputModalities: string[];
  };
  isFree: boolean;
  agentReady: boolean;
  capabilityScore: number;
  efficiencyScore: number;
  recommendedFor: string[];
}

export interface OpenRouterModelCatalogResponse {
  models: OpenRouterModelCatalogItem[];
  policy: OpenRouterModelPolicy;
  source: string;
  pricingUpdatedAt: string;
  efficiencyMethod: string;
}

export interface ModelPerformanceStats {
  modelId: string;
  llmCalls: number;
  generationSuccessRate: number;
  taskSamples: number;
  taskSuccessRate: number | null;
  avgSatisfaction: number | null;
  avgQuality: number | null;
  avgComplexity: number | null;
  avgLatencyMs: number | null;
  avgCostUsd: number | null;
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
  cacheHitTokenRate: number | null;
  toolCallRate: number | null;
  observedScore: number | null;
  confidence: number;
}

export interface ModelIntelligenceReport {
  role: string;
  objective: ModelOptimizationObjective;
  minimumSamples: number;
  targetComplexity: number | null;
  windowDays: number;
  generatedAt: string;
  originalOrder: string[];
  recommendedOrder: string[];
  recommendationChanged: boolean;
  evidenceReadyModels: number;
  stats: ModelPerformanceStats[];
}

export interface ModelIntelligenceResponse {
  report: ModelIntelligenceReport;
  routingMode: ModelRoutingMode;
  explorationRate: number;
  explanation: string;
}

async function settingsFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('apex_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const settingsApi = {
  list: () => settingsFetch<IntegrationSettingsResponse>('/api/settings/integrations'),
  save: (key: string, value: string) =>
    settingsFetch<{ ok: boolean; key: string; configured: boolean }>('/api/settings/integrations', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    }),
  clear: (key: string) =>
    settingsFetch<{ ok: boolean; key: string; configured: boolean }>(
      `/api/settings/integrations/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    ),
  probe: (key: string) =>
    settingsFetch<IntegrationProbeResult>('/api/settings/integrations/probe', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),
  recoverWorkforce: () =>
    settingsFetch<WorkforceRecoveryResult>('/api/settings/recover-workforce', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  models: () => settingsFetch<OpenRouterModelCatalogResponse>('/api/settings/models'),
  modelPolicy: () => settingsFetch<{ policy: OpenRouterModelPolicy }>('/api/settings/models/policy'),
  modelIntelligence: (role: string, options?: { complexity?: number; refresh?: boolean }) => {
    const params = new URLSearchParams({ role });
    if (options?.complexity !== undefined) params.set('complexity', String(options.complexity));
    if (options?.refresh) params.set('refresh', '1');
    return settingsFetch<ModelIntelligenceResponse>(`/api/settings/models/intelligence?${params.toString()}`);
  },
  saveModelPolicy: (policy: OpenRouterModelPolicy) =>
    settingsFetch<{
      ok: boolean;
      policy: OpenRouterModelPolicy;
      applies: string;
      unknownModelIds: string[];
      warning: string | null;
    }>('/api/settings/models/policy', {
      method: 'PUT',
      body: JSON.stringify(policy),
    }),
  resetModelPolicy: () =>
    settingsFetch<{ ok: boolean; policy: OpenRouterModelPolicy; applies: string }>(
      '/api/settings/models/policy',
      { method: 'DELETE' },
    ),
};

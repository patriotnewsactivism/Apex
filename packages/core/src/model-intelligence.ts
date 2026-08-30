import { db, logs, taskOutcomes } from '@workspace/db';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { LLMExecutionContext, LLMResponse } from './types.js';
import {
  getActiveOpenRouterModelPolicy,
  type ModelOptimizationObjective,
} from './model-routing.js';
import { getCurrentLLMExecutionContext } from './model-execution-context.js';

export const MODEL_TELEMETRY_LOG_MESSAGE = '[model-intelligence] llm-generation';
const MODEL_INTELLIGENCE_CACHE_MS = 60_000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_TELEMETRY_ROWS = 10_000;
const EXPLORATION_MAX_COMPLEXITY = 0.5;

export interface ModelTelemetryEvent {
  taskId?: string;
  agentId?: string;
  role?: string;
  provider: string;
  requestedModels: string[];
  servedModel?: string;
  success: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  toolCalls: number;
  hadTools: boolean;
  complexityHint?: number;
  errorType?: string;
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

export interface ModelRankingResult {
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

type TaskOutcomeRow = {
  taskId: string;
  success: boolean;
  qualityScore: number;
  satisfactionMetric: number;
  complexity: number;
  toolExecutions: number;
  recordedAt: Date;
};

type TelemetryRow = {
  taskId: string | null;
  agentId: string | null;
  data: Record<string, unknown> | null;
  timestamp: Date;
};

type ModelAccumulator = {
  calls: number;
  successfulCalls: number;
  latencyTotal: number;
  latencyCount: number;
  costTotal: number;
  costCount: number;
  promptTotal: number;
  completionTotal: number;
  cachedTotal: number;
  toolCalls: number;
  hadToolsCalls: number;
  taskSamples: Array<TaskOutcomeRow>;
};

type CacheEntry = { expiresAt: number; value: ModelRankingResult };
const rankingCache = new Map<string, CacheEntry>();

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function safeNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function telemetryFromRow(row: TelemetryRow): ModelTelemetryEvent | null {
  const data = row.data ?? {};
  const requestedModels = safeStringArray(data.requestedModels);
  const provider = typeof data.provider === 'string' ? data.provider : 'openrouter';
  const servedModel = typeof data.servedModel === 'string' ? data.servedModel : undefined;
  const role = typeof data.role === 'string' ? data.role : undefined;
  if (!servedModel && data.success !== false) return null;
  return {
    taskId: row.taskId ?? (typeof data.taskId === 'string' ? data.taskId : undefined),
    agentId: row.agentId ?? (typeof data.agentId === 'string' ? data.agentId : undefined),
    role,
    provider,
    requestedModels,
    servedModel,
    success: data.success !== false,
    latencyMs: Math.max(0, safeNumber(data.latencyMs)),
    promptTokens: Math.max(0, safeNumber(data.promptTokens)),
    completionTokens: Math.max(0, safeNumber(data.completionTokens)),
    cachedTokens: Math.max(0, safeNumber(data.cachedTokens)),
    reasoningTokens: Math.max(0, safeNumber(data.reasoningTokens)),
    costUsd: data.costUsd === null || data.costUsd === undefined ? null : Math.max(0, safeNumber(data.costUsd)),
    toolCalls: Math.max(0, safeNumber(data.toolCalls)),
    hadTools: data.hadTools === true,
    complexityHint: data.complexityHint === undefined ? undefined : clamp01(safeNumber(data.complexityHint)),
    errorType: typeof data.errorType === 'string' ? data.errorType : undefined,
  };
}

function normalizeInverse(value: number | null, min: number, max: number): number {
  if (value === null) return 0.5;
  if (max <= min) return 1;
  return clamp01(1 - (value - min) / (max - min));
}

function objectiveWeights(objective: ModelOptimizationObjective): {
  quality: number;
  reliability: number;
  cost: number;
  latency: number;
} {
  switch (objective) {
    case 'quality':
      return { quality: 0.58, reliability: 0.17, cost: 0.08, latency: 0.17 };
    case 'budget':
      return { quality: 0.30, reliability: 0.15, cost: 0.42, latency: 0.13 };
    case 'speed':
      return { quality: 0.30, reliability: 0.15, cost: 0.10, latency: 0.45 };
    default:
      return { quality: 0.40, reliability: 0.15, cost: 0.25, latency: 0.20 };
  }
}

function complexityWeight(sampleComplexity: number, targetComplexity: number | null): number {
  if (targetComplexity === null) return 1;
  // Never erase a real outcome completely. Nearby-complexity tasks count more,
  // while distant samples retain 25% influence as a general capability prior.
  return Math.max(0.25, 1 - Math.abs(sampleComplexity - targetComplexity));
}

function weightedAverage(
  rows: TaskOutcomeRow[],
  targetComplexity: number | null,
  selector: (row: TaskOutcomeRow) => number,
): number | null {
  if (rows.length === 0) return null;
  let weighted = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const weight = complexityWeight(row.complexity, targetComplexity);
    weighted += selector(row) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}

/**
 * Pure ranking core used by both runtime routing and deterministic CI tests.
 * Models below minimumSamples keep their original slots. This is intentional:
 * sparse evidence may inform the operator, but cannot silently demote/promote a
 * model in adaptive production routing until enough task outcomes exist.
 */
export function rankModelsFromStats(input: {
  role: string;
  candidates: string[];
  stats: ModelPerformanceStats[];
  objective: ModelOptimizationObjective;
  minimumSamples: number;
  pinnedModel?: string;
}): { order: string[]; changed: boolean; evidenceReadyModels: number } {
  const candidates = [...new Set(input.candidates)];
  const statByModel = new Map(input.stats.map((stat) => [stat.modelId, stat]));
  const evidenceReady = candidates.filter((modelId) => {
    const stat = statByModel.get(modelId);
    return stat !== undefined && stat.taskSamples >= input.minimumSamples && stat.observedScore !== null;
  });

  // One evidence-ready model cannot form a comparison. Preserve operator order.
  if (evidenceReady.length < 2) {
    return { order: candidates, changed: false, evidenceReadyModels: evidenceReady.length };
  }

  const rankedEvidence = [...evidenceReady].sort((a, b) => {
    const scoreDelta = (statByModel.get(b)?.observedScore ?? -1) - (statByModel.get(a)?.observedScore ?? -1);
    if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
    // Stable tie break follows the operator's original priority.
    return candidates.indexOf(a) - candidates.indexOf(b);
  });

  const evidenceSet = new Set(evidenceReady);
  let evidenceIndex = 0;
  let order = candidates.map((modelId) => evidenceSet.has(modelId) ? rankedEvidence[evidenceIndex++] : modelId);

  // A role primary is an explicit operator pin, stronger than adaptive learning.
  if (input.pinnedModel && order.includes(input.pinnedModel)) {
    order = [input.pinnedModel, ...order.filter((modelId) => modelId !== input.pinnedModel)];
  }

  return {
    order,
    changed: order.some((modelId, index) => modelId !== candidates[index]),
    evidenceReadyModels: evidenceReady.length,
  };
}

function deterministicFraction(seed: string): number {
  // FNV-1a: deterministic across worker processes/restarts, cheap, and adequate
  // for traffic sampling. This is not used for security or randomness-sensitive work.
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Optional cold-start learning trial. It is intentionally separate from learned
 * ranking: unqualified models normally keep their operator slots, but an
 * explicitly enabled low-rate trial can temporarily put the least-sampled
 * selected model first on an eligible low-complexity task so evidence can grow.
 */
export function applyControlledExploration(input: {
  order: string[];
  stats: ModelPerformanceStats[];
  minimumSamples: number;
  explorationRate: number;
  taskId?: string;
  role?: string;
  targetComplexity?: number;
  pinnedModel?: string;
}): { order: string[]; explored: boolean; modelId?: string } {
  const order = [...input.order];
  if (
    order.length < 2 ||
    input.pinnedModel ||
    !input.taskId ||
    input.targetComplexity === undefined ||
    input.targetComplexity > EXPLORATION_MAX_COMPLEXITY
  ) {
    return { order, explored: false };
  }

  const rate = Math.max(0, Math.min(0.25, input.explorationRate));
  if (rate <= 0) return { order, explored: false };
  if (deterministicFraction(`${input.taskId}:${input.role ?? ''}:model-trial`) >= rate) {
    return { order, explored: false };
  }

  const statByModel = new Map(input.stats.map((stat) => [stat.modelId, stat]));
  const underSampled = order
    .map((modelId, index) => ({
      modelId,
      index,
      samples: statByModel.get(modelId)?.taskSamples ?? 0,
    }))
    .filter((entry) => entry.samples < input.minimumSamples)
    .sort((a, b) => a.samples - b.samples || a.index - b.index);

  const trial = underSampled[0];
  if (!trial || trial.modelId === order[0]) return { order, explored: false };
  return {
    order: [trial.modelId, ...order.filter((modelId) => modelId !== trial.modelId)],
    explored: true,
    modelId: trial.modelId,
  };
}

export async function recordModelTelemetry(event: ModelTelemetryEvent): Promise<void> {
  try {
    await db.insert(logs).values({
      agentId: event.agentId ?? null,
      taskId: event.taskId ?? null,
      level: event.success ? 'debug' : 'warn',
      message: MODEL_TELEMETRY_LOG_MESSAGE,
      data: {
        ...event,
        // Keep the event small and deterministic; never store prompt/completion content.
        requestedModels: event.requestedModels.slice(0, 500),
      },
      timestamp: new Date(),
    });
  } catch {
    // Telemetry is observability, not execution authority. A DB/logging failure
    // must not convert a successfully served LLM response into a failed task.
  }
}

export async function recordResponseTelemetry(input: {
  response: LLMResponse;
  provider: string;
  requestedModels: string[];
  execution?: LLMExecutionContext;
  hadTools: boolean;
}): Promise<void> {
  const response = input.response;
  await recordModelTelemetry({
    taskId: input.execution?.taskId,
    agentId: input.execution?.agentId,
    role: input.execution?.role,
    provider: input.provider,
    requestedModels: input.requestedModels,
    servedModel: response.servedModel,
    success: true,
    latencyMs: response.latencyMs ?? 0,
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    cachedTokens: response.cachedTokens ?? 0,
    reasoningTokens: response.reasoningTokens ?? 0,
    costUsd: response.costUsd ?? null,
    toolCalls: response.toolCalls.length,
    hadTools: input.hadTools,
    complexityHint: input.execution?.complexityHint,
  });
}

export async function getModelIntelligenceReport(input: {
  role: string;
  candidates: string[];
  objective?: ModelOptimizationObjective;
  minimumSamples?: number;
  targetComplexity?: number | null;
  pinnedModel?: string;
  windowDays?: number;
  bypassCache?: boolean;
}): Promise<ModelRankingResult> {
  const role = input.role.trim().toUpperCase();
  const candidates = [...new Set(input.candidates.filter(Boolean))];
  const objective = input.objective ?? 'balanced';
  const minimumSamples = Math.max(2, Math.min(100, Math.round(input.minimumSamples ?? 5)));
  const targetComplexity = input.targetComplexity === null || input.targetComplexity === undefined
    ? null
    : clamp01(input.targetComplexity);
  const windowDays = Math.max(1, Math.min(180, Math.round(input.windowDays ?? DEFAULT_WINDOW_DAYS)));
  const cacheKey = JSON.stringify({ role, candidates, objective, minimumSamples, targetComplexity, pinned: input.pinnedModel, windowDays });
  const cached = rankingCache.get(cacheKey);
  if (!input.bypassCache && cached && cached.expiresAt > Date.now()) return cached.value;

  if (candidates.length === 0) {
    const empty: ModelRankingResult = {
      role,
      objective,
      minimumSamples,
      targetComplexity,
      windowDays,
      generatedAt: new Date().toISOString(),
      originalOrder: [],
      recommendedOrder: [],
      recommendationChanged: false,
      evidenceReadyModels: 0,
      stats: [],
    };
    return empty;
  }

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  let telemetryRows: TelemetryRow[] = [];
  try {
    telemetryRows = await db
      .select({ taskId: logs.taskId, agentId: logs.agentId, data: logs.data, timestamp: logs.timestamp })
      .from(logs)
      .where(and(eq(logs.message, MODEL_TELEMETRY_LOG_MESSAGE), gte(logs.timestamp, since)))
      .orderBy(desc(logs.timestamp))
      .limit(MAX_TELEMETRY_ROWS) as TelemetryRow[];
  } catch {
    telemetryRows = [];
  }

  const events = telemetryRows
    .map(telemetryFromRow)
    .filter((event): event is ModelTelemetryEvent => Boolean(event))
    .filter((event) => (event.role ?? '').toUpperCase() === role)
    .filter((event) => !event.servedModel || candidates.includes(event.servedModel));

  const taskIds = [...new Set(events.map((event) => event.taskId).filter((taskId): taskId is string => Boolean(taskId)))];
  let outcomes: TaskOutcomeRow[] = [];
  if (taskIds.length > 0) {
    try {
      outcomes = await db
        .select({
          taskId: taskOutcomes.taskId,
          success: taskOutcomes.success,
          qualityScore: taskOutcomes.qualityScore,
          satisfactionMetric: taskOutcomes.satisfactionMetric,
          complexity: taskOutcomes.complexity,
          toolExecutions: taskOutcomes.toolExecutions,
          recordedAt: taskOutcomes.recordedAt,
        })
        .from(taskOutcomes)
        .where(inArray(taskOutcomes.taskId, taskIds))
        .orderBy(desc(taskOutcomes.recordedAt)) as TaskOutcomeRow[];
    } catch {
      outcomes = [];
    }
  }

  // Keep only the newest outcome for a task. A retried task may have more than
  // one historical outcome row; the latest is the best description of whether
  // the final attempt actually delivered.
  const outcomeByTask = new Map<string, TaskOutcomeRow>();
  for (const outcome of outcomes) {
    if (!outcomeByTask.has(outcome.taskId)) outcomeByTask.set(outcome.taskId, outcome);
  }

  const accumulators = new Map<string, ModelAccumulator>();
  for (const modelId of candidates) {
    accumulators.set(modelId, {
      calls: 0,
      successfulCalls: 0,
      latencyTotal: 0,
      latencyCount: 0,
      costTotal: 0,
      costCount: 0,
      promptTotal: 0,
      completionTotal: 0,
      cachedTotal: 0,
      toolCalls: 0,
      hadToolsCalls: 0,
      taskSamples: [],
    });
  }

  // Call-level observations belong to the model OpenRouter actually served.
  for (const event of events) {
    if (!event.servedModel) continue;
    const acc = accumulators.get(event.servedModel);
    if (!acc) continue;
    acc.calls++;
    if (event.success) acc.successfulCalls++;
    if (event.latencyMs > 0) {
      acc.latencyTotal += event.latencyMs;
      acc.latencyCount++;
    }
    if (event.costUsd !== null) {
      acc.costTotal += event.costUsd;
      acc.costCount++;
    }
    acc.promptTotal += event.promptTokens;
    acc.completionTotal += event.completionTokens;
    acc.cachedTotal += event.cachedTokens;
    if (event.hadTools) {
      acc.hadToolsCalls++;
      if (event.toolCalls > 0) acc.toolCalls++;
    }
  }

  // Task outcomes are credited once, to the dominant serving model for that
  // task (the model that handled the most successful LLM turns). This prevents
  // one task with 12 iterations from counting as 12 successful tasks, and avoids
  // blindly crediting every transient fallback model with the same outcome.
  const taskModelCounts = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (!event.taskId || !event.servedModel || !event.success) continue;
    const counts = taskModelCounts.get(event.taskId) ?? new Map<string, number>();
    counts.set(event.servedModel, (counts.get(event.servedModel) ?? 0) + 1);
    taskModelCounts.set(event.taskId, counts);
  }
  for (const [taskId, counts] of taskModelCounts) {
    const outcome = outcomeByTask.get(taskId);
    if (!outcome) continue;
    const dominantModel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!dominantModel) continue;
    accumulators.get(dominantModel)?.taskSamples.push(outcome);
  }

  const preliminary = candidates.map((modelId): Omit<ModelPerformanceStats, 'observedScore' | 'confidence'> => {
    const acc = accumulators.get(modelId)!;
    const taskSuccessRate = weightedAverage(acc.taskSamples, targetComplexity, (row) => row.success ? 1 : 0);
    const avgSatisfaction = weightedAverage(acc.taskSamples, targetComplexity, (row) => row.satisfactionMetric);
    const avgQuality = weightedAverage(acc.taskSamples, targetComplexity, (row) => row.qualityScore);
    const avgComplexity = weightedAverage(acc.taskSamples, null, (row) => row.complexity);
    const totalPrompt = acc.promptTotal;
    return {
      modelId,
      llmCalls: acc.calls,
      generationSuccessRate: acc.calls ? acc.successfulCalls / acc.calls : 0,
      taskSamples: acc.taskSamples.length,
      taskSuccessRate,
      avgSatisfaction,
      avgQuality,
      avgComplexity,
      avgLatencyMs: acc.latencyCount ? acc.latencyTotal / acc.latencyCount : null,
      avgCostUsd: acc.costCount ? acc.costTotal / acc.costCount : null,
      avgPromptTokens: acc.calls ? acc.promptTotal / acc.calls : null,
      avgCompletionTokens: acc.calls ? acc.completionTotal / acc.calls : null,
      cacheHitTokenRate: totalPrompt > 0 ? clamp01(acc.cachedTotal / totalPrompt) : null,
      toolCallRate: acc.hadToolsCalls ? clamp01(acc.toolCalls / acc.hadToolsCalls) : null,
    };
  });

  const evidenced = preliminary.filter((stat) => stat.taskSamples > 0);
  const latencyValues = evidenced.map((stat) => stat.avgLatencyMs).filter((value): value is number => value !== null);
  const costValues = evidenced.map((stat) => stat.avgCostUsd).filter((value): value is number => value !== null);
  const minLatency = latencyValues.length ? Math.min(...latencyValues) : 0;
  const maxLatency = latencyValues.length ? Math.max(...latencyValues) : 0;
  const minCost = costValues.length ? Math.min(...costValues) : 0;
  const maxCost = costValues.length ? Math.max(...costValues) : 0;
  const weights = objectiveWeights(objective);

  const stats: ModelPerformanceStats[] = preliminary.map((stat) => {
    if (stat.taskSamples === 0 || stat.taskSuccessRate === null || stat.avgSatisfaction === null) {
      return { ...stat, observedScore: null, confidence: 0 };
    }
    const quality = clamp01(stat.taskSuccessRate * 0.7 + stat.avgSatisfaction * 0.3);
    const reliability = clamp01(stat.generationSuccessRate || 0);
    const cost = normalizeInverse(stat.avgCostUsd, minCost, maxCost);
    const latency = normalizeInverse(stat.avgLatencyMs, minLatency, maxLatency);
    const observedScore = clamp01(
      quality * weights.quality +
      reliability * weights.reliability +
      cost * weights.cost +
      latency * weights.latency,
    );
    const confidence = clamp01(stat.taskSamples / Math.max(minimumSamples * 4, 1));
    return { ...stat, observedScore, confidence };
  });

  const ranked = rankModelsFromStats({
    role,
    candidates,
    stats,
    objective,
    minimumSamples,
    pinnedModel: input.pinnedModel,
  });

  const value: ModelRankingResult = {
    role,
    objective,
    minimumSamples,
    targetComplexity,
    windowDays,
    generatedAt: new Date().toISOString(),
    originalOrder: candidates,
    recommendedOrder: ranked.order,
    recommendationChanged: ranked.changed,
    evidenceReadyModels: ranked.evidenceReadyModels,
    stats,
  };
  rankingCache.set(cacheKey, { expiresAt: Date.now() + MODEL_INTELLIGENCE_CACHE_MS, value });
  return value;
}

export async function getAdaptiveModelOrder(input: {
  role?: string;
  candidates: string[];
  objective: ModelOptimizationObjective;
  minimumSamples: number;
  pinnedModel?: string;
  targetComplexity?: number;
}): Promise<string[]> {
  if (!input.role || input.candidates.length < 2) return [...input.candidates];
  const report = await getModelIntelligenceReport({
    role: input.role,
    candidates: input.candidates,
    objective: input.objective,
    minimumSamples: input.minimumSamples,
    targetComplexity: input.targetComplexity,
    pinnedModel: input.pinnedModel,
  });

  const policy = getActiveOpenRouterModelPolicy();
  const execution = getCurrentLLMExecutionContext();
  const trial = applyControlledExploration({
    order: report.recommendedOrder,
    stats: report.stats,
    minimumSamples: input.minimumSamples,
    explorationRate: policy?.routingMode === 'adaptive' ? policy.explorationRate : 0,
    taskId: execution?.taskId,
    role: input.role,
    targetComplexity: input.targetComplexity,
    pinnedModel: input.pinnedModel,
  });
  return trial.order;
}

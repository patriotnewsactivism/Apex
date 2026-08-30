import { Router } from 'express';
import { db, integrationSettings } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_OPENROUTER_MODEL_CHAIN,
  OPENROUTER_MODEL_POLICY_ENV,
  getActiveOpenRouterModelPolicy,
  getModelIntelligenceReport,
  parseOpenRouterModelPolicy,
  resolveComplexityObjective,
  serializeOpenRouterModelPolicy,
  type OpenRouterModelPolicy,
} from '@workspace/core';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODEL_FETCH_TIMEOUT_MS = 12_000;

type OpenRouterCatalogEntry = {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: Record<string, string | number | null | undefined>;
  supported_parameters?: string[];
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
};

type OpenRouterCatalogResponse = { data?: OpenRouterCatalogEntry[] };

function usdPerMillion(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric * 1_000_000 : null;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function valueEfficiencyScore(inputPerM: number | null, outputPerM: number | null, context: number, capabilityScore: number): number {
  const knownCosts = [inputPerM, outputPerM].filter((value): value is number => value !== null);
  const blended = inputPerM !== null && outputPerM !== null
    ? inputPerM * 0.8 + outputPerM * 0.2
    : knownCosts.length ? knownCosts[0] : 10;
  const costScore = blended === 0 ? 100 : 100 / (1 + blended / 0.75);
  const normalizedContext = Math.max(16_384, context || 16_384);
  const contextScore = clampScore(35 + Math.log2(normalizedContext / 32_768) * 13);
  return clampScore(costScore * 0.55 + capabilityScore * 0.25 + contextScore * 0.20);
}

function normalizeModel(entry: OpenRouterCatalogEntry) {
  const id = String(entry.id ?? '').trim();
  if (!id) return null;

  const supported = new Set((entry.supported_parameters ?? []).map((item) => item.toLowerCase()));
  const inputModalities = entry.architecture?.input_modalities ?? [];
  const outputModalities = entry.architecture?.output_modalities ?? [];
  if (outputModalities.length > 0 && !outputModalities.includes('text')) return null;

  const inputPerMillion = usdPerMillion(entry.pricing?.prompt);
  const outputPerMillion = usdPerMillion(entry.pricing?.completion);
  const requestPrice = entry.pricing?.request === undefined ? null : Number(entry.pricing.request);
  const contextLength = Number(entry.context_length ?? 0) || 0;
  const toolCalling = supported.has('tools') || supported.has('tool_choice');
  const structuredOutput = supported.has('response_format') || supported.has('structured_outputs');
  const reasoning = supported.has('reasoning') || supported.has('include_reasoning');
  const vision = inputModalities.includes('image') || /image/i.test(entry.architecture?.modality ?? '');
  const isFree = (inputPerMillion === 0 && outputPerMillion === 0) || id.endsWith(':free');

  let capabilityScore = 25;
  if (toolCalling) capabilityScore += 30;
  if (structuredOutput) capabilityScore += 15;
  if (reasoning) capabilityScore += 15;
  if (vision) capabilityScore += 10;
  if (contextLength >= 262_144) capabilityScore += 5;
  capabilityScore = clampScore(capabilityScore);

  const recommendedFor: string[] = [];
  const blended = inputPerMillion !== null && outputPerMillion !== null
    ? inputPerMillion * 0.8 + outputPerMillion * 0.2
    : null;
  if (isFree) recommendedFor.push('free/background work');
  if (toolCalling && reasoning) recommendedFor.push('executive reasoning / autonomous agents');
  if (toolCalling && blended !== null && blended <= 0.75) recommendedFor.push('high-volume agent work');
  if (contextLength >= 524_288) recommendedFor.push('long-context research / repository analysis');
  if (vision) recommendedFor.push('visual QA / multimodal review');
  if (toolCalling && structuredOutput) recommendedFor.push('tool-heavy workflows / structured automation');
  if (recommendedFor.length === 0) recommendedFor.push('general text work');

  return {
    id,
    name: entry.name ?? id,
    description: entry.description ?? '',
    contextLength,
    pricing: {
      inputPerMillion,
      outputPerMillion,
      request: Number.isFinite(requestPrice) ? requestPrice : null,
    },
    capabilities: {
      toolCalling,
      structuredOutput,
      reasoning,
      vision,
      inputModalities,
      outputModalities,
    },
    isFree,
    agentReady: toolCalling,
    capabilityScore,
    efficiencyScore: valueEfficiencyScore(inputPerMillion, outputPerMillion, contextLength, capabilityScore),
    recommendedFor,
  };
}

async function fetchOpenRouterModels() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'HTTP-Referer': 'https://apex.donmatthews.live',
      'X-Title': 'APEX Model Control',
    };
    const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY_2;
    if (key) headers.Authorization = `Bearer ${key}`;

    const response = await fetch(OPENROUTER_MODELS_URL, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`OpenRouter model catalog returned HTTP ${response.status}`);
    }
    const body = await response.json() as OpenRouterCatalogResponse;
    return (body.data ?? []).map(normalizeModel).filter((model): model is NonNullable<ReturnType<typeof normalizeModel>> => Boolean(model));
  } finally {
    clearTimeout(timeout);
  }
}

function defaultPolicy(): OpenRouterModelPolicy {
  return {
    version: 1,
    selectedModelIds: [...DEFAULT_OPENROUTER_MODEL_CHAIN],
    rolePrimary: {},
    routingMode: 'manual',
    optimizationObjective: 'balanced',
    minimumSamples: 5,
    explorationRate: 0,
    complexityEscalation: false,
  };
}

export function createModelSettingsRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const models = await fetchOpenRouterModels();
      const policy = getActiveOpenRouterModelPolicy() ?? defaultPolicy();
      res.json({
        models,
        policy,
        source: 'OpenRouter /api/v1/models',
        pricingUpdatedAt: new Date().toISOString(),
        efficiencyMethod: 'APEX value-efficiency heuristic: 55% price efficiency, 25% agent capabilities, 20% context. It is not an intelligence benchmark.',
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
        policy: getActiveOpenRouterModelPolicy() ?? defaultPolicy(),
      });
    }
  });

  router.get('/intelligence', async (req, res) => {
    try {
      const role = String(req.query.role ?? '').trim().toUpperCase();
      if (!role || !/^[A-Z0-9_\-]{2,80}$/.test(role)) {
        res.status(400).json({ error: 'A valid role query parameter is required.' });
        return;
      }
      const policy = getActiveOpenRouterModelPolicy() ?? defaultPolicy();
      const rawComplexity = req.query.complexity === undefined ? null : Number(req.query.complexity);
      const targetComplexity = rawComplexity !== null && Number.isFinite(rawComplexity)
        ? Math.max(0, Math.min(1, rawComplexity))
        : null;
      const effectiveObjective = resolveComplexityObjective({
        baseObjective: policy.optimizationObjective,
        targetComplexity,
        enabled: policy.complexityEscalation === true,
      });
      const report = await getModelIntelligenceReport({
        role,
        candidates: policy.selectedModelIds,
        objective: effectiveObjective,
        minimumSamples: policy.minimumSamples,
        targetComplexity,
        pinnedModel: policy.rolePrimary[role],
        bypassCache: req.query.refresh === '1' || req.query.refresh === 'true',
      });
      const objectiveChanged = effectiveObjective !== policy.optimizationObjective;
      res.json({
        report,
        routingMode: policy.routingMode,
        explorationRate: policy.explorationRate,
        complexityEscalation: policy.complexityEscalation === true,
        baseObjective: policy.optimizationObjective,
        effectiveObjective,
        explanation: policy.routingMode === 'adaptive'
          ? `Evidence-qualified models may reorder inside the selected roster. Explicit role pins remain first.${policy.explorationRate > 0 ? ` Controlled learning trials are enabled for up to ${Math.round(policy.explorationRate * 100)}% of eligible low-complexity tasks.` : ''}${objectiveChanged ? ` Complexity escalation changed this analysis objective from ${policy.optimizationObjective} to ${effectiveObjective}.` : ''}`
          : policy.routingMode === 'advisor'
            ? `Recommendations are advisory only; the saved operator order remains authoritative.${objectiveChanged ? ` Complexity escalation changed this analysis objective from ${policy.optimizationObjective} to ${effectiveObjective}.` : ''}`
            : 'Manual mode preserves the exact saved operator order.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/policy', (_req, res) => {
    res.json({ policy: getActiveOpenRouterModelPolicy() ?? defaultPolicy() });
  });

  router.put('/policy', async (req, res) => {
    try {
      const candidate = parseOpenRouterModelPolicy(JSON.stringify(req.body));
      if (!candidate) {
        res.status(400).json({
          error: 'Invalid model policy. Select 1-500 valid OpenRouter model IDs; role primaries must be selected models.',
        });
        return;
      }

      // Catalog validation is advisory because OpenRouter supports aliases and
      // new model IDs that may appear between catalog refreshes and save time.
      let unknownModelIds: string[] = [];
      try {
        const catalog = await fetchOpenRouterModels();
        const known = new Set(catalog.map((model) => model.id));
        unknownModelIds = candidate.selectedModelIds.filter((modelId) => !known.has(modelId));
      } catch {
        // Saving a syntactically valid policy must not depend on catalog uptime.
      }

      const serialized = serializeOpenRouterModelPolicy(candidate);
      await db.insert(integrationSettings).values({
        key: OPENROUTER_MODEL_POLICY_ENV,
        value: serialized,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: integrationSettings.key,
        set: { value: serialized, updatedAt: new Date() },
      });
      process.env[OPENROUTER_MODEL_POLICY_ENV] = serialized;

      res.json({
        ok: true,
        policy: candidate,
        applies: 'next LLM request; persisted across restarts',
        unknownModelIds,
        warning: unknownModelIds.length
          ? 'Some selected IDs were not present in the current catalog. They were retained because aliases/new releases can legitimately be absent during a catalog refresh.'
          : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/policy', async (_req, res) => {
    try {
      await db.delete(integrationSettings).where(eq(integrationSettings.key, OPENROUTER_MODEL_POLICY_ENV));
      delete process.env[OPENROUTER_MODEL_POLICY_ENV];
      res.json({ ok: true, policy: defaultPolicy(), applies: 'next LLM request' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

import type {
  LLMClientConfig,
  LLMExecutionContext,
  LLMMessage,
  LLMResponse,
  LLMRouterMetadata,
  LLMTool,
  LLMToolCall,
} from './types.js';
import {
  isTotalDailyCapReached,
  msUntilDailyReset,
  recordTokenUsage,
  reserveProviderTokenCapacity,
  reserveTotalTokenCapacity,
  type TokenCapacityReservation,
} from './token-ledger.js';
import {
  DEFAULT_OPENROUTER_MODEL_CHAIN,
  getActiveOpenRouterModelPolicy,
  getOpenRouterModelChainForRole,
  getPinnedOpenRouterModelForRole,
  hasCustomOpenRouterModelPolicy,
} from './model-routing.js';
import {
  getAdaptiveModelOrder,
  recordModelTelemetry,
  recordResponseTelemetry,
} from './model-intelligence.js';

// ─── APEX OpenRouter Stack ────────────────────────────────────────────────────
//
// OpenRouter is the production gateway. With no operator policy, APEX preserves
// the reviewed DeepSeek V4 chain below. When APEX_OPENROUTER_MODEL_POLICY is a
// valid persisted policy, the selected model roster is sent to OpenRouter via
// its native `models` fallback parameter in role-specific priority order.
//
// Pricing is deliberately NOT hard-coded here. The Settings model-control API
// reads OpenRouter's live catalog because per-model prices may change.

export type ApexProviderName =
  | 'openrouter-deepseek-flash'
  | 'openrouter-deepseek-flash-0731'
  | 'openrouter-deepseek-pro';

type ProviderSpec = {
  name: ApexProviderName;
  model: string;
  baseURL: string | (() => string | undefined);
  apiKeyEnvs: readonly string[];
  paid?: boolean;
  activationEnv?: string;
  activationDescription?: string;
  /** Minimum spacing between request starts for this logical provider. */
  minIntervalMs: number;
  toolCallingReliable: true;
};

const PROVIDERS: readonly ProviderSpec[] = [
  {
    name: 'openrouter-deepseek-flash',
    model: DEFAULT_OPENROUTER_MODEL_CHAIN[0],
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnvs: ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2'],
    minIntervalMs: 500,
    toolCallingReliable: true,
  },
  {
    name: 'openrouter-deepseek-flash-0731',
    model: DEFAULT_OPENROUTER_MODEL_CHAIN[1],
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnvs: ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2'],
    minIntervalMs: 500,
    toolCallingReliable: true,
  },
  {
    name: 'openrouter-deepseek-pro',
    model: DEFAULT_OPENROUTER_MODEL_CHAIN[2],
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnvs: ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2'],
    minIntervalMs: 500,
    toolCallingReliable: true,
  },
] as const;

const PROVIDER_BY_NAME = new Map<ApexProviderName, ProviderSpec>(
  PROVIDERS.map((provider) => [provider.name, provider]),
);

const PROVIDER_ORDER: readonly ApexProviderName[] = [
  'openrouter-deepseek-flash',
  'openrouter-deepseek-flash-0731',
  'openrouter-deepseek-pro',
];

export function getProviderOrderForRole(_role?: string): ApexProviderName[] {
  // A custom roster is one OpenRouter gateway request with native model
  // fallback. Repeating that same roster through three logical adapters would
  // multiply identical requests and defeat provider pacing/circuit breaking.
  if (hasCustomOpenRouterModelPolicy()) return ['openrouter-deepseek-flash'];
  return [...PROVIDER_ORDER];
}

/** Paid inference is no longer gated — the selected OpenRouter roster is an
 * explicit operator decision. Kept for backward compatibility with callers
 * that still inspect APEX_PAID_LLM_MODE. */
export function paidLLMFallbackEnabled(mode?: string): boolean {
  const normalized = (mode ?? 'on').trim().toLowerCase();
  return ['1', 'true', 'on', 'enabled', 'fallback'].includes(normalized);
}

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'enabled', 'yes', 'confirmed'].includes(
    (value ?? '').trim().toLowerCase(),
  );
}

// ─── Request-size control ─────────────────────────────────────────────────────

export const DEFAULT_HISTORY_CHAR_BUDGET = 120_000;
export const EMERGENCY_HISTORY_CHAR_BUDGET = 48_000;

export function historySize(messages: LLMMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      (message.content?.length ?? 0) +
      (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0),
    0,
  );
}

/** Conservative pre-call reservation. Actual provider usage replaces this
 * in-flight estimate after the response is recorded. */
export function estimateLLMRequestTokens(
  messages: LLMMessage[],
  tools: LLMTool[] | undefined,
  maxOutputTokens: number,
): number {
  const messageChars = historySize(messages);
  const toolChars = tools?.length ? JSON.stringify(tools).length : 0;
  const promptEstimate = Math.ceil((messageChars + toolChars) / 4);
  return Math.max(
    512,
    promptEstimate + Math.max(0, Math.floor(maxOutputTokens)),
  );
}

export function trimMessageHistory(
  messages: LLMMessage[],
  maxChars: number = DEFAULT_HISTORY_CHAR_BUDGET,
): { messages: LLMMessage[]; trimmed: boolean; originalChars: number; finalChars: number } {
  const originalChars = historySize(messages);
  if (originalChars <= maxChars) {
    return { messages, trimmed: false, originalChars, finalChars: originalChars };
  }

  const out = messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, args: { ...call.args } })),
  }));
  const marker = '\n… [truncated to fit provider request budget]';

  const trimContent = (message: LLMMessage, keep: number) => {
    if ((message.content?.length ?? 0) > keep) {
      message.content = `${message.content.slice(0, keep)}${marker}`;
    }
  };

  for (const message of out) {
    if (historySize(out) <= maxChars) break;
    if (message.role === 'tool') trimContent(message, 2_400);
  }

  let firstUserSeen = false;
  for (const message of out) {
    if (historySize(out) <= maxChars) break;
    if (message.role === 'system') continue;
    if (message.role === 'user' && !firstUserSeen) {
      firstUserSeen = true;
      continue;
    }
    trimContent(message, 4_000);
  }

  if (historySize(out) > maxChars && out[0]?.role === 'system') {
    trimContent(out[0], 16_000);
  }

  for (const message of out) {
    if (historySize(out) <= maxChars) break;
    trimContent(message, 1_200);
  }

  return {
    messages: out,
    trimmed: true,
    originalChars,
    finalChars: historySize(out),
  };
}

export function isRequestTooLargeError(status: unknown, message: string): boolean {
  if (status === 413) return true;
  return /request too large|too many tokens|context length|maximum context|reduce the length|prompt is too long/i.test(
    message,
  );
}

// ─── Diagnostics + circuit breakers ──────────────────────────────────────────

type ProviderFailureEvent = {
  provider: string;
  model: string;
  status?: string | number;
  message: string;
  at: number;
};

const providerFailureEvents: ProviderFailureEvent[] = [];
const degradedToolCallEvents: Array<{
  provider: string;
  model: string;
  at: number;
}> = [];
type CredentialCooldown = {
  until: number;
  capacityPause: boolean;
  reason: string;
};
const credentialCooldowns = new Map<string, CredentialCooldown>();
type ProviderRequestError = Error & {
  status?: number;
  retryAfterMs?: number;
  requestedModels?: string[];
  latencyMs?: number;
  routerMetadata?: LLMRouterMetadata;
};
const providerCooldowns = new Map<ApexProviderName, number>();
const providerNextAttemptAt = new Map<ApexProviderName, number>();

const COOLDOWN_429_MS = 30_000;
const COOLDOWN_402_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_AUTH_MS = 10 * 60 * 1000;
const COOLDOWN_404_MS = 10 * 60 * 1000;
const COOLDOWN_413_MS = 15 * 60 * 1000;
const DAILY_QUOTA_PATTERN =
  /\b(per[\s-]?day|daily|tokens per day|tpd|quota exhausted|daily limit|free tier|free quota)\b/i;

function recordProviderFailure(
  provider: string,
  model: string,
  status: string | number | undefined,
  message: string,
): void {
  providerFailureEvents.push({ provider, model, status, message, at: Date.now() });
  if (providerFailureEvents.length > 300) providerFailureEvents.shift();
}

export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return undefined;
}

function cooldownMs(status: number | undefined, message: string): number {
  if (status === 402) return COOLDOWN_402_MS;
  if (status === 401 || status === 403) {
    if (/free.?tier.?only|allocationquota|free quota|quota exhausted/i.test(message)) {
      return msUntilDailyReset();
    }
    return COOLDOWN_AUTH_MS;
  }
  if (status === 404) return COOLDOWN_404_MS;
  if (status === 413) return COOLDOWN_413_MS;
  if (status === 429 && DAILY_QUOTA_PATTERN.test(message)) return msUntilDailyReset();
  return COOLDOWN_429_MS;
}

function isCapacityFailure(
  status: number | undefined,
  message: string,
): boolean {
  return (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    ((status === 401 || status === 403) &&
      /free.?tier.?only|allocationquota|free quota|quota exhausted/i.test(
        message,
      ))
  );
}

function credentialCooldown(id: string): CredentialCooldown | null {
  const cooldown = credentialCooldowns.get(id);
  if (!cooldown) return null;
  if (Date.now() >= cooldown.until) {
    credentialCooldowns.delete(id);
    return null;
  }
  return cooldown;
}

function setCredentialCooldown(
  id: string,
  status: number | undefined,
  message: string,
  retryAfterMs?: number,
): void {
  const duration = Math.max(cooldownMs(status, message), retryAfterMs ?? 0);
  credentialCooldowns.set(id, {
    until: Date.now() + duration,
    capacityPause: isCapacityFailure(status, message),
    reason: message.slice(0, 240),
  });
}

function clearCredentialCooldown(id: string): void {
  credentialCooldowns.delete(id);
}

function providerMinIntervalMs(provider: ProviderSpec): number {
  const envName = `APEX_LLM_MIN_INTERVAL_MS_${provider.name.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return provider.minIntervalMs;
  const configured = Number(raw);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.min(60_000, Math.floor(configured));
  }
  return provider.minIntervalMs;
}

export function getProviderRequestSpacingMs(providerName: ApexProviderName): number {
  const provider = PROVIDER_BY_NAME.get(providerName);
  if (!provider) throw new Error(`Unknown APEX provider: ${providerName}`);
  return providerMinIntervalMs(provider);
}

function providerReadyAt(provider: ProviderSpec): number {
  const now = Date.now();
  const cooldownUntil = providerCooldowns.get(provider.name) ?? 0;
  if (cooldownUntil && cooldownUntil <= now) providerCooldowns.delete(provider.name);
  return Math.max(
    providerCooldowns.get(provider.name) ?? 0,
    providerNextAttemptAt.get(provider.name) ?? 0,
  );
}

function tryReserveProviderAttempt(provider: ProviderSpec): { reserved: boolean; readyAt: number } {
  const now = Date.now();
  const readyAt = providerReadyAt(provider);
  if (readyAt > now) return { reserved: false, readyAt };
  providerNextAttemptAt.set(provider.name, now + providerMinIntervalMs(provider));
  return { reserved: true, readyAt: now };
}

function setProviderCooldown(
  provider: ProviderSpec,
  status: number | undefined,
  message: string,
  retryAfterMs?: number,
): void {
  const providerWide =
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    ((status === 401 || status === 403) && DAILY_QUOTA_PATTERN.test(message));
  if (!providerWide) return;
  const duration = Math.max(cooldownMs(status, message), retryAfterMs ?? 0);
  providerCooldowns.set(
    provider.name,
    Math.max(providerCooldowns.get(provider.name) ?? 0, Date.now() + duration),
  );
}

export function getProviderBackpressureSnapshot(): {
  pausedProviders: string[];
  nextResumeAt: string | null;
} {
  const now = Date.now();
  const paused: Array<{ provider: string; readyAt: number }> = [];
  for (const provider of PROVIDERS) {
    if (!providerConfigured(provider)) continue;
    const readyAt = providerCooldowns.get(provider.name) ?? 0;
    if (readyAt > now) paused.push({ provider: provider.name, readyAt });
    else if (readyAt) providerCooldowns.delete(provider.name);
  }
  const next = paused.length ? Math.min(...paused.map((entry) => entry.readyAt)) : null;
  return {
    pausedProviders: paused.map((entry) => entry.provider),
    nextResumeAt: next === null ? null : new Date(next).toISOString(),
  };
}

function providerBaseURL(provider: ProviderSpec): string | undefined {
  const raw = typeof provider.baseURL === 'function' ? provider.baseURL() : provider.baseURL;
  return raw?.replace(/\/$/, '');
}

function providerActivationIssue(provider: ProviderSpec): string | null {
  if (provider.paid && !paidLLMFallbackEnabled(process.env.APEX_PAID_LLM_MODE)) {
    return 'paid fallback disabled (APEX_PAID_LLM_MODE=off)';
  }
  if (provider.activationEnv && !enabled(process.env[provider.activationEnv])) {
    return provider.activationDescription ?? `${provider.activationEnv}=true is required`;
  }
  return null;
}

function providerRequirements(provider: ProviderSpec): string[] {
  const missing = new Set<string>();
  if (!provider.apiKeyEnvs.some((name) => Boolean(process.env[name]))) {
    missing.add(provider.apiKeyEnvs.join(' or '));
  }
  const activationIssue = providerActivationIssue(provider);
  if (activationIssue) missing.add(activationIssue);
  return [...missing];
}

function configuredCredentials(provider: ProviderSpec): Array<{ env: string; key: string }> {
  return provider.apiKeyEnvs
    .map((env) => ({ env, key: process.env[env] ?? '' }))
    .filter((entry) => Boolean(entry.key));
}

// ─── Process-wide call smoothing ─────────────────────────────────────────────

const configuredLLMConcurrency = Number(process.env.APEX_MAX_CONCURRENT_LLM_CALLS ?? 6);
const MAX_CONCURRENT_LLM_CALLS = Number.isFinite(configuredLLMConcurrency)
  ? Math.min(16, Math.max(1, Math.floor(configuredLLMConcurrency)))
  : 6;

let activeLLMCalls = 0;
const llmCallWaitQueue: Array<() => void> = [];

function acquireLLMConcurrencySlot(): Promise<void> {
  if (activeLLMCalls < MAX_CONCURRENT_LLM_CALLS) {
    activeLLMCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    llmCallWaitQueue.push(() => {
      activeLLMCalls++;
      resolve();
    });
  });
}

function releaseLLMConcurrencySlot(): void {
  activeLLMCalls = Math.max(0, activeLLMCalls - 1);
  const next = llmCallWaitQueue.shift();
  if (next) next();
}

// ─── OpenAI-compatible wire format ───────────────────────────────────────────

function toWireMessages(messages: LLMMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId ?? '',
      };
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls?.length
          ? message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            }))
          : undefined,
      };
    }
    return { role: message.role, content: message.content };
  });
}

function toWireTools(tools?: LLMTool[]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function parseToolCalls(raw: any): LLMToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((call) => call?.function?.name)
    .map((call) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
      } catch {
        args = {};
      }
      return {
        id: call.id ?? `tool-${Math.random().toString(36).slice(2)}`,
        name: call.function.name,
        args,
      };
    });
}

type CompatibleRouterAttempt = {
  provider?: unknown;
  model?: unknown;
  status?: unknown;
};

type CompatibleRouterMetadata = {
  requested?: unknown;
  strategy?: unknown;
  attempt?: unknown;
  endpoints?: {
    available?: Array<{
      provider?: unknown;
      model?: unknown;
      selected?: unknown;
    }>;
  };
  attempts?: CompatibleRouterAttempt[];
};

type CompatibleResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  openrouter_metadata?: CompatibleRouterMetadata;
  error?: { message?: string; type?: string; code?: string | number };
};

function sanitizeRouterMetadata(raw: CompatibleRouterMetadata | undefined): LLMRouterMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const requested = typeof raw.requested === 'string' ? raw.requested.slice(0, 200) : undefined;
  const strategy = typeof raw.strategy === 'string' ? raw.strategy.slice(0, 80) : undefined;
  const rawAttempt = Number(raw.attempt);
  const attempt = Number.isFinite(rawAttempt) && rawAttempt >= 0 ? Math.floor(rawAttempt) : undefined;
  const selectedEndpoint = Array.isArray(raw.endpoints?.available)
    ? raw.endpoints?.available.find((entry) => entry?.selected === true)
    : undefined;
  const selectedProvider = typeof selectedEndpoint?.provider === 'string'
    ? selectedEndpoint.provider.slice(0, 120)
    : undefined;
  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts.slice(0, 25).map((entry) => {
        const statusNumber = Number(entry?.status);
        return {
          provider: typeof entry?.provider === 'string' ? entry.provider.slice(0, 120) : undefined,
          model: typeof entry?.model === 'string' ? entry.model.slice(0, 200) : undefined,
          status: Number.isFinite(statusNumber) ? Math.floor(statusNumber) : undefined,
        };
      })
    : undefined;

  if (!requested && !strategy && attempt === undefined && !selectedProvider && !attempts?.length) {
    return undefined;
  }
  return { requested, strategy, attempt, selectedProvider, attempts };
}

async function callCompatibleProvider(
  provider: ProviderSpec,
  key: string,
  messages: LLMMessage[],
  tools: LLMTool[] | undefined,
  config: LLMClientConfig,
  execution?: LLMExecutionContext,
): Promise<LLMResponse> {
  const baseURL = providerBaseURL(provider);
  if (!baseURL) {
    throw Object.assign(new Error('provider base URL is not configured'), { status: 0 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  const startedAt = Date.now();
  let routedModels = [provider.model];

  try {
    const policy = getActiveOpenRouterModelPolicy();
    const customPolicy = Boolean(policy);
    routedModels = customPolicy
      ? getOpenRouterModelChainForRole(config.role)
      : [provider.model];

    if (policy?.routingMode === 'adaptive') {
      routedModels = await getAdaptiveModelOrder({
        role: config.role,
        candidates: routedModels,
        objective: policy.optimizationObjective,
        minimumSamples: policy.minimumSamples,
        pinnedModel: getPinnedOpenRouterModelForRole(config.role),
        targetComplexity: execution?.complexityHint,
      });
    }

    const body: Record<string, unknown> = {
      messages: toWireMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 2048,
      // Explicitly request usage data so OpenRouter returns billed generation
      // cost alongside token counts when available.
      usage: { include: true },
    };
    if (customPolicy) body.models = routedModels;
    else body.model = provider.model;

    const wireTools = toWireTools(tools);
    if (wireTools?.length) {
      body.tools = wireTools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://apex.donmatthews.live',
        'X-Title': 'APEX Agent Workforce',
        // OpenRouter documents this as the stable opt-in for route audit data.
        // Only a privacy-minimized subset is retained by APEX.
        'X-OpenRouter-Metadata': 'enabled',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: CompatibleResponse = {};
    try {
      parsed = text ? (JSON.parse(text) as CompatibleResponse) : {};
    } catch {
      parsed = {};
    }
    const routerMetadata = sanitizeRouterMetadata(parsed.openrouter_metadata);

    if (!response.ok) {
      const detail =
        parsed.error?.message ||
        text.slice(0, 500) ||
        `HTTP ${response.status}`;
      throw Object.assign(new Error(detail), {
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        routerMetadata,
      });
    }

    const choice = parsed.choices?.[0]?.message;
    if (!choice) throw new Error('provider returned no completion choice');
    const servedModel = parsed.model || routedModels[0] || provider.model;
    const rawCost = Number(parsed.usage?.cost);

    return {
      content: choice.content ?? '',
      toolCalls: parseToolCalls(choice.tool_calls),
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
      },
      model: `${provider.name}/${servedModel}`,
      servedModel,
      requestedModels: [...routedModels],
      routerMetadata,
      latencyMs: Date.now() - startedAt,
      costUsd: Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null,
      cachedTokens: Math.max(0, parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      reasoningTokens: Math.max(0, parsed.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    };
  } catch (error) {
    const err = error instanceof Error ? error as ProviderRequestError : new Error(String(error)) as ProviderRequestError;
    err.requestedModels = [...routedModels];
    err.latencyMs = Date.now() - startedAt;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

type CapacityBlock = {
  source: string;
  resumeAt: string | null;
  reason: string;
};

function capacityBlockFromReservation(
  source: string,
  reservation: TokenCapacityReservation,
): CapacityBlock {
  return {
    source,
    resumeAt: reservation.resumeAt,
    reason:
      reservation.reason === 'daily_cap'
        ? 'daily cap reached'
        : 'daily allowance pacing',
  };
}

function capacityPauseError(blocks: CapacityBlock[], otherDetails: string[] = []): Error {
  const timestamps = blocks
    .map((block) => (block.resumeAt ? Date.parse(block.resumeAt) : Number.NaN))
    .filter(Number.isFinite);
  const resumeAt = timestamps.length
    ? new Date(Math.min(...timestamps)).toISOString()
    : new Date(Date.now() + 60_000).toISOString();
  const detail = [
    ...new Map(
      blocks.map((block) => [
        `${block.source}:${block.reason}`,
        `${block.source}: ${block.reason}`,
      ]),
    ).values(),
    ...otherDetails,
  ].join(' | ');
  return new Error(
    `APEX LLM capacity paused. resume-at=${resumeAt} | ${detail || 'configured capacity is temporarily unavailable'}`,
  );
}

class MultiProviderClient {
  private config: LLMClientConfig;

  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  async complete(
    messages: LLMMessage[],
    tools?: LLMTool[],
    execution?: LLMExecutionContext,
  ): Promise<LLMResponse> {
    await acquireLLMConcurrencySlot();

    try {
      if (isTotalDailyCapReached()) {
        throw new Error(
          'APEX daily token cap reached (APEX_TOKEN_CAP_TOTAL). LLM spend is paused until the UTC daily reset.',
        );
      }

      const trimmed = trimMessageHistory(messages);
      const estimatedTokens = estimateLLMRequestTokens(
        trimmed.messages,
        tools,
        this.config.maxTokens ?? 2048,
      );
      const totalReservation = reserveTotalTokenCapacity(estimatedTokens);
      if (!totalReservation.allowed) {
        throw capacityPauseError([
          capacityBlockFromReservation('workspace', totalReservation),
        ]);
      }

      try {
        const providerErrors: string[] = [];
        const skipReasons: string[] = [];
        const capacityBlocks: CapacityBlock[] = [];
        let nonCapacityFailureSeen = false;

        for (const providerName of getProviderOrderForRole(this.config.role)) {
          const provider = PROVIDER_BY_NAME.get(providerName);
          if (!provider) continue;

          const activationIssue = providerActivationIssue(provider);
          if (activationIssue) {
            skipReasons.push(`${provider.name}: ${activationIssue}`);
            continue;
          }

          const baseURL = providerBaseURL(provider);
          if (!baseURL) {
            skipReasons.push(`${provider.name}: base URL is not configured`);
            continue;
          }

          const credentials = configuredCredentials(provider);
          if (credentials.length === 0) {
            skipReasons.push(
              `${provider.name}: no API key (${provider.apiKeyEnvs.join(' or ')})`,
            );
            continue;
          }

          const providerAttempt = tryReserveProviderAttempt(provider);
          if (!providerAttempt.reserved) {
            const waitMs = Math.max(0, providerAttempt.readyAt - Date.now());
            capacityBlocks.push({
              source: provider.name,
              resumeAt: new Date(providerAttempt.readyAt).toISOString(),
              reason: 'provider pacing/cooldown',
            });
            skipReasons.push(
              `${provider.name}: provider pacing/cooldown (${Math.ceil(waitMs / 1000)}s)`,
            );
            continue;
          }

          const providerReservation = reserveProviderTokenCapacity(
            provider.name,
            estimatedTokens,
          );
          if (!providerReservation.allowed) {
            capacityBlocks.push(
              capacityBlockFromReservation(provider.name, providerReservation),
            );
            skipReasons.push(
              `${provider.name}: APEX ${providerReservation.reason === 'daily_cap' ? 'per-provider daily cap reached' : 'daily allowance pacing active'}`,
            );
            continue;
          }

          try {
            let providerAttempted = false;

            for (const credential of credentials) {
              const credentialId = `${provider.name}:${credential.env}`;
              const activeCooldown = credentialCooldown(credentialId);
              if (activeCooldown) {
                skipReasons.push(`${credentialId}: credential in cooldown`);
                if (activeCooldown.capacityPause) {
                  capacityBlocks.push({
                    source: credentialId,
                    resumeAt: new Date(activeCooldown.until).toISOString(),
                    reason: activeCooldown.reason,
                  });
                }
                continue;
              }

              providerAttempted = true;

              try {
                const result = await callCompatibleProvider(
                  provider,
                  credential.key,
                  trimmed.messages,
                  tools,
                  this.config,
                  execution,
                );
                clearCredentialCooldown(credentialId);
                recordTokenUsage(provider.name, result.usage);
                await recordResponseTelemetry({
                  response: result,
                  provider: provider.name,
                  requestedModels: result.requestedModels ?? [provider.model],
                  execution: {
                    ...execution,
                    role: execution?.role ?? this.config.role,
                  },
                  hadTools: Boolean(tools?.length),
                });
                return result;
              } catch (error) {
                const err = error as ProviderRequestError;
                const status = err.status;
                const message =
                  err.name === 'AbortError' ? 'request timed out' : err.message;
                const requestedModels = err.requestedModels?.length
                  ? err.requestedModels
                  : hasCustomOpenRouterModelPolicy()
                    ? getOpenRouterModelChainForRole(this.config.role)
                    : [provider.model];
                const attemptedModel = requestedModels[0] ?? provider.model;
                recordProviderFailure(
                  provider.name,
                  attemptedModel,
                  status,
                  message,
                );
                await recordModelTelemetry({
                  taskId: execution?.taskId,
                  agentId: execution?.agentId,
                  role: execution?.role ?? this.config.role,
                  provider: provider.name,
                  requestedModels,
                  routerMetadata: err.routerMetadata,
                  // Only attribute a gateway failure to a specific model when
                  // exactly one model was requested; a multi-model OpenRouter
                  // fallback failure cannot honestly identify which rung failed.
                  servedModel: requestedModels.length === 1 ? requestedModels[0] : undefined,
                  success: false,
                  latencyMs: err.latencyMs ?? 0,
                  promptTokens: 0,
                  completionTokens: 0,
                  cachedTokens: 0,
                  reasoningTokens: 0,
                  costUsd: null,
                  toolCalls: 0,
                  hadTools: Boolean(tools?.length),
                  complexityHint: execution?.complexityHint,
                  errorType: status ? `http_${status}` : err.name || 'provider_error',
                });
                setCredentialCooldown(credentialId, status, message, err.retryAfterMs);
                setProviderCooldown(provider, status, message, err.retryAfterMs);
                const capacityFailure = isCapacityFailure(status, message);
                if (!capacityFailure) nonCapacityFailureSeen = true;
                const newCooldown = credentialCooldown(credentialId);
                if (newCooldown?.capacityPause) {
                  capacityBlocks.push({
                    source: credentialId,
                    resumeAt: new Date(newCooldown.until).toISOString(),
                    reason: message.slice(0, 240),
                  });
                }
                providerErrors.push(
                  `${provider.name}/${attemptedModel} via ${credential.env}: ` +
                    `${status ? `HTTP ${status} ` : ''}${message}`,
                );

                if (capacityFailure) break;

                if (isRequestTooLargeError(status, message)) {
                  try {
                    const emergency = trimMessageHistory(
                      messages,
                      EMERGENCY_HISTORY_CHAR_BUDGET,
                    );
                    const result = await callCompatibleProvider(
                      provider,
                      credential.key,
                      emergency.messages,
                      tools,
                      this.config,
                      execution,
                    );
                    clearCredentialCooldown(credentialId);
                    recordTokenUsage(provider.name, result.usage);
                    await recordResponseTelemetry({
                      response: result,
                      provider: provider.name,
                      requestedModels: result.requestedModels ?? [provider.model],
                      execution: {
                        ...execution,
                        role: execution?.role ?? this.config.role,
                      },
                      hadTools: Boolean(tools?.length),
                    });
                    return result;
                  } catch {
                    // Continue to the next credential/provider.
                  }
                }
              }
            }

            if (
              !providerAttempted &&
              providerRequirements(provider).length > 0
            ) {
              skipReasons.push(
                `${provider.name}: ${providerRequirements(provider).join(', ')}`,
              );
            }
          } finally {
            providerReservation.release();
          }
        }

        const details = [...providerErrors, ...skipReasons];
        if (capacityBlocks.length > 0 && !nonCapacityFailureSeen) {
          throw capacityPauseError(capacityBlocks, details);
        }
        throw new Error(
          `All LLM providers failed or were unavailable. ${
            details.length
              ? details.join(' | ')
              : 'No usable provider credential was configured.'
          }`,
        );
      } finally {
        totalReservation.release();
      }
    } finally {
      releaseLLMConcurrencySlot();
    }
  }
}

export function createLLMClient(config: LLMClientConfig): MultiProviderClient {
  return new MultiProviderClient(config);
}

export type LLMClient = MultiProviderClient;

// ─── Default model configs ───────────────────────────────────────────────────

export function getDefaultLLMConfig(role: string): LLMClientConfig {
  const tokenBudgets: Record<string, number> = {
    CEO: 8192,
    CTO: 8192,
    COO: 8192,
    LEAD_DEV: 8192,
    RESEARCH: 8192,
    LEAD_RESEARCH: 8192,
    SALES: 8192,
    QA_DIRECTOR: 8192,
    FRONTEND: 4096,
    BACKEND: 4096,
    DEVOPS: 4096,
    QA: 4096,
    MARKETING: 4096,
    CUSTOMER_SUCCESS: 4096,
    DOCS: 4096,
    OPS: 4096,
    COMMUNITY_WATCH: 2048,
  };

  const defaultMaxTokens = tokenBudgets[role] ?? 4096;
  const configuredMaxTokens = Number(
    process.env[`APEX_MAX_OUTPUT_TOKENS_${role}`] ??
      process.env.APEX_MAX_OUTPUT_TOKENS ??
      defaultMaxTokens,
  );
  const maxTokens = Number.isFinite(configuredMaxTokens)
    ? Math.min(16_384, Math.max(256, Math.floor(configuredMaxTokens)))
    : defaultMaxTokens;
  const model = getOpenRouterModelChainForRole(role)[0] ?? DEFAULT_OPENROUTER_MODEL_CHAIN[0];

  return {
    provider: 'openrouter-deepseek-flash',
    model,
    temperature: 0.7,
    maxTokens,
    role,
  };
}

// ─── Embeddings ───────────────────────────────────────────────────────────────
//
// Embeddings stay local so a paid inference provider cannot create hidden
// metered spend outside the chat fallback policy.

let localPipeline: any = null;
let pipelineError: string | null = null;

async function getLocalPipeline() {
  if (localPipeline) return localPipeline;
  if (pipelineError) throw new Error(pipelineError);
  try {
    const { pipeline } = await import('@xenova/transformers');
    localPipeline = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
    );
    return localPipeline;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pipelineError = `Local embedding pipeline unavailable: ${msg}`;
    console.warn(`[LLM] ${pipelineError}`);
    throw new Error(pipelineError);
  }
}

export async function createEmbedding(text: string): Promise<number[]> {
  const extractor = await getLocalPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ─── Observable provider state ────────────────────────────────────────────────

export function getProviderFailureReport(windowMs = 3_600_000): Array<{
  provider: string;
  model: string;
  status?: string | number;
  message: string;
  count: number;
  lastAt: string;
}> {
  const cutoff = Date.now() - windowMs;
  const byProvider = new Map<
    string,
    { event: ProviderFailureEvent; count: number }
  >();

  for (const event of providerFailureEvents) {
    if (event.at < cutoff) continue;
    const previous = byProvider.get(event.provider);
    byProvider.set(event.provider, {
      event,
      count: (previous?.count ?? 0) + 1,
    });
  }

  return [...byProvider.values()]
    .map(({ event, count }) => ({
      provider: event.provider,
      model: event.model,
      status: event.status,
      message: event.message,
      count,
      lastAt: new Date(event.at).toISOString(),
    }))
    .sort((a, b) => b.count - a.count);
}

export function getDegradedToolCallingReport(windowMs = 3_600_000): {
  degraded: boolean;
  count: number;
  providers: string[];
  since: string | null;
} {
  const cutoff = Date.now() - windowMs;
  const recent = degradedToolCallEvents.filter((event) => event.at >= cutoff);
  return {
    degraded: recent.length > 0,
    count: recent.length,
    providers: [...new Set(recent.map((event) => `${event.provider}/${event.model}`))],
    since: recent.length ? new Date(recent[0].at).toISOString() : null,
  };
}

function providerConfigured(provider: ProviderSpec): boolean {
  return providerRequirements(provider).length === 0;
}

export function getConfiguredProviders(): Array<{
  name: string;
  configured: boolean;
}> {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    configured: providerConfigured(provider),
  }));
}

export function getProviderRoster(): {
  providers: Array<{
    name: string;
    envVar: string;
    configured: boolean;
    tier: number;
    paid: boolean;
    toolCallingReliable: boolean;
  }>;
  freeSlots: number;
  freeSlotsConfigured: number;
  emptyFreeSlots: string[];
} {
  const providers = PROVIDERS.map((provider, index) => ({
    name: provider.name,
    envVar: provider.apiKeyEnvs.join(' or '),
    configured: providerConfigured(provider),
    tier: index,
    paid: provider.paid === true,
    toolCallingReliable: true,
  }));

  return {
    providers,
    freeSlots: providers.length,
    freeSlotsConfigured: providers.filter((provider) => provider.configured).length,
    emptyFreeSlots: providers
      .filter((provider) => !provider.configured)
      .map((provider) => provider.envVar),
  };
}

export function logProviderRoster(): void {
  const roster = getProviderRoster();
  const policy = getActiveOpenRouterModelPolicy();
  const custom = Boolean(policy);
  const modelOrder = getOpenRouterModelChainForRole();
  console.log(
    `[LLM] OpenRouter roster: ${roster.freeSlotsConfigured}/${roster.freeSlots} credential slots ready; ` +
      `policy=${custom ? `operator-${policy?.routingMode ?? 'manual'}` : 'reviewed-default'}; models=${modelOrder.join(' -> ')}`,
  );
  if (roster.emptyFreeSlots.length) {
    console.warn(
      `[LLM] Provider configuration missing: ${roster.emptyFreeSlots.join(', ')}`,
    );
  }
}

export function getProviderCatalog(): Array<{
  name: string;
  model: string;
  tier: number;
  paid: boolean;
  toolCallingReliable: boolean;
}> {
  return PROVIDER_ORDER.map((name, index) => {
    const provider = PROVIDER_BY_NAME.get(name)!;
    return {
      name: provider.name,
      model: provider.model,
      tier: index,
      paid: provider.paid === true,
      toolCallingReliable: true,
    };
  });
}

export function getKnownApiKeyEnvs(): string[] {
  return [
    ...new Set(PROVIDERS.flatMap((provider) => provider.apiKeyEnvs)),
    'YELP_API_KEY',
    'GOOGLE_PLACES_API_KEY',
    'TAVILY_API_KEY',
    'BRAVE_SEARCH_API_KEY',
    'VAPI_API_KEY',
    'VAPI_PHONE_NUMBER_ID',
    'CASEBUDDY_SUPABASE_URL',
    'CASEBUDDY_SUPABASE_SERVICE_KEY',
    'CASEBUDDY_SYSTEM_USER_ID',
    'STRIPE_SECRET_KEY',
    'APEX_APPROVAL_MODE',
  ];
}

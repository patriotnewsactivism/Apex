import type { LLMClientConfig, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './types.js';
import {
  isProviderOverDailyCap,
  isTotalDailyCapReached,
  msUntilDailyReset,
  recordTokenUsage,
} from './token-ledger.js';

// ─── APEX Free-First Intelligence Stack ──────────────────────────────────────
//
// Policy (2026-08-23): all APEX units use the same economics-first route.
//
//   1. Gemini 3.7 Flash      — FREE-TIER credential only
//   2. Cohere Command A+     — API usage free until Cohere's free rate limit
//   3. Poolside Laguna S 2.1 — limited-time free access; explicit confirmation
//   4. Qwen 3.7 Max          — only when Alibaba "Free quota only" is confirmed
//   5. Kilo Auto Free        — Kilo's free model router
//   6. Mistral Medium 3.5    — PAID emergency fallback, disabled by default
//
// Mistral is deliberately last. A high rate limit is not free capacity.
// No provider capable of metered Mistral usage is called unless
// APEX_PAID_LLM_MODE is explicitly enabled.
//
// Gemini uses dedicated GEMINI_FREE_API_KEY variables rather than the generic
// GEMINI_API_KEY names so a paid Google project cannot be consumed by accident.

export type ApexProviderName =
  | 'google-gemini'
  | 'cohere'
  | 'poolside'
  | 'qwen'
  | 'kilo'
  | 'mistral';

type ProviderSpec = {
  name: ApexProviderName;
  model: string;
  baseURL: string | (() => string | undefined);
  apiKeyEnvs: readonly string[];
  paid?: boolean;
  activationEnv?: string;
  activationDescription?: string;
  toolCallingReliable: true;
};

const PROVIDERS: readonly ProviderSpec[] = [
  {
    name: 'google-gemini',
    model: 'gemini-3.7-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnvs: ['GEMINI_FREE_API_KEY', 'GEMINI_FREE_API_KEY_2'],
    toolCallingReliable: true,
  },
  {
    name: 'cohere',
    model: 'command-a-plus-05-2026',
    baseURL: 'https://api.cohere.ai/compatibility/v1',
    apiKeyEnvs: ['COHERE_API_KEY'],
    toolCallingReliable: true,
  },
  {
    name: 'poolside',
    model: 'poolside/laguna-s-2.1',
    baseURL: 'https://inference.poolside.ai/v1',
    apiKeyEnvs: ['POOLSIDE_API_KEY'],
    activationEnv: 'POOLSIDE_FREE_ACCESS_CONFIRMED',
    activationDescription:
      'set POOLSIDE_FREE_ACCESS_CONFIRMED=true only while this account is on Poolside free access',
    toolCallingReliable: true,
  },
  {
    name: 'qwen',
    model: 'qwen3.7-max',
    baseURL: () =>
      process.env.QWEN_BASE_URL?.replace(/\/$/, '') ||
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvs: ['QWEN_API_KEY'],
    activationEnv: 'QWEN_FREE_QUOTA_ONLY',
    activationDescription:
      'enable Alibaba Model Studio Free quota only, then set QWEN_FREE_QUOTA_ONLY=true',
    toolCallingReliable: true,
  },
  {
    name: 'kilo',
    model: 'kilo-auto/free',
    baseURL: 'https://api.kilo.ai/api/gateway',
    apiKeyEnvs: ['KILO_API_KEY'],
    toolCallingReliable: true,
  },
  {
    name: 'mistral',
    model: 'mistral-medium-3-5',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnvs: ['MISTRAL_API_KEY'],
    paid: true,
    toolCallingReliable: true,
  },
] as const;

const PROVIDER_BY_NAME = new Map<ApexProviderName, ProviderSpec>(
  PROVIDERS.map((provider) => [provider.name, provider]),
);

const PROVIDER_ORDER: readonly ApexProviderName[] = [
  'google-gemini',
  'cohere',
  'poolside',
  'qwen',
  'kilo',
  'mistral',
];

export function getProviderOrderForRole(_role?: string): ApexProviderName[] {
  return [...PROVIDER_ORDER];
}

/** Paid inference is fail-closed. Mistral cannot run unless this is explicit. */
export function paidLLMFallbackEnabled(mode?: string): boolean {
  const normalized = (mode ?? 'off').trim().toLowerCase();
  return ['1', 'true', 'on', 'enabled', 'fallback'].includes(normalized);
}

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'enabled', 'yes', 'confirmed'].includes(
    (value ?? '').trim().toLowerCase(),
  );
}

// ─── Request-size control ─────────────────────────────────────────────────────

export const DEFAULT_HISTORY_CHAR_BUDGET = 60_000;
export const EMERGENCY_HISTORY_CHAR_BUDGET = 24_000;

export function historySize(messages: LLMMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      (message.content?.length ?? 0) +
      (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0),
    0,
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
    if (message.role === 'tool') trimContent(message, 1_200);
  }

  let firstUserSeen = false;
  for (const message of out) {
    if (historySize(out) <= maxChars) break;
    if (message.role === 'system') continue;
    if (message.role === 'user' && !firstUserSeen) {
      firstUserSeen = true;
      continue;
    }
    trimContent(message, 2_000);
  }

  if (historySize(out) > maxChars && out[0]?.role === 'system') {
    trimContent(out[0], 8_000);
  }

  for (const message of out) {
    if (historySize(out) <= maxChars) break;
    trimContent(message, 600);
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
const degradedToolCallEvents: Array<{ provider: string; model: string; at: number }> = [];
const credentialCooldowns = new Map<string, number>();

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

function credentialInCooldown(id: string): boolean {
  const until = credentialCooldowns.get(id);
  if (!until) return false;
  if (Date.now() >= until) {
    credentialCooldowns.delete(id);
    return false;
  }
  return true;
}

function setCredentialCooldown(id: string, status: number | undefined, message: string): void {
  credentialCooldowns.set(id, Date.now() + cooldownMs(status, message));
}

function clearCredentialCooldown(id: string): void {
  credentialCooldowns.delete(id);
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

const configuredLLMConcurrency = Number(process.env.APEX_MAX_CONCURRENT_LLM_CALLS ?? 3);
const MAX_CONCURRENT_LLM_CALLS = Number.isFinite(configuredLLMConcurrency)
  ? Math.min(16, Math.max(1, Math.floor(configuredLLMConcurrency)))
  : 3;

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

type CompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string | number };
};

async function callCompatibleProvider(
  provider: ProviderSpec,
  key: string,
  messages: LLMMessage[],
  tools: LLMTool[] | undefined,
  config: LLMClientConfig,
): Promise<LLMResponse> {
  const baseURL = providerBaseURL(provider);
  if (!baseURL) {
    throw Object.assign(new Error('provider base URL is not configured'), { status: 0 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);

  try {
    const body: Record<string, unknown> = {
      model: provider.model,
      messages: toWireMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 2048,
    };

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

    if (!response.ok) {
      const detail =
        parsed.error?.message ||
        text.slice(0, 500) ||
        `HTTP ${response.status}`;
      throw Object.assign(new Error(detail), { status: response.status });
    }

    const choice = parsed.choices?.[0]?.message;
    if (!choice) throw new Error('provider returned no completion choice');

    return {
      content: choice.content ?? '',
      toolCalls: parseToolCalls(choice.tool_calls),
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
      },
      model: `${provider.name}/${provider.model}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

class MultiProviderClient {
  private config: LLMClientConfig;

  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  async complete(messages: LLMMessage[], tools?: LLMTool[]): Promise<LLMResponse> {
    await acquireLLMConcurrencySlot();

    try {
      if (isTotalDailyCapReached()) {
        throw new Error(
          'APEX daily token cap reached (APEX_TOKEN_CAP_TOTAL). LLM spend is paused until the UTC daily reset.',
        );
      }

      const trimmed = trimMessageHistory(messages);
      const providerErrors: string[] = [];
      const skipReasons: string[] = [];

      for (const providerName of getProviderOrderForRole(this.config.role)) {
        const provider = PROVIDER_BY_NAME.get(providerName);
        if (!provider) continue;

        const activationIssue = providerActivationIssue(provider);
        if (activationIssue) {
          skipReasons.push(`${provider.name}: ${activationIssue}`);
          continue;
        }

        if (isProviderOverDailyCap(provider.name)) {
          skipReasons.push(`${provider.name}: APEX per-provider daily cap reached`);
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

        let providerAttempted = false;

        for (const credential of credentials) {
          const credentialId = `${provider.name}:${credential.env}`;
          if (credentialInCooldown(credentialId)) {
            skipReasons.push(`${credentialId}: credential in cooldown`);
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
            );
            clearCredentialCooldown(credentialId);
            recordTokenUsage(provider.name, result.usage);
            return result;
          } catch (error) {
            const err = error as Error & { status?: number };
            const status = err.status;
            const message = err.name === 'AbortError' ? 'request timed out' : err.message;
            recordProviderFailure(provider.name, provider.model, status, message);
            setCredentialCooldown(credentialId, status, message);
            providerErrors.push(
              `${provider.name}/${provider.model} via ${credential.env}: ` +
                `${status ? `HTTP ${status} ` : ''}${message}`,
            );

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
                );
                clearCredentialCooldown(credentialId);
                recordTokenUsage(provider.name, result.usage);
                return result;
              } catch {
                // Continue to the next free credential/provider.
              }
            }
          }
        }

        if (!providerAttempted && providerRequirements(provider).length > 0) {
          skipReasons.push(`${provider.name}: ${providerRequirements(provider).join(', ')}`);
        }
      }

      const details = [...providerErrors, ...skipReasons];
      throw new Error(
        `All LLM providers failed or were unavailable. ${
          details.length ? details.join(' | ') : 'No usable provider credential was configured.'
        }`,
      );
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
    CEO: 4096,
    CTO: 4096,
    COO: 4096,
    LEAD_DEV: 4096,
    RESEARCH: 4096,
    LEAD_RESEARCH: 4096,
    SALES: 4096,
    QA_DIRECTOR: 4096,
    FRONTEND: 2048,
    BACKEND: 2048,
    DEVOPS: 2048,
    QA: 2048,
    MARKETING: 2048,
    CUSTOMER_SUCCESS: 2048,
    DOCS: 2048,
    OPS: 2048,
    COMMUNITY_WATCH: 1024,
  };

  const defaultMaxTokens = tokenBudgets[role] ?? 2048;
  const configuredMaxTokens = Number(
    process.env[`APEX_MAX_OUTPUT_TOKENS_${role}`] ??
      process.env.APEX_MAX_OUTPUT_TOKENS ??
      defaultMaxTokens,
  );
  const maxTokens = Number.isFinite(configuredMaxTokens)
    ? Math.min(16_384, Math.max(256, Math.floor(configuredMaxTokens)))
    : defaultMaxTokens;

  return {
    provider: 'google-gemini',
    model: 'gemini-3.7-flash',
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

async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline } = await import('@xenova/transformers');
    localPipeline = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
    );
  }
  return localPipeline;
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

  const free = providers.filter((provider) => !provider.paid);

  return {
    providers,
    freeSlots: free.length,
    freeSlotsConfigured: free.filter((provider) => provider.configured).length,
    emptyFreeSlots: free
      .filter((provider) => !provider.configured)
      .map((provider) => provider.envVar),
  };
}

export function logProviderRoster(): void {
  const roster = getProviderRoster();
  console.log(
    `[LLM] Free-first roster: ${roster.freeSlotsConfigured}/${roster.freeSlots} free slots ready; ` +
      `order=${PROVIDER_ORDER.join(' -> ')}`,
  );

  if (roster.emptyFreeSlots.length) {
    console.warn(
      `[LLM] Free provider configuration missing/disabled: ${roster.emptyFreeSlots.join(', ')}`,
    );
  }

  if (!paidLLMFallbackEnabled(process.env.APEX_PAID_LLM_MODE)) {
    console.log('[LLM] Paid Mistral emergency fallback is OFF (fail-closed).');
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

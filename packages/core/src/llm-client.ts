import type { LLMClientConfig, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './types.js';
import {
  isProviderOverDailyCap,
  isTotalDailyCapReached,
  msUntilDailyReset,
  providerTokensToday,
  recordTokenUsage,
  totalTokensToday,
} from './token-ledger.js';

// ─── APEX Five-Provider Intelligence Stack ───────────────────────────────────
//
// Policy (2026-08-23): EXACTLY five inference providers are allowed here.
// There is intentionally no hidden sixth rung, dynamic OpenRouter fallback,
// legacy recovery provider, or provider-specific side door.
//
// Worker/specialist route:
//   Mistral Medium 3.5 -> Gemini 3.7 Flash -> Cohere Command A+ ->
//   Qwen 3.7 Max -> Kilo Auto Frontier
//
// Manager/executive route (oversight/delegation):
//   Gemini 3.7 Flash -> Mistral Medium 3.5 -> Cohere Command A+ ->
//   Qwen 3.7 Max -> Kilo Auto Frontier
//
// Models are pinned here rather than accepted from stale APEX_MODEL env vars.
// A model/provider change is therefore a reviewed code change instead of a
// deployment variable silently reintroducing a removed provider.

export type ApexProviderName =
  | 'mistral'
  | 'google-gemini'
  | 'cohere'
  | 'qwen'
  | 'kilo';

type ProviderSpec = {
  name: ApexProviderName;
  model: string;
  baseURL: string | (() => string | undefined);
  apiKeyEnvs: readonly string[];
  requiresEnv?: readonly string[];
  toolCallingReliable: true;
};

const PROVIDERS: readonly ProviderSpec[] = [
  {
    name: 'mistral',
    model: 'mistral-medium-3-5',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnvs: ['MISTRAL_API_KEY'],
    toolCallingReliable: true,
  },
  {
    name: 'google-gemini',
    model: 'gemini-3.7-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Multiple project keys are treated as one logical Gemini rung. A 429 on
    // one credential does not skip Gemini until every configured key is tried.
    apiKeyEnvs: ['GEMINI_API_KEY', 'GEMINI_API_KEY_2'],
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
    name: 'qwen',
    model: 'qwen3.7-max',
    // Alibaba Model Studio compatible-mode base URLs are workspace/region
    // specific. Require the exact deployment URL instead of guessing a region.
    baseURL: () => process.env.QWEN_BASE_URL?.replace(/\/$/, ''),
    apiKeyEnvs: ['QWEN_API_KEY'],
    requiresEnv: ['QWEN_BASE_URL'],
    toolCallingReliable: true,
  },
  {
    name: 'kilo',
    model: 'kilo-auto/frontier',
    baseURL: 'https://api.kilo.ai/api/gateway',
    apiKeyEnvs: ['KILO_API_KEY'],
    toolCallingReliable: true,
  },
] as const;

const PROVIDER_BY_NAME = new Map<ApexProviderName, ProviderSpec>(
  PROVIDERS.map((provider) => [provider.name, provider]),
);

/** Roles whose primary job is organization-wide oversight, delegation,
 * architecture, work allocation, or independent quality governance. */
const MANAGER_EXECUTIVE_ROLES = new Set([
  'CEO',
  'CTO',
  'COO',
  'LEAD_DEV',
  'LEAD_RESEARCH',
  'QA_DIRECTOR',
]);

const WORKER_ORDER: readonly ApexProviderName[] = [
  'mistral',
  'google-gemini',
  'cohere',
  'qwen',
  'kilo',
];

const MANAGER_ORDER: readonly ApexProviderName[] = [
  'google-gemini',
  'mistral',
  'cohere',
  'qwen',
  'kilo',
];

export function getProviderOrderForRole(role?: string): ApexProviderName[] {
  return [...(role && MANAGER_EXECUTIVE_ROLES.has(role) ? MANAGER_ORDER : WORKER_ORDER)];
}

// Kept for source compatibility with older verification code. Paid routing is
// no longer a separate opt-in tier: this five-provider allowlist is the whole
// routing universe, and token/spend controls live in token-ledger.ts.
export function paidLLMFallbackEnabled(mode?: string): boolean {
  const normalized = (mode ?? 'off').trim().toLowerCase();
  return ['1', 'true', 'on', 'enabled', 'fallback'].includes(normalized);
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

/**
 * Trim content without dropping messages. Keeping the message skeleton avoids
 * orphaning assistant tool_calls from their corresponding tool results, which
 * OpenAI-compatible APIs reject as malformed conversations.
 */
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

  // Old tool output is usually the largest and least valuable context.
  for (const message of out) {
    if (historySize(out) <= maxChars) break;
    if (message.role === 'tool') trimContent(message, 1_200);
  }

  // Preserve the first system + first user task as long as possible, trimming
  // older conversational prose before those anchors.
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
const DAILY_QUOTA_PATTERN = /\b(per[\s-]?day|daily|tokens per day|tpd|quota exhausted|daily limit)\b/i;

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
  if (status === 401 || status === 403) return COOLDOWN_AUTH_MS;
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

function providerRequirements(provider: ProviderSpec): string[] {
  const missing = new Set<string>();
  if (!provider.apiKeyEnvs.some((name) => Boolean(process.env[name]))) {
    missing.add(provider.apiKeyEnvs.join(' or '));
  }
  for (const name of provider.requiresEnv ?? []) {
    if (!process.env[name]) missing.add(name);
  }
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
  if (!baseURL) throw Object.assign(new Error('provider base URL is not configured'), { status: 0 });

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
      const detail = parsed.error?.message || text.slice(0, 800) || response.statusText;
      throw Object.assign(new Error(detail), { status: response.status });
    }

    const choice = parsed.choices?.[0]?.message;
    if (!choice) {
      throw Object.assign(new Error('provider returned no completion choice'), { status: response.status });
    }

    const toolCalls = parseToolCalls(choice.tool_calls);
    const usage = {
      promptTokens: Number(parsed.usage?.prompt_tokens ?? 0),
      completionTokens: Number(parsed.usage?.completion_tokens ?? 0),
    };

    return {
      content: choice.content ?? '',
      toolCalls,
      usage,
      model: `${provider.name}/${provider.model}`,
      degraded: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────

class MultiProviderClient {
  constructor(private readonly config: LLMClientConfig) {}

  async complete(messages: LLMMessage[], tools?: LLMTool[]): Promise<LLMResponse> {
    await acquireLLMConcurrencySlot();
    try {
      if (isTotalDailyCapReached()) {
        throw new Error(
          `APEX daily token cap reached (${totalTokensToday()} tokens today). ` +
            `APEX_TOKEN_CAP_TOTAL has paused LLM spend until the UTC daily reset.`,
        );
      }

      const initialTrim = trimMessageHistory(messages, DEFAULT_HISTORY_CHAR_BUDGET);
      const providerErrors: string[] = [];
      const skipReasons: string[] = [];
      const order = getProviderOrderForRole(this.config.role);

      for (const providerName of order) {
        const provider = PROVIDER_BY_NAME.get(providerName)!;

        const missing = providerRequirements(provider);
        if (missing.length) {
          skipReasons.push(`${provider.name}: missing ${missing.join(', ')}`);
          continue;
        }

        if (isProviderOverDailyCap(provider.name)) {
          skipReasons.push(
            `${provider.name}: APEX_TOKEN_CAPS daily cap reached (${providerTokensToday(provider.name)} tokens)`,
          );
          continue;
        }

        const credentials = configuredCredentials(provider);
        let providerAttempted = false;

        for (const credential of credentials) {
          const credentialId = `${provider.name}:${credential.env}`;
          if (credentialInCooldown(credentialId)) {
            skipReasons.push(`${provider.name}/${credential.env}: credential cooling down`);
            continue;
          }
          providerAttempted = true;

          let requestMessages = initialTrim.messages;
          let retriedForSize = false;

          while (true) {
            try {
              const result = await callCompatibleProvider(
                provider,
                credential.key,
                requestMessages,
                tools,
                this.config,
              );
              clearCredentialCooldown(credentialId);
              recordTokenUsage(provider.name, result.usage);
              return result;
            } catch (error) {
              const status = Number((error as any)?.status) || undefined;
              const message = error instanceof Error ? error.message : String(error);

              if (
                !retriedForSize &&
                isRequestTooLargeError(status, message) &&
                historySize(requestMessages) > EMERGENCY_HISTORY_CHAR_BUDGET
              ) {
                retriedForSize = true;
                requestMessages = trimMessageHistory(
                  requestMessages,
                  EMERGENCY_HISTORY_CHAR_BUDGET,
                ).messages;
                continue;
              }

              recordProviderFailure(provider.name, provider.model, status, message);
              setCredentialCooldown(credentialId, status, message);
              providerErrors.push(
                `${provider.name}/${provider.model} (${credential.env})` +
                  `${status ? ` HTTP ${status}` : ''}: ${message}`,
              );
              break;
            }
          }
        }

        if (!providerAttempted && credentials.length > 0) {
          skipReasons.push(`${provider.name}: every configured credential is cooling down`);
        }
      }

      const attempted = providerErrors.length ? providerErrors.join('\n- ') : '(none)';
      const skipped = skipReasons.length ? skipReasons.join('\n- ') : '(none)';
      throw new Error(
        `All LLM providers failed. Only the five approved providers are eligible.\n` +
          `Attempted:\n- ${attempted}\n` +
          `Skipped:\n- ${skipped}`,
      );
    } finally {
      releaseLLMConcurrencySlot();
    }
  }
}

// ─── Factory + role defaults ─────────────────────────────────────────────────

export function createLLMClient(config: LLMClientConfig): MultiProviderClient {
  return new MultiProviderClient(config);
}

export type LLMClient = MultiProviderClient;

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

  const primaryName = getProviderOrderForRole(role)[0];
  const primary = PROVIDER_BY_NAME.get(primaryName)!;
  return {
    provider: primary.name,
    model: primary.model,
    temperature: 0.7,
    maxTokens,
    role,
  };
}

// ─── Diagnostics API ─────────────────────────────────────────────────────────

export function getProviderFailureReport(windowMs = 3_600_000): Array<{
  provider: string;
  model: string;
  status?: string | number;
  message: string;
  count: number;
  lastAt: string;
}> {
  const cutoff = Date.now() - windowMs;
  const byProvider = new Map<string, { event: ProviderFailureEvent; count: number }>();
  for (const event of providerFailureEvents) {
    if (event.at < cutoff) continue;
    const previous = byProvider.get(event.provider);
    byProvider.set(event.provider, { event, count: (previous?.count ?? 0) + 1 });
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

function isProviderConfigured(provider: ProviderSpec): boolean {
  return providerRequirements(provider).length === 0;
}

export function getConfiguredProviders(): Array<{ name: string; configured: boolean }> {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    configured: isProviderConfigured(provider),
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
  totalSlots: number;
  configuredSlots: number;
  missingRequirements: string[];
  /** Backward-compatible aliases consumed by existing health/diagnostic UI. */
  freeSlots: number;
  freeSlotsConfigured: number;
  emptyFreeSlots: string[];
} {
  const providers = PROVIDERS.map((provider, index) => ({
    name: provider.name,
    envVar: provider.apiKeyEnvs.join(' or '),
    configured: isProviderConfigured(provider),
    tier: index,
    paid: true,
    toolCallingReliable: true,
  }));
  const missingRequirements = [
    ...new Set(PROVIDERS.flatMap((provider) => providerRequirements(provider))),
  ];
  const configuredSlots = providers.filter((provider) => provider.configured).length;
  return {
    providers,
    totalSlots: providers.length,
    configuredSlots,
    missingRequirements,
    freeSlots: providers.length,
    freeSlotsConfigured: configuredSlots,
    emptyFreeSlots: missingRequirements,
  };
}

export function logProviderRoster(): void {
  const roster = getProviderRoster();
  const configuredNames = roster.providers
    .filter((provider) => provider.configured)
    .map((provider) => provider.name);
  console.log(
    `[LLM] Approved provider roster: ${roster.configuredSlots}/${roster.totalSlots} configured ` +
      `(${configuredNames.join(', ') || 'none'})`,
  );
  if (roster.missingRequirements.length) {
    console.warn(
      `[LLM] Missing configuration for approved provider stack: ${roster.missingRequirements.join(', ')}`,
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
  return PROVIDERS.map((provider, index) => ({
    name: provider.name,
    model: provider.model,
    tier: index,
    paid: true,
    toolCallingReliable: true,
  }));
}

/** Settings API allowlist. LLM inference configuration contains only the five
 * approved providers; the remaining entries are non-LLM business/tool keys. */
export function getKnownApiKeyEnvs(): string[] {
  return [
    'MISTRAL_API_KEY',
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_2',
    'COHERE_API_KEY',
    'QWEN_API_KEY',
    'QWEN_BASE_URL',
    'KILO_API_KEY',
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

// ─── Embeddings ───────────────────────────────────────────────────────────────
// Keep embeddings inside the same allowlist: use Mistral when configured and
// fall back to the local MiniLM pipeline. No OpenAI/OpenRouter embedding path.

let localPipeline: any = null;

async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline } = await import('@xenova/transformers');
    localPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return localPipeline;
}

async function createLocalEmbedding(text: string): Promise<number[]> {
  const extractor = await getLocalPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data) as number[];
}

export async function createEmbedding(text: string): Promise<number[]> {
  const mistralKey = process.env.MISTRAL_API_KEY;
  if (mistralKey) {
    try {
      const response = await fetch('https://api.mistral.ai/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mistralKey}`,
        },
        body: JSON.stringify({
          model: 'mistral-embed',
          input: [text.replace(/\n/g, ' ')],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const parsed = (await response.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };
        const embedding = parsed.data?.[0]?.embedding;
        if (Array.isArray(embedding)) return embedding;
      }
    } catch {
      // Local fallback below.
    }
  }
  return createLocalEmbedding(text);
}

import { recordTurnEconomy } from './turn-economy.js';
import type {
  LLMClientConfig,
  LLMExecutionContext,
  LLMMessage,
  LLMResponse,
  LLMRouterMetadata,
  LLMTool,
  LLMToolCall,
} from './types.js';
import { callGeminiInteractions } from './gemini-interactions.js';
import {
  getTokenLedgerSnapshot,
  isTotalDailyCapReached,
  msUntilDailyReset,
  recordTokenUsage,
  reserveProviderTokenCapacity,
  reserveTotalTokenCapacity,
  type TokenCapacityReservation,
} from './token-ledger.js';
import {
  accountCapacityWindow,
  accountFingerprint,
  accountRequestsToday,
  directProviderCapacityWindow,
  emergencyRequestCapacityWindow,
  markDirectProviderRequestSucceeded,
  markPaidProviderRequestSucceeded,
  markProviderRequestSucceeded,
  paidProviderCapacityWindow,
  requestCapacityWindow,
  reserveDirectProviderRequest,
  reservePaidProviderRequest,
  reserveProviderRequest,
  type DirectRequestPool,
} from './request-ledger.js';
import { recordSpend } from './spend-ledger.js';
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
// ROUTING POLICY (operator decision 2026-09-23, ADR-017). Automatic routing
// tries the operator-funded Qwen3.8 Flash QwenCloud Token Plan route FIRST: the operator
// holds a paid QwenCloud Token Plan and wants it
// used rather than left idle while free capacity serves instead. QwenCloud is
// governed like Groq/Gemini — its own capped/paced request pool, its own
// activation switch — and is explicitly NOT unrestricted like FlashX: every
// APEX workspace/emergency/pacing governor still applies to it. If Qwen is
// unconfigured, disabled, or fails, routing falls through to OpenRouter
// `:free` models (plus the special `openrouter/free` router), then
// independent Groq/Gemini BYOK capacity, with the operator-approved paid GLM
// 5.3 FlashX continuity route last. FlashX alone is always eligible when its
// funded OpenRouter credential exists and bypasses APEX token/request/spend
// governors; upstream provider limits, billing, error cooldowns, tool
// authorization, and human approval policy remain for every route, Qwen and
// FlashX included.
//
// Authoritative automatic order:
//   0. qwen3.8-flash             (Token Plan, governed, primary when configured)
//   1. nex-agi/nex-n2.5-mini:free
//   2. nex-agi/nex-n2.5-pro:free
//   3. nvidia/nemotron-3-super-120b-a12b:free
//   4. nvidia/nemotron-3.5-lightning:free
//   5. openrouter/free  (tool requirements preserved)
//   6. nvidia/nemotron-3-ultra-550b-a55b:free
//   7. groq-gpt-oss-120b-byok    (BYOK, when enabled)
//   8. gemini-3.8-flash-byok     (BYOK, when enabled)
//   9. z-ai/glm-5.3-flashx       (paid, unrestricted continuity, last)
//
// MiniMax M3 Free is intentionally absent until a new direct API verification
// proves the exact `:free` slug works. Persisted OpenRouter model policies
// remain zero-cost-only; Qwen and FlashX are separate, reviewed runtime
// routes outside that policy.

export type ApexProviderName =
  | 'qwen-qwencloud-token-plan'
  | 'openrouter-nex-n2-5-mini-free'
  | 'openrouter-nex-n2-5-pro-free'
  | 'openrouter-nemotron-super'
  | 'openrouter-nemotron-3-5-lightning-free'
  | 'openrouter-free-router'
  | 'openrouter-nemotron-ultra'
  | 'openrouter-free-policy'
  | 'groq-gpt-oss-120b-byok'
  | 'gemini-3-8-flash-byok'
  | 'openrouter-glm-5-3-flashx-paid';

/** Logical provider used only when a valid persisted FREE policy exists. */
export const FREE_POLICY_GATEWAY_NAME: ApexProviderName = 'openrouter-free-policy';

/**
 * Every OpenRouter credential that may serve a `:free` model.
 *
 * Order here is only a tie-break: configuredCredentials() sorts by
 * requests-already-made-today, so the list is a roster, not a priority.
 *
 * MORE ACCOUNTS IS THE ONLY WAY TO BUY MORE FREE THROUGHPUT. OpenRouter's free
 * allowance is a per-ACCOUNT daily request budget shared across every `:free`
 * model at once. Adding more free MODELS buys nothing against it. Adding a key
 * for another independent account buys a whole extra 1,000/day (qualifying
 * accounts that have previously held at least $10 in credits).
 *
 * Multiple env names may hold keys for the SAME account. The request ledger
 * fingerprints the key itself, so those names collapse into one capacity
 * bucket. Do not treat extra env vars as extra accounts.
 */
export const OPENROUTER_FREE_KEY_ENVS = [
  'OPENROUTER_FREE_API_KEY',
  'OPENROUTER_API_KEY_2',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY_3',
  'OPENROUTER_API_KEY_4',
] as const;

/** The funded inference key confirmed by its matching OpenRouter account usage. */
export const OPENROUTER_PAID_KEY_ENVS = ['OPENROUTER_API_KEY'] as const;
export const PAID_FALLBACK_PROVIDER_NAME: ApexProviderName =
  'openrouter-glm-5-3-flashx-paid';
export const PAID_FALLBACK_MODEL = 'z-ai/glm-5.3-flashx';

type ProviderSpec = {
  name: ApexProviderName;
  model: string;
  baseURL: string | (() => string | undefined);
  apiKeyEnvs: readonly string[];
  paid?: boolean;
  /** Bypass APEX token/request/spend governors for an operator-approved paid
   * continuity route. Upstream provider billing/rate limits and reliability
   * cooldowns still apply. */
  unrestricted?: boolean;
  /** Independent request quota pool. OpenRouter uses the 2,775/day pool;
   * direct BYOK providers have their own counters. */
  requestPool?: 'openrouter' | DirectRequestPool;
  protocol?: 'openai-compatible' | 'gemini-interactions';
  activationEnv?: string;
  activationDescription?: string;
  /** Minimum spacing between request starts for this logical provider. */
  minIntervalMs: number;
  toolCallingReliable: true;
  /**
   * Whether this model accepts `parallel_tool_calls`. Checked against
   * advertised support, not assumed. No current free production model
   * advertises it; sending the field blindly risks a 400 on every call.
   */
  supportsParallelToolCalls?: boolean;
  /** List price, used only to price an unpriced response. Verified against
   *  OpenRouter's live catalog; paid specs only. */
  usdPerMillionPrompt?: number;
  usdPerMillionCompletion?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Provider-side request envelope. Used to size output/history before the
   * network call instead of learning the limit by burning a 413 attempt. */
  maxRequestTokens?: number;
  maxOutputTokens?: number;
  providerRouting?: {
    only?: readonly string[];
    allow_fallbacks?: boolean;
    sort?: 'price' | 'throughput' | 'latency';
    require_parameters?: boolean;
  };
};

function freeOpenRouterSpec(
  name: ApexProviderName,
  model: string,
  extras: Partial<ProviderSpec> = {},
): ProviderSpec {
  return {
    name,
    model,
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnvs: OPENROUTER_FREE_KEY_ENVS,
    requestPool: 'openrouter',
    protocol: 'openai-compatible',
    minIntervalMs: 500,
    toolCallingReliable: true,
    // Preserve the former shared APEX completion ceiling on free routes even
    // though FlashX can now be configured up to its much larger native limit.
    maxOutputTokens: 16_384,
    ...extras,
    // Free endpoints vary widely in latency. Prefer the endpoint most likely
    // to answer inside APEX's bounded timeout while preserving the operator's
    // exact model order and zero-cost roster.
    providerRouting: {
      sort: 'latency',
      ...(extras.providerRouting ?? {}),
    },
  };
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const PROVIDERS: readonly ProviderSpec[] = [
  {
    name: 'qwen-qwencloud-token-plan',
    model: 'qwen3.8-flash',
    // QwenCloud Token Plan OpenAI-compatible endpoint. Token Plan (`sk-sp-...`)
    // credentials are not interchangeable with pay-as-you-go (`sk-...`)
    // credentials/endpoints. The env override remains available for controlled
    // migrations without another code change.
    baseURL: () =>
      process.env.QWEN_BASE_URL?.trim() ||
      process.env.APEX_QWEN_BASE_URL?.trim() ||
      'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1',
    apiKeyEnvs: ['QWEN_API_KEY', 'QWEN_API_KEY_2'],
    // Real money from a purchased token plan, so spend is recorded like any
    // paid route — but deliberately NOT `unrestricted`. This is a governed
    // primary route on its own capped/paced pool, not a FlashX-style bypass
    // of APEX's workspace/emergency/pacing governors.
    paid: true,
    requestPool: 'qwen',
    protocol: 'openai-compatible',
    activationEnv: 'APEX_QWEN_BYOK_ENABLED',
    activationDescription: 'APEX_QWEN_BYOK_ENABLED=true is required',
    // Primary route hit by the whole workforce on every call, not an
    // occasional fallback — keep spacing tight enough that it can't become
    // the bottleneck itself. Override with
    // APEX_LLM_MIN_INTERVAL_MS_QWEN_QWENCLOUD_TOKEN_PLAN if the plan needs more room.
    minIntervalMs: 250,
    toolCallingReliable: true,
    // Not yet confirmed against DashScope's compatible-mode docs that
    // `parallel_tool_calls` is honored server-side. Left unset (so the field
    // is never sent) rather than risk a 400 on every primary-route request;
    // flip on once verified live.
    maxOutputTokens: envPositiveInt('APEX_QWEN_MAX_OUTPUT_TOKENS', 8_192),
    // usdPerMillionPrompt/usdPerMillionCompletion intentionally omitted:
    // secondary sources disagreed on current DashScope pricing for this model
    // (roughly $0.14-0.15/M input, $0.42-0.47/M output as of 2026-09) and
    // could not be confirmed against Alibaba Cloud's own pricing page.
    // QwenCloud's OpenAI-compatible response may not carry a settled
    // `usage.cost` field the way OpenRouter's does. Spend tracking for this
    // route reports $0 until verified per-token pricing is filled in here
    // from the operator's actual Model Studio billing console.
  },
  freeOpenRouterSpec('openrouter-nex-n2-5-mini-free', 'nex-agi/nex-n2.5-mini:free'),
  freeOpenRouterSpec('openrouter-nex-n2-5-pro-free', 'nex-agi/nex-n2.5-pro:free'),
  freeOpenRouterSpec('openrouter-nemotron-super', 'nvidia/nemotron-3-super-120b-a12b:free'),
  freeOpenRouterSpec('openrouter-nemotron-3-5-lightning-free', 'nvidia/nemotron-3.5-lightning:free'),
  freeOpenRouterSpec('openrouter-free-router', 'openrouter/free', {
    providerRouting: { require_parameters: true },
  }),
  // Intentionally last: recent successful availability has been materially worse
  // than the other free candidates.
  freeOpenRouterSpec('openrouter-nemotron-ultra', 'nvidia/nemotron-3-ultra-550b-a55b:free'),
  // Custom persisted FREE policies share this gateway. It is not an automatic
  // route and never uses paid credentials.
  freeOpenRouterSpec(FREE_POLICY_GATEWAY_NAME, DEFAULT_OPENROUTER_MODEL_CHAIN[0]),
  {
    name: 'groq-gpt-oss-120b-byok',
    model: 'openai/gpt-oss-120b',
    baseURL: 'https://api.groq.com/openai/v1',
    // Both configured key slots are eligible. If both keys belong to the same
    // Groq organization they may still share provider-side quota, so APEX keeps
    // one conservative Groq request pool rather than pretending each key adds
    // independent capacity. Key 2 remains preferred by live voice in that path.
    apiKeyEnvs: ['GROQ_API_KEY', 'GROQ_API_KEY_2'],
    requestPool: 'groq',
    protocol: 'openai-compatible',
    activationEnv: 'APEX_GROQ_BYOK_ENABLED',
    activationDescription: 'APEX_GROQ_BYOK_ENABLED=true is required',
    minIntervalMs: 1_000,
    toolCallingReliable: true,
    supportsParallelToolCalls: true,
    // Groq's verified on-demand envelope is 8,000 tokens/minute. Production
    // was sending 8,518-13,888 token requests because leadership roles asked
    // for up to 8,192 output tokens on top of the prompt. Stay below the hard
    // edge and trim history before dispatch instead of spending calls on 413s.
    maxRequestTokens: 7_600,
    maxOutputTokens: 1_536,
  },
  {
    name: 'gemini-3-8-flash-byok',
    model: 'gemini-3.8-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    // Two Settings slots. Google quota is commonly project-scoped, so the
    // direct Gemini pool remains aggregate unless the operator explicitly
    // raises its verified cap.
    apiKeyEnvs: ['GEMINI_API_KEY', 'GEMINI_API_KEY_2'],
    requestPool: 'gemini',
    protocol: 'gemini-interactions',
    activationEnv: 'APEX_GEMINI_BYOK_ENABLED',
    activationDescription: 'APEX_GEMINI_BYOK_ENABLED=true is required',
    minIntervalMs: 1_000,
    toolCallingReliable: true,
    supportsParallelToolCalls: true,
    maxOutputTokens: 16_384,
  },
  {
    name: PAID_FALLBACK_PROVIDER_NAME,
    model: PAID_FALLBACK_MODEL,
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnvs: OPENROUTER_PAID_KEY_ENVS,
    paid: true,
    unrestricted: true,
    requestPool: 'openrouter',
    protocol: 'openai-compatible',
    minIntervalMs: 0,
    toolCallingReliable: true,
    supportsParallelToolCalls: true,
    // FlashX supports up to 131,072 completion tokens. This is an upstream
    // model envelope, not an APEX spend/request throttle.
    maxOutputTokens: 131_072,
    // `sort: 'price'` pinned every request to whichever upstream host was
    // cheapest for this model — confirmed live 2026-09-17 to be a host with a
    // 60s p99 (Inceptron) or 31s p99 (Relace), both past LLM_REQUEST_TIMEOUT_MS.
    // That produced a sustained 100% "request timed out" failure across the
    // whole workforce even though the model itself, and this account's paid
    // balance, were both fine. `sort: 'latency'` optimizes for the thing this
    // route actually needs — answering inside the timeout — not raw price.
    providerRouting: { sort: 'latency' },
    // z-ai/glm-5.3-flashx OpenRouter list price as of 2026-09-20.
    // Actual settled cost from OpenRouter's response remains authoritative.
    usdPerMillionPrompt: 0.37,
    usdPerMillionCompletion: 1.25,
  },
];

const PROVIDER_BY_NAME = new Map<ApexProviderName, ProviderSpec>(
  PROVIDERS.map((provider) => [provider.name, provider]),
);

/**
 * The automatic routing chain. Free-only, fail-closed, exact operator order.
 * Custom persisted policies do not appear here; they use FREE_POLICY_GATEWAY_NAME.
 */
const PROVIDER_ORDER: readonly ApexProviderName[] = [
  // Operator-funded paid BYOK, governed but tried first — see the routing
  // policy comment above and ADR-017. Falls through when unconfigured,
  // disabled, or failing.
  'qwen-qwencloud-token-plan',
  'openrouter-nex-n2-5-mini-free',
  'openrouter-nex-n2-5-pro-free',
  'openrouter-nemotron-super',
  'openrouter-nemotron-3-5-lightning-free',
  'openrouter-free-router',
  'openrouter-nemotron-ultra',
  // Independent BYOK pools extend daily throughput after OpenRouter pacing or
  // quota exhaustion. They are intentionally before the paid fallback.
  'groq-gpt-oss-120b-byok',
  'gemini-3-8-flash-byok',
];

function activeProviderOrder(_role?: string, pacingEnabled?: boolean): readonly ApexProviderName[] {
  const freeOrder: ApexProviderName[] = hasCustomOpenRouterModelPolicy()
    ? [
        'qwen-qwencloud-token-plan',
        FREE_POLICY_GATEWAY_NAME,
        'groq-gpt-oss-120b-byok',
        'gemini-3-8-flash-byok',
      ]
    : [...PROVIDER_ORDER];
  // Paid FlashX continuity is part of the route by default when its credential
  // is configured. APEX imposes no spend ceiling, request cap, or pacing gate
  // on it; upstream OpenRouter/Z.ai limits remain authoritative. The operator
  // can remove the route entirely with APEX_PAID_FALLBACK_ENABLED=false.
  if (paidLLMFallbackEnabled()) freeOrder.push(PAID_FALLBACK_PROVIDER_NAME);
  return freeOrder;
}

export function getProviderOrderForRole(_role?: string, pacingEnabled?: boolean): ApexProviderName[] {
  return [...activeProviderOrder(_role, pacingEnabled)];
}

export function providerUsesFreeCredentials(name: ApexProviderName): boolean {
  const provider = PROVIDER_BY_NAME.get(name);
  return Boolean(
    provider &&
      provider.paid !== true &&
      provider.apiKeyEnvs === OPENROUTER_FREE_KEY_ENVS,
  );
}

/**
 * Whether the paid FlashX continuity route is part of the chain.
 *
 * On by default, which is the reviewed behavior: an unset variable changes
 * nothing. `APEX_PAID_FALLBACK_ENABLED=false` removes the route, and then
 * APEX is free-only — when the free pool and BYOK capacity are spent the
 * workforce parks until the daily reset rather than spending money.
 *
 * This exists because there was no way to stop paid spend at all. The route
 * was unconditionally appended and the helper unconditionally returned true,
 * so the only lever was unsetting OPENROUTER_API_KEY — which is also a member
 * of OPENROUTER_FREE_KEY_ENVS, so it would have removed a free-pool account
 * at the same time. An operator asking to go back to free allotments should
 * not have to give up free capacity to do it.
 *
 * An explicit flag, not a spend cap: a cap needs a settled-cost feed to
 * enforce and fails open when that feed is late. This fails closed.
 */
export function paidLLMFallbackEnabled(_mode?: string): boolean {
  const raw = process.env.APEX_PAID_FALLBACK_ENABLED;
  if (raw === undefined || raw.trim() === '') return true;
  return enabled(raw);
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

function estimatePromptTokens(
  messages: LLMMessage[],
  tools: LLMTool[] | undefined,
): number {
  const messageChars = historySize(messages);
  const toolChars = tools?.length ? JSON.stringify(tools).length : 0;
  return Math.ceil((messageChars + toolChars) / 4);
}

export function prepareProviderRequest(
  providerName: ApexProviderName,
  messages: LLMMessage[],
  tools: LLMTool[] | undefined,
  requestedMaxOutputTokens: number,
): {
  messages: LLMMessage[];
  maxOutputTokens: number;
  estimatedTotalTokens: number;
  trimmed: boolean;
} {
  const provider = PROVIDER_BY_NAME.get(providerName);
  if (!provider) throw new Error(`Unknown APEX provider: ${providerName}`);

  const requestedOutput = Math.max(256, Math.floor(requestedMaxOutputTokens));
  const providerOutput = provider.maxOutputTokens
    ? Math.min(requestedOutput, provider.maxOutputTokens)
    : requestedOutput;
  if (!provider.maxRequestTokens) {
    return {
      messages,
      maxOutputTokens: providerOutput,
      estimatedTotalTokens: estimatePromptTokens(messages, tools) + providerOutput,
      trimmed: false,
    };
  }

  const safetyTokens = 256;
  const toolChars = tools?.length ? JSON.stringify(tools).length : 0;
  const messageCharBudget = Math.max(
    4_000,
    (provider.maxRequestTokens - providerOutput - safetyTokens) * 4 - toolChars,
  );
  const trimmed = trimMessageHistory(messages, messageCharBudget);
  const promptTokens = estimatePromptTokens(trimmed.messages, tools);
  const availableOutput = provider.maxRequestTokens - promptTokens - safetyTokens;
  if (availableOutput < 256) {
    throw new Error(
      `provider request too large after trimming: ${promptTokens} prompt tokens leave ${availableOutput} output tokens`,
    );
  }
  const maxOutputTokens = Math.min(providerOutput, availableOutput);

  return {
    messages: trimmed.messages,
    maxOutputTokens,
    estimatedTotalTokens: promptTokens + maxOutputTokens,
    trimmed: trimmed.trimmed,
  };
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

/** OpenRouter's documented ceiling for the `models` fallback array. Sending
 * more earns "HTTP 400 'models' array must have 3 items or fewer" on every
 * request, whichever credential is used. */
export const OPENROUTER_MAX_FALLBACK_MODELS = 3;

const configuredRequestTimeoutMs = Number(process.env.APEX_LLM_REQUEST_TIMEOUT_MS ?? 30_000);
// Cap raised from 60s → 180s so paid FlashX continuity can answer past slow
// OpenRouter upstream p99 without burning the whole free-chain timeout budget.
export const LLM_REQUEST_TIMEOUT_MS = Number.isFinite(configuredRequestTimeoutMs)
  ? Math.min(180_000, Math.max(10_000, Math.floor(configuredRequestTimeoutMs)))
  : 30_000;

const COOLDOWN_429_MS = 30_000;
/** A request that timed out says nothing about the credential's quota, so it
 * earns only enough of a pause to let a wedged endpoint settle. Charging it the
 * full rate-limit cooldown blacks out every agent on APEX's single OpenRouter
 * credential for 30s over one slow response. */
const COOLDOWN_TIMEOUT_MS = 5_000;
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
  if (status === undefined && /request timed out|aborted/i.test(message)) {
    return COOLDOWN_TIMEOUT_MS;
  }
  return COOLDOWN_429_MS;
}

export function isAccountQuotaFailure(
  status: number | undefined,
  message: string,
): boolean {
  return (
    status === 429 ||
    status === 402 ||
    ((status === 401 || status === 403) &&
      /free.?tier.?only|allocationquota|free quota|quota exhausted/i.test(message))
  );
}

export function isCapacityFailure(
  status: number | undefined,
  message: string,
): boolean {
  return (
    isAccountQuotaFailure(status, message) ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status === undefined &&
      /request timed out|aborted|empty completion content \(finish_reason: error\)|provider returned no completion choice/i.test(
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

export function shouldCooldownCredential(status: number | undefined, message: string): boolean {
  if (status === 400) return false;
  // A timeout/abort is endpoint latency, not evidence that an otherwise valid
  // credential is bad. Do not create a fleet-wide key cooldown from it.
  if (status === undefined && /request timed out|aborted/i.test(message)) return false;
  return true;
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

const accountCooldowns = new Map<string, CredentialCooldown>();

function accountCooldown(apiKey: string): CredentialCooldown | null {
  const fingerprint = accountFingerprint(apiKey);
  const cooldown = accountCooldowns.get(fingerprint);
  if (!cooldown) return null;
  if (Date.now() >= cooldown.until) {
    accountCooldowns.delete(fingerprint);
    return null;
  }
  return cooldown;
}

function setAccountCooldown(
  apiKey: string,
  status: number | undefined,
  message: string,
  retryAfterMs?: number,
): void {
  const duration = Math.max(cooldownMs(status, message), retryAfterMs ?? 0);
  const fingerprint = accountFingerprint(apiKey);
  const existing = accountCooldowns.get(fingerprint);
  const until = Date.now() + duration;
  accountCooldowns.set(fingerprint, {
    until: Math.max(existing?.until ?? 0, until),
    capacityPause: true,
    reason: message.slice(0, 240),
  });
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
  const providerWide = status === 502 || status === 503 || status === 504;
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

/** Cheap, in-memory answer to "could ANY configured provider take a request
 *  right now?".
 *
 *  Exists because the agent loop's capacity pause is a latch: it records a
 *  resume-at timestamp and sleeps until it passes. A per-provider pacing window
 *  can carry a resume-at up to ~24h away (the next UTC rollover), so a single
 *  paced provider could park the entire workforce for the rest of the day even
 *  after capacity actually came back -- an operator raising a cap, a cooldown
 *  expiring, or the ledger rolling over never lowered the latch. This lets the
 *  loop re-check reality instead of trusting a stale timestamp.
 *
 *  Deliberately does NOT reserve anything: it must be safe to call every poll
 *  cycle from all 13 agents. A true answer means "worth attempting", not a
 *  guarantee -- the real reservation still happens inside complete().
 */
function isOpenRouterProvider(provider: ProviderSpec): boolean {
  return (provider.requestPool ?? 'openrouter') === 'openrouter';
}

function requestWindowForProvider(
  provider: ProviderSpec,
  at: number,
  pacingEnabled?: boolean,
) {
  // Direct BYOK pools — including a paid-but-governed one like Qwen — always
  // use their own independent capacity window, checked before the `paid`
  // branch below. Qwen is `paid: true` purely for spend-ledger accounting; it
  // must stay on its own governed pool rather than inherit FlashX's
  // ungoverned window.
  if (
    provider.requestPool === 'groq' ||
    provider.requestPool === 'gemini' ||
    provider.requestPool === 'qwen'
  ) {
    return directProviderCapacityWindow(provider.requestPool, at, pacingEnabled);
  }
  // The unrestricted paid continuity route (FlashX) has a separate dollar
  // budget and pacing policy. Do not make it wait on the free OpenRouter
  // request ramp: that would leave the workforce parked even while /health
  // correctly reports paid fallback as enabled and affordable.
  if (provider.paid) return paidProviderCapacityWindow();
  return requestCapacityWindow(at, pacingEnabled);
}

function reserveProviderAttempt(
  provider: ProviderSpec,
  credentialKey: string,
): void {
  recordTurnEconomy('requests');
  if (
    provider.requestPool === 'groq' ||
    provider.requestPool === 'gemini' ||
    provider.requestPool === 'qwen'
  ) {
    reserveDirectProviderRequest(provider.requestPool, provider.name);
  } else if (provider.paid) {
    reservePaidProviderRequest(provider.name);
  } else {
    reserveProviderRequest(credentialKey);
  }
}

function markProviderAttemptSucceeded(
  provider: ProviderSpec,
  credentialKey: string,
): void {
  if (
    provider.requestPool === 'groq' ||
    provider.requestPool === 'gemini' ||
    provider.requestPool === 'qwen'
  ) {
    markDirectProviderRequestSucceeded(provider.requestPool, provider.name);
  } else if (provider.paid) {
    markPaidProviderRequestSucceeded(provider.name);
  } else {
    markProviderRequestSucceeded(credentialKey);
  }
}

export function llmCapacityAvailableNow(now: number = Date.now()): boolean {
  const totalDailyCapReached = isTotalDailyCapReached();
  const emergencyAllowed = emergencyRequestCapacityWindow(now).allowed;
  const ledger = getTokenLedgerSnapshot();
  const totalTokenPacingAllowed = ledger.pacing.total.allowed;

  const pacingByProvider = new Map(
    ledger.providers.map((entry) => [entry.provider, entry]),
  );

  const activeOrder = activeProviderOrder();
  for (const providerName of activeOrder) {
    const provider = PROVIDER_BY_NAME.get(providerName);
    if (!provider) continue;
    if (!providerConfigured(provider)) continue;
    if (providerActivationIssue(provider)) continue;
    if (!providerBaseURL(provider)) continue;

    // Workspace token and emergency request governors apply to free/BYOK
    // capacity, but never veto an explicitly unrestricted paid continuity route.
    if (
      !provider.unrestricted &&
      (totalDailyCapReached || !emergencyAllowed || !totalTokenPacingAllowed)
    ) {
      continue;
    }

    // Each provider family owns its own request pool. An exhausted OpenRouter
    // allowance must not park Groq/Gemini, and vice versa.
    if (!requestWindowForProvider(provider, now).allowed) continue;

    const usableCredentials = configuredCredentials(provider).filter((credential) => {
      const credentialId = `${provider.name}:${credential.env}`;
      if (credentialCooldown(credentialId)) return false;
      if (!isOpenRouterProvider(provider) || provider.paid) return true;
      return (
        !accountCooldown(credential.key) &&
        accountCapacityWindow(credential.key).allowed
      );
    });
    if (usableCredentials.length === 0) continue;

    const readyAt = providerCooldowns.get(provider.name) ?? 0;
    if (readyAt > now) continue;

    const entry = pacingByProvider.get(provider.name);
    if (
      !provider.unrestricted &&
      entry &&
      (entry.capReached || !entry.pacing.allowed)
    ) continue;

    return true;
  }
  return false;
}

/**
 * Cost of one call at the provider's list price, used only when OpenRouter
 * returns no `cost` for the generation. Recording zero in that case would let
 * an unpriced response spend from the budget for free, which is the one way a
 * dollar cap can be silently defeated.
 */
function estimatedCostUsd(
  provider: ProviderSpec,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): number {
  const prompt = Math.max(0, Number(usage?.promptTokens ?? 0));
  const completion = Math.max(0, Number(usage?.completionTokens ?? 0));
  const inRate = provider.usdPerMillionPrompt ?? 0;
  const outRate = provider.usdPerMillionCompletion ?? 0;
  return (prompt * inRate + completion * outRate) / 1_000_000;
}

function providerBaseURL(provider: ProviderSpec): string | undefined {
  const raw = typeof provider.baseURL === 'function' ? provider.baseURL() : provider.baseURL;
  return raw?.replace(/\/$/, '');
}

function providerActivationIssue(provider: ProviderSpec): string | null {
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

/**
 * Credentials for a provider, LEAST-LOADED FIRST.
 *
 * The order used to be the static apiKeyEnvs order, and the loop below always
 * starts at index 0 — so the first key served every request and the others were
 * reached only when it failed. That is failover, and for a per-account daily
 * quota it is close to the worst possible policy: on 2026-09-12
 * OPENROUTER_FREE_API_KEY took 1,299 of 1,388 requests (94%), was driven past
 * its 1,000/day free limit, and returned 411 rate-limit failures — each of
 * which itself spent another request against that same exhausted account —
 * while the other two accounts sat on 15 and 52. Three accounts worth 3,000
 * requests/day delivered barely more than one account's worth.
 *
 * Sorting by requests-already-made-today turns the same list into load
 * balancing: work spreads evenly, and an account approaching its quota sinks
 * to the back on its own without anyone configuring a limit. Ties keep the
 * declared order, so behaviour is deterministic when the day starts fresh.
 *
 * "Already made today" counts the whole ACCOUNT, not the key — see
 * accountRequestsToday. Levelling keys is a different and wrong policy whenever
 * one account holds two of them: on 2026-09-14 it put 1,016 requests through a
 * 1,000/day account while another finished 263 short of its own.
 */
function configuredCredentials(provider: ProviderSpec): Array<{ env: string; key: string }> {
  const seenAccounts = new Set<string>();
  return provider.apiKeyEnvs
    .map((env, index) => ({ env, key: process.env[env] ?? '', index }))
    .filter((entry) => Boolean(entry.key))
    .sort((a, b) => {
      const load = accountRequestsToday(accountFingerprint(a.key)) -
        accountRequestsToday(accountFingerprint(b.key));
      return load !== 0 ? load : a.index - b.index;
    })
    .filter((entry) => {
      // Multiple env names holding the same key are one account. Retrying the
      // duplicate would burn another request against an already-exhausted
      // bucket and look like independent capacity.
      //
      // Two DIFFERENT keys on one account are deliberately both kept, even
      // though they also share a bucket. The sort above already sinks the pair
      // together once their shared account is the loaded one, so the duplicate
      // is only ever reached deep in a failure cascade — and dropping it would
      // silently cost the account's whole capacity if the surviving key were
      // the revoked one.
      const fingerprint = accountFingerprint(entry.key);
      if (seenAccounts.has(fingerprint)) return false;
      seenAccounts.add(fingerprint);
      return true;
    })
    .map(({ env, key }) => ({ env, key }));
}

// ─── Process-wide call smoothing ─────────────────────────────────────────────

// One slot per current APEX agent by default. The semaphore still bounds
// pathological task storms, but it no longer leaves 7 of the 13 agents waiting
// solely because of an old six-call demo-era throttle.
const configuredLLMConcurrency = Number(process.env.APEX_MAX_CONCURRENT_LLM_CALLS ?? 13);
const MAX_CONCURRENT_LLM_CALLS = Number.isFinite(configuredLLMConcurrency)
  ? Math.min(64, Math.max(1, Math.floor(configuredLLMConcurrency)))
  : 13;

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
    finish_reason?: string;
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
  const timeout = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let routedModels = [provider.model];

  try {
    const policy = isOpenRouterProvider(provider)
      ? getActiveOpenRouterModelPolicy()
      : null;
    const customPolicy = Boolean(policy) && provider.name === FREE_POLICY_GATEWAY_NAME;
    routedModels = customPolicy
      ? getOpenRouterModelChainForRole(config.role)
      : [provider.model];

    if (isOpenRouterProvider(provider) && policy?.routingMode === 'adaptive') {
      routedModels = await getAdaptiveModelOrder({
        role: config.role,
        candidates: routedModels,
        objective: policy.optimizationObjective,
        minimumSamples: policy.minimumSamples,
        pinnedModel: getPinnedOpenRouterModelForRole(config.role),
        targetComplexity: execution?.complexityHint,
      });
    }

    const usesFreeRouter = routedModels.some(
      (modelId) => modelId.trim().toLowerCase() === 'openrouter/free',
    ) || provider.model.trim().toLowerCase() === 'openrouter/free'
      || provider.name === 'openrouter-free-router';
    const wireTools = toWireTools(tools);
    const providerRouting: Record<string, unknown> = {
      ...(provider.providerRouting ?? {}),
    };
    if (usesFreeRouter && wireTools?.length) {
      providerRouting.require_parameters = true;
    }

    const prepared = prepareProviderRequest(
      provider.name,
      messages,
      tools,
      config.maxTokens ?? 2048,
    );
    const body: Record<string, unknown> = {
      messages: toWireMessages(prepared.messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: prepared.maxOutputTokens,
      // OpenRouter-specific usage/provider fields are intentionally omitted
      // for direct OpenAI-compatible BYOK APIs such as Groq.
      ...(isOpenRouterProvider(provider) ? { usage: { include: true } } : {}),
      ...(provider.reasoningEffort
        ? { reasoning: { effort: provider.reasoningEffort } }
        : {}),
      ...(isOpenRouterProvider(provider) && Object.keys(providerRouting).length > 0
        ? { provider: providerRouting }
        : {}),
    };
    if (customPolicy) {
      // OpenRouter rejects the whole request with HTTP 400 when `models` holds
      // more than OPENROUTER_MAX_FALLBACK_MODELS entries, and the Settings
      // model picker does not stop an operator selecting more than that. A
      // sixth selection must degrade to "route the best three", never to a
      // gateway that refuses every call.
      routedModels = routedModels.slice(0, OPENROUTER_MAX_FALLBACK_MODELS);
      body.models = routedModels;
    } else body.model = provider.model;

    if (wireTools?.length) {
      body.tools = wireTools;
      body.tool_choice = 'auto';
      // Without this the request never asks for more than one tool call per
      // reply, so telling the agent to batch its calls (standing rule 3) would
      // be an instruction the wire format quietly refuses to carry. The loop
      // below already executes every call in a response and returns all their
      // results in one message, so batching is capability APEX had and was
      // simply not requesting.
      //
      // This is the single biggest lever on request count: the agent loop
      // spends one request per round trip, so N sequential tool calls cost N
      // requests while the same N batched cost one.
      //
      // Escape hatch because it is sent to every provider: if some model ever
      // rejects the field outright, APEX_PARALLEL_TOOL_CALLS=off restores the
      // previous behaviour without a deploy.
      if (
        provider.supportsParallelToolCalls &&
        !['0', 'false', 'off', 'no'].includes(
          (process.env.APEX_PARALLEL_TOOL_CALLS ?? 'on').trim().toLowerCase(),
        )
      ) {
        body.parallel_tool_calls = true;
      }
    }

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        ...(isOpenRouterProvider(provider)
          ? {
              'HTTP-Referer': 'https://apex.donmatthews.live',
              'X-Title': 'APEX Agent Workforce',
              // Stable opt-in for OpenRouter route audit data.
              'X-OpenRouter-Metadata': 'enabled',
            }
          : {}),
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
    const toolCalls = parseToolCalls(choice.tool_calls);
    const content = choice.content ?? '';
    // Reasoning models can spend the whole max_tokens budget thinking and
    // max_tokens budget thinking and return content: null. That must be
    // treated as a failure so the chain falls through to the next provider —
    // never as a silent empty success. Tool-call-only turns are exempt.
    if (!content.trim() && toolCalls.length === 0) {
      throw new Error(
        `empty completion content (finish_reason: ${
          parsed.choices?.[0]?.finish_reason ?? 'unknown'
        })`,
      );
    }

    return {
      content,
      toolCalls,
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

async function callProvider(
  provider: ProviderSpec,
  key: string,
  messages: LLMMessage[],
  tools: LLMTool[] | undefined,
  config: LLMClientConfig,
  execution?: LLMExecutionContext,
): Promise<LLMResponse> {
  const providerConfig: LLMClientConfig = provider.maxOutputTokens
    ? {
        ...config,
        maxTokens: Math.min(
          config.maxTokens ?? 2048,
          provider.maxOutputTokens,
        ),
      }
    : config;
  const baseURL = providerBaseURL(provider);
  if (!baseURL) {
    throw Object.assign(new Error('provider base URL is not configured'), { status: 0 });
  }
  if (provider.protocol === 'gemini-interactions') {
    return callGeminiInteractions({
      baseURL,
      apiKey: key,
      model: provider.model,
      messages,
      tools,
      config: providerConfig,
      execution,
      timeoutMs: LLM_REQUEST_TIMEOUT_MS,
    });
  }
  return callCompatibleProvider(provider, key, messages, tools, providerConfig, execution);
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
      // Workspace governors still protect free/BYOK traffic. The operator-
      // approved FlashX continuity route is allowed to remain available after
      // those budgets are exhausted.
      const pacingOverride = execution?.interactive ? false : undefined;
      const emergencyWindow = emergencyRequestCapacityWindow(Date.now());

      const trimmed = trimMessageHistory(messages);
      // Workspace/free-route reservation is sized to the restricted providers'
      // existing 16K ceiling. A larger FlashX output setting must not inflate
      // the free/BYOK reservation and accidentally skip those cheaper routes.
      const restrictedOutputEstimate = Math.min(
        this.config.maxTokens ?? 2048,
        16_384,
      );
      const estimatedTokens = estimateLLMRequestTokens(
        trimmed.messages,
        tools,
        restrictedOutputEstimate,
      );
      const totalReservation = reserveTotalTokenCapacity(estimatedTokens);
      const globalCapacityBlocks: CapacityBlock[] = [];
      if (!emergencyWindow.allowed) {
        globalCapacityBlocks.push({
          source: 'free-byok-providers',
          resumeAt: emergencyWindow.resumeAt,
          reason: `emergency request cap reached (${emergencyWindow.usedRequests}/${emergencyWindow.cap})`,
        });
      }
      if (!totalReservation.allowed) {
        globalCapacityBlocks.push(
          capacityBlockFromReservation('workspace', totalReservation),
        );
      }

      try {
        const providerErrors: string[] = [];
        const skipReasons: string[] = [];
        const capacityBlocks: CapacityBlock[] = [...globalCapacityBlocks];
        let nonCapacityFailureSeen = false;

        for (const providerName of getProviderOrderForRole(this.config.role, pacingOverride)) {
          const provider = PROVIDER_BY_NAME.get(providerName);
          if (!provider) continue;

          if (!provider.unrestricted && globalCapacityBlocks.length > 0) {
            skipReasons.push(
              `${provider.name}: workspace/free-provider capacity governor active`,
            );
            continue;
          }

          const providerRequestWindow = requestWindowForProvider(
            provider,
            Date.now(),
            pacingOverride,
          );
          // FlashX can use its full upstream context window. Free/BYOK routes
          // retain APEX history trimming to protect their smaller envelopes and
          // quotas.
          const providerMessages = provider.unrestricted ? messages : trimmed.messages;
          if (!providerRequestWindow.allowed) {
            capacityBlocks.push({
              source: provider.requestPool ?? 'openrouter',
              resumeAt: providerRequestWindow.resumeAt,
              reason:
                providerRequestWindow.reason === 'daily_cap'
                  ? `request cap reached (${providerRequestWindow.usedRequests}/${providerRequestWindow.cap})`
                  : `request pacing active (${providerRequestWindow.usedRequests}/${providerRequestWindow.pacingAllowance} released of ${providerRequestWindow.cap}/day)`,
            });
            skipReasons.push(
              `${provider.name}: ${providerRequestWindow.reason} request budget`,
            );
            continue;
          }

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

          const providerReservation = provider.unrestricted
            ? null
            : reserveProviderTokenCapacity(provider.name, estimatedTokens);
          if (providerReservation && !providerReservation.allowed) {
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

              const accountLock =
                isOpenRouterProvider(provider) && !provider.paid
                  ? accountCooldown(credential.key)
                  : null;
              if (accountLock) {
                skipReasons.push(`${credentialId}: account in cooldown`);
                if (accountLock.capacityPause) {
                  capacityBlocks.push({
                    source: credential.env,
                    resumeAt: new Date(accountLock.until).toISOString(),
                    reason: accountLock.reason,
                  });
                }
                continue;
              }

              // Per-account request budget. Only applies to accounts given an
              // explicit cap in APEX_REQUEST_CAPS; uncapped accounts return
              // `uncapped`/allowed and fall straight through. This is what
              // lets one exhausted OpenRouter account step aside while the
              // other two keep serving, instead of the whole chain stalling
              // on the first key that ran out.
              const accountWindow =
                isOpenRouterProvider(provider) && !provider.paid
                  ? accountCapacityWindow(credential.key)
                  : null;
              if (accountWindow && !accountWindow.allowed) {
                skipReasons.push(
                  `${credentialId}: account request budget ` +
                    `(${accountWindow.usedRequests}/${accountWindow.cap} today, ${accountWindow.reason})`,
                );
                capacityBlocks.push({
                  source: credential.env,
                  resumeAt: accountWindow.resumeAt,
                  reason: `account request ${accountWindow.reason === 'daily_cap' ? 'cap reached' : 'pacing active'}`,
                });
                continue;
              }

              // Re-check immediately before reservation. There is deliberately
              // no await between these checks and reserveProviderAttempt(), so
              // concurrent agent turns cannot all consume the same final slot.
              const emergencyAttemptWindow = provider.unrestricted
                ? null
                : emergencyRequestCapacityWindow(Date.now());
              if (emergencyAttemptWindow && !emergencyAttemptWindow.allowed) {
                capacityBlocks.push({
                  source: 'free-byok-providers',
                  resumeAt: emergencyAttemptWindow.resumeAt,
                  reason: `emergency request cap reached (${emergencyAttemptWindow.usedRequests}/${emergencyAttemptWindow.cap})`,
                });
                break;
              }
              const freshProviderWindow = requestWindowForProvider(
                provider,
                Date.now(),
                pacingOverride,
              );
              if (!freshProviderWindow.allowed) {
                capacityBlocks.push({
                  source: provider.requestPool ?? 'openrouter',
                  resumeAt: freshProviderWindow.resumeAt,
                  reason:
                    freshProviderWindow.reason === 'daily_cap'
                      ? `request cap reached (${freshProviderWindow.usedRequests}/${freshProviderWindow.cap})`
                      : 'request pacing active',
                });
                break;
              }
              const freshAccountWindow =
                isOpenRouterProvider(provider) && !provider.paid
                  ? accountCapacityWindow(credential.key)
                  : null;
              if (freshAccountWindow && !freshAccountWindow.allowed) {
                capacityBlocks.push({
                  source: credential.env,
                  resumeAt: freshAccountWindow.resumeAt,
                  reason: 'account request budget exhausted',
                });
                continue;
              }

              reserveProviderAttempt(provider, credential.key);
              providerAttempted = true;

              try {
                const result = await callProvider(
                  provider,
                  credential.key,
                  providerMessages,
                  tools,
                  this.config,
                  execution,
                );
                markProviderAttemptSucceeded(provider, credential.key);
                if (provider.paid) {
                  // Charge the settled cost. OpenRouter returns it because the
                  // request sets `usage: { include: true }`; when it is absent
                  // fall back to list price rather than recording zero, since a
                  // missing figure must never read as free spend.
                  recordSpend(
                    provider.name,
                    result.costUsd ?? estimatedCostUsd(provider, result.usage),
                  );
                }
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
                // The request was reserved before dispatch, so failures already
                // count against the correct provider pool. Only successful
                // outcomes need a post-response ledger update.
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
                // A 400 indicts the request body, not the key. Parking the
                // credential for it takes every other agent down over a
                // malformed payload they had no part in — which is how one bad
                // model-policy selection became "credential in cooldown"
                // across the whole workforce.
                if (shouldCooldownCredential(status, message)) {
                  setCredentialCooldown(credentialId, status, message, err.retryAfterMs);
                }
                if (
                  isOpenRouterProvider(provider) &&
                  !provider.paid &&
                  isAccountQuotaFailure(status, message)
                ) {
                  setAccountCooldown(credential.key, status, message, err.retryAfterMs);
                }
                setProviderCooldown(provider, status, message, err.retryAfterMs);
                const capacityFailure = isCapacityFailure(status, message);
                const correctableRequestFailure = isRequestTooLargeError(status, message);
                if (!capacityFailure && !correctableRequestFailure) {
                  nonCapacityFailureSeen = true;
                }
                const newCooldown =
                  credentialCooldown(credentialId) ??
                  (isOpenRouterProvider(provider) ? accountCooldown(credential.key) : null);
                if (newCooldown?.capacityPause) {
                  capacityBlocks.push({
                    source: credentialId,
                    resumeAt: new Date(newCooldown.until).toISOString(),
                    reason: message.slice(0, 240),
                  });
                } else if (capacityFailure) {
                  // Timeouts/aborts deliberately do not poison a credential,
                  // but they are still temporary provider capacity failures.
                  // Without a block they fell through as terminal "All LLM
                  // providers failed" errors and consumed every task retry.
                  const waitMs = Math.max(COOLDOWN_TIMEOUT_MS, err.retryAfterMs ?? 0);
                  capacityBlocks.push({
                    source: `${provider.name}/${attemptedModel}`,
                    resumeAt: new Date(Date.now() + waitMs).toISOString(),
                    reason: message.slice(0, 240),
                  });
                }
                providerErrors.push(
                  `${provider.name}/${attemptedModel} via ${credential.env}: ` +
                    `${status ? `HTTP ${status} ` : ''}${message}`,
                );


                // A timeout is an endpoint/model latency failure, not evidence
                // that every credential is bad. Move to the next model instead
                // of burning another full timeout on the same provider.
                if (message === 'request timed out') break;
                // Account 429/402: try the next independent account before
                // abandoning this model. Provider-wide 502/503/504 still
                // advance to the next free route.
                if (capacityFailure && !isAccountQuotaFailure(status, message)) break;

                if (isRequestTooLargeError(status, message)) {
                  try {
                    const allWindow = provider.unrestricted
                      ? null
                      : emergencyRequestCapacityWindow(Date.now());
                    const poolWindow = requestWindowForProvider(
                      provider,
                      Date.now(),
                      pacingOverride,
                    );
                    const retryAccountWindow =
                      isOpenRouterProvider(provider) && !provider.paid
                        ? accountCapacityWindow(credential.key)
                        : null;
                    if (
                      (allWindow && !allWindow.allowed) ||
                      !poolWindow.allowed ||
                      (retryAccountWindow && !retryAccountWindow.allowed)
                    ) {
                      continue;
                    }

                    const emergency = trimMessageHistory(
                      messages,
                      EMERGENCY_HISTORY_CHAR_BUDGET,
                    );
                    reserveProviderAttempt(provider, credential.key);
                    const result = await callProvider(
                      provider,
                      credential.key,
                      emergency.messages,
                      tools,
                      this.config,
                      execution,
                    );
                    markProviderAttemptSucceeded(provider, credential.key);
                    if (provider.paid) {
                      recordSpend(
                        provider.name,
                        result.costUsd ?? estimatedCostUsd(provider, result.usage),
                      );
                    }
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
                    // The retry was already reserved and therefore correctly
                    // counted even when it fails. Continue to the next route.
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
            providerReservation?.release();
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
  // The operator may request up to FlashX's native 131,072-token completion
  // envelope. Each smaller provider clamps the request again at dispatch, so
  // raising this does not force free/BYOK routes beyond their safe ceiling.
  const maxTokens = Number.isFinite(configuredMaxTokens)
    ? Math.min(131_072, Math.max(256, Math.floor(configuredMaxTokens)))
    : defaultMaxTokens;
  // Derived from the live chain rather than restated as a literal. When these
  // were independent, flipping PROVIDER_ORDER to free-only left every agent
  // still advertising the paid model it no longer used — the same class of
  // quiet lie as an agent stuck reporting `error` while working fine.
  //
  // Qwen leads PROVIDER_ORDER and also leads activeProviderOrder()'s
  // custom-policy branch (ADR-017), so it is unconditionally the route
  // actually attempted first — including when an operator OpenRouter model
  // policy is set. Reporting the free-policy gateway as "primary" here would
  // repeat exactly the quiet-lie bug this function exists to avoid.
  const primaryName = PROVIDER_ORDER[0];
  const primary = PROVIDER_BY_NAME.get(primaryName);
  const model = primary?.model ?? DEFAULT_OPENROUTER_MODEL_CHAIN[0];

  return {
    provider: primary?.name ?? 'qwen-qwencloud-token-plan',
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
let pipelineAttempts = 0;
let pipelineRetryAt = 0;
let pipelineLoadPromise: Promise<unknown> | null = null;

/** First load fetches Xenova/all-MiniLM-L6-v2 from Hugging Face, so it depends
 *  on the network. Retry it a few times rather than never again, but cap the
 *  attempts so a genuinely unreachable model cannot become a boot-loop. */
const PIPELINE_MAX_ATTEMPTS = 4;
const PIPELINE_RETRY_COOLDOWN_MS = 10 * 60_000;

/**
 * Everything the thrower knew, because `err.message` alone did not survive
 * contact with production.
 *
 * On 2026-09-15 the musl/glibc mismatch was fixed and this path kept failing
 * with `Local embedding pipeline unavailable:` and nothing after the colon:
 * an Error whose message is the empty string renders as no diagnosis at all.
 * name, code and the cause chain are read separately for that reason, and the
 * constructor name is the last resort when every field is empty.
 */
export function describePipelineFailure(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && !seen.has(current)) {
    seen.add(current);
    const entry: string[] = [];
    if (current instanceof Error) {
      if (current.name && current.name !== 'Error') entry.push(current.name);
      if (current.message) entry.push(current.message);
      const code = (current as { code?: unknown }).code;
      if (code !== undefined) entry.push(`code=${String(code)}`);
      if (entry.length === 0) entry.push(`empty ${current.constructor?.name ?? 'Error'}`);
      parts.push(entry.join(' '));
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    parts.push(typeof current === 'string' ? current : JSON.stringify(current));
    break;
  }

  // Collapsed to ONE line on purpose. sharp's failure message opens with a
  // newline and runs to fifteen lines; Railway splits log entries on newlines,
  // so it arrived as "Local embedding pipeline unavailable:" followed by
  // fourteen separate entries. The cause was there the whole time and still
  // took a raw unfiltered log read to find. One line cannot fragment.
  const joined = parts.length > 0 ? parts.join(' <- caused by: ') : 'no error detail available';
  return joined.replace(/\s+/g, ' ').trim();
}

async function getLocalPipeline() {
  if (localPipeline) return localPipeline;
  // A latched failure used to be permanent: one bad first load and this process
  // served keyword search until it restarted, replaying the same cached string
  // on every lookup. Hold the failure only until the cooldown expires.
  if (pipelineError && (pipelineAttempts >= PIPELINE_MAX_ATTEMPTS || Date.now() < pipelineRetryAt)) {
    throw new Error(pipelineError);
  }
  // Boot starts every agent's loop within ~2s of each other, and a first task
  // often needs a memory recall — so several callers can reach this function
  // before any of them has finished loading the model. Without sharing the
  // in-flight attempt, each ran its own full native-then-WASM-fallback load
  // concurrently: observed in production as two independent "protobuf parsing
  // failed" failures 62ms apart, immediately followed by the process going
  // unresponsive long enough to fail a deploy healthcheck.
  if (pipelineLoadPromise) return pipelineLoadPromise;

  pipelineAttempts += 1;
  pipelineLoadPromise = (async () => {
    try {
      const { pipeline } = await import('@xenova/transformers');
      localPipeline = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
      );
      pipelineError = null;
      return localPipeline;
    } catch (err) {
      pipelineError = `Local embedding pipeline unavailable: ${describePipelineFailure(err)}`;
      pipelineRetryAt = Date.now() + PIPELINE_RETRY_COOLDOWN_MS;
      const exhausted = pipelineAttempts >= PIPELINE_MAX_ATTEMPTS;
      console.warn(
        `[LLM] ${pipelineError} (attempt ${pipelineAttempts}/${PIPELINE_MAX_ATTEMPTS}` +
          `${exhausted ? '; giving up until restart' : `; retrying after ${PIPELINE_RETRY_COOLDOWN_MS / 60_000}m`})`,
      );
      if (err instanceof Error && err.stack) {
        console.warn(`[LLM] embedding pipeline stack: ${err.stack.split('\n').slice(0, 4).join(' | ')}`);
      }
      throw new Error(pipelineError);
    } finally {
      pipelineLoadPromise = null;
    }
  })();
  return pipelineLoadPromise;
}

/** Embedding-pipeline state for /health, so "is semantic recall actually
 *  working" stops being a question only the logs can answer. */
export function getEmbeddingPipelineState(): {
  ready: boolean;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  retryAt: string | null;
} {
  return {
    ready: localPipeline !== null,
    attempts: pipelineAttempts,
    maxAttempts: PIPELINE_MAX_ATTEMPTS,
    lastError: pipelineError,
    retryAt:
      pipelineError && pipelineAttempts < PIPELINE_MAX_ATTEMPTS
        ? new Date(pipelineRetryAt).toISOString()
        : null,
  };
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
  /** Whether this route is intentionally enabled by operator policy. Disabled
   * routes are informational, not a health defect. */
  enabled: boolean;
}> {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    configured: providerConfigured(provider),
    enabled: providerActivationIssue(provider) === null,
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
  const providers = PROVIDER_ORDER.map((name, index) => {
    const provider = PROVIDER_BY_NAME.get(name)!;
    return {
      name: provider.name,
      envVar: provider.apiKeyEnvs.join(' or '),
      configured: providerConfigured(provider),
      tier: index,
      paid: provider.paid === true,
      toolCallingReliable: true,
    };
  });

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
  supportsParallelToolCalls: boolean;
  usesFreeCredentials: boolean;
  requireParametersWhenToolsPresent: boolean;
  providerRouting?: {
    only?: readonly string[];
    allow_fallbacks?: boolean;
    sort?: 'price' | 'throughput' | 'latency';
    require_parameters?: boolean;
  };
}> {
  return PROVIDER_ORDER.map((name, index) => {
    const provider = PROVIDER_BY_NAME.get(name)!;
    return {
      name: provider.name,
      model: provider.model,
      tier: index,
      paid: provider.paid === true,
      supportsParallelToolCalls: provider.supportsParallelToolCalls === true,
      toolCallingReliable: true,
      usesFreeCredentials: providerUsesFreeCredentials(provider.name),
      requireParametersWhenToolsPresent: provider.model.toLowerCase() === 'openrouter/free',
      ...(provider.providerRouting ? { providerRouting: provider.providerRouting } : {}),
    };
  });
}

export function getKnownApiKeyEnvs(): string[] {
  return [
    ...new Set([
      ...OPENROUTER_FREE_KEY_ENVS,
      ...PROVIDERS.flatMap((provider) => provider.apiKeyEnvs),
    ]),
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_2',
    'GROQ_API_KEY',
    'GROQ_API_KEY_2',
    'YELP_API_KEY',
    'GOOGLE_PLACES_API_KEY',
    'TOMTOM_API_KEY',
    'HUNTER_API_KEY',
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

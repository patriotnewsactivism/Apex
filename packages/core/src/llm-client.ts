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
  isRequestBudgetExhausted,
  recordProviderRequest,
  requestCapacityWindow,
  totalRequestCap,
} from './request-ledger.js';
import {
  dailySpendCapMicros,
  paidSpendAvailable,
  paidSpendCapacityWindow,
  recordSpend,
} from './spend-ledger.js';
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
// FREE-FIRST ROUTING POLICY. Automatic routing uses OpenRouter `:free` models
// (plus the special `openrouter/free` router) while free capacity is available.
// An operator may explicitly activate the reviewed paid continuity route with
// APEX_PAID_FALLBACK=confirmed. It is last in the chain and may also run while
// the free request budget is paced, so the workforce stays productive without
// accidentally making paid inference the primary path.
//
// Authoritative automatic order:
//   1. nex-agi/nex-n2.5-mini:free
//   2. nex-agi/nex-n2.5-pro:free
//   3. nvidia/nemotron-3-super-120b-a12b:free
//   4. nvidia/nemotron-3.5-lightning:free
//   5. openrouter/free  (tool requirements preserved)
//   6. nvidia/nemotron-3-ultra-550b-a55b:free
//
// MiniMax M3 Free is intentionally absent until a new direct API verification
// proves the exact `:free` slug works. Persisted model policies remain
// zero-cost-only; paid continuity is a separate, reviewed runtime route.

export type ApexProviderName =
  | 'openrouter-nex-n2-5-mini-free'
  | 'openrouter-nex-n2-5-pro-free'
  | 'openrouter-nemotron-super'
  | 'openrouter-nemotron-3-5-lightning-free'
  | 'openrouter-free-router'
  | 'openrouter-nemotron-ultra'
  | 'openrouter-free-policy'
  | 'openrouter-deepseek-v4-flash-paid';

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
  'OPENROUTER_API_KEY_4',
] as const;

/** The funded inference key confirmed by its matching OpenRouter account usage. */
export const OPENROUTER_PAID_KEY_ENVS = ['OPENROUTER_API_KEY'] as const;
export const PAID_FALLBACK_PROVIDER_NAME: ApexProviderName =
  'openrouter-deepseek-v4-flash-paid';
export const PAID_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash-0731';

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
    minIntervalMs: 500,
    toolCallingReliable: true,
    ...extras,
  };
}

const PROVIDERS: readonly ProviderSpec[] = [
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
    name: PAID_FALLBACK_PROVIDER_NAME,
    model: PAID_FALLBACK_MODEL,
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnvs: OPENROUTER_PAID_KEY_ENVS,
    paid: true,
    activationEnv: 'APEX_PAID_FALLBACK',
    activationDescription: 'APEX_PAID_FALLBACK=confirmed is required',
    minIntervalMs: 500,
    toolCallingReliable: true,
    supportsParallelToolCalls: true,
    reasoningEffort: 'low',
    // `sort: 'price'` pinned every request to whichever upstream host was
    // cheapest for this model — confirmed live 2026-09-17 to be a host with a
    // 60s p99 (Inceptron) or 31s p99 (Relace), both past LLM_REQUEST_TIMEOUT_MS.
    // That produced a sustained 100% "request timed out" failure across the
    // whole workforce even though the model itself, and this account's paid
    // balance, were both fine. `sort: 'latency'` optimizes for the thing this
    // route actually needs — answering inside the timeout — not raw price.
    providerRouting: { sort: 'latency' },
    // deepseek/deepseek-v4-flash-0731; representative low-latency-tier price
    // (BaseTen/CoreWeave/DigitalOcean). Only a fallback estimate — actual
    // settled cost from OpenRouter's response is used whenever present, and
    // the served host (and its real price) now varies request to request.
    usdPerMillionPrompt: 0.15,
    usdPerMillionCompletion: 0.3,
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
  'openrouter-nex-n2-5-mini-free',
  'openrouter-nex-n2-5-pro-free',
  'openrouter-nemotron-super',
  'openrouter-nemotron-3-5-lightning-free',
  'openrouter-free-router',
  'openrouter-nemotron-ultra',
];

function activeProviderOrder(_role?: string, pacingEnabled?: boolean): readonly ApexProviderName[] {
  const freeOrder: ApexProviderName[] = hasCustomOpenRouterModelPolicy()
    ? [FREE_POLICY_GATEWAY_NAME]
    : [...PROVIDER_ORDER];
  // The paid rung is appended only while it is BOTH enabled and in budget.
  // Dropping it from the order (rather than letting it fail) is what makes an
  // exhausted daily spend a graceful fall back to free models instead of an
  // outage — the operator's "all free if absolutely necessary". `pacingEnabled:
  // false` (an interactive call — see LLMExecutionContext.interactive) checks
  // only the hard daily $ cap here too: this order-building check and the
  // in-loop paidOnly check in complete() must agree on affordability, or an
  // interactive call that skips pacing in one and not the other ends up with
  // an empty provider order and the exact misleading fallthrough this whole
  // capacity-pause mechanism exists to prevent.
  if (paidLLMFallbackEnabled() && paidSpendAvailable(Date.now(), pacingEnabled)) {
    freeOrder.push(PAID_FALLBACK_PROVIDER_NAME);
  }
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

/** Paid inference requires an explicit operator confirmation. */
export function paidLLMFallbackEnabled(
  mode: string | undefined = process.env.APEX_PAID_FALLBACK,
): boolean {
  return enabled(mode);
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

/** OpenRouter's documented ceiling for the `models` fallback array. Sending
 * more earns "HTTP 400 'models' array must have 3 items or fewer" on every
 * request, whichever credential is used. */
export const OPENROUTER_MAX_FALLBACK_MODELS = 3;

const configuredRequestTimeoutMs = Number(process.env.APEX_LLM_REQUEST_TIMEOUT_MS ?? 30_000);
export const LLM_REQUEST_TIMEOUT_MS = Number.isFinite(configuredRequestTimeoutMs)
  ? Math.min(60_000, Math.max(10_000, Math.floor(configuredRequestTimeoutMs)))
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
    (status === undefined && /request timed out|aborted/i.test(message))
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
export function llmCapacityAvailableNow(now: number = Date.now()): boolean {
  // A hard total cap is genuinely workspace-wide; nothing to re-probe.
  if (isTotalDailyCapReached()) return false;

  // A paced/exhausted free request window can still be served by the explicitly
  // enabled paid continuity route. Free providers remain ineligible until the
  // ramp releases capacity; the paid route does not consume the free ledger.
  const freeRequestCapacityAvailable = requestCapacityWindow(now).allowed;

  const ledger = getTokenLedgerSnapshot();
  if (!ledger.pacing.total.allowed) return false;

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
    if (!freeRequestCapacityAvailable && !provider.paid) continue;
    const usableCredentials = configuredCredentials(provider).filter(
      (credential) =>
        provider.paid ||
        (!accountCooldown(credential.key) &&
          accountCapacityWindow(credential.key).allowed),
    );
    if (usableCredentials.length === 0) continue;

    const readyAt = providerCooldowns.get(provider.name) ?? 0;
    if (readyAt > now) continue;

    const entry = pacingByProvider.get(provider.name);
    if (entry && (entry.capReached || !entry.pacing.allowed)) continue;

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
  if (provider.paid && !paidLLMFallbackEnabled()) {
    return provider.activationDescription ?? 'paid inference requires explicit operator confirmation';
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
    const policy = getActiveOpenRouterModelPolicy();
    const customPolicy = Boolean(policy) && provider.name === FREE_POLICY_GATEWAY_NAME;
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

    const body: Record<string, unknown> = {
      messages: toWireMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 2048,
      // Explicitly request usage data so OpenRouter returns billed generation
      // cost alongside token counts when available.
      usage: { include: true },
      ...(provider.reasoningEffort
        ? { reasoning: { effort: provider.reasoningEffort } }
        : {}),
      ...(Object.keys(providerRouting).length > 0 ? { provider: providerRouting } : {}),
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

      // Request budget. Checked BEFORE the token budget's reservation because
      // the two ration different things and the request one is what actually
      // binds on a free-tier account: OpenRouter allows a fixed number of
      // calls per account per UTC day whatever their size, so a workspace can
      // be nowhere near any token cap and still be refused.
      //
      // The `paced` outcome is the one that does the work day to day. It is
      // not an outage — it means the ramp has not released the next request
      // yet, so the agent parks briefly and resumes. That is the mechanism
      // that spreads the allowance across 24h instead of letting the workforce
      // spend it all before lunch.
      let paidOnly = false;
      if (isRequestBudgetExhausted()) {
        if (paidLLMFallbackEnabled()) paidOnly = true;
        else {
          throw capacityPauseError([
            {
              source: 'workspace',
              resumeAt: new Date(Date.now() + msUntilDailyReset()).toISOString(),
              reason: `daily request cap reached (APEX_REQUEST_CAP_TOTAL=${totalRequestCap()})`,
            },
          ]);
        }
      }
      // Interactive (human-typed, synchronous) calls skip the smoothing ramp
      // on both budgets below — see LLMExecutionContext.interactive — but
      // never the hard caps or the per-minute rate limit inside
      // requestCapacityWindow() itself, which stay in force unconditionally.
      const pacingOverride = execution?.interactive ? false : undefined;
      const requestWindow = requestCapacityWindow(Date.now(), pacingOverride);
      if (!requestWindow.allowed) {
        if (paidLLMFallbackEnabled()) paidOnly = true;
        else {
          throw capacityPauseError([
            {
              source: 'workspace',
              resumeAt: requestWindow.resumeAt,
              reason:
                requestWindow.reason === 'daily_cap'
                  ? `daily request cap reached (${requestWindow.usedRequests}/${requestWindow.cap})`
                  : `request pacing active (${requestWindow.usedRequests}/${requestWindow.pacingAllowance} released of ${requestWindow.cap}/day)`,
            },
          ]);
        }
      }

      // paidOnly means free-tier capacity is exhausted for now, and getting
      // here already confirmed paidLLMFallbackEnabled() — but an operator
      // turning paid continuity on doesn't mean it can afford a request at
      // this exact moment. The $/day cap is paced the same way the request
      // budget above is, so it can be transiently unaffordable even while
      // genuinely enabled. Without this check, every provider below is free
      // (paidOnly skips it) or paid-but-absent-from-the-order (spend denied
      // it), so the loop exits with nothing in providerErrors or skipReasons
      // — "No usable provider credential was configured", which is false
      // (every credential IS configured) and, worse, doesn't match the
      // capacity-pause message shape base-agent.ts's isLLMIntentionalPause()
      // looks for. That mismatch is what let a workspace-wide capacity pause
      // read as an ordinary task failure: agents retried immediately instead
      // of backing off until money was actually available again, burning
      // the rest of both budgets faster and reinforcing the same pause.
      if (paidOnly) {
        const paidWindow = paidSpendCapacityWindow(Date.now(), pacingOverride);
        if (!paidWindow.allowed) {
          throw capacityPauseError([
            {
              source: PAID_FALLBACK_PROVIDER_NAME,
              resumeAt: paidWindow.resumeAt,
              reason:
                paidWindow.reason === 'daily_cap'
                  ? 'daily paid spend cap reached'
                  : 'daily paid spend pacing active',
            },
          ]);
        }
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

        for (const providerName of getProviderOrderForRole(this.config.role, pacingOverride)) {
          const provider = PROVIDER_BY_NAME.get(providerName);
          if (!provider) continue;
          if (paidOnly && !provider.paid) continue;

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

              const accountLock = provider.paid ? null : accountCooldown(credential.key);
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
              const accountWindow = provider.paid ? null : accountCapacityWindow(credential.key);
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
                if (!provider.paid) recordProviderRequest(credential.key, true);
                else {
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
                // A failed attempt still spent the account's daily request
                // allowance — a 429, a timeout and a 500 are each one request
                // as far as the provider is concerned. Counting only successes
                // would hide exactly the traffic worth seeing: the fallback
                // cascade, which burns several requests to serve one call.
                if (!provider.paid) recordProviderRequest(credential.key, false);
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
                if (!provider.paid && isAccountQuotaFailure(status, message)) {
                  setAccountCooldown(credential.key, status, message, err.retryAfterMs);
                }
                setProviderCooldown(provider, status, message, err.retryAfterMs);
                const capacityFailure = isCapacityFailure(status, message);
                if (!capacityFailure) nonCapacityFailureSeen = true;
                const newCooldown = credentialCooldown(credentialId) ?? accountCooldown(credential.key);
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
  // Derived from the live chain rather than restated as a literal. When these
  // were independent, flipping PROVIDER_ORDER to free-only left every agent
  // still advertising the paid model it no longer used — the same class of
  // quiet lie as an agent stuck reporting `error` while working fine. An
  // explicit operator model policy still wins, since that is a deliberate
  // choice rather than a stale default.
  const primaryName = hasCustomOpenRouterModelPolicy()
    ? FREE_POLICY_GATEWAY_NAME
    : PROVIDER_ORDER[0];
  const primary = PROVIDER_BY_NAME.get(primaryName);
  const model = hasCustomOpenRouterModelPolicy()
    ? (getOpenRouterModelChainForRole(role)[0] ?? DEFAULT_OPENROUTER_MODEL_CHAIN[0])
    : (primary?.model ?? DEFAULT_OPENROUTER_MODEL_CHAIN[0]);

  return {
    provider: primary?.name ?? 'openrouter-nex-n2-5-mini-free',
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

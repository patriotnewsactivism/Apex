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
  releaseDirectProviderRequest,
  releasePaidProviderRequest,
  releaseProviderRequest,
  requestCapacityWindow,
  reserveDirectProviderRequest,
  reservePaidProviderRequest,
  reserveProviderRequest,
  type DirectRequestPool,
} from './request-ledger.js';
import {
  classifyOpenRouterAccountFailure,
  excludeOpenRouterAccountForFailure,
  getOpenRouterAccountExclusion,
  getOpenRouterAccountExclusionReport as buildOpenRouterAccountExclusionReport,
} from './provider-account-exclusions.js';
import { recordSpend, recordCachedTokens, paidSpendAvailable, tryReservePaidSpend, dailySpendCapMicros, type SpendPriority } from './spend-ledger.js';
import {
  checkInternalLoopRepeat,
  checkWorkClassShare,
  formatWorkClassDeferral,
  openRouterFreeDailyRequestsPerKey,
  recordWorkClassUsage,
  type WorkClass,
} from './work-class-budget.js';
import { emergencyTotalRequestCap } from './request-ledger.js';
import { totalTokenCap } from './token-ledger.js';
import { tryEnterOperatorLane, operatorLaneProviderOrder } from './operator-lane.js';
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
// ROUTING POLICY (operator decision 2026-10-10, superseding ADR-017's
// Qwen-first order). Automatic routing consumes FREE capacity first: the
// reviewed OpenRouter `:free` roster (six models plus the `openrouter/free`
// router, each OpenRouter account contributing its own daily free allowance),
// then the independent Groq/Gemini BYOK free pools. The metered QwenCloud
// (qwencloud.com) route is tried LAST — only after every free pool is spent —
// so no-marginal-cost free allowance is always consumed before any metered
// spend. QwenCloud is a distinct product from Alibaba Cloud Model Studio/
// DashScope -- the provider `name`/env-var identifiers below still say
// "dashscope" for historical reasons (an early draft of this integration
// assumed that product before the operator's real credential proved
// otherwise) and were deliberately left as-is once corrected, rather than
// renamed, to avoid unnecessary churn -- see ADR-017 for the full history.
// QwenCloud is governed like Groq/Gemini — its own capped/paced request
// pool and its own activation switch — and is explicitly NOT unrestricted
// like the paid continuity route. OpenRouter free-pool exhaustion, the
// emergency all-provider request ceiling, and the workspace token cap must
// not stop a call from landing on QwenCloud. Qwen still obeys
// APEX_QWEN_REQUEST_CAP, rate, and pacing, plus credential cooldowns. The
// operator-approved paid DeepSeek V4 Flash 0731 continuity route (OpenRouter
// alone; the Nous Portal route was removed 2026-10-09) is appended last, hard
// capped by APEX_DAILY_SPEND_USD. It bypasses APEX token/request governors;
// upstream provider limits, billing, error cooldowns, tool authorization, and
// human approval policy remain for every route, QwenCloud and paid included.
//
// Authoritative automatic order:
//   0. nvidia/nemotron-3-super-120b-a12b:free
//   1. nvidia/nemotron-3.5-lightning:free
//   2. openrouter/free  (tool requirements preserved)
//   3. nvidia/nemotron-3-ultra-550b-a55b:free
//   4. cohere/north-mini-code:free
//   5. google/gemma-4-31b-it:free
//   6. groq-gpt-oss-120b-byok    (BYOK, when enabled)
//   7. gemini-3.8-flash-byok     (BYOK, when enabled)
//   8. qwen3.8-flash             (metered QwenCloud fallback, last automatic route)
//   9. deepseek-v4-flash-0731    (paid, unrestricted continuity, last)
//
// The two `nex-agi/nex-n2.5-*:free` rungs were removed 2026-10-11: OpenRouter
// withdrew their free tier (404 "This model is unavailable for free. The paid
// version is available now") and, because a reservation is taken before every
// dispatch, two guaranteed-404 rungs at the head of the chain burned roughly
// half of the daily OpenRouter allowance before the fleet ever reached a rung
// that could answer.
//
// MiniMax M3 Free is intentionally absent until a new direct API verification
// proves the exact `:free` slug works. Persisted OpenRouter model policies
// remain zero-cost-only; Qwen and FlashX are separate, reviewed runtime
// routes outside that policy.

export type ApexProviderName =
  | 'qwen-dashscope-byok'
  | 'openrouter-nemotron-super'
  | 'openrouter-nemotron-3-5-lightning-free'
  | 'openrouter-free-router'
  | 'openrouter-nemotron-ultra'
  | 'openrouter-free-policy'
  | 'groq-gpt-oss-120b-byok'
  | 'gemini-3-8-flash-byok'
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
  // Exactly one inference key per independent OpenRouter account (operator
  // decision 2026-09-25). OPENROUTER_API_KEY_3 was a second key on the same
  // account as OPENROUTER_FREE_API_KEY and added no :free capacity.
  'OPENROUTER_FREE_API_KEY',
  'OPENROUTER_API_KEY_2',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY_4',
] as const;

/**
 * Paid continuity (operator decision 2026-10-09): one model,
 * deepseek/deepseek-v4-flash-0731, served by OpenRouter only. Apex no longer
 * calls the Nous Portal provider (nous-deepseek-v4-flash-paid) — that access
 * is cut off entirely.
 *
 * OpenRouter: the funded inference key. Which account is funded changes over
 * time — the 2026-09-25 reading that "only OPENROUTER_API_KEY_4 has credit" was
 * already stale by 2026-10-10 — so the paid route must be able to use whichever
 * account currently holds credit rather than one pinned name.
 */
/**
 * Env names that may serve the paid continuity route.
 *
 * This was pinned to OPENROUTER_API_KEY_4 alone. On 2026-10-10 that account sat
 * at $0.50, tripped the balance monitor's $0.50 pause threshold, and was
 * excluded — so the paid continuity route could not serve while three other
 * accounts still held credit. The route must be able to use whichever account
 * is actually funded. Order is a tie-break only: configuredCredentials() sorts
 * by requests-already-made-today, and any balance-paused account is excluded by
 * the caller. Override with APEX_PAID_KEY_ENVS (comma-separated env names).
 */
export const OPENROUTER_PAID_KEY_ENVS: readonly string[] = (
  process.env.APEX_PAID_KEY_ENVS ?? 'OPENROUTER_API_KEY,OPENROUTER_API_KEY_2,OPENROUTER_API_KEY_4'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
export const PAID_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash-0731';
/** Output floor for the paid routes. On 2026-10-05 a DevOps task (4,096-token
 *  role budget) failed on deepseek-v4-flash-0731 with "empty completion
 *  content (finish_reason: length)": the reasoning filled the budget. */
export const PAID_MIN_OUTPUT_TOKENS = 16_384;
/** Request timeout for the paid routes. The default request timeout (30s,
 *  APEX_LLM_REQUEST_TIMEOUT_MS) keeps free-route failover fast, but on
 *  2026-10-05 deepseek-v4-flash-0731 regularly needed longer than 30s on
 *  25-35K-token agent contexts. Each timeout became a 5s capacity pause, the
 *  task restarted from its last checkpoint, and the aborted generation was
 *  likely still billed: about one pause a minute with the paid route as the only
 *  route. The paid route is the last resort, so it waits longer. */
export const PAID_REQUEST_TIMEOUT_MS = 120_000;
export const PAID_FALLBACK_PROVIDER_NAMES = [
  'openrouter-deepseek-v4-flash-paid',
] as const satisfies readonly ApexProviderName[];
/** The first (only) paid route in the deterministic order: OpenRouter. */
export const PAID_FALLBACK_PROVIDER_NAME: ApexProviderName = PAID_FALLBACK_PROVIDER_NAMES[0];

type ProviderSpec = {
  name: ApexProviderName;
  model: string;
  /** Optional env var that overrides `model` at request time (e.g. a BYOK
   * provider whose model is hardcoded but should be switchable by the
   * operator without a code change). Read via providerModel(). */
  modelOverrideEnv?: string;
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
  /** Cached input is billed far below fresh input (Qwen: $0.016 vs $0.15 per
   *  1M). Without this the prompt total is priced entirely at the fresh rate
   *  and the paid spend is overstated. */
  usdPerMillionCachedPrompt?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Provider-side request envelope. Used to size output/history before the
   * network call instead of learning the limit by burning a 413 attempt. */
  maxRequestTokens?: number;
  maxOutputTokens?: number;
  /** Per-route request timeout, above the default LLM_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** Floor on max_tokens, above the role's output budget. Reasoning models
   *  can spend a 4,096-token budget thinking and return no content
   *  (finish_reason: length), which fails the task after the reasoning was
   *  billed. Billing is per generated token, so a higher ceiling costs
   *  nothing when the answer is short. */
  minOutputTokens?: number;
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

/** Effective model for a provider: the operator's env override (if the spec
 * declares one) wins over the hardcoded default. */
function providerModel(provider: ProviderSpec): string {
  const override = provider.modelOverrideEnv
    ? process.env[provider.modelOverrideEnv]?.trim()
    : undefined;
  return override || provider.model;
}

const PROVIDERS: readonly ProviderSpec[] = [
  {
    name: 'qwen-dashscope-byok',
    model: 'qwen3.8-flash',
    modelOverrideEnv: 'QWEN_MODEL',
    // QwenCloud OpenAI-compatible endpoint. Pay-as-you-go (`sk-...`) and Token
    // Plan (`sk-sp-...`) credentials are not interchangeable across hosts: PAYG
    // keys are served by maas.qwencloudapi.com, Token Plan keys by
    // token-plan.maas.qwencloudapi.com. Default to the PAYG host, because the
    // operator's active key is pay-as-you-go — with the Token Plan host as the
    // default, a deployment that omits QWEN_BASE_URL sends the key to the wrong
    // host and every Qwen call fails. Token Plan deployments must set
    // QWEN_BASE_URL (or APEX_QWEN_BASE_URL) explicitly.
    baseURL: () =>
      process.env.QWEN_BASE_URL?.trim() ||
      process.env.APEX_QWEN_BASE_URL?.trim() ||
      'https://maas.qwencloudapi.com/compatible-mode/v1',
    apiKeyEnvs: ['QWEN_API_KEY', 'QWEN_API_KEY_2'],
    // Real money from a purchased token plan, so spend is recorded like any
    // paid route — but deliberately NOT `unrestricted`. OpenRouter and
    // workspace governors must not veto it (see independentPlanRoute). Its
    // own request cap, rate, and pacing still do.
    paid: true,
    requestPool: 'qwen',
    protocol: 'openai-compatible',
    activationEnv: 'APEX_QWEN_BYOK_ENABLED',
    activationDescription: 'APEX_QWEN_BYOK_ENABLED=true is required',
    // Primary route hit by the whole workforce on every call, not an
    // occasional fallback — keep spacing tight enough that it can't become
    // the bottleneck itself. Override with
    // APEX_LLM_MIN_INTERVAL_MS_QWEN_DASHSCOPE_BYOK if the plan needs more room
    // (derived from the `name` below, which keeps its original identifier —
    // see the provenance note atop this file).
    minIntervalMs: 250,
    toolCallingReliable: true,
    // Not yet confirmed against QwenCloud's compatible-mode docs that
    // `parallel_tool_calls` is honored server-side. Left unset (so the field
    // is never sent) rather than risk a 400 on every primary-route request;
    // flip on once verified live. Live-tested 2026-09-24 without this flag:
    // a tool-call request with the model's default (enabled) thinking mode
    // completed correctly (tool_calls populated, content empty -- a case the
    // completion guard below already exempts), well inside a normal budget.
    maxOutputTokens: envPositiveInt('APEX_QWEN_MAX_OUTPUT_TOKENS', 8_192),
    // PAYG per-token rates for qwen3.8-flash, confirmed against
    // qwencloud.com/models/qwen3.8-flash (input $0.15, output $0.47 per 1M
    // tokens). The operator is on pay-as-you-go, so the binding constraint IS
    // per-call dollars; without these the paid fallback records $0 and
    // cost-per-completed-task is invisible. QwenCloud's OpenAI-compatible
    // response carries no settled `usage.cost` (OpenRouter's does), so the
    // ledgers derive cost from these rates.
    usdPerMillionPrompt: 0.15,
    usdPerMillionCompletion: 0.47,
    usdPerMillionCachedPrompt: 0.016,
  },
  // Retired 2026-10-11 with the `nex-agi/nex-n2.5-*:free` slugs themselves:
  // OpenRouter moved both to paid-only, so every dispatch was a 404 that still
  // reserved a slot of the daily free allowance. Do not re-add a free-openrouter
  // spec without a live 200 on the exact `:free` slug first.
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
    name: 'openrouter-deepseek-v4-flash-paid',
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
    maxOutputTokens: 131_072,
    minOutputTokens: PAID_MIN_OUTPUT_TOKENS,
    requestTimeoutMs: PAID_REQUEST_TIMEOUT_MS,
    // `sort: 'price'` once pinned the paid route to a host with a 60s p99,
    // past LLM_REQUEST_TIMEOUT_MS (2026-09-17). Latency is what this route
    // needs: an answer inside the timeout.
    providerRouting: { sort: 'latency' },
    // OpenRouter list price for deepseek/deepseek-v4-flash-0731 on
    // 2026-10-05. Settled cost from OpenRouter's response stays authoritative.
    usdPerMillionPrompt: 0.0152,
    usdPerMillionCompletion: 1.28,
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
  // Free capacity first (operator decision 2026-10-10): the reviewed OpenRouter
  // free roster, then the independent Groq and Gemini BYOK free pools. The
  // metered QwenCloud route is the LAST automatic route — used only after
  // every free pool (and its daily allowance) is spent — so the
  // no-marginal-cost free allowance is always consumed before any pay-as-you-go
  // spend. Qwen still falls through when unconfigured, disabled, or failing.
  'openrouter-nemotron-super',
  'openrouter-nemotron-3-5-lightning-free',
  'openrouter-free-router',
  'openrouter-nemotron-ultra',
  'groq-gpt-oss-120b-byok',
  'gemini-3-8-flash-byok',
  // Metered fallback of last resort (PAYG today; the operator prefers the
  // Token Plan balance when it exists). Its model honors the QWEN_MODEL
  // override (see the qwen-dashscope-byok spec).
  'qwen-dashscope-byok',
];

function activeProviderOrder(role?: string, pacingEnabled?: boolean): readonly ApexProviderName[] {
  const freeOrder: ApexProviderName[] = hasCustomOpenRouterModelPolicy()
    ? (() => {
        // A saved free-model policy is a preference, not a single point of
        // failure. Production logs on 2026-09-26 showed a policy pinned to a
        // now-404 Nex route suppressing every other OpenRouter free fallback.
        // Try the operator-selected gateway first, then only the default free
        // providers that are NOT already present in the selected policy.
        const selected = new Set(getOpenRouterModelChainForRole(role));
        const defaultFreeFallbacks = PROVIDER_ORDER.filter((name) => {
          const provider = PROVIDER_BY_NAME.get(name);
          return Boolean(
            provider &&
            provider.requestPool === 'openrouter' &&
            provider.paid !== true &&
            !selected.has(providerModel(provider)),
          );
        });
        return [
          // Free pools first, then the metered QwenCloud fallback last (operator
          // decision 2026-10-10). A saved free-model policy governs only the
          // OpenRouter FREE sub-order; it must not drop Qwen, and it must not
          // promote the metered route ahead of free capacity either.
          FREE_POLICY_GATEWAY_NAME,
          ...defaultFreeFallbacks,
          'groq-gpt-oss-120b-byok',
          'gemini-3-8-flash-byok',
          'qwen-dashscope-byok',
        ];
      })()
    : [...PROVIDER_ORDER];
  // Paid continuity comes last and only with APEX_PAID_FALLBACK_ENABLED=true.
  // APEX imposes no spend ceiling, request cap, or pacing gate on it; upstream
  // OpenRouter limits remain authoritative.
  if (paidLLMFallbackEnabled()) freeOrder.push(...PAID_FALLBACK_PROVIDER_NAMES);
  return freeOrder;
}

export function getProviderOrderForRole(_role?: string, pacingEnabled?: boolean): ApexProviderName[] {
  return [...activeProviderOrder(_role, pacingEnabled)];
}

/**
 * The order one request actually tries. Same as getProviderOrderForRole.
 * There is a single paid route now (OpenRouter), so no rotation is needed;
 * it sits last behind the free/BYOK chain when paid fallback is enabled.
 */
export function requestProviderOrder(role?: string, pacingEnabled?: boolean): ApexProviderName[] {
  return getProviderOrderForRole(role, pacingEnabled);
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
 * Off by default. Paid continuity is an explicit opt-in: only
 * `APEX_PAID_FALLBACK_ENABLED=true` adds FlashX to the route. When the flag is
 * absent or false, APEX parks after Qwen/free/BYOK capacity is spent instead of
 * silently starting paid per-token inference.
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
  if (raw === undefined || raw.trim() === '') return false;
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

  const requestedOutput = Math.max(
    256,
    provider.minOutputTokens ?? 0,
    Math.floor(requestedMaxOutputTokens),
  );
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

/**
 * Cooldowns are in-memory for the hot path, but they MUST survive a container
 * replacement. A deploy that forgets a resting provider's cooldown hands the
 * workforce straight back to it, and the agents re-discover the outage by
 * failing — the deferral storm observed 2026-10-10 (three deploys, three
 * workforce reinit batches, zero completions). Persist the still-live entries
 * to Postgres, debounced; hydrate at boot before the first request.
 */
const COOLDOWN_SETTINGS_KEY = 'apex.llm.cooldowns';
let cooldownsPersistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCooldownsPersist(): void {
  if (cooldownsPersistTimer) return;
  cooldownsPersistTimer = setTimeout(() => {
    cooldownsPersistTimer = null;
    void persistCooldowns();
  }, 1_000);
  (cooldownsPersistTimer as { unref?: () => void }).unref?.();
}

async function persistCooldowns(): Promise<void> {
  try {
    const { db, integrationSettings } = await import('@workspace/db');
    const now = Date.now();
    const value = JSON.stringify({
      providers: [...providerCooldowns.entries()].filter(([, until]) => until > now),
      credentials: [...credentialCooldowns.entries()].filter(([, cooldown]) => cooldown.until > now),
    });
    await db
      .insert(integrationSettings)
      .values({ key: COOLDOWN_SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: integrationSettings.key,
        set: { value, updatedAt: new Date() },
      });
  } catch {
    // Best effort: a memory-only cooldown is the pre-existing behaviour.
  }
}

/** Load persisted cooldowns at boot so a restart resumes the schedule the
 *  previous process was keeping, instead of re-discovering it by failing. */
export async function initializeProviderCooldowns(): Promise<boolean> {
  try {
    const { db, integrationSettings } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select()
      .from(integrationSettings)
      .where(eq(integrationSettings.key, COOLDOWN_SETTINGS_KEY))
      .limit(1);
    if (row?.value) {
      const parsed = JSON.parse(row.value) as {
        providers?: Array<[string, number]>;
        credentials?: Array<[string, CredentialCooldown]>;
      };
      const now = Date.now();
      for (const [name, until] of parsed.providers ?? []) {
        if (until > now) providerCooldowns.set(name as ApexProviderName, until);
      }
      for (const [id, cooldown] of parsed.credentials ?? []) {
        if (cooldown?.until > now) credentialCooldowns.set(id, cooldown);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Test-only hooks for the Postgres round-trip guard. They expose the private
 * cooldown maps so a test can seed a cooldown, persist it, clear the process
 * state (simulating a container replacement) and re-hydrate — the restart
 * behaviour the source-pattern guard cannot prove.
 */
export function __testSeedProviderCooldown(name: ApexProviderName, until: number): void {
  providerCooldowns.set(name, until);
  scheduleCooldownsPersist();
}
export function __testSeedCredentialCooldown(id: string, cooldown: CredentialCooldown): void {
  credentialCooldowns.set(id, cooldown);
  scheduleCooldownsPersist();
}
export function __testClearCooldownMaps(): void {
  providerCooldowns.clear();
  credentialCooldowns.clear();
}
export function __testGetProviderCooldown(name: ApexProviderName): number | undefined {
  return providerCooldowns.get(name);
}
export function __testGetCredentialCooldown(id: string): CredentialCooldown | undefined {
  return credentialCooldowns.get(id);
}
export async function __testFlushCooldowns(): Promise<void> {
  await persistCooldowns();
}
export const __testCooldownSettingsKey = COOLDOWN_SETTINGS_KEY;

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

/**
 * The request timeout for one route: the default, or the route's own longer
 * timeout, never above the 180s ceiling.
 *
 * An interactive turn has a human watching the screen, so a route that has not
 * answered within INTERACTIVE_REQUEST_TIMEOUT_MS is abandoned and the next one
 * tried. The default 30s budget is sized for an unattended background agent;
 * spending it in front of the operator is the difference between "slow" and
 * "broken". Tunable, because the right number depends on the routes in use.
 */
const INTERACTIVE_REQUEST_TIMEOUT_MS = envPositiveInt(
  'APEX_LLM_INTERACTIVE_TIMEOUT_MS',
  15_000,
);

function providerRequestTimeoutMs(
  provider: ProviderSpec,
  execution?: LLMExecutionContext,
): number {
  const base = Math.min(180_000, Math.max(LLM_REQUEST_TIMEOUT_MS, provider.requestTimeoutMs ?? 0));
  if (execution?.interactive) return Math.min(base, INTERACTIVE_REQUEST_TIMEOUT_MS);
  return base;
}

export function getProviderRequestTimeoutMs(providerName: ApexProviderName): number {
  const provider = PROVIDER_BY_NAME.get(providerName);
  if (!provider) throw new Error(`Unknown APEX provider: ${providerName}`);
  return providerRequestTimeoutMs(provider);
}

const COOLDOWN_429_MS = 30_000;
/** A request that timed out says nothing about the credential's quota, so it
 * earns only enough of a pause to let a wedged endpoint settle. Charging it the
 * full rate-limit cooldown blacks out every agent on APEX's single OpenRouter
 * credential for 30s over one slow response. */
const COOLDOWN_TIMEOUT_MS = 5_000;
const COOLDOWN_AUTH_MS = 10 * 60 * 1000;
const COOLDOWN_404_MS = 10 * 60 * 1000;
const COOLDOWN_413_MS = 15 * 60 * 1000;

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

function isDailyProviderQuotaFailure(status: number | undefined, message: string): boolean {
  return status === 429 && /perday|per_day|per day|daily.{0,30}(?:quota|limit)|(?:quota|limit).{0,30}daily/i.test(message);
}

function cooldownMs(status: number | undefined, message: string): number {
  if (isDailyProviderQuotaFailure(status, message)) {
    const reset = new Date();
    reset.setUTCHours(24, 0, 0, 0);
    return reset.getTime() - Date.now();
  }
  // An unpurchased model is an entitlement defect, not transient congestion.
  // Keep the persisted exclusion long enough to avoid a fleet-wide retry loop.
  if (status === 403 && /AccessDenied\.Unpurchased|access to model denied/i.test(message)) {
    return 6 * 60 * 60 * 1000;
  }
  const accountFailure = classifyOpenRouterAccountFailure(status, message);
  if (accountFailure?.until !== null && accountFailure?.until !== undefined) {
    return Math.max(0, accountFailure.until - Date.now());
  }
  if (status === 401 || status === 403) {
    return COOLDOWN_AUTH_MS;
  }
  if (status === 404) return COOLDOWN_404_MS;
  if (status === 413) return COOLDOWN_413_MS;
  if (status === undefined && /request timed out|aborted/i.test(message)) {
    return COOLDOWN_TIMEOUT_MS;
  }
  return COOLDOWN_429_MS;
}

export function isAccountQuotaFailure(
  status: number | undefined,
  message: string,
): boolean {
  return classifyOpenRouterAccountFailure(status, message) !== null;
}

export function isCapacityFailure(
  status: number | undefined,
  message: string,
): boolean {
  return (
    isAccountQuotaFailure(status, message) ||
    isDailyProviderQuotaFailure(status, message) ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status === undefined &&
      /request timed out|aborted|empty completion content \(finish_reason: error\)|provider returned no completion choice/i.test(
        message,
      ))
  );
}

export function isAuthFailure(status: number | undefined, message: string): boolean {
  if (status === 401 || status === 403) return true;
  if (
    /\b(?:401|403)\b|invalid (?:api )?key|authentication failed|unauthori[sz]ed|forbidden|access to model denied/i.test(
      message,
    )
  ) {
    return true;
  }
  return false;
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
  // Cool a credential only when the failure actually says something about the
  // credential/account itself. Model 404s, malformed request bodies, oversized
  // payloads, upstream 5xx responses and empty/malformed completions are route-
  // or request-specific failures; poisoning the key for those turns one bad
  // model response into a fleet-wide outage.
  if (status === 401 || status === 403 || status === 402 || status === 429) return true;
  if (
    status === undefined &&
    /invalid (?:api )?key|authentication failed|unauthori[sz]ed|forbidden|payment required|insufficient credits|quota exhausted/i.test(
      message,
    )
  ) {
    return true;
  }
  return false;
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
  scheduleCooldownsPersist();
}

function clearCredentialCooldown(id: string): void {
  credentialCooldowns.delete(id);
  scheduleCooldownsPersist();
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
  scheduleCooldownsPersist();
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
/**
 * Only routes that name the OpenRouter pool get OpenRouter's request fields
 * (`provider`, `usage`), headers, and account handling. This used to default
 * an unset pool to OpenRouter, so when the paid route moved to Nous Portal
 * without a pool, every request carried OpenRouter's `provider` object and
 * Nous refused it with HTTP 400. That 400 also counted as a non-capacity
 * failure, so tasks failed instead of waiting out the free-pool cooldowns.
 */
function isOpenRouterProvider(provider: ProviderSpec): boolean {
  return provider.requestPool === 'openrouter';
}

/** FlashX bypasses APEX governors entirely. QwenCloud does not, but its
 *  upgraded Token Plan quota is not the OpenRouter free pool or the workspace
 *  token ledger. Those must not keep the plan idle while the workforce is
 *  parked. Qwen's own request cap, rate, and pacing still apply. */
function independentPlanRoute(provider: ProviderSpec): boolean {
  return provider.unrestricted === true || provider.requestPool === 'qwen';
}

function requestWindowForProvider(
  provider: ProviderSpec,
  at: number,
  pacingEnabled?: boolean,
  priority: SpendPriority = 'background',
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
  if (provider.paid) return paidProviderCapacityWindow(at, pacingEnabled, priority);
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

/**
 * A failure that means the request was never served, so the provider did not
 * consume the capacity the daily request allowance stands for.
 *
 * 404: the pinned `:free` slug is withdrawn or unknown ("This model is
 * unavailable for free. The paid version is available now") — no generation was
 * ever requested. 400: the body, not the key, is indicted (see the note in the
 * failure path below).
 *
 * Everything else keeps its charge. A 429 or 5xx means the provider was engaged
 * and may well have metered us, and a timeout is not evidence either way.
 */
export function isRoutingDefectStatus(status: number | undefined): boolean {
  return status === 404 || status === 400;
}

function releaseProviderAttempt(
  provider: ProviderSpec,
  credentialKey: string,
): void {
  if (
    provider.requestPool === 'groq' ||
    provider.requestPool === 'gemini' ||
    provider.requestPool === 'qwen'
  ) {
    releaseDirectProviderRequest(provider.requestPool, provider.name);
  } else if (provider.paid) {
    releasePaidProviderRequest(provider.name);
  } else {
    releaseProviderRequest(credentialKey);
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

export type ProviderCapacityState =
  | 'available' | 'disabled' | 'unconfigured' | 'access_denied'
  | 'upstream_quota' | 'cooldown' | 'daily_cap' | 'paced' | 'budget_blocked';

export interface ProviderCapacityStatus {
  name: ApexProviderName;
  model: string;
  configured: boolean;
  enabled: boolean;
  paid: boolean;
  available: boolean;
  state: ProviderCapacityState;
  reason: string;
  resumeAt: string | null;
  /** Observed in this process; a configured key is not proof of entitlement. */
  lastSuccessAt: string | null;
}

const providerLastSuccessAt = new Map<ApexProviderName, string>();

/** Read-only admission evidence, using the same local gates as dispatch.
 * Availability means worth attempting, NOT a promise of upstream entitlement.
 * Reports both inactive and active routes so a configured key is never silently
 * presented as usable capacity. No network probes and no reservations. */
export function getProviderCapacityReport(now: number = Date.now()): ProviderCapacityStatus[] {
  const activeOrder = activeProviderOrder();
  const active = new Set(activeOrder);
  const ledger = getTokenLedgerSnapshot();
  const providers = new Map(ledger.providers.map((entry) => [entry.provider, entry]));
  return [...new Set([...activeOrder, ...PROVIDER_ORDER, ...PAID_FALLBACK_PROVIDER_NAMES])].map((name) => {
    const provider = PROVIDER_BY_NAME.get(name)!;
    const configured = providerConfigured(provider);
    const enabledRoute = active.has(name) && !providerActivationIssue(provider);
    const result = (state: ProviderCapacityState, reason: string, resumeAt: string | null = null): ProviderCapacityStatus => ({
      name, model: providerModel(provider), configured, enabled: enabledRoute,
      paid: provider.paid === true, available: state === 'available', state, reason, resumeAt,
      lastSuccessAt: providerLastSuccessAt.get(name) ?? null,
    });
    if (!enabledRoute) return result('disabled', providerActivationIssue(provider) ?? 'Excluded by routing policy');
    if (!configured || !providerBaseURL(provider)) return result('unconfigured', providerRequirements(provider).join('; ') || 'Missing endpoint');

    const credentials = configuredCredentials(provider);
    const candidates = credentials.map((credential) => {
      const cooldown = credentialCooldown(`${provider.name}:${credential.env}`);
      if (cooldown) return {
        state: (/access to model denied|AccessDenied\.Unpurchased|invalid (?:api )?key|unauthori[sz]ed|forbidden/i.test(cooldown.reason)
          ? 'access_denied' : cooldown.capacityPause ? 'upstream_quota' : 'cooldown') as ProviderCapacityState,
        reason: cooldown.reason, resumeAt: new Date(cooldown.until).toISOString(),
      };
      if (isOpenRouterProvider(provider)) {
        const exclusion = getOpenRouterAccountExclusion(credential.key, { paid: provider.paid });
        if (exclusion) return { state: 'upstream_quota' as const, reason: exclusion.reason, resumeAt: exclusion.resumeAt };
        if (!provider.paid) {
          const window = accountCapacityWindow(credential.key, now);
          if (!window.allowed) return { state: window.reason === 'daily_cap' ? 'daily_cap' as const : 'paced' as const, reason: `Account request ${window.reason}`, resumeAt: window.resumeAt };
        }
      }
      return null;
    });
    if (!candidates.some((candidate) => candidate === null)) {
      const blocked = candidates.filter((candidate) => candidate !== null).sort((a, b) => Date.parse(a.resumeAt ?? '') - Date.parse(b.resumeAt ?? ''))[0];
      return blocked ? result(blocked.state, blocked.reason, blocked.resumeAt) : result('unconfigured', 'No usable credential');
    }
    if (!independentPlanRoute(provider)) {
      const emergency = emergencyRequestCapacityWindow(now);
      if (!emergency.allowed) return result('daily_cap', 'Workspace emergency request cap reached', emergency.resumeAt);
      if (ledger.totalCapReached || !ledger.pacing.total.allowed) return result(ledger.totalCapReached ? 'daily_cap' : 'paced', 'Workspace token allowance unavailable', ledger.pacing.total.resumeAt);
    }
    const window = requestWindowForProvider(provider, now);
    if (!window.allowed) return result(provider.paid && provider.requestPool === 'openrouter' ? 'budget_blocked' : window.reason === 'daily_cap' ? 'daily_cap' : 'paced', `${provider.requestPool ?? provider.name} admission ${window.reason}`, window.resumeAt);
    const until = providerCooldowns.get(provider.name) ?? 0;
    if (until > now) return result('cooldown', 'Provider upstream cooldown', new Date(until).toISOString());
    const tokens = providers.get(provider.name);
    if (!provider.unrestricted && tokens && (tokens.capReached || !tokens.pacing.allowed)) return result(tokens.capReached ? 'daily_cap' : 'paced', 'Provider token allowance unavailable', tokens.pacing.resumeAt);
    return result('available', 'Local admission gates allow a probe; upstream entitlement is not guaranteed');
  });
}

export function llmCapacityAvailableNow(now: number = Date.now()): boolean {
  return getProviderCapacityReport(now).some((provider) => provider.available);
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
  cachedTokens = 0,
): number {
  const prompt = Math.max(0, Number(usage?.promptTokens ?? 0));
  const completion = Math.max(0, Number(usage?.completionTokens ?? 0));
  // Cached prompt tokens are a subset of promptTokens and are billed at the
  // cached rate, not the fresh-input rate. Price the cached slice separately so
  // a cache-heavy call is not charged as if every input token were fresh.
  const cached = Math.min(Math.max(0, Number(cachedTokens)), prompt);
  const inRate = provider.usdPerMillionPrompt ?? 0;
  const cachedRate = provider.usdPerMillionCachedPrompt ?? inRate;
  const outRate = provider.usdPerMillionCompletion ?? 0;
  return ((prompt - cached) * inRate + cached * cachedRate + completion * outRate) / 1_000_000;
}

function estimatedPaidCallReserveUsd(
  provider: ProviderSpec,
  messages: LLMMessage[],
  tools: LLMTool[] | undefined,
  maxOutputTokens: number,
): number {
  const prepared = prepareProviderRequest(provider.name, messages, tools, maxOutputTokens);
  // Reserve the whole allowed completion, including reasoning. A char/4 prompt
  // estimate is good for routing but too optimistic for a dollar ceiling: use
  // UTF-8 bytes plus per-message framing instead. Cached pricing only reduces
  // the eventual settlement; it must not lower this pre-dispatch hold.
  const promptUpperBound = Buffer.byteLength(JSON.stringify({ messages: prepared.messages, tools: tools ?? [] }), 'utf8')
    + 256 * (prepared.messages.length + (tools?.length ?? 0) + 1);
  return estimatedCostUsd(provider, {
    promptTokens: promptUpperBound,
    completionTokens: prepared.maxOutputTokens,
  });
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

// Keep the default below workforce size so one backlog burst cannot fan all
// 13 agents into provider calls simultaneously. Operators can raise this
// deliberately, but a missing env var now lands on the reviewed safe default.
const configuredLLMConcurrency = Number(process.env.APEX_MAX_CONCURRENT_LLM_CALLS ?? 4);
const MAX_CONCURRENT_LLM_CALLS = Number.isFinite(configuredLLMConcurrency)
  ? Math.min(64, Math.max(1, Math.floor(configuredLLMConcurrency)))
  : 4;

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
  const timeout = setTimeout(() => controller.abort(), providerRequestTimeoutMs(provider, execution));
  const startedAt = Date.now();
  let routedModels = [providerModel(provider)];

  try {
    const policy = isOpenRouterProvider(provider)
      ? getActiveOpenRouterModelPolicy()
      : null;
    const customPolicy = Boolean(policy) && provider.name === FREE_POLICY_GATEWAY_NAME;
    routedModels = customPolicy
      ? getOpenRouterModelChainForRole(config.role)
      : [providerModel(provider)];

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
    ) || providerModel(provider).trim().toLowerCase() === 'openrouter/free'
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
    } else body.model = providerModel(provider);

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
    const servedModel = parsed.model || routedModels[0] || providerModel(provider);
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
      model: providerModel(provider),
      messages,
      tools,
      config: providerConfig,
      execution,
      timeoutMs: providerRequestTimeoutMs(provider, execution),
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

/** The most recent capacity pause, kept for diagnostics so "agents are
 *  deferring" can be answered with the exact provider/gate that caused it
 *  instead of a guess. Bounded and overwritten, never accumulated. */
export type CapacityDiagnostics = {
  at: string;
  resumeAt: string;
  blocks: string[];
  details: string[];
};
let lastCapacityDiagnostics: CapacityDiagnostics | null = null;
export function getLastCapacityDiagnostics(): CapacityDiagnostics | null {
  return lastCapacityDiagnostics;
}

function capacityPauseError(blocks: CapacityBlock[], otherDetails: string[] = []): Error {
  const timestamps = blocks
    .map((block) => (block.resumeAt ? Date.parse(block.resumeAt) : Number.NaN))
    .filter(Number.isFinite);
  const resumeAt = timestamps.length
    ? new Date(Math.min(...timestamps)).toISOString()
    : new Date(Date.now() + 60_000).toISOString();
  lastCapacityDiagnostics = {
    at: new Date().toISOString(),
    resumeAt,
    blocks: blocks.map((block) => `${block.source}: ${block.reason}${block.resumeAt ? ` @${block.resumeAt}` : ''}`),
    details: otherDetails,
  };
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
    // Operator/Command chat gets its own reserved lane (own slots + small daily
    // budget) so a workspace capacity pause or a full background queue never
    // parks the human. Falls back to the governed path when the lane is spent.
    const operatorLane = execution?.operatorLane ? tryEnterOperatorLane() : null;
    // Mission-first budget split (work-class-budget.ts). Operator chat and
    // mission/campaign work are never restricted here; internal loops and
    // background work are held to their share of the existing daily caps and
    // deferred per task (never a workspace-wide pause).
    const workClass: WorkClass = operatorLane || execution?.operatorLane
      ? 'operator'
      // Untagged calls come from direct callers outside the agent task loop
      // (campaign/lead pipelines, API routes). They are never throttled here
      // — only tasks the agent loop classified as internal/background are.
      : execution?.workClass ?? 'mission';
    if (workClass === 'internal' || workClass === 'background') {
      if (workClass === 'internal') {
        const repeat = checkInternalLoopRepeat(execution?.taskId, execution?.workTitle);
        if (!repeat.allowed) throw new Error(formatWorkClassDeferral(repeat));
      }
      const estimate = estimateLLMRequestTokens(
        trimMessageHistory(messages).messages,
        tools,
        Math.min(this.config.maxTokens ?? 2048, 16_384),
      );
      const requestShare = checkWorkClassShare('requests', workClass, emergencyTotalRequestCap(), 1);
      if (!requestShare.allowed) throw new Error(formatWorkClassDeferral(requestShare));
      const tokenShare = checkWorkClassShare('tokens', workClass, totalTokenCap(), estimate);
      if (!tokenShare.allowed) throw new Error(formatWorkClassDeferral(tokenShare));
      recordWorkClassUsage('requests', workClass, 1);
      recordWorkClassUsage('tokens', workClass, estimate);
    } else {
      recordWorkClassUsage('requests', workClass, 1);
    }
    if (!operatorLane) await acquireLLMConcurrencySlot();

    try {
      // Workspace governors still protect free/BYOK traffic. The operator-
      // approved FlashX continuity route is allowed to remain available after
      // those budgets are exhausted.
      const pacingOverride = execution?.interactive ? false : undefined;
      const spendPriority: SpendPriority = operatorLane ? 'operator' : 'background';
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
      // The operator lane is exempt from the workspace token pacing/reservation
      // (what produces the workspace capacity pause). The all-provider
      // emergency hard cap above and every per-provider limit still apply; the
      // paid route stays reachable within APEX_DAILY_SPEND_USD.
      if (!operatorLane && !totalReservation.allowed) {
        globalCapacityBlocks.push(
          capacityBlockFromReservation('workspace', totalReservation),
        );
      }

      try {
        const providerErrors: string[] = [];
        const skipReasons: string[] = [];
        const capacityBlocks: CapacityBlock[] = [...globalCapacityBlocks];
        let nonCapacityFailureSeen = false;
        let authFailureCount = 0;

        const providerOrder = operatorLane
          ? operatorLaneProviderOrder(
              requestProviderOrder(this.config.role, pacingOverride),
              paidLLMFallbackEnabled() ? PAID_FALLBACK_PROVIDER_NAMES : [],
              paidLLMFallbackEnabled() && paidSpendAvailable(Date.now(), false, 'operator'),
            )
          : requestProviderOrder(this.config.role, pacingOverride);
        for (const providerName of providerOrder) {
          const provider = PROVIDER_BY_NAME.get(providerName);
          if (!provider) continue;

          if (!independentPlanRoute(provider) && globalCapacityBlocks.length > 0) {
            skipReasons.push(
              `${provider.name}: workspace/free-provider capacity governor active`,
            );
            continue;
          }

          const providerRequestWindow = requestWindowForProvider(
            provider,
            Date.now(),
            pacingOverride,
            spendPriority,
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

          // Reserve what this provider can actually receive, after its own
          // history trimming and output clamp. The original CEO/agent request
          // can exceed Groq's entire 7,600-token envelope; charging that larger
          // estimate falsely parks a perfectly admissible bounded request.
          let providerRequestTokens = 0;
          try {
            if (!provider.unrestricted) providerRequestTokens = prepareProviderRequest(
              provider.name, providerMessages, tools, this.config.maxTokens ?? 4096,
            ).estimatedTotalTokens;
          } catch (error) {
            // Large tool schemas can exceed a small provider's envelope even
            // after history trimming. No upstream call or token hold occurred;
            // reject this route only, never abort the remaining fallback chain.
            const message = error instanceof Error ? error.message : String(error);
            providerErrors.push(`${provider.name}: request preparation failed (${message})`);
            if (!isRequestTooLargeError(undefined, message)) nonCapacityFailureSeen = true;
            continue;
          }
          const providerReservation = provider.unrestricted
            ? null
            : reserveProviderTokenCapacity(provider.name, providerRequestTokens);
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
                const remainingMs = Math.max(0, activeCooldown.until - Date.now());
                skipReasons.push(
                  `${credentialId}: credential in cooldown (${Math.ceil(remainingMs / 1000)}s; ${activeCooldown.reason})`,
                );
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
                isOpenRouterProvider(provider)
                  ? getOpenRouterAccountExclusion(credential.key, {
                      paid: provider.paid,
                    })
                  : null;
              if (accountLock) {
                skipReasons.push(
                  `${credentialId}: OpenRouter account excluded (${accountLock.kind}; ${accountLock.reason})`,
                );
                capacityBlocks.push({
                  source: accountLock.account,
                  resumeAt: accountLock.resumeAt,
                  reason: accountLock.reason,
                });
                continue;
              }

              // Free-tier share: OpenRouter's free-models-per-day quota is per
              // account and enforced remotely. Count it per work class so
              // internal loops / background work stop at their share and the
              // mission reserve stays available on that key.
              const freeShareResource = isOpenRouterProvider(provider) && !provider.paid
                ? (`openrouter_free:${credential.env}` as const)
                : null;
              if (freeShareResource) {
                const freeShare = checkWorkClassShare(
                  freeShareResource,
                  workClass,
                  openRouterFreeDailyRequestsPerKey(),
                  1,
                );
                if (!freeShare.allowed) {
                  skipReasons.push(`${credentialId}: work-class share (${workClass}) of free-tier quota used`);
                  capacityBlocks.push({
                    source: credentialId,
                    resumeAt: freeShare.resumeAt ?? new Date(Date.now() + 60_000).toISOString(),
                    reason: `work-class share (${workClass}): ${freeShare.reason}`,
                  });
                  continue;
                }
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
              const emergencyAttemptWindow = independentPlanRoute(provider)
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
                spendPriority,
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

              // Atomic admission and hold: no await between this decision and
              // dispatch, so concurrent background calls cannot all claim the
              // last dollars or consume the operator's protected share.
              const paidEstimateUsd = provider.paid && isOpenRouterProvider(provider)
                ? estimatedPaidCallReserveUsd(provider, providerMessages, tools, this.config.maxTokens ?? 4096)
                : 0;
              if (paidEstimateUsd > 0) {
                const spendShare = checkWorkClassShare(
                  'spend_micros',
                  workClass,
                  dailySpendCapMicros(),
                  Math.ceil(paidEstimateUsd * 1_000_000),
                );
                if (!spendShare.allowed) {
                  capacityBlocks.push({
                    source: provider.name,
                    resumeAt: spendShare.resumeAt ?? new Date(Date.now() + 60_000).toISOString(),
                    reason: `work-class share (${workClass}): ${spendShare.reason}`,
                  });
                  break;
                }
              }
              const paidReservation = provider.paid && isOpenRouterProvider(provider)
                ? tryReservePaidSpend(estimatedPaidCallReserveUsd(provider, providerMessages, tools, this.config.maxTokens ?? 4096), {
                    priority: spendPriority,
                    pacingEnabled: pacingOverride,
                    provider: provider.name,
                  })
                : null;
              if (paidReservation && !paidReservation.allowed) {
                capacityBlocks.push({ source: provider.name, resumeAt: paidReservation.resumeAt, reason: `paid spend ${paidReservation.reason}; generation reserve exceeds available ${spendPriority} budget` });
                break;
              }
              if (paidReservation) {
                recordWorkClassUsage('spend_micros', workClass, Math.ceil(paidEstimateUsd * 1_000_000));
              }
              let paidSpendSettled = false;
              reserveProviderAttempt(provider, credential.key);
              if (freeShareResource) recordWorkClassUsage(freeShareResource, workClass, 1);
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
                providerLastSuccessAt.set(provider.name, new Date().toISOString());
                if (provider.paid) {
                  // Charge the settled cost. OpenRouter returns it because the
                  // request sets `usage: { include: true }`; when it is absent
                  // fall back to list price rather than recording zero, since a
                  // missing figure must never read as free spend.
                  recordSpend(
                    provider.name,
                    result.costUsd ?? estimatedCostUsd(provider, result.usage, result.cachedTokens ?? 0),
                  );
                  paidSpendSettled = true;
                  recordCachedTokens(provider.name, result.cachedTokens ?? 0);
                }
                clearCredentialCooldown(credentialId);
                recordTokenUsage(provider.name, result.usage);
                await recordResponseTelemetry({
                  response: result,
                  provider: provider.name,
                  requestedModels: result.requestedModels ?? [providerModel(provider)],
                  execution: {
                    ...execution,
                    role: execution?.role ?? this.config.role,
                  },
                  hadTools: Boolean(tools?.length),
                });
                return result;
              } catch (error) {
                // The request was reserved before dispatch, so a failure the
                // provider actually served stays charged to the correct pool.
                // A routing DEFECT is refunded instead: a 404/400 means no
                // generation was requested, and charging those is what let a
                // rung pinned to a withdrawn `:free` slug drain half the daily
                // allowance while the pool still had live capacity.
                const err = error as ProviderRequestError;
                const status = err.status;
                if (paidReservation?.held && !paidSpendSettled && (status === undefined || status >= 500)) {
                  // A timeout/transport failure or malformed served generation
                  // may still be billed upstream. Keep its conservative maximum
                  // in the ledger instead of refunding unknown cost and retrying
                  // indefinitely against the same dollars.
                  recordSpend(provider.name, paidReservation.heldMicros / 1_000_000);
                  paidSpendSettled = true;
                }
                if (isRoutingDefectStatus(status)) {
                  releaseProviderAttempt(provider, credential.key);
                }
                const message =
                  err.name === 'AbortError' ? 'request timed out' : err.message;
                const requestedModels = err.requestedModels?.length
                  ? err.requestedModels
                  : hasCustomOpenRouterModelPolicy()
                    ? getOpenRouterModelChainForRole(this.config.role)
                    : [providerModel(provider)];
                const attemptedModel = requestedModels[0] ?? providerModel(provider);
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
                if (isOpenRouterProvider(provider)) {
                  // A free-route quota or rate limit excludes only the
                  // account's free routing; its paid route stays usable.
                  excludeOpenRouterAccountForFailure(
                    credential.key,
                    status,
                    message,
                    err.retryAfterMs,
                    Date.now(),
                    provider.paid !== true,
                  );
                }
                setProviderCooldown(provider, status, message, err.retryAfterMs);
                const capacityFailure = isCapacityFailure(status, message);
                const correctableRequestFailure = isRequestTooLargeError(status, message);
                const authFailure = isAuthFailure(status, message);
                if (authFailure) {
                  authFailureCount++;
                } else if (!capacityFailure && !correctableRequestFailure) {
                  nonCapacityFailureSeen = true;
                }
                const newCooldown =
                  credentialCooldown(credentialId);
                const newAccountExclusion = isOpenRouterProvider(provider)
                  ? getOpenRouterAccountExclusion(credential.key, {
                      paid: provider.paid,
                    })
                  : null;
                if (newCooldown?.capacityPause || newAccountExclusion) {
                  capacityBlocks.push({
                    source: newAccountExclusion?.account ?? credentialId,
                    resumeAt:
                      newAccountExclusion?.resumeAt ??
                      (newCooldown ? new Date(newCooldown.until).toISOString() : null),
                    reason: newAccountExclusion?.reason ?? message.slice(0, 240),
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
                    const allWindow = independentPlanRoute(provider)
                      ? null
                      : emergencyRequestCapacityWindow(Date.now());
                    const poolWindow = paidReservation?.held
                      ? { allowed: true } // This refused (413) request already owns a sufficient dollar hold.
                      : requestWindowForProvider(
                          provider,
                          Date.now(),
                          pacingOverride,
                          spendPriority,
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
                    if (freeShareResource) recordWorkClassUsage(freeShareResource, workClass, 1);
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
                        result.costUsd ?? estimatedCostUsd(provider, result.usage, result.cachedTokens ?? 0),
                      );
                      paidSpendSettled = true;
                      recordCachedTokens(provider.name, result.cachedTokens ?? 0);
                    }
                    clearCredentialCooldown(credentialId);
                    recordTokenUsage(provider.name, result.usage);
                    await recordResponseTelemetry({
                      response: result,
                      provider: provider.name,
                      requestedModels: result.requestedModels ?? [providerModel(provider)],
                      execution: {
                        ...execution,
                        role: execution?.role ?? this.config.role,
                      },
                      hadTools: Boolean(tools?.length),
                    });
                    return result;
                  } catch (retryError) {
                    // The retry was already reserved, so a served-but-refused
                    // failure stays correctly counted. A routing DEFECT is
                    // refunded here too, matching the first dispatch above.
                    const retryStatus = (retryError as ProviderRequestError).status;
                    if (paidReservation?.held && !paidSpendSettled && (retryStatus === undefined || retryStatus >= 500)) {
                      recordSpend(provider.name, paidReservation.heldMicros / 1_000_000);
                      paidSpendSettled = true;
                    }
                    if (isRoutingDefectStatus(retryStatus)) {
                      releaseProviderAttempt(provider, credential.key);
                    }
                  }
                }
              } finally {
                paidReservation?.release();
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
        const hasProviderCapacity = capacityBlocks.some(
          (b) => b.source !== 'workspace' && b.source !== 'free-byok-providers',
        );
        const canPause =
          capacityBlocks.length > 0 &&
          !nonCapacityFailureSeen &&
          (authFailureCount === 0 || hasProviderCapacity);
        if (canPause) {
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
      if (operatorLane) operatorLane.release();
      else releaseLLMConcurrencySlot();
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
  // Advertise the route actually attempted first for this role: the free
  // policy gateway with the role's first selected model when an operator
  // OpenRouter model policy is saved, otherwise the head of PROVIDER_ORDER.
  const primaryName = activeProviderOrder(role)[0] ?? PROVIDER_ORDER[0];
  const primary = PROVIDER_BY_NAME.get(primaryName);
  const model =
    primaryName === FREE_POLICY_GATEWAY_NAME
      ? getOpenRouterModelChainForRole(role)[0] ?? DEFAULT_OPENROUTER_MODEL_CHAIN[0]
      : (primary ? providerModel(primary) : DEFAULT_OPENROUTER_MODEL_CHAIN[0]);

  return {
    provider: primary?.name ?? PROVIDER_ORDER[0],
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

/** Embedding-pipeline state for authenticated GET /api/health/detail, so
 *  "is semantic recall actually working" stops being a question only the
 *  logs can answer. Public GET /health does not include it. */
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

export function getProviderAccountExclusionReport() {
  const envNames = new Set(
    PROVIDERS
      .filter(isOpenRouterProvider)
      .flatMap((provider) => provider.apiKeyEnvs),
  );
  return buildOpenRouterAccountExclusionReport(
    [...envNames]
      .map((env) => ({ env, key: process.env[env] ?? '' }))
      .filter(({ key }) => Boolean(key)),
  );
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

  // Compatibility counters name free capacity, so never count metered Qwen.
  const freeProviders = providers.filter((provider) => !provider.paid);
  return {
    providers,
    freeSlots: freeProviders.length,
    freeSlotsConfigured: freeProviders.filter((provider) => provider.configured).length,
    emptyFreeSlots: freeProviders
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
      model: providerModel(provider),
      tier: index,
      paid: provider.paid === true,
      supportsParallelToolCalls: provider.supportsParallelToolCalls === true,
      toolCallingReliable: true,
      usesFreeCredentials: providerUsesFreeCredentials(provider.name),
      requireParametersWhenToolsPresent: providerModel(provider).toLowerCase() === 'openrouter/free',
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
    'SERPER_API_KEY',
    'BRIGHT_DATA_API_KEY',
    'BRIGHT_DATA_ZONE',
    'VAPI_API_KEY',
    'TELNYX_API_KEY',
    'TELNYX_CALL_BRIDGE_CONNECTION_ID',
    'TELNYX_CALL_BRIDGE_WEBHOOK_SECRET',
    'APEX_FRONT_DESK_NUMBER',
    'TELNYX_OWNER_NUMBER',
    'APEX_HANK_LIVE_KEY',
    'TELNYX_WEBHOOK_SECRET',
    'DEEPGRAM_API_KEY',
    'ELEVENLABS_API_KEY',
    'CASEBUDDY_SUPABASE_URL',
    'CASEBUDDY_SUPABASE_SERVICE_KEY',
    'CASEBUDDY_SYSTEM_USER_ID',
    'STRIPE_SECRET_KEY',
    'APEX_APPROVAL_MODE',
  ];
}

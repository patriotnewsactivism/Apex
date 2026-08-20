import type { LLMClientConfig, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './types.js';
import {
  isProviderOverDailyCap,
  isTotalDailyCapReached,
  msUntilDailyReset,
  providerTokensToday,
  recordTokenUsage,
} from './token-ledger.js';

// ─── Multi-Provider Fallback Client ───────────────────────────────────────────
//
// REORDERED 2026-08-15 for maximum exhaustion resistance. Key principles:
//   1. Providers with the LARGEST daily/monthly budgets go first so the chain
//      absorbs the most traffic before falling through.
//   2. Duplicate-key slots (CEREBRAS_API_KEY_2/3, GROQ_API_KEY_2, GEMINI_API_KEY_2)
//      multiply free-tier rate limits — each is a real PROVIDERS entry now, not
//      just a comment.
//   3. Two-pass fallback: toolCallingReliable:false providers are skipped on
//      tool-bearing requests and only tried as last resort.
//   4. Dead/expired-key entries are DEMOTED, not removed — behind the circuit
//      breaker they cost one skipped probe per cooldown, and keeping them means
//      zero-code-change recovery when keys are rotated or billing is sorted.
//
// Chain order (12 entries, 4 tiers as of 2026-08-19 — see `tier` field on
// each PROVIDERS entry; tier is now enforced in code, not just documented):
//
//   Tier 0 (paid anchor — always tried first, ends the free-tier cascade):
//     OpenRouter → anthropic/claude-sonnet-5 ($2/$10 per M, real per-call cost)
//
//   Tier 1 (live, tool-reliable, ordered by daily capacity):
//     Mistral (1B tok/mo) → Gemini ×2 (1,500 RPD each) →
//     Cerebras ($5 credit) → Groq ×2 (100K TPD each) →
//     SambaNova ($5 credit + 20M TPD) → Hugging Face (free credits)
//
//   Tier 2 (demoted — no key configured, circuit breaker = cheap skip):
//     NVIDIA NIM
//
//   Tier 3 (last resort — unreliable tool calling):
//     OpenRouter/free router → OpenRouter-free ×2
//
// ROOT-CAUSE FIX 2026-08-19: rrStartIndex used to rotate across the entire
// flat array, defeating this tier ordering on all but 1 call in N (see
// rrStartIndexByTier below) — tier order is now unconditional; round-robin
// only spreads load within a tier. A process-wide concurrency semaphore
// (MAX_CONCURRENT_LLM_CALLS) also caps how many complete() calls can be
// mid-flight at once, so a large task backlog releasing at boot can't
// stampede tier 0/1 with ~20 simultaneous requests.
//
// 2026-08-16: xAI (403, credits exhausted) and Cohere/Cohere-trial (402/429,
// no payment method / trial cap reached) REMOVED outright, not demoted —
// explicit instruction, not the usual "keep for zero-code-change recovery"
// treatment every other dead entry gets. Re-add only if asked.
//
// Each provider uses the standard OpenAI-compatible chat completions shape,
// so the same request/response mapping logic is reused across all of them.

const PROVIDERS: Array<{
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  // Free providers only support specific model IDs — remap on fallback.
  fallbackModel?: string;
  // Some providers need specific headers
  extraHeaders?: Record<string, string>;
  // 'anthropic' routes through completeViaAnthropic() (Messages API wire
  // format) instead of the OpenAI-shaped chat.completions path below.
  // Undefined/omitted = 'openai', today's default for every existing entry.
  protocol?: 'openai' | 'anthropic';
  // Cap max_tokens per provider — some models reject requests with
  // max_tokens higher than their supported output limit (Cohere 400).
  maxOutputTokens?: number;
  // Total request budget in characters (messages + stringified tool schemas
  // combined) — trimmed to BEFORE the first attempt, not just after a 413.
  // Added 2026-08-16 for Groq: its free tier's TPM (tokens per minute) limit
  // reserves `max_tokens` against the SAME budget as the prompt, so a
  // premium-role request (maxTokens: 16384) alone already exceeds Groq's
  // 12,000 TPM cap before a single prompt token is counted — see
  // maxOutputTokens on the groq entries below, which fixes the dominant
  // cause. This field is the second layer: even with output capped, a long
  // conversation history can still push a single request over a small TPM
  // budget, and the existing 413-triggered EMERGENCY_HISTORY_CHAR_BUDGET
  // retry only fires AFTER wasting one guaranteed-fail attempt. Providers
  // with a known small per-minute/per-request cap should set this so the
  // first attempt is already sized to fit.
  maxRequestChars?: number;
  // FALSE = this provider's model does not reliably emit structured tool
  // calls. Added 2026-07-29 after persistActualProvider (finally wired up)
  // revealed 11 of 13 live agents had fallen through to
  // cohere/command-r-plus and QA Director to gpt-oss-20b:free, because
  // cerebras and groq were both exhausted. Every symptom that day traced to
  // it: agents answering "I am unable to access the code" without ever
  // calling readFile, "I couldn't find any results" without ever calling
  // searchBusinessDirectory (which returns 20 real businesses when called
  // directly), tool calls emitted as literal text, and all-N/A reports.
  // The workforce was not broken — it was running on a tier that cannot
  // drive tools, and nothing said so.
  toolCallingReliable?: boolean;
  // Priority tier — ADDED 2026-08-19 per root-cause finding: rrStartIndex
  // previously round-robined across the ENTIRE flat array regardless of
  // this comment block's documented tier structure, so "largest budget/paid
  // anchor first" only actually held on 1 call in N. Lower tier = tried
  // first, always, for every call. Round-robin (load spreading across
  // concurrent calls) still applies, but only WITHIN a tier — it can no
  // longer cause a tier-0 paid anchor or a tier-1 large-budget free
  // provider to be skipped in favor of a later tier just because of where
  // rrStartIndex happened to land. Omitted = tier 1 (default free/reliable).
  tier?: number;
}> = [
  // ── Tier 0: Paid anchor — ends the correlated free-tier cascade ────────────
  //
  // ADDED 2026-08-19 per root-cause finding: every Tier 1 provider below is a
  // free tier, and free tiers share a correlated failure mode — they all
  // exhaust on the same busy day. "All providers failed" was never bad luck;
  // it was the designed behavior of a chain made entirely of free quotas with
  // no paid floor under it. anthropic/claude-sonnet-5 via OpenRouter is a
  // zero-code-change frontier path: OPENROUTER_API_KEY, baseURL, headers, and
  // wire format are already wired up for the Tier C openrouter-free* entries
  // below — this just points the SAME client at a paid, non-":free" model.
  // Confirmed live, tool-calling capable, $2/$10 per M tokens. This is a real
  // (small) per-call cost, unlike every other entry in this file — that's the
  // point: one reliable rung stops the whole workforce going dead whenever
  // Mistral/Gemini/Cerebras/Groq/SambaNova all happen to be tapped out at once.
  { name: 'openrouter-paid-anchor', tier: 0, baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'anthropic/claude-sonnet-5', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },

  // ── Tier 1: Live, tool-calling reliable, ordered by daily capacity ──────────
  //
  // REORDERED 2026-08-15 to maximize exhaustion resistance. Providers with the
  // LARGEST daily/monthly budgets go first. Round-robin start index spreads
  // concurrent load across entries WITHIN this tier only (see `tier` field).

  // Mistral (La Plateforme) — #1 POSITION: 1B tokens/month free tier (~33M
  // tokens/day) is by far the largest budget in this entire chain — more than
  // every other free tier combined. Reliable tool calling via mistral-small-
  // latest. Free tier: 30 RPM, ~1 RPS global limit.
  { name: 'mistral', baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', fallbackModel: 'mistral-small-latest' },

  // Google Gemini — permanent free tier: 1,500 RPD, 15 RPM, 250K TPM.
  //
  // MODEL ID — 2026-08-16: this string had been changed 4 times across prior
  // commits (gemini-1.5-flash-latest → gemini-flash-latest → gemini-3.6-flash
  // → gemini-3.5-flash) by different sessions, none of which verified the
  // change against a live source before committing — pure guessing, and the
  // 400s never stopped because nobody confirmed which guess (if any) was
  // right. Verified this time via a live fetch of ai.google.dev/gemini-api/
  // docs/models: gemini-3.7-flash is Google's current "New Stable" flash
  // model, explicitly described as built for "complex coding, agentic
  // workflows, and reliable multi-step execution" — the exact shape of this
  // system's workload. A rolling `gemini-flash-latest` alias also exists but
  // Google's own docs recommend pinning a stable version for production
  // rather than an alias that can hot-swap underlying models with only two
  // weeks' notice. DO NOT change this string again without a live probe
  // (scripts/llm-probe.mjs) or a fresh docs fetch confirming the new value —
  // the 400s this system has been seeing are NOT proof the model id is
  // wrong; verify before guessing.
  { name: 'google-gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', fallbackModel: 'gemini-3.7-flash' },

  // Google Gemini (2nd project) — separate Google Cloud project = separate
  // quota, doubling Gemini's effective daily capacity to 3,000 RPD.
  { name: 'google-gemini-2', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY_2', fallbackModel: 'gemini-3.7-flash' },

  // Cerebras — $5 free credit per account, 30 RPM, ~3000 tok/s inference.
  // gpt-oss-120b on Cerebras hardware. Credits expire 30 days after creation.
  { name: 'cerebras', baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY', fallbackModel: 'gpt-oss-120b' },

  // Cerebras (2nd account) — separate account = separate $5 credit + rate limit.
  
  // Cerebras (3rd account) — triple the rate-limit pool.
  
  // Groq — permanent free tier: 30 RPM, 14,400 RPD. openai/gpt-oss-120b,
  // reliable tool calling. Daily token quota resets at midnight UTC.
  //
  // 413 FIX — 2026-08-16: live errors showed "TPM Limit 12000, Requested
  // 19198-27829" on nearly every call, across wildly different history sizes
  // — the constant wasn't the prompt, it was `max_tokens`. Groq's on_demand
  // TPM check reserves `max_tokens` against the SAME 12,000-token budget as
  // the prompt, and premium roles (CEO/COO/CTO/SALES/...) request
  // maxTokens:16384 by default — already 4,384 tokens OVER the entire quota
  // before one prompt token is counted. No amount of message-history
  // trimming could ever have fixed this; that's why the existing
  // 413-triggered emergency retry (EMERGENCY_HISTORY_CHAR_BUDGET) kept
  // re-failing. maxOutputTokens caps the response reservation well under the
  // quota; maxRequestChars pre-trims the prompt on the FIRST attempt instead
  // of wasting one guaranteed-fail request to discover it's oversized.
  // MODEL ID — 2026-08-19: corrected to openai/gpt-oss-120b, VERIFIED against
  // console.groq.com/docs/models (Production Models) and /docs/deprecations.
  // Both prior values are decommissioned and 404 on every call:
  //   • llama-3.3-70b-versatile — deprecated 2026-06-17, SHUT DOWN 2026-08-16.
  //   • llama-3.1-70b-versatile — SHUT DOWN 2025-01-24, i.e. dead ~19 months
  //     before the 2026-08-17 commit that "fixed" 3.3 → 3.1. That change swapped
  //     a freshly-dead model for a long-dead one and was never verified against
  //     Groq's docs; it made the outage permanent rather than resolving it.
  // openai/gpt-oss-120b is Groq's own documented migration target for
  // llama-3.3-70b-versatile and is listed under Production Models with tool-use
  // support. Same model family already used by the cerebras/sambanova entries
  // (those are unprefixed 'gpt-oss-120b'; Groq namespaces it as 'openai/...').
  // DO NOT change this string again without a live probe (scripts/llm-probe.mjs)
  // or a fresh docs fetch — Groq retires models aggressively and guessing is
  // exactly how this entry stayed broken across three separate commits.
  { name: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', fallbackModel: 'openai/gpt-oss-120b', maxOutputTokens: 3072, maxRequestChars: 32_000 },

  // Groq (2nd org) — separate org = 2x daily token capacity (200K TPD total).
  // Same 12,000 TPM ceiling per org as groq above — same caps apply.
  { name: 'groq-2', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY_2', fallbackModel: 'openai/gpt-oss-120b', maxOutputTokens: 3072, maxRequestChars: 32_000 },

  // SambaNova — $5 signup credit, 20M TPD developer tier. OpenAI-compatible,
  // gpt-oss-120b on SambaNova RDU hardware. Tool calling reliable.
  { name: 'sambanova', baseURL: 'https://api.sambanova.ai/v1', apiKeyEnv: 'SAMBANOVA_API_KEY', fallbackModel: 'gpt-oss-120b' },

  // Hugging Face Inference Providers — free inference credits for new users +
  // PRO subscribers. OpenAI-compatible router at router.huggingface.co.
  // Llama 3.3 70B Instruct, tool calling reliable.
  { name: 'huggingface', baseURL: 'https://router.huggingface.co/v1', apiKeyEnv: 'HF_TOKEN', fallbackModel: 'meta-llama/Llama-3.3-70B-Instruct' },

  // ── Tier 2: Demoted — kept for zero-code-change recovery only ─────────────
  //
  // CLEANED UP 2026-08-19: poolside/together/deepseek/qwen-cloud x3/glm-zai
  // were previously listed here as demoted-but-present entries. All were
  // actually removed as real PROVIDERS entries in commit 071b47a (2026-08-19,
  // same-day earlier fix) because each was structurally broken regardless of
  // key/billing state, not just rate-limited or unfunded:
  //   • together    — model ID carried a bogus "Meta-" prefix, 404s always.
  //   • poolside     — api.poolside.ai does not resolve in DNS at all; a
  //                     connection error has no HTTP status, so it fell into
  //                     the circuit breaker's 30s cooldown bucket and got
  //                     retried forever instead of being backed off properly.
  //   • qwen-cloud-anthropic — baseURL double-appended /v1, so the SDK POSTed
  //                     to .../compatible-mode/v1/v1/messages — always 404.
  //   • deepseek, qwen-cloud, qwen-cloud-anthropic (paid), glm-zai — dead
  //     keys/billing, no path to zero-code-change recovery without Don
  //     rotating a key anyway, so keeping the broken entry bought nothing.
  // If Don rotates a fresh QWENCLOUD_API_KEY or fixes any of the above, ADD
  // A NEW ENTRY with the defect fixed rather than resurrecting the old one.
  //
  // NVIDIA NIM — free tier at build.nvidia.com. Llama 3.3 70B, tool-calling
  // reliable. NOT configured on Railway/Lightsail — no-op until the key is
  // added. FLAGGED 2026-08-19: meta/llama-3.3-70b-instruct deprecates
  // 2026-08-25 — if NVIDIA_API_KEY is ever added, verify the model ID is
  // still current before relying on this entry after that date.
  { name: 'nvidia', tier: 2, baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', fallbackModel: 'meta/llama-3.3-70b-instruct' },

  // ── Tier 3: Last resort — unreliable or best-effort tool calling ───────────
  // Reached only after all reliable providers fail (two-pass fallback).

  // OpenRouter smart router — `openrouter/free` auto-selects a free model that
  // supports the requested capabilities (including tool calling). Better than
  // the explicit :free model entries because it filters for tool-capable models.
  // Still marked unreliable as a safety measure: free-tier models rotate and
  // tool quality varies across underlying models.
  { name: 'openrouter-free-router', tier: 3, toolCallingReliable: false, baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'openrouter/free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },

  // OpenRouter FREE tier — explicit free models, daily-quota 429s self-reset.
  { name: 'openrouter-free', tier: 3, toolCallingReliable: false, baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'openai/gpt-oss-20b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
  { name: 'openrouter-free-2', tier: 3, toolCallingReliable: false, baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'nvidia/nemotron-3-super-120b-a12b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },

];

// ─── Role-aware Qwen Cloud model selection ─────────────────────────────────
//
// ADDED 2026-07-27 per Don's explicit request: CEO/CTO/COO and the other
// high-stakes/high-budget roles ("premium" tier — reusing the exact role set
// already defined as the 16384-token tier in getDefaultLLMConfig below, so
// this doesn't drift from that split) get Qwen's strongest reasoning model
// instead of the balanced default. Both qwen-cloud entries resolve their
// model through this instead of a static fallbackModel string. Overridable
// via env for easy A/B against qwen3.8-max-preview (Token Plan only, newer/
// less proven than the GA qwen3.7-max) without another code change.
const PREMIUM_ROLES = new Set([
  'CEO', 'CTO', 'COO', 'LEAD_DEV', 'RESEARCH', 'LEAD_RESEARCH', 'SALES', 'QA_DIRECTOR',
]);

// ─── Request size control ─────────────────────────────────────────────────────
//
// Observed live 2026-07-28: every agent task died with "All LLM providers
// failed", and the chain read:
//   • cerebras (gpt-oss-120b, 429): rate limited
//   • groq (llama-3.3-70b-versatile, 413): Request too large … tokens per minute
//
// The 413 is the important one. A 429 is genuinely "come back later", but a
// 413 means THIS request will never fit — and because every downstream
// provider was handed the identical oversized `messages` array, one bloated
// conversation failed the ENTIRE fallback chain. The fallback existed and was
// structurally incapable of rescuing anything.
//
// Histories grow without bound: every tool result is appended, and agents run
// up to 50 iterations (Lead Research). Tool results are the bulk of it —
// search results, file contents, snapshot JSON. So trim tool output, not turns.
//
// Deliberately truncates message CONTENT rather than dropping messages: an
// assistant message carrying tool_calls MUST be followed by its matching tool
// results or the OpenAI-shaped APIs reject the request outright. Dropping
// messages to save space would trade a 413 for a 400.

/** Rough chars-per-token. Deliberately conservative — this is a safety budget,
 *  not an accounting system, and over-trimming costs far less than a 413. */
const CHARS_PER_TOKEN = 4;

/** Default budget in characters (~15k tokens).
 *
 * Was 120_000 (~30k tokens) until 2026-08-04. That budget was fatal for the
 * free tiers this chain depends on: Groq's TPD limit is 100k tokens, so ONE
 * 30k-token request consumed ~30% of an org's entire day — live logs showed
 * requests of 10k-30k tokens exhausting every provider by mid-afternoon and
 * the workforce degrading to prose-only cohere answers. 60k keeps the system
 * prompt + task + recent context intact while roughly doubling how many tasks
 * the free-tier capacity can serve. */
export const DEFAULT_HISTORY_CHAR_BUDGET = 60_000;

/** Hard retry budget (~6k tokens) used for the one retry after a 413. */
export const EMERGENCY_HISTORY_CHAR_BUDGET = 24_000;

export function historySize(messages: LLMMessage[]): number {
  return messages.reduce(
    (n, m) => n + (m.content?.length ?? 0) + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0),
    0,
  );
}

/**
 * Shrink a conversation to fit `maxChars` while keeping it structurally valid.
 *
 * Priority of what survives, highest first: the system prompt, the first user
 * message (the task itself — losing it makes the agent forget what it was
 * asked), and the most recent turns. Oldest tool results are truncated first,
 * since they are both the largest and the least likely to still matter.
 */
export function trimMessageHistory(
  messages: LLMMessage[],
  maxChars: number = DEFAULT_HISTORY_CHAR_BUDGET,
): { messages: LLMMessage[]; trimmed: boolean; originalChars: number; finalChars: number } {
  const originalChars = historySize(messages);
  if (originalChars <= maxChars) {
    return { messages, trimmed: false, originalChars, finalChars: originalChars };
  }

  const out = messages.map((m) => ({ ...m }));
  const marker = '\n… [truncated to fit the provider request limit]';

  // Never touch the last 4 messages — that's the live working context the
  // model needs to make its next decision.
  const protectedFrom = Math.max(0, out.length - 4);

  // Pass 1: oldest tool results down to a stub. Biggest win, least loss.
  for (let i = 0; i < protectedFrom && historySize(out) > maxChars; i++) {
    if (out[i].role !== 'tool') continue;
    const c = out[i].content ?? '';
    if (c.length > 400) out[i].content = c.slice(0, 400) + marker;
  }

  // Pass 2: still too big — trim old assistant prose (keep toolCalls intact,
  // they are structural and small).
  for (let i = 0; i < protectedFrom && historySize(out) > maxChars; i++) {
    if (out[i].role !== 'assistant') continue;
    const c = out[i].content ?? '';
    if (c.length > 500) out[i].content = c.slice(0, 500) + marker;
  }

  // Pass 3: squeeze the protected tail too, oldest first, but keep it usable.
  for (let i = protectedFrom; i < out.length && historySize(out) > maxChars; i++) {
    const c = out[i].content ?? '';
    if (out[i].role === 'tool' && c.length > 1_000) out[i].content = c.slice(0, 1_000) + marker;
  }

  // Pass 4: the emergency floor. Passes 1-3 bottom out around 25k chars on a
  // long run (40+ tool results at a 400-char stub each), which is ABOVE the
  // emergency budget — so a 413 retry would have 413'd again. Squeeze every
  // tool result to a stub and every assistant turn to a summary line.
  // tool_calls are left intact throughout: they are structural, and dropping
  // them breaks assistant→tool pairing.
  for (let i = 0; i < out.length && historySize(out) > maxChars; i++) {
    const c = out[i].content ?? '';
    if (out[i].role === 'tool' && c.length > 120) out[i].content = c.slice(0, 120) + marker;
    else if (out[i].role === 'assistant' && c.length > 200) out[i].content = c.slice(0, 200) + marker;
  }

  // Pass 5: absolute last resort — the system prompt itself. It carries the
  // agent's role and org chart at the HEAD, with memory context and learning
  // insights appended at the TAIL (see BaseAgent.executeTask), so truncating
  // from the end sheds the accumulated context and keeps the identity. Only
  // reached when everything else has already been stubbed.
  if (historySize(out) > maxChars && out[0]?.role === 'system') {
    const c = out[0].content ?? '';
    if (c.length > 6_000) out[0].content = c.slice(0, 6_000) + marker;
  }

  return { messages: out, trimmed: true, originalChars, finalChars: historySize(out) };
}

/** True when a provider error means "this request is too big" rather than
 *  "you are going too fast". The two demand opposite responses: shrink and
 *  retry vs. back off and wait. */
export function isRequestTooLargeError(status: unknown, message: string): boolean {
  if (status === 413) return true;
  return /request too large|too many tokens|context length|maximum context|reduce the length|prompt is too long/i.test(
    message,
  );
}

function resolveQwenModel(role: string | undefined): string {
  const isPremium = role !== undefined && PREMIUM_ROLES.has(role);
  const envOverride = isPremium ? process.env.APEX_QWEN_PREMIUM_MODEL : process.env.APEX_QWEN_STANDARD_MODEL;
  if (envOverride) return envOverride;
  return isPremium ? 'qwen3.7-max' : 'qwen3.7-plus';
}

// ─── Anthropic Messages API conversion helpers ────────────────────────────────
//
// The Anthropic wire format differs from OpenAI's chat.completions shape in
// three load-bearing ways: (1) system prompt is a top-level `system` string
// field, never a message with role:'system'; (2) every tool_result for a given
// turn must be batched into ONE role:'user' message's content array — Anthropic
// docs call splitting them across messages harmful ("silently trains Claude to
// stop making parallel calls"); (3) tool schemas use `input_schema`, not
// `parameters`. This function walks the internal LLMMessage[] history once and
// produces both the extracted system string and the batched message array.

function buildAnthropicMessages(messages: LLMMessage[]): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }>;
} {
  const systemParts: string[] = [];
  const result: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = [];

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];

    if (m.role === 'system') {
      systemParts.push(m.content);
      i++;
      continue;
    }

    if (m.role === 'tool') {
      // Batch every consecutive tool result into one user message's content array.
      const toolResultBlocks: Array<Record<string, unknown>> = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const tm = messages[i];
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tm.toolCallId ?? '', content: tm.content });
        i++;
      }
      result.push({ role: 'user', content: toolResultBlocks });
      continue;
    }

    if (m.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      result.push({ role: 'assistant', content });
      i++;
      continue;
    }

    // user
    result.push({ role: 'user', content: m.content });
    i++;
  }

  return { system: systemParts.join('\n\n'), messages: result };
}

class MultiProviderClient {
  private config: LLMClientConfig;

  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  /** Anthropic Messages API path — see buildAnthropicMessages() above for why
   * this can't just reuse the OpenAI-shaped request builder. Mirrors the same
   * timeout/AbortController/error-capture scaffolding the OpenAI path uses
   * below; only the request-building and response-parsing differ. */
  private async completeViaAnthropic(
    provider: { name: string; baseURL: string; maxOutputTokens?: number },
    apiKey: string,
    model: string,
    messages: LLMMessage[],
    tools: LLMTool[] | undefined,
  ): Promise<LLMResponse> {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;

    const client = new Anthropic({
      apiKey,
      baseURL: provider.baseURL,
      timeout: 75_000,
      maxRetries: 0,
    });

    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);
    const anthropicTools = tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 75_000);
    let res;
    try {
      res = await client.messages.create(
        {
          model,
          system: system || undefined,
          messages: anthropicMessages as any,
          tools: anthropicTools && anthropicTools.length > 0 ? (anthropicTools as any) : undefined,
          max_tokens: Math.min(this.config.maxTokens ?? 4096, provider.maxOutputTokens ?? 32768),
          temperature: this.config.temperature ?? 0.7,
        },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    let content = '';
    const toolCalls: LLMToolCall[] = [];
    for (const block of res.content) {
      if (block.type === 'text') content += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input as Record<string, unknown> });
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: res.usage?.input_tokens ?? 0,
        completionTokens: res.usage?.output_tokens ?? 0,
      },
      model: `${provider.name}/${res.model}`,
    };
  }

  // PUBLIC ENTRY POINT — gates on the process-wide LLM concurrency semaphore
  // (see acquireLLMConcurrencySlot below) before doing any real work. Root-
  // cause finding 2026-08-19: 345 tasks releasing at once across 13 agents
  // (several at concurrency 4-5) means up to ~20 concurrent complete() calls
  // can fire within the same second on a fresh boot or after a backlog
  // clears — every one of them tries the SAME tier-0/tier-1 provider first,
  // which is exactly a 429 stampede against a 30 RPM free-tier limit. This
  // caps how many complete() calls are actually making outbound HTTP
  // requests at once, process-wide, independent of each agent's own
  // concurrency setting (which only bounds ONE agent's in-flight tasks, not
  // the whole process's in-flight LLM calls).
  async complete(rawMessages: LLMMessage[], tools?: LLMTool[]): Promise<LLMResponse> {
    await acquireLLMConcurrencySlot();
    try {
      return await this.completeInner(rawMessages, tools);
    } finally {
      releaseLLMConcurrencySlot();
    }
  }

  private async completeInner(rawMessages: LLMMessage[], tools?: LLMTool[]): Promise<LLMResponse> {
    const OpenAI = (await import('openai')).default;

    // ── Workspace-wide daily token cap (token-ledger.ts) ────────────────────
    // Fail fast and honestly instead of walking 15 providers to collect 15
    // 429s. Unset/0 = no cap, i.e. exactly the pre-2026-08-19 behavior.
    if (isTotalDailyCapReached()) {
      throw new Error(
        `APEX daily token cap reached (APEX_TOKEN_CAP_TOTAL) — LLM spend is paused until the UTC daily reset ` +
          `in ~${Math.round(msUntilDailyReset() / 60000)} min. Raise APEX_TOKEN_CAP_TOTAL to continue today.`,
      );
    }

    // Cap the conversation BEFORE any provider sees it. Previously an
    // overgrown history was handed unchanged to every provider in turn, so a
    // single bloated task could 413 its way through the entire chain and
    // report "All LLM providers failed" — making a size problem look like a
    // capacity outage.
    const trim = trimMessageHistory(rawMessages);
    if (trim.trimmed) {
      console.warn(
        `[LLM] History trimmed ${trim.originalChars} → ${trim.finalChars} chars to stay under the request limit`,
      );
    }
    const messages = trim.messages;

    const buildOpenAIMessages = (msgs: LLMMessage[]) => msgs.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, content: m.content, tool_call_id: m.toolCallId ?? '' };
      }
      if (m.role === 'assistant') {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.toolCalls && m.toolCalls.length > 0
            ? m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              }))
            : undefined,
        };
      }
      return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
    });

    const openaiMessages = buildOpenAIMessages(messages);

    const openaiTools = tools?.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const providerErrors: Array<{ provider: string; model: string; status?: number; message: string }> = [];

    // Two-pass fallback: first try only reliable providers, then fall to
    // unreliable ones as last resort if everything else fails.
    let lastResortMode = false;
    // If the last request totally exhausted all providers, wait before trying
    // again — stampeding 13 agents into a dead provider chain wastes tokens
    // and generates noise. Let the providers recover.
    const sinceTotalFailure = Date.now() - lastTotalFailureAt;
    const dynamicBackoffMs = Math.min(
      Math.max(GLOBAL_BACKOFF_FLOOR_MS, getShortestActiveCooldownMs()),
      GLOBAL_BACKOFF_CAP_MS,
    );
    if (sinceTotalFailure < dynamicBackoffMs) {
      const waitMs = dynamicBackoffMs - sinceTotalFailure;
      console.warn(`[LLM] Global backoff: waiting ${Math.round(waitMs / 1000)}s before retrying — all providers recently exhausted (sized to shortest active cooldown, floor ${GLOBAL_BACKOFF_FLOOR_MS / 1000}s, cap ${GLOBAL_BACKOFF_CAP_MS / 1000}s)`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Build a round-robin ordered provider list.
    //
    // FIXED 2026-08-19 — root-cause finding: this used to rotate the start
    // index across the ENTIRE flat PROVIDERS array, so the documented
    // "paid anchor / largest budget first" tier ordering only actually held
    // on 1 call in PROVIDERS.length; the rest of the time a later-tier
    // provider got tried before an earlier, higher-priority one purely
    // because of where rrStartIndex happened to land that call. Tiers now
    // determine priority ORDER unconditionally (tier 0 paid anchor always
    // considered before tier 1 free providers, always before tier 2/3);
    // round-robin only spreads concurrent load WITHIN a tier, by rotating a
    // separate start index per tier so it can't cross a tier boundary.
    const byTier = new Map<number, typeof PROVIDERS>();
    for (const p of PROVIDERS) {
      const t = p.tier ?? 1;
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t)!.push(p);
    }
    const sortedTiers = [...byTier.keys()].sort((a, b) => a - b);
    const reliableProviders: typeof PROVIDERS = [];
    const unreliableProviders: typeof PROVIDERS = [];
    for (const t of sortedTiers) {
      const group = byTier.get(t)!;
      const startIdx = rrStartIndexByTier.get(t) ?? 0;
      for (let i = 0; i < group.length; i++) {
        const p = group[(startIdx + i) % group.length];
        if (p.toolCallingReliable === false) {
          unreliableProviders.push(p);
        } else {
          reliableProviders.push(p);
        }
      }
      rrStartIndexByTier.set(t, (startIdx + 1) % group.length); // rotate this tier for next call
    }

    for (let pass = 0; pass <= 1; pass++) {
      if (pass === 1) {
        // BUG FIX 2026-08-12: this used to `break` when providerErrors was
        // empty, on the theory that empty errors meant "pass 0 already
        // succeeded." That's wrong — if pass 0 had succeeded, the function
        // would already have `return`ed above, so execution never reaches
        // here at all. Empty providerErrors at this point almost always
        // means every reliable provider was silently *skipped* (missing key
        // or circuit-breaker cooldown — neither path pushes to
        // providerErrors), NOT that the request succeeded. The old code
        // then skipped the last-resort unreliable-provider pass entirely,
        // surfacing a misleading "(no providers were configured or had API
        // keys)" error even when live last-resort providers (openrouter-free,
        // cohere-trial) were available and never got a chance to try.
        // Only skip pass 1 if there is genuinely nothing to try in it.
        if (unreliableProviders.length === 0) break;
        lastResortMode = true;
        console.warn(`[LLM] All reliable providers exhausted or in cooldown — starting last-resort pass with unreliable tool-calling providers`);
      }
    const orderedProviders = lastResortMode ? unreliableProviders : reliableProviders;
    for (const provider of orderedProviders) {
      const apiKey = process.env[provider.apiKeyEnv];
      if (!apiKey) {
        continue; // skip silently — no key configured
      }

      // Circuit breaker: skip providers in cooldown
      if (isProviderInCooldown(provider.name)) {
        console.warn(`[LLM] Skipping ${provider.name}: in cooldown (circuit breaker)`);
        continue;
      }

      // Budget governor (token-ledger.ts): skip a provider that has already
      // spent its configured daily token allowance. This is the PROACTIVE
      // counterpart to the circuit breaker — the breaker can only react after
      // a 429 has already been paid for out of the provider's per-day REQUEST
      // quota, whereas this never sends the request at all. No configured cap
      // for a provider = never skipped here.
      if (isProviderOverDailyCap(provider.name)) {
        console.warn(
          `[LLM] Skipping ${provider.name}: daily token budget spent (${providerTokensToday(provider.name)} tokens today, ` +
            `APEX_TOKEN_CAPS) — resets in ~${Math.round(msUntilDailyReset() / 60000)} min`,
        );
        setProviderCooldown(provider.name, 'daily-cap', undefined);
        continue;
      }

      // Defer unreliable providers for tool-bearing requests. They answer in
      // prose instead of emitting structured tool calls, which creates fake
      // "success" responses. On the first pass, skip them entirely so reliable
      // providers are preferred. If ALL reliable providers fail, we restart
      // the loop in lastResort mode and try them anyway — a prose-only answer
      // is better than the entire workforce going dead for hours.
      // (2026-08-04: 200+ requests fell through to cohere/openrouter-free
      // during provider exhaustion, producing pages of prose-only answers
      // that clogged the task backlog. But the opposite extreme — skipping
      // them entirely — caused total workforce failure when ALL reliable
      // providers hit daily caps. The two-pass approach gets the best of
      // both: prefer reliable providers, fall to unreliable as last resort.)
      if (provider.toolCallingReliable === false && openaiTools && openaiTools.length > 0) {
        if (!lastResortMode) {
          console.warn(`[LLM] Deferring ${provider.name}: toolCallingReliable=false and ${openaiTools.length} tool(s) offered — will retry as last resort if all reliable providers fail`);
          continue;
        }
        console.warn(`[LLM] LAST RESORT: trying ${provider.name} with unreliable tool calling — all reliable providers exhausted`);
      }

      // Mistral's role-aware model routing was removed 2026-07-26 along with
      // the Mistral provider entry itself (confirmed 401 invalid key, see
      // PROVIDERS above). Every OTHER remaining provider uses its plain
      // fallbackModel — except the two qwen-cloud entries, which resolve a
      // role-aware model via resolveQwenModel() (see above) instead.
      const model: string = provider.name.startsWith('qwen-cloud')
        ? resolveQwenModel(this.config.role)
        : (provider.fallbackModel ?? this.config.model);

      if (provider.protocol === 'anthropic') {
        try {
          const response = await this.completeViaAnthropic(provider, apiKey, model, messages, tools);
          recordTokenUsage(provider.name, response.usage);
          clearProviderCooldown(provider.name);
          if (providerErrors.length > 0) {
            console.warn(`[LLM] Succeeded with ${provider.name}/${model} after ${providerErrors.length} failed provider(s): ${providerErrors.map((e) => `${e.provider}(${e.status ?? '?'}: ${e.message})`).join(', ')}`);
          }
          return response;
        } catch (err) {
          const status = (err as any)?.status ?? (err as any)?.response?.status ?? (err as any)?.code;
          const errMessage = err instanceof Error ? err.message : String(err);
          const truncatedMsg = errMessage.length > 200 ? errMessage.slice(0, 200) + '…' : errMessage;
          console.error(`[LLM] Provider ${provider.name} failed — model: ${model}, status: ${status ?? 'N/A'}, error: ${truncatedMsg}`);
          providerErrors.push({ provider: provider.name, model, status, message: truncatedMsg });
          recordProviderFailure(provider.name, model, status, truncatedMsg);
          setProviderCooldown(provider.name, status, truncatedMsg);
          continue;
        }
      }

      // Pre-emptive per-provider trim: for providers with a known small
      // request budget (e.g. Groq's 12,000 TPM), shrink the FIRST attempt to
      // fit instead of wasting a guaranteed-fail round trip discovering it's
      // oversized (that's what the 413-triggered emergency retry further
      // down already does, but only after paying for one failure first).
      // Tool schemas count against the same budget on every provider here
      // but aren't part of `messages`, so they're measured and subtracted
      // from the budget before trimming.
      let providerOpenaiMessages = openaiMessages;
      if (provider.maxRequestChars) {
        const toolsChars = openaiTools ? JSON.stringify(openaiTools).length : 0;
        const budget = Math.max(EMERGENCY_HISTORY_CHAR_BUDGET, provider.maxRequestChars - toolsChars);
        if (historySize(messages) > budget) {
          const preTrim = trimMessageHistory(messages, budget);
          providerOpenaiMessages = buildOpenAIMessages(preTrim.messages);
          console.warn(
            `[LLM] Pre-trimming for ${provider.name}: ${preTrim.originalChars} → ${preTrim.finalChars} chars ` +
              `(provider budget ${provider.maxRequestChars}, ~${toolsChars} chars of tool schemas)`,
          );
        }
      }

      try {
        const defaultHeaders: Record<string, string> = {};
        if (provider.extraHeaders) {
          Object.assign(defaultHeaders, provider.extraHeaders);
        }

        const client = new OpenAI({
          apiKey,
          baseURL: provider.baseURL,
          defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
          timeout: 75_000, // hard cap: a hung provider must not freeze the whole agent forever
          maxRetries: 0, // we handle fallback across providers ourselves; don't double-retry inside one provider
        });

        // Belt-and-suspenders timeout: the client-level `timeout` above should abort
        // the underlying HTTP request, but wrap the call in our own race too so a
        // provider that hangs somewhere the SDK's own timeout doesn't cover (e.g. a
        // stalled stream, a hung DNS lookup) can never block this agent's loop forever.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 75_000);
        let res;
        try {
          const send = (msgs: typeof openaiMessages) =>
            client.chat.completions.create(
              {
                model,
                messages: msgs,
                tools: openaiTools && openaiTools.length > 0 ? openaiTools : undefined,
                temperature: this.config.temperature ?? 0.7,
                max_tokens: Math.min(this.config.maxTokens ?? 4096, provider.maxOutputTokens ?? 32768),
              },
              { signal: controller.signal },
            );

          try {
            res = await send(providerOpenaiMessages);
          } catch (err) {
            const status = (err as any)?.status ?? (err as any)?.response?.status;
            const msg = err instanceof Error ? err.message : String(err);

            if (status === 429 && isDailyQuotaError(msg)) {
              // 2026-08-13 fix: this provider's own error body says the
              // limit is a DAILY one (e.g. Groq "tokens per day (TPD)") —
              // it will not recover in the next 12 seconds. Skip the
              // in-request retry entirely and fall straight through to the
              // next provider; setProviderCooldown (below, in the catch
              // block at the outer scope) will also park this provider for
              // hours instead of the usual 30s.
              throw err;
            } else if (status === 429) {
              // Rate limited — retry this provider with backoff instead of
              // immediately falling through. Gemini free tier (15 RPM) and
              // Groq both 429 under concurrent agent load; retrying keeps
              // the request on a tool-calling provider instead of cascading
              // to cohere/openrouter-free which answer in prose.
              let recovered = false;
              for (let attempt = 1; attempt <= 2 && !recovered; attempt++) {
                const delayMs = 4000 * attempt;
                console.warn(`[LLM] ${provider.name}/${model} 429 rate limited, retry ${attempt}/2 in ${delayMs / 1000}s`);
                await new Promise(r => setTimeout(r, delayMs));
                try {
                  res = await send(providerOpenaiMessages);
                  recovered = true;
                } catch (retryErr) {
                  const retryStatus = (retryErr as any)?.status ?? (retryErr as any)?.response?.status;
                  if (isRequestTooLargeError(retryStatus, retryErr instanceof Error ? retryErr.message : String(retryErr))) {
                    const hard = trimMessageHistory(messages, EMERGENCY_HISTORY_CHAR_BUDGET);
                    res = await send(buildOpenAIMessages(hard.messages));
                    recovered = true;
                  } else if (attempt === 2 || retryStatus !== 429) {
                    throw retryErr;
                  }
                }
              }
              if (!recovered) throw err;
            } else if (isRequestTooLargeError(status, msg)) {
              // A 413 is recoverable HERE and nowhere else: moving to the next
              // provider carries the same oversized payload and earns the same
              // 413. Shrink hard and retry this provider once before giving up
              // on it. This is exactly what turned a transient cerebras 429 into
              // a total chain failure on 2026-07-28.
              const hard = trimMessageHistory(messages, EMERGENCY_HISTORY_CHAR_BUDGET);
              console.warn(
                `[LLM] ${provider.name} rejected the request as too large; retrying once at ` +
                  `${hard.finalChars} chars (was ${hard.originalChars}).`,
              );
              res = await send(buildOpenAIMessages(hard.messages));
            } else {
              throw err;
            }
          }
        } finally {
          clearTimeout(timeoutId);
        }

        if (!res) throw new Error(`Unexpected: ${provider.name} returned no response`);
        const choice = res.choices[0];
        const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? []).flatMap((tc) => {
          if (tc.type !== 'function') return [];
          let parsed: unknown;
          try {
            parsed = JSON.parse(tc.function.arguments);
          } catch {
            parsed = null;
          }
          // Providers may emit "null", empty strings, or arrays for arguments.
          // Coerce anything non-object to an empty object so schema validation
          // can surface a meaningful error instead of a cryptic Zod failure.
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            parsed = {};
          }
          return [{ id: tc.id, name: tc.function.name, args: parsed as Record<string, unknown> }];
        });

        // Real spend accounting — usage was parsed on every call since the
        // multi-provider chain was written, but never recorded anywhere, so
        // nothing in the system knew how many tokens the workforce had burned
        // today. See token-ledger.ts.
        recordTokenUsage(provider.name, {
          promptTokens: res.usage?.prompt_tokens ?? 0,
          completionTokens: res.usage?.completion_tokens ?? 0,
        });

        // Log success so it's visible which provider actually served the request
        clearProviderCooldown(provider.name); // provider recovered — clear circuit breaker
        if (providerErrors.length > 0) {
          console.warn(`[LLM] Succeeded with ${provider.name}/${model} after ${providerErrors.length} failed provider(s): ${providerErrors.map((e) => `${e.provider}(${e.status ?? '?'}: ${e.message})`).join(', ')}`);
        }
        // The condition that silently stopped the business on 2026-07-29:
        // tools were offered, but the provider the chain fell through to
        // cannot reliably call them. The request "succeeds" and the agent
        // answers in prose ("I couldn't find any results"), so nothing
        // upstream can tell this apart from a genuine empty result.
        if (provider.toolCallingReliable === false && openaiTools && openaiTools.length > 0) {
          recordDegradedToolCalling(provider.name, model);
          console.warn(
            `[LLM] DEGRADED TOOL CALLING: ${provider.name}/${model} served a request with ` +
              `${openaiTools.length} tool(s) offered, but this provider does not reliably emit ` +
              `structured tool calls. Expect agents to answer in prose instead of acting. ` +
              `Restore capacity on an earlier provider in the chain.`,
          );
        }

        return {
          content: choice.message.content ?? '',
          toolCalls,
          usage: {
            promptTokens: res.usage?.prompt_tokens ?? 0,
            completionTokens: res.usage?.completion_tokens ?? 0,
          },
          model: `${provider.name}/${res.model}`,
          degraded: provider.toolCallingReliable === false && !!openaiTools && openaiTools.length > 0,
        };
      } catch (err) {
        // Extract status code and message for clear diagnostics
        const status = (err as any)?.status ?? (err as any)?.response?.status ?? (err as any)?.code;
        const errMessage = err instanceof Error ? err.message : String(err);
        const truncatedMsg = errMessage.length > 200 ? errMessage.slice(0, 200) + '…' : errMessage;

        console.error(`[LLM] Provider ${provider.name} failed — model: ${model}, status: ${status ?? 'N/A'}, error: ${truncatedMsg}`);

        providerErrors.push({ provider: provider.name, model, status, message: truncatedMsg });
        recordProviderFailure(provider.name, model, status, truncatedMsg);
        setProviderCooldown(provider.name, status, truncatedMsg);
        continue; // try next provider in the chain
      }
    }
    } // end pass loop

    // Record total failure for global backoff
    lastTotalFailureAt = Date.now();

    // All providers failed — build a detailed error showing every attempt
    const errorSummary = providerErrors.length > 0
      ? providerErrors.map((e) => `  • ${e.provider} (model: ${e.model}, status: ${e.status ?? 'N/A'}): ${e.message}`).join('\n')
      : '  (no providers were configured or had API keys)';

    const finalError = new Error(
      `All LLM providers failed.\n${errorSummary}`
    );

    console.error(`[LLM] All providers exhausted:\n${errorSummary}`);
    throw finalError;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLLMClient(config: LLMClientConfig): MultiProviderClient {
  return new MultiProviderClient(config);
}

export type LLMClient = MultiProviderClient;

// ─── Default model configs per agent tier ────────────────────────────────────
//
// Primary model IDs are OpenRouter-style; if OpenRouter fails, the client
// automatically retries with Groq/Gemini/Cohere/Poolside using their own model IDs.

export function getDefaultLLMConfig(role: string): LLMClientConfig {
  // Per-role token budgets — each turn in the agentic loop gets this budget,
  // and agents iterate up to maxIterations (20-25), so total output per task
  // can be much larger than these per-turn numbers.
  const tokenBudgets: Record<string, number> = {
    CEO: 16384,
    CTO: 16384,
    COO: 16384,
    LEAD_DEV: 16384,
    RESEARCH: 16384,
    LEAD_RESEARCH: 16384,
    SALES: 16384,
    QA_DIRECTOR: 16384,
    FRONTEND: 8192,
    BACKEND: 8192,
    DEVOPS: 8192,
    QA: 8192,
    MARKETING: 8192,
    CUSTOMER_SUCCESS: 8192,
    DOCS: 8192,
    OPS: 8192,
    // Community Watch (comment classification/drafting, ported from
    // APEX-Stream's agent-warden) — output is a small JSON verdict or a
    // one/two-sentence draft, nowhere near the 8192 default other roles need.
    COMMUNITY_WATCH: 1024,
  };
  const maxTokens = tokenBudgets[role] ?? 8192;

  const envKey = `APEX_MODEL_${role}`;
  const envOverride = process.env[envKey];
  if (envOverride) {
    return { provider: 'cerebras', model: envOverride, temperature: 0.7, maxTokens, role };
  }

  const globalModel = process.env.APEX_MODEL;
  if (globalModel) {
    return { provider: 'cerebras', model: globalModel, temperature: 0.7, maxTokens, role };
  }

  // Default model tier — these `model` strings are now cosmetic/legacy since
  // OpenRouter (the only provider that honored this.config.model) was removed
  // 2026-07-22; every remaining provider uses its own fixed fallbackModel.
  // No Claude/GPT/Gemini anywhere in this map (removed 2026-07-27 — Anthropic
  // pricing isn't affordable for this workload; OpenAI/Google were never
  // actually reachable through this client anyway, see below). This field is
  // COSMETIC for every provider except qwen-cloud/qwen-cloud-anthropic (which
  // ignore it entirely in favor of resolveQwenModel(), see above) — every
  // OTHER configured provider uses its own fixed fallbackModel, never
  // this.config.model. Kept accurate anyway so nothing here implies a
  // dependency on a provider this system doesn't actually call.
  const tierMap: Record<string, string> = {
    CEO: 'qwen3.7-max', CTO: 'qwen3.7-max', COO: 'qwen3.7-max',
    LEAD_DEV: 'qwen3.7-max', RESEARCH: 'qwen3.7-max', LEAD_RESEARCH: 'qwen3.7-max',
    SALES: 'qwen3.7-max', QA_DIRECTOR: 'qwen3.7-max',
    FRONTEND: 'qwen3.7-plus', BACKEND: 'qwen3.7-plus', DEVOPS: 'qwen3.7-plus', QA: 'qwen3.7-plus',
    MARKETING: 'qwen3.7-plus', CUSTOMER_SUCCESS: 'qwen3.7-plus', DOCS: 'qwen3.7-plus', OPS: 'qwen3.7-plus',
  };

  const model = tierMap[role] ?? 'qwen3.7-plus';
  return { provider: 'cerebras', model, temperature: 0.7, maxTokens, role };
}

// ─── Embedding Generation ─────────────────────────────────────────────────────

let localPipeline: any = null;

async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline } = await import('@xenova/transformers');
    localPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return localPipeline;
}

/** Which LLM fallback providers currently have an API key configured.
 * Read-only, no network calls — used by health_check to report LLM
 * connectivity config without burning real API requests on every check. */
// ─── Degraded-tool-calling tracker ───────────────────────────────────────────
// Remembers the most recent occasions the chain served a tool-bearing request
// from a provider that cannot reliably call tools, so the condition is
// queryable (health checks, reports) instead of only being a log line nobody
// reads. Bounded and in-memory by design — it describes the CURRENT process.

const degradedToolCallEvents: Array<{ provider: string; model: string; at: number }> = [];

// Why each provider in the chain was passed over. Until now these errors went
// only to console.warn, which is unreadable from anywhere but the container's
// stdout — so "qwen-cloud is configured and healthy but never serves" was
// undiagnosable from the API. Bounded and in-memory: it describes the CURRENT
// process, exactly like the degraded tracker above.
const providerFailureEvents: Array<{
  provider: string;
  model: string;
  status?: string | number;
  message: string;
  at: number;
}> = [];

// ─── Provider Circuit Breaker ─────────────────────────────────────────────────
// When a provider returns 429 (rate limited) or 402 (billing), it's not just
// THIS request that will fail — every concurrent request from every agent will
// fail too, because they all hit the same provider first. Without a circuit
// breaker, 13 agents × 5 concurrency = 65 simultaneous requests all hammer
// Cerebras at once, all get 429, all cascade to Groq, all get 429, etc.
//
// The breaker sets a per-provider cooldown after a 429/402. During cooldown,
// the provider is skipped entirely (not tried, not retried). This spreads
// load across remaining providers instead of all agents stampeding the same
// first-in-chain provider.
const providerCooldowns = new Map<string, number>(); // provider name → epoch ms
const COOLDOWN_429_MS = 30_000;   // 30s for ordinary short-window rate limits (resets quickly)
const COOLDOWN_402_MS = 300_000;  // 5min for billing blocks (won't recover soon)
const COOLDOWN_401_MS = 600_000;  // 10min for auth failures (key won't fix itself)
// 413 reaching THIS function means even the in-request emergency retry
// (EMERGENCY_HISTORY_CHAR_BUDGET, and now the pre-emptive maxRequestChars
// trim above) still didn't fit — a structural mismatch between this
// provider's request-size cap and this workload, not a transient blip.
// Retrying it every ~30s (the old default-bucket behavior, since 413 had no
// explicit branch here) just re-burns the provider's real per-day request
// quota for a guaranteed-fail. Give it room to be fixed by config/plan
// changes without hammering it meanwhile.
const COOLDOWN_413_MS = 900_000;  // 15min for "this request structurally does not fit"
// 2026-08-13 fix: a 429 whose OWN error body says the limit is a DAILY one
// (Groq/Cerebras/Gemini/OpenRouter-free all phrase it as "per day"/"TPD"/
// "daily"/"free-models-per-day") will not recover in 30s — that provider is
// done until its actual daily reset. Before this fix every provider got the
// same blanket 30s cooldown regardless of WHY it 429'd, so once a provider's
// day-quota was blown the retry loop kept re-hitting it every ~30-90s for the
// rest of the day: guaranteed-fail requests that burn real per-day REQUEST
// budgets (e.g. Cerebras's 2400 req/day) for zero benefit, and starve
// still-live providers (e.g. Mistral) of a fair shot in the rotation.
const COOLDOWN_DAILY_MS = 4 * 60 * 60 * 1000; // 4hr — long enough to stop the retry-storm, short enough to self-heal without a redeploy if the message-sniff ever misses a case
const DAILY_QUOTA_PATTERN = /\b(per[\s-]?day|daily|tokens per day|tpd|free-models-per-day)\b/i;

function isDailyQuotaError(message: string | undefined): boolean {
  return !!message && DAILY_QUOTA_PATTERN.test(message);
}

// 2026-08-14 fix: some providers (confirmed: Cerebras) return a bare
// "429 status code (no body)" with zero descriptive text — isDailyQuotaError
// can never match on an empty message, so these always fell through to the
// short 30s cooldown regardless of the REAL cause. Under 13-agent concurrent
// load this reproduced the exact same retry-storm the keyword fix was meant
// to stop, just for providers that don't bother describing their own 429s.
// Fix: track a rolling count of UNCLASSIFIED 429s (no keyword match) per
// provider. If 3+ land within a 2-minute window, treat that streak itself as
// evidence of a real (not transient) exhaustion and escalate to the long
// cooldown — a real one-off burst self-heals in under 2 minutes and never
// accumulates 3 hits, so this doesn't punish genuine brief spikes.
const UNCLASSIFIED_429_WINDOW_MS = 2 * 60 * 1000;
const UNCLASSIFIED_429_STREAK_THRESHOLD = 3;
const recentUnclassified429s = new Map<string, number[]>();

function isRepeatedUnclassified429(name: string): boolean {
  const now = Date.now();
  const history = (recentUnclassified429s.get(name) ?? []).filter((t) => now - t < UNCLASSIFIED_429_WINDOW_MS);
  history.push(now);
  recentUnclassified429s.set(name, history);
  return history.length >= UNCLASSIFIED_429_STREAK_THRESHOLD;
}

function setProviderCooldown(
  name: string,
  status: number | 'daily-cap' | undefined,
  message?: string,
): void {
  // 'daily-cap' is not a provider error at all — it's OUR ledger saying this
  // provider's configured daily token allowance is spent. The correct cooldown
  // is until the actual UTC daily reset, not a 4h heuristic.
  if (status === 'daily-cap') {
    providerCooldowns.set(name, Date.now() + msUntilDailyReset());
    return;
  }
  let ms = COOLDOWN_429_MS;
  let escalatedViaStreak = false;
  if (status === 402) ms = COOLDOWN_402_MS;
  else if (status === 401 || status === 403) ms = COOLDOWN_401_MS;
  else if (status === 413) ms = COOLDOWN_413_MS;
  else if (status === 429) {
    if (isDailyQuotaError(message)) {
      ms = COOLDOWN_DAILY_MS;
    } else if (isRepeatedUnclassified429(name)) {
      ms = COOLDOWN_DAILY_MS;
      escalatedViaStreak = true;
    } else {
      ms = COOLDOWN_429_MS;
    }
  }
  providerCooldowns.set(name, Date.now() + ms);
  if (status === 413) {
    console.warn(`[LLM] ${name}: request too large even after the emergency trim — this is a structural size mismatch, not a transient blip. Cooling down ${ms / 60000}min instead of the usual 30s.`);
  } else if (status === 429 && isDailyQuotaError(message)) {
    console.warn(`[LLM] ${name}: 429 is a DAILY quota exhaustion, not a short burst — cooling down ${ms / 60000}min instead of the usual 30s`);
  } else if (status === 429 && escalatedViaStreak) {
    console.warn(`[LLM] ${name}: ${UNCLASSIFIED_429_STREAK_THRESHOLD}+ unclassified 429s (no body/keyword) within ${UNCLASSIFIED_429_WINDOW_MS / 60000}min — treating as real exhaustion, cooling down ${ms / 60000}min instead of the usual 30s`);
  }
  if (status === 429 && !isDailyQuotaError(message) && !escalatedViaStreak) {
    // Genuine short-window rate limit (or first/second unclassified 429 in this
    // provider's rolling window) — clear its streak isn't reset here on
    // purpose: clearProviderCooldown() (called on success) is what actually
    // resets the provider to a clean slate.
  }
}

function isProviderInCooldown(name: string): boolean {
  const until = providerCooldowns.get(name);
  if (!until) return false;
  if (Date.now() >= until) {
    providerCooldowns.delete(name);
    return false;
  }
  return true;
}

/** Shortest remaining cooldown (ms) across all providers currently in
 *  cooldown, or 0 if none are active. Used to size the global backoff to
 *  reality instead of a flat guess — see GLOBAL_BACKOFF_FLOOR_MS/CAP_MS. */
function getShortestActiveCooldownMs(): number {
  const now = Date.now();
  let shortest = Infinity;
  for (const until of providerCooldowns.values()) {
    if (until > now) shortest = Math.min(shortest, until - now);
  }
  return shortest === Infinity ? 0 : shortest;
}

function clearProviderCooldown(name: string): void {
  providerCooldowns.delete(name);
  recentUnclassified429s.delete(name);
}

// ─── Round-Robin Starting Provider ─────────────────────────────────────────────
// Instead of every request always starting from Cerebras (index 0), rotate
// the starting index per request. This spreads concurrent load across all
// available providers instead of stampeding the first one. Combined with the
// circuit breaker, this means when Cerebras is in cooldown, the next request
// naturally starts from Groq, then Gemini, etc.
const rrStartIndexByTier = new Map<number, number>(); // rotation index PER TIER — see complete() for why

// ─── Process-wide LLM call concurrency cap ─────────────────────────────────
//
// ADDED 2026-08-19 per root-cause finding: 345 tasks releasing at once
// across 13 agents (some at concurrency 4-5) means the process can attempt
// ~20 simultaneous outbound LLM calls the instant a backlog clears or right
// after boot — all racing into the SAME first tier/provider, a guaranteed
// 429 stampede against free-tier per-minute limits. This is a simple
// counting semaphore: only MAX_CONCURRENT_LLM_CALLS complete() calls are
// ever doing real work at once; the rest await their turn in FIFO order.
// Deliberately generous (not 1-2) — the goal is smoothing a stampede into a
// steady stream, not serializing the whole workforce.
const MAX_CONCURRENT_LLM_CALLS = 6;
let activeLLMCalls = 0;
const llmCallWaitQueue: Array<() => void> = [];

function acquireLLMConcurrencySlot(): Promise<void> {
  if (activeLLMCalls < MAX_CONCURRENT_LLM_CALLS) {
    activeLLMCalls++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    llmCallWaitQueue.push(() => {
      activeLLMCalls++;
      resolve();
    });
  });
}

function releaseLLMConcurrencySlot(): void {
  activeLLMCalls--;
  const next = llmCallWaitQueue.shift();
  if (next) next();
}

// ─── Global Backoff ───────────────────────────────────────────────────────────
// When ALL providers fail in a single pass, the entire system is under
// pressure. Rather than immediately failing and letting the agent pick up
// the next task (which triggers another immediate round of provider calls),
// track the last total-failure timestamp and add a backoff delay.
//
// BUG FIX 2026-08-14: this was a flat 15s regardless of WHY providers were
// exhausted. But the circuit breaker's own cooldown tiers are 30s (429) /
// 5min (402) / 10min (401/403) / 4hr (daily quota) — every one of those is
// LONGER than 15s. So under sustained load the loop retried every ~15-20s
// into a chain it had already proven was still cooling down, and because
// task-queue.ts's fail() correctly refuses to retry capacity-exhaustion
// errors (retrying a guaranteed-fail just hammers dead providers), each of
// those doomed 15s-early retries permanently failed whatever real task
// triggered it. Live evidence from the 2026-08-14 12:51-12:59 log window:
// 1 successful completion vs 48 permanently-failed tasks and 24
// "all providers exhausted" cascades in 8 minutes — the backoff was
// actively destroying real work, not just being noisy.
// Fix: wait for the SHORTEST remaining real cooldown across providers
// currently in cooldown (not a flat guess), floored at the old 15s (so a
// transient one-off failure with no active cooldown still gets a small
// courtesy pause) and capped at 90s (so a single request never blocks for
// the full 4hr daily-quota tier — that long-horizon case is what the
// capacity-exhaustion permanent-fail path in task-queue.ts is already for;
// this backoff only exists to de-stampede short-window retries).
let lastTotalFailureAt = 0;
const GLOBAL_BACKOFF_FLOOR_MS = 15_000;
const GLOBAL_BACKOFF_CAP_MS = 90_000;

function recordProviderFailure(
  provider: string,
  model: string,
  status: string | number | undefined,
  message: string,
): void {
  providerFailureEvents.push({ provider, model, status, message, at: Date.now() });
  if (providerFailureEvents.length > 300) providerFailureEvents.shift();
}

/** Most recent failure per provider in the last `windowMs` (default 1h).
 *  This is how you find out that the provider you promoted to the top of the
 *  chain is 404ing on its model id rather than actually being used. */
export function getProviderFailureReport(windowMs = 3_600_000): Array<{
  provider: string;
  model: string;
  status?: string | number;
  message: string;
  count: number;
  lastAt: string;
}> {
  const cutoff = Date.now() - windowMs;
  const byProvider = new Map<string, { e: (typeof providerFailureEvents)[number]; count: number }>();
  for (const e of providerFailureEvents) {
    if (e.at < cutoff) continue;
    const prev = byProvider.get(e.provider);
    byProvider.set(e.provider, { e, count: (prev?.count ?? 0) + 1 });
  }
  return [...byProvider.values()]
    .map(({ e, count }) => ({
      provider: e.provider,
      model: e.model,
      status: e.status,
      message: e.message,
      count,
      lastAt: new Date(e.at).toISOString(),
    }))
    .sort((a, b) => b.count - a.count);
}

function recordDegradedToolCalling(provider: string, model: string): void {
  degradedToolCallEvents.push({ provider, model, at: Date.now() });
  if (degradedToolCallEvents.length > 200) degradedToolCallEvents.shift();
}

/** Tool-bearing requests served by a tool-unreliable provider in the last
 *  `windowMs` (default 1h). Non-zero means agents are very likely answering in
 *  prose instead of acting — the business looks busy and produces nothing. */
export function getDegradedToolCallingReport(windowMs = 3_600_000): {
  degraded: boolean;
  count: number;
  providers: string[];
  since: string | null;
} {
  const cutoff = Date.now() - windowMs;
  const recent = degradedToolCallEvents.filter((e) => e.at >= cutoff);
  return {
    degraded: recent.length > 0,
    count: recent.length,
    providers: [...new Set(recent.map((e) => `${e.provider}/${e.model}`))],
    since: recent.length > 0 ? new Date(recent[0].at).toISOString() : null,
  };
}

export function getConfiguredProviders(): Array<{ name: string; configured: boolean }> {
  return PROVIDERS.map((p) => ({ name: p.name, configured: Boolean(process.env[p.apiKeyEnv]) }));
}

/** The full set of env var names this LLM client will ever read an API key
 * from. Used by the Settings API as a strict allowlist so a client can only
 * ever set/clear a key this client actually consumes — never an arbitrary
 * environment variable. */
export function getKnownApiKeyEnvs(): string[] {
  return [...PROVIDERS.map((p) => p.apiKeyEnv), 'YELP_API_KEY', 'GOOGLE_PLACES_API_KEY', 'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'VAPI_API_KEY', 'VAPI_PHONE_NUMBER_ID', 'CASEBUDDY_SUPABASE_URL', 'CASEBUDDY_SUPABASE_SERVICE_KEY', 'CASEBUDDY_SYSTEM_USER_ID', 'STRIPE_SECRET_KEY', 'APEX_APPROVAL_MODE'];
}

export async function createEmbedding(text: string): Promise<number[]> {
  const openaiKey = process.env.OPENAI_API_KEY;
  // OpenRouter fallback removed 2026-07-22 along with the rest of OpenRouter --
  // local embeddings are now the default whenever OPENAI_API_KEY isn't set.
  const useLocal = process.env.APEX_EMBEDDING_PROVIDER === 'local' || !openaiKey;

  if (useLocal) {
    try {
      const extractor = await getLocalPipeline();
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    } catch (localErr) {
      console.warn('Local embedding generation failed, trying API fallback...', localErr);
    }
  }

  const OpenAI = (await import('openai')).default;

  let apiKey = openaiKey || '';
  let baseURL: string | undefined = undefined;
  let model = 'text-embedding-3-small';

  const client = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/apex-agent',
      'X-Title': 'APEX Autonomous AI Workforce',
    },
  });

  const response = await client.embeddings.create({
    model,
    input: text.replace(/\n/g, ' '),
  });

  return response.data[0].embedding;
}


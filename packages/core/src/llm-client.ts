import type { LLMClientConfig, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './types.js';

// ─── Multi-Provider Fallback Client ───────────────────────────────────────────
//
// Reordered 2026-08-04 after a full audit of BOTH the local keys
// (scripts/llm-probe.mjs, real completion probe per provider) and the live
// Railway service (/api/logs failure trails + /api/health). Findings:
//   • LIVE: cerebras #1 (429 bursts, resets in minutes), cohere (small
//     requests 200; tool-unreliable AND intermittently 422 on live tool
//     requests). Everything else was failing at probe time.
//   • DEAD until human action, on Railway AND local: cerebras-2/3 (402
//     payment required), deepseek (402 insufficient balance), together (402
//     credit limit exceeded), qwen-cloud + glm-aliyun + qwen-cloud-anthropic
//     (401 invalid key — QWENCLOUD_API_KEY needs rotating in the Aliyun
//     console). glm-zai: local key expired, no key on Railway.
//   • CAPACITY-EXHAUSTED but self-resetting: groq + groq-2 (100K TPD per
//     org, ~99% consumed by 19:10Z — daily reset), google-gemini (429,
//     daily), poolside (429 usage limit), openrouter-free x2 (429 daily).
//   • NOT CONFIGURED on Railway: google-gemini-2, nvidia — free capacity
//     left on the table until those keys are added.
//
// Chain order now (live evidence first, dead-but-recoverable last):
//
//   Cerebras → Cerebras-2 → Cerebras-3 → Gemini → Gemini-2 → Groq → Groq-2 →
//   NVIDIA NIM → Poolside → Together AI → DeepSeek → Qwen Cloud → GLM-Aliyun →
//   Qwen Cloud (Anthropic) → GLM-Zai → Cohere → OpenRouter (free) x2
//
// Dead/blocked entries are DEMOTED, not removed — behind the circuit breaker
// they cost one skipped probe per cooldown, and keeping them means zero-code-
// change recovery the moment Don rotates a key or tops up billing. When
// QWENCLOUD_API_KEY is rotated, promote the three qwen entries back above
// the free tiers: that paid Token Plan is meant to be the chain's anchor.
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
}> = [
  // Cerebras — live on Railway 2026-08-04 (429 bursts under concurrent load,
  // resets in minutes; the in-provider 429 retry + circuit breaker absorb the
  // bursts). Local key is 402 billing-gated — Railway's is the one that
  // matters for the workforce.
  { name: 'cerebras', baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY', fallbackModel: 'llama3.1-70b' },
  // Cerebras (2nd account) — 402 payment required on Railway AND local as of
  // 2026-08-04 (account needs a payment method). Demoted but kept: zero-code-
  // change recovery once billing is sorted; circuit breaker makes it a cheap
  // skip meanwhile.
  { name: 'cerebras-2', baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY_2', fallbackModel: 'llama3.1-70b' },
  // Cerebras (3rd account) — same 402 story as cerebras-2.
  { name: 'cerebras-3', baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY_3', fallbackModel: 'llama3.1-70b' },
  // Google Gemini — PROMOTED 2026-08-04 ahead of Groq: its free tier
  // (1,500 req/day, 15 RPM, 1M tokens/min) is by far the largest daily
  // budget in this chain — Groq's whole org gets 100K TPD, which is only
  // ~5-10 of today's sized requests. Function calling is reliable; the
  // in-provider 429 retry absorbs the 15 RPM ceiling. OpenAI-compatible
  // endpoint at generativelanguage.googleapis.com/v1beta/openai/. Key from
  // aistudio.google.com.
  { name: 'google-gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', fallbackModel: 'gemini-1.5-flash-latest' },
  // Google Gemini (2nd project) — separate Google Cloud project = separate
  // quota. NOT configured on Railway as of 2026-08-04 — no-op until the key
  // is added.
  { name: 'google-gemini-2', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY_2', fallbackModel: 'gemini-1.5-flash-latest' },
  // Groq — the workhorse while its 100K TPD org budget lasts; both orgs were
  // ~99% consumed by 19:10Z on 2026-08-04. Resets daily.
  { name: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', fallbackModel: 'llama-3.3-70b-versatile' },
  // Groq (2nd account) — second org, same 100K TPD, same daily reset.
  { name: 'groq-2', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY_2', fallbackModel: 'llama-3.3-70b-versatile' },
  // NVIDIA NIM — free tier at build.nvidia.com. Llama 3.3 70B supports
  // function calling. OpenAI-compatible at integrate.api.nvidia.com. NOT
  // configured on Railway as of 2026-08-04 — no-op until the key is added.
  { name: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', fallbackModel: 'meta/llama-3.3-70b-instruct' },
  // Poolside — 429 "usage limit exceeded" on Railway AND local as of
  // 2026-08-04 (quota top-up or reset needed). Kept above the 401/402-dead
  // entries because its limit can self-reset. OpenAI-compatible; model
  // catalog is poolside/laguna-s-2.1 (the larger of two); keys start sky_.
  { name: 'poolside', baseURL: 'https://inference.poolside.ai/v1', apiKeyEnv: 'POOLSIDE_API_KEY', fallbackModel: 'poolside/laguna-s-2.1' },
  // Together AI — 402 credit limit exceeded on Railway 2026-08-04 (the free
  // credits are spent). Demoted; needs a top-up to serve again. Llama 3.3
  // 70B Turbo, OpenAI-compatible at api.together.xyz.
  { name: 'together', baseURL: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY', fallbackModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  // DeepSeek — 402 insufficient balance on Railway AND local 2026-08-04.
  // Demoted; needs a top-up. OpenAI-compatible endpoint, deepseek-chat.
  { name: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', fallbackModel: 'deepseek-chat' },
  // Qwen Cloud (Aliyun Token Plan) — DEMOTED 2026-08-04: QWENCLOUD_API_KEY
  // is 401 Invalid API-key on all three entries, live AND local, until Don
  // rotates the Token Plan key in the Aliyun console. Kept in the chain
  // (circuit breaker = cheap 10-min-cooldown skip) for zero-code-change
  // recovery — and PROMOTE these entries back above the free tiers once the
  // key is rotated: this paid plan is meant to be the chain's anchor. It was
  // promoted above cohere 2026-07-29 for the same reason it must never sit
  // below it while alive: ordering by "does it respond" instead of "can it
  // do the work" is what stalled the workforce that day — cohere answered in
  // prose, without calling tools, and the fallback stopped there. A provider
  // that answers but cannot call tools must sit BELOW ones that can.
  // Endpoint note: this is the Token Plan endpoint, NOT the Pay-As-You-Go
  // dashscope-intl endpoint, which 401s a Token Plan key.
  // Model note: the Token Plan endpoint uses DOTTED versioned model IDs
  // (qwen3.7-plus / qwen3.7-max / qwen3.6-flash / qwen3.8-max-preview), NOT
  // the hyphenated public IDs — qwen3-coder-plus AND qwen-plus both 404
  // "Model not exist" here. qwen3.7-plus is the balanced large-context
  // workhorse; role-aware selection via resolveQwenModel().
  { name: 'qwen-cloud', baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWENCLOUD_API_KEY', fallbackModel: 'qwen3.7-plus' },
  // GLM-5.2 (Zhipu) THROUGH THE SAME ALIYUN TOKEN PLAN ACCOUNT — Aliyun Model
  // Studio hosts third-party models alongside its own (docs:
  // help.aliyun.com/en/model-studio/glm-zhipu; Token Plan page lists GLM-5.2
  // as supported). Reuses QWENCLOUD_API_KEY, so exactly as dead/live as
  // qwen-cloud above. 1M context. Never independently confirmed live on this
  // account — verify with a real completion call after the key rotation.
  { name: 'glm-aliyun', baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWENCLOUD_API_KEY', fallbackModel: 'glm-5.2' },
  // SAME Token Plan account again, through Aliyun's Anthropic-Messages-API-
  // compatible endpoint — different wire protocol in front of the same model
  // catalog, so the model ID is identical by design. NOT independently
  // confirmed live on this endpoint; verify after the key rotation.
  { name: 'qwen-cloud-anthropic', protocol: 'anthropic', baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', apiKeyEnv: 'QWENCLOUD_API_KEY', fallbackModel: 'qwen3.7-plus' },
  // GLM-5.2, second path — Zhipu's own direct Z.ai API. Independent of the
  // Aliyun account/quota (different key, different infra) — a genuinely
  // separate fallback, not a duplicate. General pay-per-token API
  // (api.z.ai/api/paas/v4), NOT the GLM Coding Plan endpoint
  // (api.z.ai/api/coding/paas/v4 — flat-rate subscription that only works
  // inside specific coding tools like Claude Code/Cline/OpenCode, not a fit
  // for a custom agent backend). Local key expired ("token expired or
  // incorrect", 2026-08-04 probe) and no key configured on Railway.
  { name: 'glm-zai', baseURL: 'https://api.z.ai/api/paas/v4', apiKeyEnv: 'ZAI_API_KEY', fallbackModel: 'glm-5.2' },
  // Cohere — last-resort tier with the openrouter-free entries below: reached
  // only after every reliable provider above has failed (two-pass fallback in
  // complete()). toolCallingReliable: false — the OpenAI-compatibility shim
  // accepts a tools array but command-r-plus frequently answers in prose
  // instead of calling anything. Better than the workforce going dead, and
  // the degradation is surfaced (getDegradedToolCallingReport) not silent.
  // 2026-08-04: small requests probe 200, but live tool-bearing requests
  // intermittently 422 (no body) — treat its output as best-effort.
  { name: 'cohere', baseURL: 'https://api.cohere.com/compatibility/v1', apiKeyEnv: 'COHERE_API_KEY', fallbackModel: 'command-r-plus-08-2024', maxOutputTokens: 4096, toolCallingReliable: false },
  // OpenRouter FREE tier — daily-quota 429s are a shared, self-resetting
  // rate limit (not a dead/invalid key), genuinely serves requests once the
  // daily window resets.
  { name: 'openrouter-free', toolCallingReliable: false, baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'openai/gpt-oss-20b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
  { name: 'openrouter-free-2', toolCallingReliable: false, baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'nvidia/nemotron-3-super-120b-a12b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
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

  async complete(rawMessages: LLMMessage[], tools?: LLMTool[]): Promise<LLMResponse> {
    const OpenAI = (await import('openai')).default;

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
    if (sinceTotalFailure < GLOBAL_BACKOFF_MS) {
      const waitMs = GLOBAL_BACKOFF_MS - sinceTotalFailure;
      console.warn(`[LLM] Global backoff: waiting ${Math.round(waitMs / 1000)}s before retrying — all providers recently exhausted`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Build a round-robin ordered provider list: start from a different index
    // each call so concurrent requests don't all stampede the same provider.
    const reliableProviders: typeof PROVIDERS = [];
    const unreliableProviders: typeof PROVIDERS = [];
    for (let i = 0; i < PROVIDERS.length; i++) {
      const idx = (rrStartIndex + i) % PROVIDERS.length;
      const p = PROVIDERS[idx];
      if (p.toolCallingReliable === false) {
        unreliableProviders.push(p);
      } else {
        reliableProviders.push(p);
      }
    }
    rrStartIndex = (rrStartIndex + 1) % PROVIDERS.length; // rotate for next call

    for (let pass = 0; pass <= 1; pass++) {
      if (pass === 1) {
        if (providerErrors.length === 0) break; // succeeded on pass 0, no need for pass 1
        lastResortMode = true;
        console.warn(`[LLM] All reliable providers exhausted — starting last-resort pass with unreliable tool-calling providers`);
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
          setProviderCooldown(provider.name, status);
          continue;
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
            res = await send(openaiMessages);
          } catch (err) {
            const status = (err as any)?.status ?? (err as any)?.response?.status;
            const msg = err instanceof Error ? err.message : String(err);

            if (status === 429) {
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
                  res = await send(openaiMessages);
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
        setProviderCooldown(provider.name, status);
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
const COOLDOWN_429_MS = 30_000;  // 30s for rate limits (resets quickly)
const COOLDOWN_402_MS = 300_000; // 5min for billing blocks (won't recover soon)
const COOLDOWN_401_MS = 600_000; // 10min for auth failures (key won't fix itself)

function setProviderCooldown(name: string, status: number | undefined): void {
  let ms = COOLDOWN_429_MS;
  if (status === 402) ms = COOLDOWN_402_MS;
  else if (status === 401 || status === 403) ms = COOLDOWN_401_MS;
  else if (status === 429) ms = COOLDOWN_429_MS;
  providerCooldowns.set(name, Date.now() + ms);
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

function clearProviderCooldown(name: string): void {
  providerCooldowns.delete(name);
}

// ─── Round-Robin Starting Provider ─────────────────────────────────────────────
// Instead of every request always starting from Cerebras (index 0), rotate
// the starting index per request. This spreads concurrent load across all
// available providers instead of stampeding the first one. Combined with the
// circuit breaker, this means when Cerebras is in cooldown, the next request
// naturally starts from Groq, then Gemini, etc.
let rrStartIndex = 0;

// ─── Global Backoff ───────────────────────────────────────────────────────────
// When ALL providers fail in a single pass, the entire system is under
// pressure. Rather than immediately failing and letting the agent pick up
// the next task (which triggers another immediate round of provider calls),
// track the last total-failure timestamp and add a backoff delay.
let lastTotalFailureAt = 0;
const GLOBAL_BACKOFF_MS = 15_000; // 15s pause after total provider exhaustion

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
  return [...PROVIDERS.map((p) => p.apiKeyEnv), 'YELP_API_KEY', 'GOOGLE_PLACES_API_KEY', 'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'VAPI_API_KEY', 'VAPI_PHONE_NUMBER_ID', 'CASEBUDDY_SUPABASE_URL', 'CASEBUDDY_SUPABASE_SERVICE_KEY', 'CASEBUDDY_SYSTEM_USER_ID', 'GEMINI_API_KEY', 'STRIPE_SECRET_KEY', 'CEREBRAS_API_KEY_2', 'CEREBRAS_API_KEY_3', 'GROQ_API_KEY_2', 'GEMINI_API_KEY_2', 'NVIDIA_API_KEY', 'TOGETHER_API_KEY', 'APEX_APPROVAL_MODE'];
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


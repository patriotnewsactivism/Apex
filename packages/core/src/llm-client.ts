import type { LLMClientConfig, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './types.js';

// ─── Multi-Provider Fallback Client ───────────────────────────────────────────
//
// Reordered 2026-07-26 after a full live-key audit (direct curl against every
// configured key, with proper User-Agent — api.cerebras.ai/api.groq.com were
// throwing Cloudflare 403 error 1010 on bare urllib requests with no UA,
// which looked like dead keys but were a false alarm once a real UA was
// sent). Confirmed live: Cerebras, Groq, Cohere (COHERE_API_KEY — see
// corrected note below, this is NOT the old mislabeled-trial situation
// anymore). Confirmed dead/blocked: Mistral (401 invalid key), Qwen Cloud
// (401 invalid key), Cohere-trial (429, monthly 1000-call cap hit),
// GitHub Models (no_access on every model tried), xAI (403 permission-denied
// — team credits/spending limit exhausted, key itself is valid), Kilo Code
// (402 — negative account balance). Chain order now:
//
//   Cerebras → Groq → Cohere (prod) → Mistral → Qwen Cloud → GitHub Models →
//   Cohere (trial) → xAI → Kilo Code → OpenRouter (free) x2
//
// Dead/blocked entries kept in the chain rather than removed — harmless
// no-ops today, zero-code-change recovery the moment Don rotates a key or
// tops up billing (xAI/Kilo Code specifically just need a credits top-up,
// not a new key).
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
}> = [
  // Cerebras — re-verified live 2026-07-26.
  { name: 'cerebras', baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY', fallbackModel: 'gpt-oss-120b' },
  // Groq — re-verified live 2026-07-26.
  { name: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', fallbackModel: 'llama-3.3-70b-versatile' },
  // Cohere (production) — re-verified live 2026-07-26, genuine production tier
  // (clean completion, no trial-cap warning).
  { name: 'cohere', baseURL: 'https://api.cohere.com/compatibility/v1', apiKeyEnv: 'COHERE_API_KEY', fallbackModel: 'command-r-plus-08-2024' },
  // Mistral RE-ADDED 2026-07-26: Don rotated a fresh key same-day, confirmed
  // live via direct completion call (real "Ok!" response) before re-adding.
  { name: 'mistral', baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', fallbackModel: 'mistral-small-latest' },
  // Still removed 2026-07-26 per Don's explicit instruction ("remove models
  // that keep returning errors, get them out"): github-models (no_access on
  // every model tried), cohere-trial (429, monthly cap hit), xai (403, team
  // credits exhausted), kilocode (402, negative balance). Re-add only once a
  // fresh key is confirmed live with a real completion call first.
  // Qwen Cloud RE-ADDED 2026-07-26 with the Token Plan endpoint (Don's active
  // sk-sp-… Token Plan key). The removed entry used the Pay-As-You-Go
  // dashscope-intl endpoint, which 401s a Token Plan key — the likely cause of
  // the "API-key is blocked" failures that removed it in 85bc100. No-op while
  // QWENCLOUD_API_KEY is unset on the service (the client skips missing keys).
  // Model note: the Token Plan (Lite) endpoint uses DOTTED versioned model IDs
  // (qwen3.7-plus / qwen3.7-max / qwen3.6-flash / qwen3.8-max-preview), NOT the
  // hyphenated public IDs — qwen3-coder-plus AND qwen-plus both 404 "Model not
  // exist" here (auth succeeded, so the endpoint/key wiring was right, only the
  // model ID was wrong). qwen3.7-plus is the balanced large-context workhorse.
  { name: 'qwen-cloud', baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWENCLOUD_API_KEY', fallbackModel: 'qwen3.7-plus' },
  // Qwen Cloud, second entry (added 2026-07-27): the SAME Token Plan account/
  // key, exposed through Aliyun's Anthropic-Messages-API-compatible endpoint
  // instead of the OpenAI-compatible one above. Model ID reused from the
  // qwen-cloud entry above — same underlying model catalog on the same Token
  // Plan account, just a different wire protocol in front of it, so the model
  // ID string itself should be identical; NOT independently confirmed live on
  // this specific endpoint yet, verify with a real completion call before
  // relying on this entry.
  { name: 'qwen-cloud-anthropic', protocol: 'anthropic', baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', apiKeyEnv: 'QWENCLOUD_API_KEY', fallbackModel: 'qwen3.7-plus' },
  // OpenRouter FREE tier -- kept: daily-quota 429s are a shared, self-resetting
  // rate limit (not a dead/invalid key), genuinely serves requests once the
  // daily window resets.
  { name: 'openrouter-free', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'openai/gpt-oss-20b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
  { name: 'openrouter-free-2', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'nvidia/nemotron-3-super-120b-a12b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
];

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
    provider: { name: string; baseURL: string },
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
          max_tokens: this.config.maxTokens ?? 4096,
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

  async complete(messages: LLMMessage[], tools?: LLMTool[]): Promise<LLMResponse> {
    const OpenAI = (await import('openai')).default;

    const openaiMessages = messages.map((m) => {
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

    const openaiTools = tools?.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const providerErrors: Array<{ provider: string; model: string; status?: number; message: string }> = [];

    for (const provider of PROVIDERS) {
      const apiKey = process.env[provider.apiKeyEnv];
      if (!apiKey) {
        console.warn(`[LLM] Skipping ${provider.name}: no ${provider.apiKeyEnv} configured`);
        continue;
      }

      // Mistral's role-aware model routing was removed 2026-07-26 along with
      // the Mistral provider entry itself (confirmed 401 invalid key, see
      // PROVIDERS above). Every remaining provider uses its plain fallbackModel.
      const model: string = provider.fallbackModel ?? this.config.model;

      if (provider.protocol === 'anthropic') {
        try {
          const response = await this.completeViaAnthropic(provider, apiKey, model, messages, tools);
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
          res = await client.chat.completions.create(
            {
              model,
              messages: openaiMessages,
              tools: openaiTools && openaiTools.length > 0 ? openaiTools : undefined,
              temperature: this.config.temperature ?? 0.7,
              max_tokens: this.config.maxTokens ?? 4096,
            },
            { signal: controller.signal },
          );
        } finally {
          clearTimeout(timeoutId);
        }

        const choice = res.choices[0];
        const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? []).flatMap((tc) => {
          if (tc.type !== 'function') return [];
          return [{ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments) as Record<string, unknown> }];
        });

        // Log success so it's visible which provider actually served the request
        if (providerErrors.length > 0) {
          console.warn(`[LLM] Succeeded with ${provider.name}/${model} after ${providerErrors.length} failed provider(s): ${providerErrors.map((e) => `${e.provider}(${e.status ?? '?'}: ${e.message})`).join(', ')}`);
        }

        return {
          content: choice.message.content ?? '',
          toolCalls,
          usage: {
            promptTokens: res.usage?.prompt_tokens ?? 0,
            completionTokens: res.usage?.completion_tokens ?? 0,
          },
          model: `${provider.name}/${res.model}`,
        };
      } catch (err) {
        // Extract status code and message for clear diagnostics
        const status = (err as any)?.status ?? (err as any)?.response?.status ?? (err as any)?.code;
        const errMessage = err instanceof Error ? err.message : String(err);
        const truncatedMsg = errMessage.length > 200 ? errMessage.slice(0, 200) + '…' : errMessage;

        console.error(`[LLM] Provider ${provider.name} failed — model: ${model}, status: ${status ?? 'N/A'}, error: ${truncatedMsg}`);

        providerErrors.push({ provider: provider.name, model, status, message: truncatedMsg });
        continue; // try next provider in the chain
      }
    }

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
  const tierMap: Record<string, string> = {
    CEO:      'anthropic/claude-sonnet-4-5',
    CTO:      'anthropic/claude-sonnet-4-5',
    COO:      'anthropic/claude-sonnet-4-5',
    LEAD_DEV: 'openai/gpt-4o',
    FRONTEND: 'openai/gpt-4o',
    BACKEND:  'openai/gpt-4o',
    DEVOPS:   'openai/gpt-4o',
    QA:       'openai/gpt-4o',
    RESEARCH: 'google/gemini-2.5-flash',
    DOCS:     'openai/gpt-4o-mini',
    OPS:      'openai/gpt-4o-mini',
    LEAD_RESEARCH:    'google/gemini-2.5-flash',
    SALES:            'openai/gpt-4o',
    MARKETING:        'openai/gpt-4o-mini',
    CUSTOMER_SUCCESS: 'openai/gpt-4o-mini',
    QA_DIRECTOR:      'openai/gpt-4o',
  };

  const model = tierMap[role] ?? 'openai/gpt-4o-mini';
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
export function getConfiguredProviders(): Array<{ name: string; configured: boolean }> {
  return PROVIDERS.map((p) => ({ name: p.name, configured: Boolean(process.env[p.apiKeyEnv]) }));
}

/** The full set of env var names this LLM client will ever read an API key
 * from. Used by the Settings API as a strict allowlist so a client can only
 * ever set/clear a key this client actually consumes — never an arbitrary
 * environment variable. */
export function getKnownApiKeyEnvs(): string[] {
  return PROVIDERS.map((p) => p.apiKeyEnv);
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


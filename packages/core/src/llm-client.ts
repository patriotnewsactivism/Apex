import type { LLMClientConfig, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './types.js';

// ─── Multi-Provider Fallback Client ───────────────────────────────────────────
//
// OpenRouter REMOVED entirely 2026-07-22 per Don's decision (not renewing
// OpenRouter credits — dropping it portfolio-wide, not just letting it
// silently 402). Falls back through free providers in order:
//
//   Cerebras → Mistral → Groq → GitHub Models → Qwen Cloud → Cohere (trial) →
//   Cohere (prod)
//
// Direct Gemini fallback was removed 2026-07-14 (permanently dead key, zero
// quota grant — not a rate limit). See NOTE above the cohere-trial entry.
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
}> = [
  // Cerebras — verified live 2026-07-14. Available models on this account:
  // gemma-4-31b, zai-glm-4.7, gpt-oss-120b. Using gpt-oss-120b (best quality/speed).
  { name: 'cerebras', baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY', fallbackModel: 'gpt-oss-120b' },
  // Mistral La Plateforme — free tier, 1B tokens/month. Skips automatically
  // until MISTRAL_API_KEY is configured (same pattern as every other provider).
  { name: 'mistral', baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', fallbackModel: 'mistral-small-latest' },
  { name: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', fallbackModel: 'llama-3.3-70b-versatile' },
  // GitHub Models -- free via the existing GITHUB_TOKEN_4 PAT (already used
  // for repo writes elsewhere in this ecosystem), no separate signup. Live-
  // verified 2026-07-20: openai/gpt-4.1 responds correctly with this token.
  // Tight per-request token caps on GitHub's side, so placed after the faster
  // free tiers (Cerebras/Mistral/Groq) rather than first.
  { name: 'github-models', baseURL: 'https://models.github.ai/inference', apiKeyEnv: 'GITHUB_TOKEN_4', fallbackModel: 'openai/gpt-4.1' },
  // Qwen Cloud (Alibaba Cloud Model Studio, international dashscope-intl
  // endpoint -- NOT the mainland Bailian console, separate account/URL).
  // PAID pay-as-you-go, NOT free -- placed after every free tier above
  // (Cerebras/Mistral/Groq/GitHub Models) and before Cohere's trial-limited
  // tier, since it's cheap and has no shared-quota risk. Live-verified
  // 2026-07-20 against the real endpoint (qwen-max, qwen3-coder-plus both
  // returned real completions). Pricing confirmed official 2026-07-20:
  // qwen3-coder-plus $1.00/$5.00 per 1M (base tier), qwen-max $1.60/$6.40.
  { name: 'qwen-cloud', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWENCLOUD_API_KEY', fallbackModel: 'qwen3-coder-plus' },
  // NOTE: direct Gemini fallback (GEMINI_API_KEY -> generativelanguage.googleapis.com)
  // was REMOVED 2026-07-14 — confirmed permanently dead: this Google Cloud
  // project/key returns a 429 with `limit: 0` for gemini-2.0-flash free tier,
  // which is a zero quota GRANT, not a transient rate limit. Re-add only if a
  // fresh key from a NEW Google AI Studio project (or billing enabled) is
  // provided and verified live first. Gemini is still reachable via OpenRouter
  // (see business.ts / APEX_CHARTER.md `google/gemini-2.5-flash` model refs) —
  // that path goes through OpenRouter's own billing, not this dead key, and is
  // unaffected by this removal.
  { name: 'cohere-trial', baseURL: 'https://api.cohere.com/compatibility/v1', apiKeyEnv: 'COHERE_TRIAL_API_KEY', fallbackModel: 'command-r-plus-08-2024' },
  // NOTE: despite the name, COHERE_API_KEY is NOT an actual Cohere production
  // (paid) key — confirmed live 2026-07-14: Cohere's API itself returns
  // "You are using a Trial key, which is limited to 1000 API calls / month"
  // for both COHERE_API_KEY and COHERE_TRIAL_API_KEY. Whoever issued this key
  // mislabeled it, or it was downgraded. Needs a REAL production key from
  // https://dashboard.cohere.com/api-keys (Production tab, not Trial) to
  // actually get higher rate limits — until then this tier will keep 429ing
  // once the shared trial quota is exhausted.
  { name: 'cohere', baseURL: 'https://api.cohere.com/compatibility/v1', apiKeyEnv: 'COHERE_API_KEY', fallbackModel: 'command-r-plus-08-2024' },
  // OpenRouter FREE tier re-added 2026-07-22 (last-resort only) -- Don confirmed
  // the paid OpenRouter balance stays retired, but OpenRouter's :free-suffixed
  // models cost nothing and just add more distinct rate-limit buckets to this
  // chain. Re-verified live against openrouter.ai/api/v1/models 2026-07-22 --
  // OpenRouter's free catalog has changed since this was last used: the old
  // devstral/qwen-coder/llama-3.3-70b :free ids are gone, replaced by
  // gpt-oss-20b and nvidia/nemotron variants. Placed LAST since it's the
  // provider most likely to already be exhausted portfolio-wide.
  { name: 'openrouter-free', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'openai/gpt-oss-20b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
  { name: 'openrouter-free-2', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'nvidia/nemotron-3-super-120b-a12b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
];

class MultiProviderClient {
  private config: LLMClientConfig;

  constructor(config: LLMClientConfig) {
    this.config = config;
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

      // Role-aware model selection for Mistral: route coding-heavy roles to
      // Devstral (agentic coding) / Codestral (code review), everything else
      // to the high-throughput mistral-small-2506 (5 RPS vs mistral-large's 0.07 RPS).
      // Model IDs confirmed live on this Mistral org account 2026-07-16.
      const CODING_ROLES = ['LEAD_DEV', 'BACKEND', 'DEVOPS', 'FRONTEND'];
      const QA_ROLES = ['QA', 'QA_DIRECTOR'];
      let model: string;
      if (provider.name === 'mistral') {
        const role = this.config.role;
        if (role && QA_ROLES.includes(role)) model = 'codestral-2508';
        else if (role && CODING_ROLES.includes(role)) model = 'devstral-2512';
        else model = 'mistral-small-2506';
      } else {
        model = provider.fallbackModel ?? this.config.model;
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
              max_tokens: this.config.maxTokens ?? 400,
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


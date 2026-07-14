import type { LLMClientConfig, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './types.js';

// ─── Multi-Provider Fallback Client ───────────────────────────────────────────
//
// Tries OpenRouter first (best model selection), then falls back through free
// providers in order if OpenRouter is unavailable (e.g. out of credits) or a
// provider errors/rate-limits:
//
//   OpenRouter → Groq → Gemini → Cohere (trial) → Cohere (prod) → Poolside
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
  { name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  { name: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', fallbackModel: 'llama-3.3-70b-versatile' },
  { name: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKeyEnv: 'GEMINI_API_KEY', fallbackModel: 'gemini-2.0-flash' },
  { name: 'cohere-trial', baseURL: 'https://api.cohere.com/compatibility/v1', apiKeyEnv: 'COHERE_TRIAL_API_KEY', fallbackModel: 'command-r-plus-08-2024' },
  { name: 'cohere', baseURL: 'https://api.cohere.com/compatibility/v1', apiKeyEnv: 'COHERE_API_KEY', fallbackModel: 'command-r-plus-08-2024' },
  { name: 'poolside', baseURL: 'https://inference.poolside.ai/v1', apiKeyEnv: 'POOLSIDE_API_KEY', fallbackModel: 'laguna-m.1' },
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

      const model = provider.name === 'openrouter' ? this.config.model : (provider.fallbackModel ?? this.config.model);

      try {
        const defaultHeaders: Record<string, string> = {};
        if (provider.name === 'openrouter') {
          defaultHeaders['HTTP-Referer'] = 'https://github.com/apex-agent';
          defaultHeaders['X-Title'] = 'APEX Autonomous AI Workforce';
        }
        if (provider.extraHeaders) {
          Object.assign(defaultHeaders, provider.extraHeaders);
        }

        const client = new OpenAI({
          apiKey,
          baseURL: this.config.baseUrl && provider.name === 'openrouter' ? this.config.baseUrl : provider.baseURL,
          defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
        });

        const res = await client.chat.completions.create({
          model,
          messages: openaiMessages,
          tools: openaiTools && openaiTools.length > 0 ? openaiTools : undefined,
          temperature: this.config.temperature ?? 0.7,
          max_tokens: this.config.maxTokens ?? 400,
        });

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
    return { provider: 'openrouter', model: envOverride, temperature: 0.7, maxTokens };
  }

  const globalModel = process.env.APEX_MODEL;
  if (globalModel) {
    return { provider: 'openrouter', model: globalModel, temperature: 0.7, maxTokens };
  }

  // Default model tier — free-friendly: Groq/Gemini fallback chain catches these
  // when OpenRouter credits run out
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
  return { provider: 'openrouter', model, temperature: 0.7, maxTokens };
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

export async function createEmbedding(text: string): Promise<number[]> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const useLocal = process.env.APEX_EMBEDDING_PROVIDER === 'local' || (!openaiKey && !openrouterKey);

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

  let apiKey = openaiKey || openrouterKey || '';
  let baseURL = openaiKey ? undefined : 'https://openrouter.ai/api/v1';
  let model = openaiKey ? 'text-embedding-3-small' : 'openai/text-embedding-3-small';

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

import type { LLMClientConfig, LLMMessage, LLMResponse, LLMTool, LLMToolCall } from './types.js';

// ─── OpenRouter Client ────────────────────────────────────────────────────────
//
// OpenRouter exposes a fully OpenAI-compatible API at https://openrouter.ai/api/v1
// This means we use the standard `openai` npm package but point it at OpenRouter.
// One key gives access to OpenAI, Anthropic, Google, Meta, Mistral, and more.
//
// Model name format: "provider/model-name"
//   e.g. "openai/gpt-4o", "anthropic/claude-opus-4-5",
//        "google/gemini-2.5-pro", "meta-llama/llama-3.3-70b-instruct"

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

class OpenRouterClient {
  private config: LLMClientConfig;

  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  async complete(messages: LLMMessage[], tools?: LLMTool[]): Promise<LLMResponse> {
    const OpenAI = (await import('openai')).default;

    const client = new OpenAI({
      apiKey: this.config.apiKey ?? process.env.OPENROUTER_API_KEY ?? '',
      baseURL: this.config.baseUrl ?? OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/apex-agent',
        'X-Title': 'APEX Autonomous AI Workforce',
      },
    });

    // Map our unified message format → OpenAI format (OpenRouter accepts the same)
    const openaiMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.toolCallId ?? '',
        };
      }
      if (m.role === 'assistant') {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.toolCalls && m.toolCalls.length > 0
            ? m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.args),
                },
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

    const res = await client.chat.completions.create({
      model: this.config.model,
      messages: openaiMessages,
      tools: openaiTools && openaiTools.length > 0 ? openaiTools : undefined,
      temperature: this.config.temperature ?? 0.7,
      max_tokens: this.config.maxTokens ?? 400,
    });

    const choice = res.choices[0];
    const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? []).flatMap((tc) => {
      if (tc.type !== 'function') return [];
      return [{
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }];
    });

    return {
      content: choice.message.content ?? '',
      toolCalls,
      usage: {
        promptTokens: res.usage?.prompt_tokens ?? 0,
        completionTokens: res.usage?.completion_tokens ?? 0,
      },
      model: res.model,
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLLMClient(config: LLMClientConfig): OpenRouterClient {
  // All providers route through OpenRouter — model name selects the backend
  return new OpenRouterClient(config);
}

export type LLMClient = OpenRouterClient;

// ─── Default model configs per agent tier ────────────────────────────────────
//
// OpenRouter model IDs: https://openrouter.ai/models
// Senior agents get high-capability models; specialists get fast/cheap ones.

export function getDefaultLLMConfig(role: string): LLMClientConfig {
  // Allow per-role model override via env, e.g. APEX_MODEL_CEO=anthropic/claude-opus-4-5
  const envKey = `APEX_MODEL_${role}`;
  const envOverride = process.env[envKey];
  if (envOverride) {
    return { provider: 'openrouter', model: envOverride, temperature: 0.7, maxTokens: 400 };
  }

  // Global model override — use one model for everything
  const globalModel = process.env.APEX_MODEL;
  if (globalModel) {
    return { provider: 'openrouter', model: globalModel, temperature: 0.7, maxTokens: 400 };
  }

  // Tiered defaults: senior agents → Claude Sonnet; specialists → fast model
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
  };

  const model = tierMap[role] ?? 'openai/gpt-4o-mini';
  return { provider: 'openrouter', model, temperature: 0.7, maxTokens: 400 };
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
  let baseURL = openaiKey ? undefined : OPENROUTER_BASE_URL;
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
    input: text.replace(/\n/g, ' '), // recommended replacement for embedding tasks
  });

  return response.data[0].embedding;
}


'use node';

// ─── Multi-Provider Fallback Client ───────────────────────────────────────────
//
// Ports packages/core/src/llm-client.ts. Needs the Node runtime (not the
// default V8-isolate action runtime) for the `openai` SDK.
//
// Zero-cost only. Production Convex autonomy is disabled unless
// APEX_CONVEX_AUTONOMY_ENABLED=true. Even then this client must not spend
// money: only OpenRouter :free models and the free-account key roster.

import { v } from 'convex/values';
import { internalAction } from './_generated/server';

const configuredRequestTimeoutMs = Number(process.env.APEX_LLM_REQUEST_TIMEOUT_MS ?? 30_000);
const LLM_REQUEST_TIMEOUT_MS = Number.isFinite(configuredRequestTimeoutMs)
  ? Math.min(60_000, Math.max(10_000, Math.floor(configuredRequestTimeoutMs)))
  : 30_000;

const OPENROUTER_FREE_KEY_ENVS = [
  'OPENROUTER_FREE_API_KEY',
  'OPENROUTER_API_KEY_2',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY_3',
  'OPENROUTER_API_KEY_4',
] as const;

const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://apex.donmatthews.live',
  'X-Title': 'APEX Agent Workforce',
} as const;

const PROVIDERS: Array<{
  name: string;
  baseURL: string;
  fallbackModel: string;
  extraHeaders?: Record<string, string>;
}> = [
  // Zero-cost OpenRouter chain. Paid endpoints are unreachable.
  { name: 'openrouter-nex-n2-5-mini-free', baseURL: 'https://openrouter.ai/api/v1', fallbackModel: 'nex-agi/nex-n2.5-mini:free', extraHeaders: OPENROUTER_HEADERS },
  { name: 'openrouter-nex-n2-5-pro-free', baseURL: 'https://openrouter.ai/api/v1', fallbackModel: 'nex-agi/nex-n2.5-pro:free', extraHeaders: OPENROUTER_HEADERS },
  { name: 'openrouter-nemotron-super', baseURL: 'https://openrouter.ai/api/v1', fallbackModel: 'nvidia/nemotron-3-super-120b-a12b:free', extraHeaders: OPENROUTER_HEADERS },
  { name: 'openrouter-nemotron-3-5-lightning-free', baseURL: 'https://openrouter.ai/api/v1', fallbackModel: 'nvidia/nemotron-3.5-lightning:free', extraHeaders: OPENROUTER_HEADERS },
  { name: 'openrouter-free-router', baseURL: 'https://openrouter.ai/api/v1', fallbackModel: 'openrouter/free', extraHeaders: OPENROUTER_HEADERS },
  { name: 'openrouter-nemotron-ultra', baseURL: 'https://openrouter.ai/api/v1', fallbackModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', extraHeaders: OPENROUTER_HEADERS },
];

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  toolCallId?: string;
  name?: string;
};

export type LLMTool = { name: string; description: string; parameters: Record<string, unknown> };
export type LLMResponse = {
  content: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage: { promptTokens: number; completionTokens: number };
  model: string;
};

async function completeImpl(
  messages: LLMMessage[],
  tools: LLMTool[] | undefined,
  llmConfig: { model: string; temperature?: number; maxTokens?: number; role?: string },
): Promise<LLMResponse> {
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
  const seenAccounts = new Set<string>();
  const credentials = OPENROUTER_FREE_KEY_ENVS
    .map((env) => ({ env, key: process.env[env] ?? '' }))
    .filter((entry) => Boolean(entry.key))
    .filter((entry) => {
      if (seenAccounts.has(entry.key)) return false;
      seenAccounts.add(entry.key);
      return true;
    });

  for (const provider of PROVIDERS) {
    if (credentials.length === 0) {
      console.warn(`[LLM] Skipping ${provider.name}: no OpenRouter free credential configured`);
      continue;
    }

    const model = provider.fallbackModel;

    for (const credential of credentials) {
      try {
        const defaultHeaders: Record<string, string> = {};
        if (provider.extraHeaders) Object.assign(defaultHeaders, provider.extraHeaders);

        const client = new OpenAI({
          apiKey: credential.key,
          baseURL: provider.baseURL,
          defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
          timeout: LLM_REQUEST_TIMEOUT_MS,
          maxRetries: 0,
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
        let res;
        try {
          res = await client.chat.completions.create(
            {
              model,
              messages: openaiMessages,
              tools: openaiTools && openaiTools.length > 0 ? openaiTools : undefined,
              temperature: llmConfig.temperature ?? 0.7,
              max_tokens: llmConfig.maxTokens ?? 4096,
              ...(model === 'openrouter/free' && openaiTools && openaiTools.length > 0
                ? { provider: { require_parameters: true } }
                : {}),
            } as Parameters<typeof client.chat.completions.create>[0],
            { signal: controller.signal },
          );
        } finally {
          clearTimeout(timeoutId);
        }

        const choice = res.choices[0];
        const toolCalls = (choice.message.tool_calls ?? []).flatMap((tc) => {
          if (tc.type !== 'function') return [];
          return [{ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments) as Record<string, unknown> }];
        });

        if (providerErrors.length > 0) {
          console.warn(`[LLM] Succeeded with ${provider.name}/${model} after ${providerErrors.length} failed provider(s): ${providerErrors.map((e) => `${e.provider}(${e.status ?? '?'}: ${e.message})`).join(', ')}`);
        }

        return {
          content: choice.message.content ?? '',
          toolCalls,
          usage: { promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0 },
          model: `${provider.name}/${res.model}`,
        };
      } catch (err) {
        const status = (err as any)?.status ?? (err as any)?.response?.status ?? (err as any)?.code;
        const errMessage = err instanceof Error ? err.message : String(err);
        const truncatedMsg = errMessage.length > 200 ? errMessage.slice(0, 200) + '…' : errMessage;
        console.error(`[LLM] Provider ${provider.name} via ${credential.env} failed — model: ${model}, status: ${status ?? 'N/A'}, error: ${truncatedMsg}`);
        providerErrors.push({ provider: `${provider.name}/${credential.env}`, model, status, message: truncatedMsg });
        // 429/402: try the next independent account. Other failures advance models.
        if (status !== 429 && status !== 402) break;
      }
    }
  }

  const errorSummary = providerErrors.length > 0
    ? providerErrors.map((e) => `  • ${e.provider} (model: ${e.model}, status: ${e.status ?? 'N/A'}): ${e.message}`).join('\n')
    : '  (no providers were configured or had API keys)';

  console.error(`[LLM] All providers exhausted:\n${errorSummary}`);
  throw new Error(`All LLM providers failed.\n${errorSummary}`);
}

export const complete = internalAction({
  args: {
    messages: v.array(v.any()),
    tools: v.optional(v.array(v.any())),
    model: v.string(),
    temperature: v.optional(v.number()),
    maxTokens: v.optional(v.number()),
    role: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    return await completeImpl(args.messages as LLMMessage[], args.tools as LLMTool[] | undefined, {
      model: args.model,
      role: args.role,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
    });
  },
});

// Pure config helpers (getDefaultLLMConfig, getConfiguredProviders,
// getKnownApiKeyEnvs) live in ./llmConfig.ts, not here — that file has no
// 'use node' directive, so default-runtime files (agentLoop.ts) can import
// them directly without pulling in this file's Node-only bundle. Re-exported
// here too for convenience/back-compat.
export { getDefaultLLMConfig, getConfiguredProviders, getKnownApiKeyEnvs } from './llmConfig.js';

// ─── Embedding Generation ─────────────────────────────────────────────────────

async function createEmbeddingImpl(_text: string): Promise<number[]> {
  throw new Error(
    'Paid OpenAI embeddings are disabled while APEX is in zero-cost mode; caller should fall back to keyword search',
  );
}

export const createEmbedding = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => createEmbeddingImpl(text),
});

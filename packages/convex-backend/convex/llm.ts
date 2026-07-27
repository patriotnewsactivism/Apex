'use node';

// ─── Multi-Provider Fallback Client ───────────────────────────────────────────
//
// Ports packages/core/src/llm-client.ts. Needs the Node runtime (not the
// default V8-isolate action runtime) for the `openai` SDK.
//
// Deliberately does NOT port the old local-embedding fallback
// (@xenova/transformers, real ONNX inference): that pulls in onnxruntime-node
// (~92MB) + sharp (~50MB), blowing Convex's per-function bundle size limit —
// a hard platform constraint, not a style choice. createEmbedding here is
// OpenAI-API-only; when OPENAI_API_KEY isn't set it throws, which the caller
// (agentLoop.ts's buildMemoryContext) already catches and falls back to
// keyword search for — a graceful degrade, not a crash. If local embeddings
// are ever needed again, that's exactly the kind of "needs a real Node
// environment Convex can't provide" work that belongs on the M5 CI/CD worker,
// not here.
//
// Reordered 2026-07-26 after a full live-key audit (direct curl against every
// configured key, with proper User-Agent — api.cerebras.ai/api.groq.com were
// throwing Cloudflare 403 error 1010 on bare urllib requests with no UA,
// which looked like dead keys but were a false alarm once a real UA was
// sent). Confirmed live: Cerebras, Groq, Cohere (COHERE_API_KEY). Confirmed
// dead/blocked: Mistral (401), Qwen Cloud (401 on wrong endpoint), Cohere-trial
// (429, monthly cap), GitHub Models (no_access), xAI (403, credits exhausted),
// Kilo Code (402, negative balance). Dead/blocked entries kept in the chain —
// harmless no-ops today, zero-code-change recovery once Don rotates a key.

import { v } from 'convex/values';
import { internalAction } from './_generated/server';

const PROVIDERS: Array<{
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  fallbackModel?: string;
  extraHeaders?: Record<string, string>;
}> = [
  { name: 'cerebras', baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY', fallbackModel: 'gpt-oss-120b' },
  { name: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', fallbackModel: 'llama-3.3-70b-versatile' },
  { name: 'cohere', baseURL: 'https://api.cohere.com/compatibility/v1', apiKeyEnv: 'COHERE_API_KEY', fallbackModel: 'command-r-plus-08-2024' },
  { name: 'mistral', baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', fallbackModel: 'mistral-small-latest' },
  { name: 'qwen-cloud', baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWENCLOUD_API_KEY', fallbackModel: 'qwen-plus' },
  { name: 'openrouter-free', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'openai/gpt-oss-20b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
  { name: 'openrouter-free-2', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'nvidia/nemotron-3-super-120b-a12b:free', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' } },
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
  llmConfig: { model: string; temperature?: number; maxTokens?: number },
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

  for (const provider of PROVIDERS) {
    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey) {
      console.warn(`[LLM] Skipping ${provider.name}: no ${provider.apiKeyEnv} configured`);
      continue;
    }

    const model: string = provider.fallbackModel ?? llmConfig.model;

    try {
      const defaultHeaders: Record<string, string> = {};
      if (provider.extraHeaders) Object.assign(defaultHeaders, provider.extraHeaders);

      const client = new OpenAI({
        apiKey,
        baseURL: provider.baseURL,
        defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
        timeout: 75_000,
        maxRetries: 0,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 75_000);
      let res;
      try {
        res = await client.chat.completions.create(
          {
            model,
            messages: openaiMessages,
            tools: openaiTools && openaiTools.length > 0 ? openaiTools : undefined,
            temperature: llmConfig.temperature ?? 0.7,
            max_tokens: llmConfig.maxTokens ?? 4096,
          },
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
      console.error(`[LLM] Provider ${provider.name} failed — model: ${model}, status: ${status ?? 'N/A'}, error: ${truncatedMsg}`);
      providerErrors.push({ provider: provider.name, model, status, message: truncatedMsg });
      continue;
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
  },
  handler: async (_ctx, args) => {
    return await completeImpl(args.messages as LLMMessage[], args.tools as LLMTool[] | undefined, {
      model: args.model,
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

async function createEmbeddingImpl(text: string): Promise<number[]> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error('OPENAI_API_KEY is not set — embeddings are unavailable (caller should fall back to keyword search)');
  }

  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    apiKey: openaiKey,
    defaultHeaders: { 'HTTP-Referer': 'https://github.com/apex-agent', 'X-Title': 'APEX Autonomous AI Workforce' },
  });

  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),
  });

  return response.data[0].embedding;
}

export const createEmbedding = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => createEmbeddingImpl(text),
});

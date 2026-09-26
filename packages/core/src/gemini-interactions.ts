import type {
  LLMClientConfig,
  LLMExecutionContext,
  LLMMessage,
  LLMResponse,
  LLMTool,
  LLMToolCall,
} from './types.js';

type GeminiStep = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
};

type GeminiResponse = {
  id?: string;
  status?: string;
  model?: string;
  steps?: GeminiStep[];
  usage?: {
    total_tokens?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    cached_input_tokens?: number;
  };
  errors?: Array<{ message?: string; code?: string | number }>;
  error?: { message?: string; code?: string | number };
};

type ProviderRequestError = Error & {
  status?: number;
  retryAfterMs?: number;
  requestedModels?: string[];
  latencyMs?: number;
};

type GeminiSession = {
  interactionId: string;
  updatedAt: number;
};

const sessions = new Map<string, GeminiSession>();
const SESSION_TTL_MS = 30 * 60_000;

function sessionKey(execution?: LLMExecutionContext): string | null {
  if (execution?.conversationId) return `conversation:${execution.conversationId}`;
  if (execution?.taskId) return `task:${execution.taskId}`;
  return null;
}

function cleanupSessions(now = Date.now()): void {
  for (const [key, state] of sessions) {
    if (now - state.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

function systemInstruction(messages: LLMMessage[]): string | undefined {
  const text = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

function toolDeclarations(tools?: LLMTool[]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function fullHistoryInput(messages: LLMMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      out.push({
        type: 'user_input',
        content: [{ type: 'text', text: message.content }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) {
        out.push({
          type: 'model_output',
          content: [{ type: 'text', text: message.content }],
        });
      }
      for (const call of message.toolCalls ?? []) {
        out.push({
          type: 'function_call',
          id: call.id,
          name: call.name,
          arguments: call.args,
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        type: 'function_result',
        name: message.name ?? 'tool',
        call_id: message.toolCallId ?? '',
        result: [{ type: 'text', text: message.content }],
      });
    }
  }
  return out;
}

function continuationInput(messages: LLMMessage[]): unknown[] {
  // The previous Gemini interaction already stores its own model output and
  // function_call steps. Only send work APEX produced after that turn.
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  const tail = lastAssistant >= 0 ? messages.slice(lastAssistant + 1) : messages;
  const input: unknown[] = [];
  for (const message of tail) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_result',
        name: message.name ?? 'tool',
        call_id: message.toolCallId ?? '',
        result: [{ type: 'text', text: message.content }],
      });
    } else if (message.role === 'user') {
      input.push({
        type: 'user_input',
        content: [{ type: 'text', text: message.content }],
      });
    }
  }
  // A stateful continuation should normally be function results. If the
  // caller has no structured tail, send the latest user input rather than an
  // empty interaction body.
  if (input.length === 0) {
    const latestUser = [...messages].reverse().find((message) => message.role === 'user');
    if (latestUser) {
      input.push({
        type: 'user_input',
        content: [{ type: 'text', text: latestUser.content }],
      });
    }
  }
  return input;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function extractText(steps: GeminiStep[] | undefined): string {
  const chunks: string[] = [];
  for (const step of steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
    }
  }
  return chunks.join('');
}

function extractToolCalls(steps: GeminiStep[] | undefined): LLMToolCall[] {
  const calls: LLMToolCall[] = [];
  for (const step of steps ?? []) {
    if (step.type !== 'function_call' || !step.name) continue;
    const args =
      step.arguments && typeof step.arguments === 'object' && !Array.isArray(step.arguments)
        ? step.arguments
        : {};
    calls.push({
      id: step.id ?? `gemini-tool-${calls.length + 1}`,
      name: step.name,
      args,
    });
  }
  return calls;
}

export async function callGeminiInteractions(input: {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  config: LLMClientConfig;
  execution?: LLMExecutionContext;
  timeoutMs: number;
}): Promise<LLMResponse> {
  cleanupSessions();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const key = sessionKey(input.execution);
  const previous = key ? sessions.get(key) : undefined;

  try {
    const body: Record<string, unknown> = {
      model: input.model,
      input: previous
        ? continuationInput(input.messages)
        : fullHistoryInput(input.messages),
      tools: toolDeclarations(input.tools),
      system_instruction: systemInstruction(input.messages),
      generation_config: {
        max_output_tokens: input.config.maxTokens ?? 2048,
        // Gemini 3.8 Interactions rejects legacy sampling knobs on some
        // requests. Keep the supported thinking-level control and output cap.
        // APEX optimizes autonomous throughput, so low thinking preserves
        // reasoning while reducing latency/token burn for routine tool turns.
        thinking_level: 'low',
      },
    };

    if (previous) {
      body.previous_interaction_id = previous.interactionId;
      body.store = true;
    } else if (key) {
      // APEX task/chat turns need server-side state so thought signatures and
      // function-call history survive the local tool-execution round trip.
      body.store = true;
    } else {
      // Diagnostics and isolated one-shot calls do not need server retention.
      body.store = false;
    }

    const response = await fetch(`${input.baseURL.replace(/\/$/, '')}/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.apiKey,
        'Api-Revision': '2026-05-20',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed: GeminiResponse = {};
    try {
      parsed = raw ? (JSON.parse(raw) as GeminiResponse) : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      if (key) sessions.delete(key);
      const detail =
        parsed.error?.message ||
        parsed.errors?.map((error) => error.message).filter(Boolean).join(' | ') ||
        raw.slice(0, 500) ||
        `HTTP ${response.status}`;
      throw Object.assign(new Error(detail), {
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      });
    }

    const toolCalls = extractToolCalls(parsed.steps);
    const content = extractText(parsed.steps);
    if (parsed.status === 'failed' || parsed.status === 'cancelled') {
      if (key) sessions.delete(key);
      const detail =
        parsed.errors?.map((error) => error.message).filter(Boolean).join(' | ') ||
        `Gemini interaction ${parsed.status}`;
      throw new Error(detail);
    }
    if (!content.trim() && toolCalls.length === 0) {
      if (key) sessions.delete(key);
      throw new Error(`Gemini returned no text or function call (status: ${parsed.status ?? 'unknown'})`);
    }

    if (key && parsed.id && toolCalls.length > 0) {
      sessions.set(key, { interactionId: parsed.id, updatedAt: Date.now() });
    } else if (key) {
      sessions.delete(key);
    }

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: Math.max(0, parsed.usage?.total_input_tokens ?? 0),
        completionTokens: Math.max(0, parsed.usage?.total_output_tokens ?? 0),
      },
      model: `gemini-3-8-flash-byok/${parsed.model ?? input.model}`,
      servedModel: parsed.model ?? input.model,
      requestedModels: [input.model],
      latencyMs: Date.now() - startedAt,
      costUsd: null,
      cachedTokens: Math.max(0, parsed.usage?.cached_input_tokens ?? 0),
      reasoningTokens: Math.max(0, parsed.usage?.total_thought_tokens ?? 0),
    };
  } catch (error) {
    const err =
      error instanceof Error
        ? (error as ProviderRequestError)
        : (new Error(String(error)) as ProviderRequestError);
    err.requestedModels = [input.model];
    err.latencyMs = Date.now() - startedAt;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

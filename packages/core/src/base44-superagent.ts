import { z } from 'zod';
import type { ToolDefinition } from './types.js';

const DEFAULT_AGENT_ID = '6a515f4e071e32fc10378575';
const BASE44_AGENT_API = 'https://app.base44.com/api/agents';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

type Base44Message = {
  id?: string;
  role?: string;
  content?: string;
};

type Base44Conversation = {
  id?: string;
  conversation_id?: string;
  messages?: Base44Message[];
  [key: string]: unknown;
};

export type Base44SuperagentResult = {
  conversationId: string;
  messageId: string | null;
  content: string;
};

function apiKey(): string {
  return process.env.BASE44_SUPERAGENT_API_KEY?.trim() ?? '';
}

export function base44SuperagentId(): string {
  return process.env.BASE44_SUPERAGENT_ID?.trim() || DEFAULT_AGENT_ID;
}

export function base44SuperagentConfigured(): boolean {
  return Boolean(apiKey() && base44SuperagentId());
}

function configuredTimeoutMs(requested?: number): number {
  if (requested !== undefined) {
    return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(requested)));
  }
  const raw = Number(process.env.BASE44_SUPERAGENT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(raw)));
}

function conversationIdFrom(value: Base44Conversation): string | null {
  if (typeof value.id === 'string' && value.id) return value.id;
  if (typeof value.conversation_id === 'string' && value.conversation_id) return value.conversation_id;
  return null;
}

async function base44Fetch<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const key = apiKey();
  if (!key) {
    throw new Error('BASE44_SUPERAGENT_API_KEY is not configured');
  }

  const url = `${BASE44_AGENT_API}/${encodeURIComponent(base44SuperagentId())}${path}`;
  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      'Content-Type': 'application/json',
      api_key: key,
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Base44 Superagent API ${response.status}: ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function createBase44SuperagentConversation(
  signal?: AbortSignal,
): Promise<string> {
  const conversation = await base44Fetch<Base44Conversation>(
    '/conversations',
    { method: 'POST', body: '{}' },
    signal,
  );
  const id = conversationIdFrom(conversation);
  if (!id) throw new Error('Base44 did not return a conversation id');
  return id;
}

export async function getBase44SuperagentConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<Base44Conversation> {
  return base44Fetch<Base44Conversation>(
    `/conversations/${encodeURIComponent(conversationId)}`,
    { method: 'GET' },
    signal,
  );
}

function newestNewAssistantMessage(
  conversation: Base44Conversation,
  priorAssistantIds: Set<string>,
  priorAssistantCount: number,
): Base44Message | null {
  const assistants = (conversation.messages ?? []).filter(
    (message) => message.role === 'assistant' && typeof message.content === 'string',
  );

  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    const message = assistants[i];
    if (message.id && !priorAssistantIds.has(message.id)) return message;
  }

  if (assistants.length > priorAssistantCount) {
    return assistants[assistants.length - 1] ?? null;
  }
  return null;
}

export async function callBase44Superagent(input: {
  task: string;
  conversationId?: string;
  fileUrls?: string[];
  timeoutMs?: number;
}): Promise<Base44SuperagentResult> {
  const task = input.task.trim();
  if (!task) throw new Error('Base44 Superagent task must not be empty');
  if (!base44SuperagentConfigured()) {
    throw new Error(
      'Base44 Superagent is not configured. Set BASE44_SUPERAGENT_API_KEY as a server-side secret.',
    );
  }

  const timeoutMs = configuredTimeoutMs(input.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let conversationId = input.conversationId?.trim() || '';
    let before: Base44Conversation = { messages: [] };

    if (conversationId) {
      before = await getBase44SuperagentConversation(conversationId, controller.signal);
    } else {
      conversationId = await createBase44SuperagentConversation(controller.signal);
    }

    const priorAssistants = (before.messages ?? []).filter((message) => message.role === 'assistant');
    const priorAssistantIds = new Set(
      priorAssistants.map((message) => message.id).filter((id): id is string => Boolean(id)),
    );
    const priorAssistantCount = priorAssistants.length;

    await base44Fetch<unknown>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          role: 'user',
          content: task,
          file_urls: input.fileUrls ?? [],
        }),
      },
      controller.signal,
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const conversation = await getBase44SuperagentConversation(conversationId, controller.signal);
      const reply = newestNewAssistantMessage(
        conversation,
        priorAssistantIds,
        priorAssistantCount,
      );
      if (reply?.content) {
        return {
          conversationId,
          messageId: reply.id ?? null,
          content: reply.content,
        };
      }
      await new Promise<void>((resolve, reject) => {
        const pollTimer = setTimeout(resolve, POLL_INTERVAL_MS);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(pollTimer);
            reject(new Error('Base44 Superagent request timed out'));
          },
          { once: true },
        );
      });
    }

    throw new Error(`Base44 Superagent did not complete within ${timeoutMs}ms`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Base44 Superagent request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createBase44SuperagentTools(): ToolDefinition[] {
  return [
    {
      name: 'base44_superagent',
      description:
        'Delegate a bounded task to the configured Base44 Superagent and return its completed response. Use it as an external specialist/second-opinion worker for planning, synthesis, analysis, or other work where another autonomous agent is valuable. Pass conversationId to continue an existing Base44 thread; omit it to start a fresh one.',
      schema: z.object({
        task: z
          .string()
          .min(1)
          .max(100_000)
          .describe('Complete task or question to delegate to the Base44 Superagent'),
        conversationId: z
          .string()
          .optional()
          .describe('Existing Base44 conversation id to continue; omit for a fresh conversation'),
        fileUrls: z
          .array(z.string().url())
          .max(10)
          .optional()
          .describe('Optional public file URLs that Base44 should receive with the task'),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe('Maximum time to wait for the completed assistant response (default 90000ms)'),
      }),
      requiresApproval: false,
      async execute(args) {
        return callBase44Superagent(args);
      },
    },
  ];
}

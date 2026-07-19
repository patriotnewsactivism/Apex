import { z } from 'zod';

// ─── LLM ─────────────────────────────────────────────────────────────────────

// All LLM calls are routed through OpenRouter (openrouter.ai).
// The "provider" field is kept for future extensibility but defaults to 'openrouter'.
export type LLMProvider = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'cohere' | 'poolside';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface LLMToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  model: string;
}

export interface LLMClientConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  // Agent role (e.g. 'LEAD_DEV', 'QA') — used to pick role-appropriate models
  // when falling back to a provider that doesn't support the primary
  // OpenRouter model ID (e.g. routing coding roles to Mistral's Devstral/Codestral).
  role?: string;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodSchema<TInput>;
  requiresApproval: boolean;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

export interface ToolContext {
  agentId: string;
  taskId?: string;
  goalId?: string;
  workspaceRoot: string;
  requestApproval: (toolName: string, args: unknown, reason: string) => Promise<boolean>;
  delegateToRole?: (targetRole: string, input: { title: string; description: string; parentTaskId?: string; context?: Record<string, unknown> }) => Promise<string>;
  delegateToAgent?: (targetAgentId: string, input: { title: string; description: string; parentTaskId?: string; goalId?: string; context?: Record<string, unknown> }) => Promise<string>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export type AgentRole =
  | 'CEO'
  | 'CTO'
  | 'COO'
  | 'LEAD_DEV'
  | 'FRONTEND'
  | 'BACKEND'
  | 'DEVOPS'
  | 'QA'
  | 'RESEARCH'
  | 'DOCS'
  | 'OPS'
  | 'LEAD_RESEARCH'
  | 'SALES'
  | 'MARKETING'
  | 'CUSTOMER_SUCCESS'
  | 'QA_DIRECTOR';

export type AgentStatus = 'idle' | 'thinking' | 'acting' | 'blocked' | 'done' | 'error';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface AgentConfig {
  id: string;
  name: string;
  role: AgentRole;
  tier: number;
  parentId?: string;
  systemPrompt: string;
  llm: LLMClientConfig;
  tools: string[]; // tool names this agent is allowed to use
  maxIterations?: number; // safety limit for autonomous loops
  approvalRequired?: boolean; // gate all actions through human approval
  // Max tasks this agent instance will run concurrently from its own queue.
  // Default 1 preserves existing strictly-sequential behavior. Bump this for
  // roles that receive dispatchSwarm fan-outs (e.g. QA_DIRECTOR, LEAD_RESEARCH)
  // so N independent swarm instances actually execute in parallel instead of
  // queuing up behind one another.
  concurrency?: number;
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export interface TaskInput {
  title: string;
  description: string;
  goalId?: string;
  parentTaskId?: string;
  priority?: number;
  context?: Record<string, unknown>;
}

export interface TaskResult {
  success: boolean;
  output?: string;
  artifacts?: string[]; // file paths created
  error?: string;
  subTasks?: string[]; // IDs of spawned sub-tasks
}

// ─── Events (for WebSocket broadcast) ────────────────────────────────────────

export type ApexEvent =
  | { type: 'agent:status'; agentId: string; status: AgentStatus; message?: string }
  | { type: 'task:created'; taskId: string; title: string; assignedAgentId?: string }
  | { type: 'task:updated'; taskId: string; status: TaskStatus; result?: string }
  | { type: 'goal:created'; goalId: string; title: string }
  | { type: 'goal:updated'; goalId: string; status: string }
  | { type: 'log'; agentId?: string; taskId?: string; level: string; message: string; timestamp: number }
  | { type: 'approval:requested'; approvalId: string; agentId: string; toolName: string; reason: string }
  | { type: 'approval:resolved'; approvalId: string; status: 'approved' | 'rejected' }
  | { type: 'memory:updated'; agentId: string; key: string }
  | { type: 'message:sent'; messageId: string; fromAgentId: string; toAgentId: string; subject: string };

import { BaseAgent as CoreBaseAgent } from './base-agent.js';
import {
  estimatePreRunComplexity,
  getCurrentLLMExecutionContext,
  withLLMExecutionContext,
} from './model-execution-context.js';
import type { AgentConfig, TaskResult } from './types.js';

/**
 * Thin production wrapper around the existing governed BaseAgent. It changes no
 * task semantics; it only binds durable task identity to the async call chain so
 * nested LLM generations can be attributed correctly even when one agent runs
 * several tasks concurrently.
 */
export class BaseAgent extends CoreBaseAgent {
  constructor(config: AgentConfig) {
    super(config);

    // BaseAgent's governed execution loop owns the LLM calls. Wrap the client
    // once so those existing calls inherit the task-local AsyncLocalStorage
    // context without rewriting the mature task loop or using mutable globals.
    const complete = this.llm.complete.bind(this.llm);
    this.llm.complete = (messages, tools, execution) =>
      complete(messages, tools, execution ?? getCurrentLLMExecutionContext());
  }

  protected override async executeTask(
    taskId: string,
    title: string,
    description: string,
    context: Record<string, unknown>,
  ): Promise<TaskResult> {
    return withLLMExecutionContext(
      {
        taskId,
        agentId: this.id,
        role: this.role,
        complexityHint: estimatePreRunComplexity(`${title}\n${description}`, context),
      },
      () => super.executeTask(taskId, title, description, context),
    );
  }
}

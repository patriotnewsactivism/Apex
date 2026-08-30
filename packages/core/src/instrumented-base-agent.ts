import { BaseAgent as CoreBaseAgent } from './base-agent.js';
import { estimatePreRunComplexity, withLLMExecutionContext } from './model-execution-context.js';
import type { TaskResult } from './types.js';

/**
 * Thin production wrapper around the existing governed BaseAgent. It changes no
 * task semantics; it only binds durable task identity to the async call chain so
 * nested LLM generations can be attributed correctly even when one agent runs
 * several tasks concurrently.
 */
export class BaseAgent extends CoreBaseAgent {
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

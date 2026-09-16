import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMExecutionContext } from './types.js';

const llmExecutionContext = new AsyncLocalStorage<LLMExecutionContext>();

export function getCurrentLLMExecutionContext(): LLMExecutionContext | undefined {
  return llmExecutionContext.getStore();
}

export async function withLLMExecutionContext<T>(
  context: LLMExecutionContext,
  run: () => Promise<T>,
): Promise<T> {
  return llmExecutionContext.run(context, run);
}

/**
 * Coarse pre-run complexity hint for routing. This intentionally uses only data
 * available before execution. The learning system's post-run complexity score
 * remains authoritative for evaluating the completed task.
 */
export function estimatePreRunComplexity(description: string, context?: Record<string, unknown>): number {
  const explicit = Number(context?.complexity ?? context?.complexityHint);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(1, explicit));

  let score = 0.25;
  const length = description.trim().length;
  if (length > 400) score += 0.10;
  if (length > 1_000) score += 0.15;
  if (length > 2_500) score += 0.15;
  if (/deploy|migration|architecture|refactor|debug|investigate|security|production|multi[- ]?step|end[- ]?to[- ]?end/i.test(description)) score += 0.15;
  return Math.max(0, Math.min(1, score));
}

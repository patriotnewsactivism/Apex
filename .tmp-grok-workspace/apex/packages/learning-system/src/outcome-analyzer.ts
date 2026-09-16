// ─── OutcomeAnalyzer ──────────────────────────────────────────────────────────
//
// Analyzes completed task execution parameters, calculates complexity and
// satisfaction metrics, classifies errors, generates tags, and records the
// outcome in the task_outcomes database table.

import { db, taskOutcomes, type NewTaskOutcome } from '@workspace/db';

export interface OutcomeParams {
  taskId: string;
  agentId: string;
  role: string;
  durationMs: number;
  success: boolean;
  qualityScore?: number;
  toolExecutions?: number;
  llmCalls?: number;
  iterations?: number;
  requiredApprovals?: number;
  errorMessage?: string;
  taskTitle?: string;
  description?: string;
}

export class OutcomeAnalyzer {
  /** Calculate estimated task complexity (0.0 to 1.0) based on length and iterations. */
  static calculateComplexity(description: string = '', iterations: number = 1, toolExecutions: number = 0): number {
    let score = 0.2;
    if (description.length > 500) score += 0.2;
    if (iterations > 3) score += 0.3;
    if (toolExecutions > 5) score += 0.3;
    return Math.min(1.0, score);
  }

  /** Calculate overall satisfaction metric (0.0 to 1.0). */
  static calculateSatisfactionMetric(success: boolean, iterations: number = 1, errorType?: string): number {
    if (!success) {
      if (errorType === 'timeout') return 0.2;
      if (errorType === 'rejection') return 0.4;
      return 0.1;
    }
    // Success — penalty for excessive iterations
    if (iterations > 10) return 0.7;
    if (iterations > 5) return 0.85;
    return 1.0;
  }

  /** Classify raw error string into standard error categories. */
  static classifyError(errorMessage?: string): string | null {
    if (!errorMessage) return null;
    const lower = errorMessage.toLowerCase();
    if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
    if (lower.includes('rejected') || lower.includes('denied')) return 'rejection';
    if (lower.includes('max iterations')) return 'max_iterations_exceeded';
    if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit';
    if (lower.includes('network') || lower.includes('fetch failed')) return 'network_error';
    if (lower.includes('syntax') || lower.includes('parse')) return 'parse_error';
    return 'execution_error';
  }

  /** Generate descriptive tags for indexing outcomes. */
  static generateOutcomeTags(taskTitle: string = '', role: string = 'unknown', success: boolean, errorType?: string | null): string[] {
    const safeRole = (role || 'unknown').toLowerCase();
    const tags: string[] = [safeRole, success ? 'status:success' : 'status:failure'];
    if (errorType) tags.push(`error:${errorType}`);
    const lowerTitle = (taskTitle || '').toLowerCase();
    if (lowerTitle.includes('swarm')) tags.push('feature:swarm');
    if (lowerTitle.includes('refactor') || lowerTitle.includes('build')) tags.push('type:dev');
    if (lowerTitle.includes('review') || lowerTitle.includes('test')) tags.push('type:qa');
    return tags;
  }

  /**
   * Analyze and record task outcome to database.
   * Guaranteed safe execution (catches internal errors so caller loop is never disrupted).
   */
  async recordOutcome(params: OutcomeParams): Promise<boolean> {
    try {
      const errorType = OutcomeAnalyzer.classifyError(params.errorMessage);
      const complexity = OutcomeAnalyzer.calculateComplexity(
        params.description,
        params.iterations ?? 1,
        params.toolExecutions ?? 0,
      );
      const satisfaction = OutcomeAnalyzer.calculateSatisfactionMetric(
        params.success,
        params.iterations ?? 1,
        errorType ?? undefined,
      );
      const tags = OutcomeAnalyzer.generateOutcomeTags(
        params.taskTitle,
        params.role,
        params.success,
        errorType,
      );

      const record: NewTaskOutcome = {
        taskId: params.taskId,
        agentId: params.agentId,
        role: params.role,
        durationMs: params.durationMs,
        success: params.success,
        qualityScore: params.qualityScore ?? (params.success ? 1.0 : 0.0),
        toolExecutions: params.toolExecutions ?? 0,
        llmCalls: params.llmCalls ?? (params.iterations ?? 1),
        iterations: params.iterations ?? 1,
        requiredApprovals: params.requiredApprovals ?? 0,
        errorType: errorType ?? null,
        complexity,
        satisfactionMetric: satisfaction,
        tags,
        recordedAt: new Date(),
      };

      await db.insert(taskOutcomes).values(record);
      return true;
    } catch (err) {
      console.error('[OutcomeAnalyzer] Failed to record outcome:', err);
      return false;
    }
  }
}

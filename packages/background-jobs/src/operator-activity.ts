import { db, logs } from '@workspace/db';
import { emitApexEvent } from '@workspace/core';

export type OperatorActivityCategory =
  | 'lead_search'
  | 'lead_cleanup'
  | 'contact_recovery'
  | 'pipeline'
  | 'campaign'
  | 'provider'
  | 'system';

export interface OperatorActivityInput {
  category: OperatorActivityCategory;
  message: string;
  level?: 'info' | 'warn' | 'error';
  agentId?: string;
  taskId?: string | null;
  goalId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Durable, plain-English history for the operator.
 *
 * This intentionally records outcomes, not noisy internal steps. If APEX says
 * "found 8 contacts" here, that is because the underlying operation completed
 * and supplied that count. The dashboard can therefore show a long rolling
 * history without turning into a wall of debug chatter.
 */
export async function recordOperatorActivity(input: OperatorActivityInput): Promise<void> {
  const timestamp = new Date();
  const level = input.level ?? 'info';
  const agentId = input.agentId ?? 'apex-system';

  try {
    await db.insert(logs).values({
      agentId,
      taskId: input.taskId ?? null,
      goalId: input.goalId ?? null,
      level,
      message: input.message,
      data: {
        kind: 'operator_activity',
        category: input.category,
        ...(input.data ?? {}),
      },
      timestamp,
    });
  } catch (err) {
    console.warn(
      '[operator-activity] persistence failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  emitApexEvent({
    type: 'log',
    agentId,
    taskId: input.taskId ?? undefined,
    level,
    message: input.message,
    data: {
      kind: 'operator_activity',
      category: input.category,
      ...(input.data ?? {}),
    },
    timestamp: timestamp.getTime(),
  });
}

// ─── OrchestrationEngine ──────────────────────────────────────────────────────
//
// Cross-repository task orchestrator. Delegates tasks to target applications while
// adhering to each repo's standing rules.

import { db, applicationTasks, type NewApplicationTaskRow } from '@workspace/db';

export class OrchestrationEngine {
  /** Delegate a task to a registered target application. Requires approval. */
  async delegateToApplication(appId: string, taskName: string) {
    const record: NewApplicationTaskRow = {
      appId,
      taskName,
      status: 'pending',
      createdAt: new Date(),
    };

    const [inserted] = await db.insert(applicationTasks).values(record).returning();

    return {
      taskId: inserted.id,
      appId,
      taskName,
      status: 'pending',
    };
  }
}

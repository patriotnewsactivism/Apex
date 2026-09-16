// ─── ExecutorDispatchJob — sandbox dispatch via the cron table ───────────────
//
// Phase 4: when an agent schedules executor_dispatch (min 15-minute floor via
// the governor), each fire dispatches every due, undispatched runtime='job'
// task to the Cloud Run Jobs sandbox. In the default control-plane wiring the
// api-server also runs a 30-second interval loop, so this handler is the
// agent-reaching path — either one can win a dispatch, and the compare-and-set
// marker in dispatchDueExecutorTasks prevents double execution.

import type { JobHandler } from './handlers/index.js';

export class ExecutorDispatchJob implements JobHandler {
  async execute(): Promise<unknown> {
    const { dispatchDueExecutorTasks } = await import('@workspace/executor');
    const result = await dispatchDueExecutorTasks({ maxPerCycle: 3 });
    return {
      ...result,
      note: result.config?.configured === false
        ? 'APEX_EXECUTOR_JOB is not set — dispatch is a no-op until configured'
        : 'dispatched to Cloud Run Jobs sandbox',
    };
  }
}
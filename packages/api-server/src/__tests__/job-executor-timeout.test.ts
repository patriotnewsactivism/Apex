/**
 * Scheduled executor timeout: the execution's AbortController must be aborted
 * BEFORE the timeout is recorded and the retry (status='active', nextRunAt) is
 * written, so cooperative handlers stop before the occurrence can be retried.
 * Behavioural companion to scripts/verify-durable-autonomy.ts
 * ("timeout aborts cooperative work before recording retry"). No database:
 * @workspace/db is replaced with an in-memory recorder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Write = { table: string; values: Record<string, unknown>; signalAborted: boolean | null };
const state = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; values: Record<string, unknown>; signalAborted: boolean | null }>,
  signal: null as AbortSignal | null,
  job: null as Record<string, unknown> | null,
}));

vi.mock('@workspace/db', () => {
  const scheduledJobs = { __name: 'scheduled_jobs', id: 'scheduled_jobs.id' };
  const jobExecutionLog = { __name: 'job_execution_log', executionId: 'job_execution_log.execution_id' };
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (state.job ? [state.job] : []) }) }) }),
    insert: (table: { __name: string }) => ({
      values: async (values: Record<string, unknown>) => {
        state.writes.push({ table: table.__name, values, signalAborted: state.signal?.aborted ?? null });
      },
    }),
    update: (table: { __name: string }) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.writes.push({ table: table.__name, values, signalAborted: state.signal?.aborted ?? null });
        },
      }),
    }),
  };
  return { db, scheduledJobs, jobExecutionLog };
});

vi.mock('@workspace/core', () => ({
  runWithSendCaller: (_caller: string, fn: () => unknown) => fn(),
}));

const { JobExecutor } = await import('../../../background-jobs/src/job-executor.js');

describe('JobExecutor timeout', () => {
  beforeEach(() => {
    state.writes = [];
    state.signal = null;
    state.job = {
      id: 'job-1', jobType: 'slow', enabled: true, status: 'running',
      retryCount: 0, maxRetries: 3, cronExpression: null,
    };
  });

  it('aborts the handler signal before recording the timeout and releasing the claim for retry', async () => {
    let abortedWhileRunning = false;
    const executor = new JobExecutor({ defaultTimeoutMs: 25 });
    executor.registerHandler('slow', {
      async execute(_job: unknown, signal?: AbortSignal) {
        state.signal = signal ?? null;
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => { abortedWhileRunning = true; resolve(); }, { once: true });
          setTimeout(resolve, 1_000);
        });
        return 'late';
      },
    } as never);

    const result = await executor.execute('job-1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(abortedWhileRunning).toBe(true);

    const timeoutLog = state.writes.find((w) => w.table === 'job_execution_log' && w.values.status === 'timeout');
    const retry = state.writes.find((w) => w.table === 'scheduled_jobs' && w.values.status === 'active');
    expect(timeoutLog, 'timeout recorded').toBeDefined();
    expect(retry, 'claim released for retry').toBeDefined();
    expect(retry!.values.nextRunAt).toBeInstanceOf(Date);
    // The cooperative signal was already aborted when both writes happened.
    expect(timeoutLog!.signalAborted).toBe(true);
    expect(retry!.signalAborted).toBe(true);
  });
});

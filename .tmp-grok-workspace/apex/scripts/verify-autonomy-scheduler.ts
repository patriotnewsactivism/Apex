/** Verifies the scheduler actually dispatches the NEW job types end-to-end.
 *
 * Usage (DESTRUCTIVE — truncates scheduled_jobs/job_execution_log/tasks/goals/
 * agents; use a scratch database, NEVER production):
 *   DATABASE_URL=postgres://user@host:port/scratchdb \
 *     pnpm --filter @workspace/api-server exec tsx ../../scripts/verify-autonomy-scheduler.ts
 *
 * The real integration risk is a jobType with no registered handler: the
 * executor returns "No handler registered" and the cron silently never works. */
import { db, migrate, scheduledJobs, jobExecutionLog, tasks, goals, agents } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { JobScheduler, JobExecutor, CronParser } from '../packages/background-jobs/src/index.js';

let failures = 0;
const check = (l: string, c: boolean, d?: unknown) => {
  console.log(c ? `  ✅ ${l}` : `  ❌ ${l} ${d !== undefined ? JSON.stringify(d) : ''}`);
  if (!c) failures++;
};

async function main() {
  await migrate();
  await db.delete(jobExecutionLog); await db.delete(scheduledJobs);
  await db.delete(tasks); await db.delete(goals); await db.delete(agents);
  const now = new Date();
  await db.insert(agents).values({ id: 'apex-ceo-001', name: 'CEO', role: 'CEO', tier: 0, status: 'idle', systemPrompt: 'x', model: 'm', provider: 'p', createdAt: now });

  console.log('── Cron expressions used by the new seeded roster ──');
  for (const expr of ['*/5 * * * *', '*/30 * * * *', '15 */2 * * *', '0 * * * *', '30 */2 * * *']) {
    const next = CronParser.nextRun(expr, now);
    check(`"${expr}" parses to a future run (${next?.toISOString()})`, !!next && next.getTime() > now.getTime());
  }

  console.log('\n── Scheduler dispatches every new job type ──');
  const types = ['delegation_followup', 'goal_progress', 'failure_review', 'branch_review'];
  for (const t of types) {
    await db.insert(scheduledJobs).values({
      id: `test-${t}`, name: `test ${t}`, jobType: t, cronExpression: '*/5 * * * *',
      enabled: true, targetAgentId: 'apex-ceo-001', payload: t === 'branch_review' ? { subordinates: [], focus: 'f' } : {},
      priority: 5, status: 'active', retryCount: 0, maxRetries: 3,
      nextRunAt: new Date(now.getTime() - 60_000), createdAt: now, updatedAt: now,
    });
  }

  const scheduler = new JobScheduler({ pollIntervalMs: 1000 });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 6000));
  scheduler.stop();

  for (const t of types) {
    const logs = await db.select().from(jobExecutionLog).where(eq(jobExecutionLog.jobId, `test-${t}`));
    const ok = logs.some((l) => l.status === 'completed');
    check(`${t} dispatched and completed (no "No handler registered")`, ok, logs.map((l) => ({ s: l.status, e: l.error })));
  }

  // A bogus type must still be rejected — proves the check above is meaningful.
  const rejected = await new JobExecutor().execute('nope');
  check('unknown job id is rejected (control)', !rejected.success);

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

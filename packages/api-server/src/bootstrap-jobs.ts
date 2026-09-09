// ─── Runtime-critical bootstrap jobs ──────────────────────────────────────────
//
// Extracted from index.ts (Phase 5 of the autonomous-OS upgrade) so
// runtime-bootstrap.ts can share them with worker.ts. Before this, the
// dedicated `start:worker` runtime (ADR-011) called none of this: it built
// the workforce and started the scheduler directly, so a standalone worker
// process never seeded the default recurring jobs, never recovered
// lease-expired tasks from a prior crash, and started with whatever
// `process.env` it happened to boot with rather than the settings the
// dashboard's Settings panel persisted to Postgres. Two entrypoints running
// the "same" governed workforce were not actually running the same runtime.

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db, tasks } from '@workspace/db';

// Seed the default recurring system jobs — the baseline work schedule that
// scheduling/HR owns. On conflict (job already exists), revive ONLY jobs
// currently stuck in 'failed' status: a transient outage (LLM exhaustion, DB
// blip) must never permanently silence autonomous work. Jobs an operator
// disabled via /api/jobs/:id/toggle stay disabled (enabled=false is untouched;
// only status='failed' rows are reset to 'active'). Versioned system
// definitions are also synchronized on startup so a prompt/cron safety fix
// actually reaches existing production rows instead of applying only to a
// fresh database. The CEO can create separate crons via schedule_task.
export async function seedDefaultJobs(): Promise<void> {
  try {
    const { db, scheduledJobs } = await import('@workspace/db');
    const { CronParser } = await import('@workspace/background-jobs');
    const { eq } = await import('drizzle-orm');

    const now = new Date();
    const defaults = [
      {
        id: 'system-ceo-goal-review',
        name: 'CEO autonomous goal review',
        jobType: 'goal_review',
        cronExpression: '*/15 * * * *', // every 15 min — the autonomous spark
        targetAgentId: 'apex-ceo-001' as string | null,
        priority: 4,
        payload: {} as Record<string, unknown>,
      },
      {
        id: 'system-lead-gen-sweep',
        name: 'Lead generation research sweep',
        jobType: 'task_delegation',
        cronExpression: '0 */2 * * *', // every 2 h
        targetAgentId: 'apex-lead-research-001' as string | null,
        priority: 3,
        payload: {
          title: 'Lead generation sweep',
          description:
            'AUTONOMOUS LEAD-GEN SWEEP — run a research session now. Call listResearchedLeads first to see what is already in the pipeline and avoid duplicates. Then pick an industry/region you have NOT recently covered. Use searchBusinessDirectory and webSearch to find real qualifying businesses. For every lead, inspect public contact/about/team sources and attempt to find the decision maker, business email, and phone; never guess. Save the source and honest contact research status with saveResearchedLeadsBatch. Every saved lead must retain at least its verified company website as a contact path. Quality over quantity.',
        },
      },
      {
        id: 'system-lead-contact-enrichment',
        name: 'Lead contact enrichment backlog',
        jobType: 'task_delegation',
        cronExpression: '*/15 * * * *', // bounded catch-up cadence; serialized agent prevents overlap
        targetAgentId: 'apex-lead-research-001' as string | null,
        priority: 3,
        payload: {
          systemDefinitionVersion: 1,
          maxPerRun: 12,
          title: 'Enrich pending lead contacts',
          description: 'Call listResearchedLeads with needsContactResearch=true and limit=12. Process at most 12 pending leads this run. Prefer the verified first-party business website, then one targeted public web-search pass for missing decision-maker/email/phone fields. Reject directory-domain, franchise-branch, city, and company-name mismatches. Never guess or synthesize contact data or email patterns. Do not repeat the same failed search/provider call in this task: on provider, quota, pacing, or capacity errors, stop cleanly rather than looping and leave remaining leads pending for the next scheduled run. Call updateLeadContactInfo for every genuinely attempted lead, include the supporting public source URL when found, and honestly mark partial, complete, or unavailable.',
        },
      },
      {
        id: 'system-daily-report',
        name: 'Daily activity report',
        jobType: 'report_generation',
        cronExpression: '0 9 * * *', // daily at 09:00
        targetAgentId: null as string | null,
        priority: 7,
        payload: {} as Record<string, unknown>,
      },
      {
        id: 'system-daily-maintenance',
        name: 'Daily cleanup (logs, expired memories)',
        jobType: 'maintenance',
        cronExpression: '0 3 * * *', // daily at 03:00
        targetAgentId: null as string | null,
        priority: 8,
        payload: {} as Record<string, unknown>,
      },
      {
        id: 'system-learning-analysis',
        name: 'Autonomous learning analysis',
        jobType: 'learning_analysis',
        cronExpression: '0 */6 * * *', // every 6 h
        targetAgentId: null as string | null,
        priority: 6,
        payload: {} as Record<string, unknown>,
      },
      {
        id: 'system-opportunity-discovery',
        name: 'Novel opportunity discovery across projects',
        jobType: 'opportunity_discovery',
        cronExpression: '47 */2 * * *',
        targetAgentId: null as string | null,
        priority: 4,
        payload: {
          systemDefinitionVersion: 1,
          maxProjectsPerRun: 6,
          maxCandidatesPerProject: 4,
        } as Record<string, unknown>,
      },
      {
        id: 'system-workforce-planner',
        name: 'Bounded autonomous workforce coverage planner',
        jobType: 'workforce_planner',
        cronExpression: '7 * * * *',
        targetAgentId: null as string | null,
        priority: 4,
        payload: { systemDefinitionVersion: 1 } as Record<string, unknown>,
      },
      {
        id: 'system-prompt-evolution',
        name: 'Continuous agent prompt evolution',
        jobType: 'prompt_self_improve',
        cronExpression: '27 */6 * * *',
        targetAgentId: null as string | null,
        priority: 5,
        payload: {
          systemDefinitionVersion: 1,
          role: 'auto',
          maxIterations: 4,
        } as Record<string, unknown>,
      },
      // ── Closed-loop autonomy roster ──────────────────────────────────────
      // Delegation used to be one-way: a manager handed work down and its own
      // task finished immediately, so nothing ever read the outcome back. This
      // is the return leg — it routes finished sub-work to whoever delegated it.
      {
        id: 'system-delegation-followup',
        name: 'Delegation results follow-up',
        jobType: 'delegation_followup',
        cronExpression: '*/5 * * * *', // every 5 min — keeps the feedback tight
        targetAgentId: null as string | null,
        priority: 3,
        payload: { maxPerRun: 8 } as Record<string, unknown>,
      },
      // Goals only ever left 'active' when a human clicked. This drives each
      // one to a real conclusion: decompose it, close it, or change approach.
      {
        id: 'system-goal-progress',
        name: 'Goal progress & close-out review',
        jobType: 'goal_progress',
        cronExpression: '*/30 * * * *', // every 30 min
        targetAgentId: 'apex-ceo-001' as string | null,
        priority: 4,
        payload: { maxPerRun: 4, minAgeMinutes: 20 } as Record<string, unknown>,
      },
      // Failed tasks used to be terminal and unseen. Cluster them and put the
      // recurring ones in front of the CEO.
      {
        id: 'system-failure-review',
        name: 'Failure triage review',
        jobType: 'failure_review',
        cronExpression: '15 */2 * * *', // every 2 h, offset off the hour
        targetAgentId: 'apex-ceo-001' as string | null,
        priority: 5,
        payload: { windowHours: 24, minClusterSize: 2 } as Record<string, unknown>,
      },
      // The COO and CTO had no heartbeat of their own — whole branches sat idle
      // between CEO reviews. These give each branch manager its own cadence.
      // Provider outages are transient; the work they killed should not be.
      // Runs often enough that a recovered chain resumes business work within
      // minutes rather than waiting for the next sparse business cron.
      {
        id: 'system-stalled-work-recovery',
        name: 'Recover work killed by LLM provider outages',
        jobType: 'stalled_work_recovery',
        cronExpression: '*/10 * * * *', // every 10 min
        targetAgentId: null as string | null,
        priority: 2,
        payload: { windowHours: 24, maxPerRun: 15, maxRequeues: 3 } as Record<string, unknown>,
      },
      {
        id: 'system-coo-branch-review',
        name: 'COO operations branch review',
        jobType: 'branch_review',
        cronExpression: '5 * * * *', // hourly, after :00 provider-work recovery
        targetAgentId: 'apex-coo-001' as string | null,
        priority: 4,
        payload: {
          systemDefinitionVersion: 2,
          subordinates: ['apex-lead-research-001', 'apex-sales-001', 'apex-marketing-001', 'apex-success-001'],
          includeBuildMyBot2: true,
          focus:
            'You run BuildMyBot.App day-to-day operations. Priorities in order: (1) BuildMyBot2 health — if snapshot.buildmybot2 shows current open critical errors, flagged/escalated shifts, or leads stalling without a reply, act: read buildmybot_status, then send a corrective briefing with buildmybot_send_briefing or file one real ticket with buildmybot_dispatch_engineering. Historical provider failures listed as recovered are not current incidents. (2) Pipeline — leads researched but never worked are wasted spend; make sure the Lead Researcher is covering new industries/regions rather than re-covering the same ones, and that Sales is actually reviewing what was found. (3) Content and support cadence. Be honest about what is genuinely not wired yet (real outbound email/SMS and payments are not) — never report outreach that did not happen.',
        } as Record<string, unknown>,
      },
      {
        id: 'system-cto-branch-review',
        name: 'CTO engineering branch review',
        jobType: 'branch_review',
        cronExpression: '35 */2 * * *', // every 2 h, after :30 provider-work recovery
        targetAgentId: 'apex-cto-001' as string | null,
        priority: 4,
        payload: {
          systemDefinitionVersion: 2,
          subordinates: [
            'apex-lead-dev-001',
            'apex-frontend-001',
            'apex-backend-001',
            'apex-devops-001',
            'apex-qa-001',
          ],
          focus:
            'You run engineering for Apex itself and for buildmybot2. Priorities in order: (1) Stability over features — call health_check first and act only on current degradation. A successful task newer than an old provider-chain failure means that outage recovered; do not request credits or keys from historical errors alone. (2) Repeated current failures are engineering defects until proven otherwise — diagnose the root cause rather than re-running the same work. (3) Delegate exactly once through apex-lead-dev-001; never also assign its Frontend, Backend, DevOps, or QA reports directly. Idle agents need no invented work. (4) BuildMyBot2 work must keep its repository context; do not inspect the Apex filesystem as if it were BuildMyBot2. (5) Ship through PRs, never direct pushes; deploys stay approval-gated. Escalate a missing capability only after a current tool or health check proves it is missing.',
        } as Record<string, unknown>,
      },
      // ── Autonomous execution scheduler roster (2026-09-06) ───────────────
      // work_generation is the self-growing task machine: it turns open goals,
      // accepted opportunities, and due workstreams into concrete tasks every
      // 10 minutes (deduped — see WorkGenerationJob). cron_governor is the
      // hourly ceiling/floor enforcement so that machine cannot explode.
      {
        id: 'system-work-generation',
        name: 'Autonomous work generation (goals, opportunities, workstreams)',
        jobType: 'work_generation',
        cronExpression: '*/10 * * * *', // every 10 min — the autonomous spark
        targetAgentId: 'apex-coo-001' as string | null,
        priority: 3,
        payload: { systemDefinitionVersion: 1, maxPerRun: 6 } as Record<string, unknown>,
      },
      {
        id: 'system-cron-governor',
        name: 'Cron governance (ceilings, frequency floor, failed-storm pruning)',
        jobType: 'cron_governor',
        cronExpression: '23 * * * *', // hourly, offset off the half-hour
        targetAgentId: null as string | null,
        priority: 4,
        payload: { systemDefinitionVersion: 1 } as Record<string, unknown>,
      },
    ];

    for (const def of defaults) {
      const nextRunAt = CronParser.nextRun(def.cronExpression, now) ?? new Date(now.getTime() + 60_000);
      await db
        .insert(scheduledJobs)
        .values({
          id: def.id,
          name: def.name,
          jobType: def.jobType,
          cronExpression: def.cronExpression,
          enabled: true,
          targetAgentId: def.targetAgentId,
          payload: def.payload,
          priority: def.priority,
          status: 'active',
          retryCount: 0,
          maxRetries: 3,
          nextRunAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: scheduledJobs.id,
          set: {
            enabled: true,
            status: 'active',
            retryCount: 0,
            error: null,
            nextRunAt,
            updatedAt: now,
          },
          where: eq(scheduledJobs.status, 'failed'),
        });

      // Existing active rows were historically never updated, which left old
      // prompts and colliding cron expressions live forever after code fixes.
      // Only explicitly versioned code-owned definitions are synchronized;
      // unversioned/user-created schedules remain operator-controlled.
      const desiredDefinitionVersion = Number(def.payload.systemDefinitionVersion ?? 0);
      if (desiredDefinitionVersion > 0) {
        // Keep the version comparison in the UPDATE predicate. An older
        // deployment can never overwrite a newer definition after a stale read.
        await db
          .update(scheduledJobs)
          .set({
            name: def.name,
            jobType: def.jobType,
            cronExpression: def.cronExpression,
            targetAgentId: def.targetAgentId,
            payload: def.payload,
            priority: def.priority,
            nextRunAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(scheduledJobs.id, def.id),
              sql`coalesce((${scheduledJobs.payload} ->> 'systemDefinitionVersion')::int, 0) < ${desiredDefinitionVersion}`,
            ),
          );
      }
    }
    console.log(
      '✅ Seeded default system jobs (goals, learning, opportunity discovery, workforce planning, prompt evolution, recovery, branch reviews, reporting)',
    );
  } catch (err) {
    console.warn('⚠️  Default job seeding skipped:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Lease-expiry crash recovery: only recover tasks whose lease has expired
 * (>10 min) or whose leased_at is NULL (tasks left in_progress before
 * leased_at was added). Increments retryCount and applies backoff, or marks
 * failed if maxRetries exceeded. The old naive reset
 * (`SET status='pending' WHERE status='in_progress'`) blindly requeued tasks
 * without incrementing retryCount, allowing crash-looping tasks to ignore
 * maxRetries and spin forever.
 */
export async function recoverStaleLeasedTasks(): Promise<void> {
  try {
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const staleTasks = await db
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.status, 'in_progress'),
        // Sandbox-executor tasks (context.runtime='job') run inside Cloud Run
        // Jobs with their own 55-minute wall clock and lease semantics; the
        // in-process 10-minute recovery sweep must never steal them mid-run.
        sql`${tasks.context}->>'runtime' IS DISTINCT FROM 'job'`,
        or(
          isNull(tasks.leasedAt),
          lt(tasks.leasedAt, staleThreshold),
        ),
      ));

    let recovered = 0;
    let exhausted = 0;
    for (const task of staleTasks) {
      const newRetryCount = task.retryCount + 1;
      if (task.retryCount >= task.maxRetries) {
        await db
          .update(tasks)
          .set({
            status: 'failed',
            errorMessage: 'Process crash: lease expired (max retries exceeded)',
            updatedAt: new Date(),
          })
          .where(and(
            eq(tasks.id, task.id),
            eq(tasks.status, 'in_progress'),
            or(isNull(tasks.leasedAt), lt(tasks.leasedAt, staleThreshold))
          ));
        exhausted++;
      } else {
        const retryDelayMs = Math.min(Math.pow(2, newRetryCount) * 1000, 300_000);
        const nextRetryAt = new Date(Date.now() + retryDelayMs);
        await db
          .update(tasks)
          .set({
            status: 'pending',
            retryCount: newRetryCount,
            leasedAt: null,
            nextRetryAt,
            errorMessage: 'Process crash: lease expired',
            updatedAt: new Date(),
          })
          .where(and(
            eq(tasks.id, task.id),
            eq(tasks.status, 'in_progress'),
            or(isNull(tasks.leasedAt), lt(tasks.leasedAt, staleThreshold))
          ));
        recovered++;
      }
    }
    console.log(`✅ Lease-expiry recovery: ${recovered} task(s) requeued, ${exhausted} task(s) failed (max retries)`);
  } catch (err) {
    console.warn('⚠️  Crash recovery skipped:', err instanceof Error ? err.message : String(err));
  }
}

import { db, agents, tasks, type Task } from '@workspace/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { TaskQueue } from './task-queue.js';
import { BaseAgent } from './base-agent.js';
import type { TaskInput } from './types.js';

const PEER_REVIEW_TITLE = 'Peer Review Request';
const MAX_PARENT_RESULT_CHARS = 6_000;
const MAX_ARTIFACTS = 25;
const OPEN_REVIEW_STATUSES = ['pending', 'in_progress', 'blocked', 'awaiting_approval'] as const;

// One APEX HTTP runtime currently owns the autonomous workforce. This in-process
// lock closes the small check-then-insert race for ad-hoc reviews whose goalId is
// null (the general tasks_delegation_unique index intentionally does not cover
// null-goal work). The deterministic title below also gives goal-scoped reviews
// a stable DB uniqueness key.
const peerReviewCreationLocks = new Map<string, Promise<string>>();

function isPeerReviewTitle(title: string): boolean {
  return title === PEER_REVIEW_TITLE || title.startsWith(`${PEER_REVIEW_TITLE}: `);
}

// Parent-task context can contain arbitrary operational state. Carry only the
// fields that can actually help a reviewer locate the work instead of blindly
// copying an unbounded context object into another model prompt.
const REVIEW_HINT_KEYS = [
  'projectId',
  'project',
  'repo',
  'repository',
  'repositoryFullName',
  'branch',
  'commit',
  'commitSha',
  'prNumber',
  'pullRequest',
  'path',
  'paths',
  'file',
  'files',
  'changedFiles',
  'artifact',
  'artifacts',
  'workspace',
  'workspaceRoot',
  'url',
] as const;

type ReviewSource = {
  parentTaskId: string;
  title: string;
  description: string;
  result?: string;
  resultArtifacts: string[];
  contextHints: Record<string, unknown>;
};

function asContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function hasReviewSource(context: Record<string, unknown>, parentTaskId: string): boolean {
  const source = context.reviewSource;
  return Boolean(
    source &&
      typeof source === 'object' &&
      !Array.isArray(source) &&
      (source as Record<string, unknown>).parentTaskId === parentTaskId,
  );
}

function selectContextHints(value: unknown): Record<string, unknown> {
  const source = asContext(value);
  const hints: Record<string, unknown> = {};
  for (const key of REVIEW_HINT_KEYS) {
    if (source[key] !== undefined) hints[key] = source[key];
  }
  return hints;
}

async function loadReviewSource(parentTaskId: string): Promise<ReviewSource | null> {
  const [parent] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      result: tasks.result,
      resultArtifacts: tasks.resultArtifacts,
      context: tasks.context,
    })
    .from(tasks)
    .where(eq(tasks.id, parentTaskId))
    .limit(1);

  if (!parent) return null;

  return {
    parentTaskId: parent.id,
    title: parent.title,
    description: parent.description,
    ...(parent.result
      ? { result: parent.result.slice(0, MAX_PARENT_RESULT_CHARS) }
      : {}),
    resultArtifacts: (parent.resultArtifacts ?? []).slice(0, MAX_ARTIFACTS),
    contextHints: selectContextHints(parent.context),
  };
}

async function enrichedContext(
  parentTaskId: string,
  existing: unknown,
): Promise<Record<string, unknown>> {
  const base = asContext(existing);
  if (hasReviewSource(base, parentTaskId)) return base;

  const source = await loadReviewSource(parentTaskId);
  if (!source) return base;

  return {
    ...base,
    reviewSource: source,
    reviewContextAutoEnriched: true,
  };
}

/**
 * Collapse already-existing duplicate review work when it reaches the front of
 * the queue. This cleans the historical backlog without a one-off destructive
 * database migration: for each (parent task, reviewer agent) pair, the oldest
 * still-open review wins and the rest are explicitly cancelled as superseded.
 *
 * It also drains historical review-of-review rows. New review chaining is
 * blocked at creation time below, but rows created before that guard already
 * exist in production. Letting those execute would keep the old storm alive
 * until the backlog naturally exhausted, so they are cancelled on claim.
 */
async function collapseClaimedPeerReview(task: Task | null): Promise<Task | null> {
  if (
    !task ||
    !isPeerReviewTitle(task.title) ||
    !task.parentTaskId ||
    !task.assignedAgentId
  ) {
    return task;
  }

  const [parent] = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(eq(tasks.id, task.parentTaskId))
    .limit(1);

  if (parent && isPeerReviewTitle(parent.title)) {
    await db
      .update(tasks)
      .set({
        status: 'cancelled',
        errorMessage: `Cancelled historical recursive peer review; parent ${parent.id} is itself a peer review`,
        nextRetryAt: null,
        leasedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    return null;
  }

  const peers = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.parentTaskId, task.parentTaskId),
        eq(tasks.assignedAgentId, task.assignedAgentId),
        inArray(tasks.status, [...OPEN_REVIEW_STATUSES]),
      ),
    )
    .orderBy(asc(tasks.createdAt));

  const reviewPeers = peers.filter((peer) => isPeerReviewTitle(peer.title));
  if (reviewPeers.length <= 1) return task;

  const winner = reviewPeers[0];
  const duplicateIds = reviewPeers.slice(1).map((peer) => peer.id);
  const now = new Date();

  if (duplicateIds.length > 0) {
    await db
      .update(tasks)
      .set({
        status: 'cancelled',
        errorMessage: `Superseded duplicate peer review; canonical task is ${winner.id}`,
        nextRetryAt: null,
        leasedAt: null,
        updatedAt: now,
      })
      .where(inArray(tasks.id, duplicateIds));
  }

  // If the task we just claimed was itself one of the duplicates, do not let it
  // enter the agent loop. The canonical older review remains available.
  if (winner.id !== task.id) return null;
  return task;
}

async function enrichClaimedPeerReview(task: Task | null): Promise<Task | null> {
  const canonical = await collapseClaimedPeerReview(task);
  if (!canonical || !isPeerReviewTitle(canonical.title) || !canonical.parentTaskId) return canonical;

  const current = asContext(canonical.context);
  if (hasReviewSource(current, canonical.parentTaskId)) return canonical;

  const context = await enrichedContext(canonical.parentTaskId, current);
  if (!hasReviewSource(context, canonical.parentTaskId)) return canonical;

  // Persist the repair as well as returning it to this execution. This matters
  // for an already-existing backlog item: a retry/restart must not lose the
  // artifact context we just recovered.
  await db
    .update(tasks)
    .set({ context, updatedAt: new Date() })
    .where(eq(tasks.id, canonical.id));

  return { ...canonical, context };
}

let installed = false;

/**
 * Installs narrow guards around peer-review creation and consumption.
 *
 * Production exposed three independent defects in the old path:
 *  1. requestPeerReview could omit contextData, leaving the reviewer with no
 *     actual artifact/result to inspect.
 *  2. every review used the literal title "Peer Review Request". The general
 *     (goalId,title,agent) uniqueness key then collided across DIFFERENT parent
 *     tasks in the same goal, and BaseAgent emitted a task:created event even
 *     when ON CONFLICT DO NOTHING inserted nothing. The dashboard therefore
 *     showed phantom "Created task" rows with IDs that did not exist.
 *  3. a review task could request another peer review, creating review-of-review
 *     chains and eventually a storm across QA/Lead Research roles.
 *
 * This guard fixes the behavior without weakening the global task uniqueness
 * rule: deterministic parent-specific review titles, parent-source enrichment,
 * duplicate reuse, recursive-review rejection, and backlog collapse on claim.
 */
export function installPeerReviewContextGuard(): void {
  if (installed) return;
  installed = true;

  // Some orchestration paths enqueue review work through TaskQueue directly.
  const originalEnqueue = TaskQueue.prototype.enqueue;
  TaskQueue.prototype.enqueue = async function (
    input: TaskInput & { createdByAgentId?: string },
  ): Promise<Task> {
    if (!isPeerReviewTitle(input.title) || !input.parentTaskId) {
      return originalEnqueue.call(this, input);
    }

    const context = await enrichedContext(input.parentTaskId, input.context);
    return originalEnqueue.call(this, { ...input, context });
  };

  // requestPeerReview normally comes through BaseAgent.delegateToRole(), which
  // inserts directly and therefore bypasses TaskQueue.enqueue(). Guard that
  // creation boundary as well.
  const originalDelegateToRole = BaseAgent.prototype.delegateToRole;
  BaseAgent.prototype.delegateToRole = async function (
    targetRole: string,
    input: TaskInput,
  ): Promise<string> {
    if (!isPeerReviewTitle(input.title) || !input.parentTaskId) {
      return originalDelegateToRole.call(this, targetRole, input);
    }

    const [parent] = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.id, input.parentTaskId))
      .limit(1);

    if (parent && isPeerReviewTitle(parent.title)) {
      throw new Error(
        `Peer-review chaining is blocked: task ${parent.id} is already a peer review. ` +
        'Complete the current review directly instead of creating another Peer Review Request.',
      );
    }

    const [target] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.role, targetRole))
      .limit(1);

    // If role resolution fails, preserve BaseAgent's authoritative error path.
    if (!target) return originalDelegateToRole.call(this, targetRole, input);

    const lockKey = `${input.parentTaskId}:${target.id}`;
    const inFlight = peerReviewCreationLocks.get(lockKey);
    if (inFlight) return inFlight;

    const creation = (async () => {
      const existingRows = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          createdAt: tasks.createdAt,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.parentTaskId, input.parentTaskId!),
            eq(tasks.assignedAgentId, target.id),
            inArray(tasks.status, [...OPEN_REVIEW_STATUSES]),
          ),
        )
        .orderBy(asc(tasks.createdAt));

      const existing = existingRows.find((row) => isPeerReviewTitle(row.title));
      if (existing) {
        // Crucially, do NOT call BaseAgent here. The old implementation emitted
        // task:created even when its DB insert lost a uniqueness conflict, which
        // is the phantom "Created task" burst visible in the dashboard.
        return existing.id;
      }

      const context = await enrichedContext(input.parentTaskId!, input.context);
      const parentLabel = parent?.title?.slice(0, 100) || 'parent task';
      const deterministicTitle = `${PEER_REVIEW_TITLE}: ${parentLabel} [${input.parentTaskId}]`;

      return originalDelegateToRole.call(this, targetRole, {
        ...input,
        title: deterministicTitle,
        context,
      });
    })();

    peerReviewCreationLocks.set(lockKey, creation);
    try {
      return await creation;
    } finally {
      if (peerReviewCreationLocks.get(lockKey) === creation) {
        peerReviewCreationLocks.delete(lockKey);
      }
    }
  };

  const originalDequeue = TaskQueue.prototype.dequeue;
  TaskQueue.prototype.dequeue = async function (): Promise<Task | null> {
    return enrichClaimedPeerReview(await originalDequeue.call(this));
  };

  const originalClaimById = TaskQueue.prototype.claimById;
  TaskQueue.prototype.claimById = async function (taskId: string): Promise<Task | null> {
    return enrichClaimedPeerReview(await originalClaimById.call(this, taskId));
  };
}

// @workspace/core is the public entry point used by the agent package. Install
// at module evaluation so every subsequently-created TaskQueue/BaseAgent path
// gets the guards without changing each concrete agent class.
installPeerReviewContextGuard();

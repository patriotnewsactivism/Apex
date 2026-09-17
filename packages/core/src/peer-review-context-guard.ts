import { db, tasks, type Task } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { TaskQueue } from './task-queue.js';
import type { TaskInput } from './types.js';

const PEER_REVIEW_TITLE = 'Peer Review Request';
const MAX_PARENT_RESULT_CHARS = 6_000;
const MAX_ARTIFACTS = 25;

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

async function enrichClaimedPeerReview(task: Task | null): Promise<Task | null> {
  if (!task || task.title !== PEER_REVIEW_TITLE || !task.parentTaskId) return task;

  const current = asContext(task.context);
  if (hasReviewSource(current, task.parentTaskId)) return task;

  const context = await enrichedContext(task.parentTaskId, current);
  if (!hasReviewSource(context, task.parentTaskId)) return task;

  // Persist the repair as well as returning it to this execution. This matters
  // for an already-existing backlog item: a retry/restart must not lose the
  // artifact context we just recovered.
  await db
    .update(tasks)
    .set({ context, updatedAt: new Date() })
    .where(eq(tasks.id, task.id));

  return { ...task, context };
}

let installed = false;

/**
 * Installs a narrow TaskQueue guard for peer-review work.
 *
 * requestPeerReview historically allowed contextData to be omitted. That left
 * reviewers with a vague reviewObjective and, after delegation follow-up ran,
 * sometimes literally only { reportedToParent: true } as task context. The
 * live symptom was a QA Director correctly reporting "no code artifact
 * supplied" and spawning yet another blocked review task.
 *
 * The guard fixes both directions:
 *  - NEW Peer Review Request tasks inherit bounded source material before save.
 *  - OLD queued Peer Review Request tasks are repaired when claimed.
 *
 * It intentionally lives at the queue boundary rather than in one tool because
 * peer-review tasks can be created through more than one orchestration path.
 */
export function installPeerReviewContextGuard(): void {
  if (installed) return;
  installed = true;

  const originalEnqueue = TaskQueue.prototype.enqueue;
  TaskQueue.prototype.enqueue = async function (
    input: TaskInput & { createdByAgentId?: string },
  ): Promise<Task> {
    if (input.title !== PEER_REVIEW_TITLE || !input.parentTaskId) {
      return originalEnqueue.call(this, input);
    }

    const context = await enrichedContext(input.parentTaskId, input.context);
    return originalEnqueue.call(this, { ...input, context });
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
// at module evaluation so every subsequently-created TaskQueue instance gets
// the guard without changing BaseAgent's internal queue construction.
installPeerReviewContextGuard();

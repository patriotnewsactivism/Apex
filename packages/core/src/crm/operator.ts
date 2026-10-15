/**
 * CRM phase 1 write paths: the things the operator does by hand.
 *
 * Nothing here is reachable from an agent. `packages/core/src/crm/tools.ts`
 * exposes read-only lookups only, and verify-crm asserts that these write
 * functions never appear in it. Every caller arrives through the
 * operator-authenticated routes in packages/api-server/src/routes/crm.ts.
 *
 * Two rules hold across this file:
 *  - The timeline stays insert-only. Every write that changes what the contact
 *    book says about a person also appends a timeline row, so the change is
 *    visible in the same history as the sends and replies.
 *  - A privileged change is refused for anyone but the operator. Status,
 *    do-not-contact and opt-out lifts are checked here, not only at the route.
 */
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import {
  auditEvents,
  callBridgeSessions,
  campaignEnrollments,
  contactIdentifiers,
  contactTimeline,
  contacts,
  crmLeadImports,
  crmLeadImportRows,
  crmTasks,
  db,
  emailSends,
  emailSuppressions,
  interactions,
  researchedLeads,
  suppressions,
} from '@workspace/db';
import {
  CONTACT_LIFECYCLE_STAGES,
  CRM_ORGANIZATION_ID,
  OPERATOR_ACTOR,
  chicagoDayBounds,
  extractEmailAddress,
  isContactLifecycleStage,
  lifecycleStageChangeAllowed,
  normalizePhone,
  type ContactLifecycleStage,
} from './pure.js';
import { asExecutor, findContactIdsByDestination, insertTimelineEvent, type CrmDb } from './store.js';

const MAX_TAGS = 24;
const MAX_TAG_LENGTH = 48;
const MAX_IMPORT_BATCH = 500;

export class CrmWriteError extends Error {}
export class ContactExistsError extends CrmWriteError {
  constructor(public readonly contactId: string, message: string) {
    super(message);
  }
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanLimited(value: unknown, max: number): string | null {
  const trimmed = clean(value);
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalizeTagArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    const tag = cleanLimited(raw, MAX_TAG_LENGTH)?.toLowerCase().replace(/\s+/g, ' ');
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, MAX_TAGS);
}

function domainOf(website: string | null | undefined): string | null {
  const raw = clean(website);
  if (!raw) return null;
  try {
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/\s?#]/)[0] || null;
  }
}

function companyKey(name: string | null | undefined): string | null {
  const raw = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return raw.length > 0 ? raw : null;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function audit(
  executor: CrmDb,
  input: { actor: string; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await executor.insert(auditEvents).values({
    organizationId: CRM_ORGANIZATION_ID,
    actorType: input.actor === OPERATOR_ACTOR ? 'user' : 'system',
    actorId: input.actor,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata ?? {},
  });
}

async function addIdentifier(executor: CrmDb, contactId: string, kind: 'email' | 'phone', value: string): Promise<void> {
  const [existing] = await executor
    .select({ id: contactIdentifiers.id })
    .from(contactIdentifiers)
    .where(and(
      eq(contactIdentifiers.contactId, contactId),
      eq(contactIdentifiers.kind, kind),
      sql`lower(${contactIdentifiers.value}) = ${value.toLowerCase()}`,
    ))
    .limit(1);
  if (existing) return;
  await executor.insert(contactIdentifiers).values({
    contactId,
    kind,
    value,
    verified: false,
    sourceUrl: 'manual',
    foundAt: new Date(),
  });
}

// ─── Contacts: create and edit ───────────────────────────────────────────────

export interface CreateContactInput {
  actor: string;
  firstName?: unknown;
  lastName?: unknown;
  organizationName?: unknown;
  title?: unknown;
  email?: unknown;
  phone?: unknown;
  city?: unknown;
  state?: unknown;
  website?: unknown;
  notes?: unknown;
  ownerBot?: unknown;
  tags?: unknown;
  lifecycleStage?: unknown;
  companyId?: unknown;
  source?: unknown;
}

export async function createContact(input: CreateContactInput): Promise<{ contactId: string }> {
  const email = extractEmailAddress(clean(input.email));
  const phone = normalizePhone(clean(input.phone));
  const firstName = cleanLimited(input.firstName, 100);
  const lastName = cleanLimited(input.lastName, 100);
  const organizationName = cleanLimited(input.organizationName, 200);
  const website = cleanLimited(input.website, 500);
  if (!email && !phone && !organizationName && !firstName && !lastName && !website) {
    throw new CrmWriteError('A contact needs at least a name, an organization, an email, a phone, or a website.');
  }
  const stageInput = clean(input.lifecycleStage);
  if (stageInput && !isContactLifecycleStage(stageInput)) {
    throw new CrmWriteError(`Unknown client status "${stageInput}". Use one of ${CONTACT_LIFECYCLE_STAGES.join(', ')}.`);
  }
  // A duplicate is a dead end, so say which contact already holds the address
  // instead of creating a second record the operator then has to merge.
  for (const destination of [email, phone]) {
    if (!destination) continue;
    const existing = await findContactIdsByDestination(db, destination);
    if (existing[0]) {
      throw new ContactExistsError(existing[0], `That ${email === destination ? 'email' : 'phone'} is already on another contact.`);
    }
  }
  const lifecycleStage: ContactLifecycleStage = stageInput && isContactLifecycleStage(stageInput) ? stageInput : 'prospect';
  const at = new Date();
  const contactId = await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const [created] = await executor.insert(contacts).values({
      organizationId: CRM_ORGANIZATION_ID,
      companyId: clean(input.companyId),
      firstName,
      lastName,
      title: cleanLimited(input.title, 200),
      email,
      phoneE164: phone,
      organizationName,
      website,
      city: cleanLimited(input.city, 120),
      state: cleanLimited(input.state, 80),
      notes: clean(input.notes),
      ownerBot: cleanLimited(input.ownerBot, 120),
      tags: normalizeTagArray(input.tags),
      source: cleanLimited(input.source, 60) ?? 'manual',
      status: 'active',
      lifecycleStage,
      lifecycleStageChangedAt: at,
      lifecycleStageChangedBy: input.actor,
    }).returning({ id: contacts.id });
    if (!created) throw new CrmWriteError('Contact insert returned no id');
    if (email) await addIdentifier(executor, created.id, 'email', email);
    if (phone) await addIdentifier(executor, created.id, 'phone', phone);
    await audit(executor, {
      actor: input.actor,
      action: 'contact.created',
      entityType: 'contact',
      entityId: created.id,
      metadata: { lifecycleStage, source: clean(input.source) ?? 'manual' },
    });
    await insertTimelineEvent(executor, {
      contactId: created.id,
      channel: 'internal',
      direction: 'internal',
      actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
      actorName: input.actor,
      eventKind: 'contact_created',
      bodyText: `Contact created by hand. Client status: ${lifecycleStage}.`,
      provider: 'crm',
      providerMessageId: `contact-created:${created.id}`,
    });
    return created.id;
  });
  return { contactId };
}

export interface UpdateContactInput {
  contactId: string;
  actor: string;
  patch: Record<string, unknown>;
}

const EDITABLE_FIELDS = [
  'firstName',
  'lastName',
  'organizationName',
  'title',
  'email',
  'phone',
  'city',
  'state',
  'website',
  'notes',
  'ownerBot',
] as const;

export async function updateContact(input: UpdateContactInput): Promise<{ changed: string[] }> {
  const [existing] = await db.select().from(contacts).where(eq(contacts.id, input.contactId)).limit(1);
  if (!existing) throw new CrmWriteError('Contact not found');
  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const field of EDITABLE_FIELDS) {
    if (!(field in input.patch)) continue;
    const raw = input.patch[field];
    let next: string | null;
    if (field === 'email') {
      next = extractEmailAddress(clean(raw));
      if (clean(raw) && !next) throw new CrmWriteError('That email address is not a valid address.');
    } else if (field === 'phone') {
      next = normalizePhone(clean(raw));
      if (clean(raw) && !next) throw new CrmWriteError('That phone number is not a valid number.');
    } else if (field === 'notes') {
      next = clean(raw);
    } else {
      const limits: Record<string, number> = {
        firstName: 100, lastName: 100, organizationName: 200, title: 200, city: 120, state: 80, website: 500, ownerBot: 120,
      };
      next = cleanLimited(raw, limits[field] ?? 200);
    }
    const current = (existing as unknown as Record<string, unknown>)[field === 'phone' ? 'phoneE164' : field] ?? null;
    if ((current ?? null) === (next ?? null)) continue;
    patch[field] = next;
    changed.push(field === 'phone' ? 'phoneE164' : field);
  }
  if (changed.length === 0) throw new CrmWriteError('Nothing to change.');
  const email = typeof patch.email === 'string' ? patch.email : null;
  const phone = typeof patch.phoneE164 === 'string' ? patch.phoneE164 : null;
  for (const destination of [email, phone]) {
    if (!destination) continue;
    const found = await findContactIdsByDestination(db, destination);
    const clash = found.find((id) => id !== input.contactId);
    if (clash) throw new CrmWriteError(`That ${email === destination ? 'email' : 'phone'} is already on contact ${clash}.`);
  }
  const at = new Date();
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const set: Record<string, unknown> = { ...patch, updatedAt: at };
    await executor.update(contacts).set(set).where(eq(contacts.id, input.contactId));
    if (email) await addIdentifier(executor, input.contactId, 'email', email);
    if (phone) await addIdentifier(executor, input.contactId, 'phone', phone);
    await audit(executor, {
      actor: input.actor,
      action: 'contact.updated',
      entityType: 'contact',
      entityId: input.contactId,
      metadata: { fields: changed },
    });
    await insertTimelineEvent(executor, {
      contactId: input.contactId,
      channel: 'internal',
      direction: 'internal',
      actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
      actorName: input.actor,
      eventKind: 'contact_updated',
      bodyText: `Contact edited by hand: ${changed.join(', ')}.`,
      provider: 'crm',
      providerMessageId: `contact-updated:${input.contactId}:${at.toISOString()}`,
    });
  });
  return { changed };
}

export async function setContactTags(input: {
  contactId: string;
  actor: string;
  add?: unknown;
  remove?: unknown;
  replace?: unknown;
}): Promise<{ tags: string[] }> {
  const [existing] = await db.select({ id: contacts.id, tags: contacts.tags }).from(contacts).where(eq(contacts.id, input.contactId)).limit(1);
  if (!existing) throw new CrmWriteError('Contact not found');
  const current = existing.tags ?? [];
  let next: string[];
  if (input.replace !== undefined) {
    next = normalizeTagArray(input.replace);
  } else {
    const add = normalizeTagArray(input.add);
    const remove = new Set(normalizeTagArray(input.remove));
    next = [...new Set([...current.map((tag) => tag.toLowerCase()), ...add])].filter((tag) => !remove.has(tag)).slice(0, MAX_TAGS);
  }
  const at = new Date();
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(contacts).set({ tags: next, updatedAt: at }).where(eq(contacts.id, input.contactId));
    await audit(executor, {
      actor: input.actor,
      action: 'contact.tags_changed',
      entityType: 'contact',
      entityId: input.contactId,
      metadata: { before: current, after: next },
    });
    await insertTimelineEvent(executor, {
      contactId: input.contactId,
      channel: 'internal',
      direction: 'internal',
      actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
      actorName: input.actor,
      eventKind: 'contact_tags',
      bodyText: `Tags now: ${next.length > 0 ? next.join(', ') : '(none)'}.`,
      provider: 'crm',
      providerMessageId: `contact-tags:${input.contactId}:${at.toISOString()}`,
    });
  });
  return { tags: next };
}

// ─── Client status ───────────────────────────────────────────────────────────

/**
 * Move a contact along the relationship: prospect, lead, qualified, client,
 * churned. Refused for anyone but the operator, and every move is logged twice:
 * an audit row for the record and a timeline row for the contact's history.
 */
export async function setLifecycleStage(input: {
  contactId: string;
  stage: string;
  actor: string;
  reason?: string | null;
}): Promise<{ changed: boolean; from: string; to: ContactLifecycleStage }> {
  if (!lifecycleStageChangeAllowed(input.actor)) {
    throw new CrmWriteError('Only Matthew can change a client status.');
  }
  if (!isContactLifecycleStage(input.stage)) {
    throw new CrmWriteError(`Unknown client status "${input.stage}". Use one of ${CONTACT_LIFECYCLE_STAGES.join(', ')}.`);
  }
  const [existing] = await db
    .select({ id: contacts.id, stage: contacts.lifecycleStage })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  if (!existing) throw new CrmWriteError('Contact not found');
  const from = existing.stage ?? 'prospect';
  if (from === input.stage) return { changed: false, from, to: input.stage };
  const at = new Date();
  const reason = clean(input.reason);
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(contacts).set({
      lifecycleStage: input.stage,
      lifecycleStageChangedAt: at,
      lifecycleStageChangedBy: input.actor,
      updatedAt: at,
    }).where(eq(contacts.id, input.contactId));
    await audit(executor, {
      actor: input.actor,
      action: 'contact.lifecycle_stage_changed',
      entityType: 'contact',
      entityId: input.contactId,
      metadata: { from, to: input.stage, reason },
    });
    await insertTimelineEvent(executor, {
      contactId: input.contactId,
      channel: 'internal',
      direction: 'internal',
      actorType: 'operator',
      actorName: input.actor,
      eventKind: 'lifecycle_stage',
      bodyText: `Client status: ${from} → ${input.stage}${reason ? ` (${reason})` : ''}.`,
      provider: 'crm',
      providerMessageId: `lifecycle:${input.contactId}:${input.stage}:${at.toISOString()}`,
    });
  });
  return { changed: true, from, to: input.stage };
}

// ─── Calls you made yourself ─────────────────────────────────────────────────

/**
 * Log a call the operator placed or took outside APEX. No provider call happens
 * here; this only writes the history row, which is what the contact card reads.
 */
export async function logManualCall(input: {
  contactId: string;
  actor: string;
  direction?: unknown;
  outcome?: unknown;
  notes?: unknown;
  occurredAt?: unknown;
  durationSeconds?: unknown;
}): Promise<{ timelineId: string }> {
  const [existing] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, input.contactId)).limit(1);
  if (!existing) throw new CrmWriteError('Contact not found');
  const direction = input.direction === 'inbound' ? 'inbound' : 'outbound';
  const outcome = cleanLimited(input.outcome, 120);
  const notes = clean(input.notes);
  const occurredAt = parseDate(input.occurredAt) ?? new Date();
  const durationSeconds = Number.isFinite(Number(input.durationSeconds)) && Number(input.durationSeconds) > 0
    ? Math.min(Math.round(Number(input.durationSeconds)), 6 * 60 * 60)
    : null;
  return db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const row = await insertTimelineEvent(executor, {
      contactId: input.contactId,
      channel: 'call',
      direction,
      actorType: 'operator',
      actorName: input.actor,
      eventKind: 'call',
      occurredAt,
      subject: outcome ? `Call — ${outcome}` : 'Call',
      bodyText: notes ?? outcome ?? 'Logged by hand.',
      provider: 'manual',
      providerMessageId: `manual-call:${input.contactId}:${occurredAt.toISOString()}`,
      metadata: { manual: true, outcome, durationSeconds, loggedBy: input.actor },
    });
    await audit(executor, {
      actor: input.actor,
      action: 'contact.call_logged',
      entityType: 'contact',
      entityId: input.contactId,
      metadata: { direction, outcome, durationSeconds },
    });
    return { timelineId: row.id };
  });
}

// ─── Follow-up tasks ─────────────────────────────────────────────────────────

export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Keep contact.next_follow_up_at in step with the earliest open task. */
async function syncNextFollowUp(executor: CrmDb, contactId: string | null): Promise<void> {
  if (!contactId) return;
  const [next] = await executor
    .select({ dueAt: crmTasks.dueAt })
    .from(crmTasks)
    .where(and(
      eq(crmTasks.contactId, contactId),
      eq(crmTasks.status, 'open'),
      sql`${crmTasks.dueAt} IS NOT NULL`,
    ))
    .orderBy(asc(crmTasks.dueAt))
    .limit(1);
  await executor.update(contacts).set({
    nextFollowUpAt: next?.dueAt ?? null,
    updatedAt: new Date(),
  }).where(eq(contacts.id, contactId));
}

export async function createTask(input: {
  actor: string;
  title?: unknown;
  contactId?: unknown;
  companyId?: unknown;
  opportunityId?: unknown;
  kind?: unknown;
  notes?: unknown;
  dueAt?: unknown;
  dueInDays?: unknown;
  priority?: unknown;
  assignedTo?: unknown;
}): Promise<{ taskId: string }> {
  const title = cleanLimited(input.title, 200);
  if (!title) throw new CrmWriteError('A follow-up needs a title.');
  const contactId = clean(input.contactId);
  if (contactId) {
    const [contact] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
    if (!contact) throw new CrmWriteError('Contact not found');
  }
  const priorityInput = clean(input.priority) ?? 'normal';
  if (!(TASK_PRIORITIES as readonly string[]).includes(priorityInput)) {
    throw new CrmWriteError(`Unknown priority "${priorityInput}". Use one of ${TASK_PRIORITIES.join(', ')}.`);
  }
  let dueAt = parseDate(input.dueAt);
  if (!dueAt && input.dueInDays !== undefined && input.dueInDays !== null && input.dueInDays !== '') {
    const days = Number(input.dueInDays);
    if (!Number.isFinite(days)) throw new CrmWriteError('dueInDays must be a number.');
    dueAt = new Date(Date.now() + Math.round(days) * 24 * 60 * 60 * 1000);
  }
  const at = new Date();
  const taskId = await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const [created] = await executor.insert(crmTasks).values({
      organizationId: CRM_ORGANIZATION_ID,
      contactId,
      companyId: clean(input.companyId),
      opportunityId: clean(input.opportunityId),
      kind: cleanLimited(input.kind, 40) ?? 'follow_up',
      title,
      notes: clean(input.notes),
      dueAt,
      priority: priorityInput,
      status: 'open',
      assignedTo: cleanLimited(input.assignedTo, 120) ?? input.actor,
      createdBy: input.actor,
    }).returning({ id: crmTasks.id });
    if (!created) throw new CrmWriteError('Task insert returned no id');
    await syncNextFollowUp(executor, contactId);
    await audit(executor, {
      actor: input.actor,
      action: 'crm_task.created',
      entityType: 'crm_task',
      entityId: created.id,
      metadata: { contactId, dueAt: dueAt ? dueAt.toISOString() : null, priority: priorityInput },
    });
    if (contactId) {
      await insertTimelineEvent(executor, {
        contactId,
        channel: 'internal',
        direction: 'internal',
        actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
        actorName: input.actor,
        eventKind: 'follow_up_created',
        bodyText: `Follow-up: ${title}${dueAt ? ` (due ${dueAt.toISOString()})` : ''}.`,
        provider: 'crm',
        providerMessageId: `task-created:${created.id}`,
      });
    }
    return created.id;
  });
  return { taskId };
}

export interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  kind: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  contactId: string | null;
  contactName: string | null;
  contactOrganization: string | null;
  overdue: boolean;
}

async function taskRows(where: ReturnType<typeof and>, limit: number): Promise<TaskRow[]> {
  const rows = await db
    .select({
      id: crmTasks.id,
      title: crmTasks.title,
      notes: crmTasks.notes,
      kind: crmTasks.kind,
      status: crmTasks.status,
      priority: crmTasks.priority,
      dueAt: crmTasks.dueAt,
      contactId: crmTasks.contactId,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      organizationName: contacts.organizationName,
    })
    .from(crmTasks)
    .leftJoin(contacts, eq(contacts.id, crmTasks.contactId))
    .where(where)
    .orderBy(sql`${crmTasks.dueAt} ASC NULLS LAST`, asc(crmTasks.priority))
    .limit(limit);
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    notes: row.notes,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    dueAt: row.dueAt,
    contactId: row.contactId,
    contactName: [row.firstName, row.lastName].filter(Boolean).join(' ') || null,
    contactOrganization: row.organizationName,
    overdue: Boolean(row.dueAt && row.dueAt.getTime() < now),
  }));
}

/**
 * The due list: open tasks due before the end of today in Chicago, so an
 * overdue task stays visible instead of quietly dropping off the list.
 */
export async function listDueTasks(input: { limit?: number } = {}): Promise<{ date: string; tasks: TaskRow[] }> {
  const bounds = chicagoDayBounds();
  const tasks = await taskRows(
    and(
      eq(crmTasks.organizationId, CRM_ORGANIZATION_ID),
      eq(crmTasks.status, 'open'),
      // An ISO string with a cast: the client runs with prepare:false (pooler), which
      // cannot bind a raw Date inside a hand-written sql template.
      sql`${crmTasks.dueAt} IS NOT NULL AND ${crmTasks.dueAt} < ${bounds.end.toISOString()}::timestamptz`,
    ),
    Math.min(Math.max(input.limit ?? 100, 1), 500),
  );
  return { date: bounds.date, tasks };
}

export async function listTasks(input: {
  status?: string | null;
  contactId?: string | null;
  limit?: number;
} = {}): Promise<TaskRow[]> {
  const clauses = [eq(crmTasks.organizationId, CRM_ORGANIZATION_ID)];
  if (input.status && ['open', 'done', 'cancelled'].includes(input.status)) {
    clauses.push(eq(crmTasks.status, input.status));
  }
  if (input.contactId) clauses.push(eq(crmTasks.contactId, input.contactId));
  return taskRows(and(...clauses), Math.min(Math.max(input.limit ?? 100, 1), 500));
}

export async function completeTask(input: { taskId: string; actor: string; notes?: unknown }): Promise<{ ok: true }> {
  const [existing] = await db.select().from(crmTasks).where(eq(crmTasks.id, input.taskId)).limit(1);
  if (!existing) throw new CrmWriteError('Task not found');
  if (existing.status === 'done') return { ok: true };
  const at = new Date();
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(crmTasks).set({
      status: 'done',
      completedAt: at,
      completedBy: input.actor,
      notes: clean(input.notes) ?? existing.notes,
      updatedAt: at,
    }).where(eq(crmTasks.id, input.taskId));
    await syncNextFollowUp(executor, existing.contactId);
    await audit(executor, {
      actor: input.actor,
      action: 'crm_task.completed',
      entityType: 'crm_task',
      entityId: input.taskId,
      metadata: { contactId: existing.contactId },
    });
    if (existing.contactId) {
      await insertTimelineEvent(executor, {
        contactId: existing.contactId,
        channel: 'internal',
        direction: 'internal',
        actorType: input.actor === OPERATOR_ACTOR ? 'operator' : 'system',
        actorName: input.actor,
        eventKind: 'follow_up_completed',
        bodyText: `Follow-up done: ${existing.title}${clean(input.notes) ? ` — ${clean(input.notes)}` : ''}.`,
        provider: 'crm',
        providerMessageId: `task-done:${input.taskId}:${at.toISOString()}`,
      });
    }
  });
  return { ok: true };
}

export async function cancelTask(input: { taskId: string; actor: string; reason?: unknown }): Promise<{ ok: true }> {
  const [existing] = await db.select().from(crmTasks).where(eq(crmTasks.id, input.taskId)).limit(1);
  if (!existing) throw new CrmWriteError('Task not found');
  if (existing.status !== 'open') throw new CrmWriteError('Only an open task can be cancelled.');
  const at = new Date();
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(crmTasks).set({ status: 'cancelled', updatedAt: at }).where(eq(crmTasks.id, input.taskId));
    await syncNextFollowUp(executor, existing.contactId);
    await audit(executor, {
      actor: input.actor,
      action: 'crm_task.cancelled',
      entityType: 'crm_task',
      entityId: input.taskId,
      metadata: { contactId: existing.contactId, reason: clean(input.reason) },
    });
  });
  return { ok: true };
}

export async function rescheduleTask(input: { taskId: string; actor: string; dueAt?: unknown }): Promise<{ dueAt: Date | null }> {
  const [existing] = await db.select().from(crmTasks).where(eq(crmTasks.id, input.taskId)).limit(1);
  if (!existing) throw new CrmWriteError('Task not found');
  const dueAt = parseDate(input.dueAt);
  const at = new Date();
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(crmTasks).set({ dueAt, updatedAt: at }).where(eq(crmTasks.id, input.taskId));
    await syncNextFollowUp(executor, existing.contactId);
    await audit(executor, {
      actor: input.actor,
      action: 'crm_task.rescheduled',
      entityType: 'crm_task',
      entityId: input.taskId,
      metadata: { from: existing.dueAt ? existing.dueAt.toISOString() : null, to: dueAt ? dueAt.toISOString() : null },
    });
  });
  return { dueAt };
}

// ─── Researched leads → the contact book ─────────────────────────────────────

export interface LeadImportFilter {
  limit?: number;
  status?: string | null;
  pipelineState?: string | null;
  industry?: string | null;
  city?: string | null;
  campaignId?: string | null;
  /** Only leads that carry an email or a phone: without one there is nobody to reach. */
  reachableOnly?: boolean;
}

export interface LeadImportPlanRow {
  leadId: string;
  companyName: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  industry: string | null;
  action: 'create' | 'matched' | 'skipped';
  reason?: string;
  existingContactId?: string;
}

export interface LeadImportPlan {
  dryRun: boolean;
  considered: number;
  wouldCreate: number;
  alreadyInBook: number;
  skipped: number;
  rows: LeadImportPlanRow[];
  filter: LeadImportFilter;
}

async function candidateLeads(filter: LeadImportFilter) {
  const clauses = [];
  if (filter.status) clauses.push(eq(researchedLeads.status, filter.status));
  if (filter.pipelineState) clauses.push(eq(researchedLeads.pipelineState, filter.pipelineState));
  if (filter.industry) clauses.push(sql`lower(coalesce(${researchedLeads.industry}, '')) = ${filter.industry.toLowerCase()}`);
  if (filter.city) clauses.push(sql`lower(coalesce(${researchedLeads.city}, '')) = ${filter.city.toLowerCase()}`);
  if (filter.campaignId) clauses.push(eq(researchedLeads.campaignId, filter.campaignId));
  if (filter.reachableOnly !== false) {
    clauses.push(sql`(
      (${researchedLeads.contactEmail} IS NOT NULL AND ${researchedLeads.contactEmail} <> '')
      OR (${researchedLeads.contactPhone} IS NOT NULL AND ${researchedLeads.contactPhone} <> '')
    )`);
  }
  return db
    .select()
    .from(researchedLeads)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(researchedLeads.discoveredAt))
    .limit(Math.min(Math.max(filter.limit ?? 200, 1), MAX_IMPORT_BATCH));
}

/** Which contact in the book already represents this lead, if any. */
async function matchContactForLead(
  executor: CrmDb,
  lead: { contactEmail: string | null; contactPhone: string | null; website: string | null; companyName: string },
): Promise<string | null> {
  const email = extractEmailAddress(lead.contactEmail);
  if (email) {
    const ids = await findContactIdsByDestination(executor, email);
    if (ids[0]) return ids[0];
  }
  const phone = normalizePhone(lead.contactPhone);
  if (phone) {
    const ids = await findContactIdsByDestination(executor, phone);
    if (ids[0]) return ids[0];
  }
  const domain = domainOf(lead.website);
  const key = companyKey(lead.companyName);
  if (!domain && !key) return null;
  const rows = await executor
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(
      eq(contacts.organizationId, CRM_ORGANIZATION_ID),
      sql`(
        (${domain}::text IS NOT NULL AND lower(regexp_replace(regexp_replace(coalesce(${contacts.website}, ''), '^[a-zA-Z]+://', ''), '^www\\.|[/?#:].*$', '', 'g')) = ${domain}::text)
        OR (${key}::text IS NOT NULL AND lower(regexp_replace(coalesce(${contacts.organizationName}, ''), '[^a-zA-Z0-9]', '', 'g')) = ${key}::text)
      )`,
    ))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Dry run by default: say exactly which leads would become contacts, which are
 * already in the book, and which are skipped, before anything is written.
 */
export async function planResearchedLeadImport(filter: LeadImportFilter = {}): Promise<LeadImportPlan> {
  const leads = await candidateLeads(filter);
  const rows: LeadImportPlanRow[] = [];
  let wouldCreate = 0;
  let alreadyInBook = 0;
  let skipped = 0;
  for (const lead of leads) {
    const contactId = await matchContactForLead(db, lead);
    if (contactId) {
      alreadyInBook += 1;
      rows.push({
        leadId: lead.id,
        companyName: lead.companyName,
        contactName: lead.decisionMakerName ?? null,
        email: lead.contactEmail ?? null,
        phone: lead.contactPhone ?? null,
        city: lead.city ?? null,
        industry: lead.industry ?? null,
        action: 'matched',
        reason: 'already in the contact book',
        existingContactId: contactId,
      });
      continue;
    }
    const name = lead.decisionMakerName ?? null;
    if (!lead.companyName && !name) {
      skipped += 1;
      rows.push({
        leadId: lead.id,
        companyName: lead.companyName,
        contactName: name,
        email: lead.contactEmail ?? null,
        phone: lead.contactPhone ?? null,
        city: lead.city ?? null,
        industry: lead.industry ?? null,
        action: 'skipped',
        reason: 'no company or contact name',
      });
      continue;
    }
    wouldCreate += 1;
    rows.push({
      leadId: lead.id,
      companyName: lead.companyName,
      contactName: name,
      email: lead.contactEmail ?? null,
      phone: lead.contactPhone ?? null,
      city: lead.city ?? null,
      industry: lead.industry ?? null,
      action: 'create',
    });
  }
  return { dryRun: true, considered: leads.length, wouldCreate, alreadyInBook, skipped, rows, filter };
}

/**
 * Write the plan. Requires `confirm: true` — the default is a dry run, and the
 * route that calls this also requires an operator dashboard session, because
 * this writes to the real contact book.
 */
export async function applyResearchedLeadImport(input: {
  actor: string;
  filter?: LeadImportFilter;
  confirm?: boolean;
  notes?: unknown;
}): Promise<{ batchId: string; created: number; matched: number; skipped: number; plan: LeadImportPlan }> {
  if (input.confirm !== true) {
    throw new CrmWriteError('Copying leads into the contact book needs an explicit confirmation.');
  }
  const plan = await planResearchedLeadImport(input.filter ?? {});
  const toCreate = plan.rows.filter((row) => row.action === 'create');
  const at = new Date();
  const batchId = await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const [batch] = await executor.insert(crmLeadImports).values({
      organizationId: CRM_ORGANIZATION_ID,
      status: 'applied',
      filter: (plan.filter ?? {}) as Record<string, unknown>,
      matched: plan.alreadyInBook,
      createdCount: toCreate.length,
      skippedCount: plan.skipped,
      appliedBy: input.actor,
      appliedAt: at,
      notes: clean(input.notes),
    }).returning({ id: crmLeadImports.id });
    if (!batch) throw new CrmWriteError('Lead import batch insert returned no id');
    return batch.id;
  });

  let created = 0;
  let matched = 0;
  let skipped = 0;
  for (const row of plan.rows) {
    if (row.action === 'matched') {
      matched += 1;
      await db.insert(crmLeadImportRows).values({
        batchId,
        leadId: row.leadId,
        contactId: row.existingContactId ?? null,
        outcome: 'matched',
        detail: 'already in the contact book',
      }).onConflictDoNothing();
      continue;
    }
    if (row.action === 'skipped') {
      skipped += 1;
      await db.insert(crmLeadImportRows).values({
        batchId,
        leadId: row.leadId,
        outcome: 'skipped',
        detail: row.reason ?? 'skipped',
      }).onConflictDoNothing();
      continue;
    }
    const [lead] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, row.leadId)).limit(1);
    if (!lead) {
      skipped += 1;
      await db.insert(crmLeadImportRows).values({ batchId, leadId: row.leadId, outcome: 'skipped', detail: 'lead disappeared' }).onConflictDoNothing();
      continue;
    }
    const contactId = await db.transaction(async (tx) => {
      const executor = asExecutor(tx);
      // Re-check inside the write: a duplicate created since the plan would
      // otherwise become a second record for the same person.
      const again = await matchContactForLead(executor, lead);
      if (again) return { contactId: again, outcome: 'matched' as const };
      const email = extractEmailAddress(lead.contactEmail);
      const phone = normalizePhone(lead.contactPhone);
      const name = clean(lead.decisionMakerName) ?? '';
      const [firstName, ...rest] = name.split(/\s+/);
      const tags = ['researched-lead'];
      if (lead.industry) tags.push(lead.industry.toLowerCase().replace(/\s+/g, '-'));
      const [inserted] = await executor.insert(contacts).values({
        organizationId: CRM_ORGANIZATION_ID,
        firstName: firstName || null,
        lastName: rest.join(' ') || null,
        title: lead.title ?? null,
        email,
        phoneE164: phone,
        organizationName: lead.companyName,
        website: lead.website,
        city: lead.city,
        tags,
        source: 'researched-leads',
        status: 'active',
        lifecycleStage: 'prospect',
        lifecycleStageChangedAt: at,
        lifecycleStageChangedBy: input.actor,
        metadata: {
          researchedLeadId: lead.id,
          industry: lead.industry,
          fitReason: lead.fitReason,
          outreachAngle: lead.outreachAngle,
          contactSourceUrl: lead.contactSourceUrl,
          linkedinUrl: lead.linkedinUrl,
          employeeCount: lead.employeeCount,
          importedBy: input.actor,
          importBatchId: batchId,
        },
      }).returning({ id: contacts.id });
      if (!inserted) throw new CrmWriteError('Contact insert returned no id');
      if (email) await addIdentifier(executor, inserted.id, 'email', email);
      if (phone) await addIdentifier(executor, inserted.id, 'phone', phone);
      await insertTimelineEvent(executor, {
        contactId: inserted.id,
        channel: 'internal',
        direction: 'internal',
        actorType: 'operator',
        actorName: input.actor,
        eventKind: 'lead_imported',
        bodyText: `Researched lead copied into the contact book as a prospect${lead.fitReason ? ` — ${lead.fitReason}` : ''}.`,
        provider: 'crm',
        providerMessageId: `lead-import:${batchId}:${lead.id}`,
        metadata: { researchedLeadId: lead.id, batchId },
      });
      return { contactId: inserted.id, outcome: 'created' as const };
    });
    if (contactId.outcome === 'created') created += 1;
    else matched += 1;
    await db.insert(crmLeadImportRows).values({
      batchId,
      leadId: row.leadId,
      contactId: contactId.contactId,
      outcome: contactId.outcome,
      detail: contactId.outcome === 'matched' ? 'already in the contact book' : null,
    }).onConflictDoNothing();
  }

  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(crmLeadImports).set({
      createdCount: created,
      matched,
      skippedCount: skipped,
    }).where(eq(crmLeadImports.id, batchId));
    await audit(executor, {
      actor: input.actor,
      action: 'crm.leads_imported',
      entityType: 'crm_lead_import',
      entityId: batchId,
      metadata: { created, matched, skipped, filter: plan.filter ?? {} },
    });
  });

  return { batchId, created, matched, skipped, plan };
}

export interface LeadImportBatch {
  id: string;
  status: string;
  appliedBy: string;
  appliedAt: Date;
  undoneAt: Date | null;
  createdCount: number;
  matched: number;
  skippedCount: number;
  filter: Record<string, unknown>;
  notes: string | null;
}

export async function listLeadImports(input: { limit?: number } = {}): Promise<LeadImportBatch[]> {
  const rows = await db
    .select()
    .from(crmLeadImports)
    .where(eq(crmLeadImports.organizationId, CRM_ORGANIZATION_ID))
    .orderBy(desc(crmLeadImports.appliedAt))
    .limit(Math.min(Math.max(input.limit ?? 10, 1), 50));
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    appliedBy: row.appliedBy,
    appliedAt: row.appliedAt,
    undoneAt: row.undoneAt,
    createdCount: row.createdCount,
    matched: row.matched,
    skippedCount: row.skippedCount,
    filter: (row.filter ?? {}) as Record<string, unknown>,
    notes: row.notes,
  }));
}

/** Is this contact still exactly as the import left it? */
async function contactUntouched(executor: CrmDb, contactId: string): Promise<{ untouched: boolean; reason?: string }> {
  const [contact] = await executor
    .select({ email: contacts.email, phone: contacts.phoneE164, doNotContact: contacts.doNotContact })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!contact) return { untouched: false, reason: 'contact no longer exists' };
  if (contact.doNotContact) return { untouched: false, reason: 'do-not-contact was set' };
  const [timeline] = await executor
    .select({ id: contactTimeline.id })
    .from(contactTimeline)
    .where(and(eq(contactTimeline.contactId, contactId), sql`${contactTimeline.eventKind} <> 'lead_imported'`))
    .limit(1);
  if (timeline) return { untouched: false, reason: 'has activity in its history' };
  const [interaction] = await executor
    .select({ id: interactions.id })
    .from(interactions)
    .where(eq(interactions.contactId, contactId))
    .limit(1);
  if (interaction) return { untouched: false, reason: 'has logged interactions' };
  const [enrollment] = await executor
    .select({ id: campaignEnrollments.id })
    .from(campaignEnrollments)
    .where(eq(campaignEnrollments.contactId, contactId))
    .limit(1);
  if (enrollment) return { untouched: false, reason: 'is enrolled in a campaign' };
  if (contact.phone) {
    const [call] = await executor
      .select({ id: callBridgeSessions.id })
      .from(callBridgeSessions)
      .where(eq(callBridgeSessions.customerNumber, contact.phone))
      .limit(1);
    if (call) return { untouched: false, reason: 'has a call record' };
  }
  if (contact.email) {
    const [send] = await executor
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(sql`lower(${emailSends.toEmail}) = ${contact.email.toLowerCase()}`)
      .limit(1);
    if (send) return { untouched: false, reason: 'has an email send' };
  }
  return { untouched: true };
}

/**
 * Undo a copy. Only the contacts this batch created are removed, and only those
 * that nothing has touched since: a contact someone has since called, emailed,
 * enrolled or opted out is kept, and the undo reports why.
 */
export async function undoResearchedLeadImport(input: {
  batchId: string;
  actor: string;
}): Promise<{ removed: number; kept: number; keptReasons: Array<{ contactId: string; reason: string }> }> {
  const [batch] = await db.select().from(crmLeadImports).where(eq(crmLeadImports.id, input.batchId)).limit(1);
  if (!batch) throw new CrmWriteError('Import batch not found');
  if (batch.status === 'undone') throw new CrmWriteError('That copy was already undone.');
  const rows = await db
    .select()
    .from(crmLeadImportRows)
    .where(and(eq(crmLeadImportRows.batchId, input.batchId), eq(crmLeadImportRows.outcome, 'created')));
  let removed = 0;
  let kept = 0;
  const keptReasons: Array<{ contactId: string; reason: string }> = [];
  const at = new Date();
  for (const row of rows) {
    if (!row.contactId) continue;
    const state = await db.transaction(async (tx) => {
      const executor = asExecutor(tx);
      const check = await contactUntouched(executor, row.contactId as string);
      if (!check.untouched) return check;
      // Only the records this batch created are removed. The contact's own
      // timeline rows stay (the timeline is insert-only): they are the record
      // that the lead was copied in, and the import row below records the undo.
      await executor.delete(contactIdentifiers).where(eq(contactIdentifiers.contactId, row.contactId as string));
      await executor.delete(contacts).where(eq(contacts.id, row.contactId as string));
      return { untouched: true };
    });
    if (state.untouched) {
      removed += 1;
      await db.update(crmLeadImportRows).set({ detail: 'removed by undo' }).where(eq(crmLeadImportRows.id, row.id));
    } else {
      kept += 1;
      const reason = state.reason ?? 'has activity';
      keptReasons.push({ contactId: row.contactId, reason });
      await db.update(crmLeadImportRows).set({ detail: `kept by undo: ${reason}` }).where(eq(crmLeadImportRows.id, row.id));
    }
  }
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(crmLeadImports).set({
      status: 'undone',
      undoneBy: input.actor,
      undoneAt: at,
      createdCount: kept,
      notes: batch.notes,
    }).where(eq(crmLeadImports.id, input.batchId));
    await audit(executor, {
      actor: input.actor,
      action: 'crm.lead_import_undone',
      entityType: 'crm_lead_import',
      entityId: input.batchId,
      metadata: { removed, kept, keptReasons },
    });
  });
  return { removed, kept, keptReasons };
}

// ─── Opt-outs you can actually undo ──────────────────────────────────────────

export interface ContactSuppression {
  id: string;
  channel: string;
  reason: string;
  source: string | null;
  email: string | null;
  phoneE164: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  liftedAt: Date | null;
  liftedBy: string | null;
  liftReason: string | null;
}

export async function listContactSuppressions(input: { contactId: string }): Promise<ContactSuppression[]> {
  const [contact] = await db
    .select({ id: contacts.id, email: contacts.email, phoneE164: contacts.phoneE164 })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  if (!contact) throw new CrmWriteError('Contact not found');
  const clauses = [eq(suppressions.contactId, contact.id)];
  if (contact.email) clauses.push(sql`lower(${suppressions.email}) = ${contact.email.toLowerCase()}`);
  if (contact.phoneE164) clauses.push(eq(suppressions.phoneE164, contact.phoneE164));
  const rows = await db
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.organizationId, CRM_ORGANIZATION_ID), or(...clauses)))
    .orderBy(desc(suppressions.createdAt))
    .limit(50);
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    reason: row.reason,
    source: row.source,
    email: row.email,
    phoneE164: row.phoneE164,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    liftedAt: row.liftedAt,
    liftedBy: row.liftedBy,
    liftReason: row.liftReason,
  }));
}

/**
 * Lift ONE recorded opt-out so that channel can be used again.
 *
 * The row is never deleted: it is marked lifted, with who lifted it and why.
 * Lifting only that channel is the default; clearing the contact-level
 * do-not-contact flag is a second, explicit decision, and it is refused while
 * another record for that address is still blocking the same channel.
 */
export async function liftSuppression(input: {
  suppressionId: string;
  actor: string;
  reason?: unknown;
  alsoClearDoNotContact?: boolean;
}): Promise<{ ok: true; channel: string; clearedDoNotContact: boolean; contactId: string | null }> {
  if (!lifecycleStageChangeAllowed(input.actor)) {
    throw new CrmWriteError('Only Matthew can lift an opt-out.');
  }
  const [row] = await db.select().from(suppressions).where(eq(suppressions.id, input.suppressionId)).limit(1);
  if (!row) throw new CrmWriteError('That opt-out record was not found.');
  if (row.liftedAt) throw new CrmWriteError('That opt-out was already lifted.');
  const reason = clean(input.reason) ?? 'operator lifted';
  const at = new Date();
  let clearedDoNotContact = false;
  const contactId = row.contactId ?? null;

  if (input.alsoClearDoNotContact === true && contactId) {
    const remaining = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(
        eq(suppressions.organizationId, CRM_ORGANIZATION_ID),
        isNull(suppressions.liftedAt),
        or(
          eq(suppressions.channel, 'all'),
          eq(suppressions.channel, row.channel),
          row.channel === 'email' ? eq(suppressions.channel, 'calendar') : eq(suppressions.channel, row.channel),
        ),
        or(
          ...(row.email ? [sql`lower(${suppressions.email}) = ${row.email.toLowerCase()}`] : []),
          ...(row.phoneE164 ? [eq(suppressions.phoneE164, row.phoneE164)] : []),
          eq(suppressions.contactId, contactId),
        ),
      ))
      .limit(5);
    const others = remaining.filter((other) => other.id !== row.id);
    if (others.length > 0) {
      throw new CrmWriteError(
        'Another opt-out record still blocks this person. Lift those first, or only lift this one.',
      );
    }
    clearedDoNotContact = true;
  }

  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(suppressions).set({
      liftedAt: at,
      liftedBy: input.actor,
      liftReason: reason,
    }).where(eq(suppressions.id, input.suppressionId));
    // The email mirror is a blocking lookup, not the record of the opt-out: the
    // suppressions row plus the audit and timeline rows hold that history.
    if (row.email && (row.channel === 'email' || row.channel === 'all' || row.channel === 'calendar')) {
      await executor.delete(emailSuppressions).where(eq(emailSuppressions.email, row.email.toLowerCase()));
    }
    if (clearedDoNotContact && contactId) {
      await executor.update(contacts).set({
        doNotContact: false,
        doNotContactReason: null,
        doNotContactSetBy: input.actor,
        doNotContactSetAt: at,
        status: 'active',
        updatedAt: at,
      }).where(eq(contacts.id, contactId));
    }
    await audit(executor, {
      actor: input.actor,
      action: 'contact.suppression_lifted',
      entityType: 'contact',
      entityId: contactId ?? input.suppressionId,
      metadata: { suppressionId: input.suppressionId, channel: row.channel, reason, clearedDoNotContact },
    });
    if (contactId) {
      await insertTimelineEvent(executor, {
        contactId,
        channel: 'internal',
        direction: 'internal',
        actorType: 'operator',
        actorName: input.actor,
        eventKind: 'opt_out_lifted',
        bodyText: `Opt-out lifted for ${row.channel} (${row.reason})${clearedDoNotContact ? '; do-not-contact cleared' : ''}. Reason: ${reason}.`,
        provider: 'crm',
        providerMessageId: `optout-lift:${input.suppressionId}:${at.toISOString()}`,
      });
    }
  });
  return { ok: true, channel: row.channel, clearedDoNotContact, contactId };
}

/** Active (unlifted, unexpired) suppressions, for the compliance panel. */
export async function listActiveSuppressions(input: { limit?: number } = {}) {
  return db
    .select()
    .from(suppressions)
    .where(and(
      eq(suppressions.organizationId, CRM_ORGANIZATION_ID),
      isNull(suppressions.liftedAt),
      or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, new Date())),
    ))
    .orderBy(desc(suppressions.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
}
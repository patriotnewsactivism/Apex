/**
 * CRM contact book. Timeline rows are insert-only. Corrections are new rows.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditEvents,
  callBridgeSessions,
  callOutcomes,
  campaignEnrollments,
  companies,
  contactIdentifiers,
  contactMerges,
  contactTimeline,
  contacts,
  crmLegacyLinks,
  db,
  emailSends,
  emailSuppressions,
  inboundUnmatched,
  interactions,
  meetings,
  researchedLeads,
  sequenceStepExecutions,
  smsMessages,
  suppressions,
} from '@workspace/db';
import {
  CRM_ORGANIZATION_ID,
  OPERATOR_ACTOR,
  SendBlockedError,
  assertDoNotContactClear,
  clearDoNotContactAllowed,
  extractEmailAddress,
  mergeAllowed,
  normalizePhone,
  parseNewsroomCsv,
  toCsv,
  type NewsroomRow,
} from './pure.js';

export type CrmDb = typeof db;

export interface TimelineAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
}

export interface TimelineInput {
  organizationId?: string;
  contactId?: string | null;
  destination?: string | null;
  createContact?: boolean;
  channel: string;
  direction: 'inbound' | 'outbound' | 'internal';
  actorType: 'operator' | 'agent' | 'system' | 'provider';
  actorName: string;
  eventKind: string;
  occurredAt?: Date;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  emailMessageId?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  replyToken?: string | null;
  sendRecordTable?: string | null;
  sendRecordId?: string | null;
  attachments?: TimelineAttachment[];
  metadata?: Record<string, unknown>;
}

const REPLY_EVENTS = new Set(['reply', 'message', 'email', 'sms', 'call', 'inbound']);

export function asExecutor(tx: unknown): CrmDb {
  return tx as CrmDb;
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: string }).code;
    if (code === '23505') return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function destinationKind(destination: string): { email: string | null; phone: string | null } {
  const email = extractEmailAddress(destination);
  if (email) return { email, phone: null };
  return { email: null, phone: normalizePhone(destination) };
}

export async function findContactIdsByDestination(executor: CrmDb, destination: string): Promise<string[]> {
  const { email, phone } = destinationKind(destination);
  const ids = new Set<string>();
  if (email) {
    const byColumn = await executor
      .select({ id: contacts.id })
      .from(contacts)
      .where(sql`lower(${contacts.email}) = ${email}`);
    for (const row of byColumn) ids.add(row.id);
    const byIdent = await executor
      .select({ contactId: contactIdentifiers.contactId })
      .from(contactIdentifiers)
      .where(and(eq(contactIdentifiers.kind, 'email'), sql`lower(${contactIdentifiers.value}) = ${email}`));
    for (const row of byIdent) ids.add(row.contactId);
  }
  if (phone) {
    const byColumn = await executor
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.phoneE164, phone));
    for (const row of byColumn) ids.add(row.id);
    const byIdent = await executor
      .select({ contactId: contactIdentifiers.contactId })
      .from(contactIdentifiers)
      .where(and(eq(contactIdentifiers.kind, 'phone'), eq(contactIdentifiers.value, phone)));
    for (const row of byIdent) ids.add(row.contactId);
  }
  return [...ids];
}

async function addIdentifier(
  executor: CrmDb,
  contactId: string,
  kind: 'email' | 'phone',
  value: string,
  sourceUrl?: string | null,
): Promise<void> {
  await executor.insert(contactIdentifiers).values({
    contactId,
    kind,
    value,
    verified: false,
    sourceUrl: sourceUrl ?? null,
    foundAt: new Date(),
  }).onConflictDoNothing();
}

export async function findOrCreateContact(
  executor: CrmDb,
  destination: string,
  extras: { name?: string | null; organizationName?: string | null; source?: string } = {},
): Promise<string> {
  const existing = await findContactIdsByDestination(executor, destination);
  if (existing[0]) return existing[0];
  const { email, phone } = destinationKind(destination);
  const name = extras.name?.trim() ?? '';
  const [firstName, ...rest] = name.split(/\s+/);
  try {
    const [created] = await executor.insert(contacts).values({
      organizationId: CRM_ORGANIZATION_ID,
      firstName: firstName || null,
      lastName: rest.join(' ') || null,
      organizationName: extras.organizationName ?? null,
      email,
      phoneE164: phone,
      source: extras.source ?? 'crm',
      status: 'active',
    }).returning({ id: contacts.id });
    if (!created) throw new Error('Contact insert returned no id');
    if (email) await addIdentifier(executor, created.id, 'email', email);
    if (phone) await addIdentifier(executor, created.id, 'phone', phone);
    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const again = await findContactIdsByDestination(executor, destination);
    if (again[0]) return again[0];
    throw error;
  }
}

// Contact-level do-not-contact, every channel. The send safeguard's own gate
// (send-safeguard.ts assertSendAllowed) still runs after this on every path.
export async function assertContactSendable(input: {
  channel: string;
  destination?: string | null;
  contactId?: string | null;
}): Promise<{ contactId: string | null }> {
  void input.channel;
  const ids = new Set<string>();
  if (input.contactId) ids.add(input.contactId);
  if (input.destination) {
    for (const id of await findContactIdsByDestination(db, input.destination)) ids.add(id);
  }
  if (ids.size === 0) return { contactId: input.contactId ?? null };
  const rows = await db
    .select({
      id: contacts.id,
      doNotContact: contacts.doNotContact,
      doNotContactReason: contacts.doNotContactReason,
      doNotContactSetBy: contacts.doNotContactSetBy,
    })
    .from(contacts)
    .where(inArray(contacts.id, [...ids]));
  const blocked = rows.find((row) => row.doNotContact);
  assertDoNotContactClear(blocked
    ? { doNotContact: true, reason: blocked.doNotContactReason, setBy: blocked.doNotContactSetBy }
    : null);
  return { contactId: input.contactId ?? rows[0]?.id ?? null };
}

async function familyIds(executor: CrmDb, rootId: string): Promise<string[]> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    const rows = await executor
      .select({ loserId: contactMerges.loserId })
      .from(contactMerges)
      .where(inArray(contactMerges.winnerId, [...ids]));
    for (const row of rows) {
      if (!ids.has(row.loserId)) {
        ids.add(row.loserId);
        grew = true;
      }
    }
  }
  return [...ids];
}

export async function pauseFollowUps(
  executor: CrmDb,
  contactId: string,
  at: Date,
  countAsReply: boolean,
): Promise<void> {
  await executor.update(contacts).set({
    followUpPaused: true,
    ...(countAsReply ? { lastReplyAt: at } : {}),
    updatedAt: at,
  }).where(eq(contacts.id, contactId));

  const enrollments = await executor
    .select({ id: campaignEnrollments.id })
    .from(campaignEnrollments)
    .where(and(
      eq(campaignEnrollments.contactId, contactId),
      inArray(campaignEnrollments.status, ['pending', 'active', 'waiting']),
    ));
  if (enrollments.length === 0) return;
  const enrollmentIds = enrollments.map((row) => row.id);
  await executor.update(campaignEnrollments).set({
    status: 'responded',
    stopReason: 'reply',
    nextActionAt: null,
    updatedAt: at,
  }).where(inArray(campaignEnrollments.id, enrollmentIds));
  await executor.update(sequenceStepExecutions).set({
    status: 'skipped',
    error: 'paused: contact replied',
    updatedAt: at,
  }).where(and(
    inArray(sequenceStepExecutions.enrollmentId, enrollmentIds),
    inArray(sequenceStepExecutions.status, ['queued', 'running', 'awaiting_approval']),
  ));
}

export async function insertTimelineEvent(
  executor: CrmDb,
  input: TimelineInput,
): Promise<{ id: string; interactionId: string | null; deduped: boolean }> {
  if (input.provider && input.providerMessageId) {
    const [existing] = await executor
      .select({ id: contactTimeline.id, interactionId: contactTimeline.interactionId })
      .from(contactTimeline)
      .where(and(
        eq(contactTimeline.provider, input.provider),
        eq(contactTimeline.providerMessageId, input.providerMessageId),
      ))
      .limit(1);
    if (existing) return { id: existing.id, interactionId: existing.interactionId, deduped: true };
  }

  let contactId = input.contactId ?? null;
  if (!contactId && input.destination && input.createContact !== false) {
    contactId = await findOrCreateContact(executor, input.destination);
  }
  const at = input.occurredAt ?? new Date();
  const organizationId = input.organizationId ?? CRM_ORGANIZATION_ID;
  const summary = (input.bodyText ?? input.subject ?? input.eventKind).slice(0, 500);

  const [interaction] = await executor.insert(interactions).values({
    organizationId,
    contactId,
    channel: input.channel,
    direction: input.direction,
    type: input.eventKind,
    provider: input.provider ?? null,
    externalId: input.providerMessageId ?? null,
    subject: input.subject?.slice(0, 500) ?? null,
    bodySummary: summary,
    bodyText: input.bodyText ?? null,
    bodyHtml: input.bodyHtml ?? null,
    providerMessageId: input.providerMessageId ?? null,
    emailMessageId: input.emailMessageId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    referencesHeader: input.referencesHeader ?? null,
    actorType: input.actorType,
    actorName: input.actorName,
    occurredAt: at,
  }).returning({ id: interactions.id });

  const [row] = await executor.insert(contactTimeline).values({
    organizationId,
    contactId,
    channel: input.channel,
    direction: input.direction,
    actorType: input.actorType,
    actorName: input.actorName,
    eventKind: input.eventKind,
    occurredAt: at,
    subject: input.subject ?? null,
    bodyText: input.bodyText ?? null,
    bodyHtml: input.bodyHtml ?? null,
    provider: input.provider ?? null,
    providerMessageId: input.providerMessageId ?? null,
    emailMessageId: input.emailMessageId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    referencesHeader: input.referencesHeader ?? null,
    replyToken: input.replyToken ?? null,
    interactionId: interaction?.id ?? null,
    sendRecordTable: input.sendRecordTable ?? null,
    sendRecordId: input.sendRecordId ?? null,
    attachments: input.attachments ?? [],
    metadata: input.metadata ?? {},
  }).returning({ id: contactTimeline.id });
  if (!row) throw new Error('Timeline insert returned no id');

  if (contactId && input.direction === 'outbound') {
    await executor.update(contacts).set({
      lastContactedAt: at,
      updatedAt: at,
    }).where(eq(contacts.id, contactId));
  }
  if (contactId && input.direction === 'inbound' && REPLY_EVENTS.has(input.eventKind)) {
    await pauseFollowUps(executor, contactId, at, true);
  }
  return { id: row.id, interactionId: interaction?.id ?? null, deduped: false };
}

/** Alias scanned by verify-crm. Timeline inserts only — never updates. */
export const recordOutboundTimeline = insertTimelineEvent;

export async function commitSendRecord<T>(
  write: (tx: CrmDb) => Promise<T>,
  timeline: TimelineInput | ((result: T) => TimelineInput | Promise<TimelineInput>),
): Promise<{ result: T; timelineId: string }> {
  return db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const result = await write(executor);
    const input = typeof timeline === 'function' ? await timeline(result) : timeline;
    const row = await insertTimelineEvent(executor, input);
    return { result, timelineId: row.id };
  });
}

export async function applyDoNotContact(
  executor: CrmDb,
  input: {
    contactId?: string | null;
    destination?: string | null;
    reason: string;
    setBy: string;
    channel?: string;
    providerMessageId?: string | null;
  },
): Promise<string> {
  const at = new Date();
  let contactId = input.contactId ?? null;
  if (!contactId && input.destination) {
    contactId = await findOrCreateContact(executor, input.destination, { source: 'do_not_contact' });
  }
  if (!contactId) throw new Error('Do-not-contact requires a contact or a destination.');
  const { email, phone } = input.destination ? destinationKind(input.destination) : { email: null, phone: null };
  await executor.update(contacts).set({
    doNotContact: true,
    doNotContactReason: input.reason,
    doNotContactSetBy: input.setBy,
    doNotContactSetAt: at,
    status: 'suppressed',
    updatedAt: at,
  }).where(eq(contacts.id, contactId));
  await executor.insert(suppressions).values({
    organizationId: CRM_ORGANIZATION_ID,
    contactId,
    email,
    phoneE164: phone,
    channel: input.channel ?? 'all',
    reason: input.reason,
    source: 'automated',
  });
  if (email) {
    await executor.insert(emailSuppressions).values({
      email,
      reason: input.reason,
      createdAt: at,
    }).onConflictDoNothing();
  }
  await executor.insert(auditEvents).values({
    organizationId: CRM_ORGANIZATION_ID,
    actorType: input.setBy === OPERATOR_ACTOR ? 'user' : 'system',
    actorId: input.setBy,
    action: 'contact.do_not_contact',
    entityType: 'contact',
    entityId: contactId,
    metadata: { reason: input.reason },
  });
  await pauseFollowUps(executor, contactId, at, false);
  await insertTimelineEvent(executor, {
    contactId,
    channel: input.channel ?? 'internal',
    direction: 'internal',
    actorType: input.setBy === OPERATOR_ACTOR ? 'operator' : 'system',
    actorName: input.setBy,
    eventKind: 'opt_out',
    bodyText: `Do-not-contact set: ${input.reason}`,
    provider: 'crm',
    providerMessageId: input.providerMessageId ?? `optout:${contactId}:${input.reason}:${at.toISOString()}`,
  });
  return contactId;
}

export async function markDoNotContactByDestination(input: {
  destination: string;
  reason: string;
  setBy: string;
  channel?: string;
}): Promise<string> {
  return db.transaction(async (tx) => applyDoNotContact(asExecutor(tx), input));
}

export async function setDoNotContact(input: {
  contactId: string;
  value: boolean;
  actor: string;
  reason?: string | null;
}): Promise<void> {
  if (!input.value && !clearDoNotContactAllowed(input.actor)) {
    throw new Error('Only Matthew can clear do-not-contact.');
  }
  if (input.value) {
    await db.transaction(async (tx) => {
      await applyDoNotContact(asExecutor(tx), {
        contactId: input.contactId,
        reason: input.reason ?? 'manual',
        setBy: input.actor,
      });
    });
    return;
  }
  const at = new Date();
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    await executor.update(contacts).set({
      doNotContact: false,
      doNotContactReason: null,
      doNotContactSetBy: input.actor,
      doNotContactSetAt: at,
      status: 'active',
      updatedAt: at,
    }).where(eq(contacts.id, input.contactId));
    await executor.insert(auditEvents).values({
      organizationId: CRM_ORGANIZATION_ID,
      actorType: 'user',
      actorId: input.actor,
      action: 'contact.do_not_contact_cleared',
      entityType: 'contact',
      entityId: input.contactId,
      metadata: { previousReason: input.reason ?? null },
    });
    await insertTimelineEvent(executor, {
      contactId: input.contactId,
      channel: 'internal',
      direction: 'internal',
      actorType: 'operator',
      actorName: input.actor,
      eventKind: 'do_not_contact_cleared',
      bodyText: 'Do-not-contact cleared.',
      provider: 'crm',
      providerMessageId: `dnc-clear:${input.contactId}:${at.toISOString()}`,
    });
  });
}

export async function recordCodeCheck(input: {
  contactId: string;
  passed: boolean;
  code?: string | null;
  actorName: string;
}): Promise<string> {
  const { codeCheckTimelineText } = await import('./pure.js');
  const row = await insertTimelineEvent(db, {
    contactId: input.contactId,
    channel: 'internal',
    direction: 'internal',
    actorType: 'system',
    actorName: input.actorName,
    eventKind: 'code_check',
    bodyText: codeCheckTimelineText(input.passed, input.code),
    provider: 'crm',
    providerMessageId: `code-check:${input.contactId}:${Date.now()}:${input.passed ? 'pass' : 'fail'}`,
  });
  return row.id;
}

export interface SmsSendRow {
  id: string;
  direction: 'inbound' | 'outbound';
  counterpartyNumber: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  providerId?: string | null;
  errorMessage?: string | null;
  createdByAgentId?: string | null;
}

export async function commitSmsMessage(
  row: SmsSendRow,
  actor: { actorType: TimelineInput['actorType']; actorName: string },
): Promise<string> {
  const recorded = await commitSendRecord(async (tx) => {
    await tx.insert(smsMessages).values({
      id: row.id,
      direction: row.direction,
      counterpartyNumber: row.counterpartyNumber,
      fromNumber: row.fromNumber,
      toNumber: row.toNumber,
      body: row.body,
      status: row.status,
      providerId: row.providerId ?? null,
      errorMessage: row.errorMessage ?? null,
      createdByAgentId: row.createdByAgentId ?? null,
      createdAt: new Date(),
    });
    return row.id;
  }, {
    destination: row.counterpartyNumber,
    channel: 'sms',
    direction: row.direction,
    actorType: actor.actorType,
    actorName: actor.actorName,
    eventKind: row.direction === 'inbound' ? 'sms' : 'sms',
    bodyText: row.body,
    provider: 'telnyx',
    providerMessageId: row.providerId ?? null,
    sendRecordTable: 'sms_messages',
    sendRecordId: row.id,
  });
  return recorded.timelineId;
}

export async function commitCallOutcome(input: {
  id: string;
  callId: string;
  leadId?: string | null;
  customerNumber: string;
  customerName?: string | null;
  disposition: string;
  summary: string;
  nextAction?: string | null;
  endedReason?: string | null;
  createdByAgentId: string;
  conflictUpdate?: boolean;
}): Promise<string> {
  const recorded = await commitSendRecord(async (tx) => {
    const values = {
      id: input.id,
      callId: input.callId,
      leadId: input.leadId ?? null,
      customerNumber: input.customerNumber,
      customerName: input.customerName ?? null,
      disposition: input.disposition,
      summary: input.summary,
      nextAction: input.nextAction ?? null,
      endedReason: input.endedReason ?? null,
      createdByAgentId: input.createdByAgentId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (input.conflictUpdate) {
      await tx.insert(callOutcomes).values(values).onConflictDoUpdate({
        target: callOutcomes.callId,
        set: {
          leadId: input.leadId ?? null,
          customerNumber: input.customerNumber,
          customerName: input.customerName ?? null,
          updatedAt: new Date(),
        },
      });
    } else {
      await tx.insert(callOutcomes).values(values);
    }
    return input.id;
  }, {
    destination: input.customerNumber,
    channel: 'call',
    direction: 'outbound',
    actorType: input.createdByAgentId === 'operator' ? 'operator' : 'agent',
    actorName: input.createdByAgentId,
    eventKind: 'call',
    bodyText: input.summary,
    provider: 'cartesia',
    providerMessageId: input.callId,
    sendRecordTable: 'call_outcomes',
    sendRecordId: input.id,
  });
  return recorded.timelineId;
}

export interface ContactSearchFilters {
  query?: string | null;
  tag?: string | null;
  city?: string | null;
  state?: string | null;
  verifiedOnly?: boolean;
  doNotContact?: boolean | null;
  ownerBot?: string | null;
  lastContactedFrom?: string | null;
  lastContactedTo?: string | null;
  replied?: boolean | null;
  campaignId?: string | null;
  /** Client's company industry (companies.industry via companyId). */
  industry?: string | null;
  /** Has/has not been called (per the contact timeline). */
  called?: boolean | null;
  /** Has/has not been emailed (per the contact timeline). */
  emailed?: boolean | null;
  limit?: number;
}

function searchTerm(query: string): string {
  return query.replace(/[^\p{L}\p{N}@.+]+/gu, ' ').trim();
}

export async function searchContacts(filters: ContactSearchFilters) {
  const clauses = [
    eq(contacts.organizationId, CRM_ORGANIZATION_ID),
    sql`${contacts.status} <> 'merged'`,
  ];
  const term = filters.query ? searchTerm(filters.query) : '';
  if (term) {
    clauses.push(sql`${contacts.id} IN (
      SELECT id FROM contacts WHERE search_vector @@ plainto_tsquery('simple', ${term})
      UNION
      SELECT contact_id FROM contact_timeline
      WHERE contact_id IS NOT NULL AND search_vector @@ plainto_tsquery('simple', ${term})
    )`);
  }
  if (filters.tag) clauses.push(sql`${filters.tag} = ANY(${contacts.tags})`);
  if (filters.city) clauses.push(sql`lower(${contacts.city}) = ${filters.city.toLowerCase()}`);
  if (filters.state) clauses.push(sql`lower(${contacts.state}) = ${filters.state.toLowerCase()}`);
  if (filters.ownerBot) clauses.push(eq(contacts.ownerBot, filters.ownerBot));
  if (filters.doNotContact === true || filters.doNotContact === false) {
    clauses.push(eq(contacts.doNotContact, filters.doNotContact));
  }
  if (filters.replied === true) clauses.push(sql`${contacts.lastReplyAt} IS NOT NULL`);
  if (filters.replied === false) clauses.push(sql`${contacts.lastReplyAt} IS NULL`);
  if (filters.lastContactedFrom) clauses.push(sql`${contacts.lastContactedAt} >= ${new Date(filters.lastContactedFrom)}`);
  if (filters.lastContactedTo) clauses.push(sql`${contacts.lastContactedAt} <= ${new Date(filters.lastContactedTo)}`);
  if (filters.verifiedOnly) {
    clauses.push(sql`${contacts.id} IN (SELECT contact_id FROM contact_identifiers WHERE verified = true)`);
  }
  if (filters.campaignId) {
    clauses.push(sql`${contacts.id} IN (
      SELECT contact_id FROM campaign_enrollments WHERE campaign_id = ${filters.campaignId}::uuid
    )`);
  }
  if (filters.industry && filters.industry.trim()) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM companies c
      WHERE c.id = ${contacts.companyId} AND lower(c.industry) = ${filters.industry.trim().toLowerCase()}
    )`);
  }
  // Called/emailed are read off the contact timeline, which records a row per
  // logged interaction regardless of channel. A false filter is the absence of
  // any such row, so "not emailed" means truly untouched, not merely untracked.
  if (filters.called === true) {
    clauses.push(sql`EXISTS (SELECT 1 FROM contact_timeline t WHERE t.contact_id = ${contacts.id} AND t.channel = 'call')`);
  } else if (filters.called === false) {
    clauses.push(sql`NOT EXISTS (SELECT 1 FROM contact_timeline t WHERE t.contact_id = ${contacts.id} AND t.channel = 'call')`);
  }
  if (filters.emailed === true) {
    clauses.push(sql`EXISTS (SELECT 1 FROM contact_timeline t WHERE t.contact_id = ${contacts.id} AND t.channel = 'email')`);
  } else if (filters.emailed === false) {
    clauses.push(sql`NOT EXISTS (SELECT 1 FROM contact_timeline t WHERE t.contact_id = ${contacts.id} AND t.channel = 'email')`);
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  return db.select().from(contacts).where(and(...clauses)).orderBy(desc(contacts.updatedAt)).limit(limit);
}

export interface ResearchedLeadSearchFilters {
  query?: string | null;
  industry?: string | null;
  city?: string | null;
  pipelineState?: string | null;
  status?: string | null;
  called?: boolean | null;
  emailed?: boolean | null;
  campaignId?: string | null;
  limit?: number;
}

/**
 * The CRM's second record type: researched leads. Same facet shape as the
 * contact search so one filter bar drives both lists. Called/emailed are read
 * from the outreach tables (email_sends, call_bridge_sessions) matched on the
 * lead's researched contact address/number — a lead has no identifier rows.
 */
export async function searchResearchedLeads(filters: ResearchedLeadSearchFilters) {
  const clauses = [];
  if (filters.query && filters.query.trim()) {
    const term = `%${filters.query.trim().toLowerCase()}%`;
    clauses.push(sql`(
      lower(${researchedLeads.companyName}) LIKE ${term}
      OR lower(coalesce(${researchedLeads.website}, '')) LIKE ${term}
      OR lower(coalesce(${researchedLeads.contactEmail}, '')) LIKE ${term}
      OR lower(coalesce(${researchedLeads.decisionMakerName}, '')) LIKE ${term}
    )`);
  }
  if (filters.industry && filters.industry.trim()) {
    clauses.push(sql`lower(coalesce(${researchedLeads.industry}, '')) = ${filters.industry.trim().toLowerCase()}`);
  }
  if (filters.city && filters.city.trim()) {
    clauses.push(sql`lower(coalesce(${researchedLeads.city}, '')) = ${filters.city.trim().toLowerCase()}`);
  }
  if (filters.pipelineState) clauses.push(eq(researchedLeads.pipelineState, filters.pipelineState));
  if (filters.status) clauses.push(eq(researchedLeads.status, filters.status));
  if (filters.campaignId) clauses.push(eq(researchedLeads.campaignId, filters.campaignId));
  if (filters.emailed === true) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM email_sends es
      WHERE es.lead_id = ${researchedLeads.id}
         OR (${researchedLeads.contactEmail} IS NOT NULL AND lower(es.to_email) = lower(${researchedLeads.contactEmail}))
    )`);
  } else if (filters.emailed === false) {
    clauses.push(sql`NOT EXISTS (
      SELECT 1 FROM email_sends es
      WHERE es.lead_id = ${researchedLeads.id}
         OR (${researchedLeads.contactEmail} IS NOT NULL AND lower(es.to_email) = lower(${researchedLeads.contactEmail}))
    )`);
  }
  if (filters.called === true) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM call_bridge_sessions cs
      WHERE ${researchedLeads.contactPhone} IS NOT NULL AND cs.customer_number = ${researchedLeads.contactPhone}
    )`);
  } else if (filters.called === false) {
    clauses.push(sql`NOT EXISTS (
      SELECT 1 FROM call_bridge_sessions cs
      WHERE ${researchedLeads.contactPhone} IS NOT NULL AND cs.customer_number = ${researchedLeads.contactPhone}
    )`);
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  return db
    .select()
    .from(researchedLeads)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(researchedLeads.discoveredAt))
    .limit(limit);
}

export async function getContact(contactId: string) {
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!contact) return null;
  const ids = await familyIds(db, contactId);
  const identifiers = await db.select().from(contactIdentifiers).where(inArray(contactIdentifiers.contactId, ids));
  const contactMeetings = await db.select().from(meetings).where(inArray(meetings.contactId, ids)).orderBy(desc(meetings.startsAt));
  return { contact, identifiers, meetings: contactMeetings };
}

export async function getTimeline(contactId: string) {
  const ids = await familyIds(db, contactId);
  return db.select().from(contactTimeline)
    .where(inArray(contactTimeline.contactId, ids))
    .orderBy(desc(contactTimeline.occurredAt));
}

export type ContactActivityKind = 'email' | 'sms' | 'call' | 'timeline';

export interface ContactActivityEvent {
  id: string;
  kind: ContactActivityKind;
  channel: string;
  occurredAt: Date;
  summary: string;
  direction: string | null;
  actor: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * Every logged interaction with a contact AND its merged family, across ALL
 * channels — the client card must show one chronological history, not just the
 * contact_timeline rows. The operator's rule: if it was emailed, called, or
 * texted, it is logged here. Email matches by identifier address, SMS and
 * calls match by identifier number.
 */
export async function getContactActivity(contactId: string): Promise<ContactActivityEvent[]> {
  const ids = await familyIds(db, contactId);
  const identifiers = await db
    .select()
    .from(contactIdentifiers)
    .where(inArray(contactIdentifiers.contactId, ids));
  const emails = [
    ...new Set(
      identifiers
        .filter((row) => row.kind === 'email')
        .map((row) => row.value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const phones = [
    ...new Set(
      identifiers
        .filter((row) => row.kind === 'phone')
        .map((row) => row.value.trim())
        .filter(Boolean),
    ),
  ];

  const [timeline, sentEmails, texts, calls] = await Promise.all([
    db.select().from(contactTimeline).where(inArray(contactTimeline.contactId, ids)),
    emails.length
      ? db.select().from(emailSends).where(inArray(sql`lower(${emailSends.toEmail})`, emails))
      : Promise.resolve([] as Array<typeof emailSends.$inferSelect>),
    phones.length
      ? db.select().from(smsMessages).where(inArray(smsMessages.counterpartyNumber, phones))
      : Promise.resolve([] as Array<typeof smsMessages.$inferSelect>),
    phones.length
      ? db.select().from(callBridgeSessions).where(inArray(callBridgeSessions.customerNumber, phones))
      : Promise.resolve([] as Array<typeof callBridgeSessions.$inferSelect>),
  ]);

  const events: ContactActivityEvent[] = [];
  for (const row of timeline) {
    events.push({
      id: `timeline:${row.id}`,
      kind: 'timeline',
      channel: row.channel,
      occurredAt: row.occurredAt,
      summary: row.subject || row.bodyText || row.eventKind,
      direction: row.direction,
      actor: row.actorName,
      detail: { eventKind: row.eventKind, provider: row.provider ?? null },
    });
  }
  for (const row of sentEmails) {
    events.push({
      id: `email:${row.id}`,
      kind: 'email',
      channel: 'email',
      occurredAt: row.sentAt ?? row.createdAt,
      summary: `${row.subject} — ${row.status}`,
      direction: 'outbound',
      actor: row.createdByAgentId ?? null,
      detail: { to: row.toEmail, status: row.status, campaignId: row.campaignId ?? null, leadId: row.leadId ?? null },
    });
  }
  for (const row of texts) {
    events.push({
      id: `sms:${row.id}`,
      kind: 'sms',
      channel: 'sms',
      occurredAt: row.createdAt,
      summary: row.body,
      direction: row.direction,
      actor: row.createdByAgentId ?? null,
      detail: { status: row.status, from: row.fromNumber, to: row.toNumber },
    });
  }
  for (const row of calls) {
    events.push({
      id: `call:${row.id}`,
      kind: 'call',
      channel: 'call',
      occurredAt: row.aiTakeoverAt ?? row.createdAt,
      summary: `Call ${row.status}${row.assistantTopic ? ` — ${row.assistantTopic}` : ''}`,
      direction: 'outbound',
      actor: row.createdByAgentId ?? null,
      detail: { status: row.status, mode: row.sessionMode, aiMuted: row.aiMuted },
    });
  }

  events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return events;
}

const FREE_EMAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com']);

export async function duplicateSuggestions() {
  const merged = new Set((await db.select({ id: contactMerges.loserId }).from(contactMerges)).map((row) => row.id));
  const emailRows = await db.execute(sql`
    SELECT lower(value) AS value, array_agg(DISTINCT contact_id::text) AS ids
    FROM contact_identifiers
    WHERE kind = 'email'
    GROUP BY lower(value)
    HAVING count(DISTINCT contact_id) > 1
  `);
  const phoneRows = await db.execute(sql`
    SELECT value, array_agg(DISTINCT contact_id::text) AS ids
    FROM contact_identifiers
    WHERE kind = 'phone'
    GROUP BY value
    HAVING count(DISTINCT contact_id) > 1
  `);
  const domainRows = await db.execute(sql`
    SELECT split_part(lower(value), '@', 2) AS value, array_agg(DISTINCT contact_id::text) AS ids
    FROM contact_identifiers
    WHERE kind = 'email' AND position('@' in value) > 0
    GROUP BY 1
    HAVING count(DISTINCT contact_id) > 1
  `);
  const suggestions: Array<{ kind: 'email' | 'phone' | 'domain'; value: string; contactIds: string[] }> = [];
  const push = (kind: 'email' | 'phone' | 'domain', rows: unknown) => {
    const list = rows as Array<{ value: string; ids: string[] }>;
    for (const row of list) {
      if (kind === 'domain' && FREE_EMAIL_DOMAINS.has(row.value)) continue;
      const contactIds = (row.ids ?? []).filter((id) => !merged.has(id));
      if (contactIds.length > 1) suggestions.push({ kind, value: row.value, contactIds });
    }
  };
  push('email', emailRows);
  push('phone', phoneRows);
  push('domain', domainRows);
  return suggestions;
}

export async function mergeContacts(input: {
  winnerId: string;
  loserId: string;
  explicit: boolean;
  actor: string;
}): Promise<void> {
  const decision = mergeAllowed(input.explicit, input.actor);
  if (!decision.ok) throw new Error(decision.error);
  if (input.winnerId === input.loserId) throw new Error('A contact cannot be merged with itself.');
  await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const [already] = await executor.select().from(contactMerges).where(eq(contactMerges.loserId, input.loserId)).limit(1);
    if (already) throw new Error('That contact was already merged.');
    await executor.update(contactMerges).set({ winnerId: input.winnerId }).where(eq(contactMerges.winnerId, input.loserId));
    await executor.insert(contactMerges).values({
      organizationId: CRM_ORGANIZATION_ID,
      winnerId: input.winnerId,
      loserId: input.loserId,
      actor: input.actor,
    });
    await executor.update(contacts).set({ status: 'merged', updatedAt: new Date() }).where(eq(contacts.id, input.loserId));
    await executor.insert(auditEvents).values({
      organizationId: CRM_ORGANIZATION_ID,
      actorType: 'user',
      actorId: input.actor,
      action: 'contact.merged',
      entityType: 'contact',
      entityId: input.winnerId,
      metadata: { loserId: input.loserId },
    });
    await insertTimelineEvent(executor, {
      contactId: input.winnerId,
      channel: 'internal',
      direction: 'internal',
      actorType: 'operator',
      actorName: input.actor,
      eventKind: 'merge',
      bodyText: `Merged contact ${input.loserId} into this record. Both timelines are kept.`,
      provider: 'crm',
      providerMessageId: `merge:${input.loserId}`,
    });
  });
}

export async function listUnmatched() {
  return db.select().from(inboundUnmatched)
    .where(eq(inboundUnmatched.status, 'unmatched'))
    .orderBy(desc(inboundUnmatched.receivedAt));
}

export async function attachUnmatched(input: { unmatchedId: string; contactId: string; actor: string }): Promise<string> {
  if (input.actor !== OPERATOR_ACTOR) throw new Error('Only Matthew can attach unmatched mail.');
  return db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const [row] = await executor.select().from(inboundUnmatched).where(eq(inboundUnmatched.id, input.unmatchedId)).limit(1);
    if (!row) throw new Error('Unmatched message not found.');
    if (row.status === 'attached') throw new Error('That message is already attached.');
    const timeline = await insertTimelineEvent(executor, {
      contactId: input.contactId,
      channel: row.channel,
      direction: 'inbound',
      actorType: 'operator',
      actorName: input.actor,
      eventKind: 'reply',
      subject: row.subject,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      emailMessageId: row.emailMessageId,
      inReplyTo: row.inReplyTo,
      referencesHeader: row.referencesHeader,
      provider: 'resend',
      providerMessageId: row.providerMessageId ? `attached:${row.providerMessageId}` : `attached:${row.id}`,
      attachments: row.attachments ?? [],
    });
    await executor.update(inboundUnmatched).set({
      status: 'attached',
      attachedContactId: input.contactId,
    }).where(eq(inboundUnmatched.id, row.id));
    return timeline.id;
  });
}

export interface NewsroomImportResult {
  dryRun: boolean;
  parsed: number;
  wouldCreate: number;
  wouldSkip: number;
  created: number;
  skipped: number;
  rows: Array<{ name: string; action: 'create' | 'skip'; reason?: string }>;
}

async function newsroomMatch(executor: CrmDb, row: NewsroomRow): Promise<string | null> {
  if (row.email) {
    const ids = await findContactIdsByDestination(executor, row.email);
    if (ids[0]) return ids[0];
  }
  if (row.tipEmail && row.tipEmail.includes('@')) {
    const ids = await findContactIdsByDestination(executor, row.tipEmail);
    if (ids[0]) return ids[0];
  }
  const [byName] = await executor.select({ id: contacts.id }).from(contacts).where(sql`
    lower(${contacts.organizationName}) = ${row.name.toLowerCase()}
    AND ${contacts.organizationId} = ${CRM_ORGANIZATION_ID}
  `).limit(1);
  return byName?.id ?? null;
}

export async function importNewsroomCsv(csv: string, options: { dryRun: boolean }): Promise<NewsroomImportResult> {
  const parsed = parseNewsroomCsv(csv);
  const preview: NewsroomImportResult['rows'] = [];
  let wouldCreate = 0;
  let wouldSkip = 0;
  const plan: Array<{ row: NewsroomRow; action: 'create' | 'skip' }> = [];
  for (const row of parsed) {
    const existing = await newsroomMatch(db, row);
    if (existing) {
      wouldSkip += 1;
      plan.push({ row, action: 'skip' });
      preview.push({ name: row.name, action: 'skip', reason: 'existing contact' });
    } else {
      wouldCreate += 1;
      plan.push({ row, action: 'create' });
      preview.push({ name: row.name, action: 'create' });
    }
  }
  if (options.dryRun) {
    return { dryRun: true, parsed: parsed.length, wouldCreate, wouldSkip, created: 0, skipped: 0, rows: preview };
  }
  let created = 0;
  let skipped = 0;
  for (const item of plan) {
    if (item.action === 'skip') {
      skipped += 1;
      continue;
    }
    const row = item.row;
    await db.transaction(async (tx) => {
      const executor = asExecutor(tx);
      const again = await newsroomMatch(executor, row);
      if (again) return;
      const phone = row.phone ? normalizePhone(row.phone) : null;
      const [contact] = await executor.insert(contacts).values({
        organizationId: CRM_ORGANIZATION_ID,
        organizationName: row.name,
        email: row.email,
        phoneE164: phone,
        website: row.website,
        city: row.city,
        state: row.state,
        notes: row.notes,
        tags: row.tags,
        source: 'newsroom-directory',
        status: 'active',
      }).returning({ id: contacts.id });
      if (!contact) return;
      if (row.email) await addIdentifier(executor, contact.id, 'email', row.email);
      if (row.tipEmail?.includes('@') && row.tipEmail !== row.email) {
        await addIdentifier(executor, contact.id, 'email', row.tipEmail);
      }
      if (phone) await addIdentifier(executor, contact.id, 'phone', phone);
      created += 1;
    });
  }
  return { dryRun: false, parsed: parsed.length, wouldCreate, wouldSkip, created, skipped, rows: preview };
}

export function contactsToCsv(rows: Array<typeof contacts.$inferSelect>): string {
  const headers = ['name', 'organization', 'email', 'phone', 'city', 'state', 'tags', 'do_not_contact', 'owner_bot', 'last_contacted_at', 'last_reply_at'];
  const body = rows.map((row) => [
    [row.firstName, row.lastName].filter(Boolean).join(' '),
    row.organizationName ?? '',
    row.email ?? '',
    row.phoneE164 ?? '',
    row.city ?? '',
    row.state ?? '',
    (row.tags ?? []).join('|'),
    row.doNotContact ? 'true' : 'false',
    row.ownerBot ?? '',
    row.lastContactedAt ? row.lastContactedAt.toISOString() : '',
    row.lastReplyAt ? row.lastReplyAt.toISOString() : '',
  ]);
  return toCsv(headers, body);
}

export async function legacyLinkExists(sourceTable: string, sourceId: string): Promise<boolean> {
  const [row] = await db.select().from(crmLegacyLinks).where(and(
    eq(crmLegacyLinks.sourceTable, sourceTable),
    eq(crmLegacyLinks.sourceId, sourceId),
  )).limit(1);
  return Boolean(row);
}

export { CRM_ORGANIZATION_ID, SendBlockedError };

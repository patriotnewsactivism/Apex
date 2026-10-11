/**
 * CRM phase 3: how warm is this contact, and why.
 *
 * The score is arithmetic over the records the contact book already holds, not
 * a model's opinion, so it can be read, argued with, and reproduced. Every point
 * carries the reason that awarded it. Nothing is stored: a score cannot drift
 * from the history it is derived from.
 *
 * A contact who is on do-not-contact scores zero whatever else is true, because
 * the next thing to do about them is nothing.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  companies,
  contactIdentifiers,
  contactTimeline,
  contacts,
  crmTasks,
  db,
  researchedLeads,
  salesOpportunities,
} from '@workspace/db';
import { CRM_ORGANIZATION_ID, chicagoDayBounds, scoreContact, type ContactScore } from './pure.js';

function daysSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}

export interface ScoredContact {
  contactId: string;
  score: ContactScore;
}

interface TimelineStatRow {
  contactId: string | null;
  outboundTouches: number;
  replies: number;
  lastOutboundAt: Date | null;
  lastReplyAt: Date | null;
}

/**
 * Score specific contacts. One pass per fact over the ids asked for, then the
 * arithmetic, so scoring a page of 50 contacts costs five queries, not 250.
 */
export async function scoreContacts(contactIds: string[]): Promise<Map<string, ContactScore>> {
  const ids = [...new Set(contactIds.filter(Boolean))];
  const result = new Map<string, ContactScore>();
  if (ids.length === 0) return result;

  const bounds = chicagoDayBounds();
  const contactRows = await db
    .select({
      id: contacts.id,
      doNotContact: contacts.doNotContact,
      lifecycleStage: contacts.lifecycleStage,
      email: contacts.email,
      phoneE164: contacts.phoneE164,
      website: contacts.website,
      metadata: contacts.metadata,
      lastName: contacts.lastName,
      organizationName: contacts.organizationName,
      firstName: contacts.firstName,
      companyIndustry: companies.industry,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(inArray(contacts.id, ids));

  const verified = await db
    .select({ contactId: contactIdentifiers.contactId })
    .from(contactIdentifiers)
    .where(and(inArray(contactIdentifiers.contactId, ids), eq(contactIdentifiers.verified, true)));
  const verifiedIds = new Set(verified.map((row) => row.contactId));

  const timelineStats = await db
    .select({
      contactId: contactTimeline.contactId,
      outboundTouches: sql<number>`count(*) FILTER (WHERE ${contactTimeline.direction} = 'outbound')`,
      replies: sql<number>`count(*) FILTER (WHERE ${contactTimeline.direction} = 'inbound' AND ${contactTimeline.eventKind} IN ('reply', 'message'))`,
      lastOutboundAt: sql<Date | null>`max(${contactTimeline.occurredAt}) FILTER (WHERE ${contactTimeline.direction} = 'outbound')`,
      lastReplyAt: sql<Date | null>`max(${contactTimeline.occurredAt}) FILTER (WHERE ${contactTimeline.direction} = 'inbound' AND ${contactTimeline.eventKind} IN ('reply', 'message'))`,
    })
    .from(contactTimeline)
    .where(inArray(contactTimeline.contactId, ids))
    .groupBy(contactTimeline.contactId);
  const timelineByContact = new Map<string, TimelineStatRow>(
    timelineStats.map((row) => [row.contactId ?? '', row as TimelineStatRow]),
  );

  const dealRows = await db
    .select({
      contactId: salesOpportunities.contactId,
      openDeals: sql<number>`count(*)`,
      openValue: sql<string | null>`coalesce(sum(${salesOpportunities.amountCents}), 0)`,
    })
    .from(salesOpportunities)
    .where(and(
      inArray(salesOpportunities.contactId, ids),
      sql`${salesOpportunities.status} NOT IN ('won', 'lost')`,
    ))
    .groupBy(salesOpportunities.contactId);
  const dealsByContact = new Map(dealRows.map((row) => [row.contactId ?? '', row]));

  const taskRows = await db
    .select({ contactId: crmTasks.contactId })
    .from(crmTasks)
    .where(and(
      inArray(crmTasks.contactId, ids),
      eq(crmTasks.status, 'open'),
      sql`${crmTasks.dueAt} IS NOT NULL AND ${crmTasks.dueAt} < ${bounds.end}`,
    ));
  const dueTodayIds = new Set(taskRows.map((row) => row.contactId ?? ''));

  const leadIds = contactRows
    .map((row) => (row.metadata as { researchedLeadId?: string } | null)?.researchedLeadId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const leadScores = leadIds.length
    ? await db
        .select({ id: researchedLeads.id, score: researchedLeads.qualificationScore })
        .from(researchedLeads)
        .where(inArray(researchedLeads.id, leadIds))
    : [];
  const leadScoreById = new Map(leadScores.map((row) => [row.id, row.score]));

  for (const contact of contactRows) {
    const timeline = timelineByContact.get(contact.id);
    const deals = dealsByContact.get(contact.id);
    const researchId = (contact.metadata as { researchedLeadId?: string } | null)?.researchedLeadId;
    result.set(contact.id, scoreContact({
      doNotContact: Boolean(contact.doNotContact),
      lifecycleStage: contact.lifecycleStage ?? 'prospect',
      hasEmail: Boolean(contact.email),
      hasPhone: Boolean(contact.phoneE164),
      hasWebsite: Boolean(contact.website),
      verifiedIdentifier: verifiedIds.has(contact.id),
      replies: Number(timeline?.replies ?? 0),
      daysSinceLastReply: daysSince(timeline?.lastReplyAt ? new Date(timeline.lastReplyAt) : null),
      outboundTouches: Number(timeline?.outboundTouches ?? 0),
      daysSinceLastContact: daysSince(timeline?.lastOutboundAt ? new Date(timeline.lastOutboundAt) : null),
      openDeals: Number(deals?.openDeals ?? 0),
      openDealValueUsd: Number(deals?.openValue ?? 0) / 100,
      followUpDueToday: dueTodayIds.has(contact.id),
      industry: contact.companyIndustry ?? null,
      leadQualificationScore: researchId ? leadScoreById.get(researchId) ?? null : null,
    }));
  }
  return result;
}

/** The best contacts to work next, highest score first. */
export async function topScoredContacts(input: { limit?: number; minScore?: number } = {}): Promise<Array<ScoredContact & {
  name: string;
  organizationName: string | null;
  lifecycleStage: string;
  email: string | null;
  phoneE164: string | null;
  nextFollowUpAt: Date | null;
}>> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      organizationName: contacts.organizationName,
      lifecycleStage: contacts.lifecycleStage,
      email: contacts.email,
      phoneE164: contacts.phoneE164,
      nextFollowUpAt: contacts.nextFollowUpAt,
    })
    .from(contacts)
    .where(and(
      eq(contacts.organizationId, CRM_ORGANIZATION_ID),
      sql`${contacts.status} <> 'merged'`,
      eq(contacts.doNotContact, false),
      or(isNull(contacts.lifecycleStage), sql`${contacts.lifecycleStage} <> 'churned'`),
    ))
    .orderBy(desc(contacts.updatedAt))
    .limit(500);
  const scores = await scoreContacts(rows.map((row) => row.id));
  const scored = rows
    .map((row) => ({
      contactId: row.id,
      name: [row.firstName, row.lastName].filter(Boolean).join(' ') || row.organizationName || row.email || 'Unnamed contact',
      organizationName: row.organizationName,
      lifecycleStage: row.lifecycleStage ?? 'prospect',
      email: row.email,
      phoneE164: row.phoneE164,
      nextFollowUpAt: row.nextFollowUpAt,
      score: scores.get(row.id) ?? { score: 0, band: 'cold' as const, reasons: [] },
    }))
    .filter((row) => row.score.score >= (input.minScore ?? 0))
    .sort((a, b) => b.score.score - a.score.score);
  return scored.slice(0, limit);
}

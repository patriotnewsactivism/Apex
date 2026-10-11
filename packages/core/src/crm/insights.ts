/**
 * CRM phase 3: the one-paragraph read on a contact, and the next step.
 *
 * The paragraph is written by a model from that contact's own history — nothing
 * else is fed to it. It is cached with the model that wrote it and the number of
 * history rows it saw, so a later, larger count marks it stale instead of
 * letting it quietly age. If no model capacity is available the call throws:
 * a summary nobody generated must not look like one that was.
 *
 * Reading a cached insight is open to the dashboard; generating one costs a
 * model call, so the route that generates it requires the operator session, and
 * an agent tool never reaches it.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  companies,
  contactTimeline,
  contacts,
  crmContactInsights,
  crmTasks,
  db,
  salesOpportunities,
} from '@workspace/db';
import { CRM_ORGANIZATION_ID, OPERATOR_ACTOR } from './pure.js';
import { CrmWriteError } from './operator.js';

const MAX_HISTORY_ROWS = 40;
const MAX_SUMMARY_CHARS = 1200;
const MAX_NEXT_STEP_CHARS = 400;

export interface ContactInsight {
  summary: string;
  nextStep: string;
  model: string | null;
  sourceEvents: number;
  generatedAt: Date;
  generatedBy: string;
  /** True when history has been written since this insight was generated. */
  stale: boolean;
  currentEvents: number;
}

export interface ContactHistoryDigest {
  contactId: string;
  name: string;
  organizationName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  lifecycleStage: string;
  doNotContact: boolean;
  source: string | null;
  notes: string | null;
  lastContactedAt: Date | null;
  lastReplyAt: Date | null;
  nextFollowUpAt: Date | null;
  openTasks: Array<{ title: string; dueAt: Date | null }>;
  deals: Array<{ name: string; status: string; amountUsd: number; nextStep: string | null }>;
  events: Array<{ occurredAt: Date; channel: string; direction: string; actor: string; kind: string; text: string | null }>;
  totalEvents: number;
}

async function countEvents(contactId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(contactTimeline)
    .where(eq(contactTimeline.contactId, contactId));
  return Number(row?.n ?? 0);
}

/** Everything the model is allowed to see about this contact, and nothing else. */
export async function contactHistoryDigest(contactId: string): Promise<ContactHistoryDigest> {
  const [contact] = await db
    .select({
      contact: contacts,
      industry: companies.industry,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!contact) throw new CrmWriteError('Contact not found');

  const events = await db
    .select({
      occurredAt: contactTimeline.occurredAt,
      channel: contactTimeline.channel,
      direction: contactTimeline.direction,
      actor: contactTimeline.actorName,
      kind: contactTimeline.eventKind,
      text: contactTimeline.bodyText,
      subject: contactTimeline.subject,
    })
    .from(contactTimeline)
    .where(eq(contactTimeline.contactId, contactId))
    .orderBy(desc(contactTimeline.occurredAt))
    .limit(MAX_HISTORY_ROWS);

  const deals = await db
    .select({
      name: salesOpportunities.name,
      status: salesOpportunities.status,
      amountCents: salesOpportunities.amountCents,
      nextStep: salesOpportunities.nextStep,
    })
    .from(salesOpportunities)
    .where(eq(salesOpportunities.contactId, contactId))
    .orderBy(desc(salesOpportunities.updatedAt))
    .limit(20);

  const tasks = await db
    .select({ title: crmTasks.title, dueAt: crmTasks.dueAt })
    .from(crmTasks)
    .where(and(eq(crmTasks.contactId, contactId), eq(crmTasks.status, 'open')))
    .orderBy(desc(crmTasks.dueAt))
    .limit(10);

  const c = contact.contact;
  return {
    contactId,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.organizationName || 'Unnamed contact',
    organizationName: c.organizationName,
    title: c.title,
    email: c.email,
    phone: c.phoneE164,
    city: c.city,
    state: c.state,
    industry: contact.industry ?? null,
    lifecycleStage: c.lifecycleStage ?? 'prospect',
    doNotContact: Boolean(c.doNotContact),
    source: c.source,
    notes: c.notes,
    lastContactedAt: c.lastContactedAt,
    lastReplyAt: c.lastReplyAt,
    nextFollowUpAt: c.nextFollowUpAt,
    openTasks: tasks,
    deals: deals.map((deal) => ({
      name: deal.name,
      status: deal.status,
      amountUsd: Number(deal.amountCents ?? 0) / 100,
      nextStep: deal.nextStep,
    })),
    events: events.map((event) => ({
      occurredAt: event.occurredAt,
      channel: event.channel,
      direction: event.direction,
      actor: event.actor,
      kind: event.kind,
      text: (event.text ?? event.subject ?? '').slice(0, 400),
    })),
    totalEvents: await countEvents(contactId),
  };
}

/** The prompt is the digest, in a stable shape, so a change in output is a change in history. */
export function buildInsightPrompt(digest: ContactHistoryDigest): string {
  const lines: string[] = [];
  lines.push('CONTACT');
  lines.push(`name: ${digest.name}`);
  if (digest.organizationName) lines.push(`organization: ${digest.organizationName}`);
  if (digest.title) lines.push(`title: ${digest.title}`);
  if (digest.industry) lines.push(`industry: ${digest.industry}`);
  if (digest.city || digest.state) lines.push(`location: ${[digest.city, digest.state].filter(Boolean).join(', ')}`);
  lines.push(`client status: ${digest.lifecycleStage}`);
  lines.push(`do not contact: ${digest.doNotContact ? 'yes' : 'no'}`);
  if (digest.source) lines.push(`added from: ${digest.source}`);
  lines.push(`last contacted: ${digest.lastContactedAt ? digest.lastContactedAt.toISOString() : 'never'}`);
  lines.push(`last reply: ${digest.lastReplyAt ? digest.lastReplyAt.toISOString() : 'never'}`);
  if (digest.nextFollowUpAt) lines.push(`next follow-up: ${digest.nextFollowUpAt.toISOString()}`);
  if (digest.notes) lines.push(`notes: ${digest.notes.slice(0, 600)}`);
  if (digest.deals.length > 0) {
    lines.push('');
    lines.push('DEALS');
    for (const deal of digest.deals) {
      lines.push(`- ${deal.name} [${deal.status}] $${Math.round(deal.amountUsd)}${deal.nextStep ? ` — next: ${deal.nextStep}` : ''}`);
    }
  }
  if (digest.openTasks.length > 0) {
    lines.push('');
    lines.push('OPEN FOLLOW-UPS');
    for (const task of digest.openTasks) {
      lines.push(`- ${task.title}${task.dueAt ? ` (due ${task.dueAt.toISOString()})` : ''}`);
    }
  }
  lines.push('');
  lines.push(`HISTORY (${digest.events.length} of ${digest.totalEvents} rows, newest first)`);
  if (digest.events.length === 0) lines.push('- nothing recorded yet');
  for (const event of digest.events) {
    lines.push(`- ${event.occurredAt.toISOString()} ${event.direction} ${event.channel} ${event.kind} by ${event.actor}: ${event.text ?? ''}`);
  }
  return lines.join('\n');
}

export const INSIGHT_SYSTEM_PROMPT = [
  'You keep the contact book for one operator who runs a small newsroom and a small software business.',
  'You are given one contact and that contact\'s own history. Use only what is in the record.',
  'Never invent a fact, a name, a date, a number, or an intention that is not in the record.',
  'If the record is thin, say so plainly.',
  'Answer with JSON only, no prose around it, in this exact shape:',
  '{"summary": "one paragraph, four sentences at most, on where this stands", "next_step": "one concrete next action"}',
].join(' ');

export interface InsightCompletion {
  content: string;
  model?: string;
}

/** Split out so verify-crm can exercise the parsing without a model call. */
export function parseInsightResponse(content: string): { summary: string; nextStep: string } {
  const trimmed = content.trim();
  const json = trimmed.startsWith('{') ? trimmed : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CrmWriteError('The model did not answer in the expected shape; nothing was saved.');
  }
  const record = parsed as { summary?: unknown; next_step?: unknown; nextStep?: unknown };
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  const nextRaw = typeof record.next_step === 'string' ? record.next_step : typeof record.nextStep === 'string' ? record.nextStep : '';
  const nextStep = nextRaw.trim();
  if (!summary || !nextStep) throw new CrmWriteError('The model answered without both a summary and a next step; nothing was saved.');
  return {
    summary: summary.slice(0, MAX_SUMMARY_CHARS),
    nextStep: nextStep.slice(0, MAX_NEXT_STEP_CHARS),
  };
}

export async function readInsight(contactId: string): Promise<ContactInsight | null> {
  const [row] = await db
    .select()
    .from(crmContactInsights)
    .where(eq(crmContactInsights.contactId, contactId))
    .limit(1);
  if (!row) return null;
  const currentEvents = await countEvents(contactId);
  return {
    summary: row.summary,
    nextStep: row.nextStep,
    model: row.model,
    sourceEvents: row.sourceEvents,
    generatedAt: row.generatedAt,
    generatedBy: row.generatedBy,
    stale: currentEvents > row.sourceEvents,
    currentEvents,
  };
}

export type InsightCompleter = (prompt: string) => Promise<InsightCompletion>;

/**
 * Generate and cache the insight. The completer is injected: the route passes
 * the real model client, and the verification passes a stub, so the shape of
 * what gets stored is testable without spending a model call.
 */
export async function generateContactInsight(input: {
  contactId: string;
  actor: string;
  complete: InsightCompleter;
}): Promise<ContactInsight> {
  if (input.actor !== OPERATOR_ACTOR) {
    throw new CrmWriteError('Only Matthew can generate a contact summary.');
  }
  const digest = await contactHistoryDigest(input.contactId);
  const response = await input.complete(`${INSIGHT_SYSTEM_PROMPT}\n\n${buildInsightPrompt(digest)}`);
  const { summary, nextStep } = parseInsightResponse(response.content);
  const at = new Date();
  await db
    .insert(crmContactInsights)
    .values({
      organizationId: CRM_ORGANIZATION_ID,
      contactId: input.contactId,
      summary,
      nextStep,
      model: response.model ?? null,
      sourceEvents: digest.totalEvents,
      generatedAt: at,
      generatedBy: input.actor,
    })
    .onConflictDoUpdate({
      target: crmContactInsights.contactId,
      set: {
        summary,
        nextStep,
        model: response.model ?? null,
        sourceEvents: digest.totalEvents,
        generatedAt: at,
        generatedBy: input.actor,
      },
    });
  return {
    summary,
    nextStep,
    model: response.model ?? null,
    sourceEvents: digest.totalEvents,
    generatedAt: at,
    generatedBy: input.actor,
    stale: false,
    currentEvents: digest.totalEvents,
  };
}

/**
 * The real model call. Capacity is checked first: without it the caller gets a
 * refusal, not an empty summary.
 */
export async function completeWithModel(prompt: string): Promise<InsightCompletion> {
  const { createLLMClient, getDefaultLLMConfig, llmCapacityAvailableNow } = await import('../llm-client.js');
  if (!llmCapacityAvailableNow()) {
    throw new CrmWriteError('No model capacity available right now; the summary was not generated.');
  }
  const client = createLLMClient(getDefaultLLMConfig('SALES'));
  const response = await client.complete([{ role: 'user', content: prompt }]);
  return { content: response.content, model: response.model };
}

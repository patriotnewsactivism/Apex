// ─── Autonomous Revenue Workforce Loop ──────────────────────────────────────
//
// This module is the durable handoff between a qualified prospect and the
// channel-specific tools. It deliberately prepares and records outbound work;
// the actual email/SMS/call still goes through APEX's existing approval gates.

import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import {
  campaigns,
  campaignEnrollments,
  companies,
  contacts,
  interactions,
  outreachStrategies,
  sequenceStepExecutions,
  sequenceSteps,
  sequences,
  db,
} from '@workspace/db';

export interface StrategyDraft {
  objective: string;
  painHypothesis: string;
  valueProposition: string;
  openingAngle: string;
  channelOrder: string[];
  personalization: Record<string, unknown>;
  qualificationCriteria: string[];
  nextBestAction: string;
  confidence: number;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function metadataText(metadata: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = text(metadata?.[key]);
    if (value) return value;
  }
  return null;
}

/**
 * Build a useful strategy without requiring an LLM call. An LLM may improve
 * this later, but the revenue loop must keep moving when model capacity is
 * paused or exhausted.
 */
export function buildStrategyDraft(input: {
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  email?: string | null;
  phoneE164?: string | null;
  companyName?: string | null;
  industry?: string | null;
  city?: string | null;
  contactMetadata?: Record<string, unknown> | null;
  companyMetadata?: Record<string, unknown> | null;
  channelOrder?: string[];
}): StrategyDraft {
  const contactMetadata = input.contactMetadata ?? {};
  const companyMetadata = input.companyMetadata ?? {};
  const company = text(input.companyName) ?? 'this company';
  const industry = text(input.industry) ?? 'business';
  const city = text(input.city) ?? null;
  const role = text(input.title) ?? 'the decision maker';
  const fitReason = metadataText(contactMetadata, 'fitReason', 'fit_reason') ??
    metadataText(companyMetadata, 'fitReason', 'fit_reason');
  const suppliedAngle = metadataText(contactMetadata, 'outreachAngle', 'outreach_angle') ??
    metadataText(companyMetadata, 'outreachAngle', 'outreach_angle');
  const location = city ? ` in ${city}` : '';
  const firstName = text(input.firstName);

  const painHypothesis = fitReason ??
    `${company} may be losing qualified demand when inbound questions arrive outside the team's fastest response window.`;
  const openingAngle = suppliedAngle ??
    `Ask ${firstName ?? role} how ${company} handles new ${industry} inquiries after hours and during busy periods.`;

  return {
    objective: `Earn a qualified conversation with ${company}${location} about improving speed-to-lead.`,
    painHypothesis,
    valueProposition:
      `APEX can research the opportunity, coordinate a tailored first touch, and help ${company} respond, qualify, and book without adding another disconnected system.`,
    openingAngle,
    channelOrder: input.channelOrder?.length ? input.channelOrder : ['email', 'phone', 'sms', 'task'],
    personalization: {
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      title: input.title ?? null,
      companyName: input.companyName ?? null,
      industry: input.industry ?? null,
      city,
      email: input.email ?? null,
      phoneE164: input.phoneE164 ?? null,
      fitReason: fitReason ?? null,
      outreachAngle: suppliedAngle ?? null,
    },
    qualificationCriteria: [
      'Has a measurable lead-response, follow-up, or missed-opportunity problem',
      'Can identify an owner for the workflow',
      'Willing to review a live example or test interaction',
    ],
    nextBestAction: `Prepare a ${input.channelOrder?.[0] ?? 'email'} touch using the opening angle, then wait for a response before escalating channels.`,
    confidence: fitReason || suppliedAngle ? 0.78 : 0.55,
  };
}

export function renderRevenueTemplate(template: string, strategy: Pick<typeof outreachStrategies.$inferSelect, 'personalization' | 'openingAngle' | 'painHypothesis' | 'valueProposition'>): string {
  const values: Record<string, string> = {
    ...Object.fromEntries(Object.entries(strategy.personalization).map(([key, value]) => [key, value == null ? '' : String(value)])),
    openingAngle: strategy.openingAngle,
    painHypothesis: strategy.painHypothesis,
    valueProposition: strategy.valueProposition,
  };
  return template.replace(/{{\s*([A-Za-z0-9_]+)\s*}}/g, (_match, key: string) => values[key] ?? '');
}

export async function ensureStrategyForEnrollment(input: {
  organizationId: string;
  enrollmentId: string;
}): Promise<typeof outreachStrategies.$inferSelect> {
  const [enrollment] = await db
    .select({
      enrollmentId: campaignEnrollments.id,
      campaignId: campaignEnrollments.campaignId,
      contactId: campaignEnrollments.contactId,
      campaignName: campaigns.name,
    })
    .from(campaignEnrollments)
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .where(and(
      eq(campaignEnrollments.id, input.enrollmentId),
      eq(campaignEnrollments.organizationId, input.organizationId),
    ))
    .limit(1);

  if (!enrollment) throw new Error(`Enrollment ${input.enrollmentId} not found`);

  const [existing] = await db
    .select()
    .from(outreachStrategies)
    .where(and(
      eq(outreachStrategies.organizationId, input.organizationId),
      eq(outreachStrategies.campaignId, enrollment.campaignId),
      eq(outreachStrategies.contactId, enrollment.contactId),
    ))
    .limit(1);
  if (existing) return existing;

  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(
      eq(contacts.id, enrollment.contactId),
      eq(contacts.organizationId, input.organizationId),
    ))
    .limit(1);
  if (!contact) throw new Error(`Contact ${enrollment.contactId} not found`);

  const company = contact.companyId
    ? (await db.select().from(companies).where(eq(companies.id, contact.companyId)).limit(1))[0]
    : undefined;
  const channelOrder = await getCampaignChannelOrder(enrollment.campaignId);
  const draft = buildStrategyDraft({
    firstName: contact.firstName,
    lastName: contact.lastName,
    title: contact.title,
    email: contact.email,
    phoneE164: contact.phoneE164,
    companyName: company?.name,
    industry: company?.industry,
    city: readCity(contact.location),
    contactMetadata: contact.metadata,
    companyMetadata: company?.metadata,
    channelOrder,
  });
  const now = new Date();

  await db.insert(outreachStrategies).values({
    id: randomUUID(),
    organizationId: input.organizationId,
    campaignId: enrollment.campaignId,
    contactId: enrollment.contactId,
    enrollmentId: enrollment.enrollmentId,
    version: 1,
    status: 'ready',
    ...draft,
    source: 'deterministic',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  const [created] = await db
    .select()
    .from(outreachStrategies)
    .where(and(
      eq(outreachStrategies.organizationId, input.organizationId),
      eq(outreachStrategies.campaignId, enrollment.campaignId),
      eq(outreachStrategies.contactId, enrollment.contactId),
    ))
    .limit(1);
  if (!created) throw new Error(`Could not create strategy for enrollment ${input.enrollmentId}`);
  return created;
}

function readCity(location: unknown): string | null {
  if (!location || typeof location !== 'object') return null;
  const record = location as Record<string, unknown>;
  return text(record.city) ?? text(record.locality) ?? text(record.town);
}

async function getCampaignChannelOrder(campaignId: string): Promise<string[]> {
  const rows = await db
    .select({ channel: sequenceSteps.channel, position: sequenceSteps.position })
    .from(sequences)
    .innerJoin(sequenceSteps, eq(sequenceSteps.sequenceId, sequences.id))
    .where(eq(sequences.campaignId, campaignId))
    .orderBy(asc(sequenceSteps.position));
  return [...new Set(rows.map((row) => row.channel))];
}

export async function queueDurableStepExecution(input: {
  organizationId: string;
  enrollmentId: string;
  stepId: string;
  scheduledAt: Date;
}): Promise<string> {
  const idempotencyKey = `${input.organizationId}:${input.enrollmentId}:${input.stepId}`;
  const [existing] = await db
    .select({ id: sequenceStepExecutions.id })
    .from(sequenceStepExecutions)
    .where(eq(sequenceStepExecutions.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing) return existing.id;

  const id = randomUUID();
  await db.insert(sequenceStepExecutions).values({
    id,
    organizationId: input.organizationId,
    enrollmentId: input.enrollmentId,
    stepId: input.stepId,
    idempotencyKey,
    status: 'queued',
    scheduledAt: input.scheduledAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();

  const [created] = await db
    .select({ id: sequenceStepExecutions.id })
    .from(sequenceStepExecutions)
    .where(eq(sequenceStepExecutions.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!created) throw new Error(`Could not queue step ${input.stepId}`);
  return created.id;
}

/** Queue the next unexecuted step for a live enrollment. This is safe to call
 * repeatedly from multiple workers because the execution ledger is unique per
 * enrollment and step.
 */
export async function queueNextRevenueWorkforceStep(input: {
  organizationId: string;
  enrollmentId: string;
  now?: Date;
}): Promise<{ queued: boolean; executionId?: string; stepId?: string; reason?: string }> {
  const now = input.now ?? new Date();
  const [enrollment] = await db.select().from(campaignEnrollments).where(and(
    eq(campaignEnrollments.id, input.enrollmentId),
    eq(campaignEnrollments.organizationId, input.organizationId),
    inArray(campaignEnrollments.status, ['pending', 'active']),
  )).limit(1);
  if (!enrollment) return { queued: false, reason: 'Enrollment is not queueable.' };

  await ensureStrategyForEnrollment(input);
  const [sequence] = await db.select({ id: sequences.id }).from(sequences)
    .where(eq(sequences.campaignId, enrollment.campaignId))
    .orderBy(asc(sequences.version)).limit(1);
  if (!sequence) return { queued: false, reason: 'Campaign has no sequence.' };

  const steps = await db.select().from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequence.id))
    .orderBy(asc(sequenceSteps.position));
  if (steps.length === 0) return { queued: false, reason: 'Sequence has no steps.' };

  const executions = await db.select({ stepId: sequenceStepExecutions.stepId, status: sequenceStepExecutions.status })
    .from(sequenceStepExecutions)
    .where(and(
      eq(sequenceStepExecutions.organizationId, input.organizationId),
      eq(sequenceStepExecutions.enrollmentId, enrollment.id),
    ));
  if (executions.some((execution) => ['queued', 'running', 'awaiting_approval'].includes(execution.status))) {
    return { queued: false, reason: 'Enrollment already has an outstanding step.' };
  }
  const executed = new Set(executions.filter((execution) => ['succeeded', 'skipped'].includes(execution.status)).map((execution) => execution.stepId));
  const nextStep = steps.find((step) => !executed.has(step.id));
  if (!nextStep) {
    await db.update(campaignEnrollments).set({ status: 'completed', completedAt: now, updatedAt: now })
      .where(eq(campaignEnrollments.id, enrollment.id));
    return { queued: false, reason: 'Enrollment completed.' };
  }

  const scheduledAt = new Date(now.getTime() + Math.max(0, nextStep.delaySeconds) * 1000);
  await db.update(campaignEnrollments).set({
    status: 'active',
    currentStepId: nextStep.id,
    nextActionAt: scheduledAt,
    startedAt: enrollment.startedAt ?? now,
    updatedAt: now,
  }).where(eq(campaignEnrollments.id, enrollment.id));
  const executionId = await queueDurableStepExecution({
    organizationId: input.organizationId,
    enrollmentId: enrollment.id,
    stepId: nextStep.id,
    scheduledAt,
  });
  return { queued: true, executionId, stepId: nextStep.id };
}

export async function markStepExecution(input: {
  organizationId: string;
  enrollmentId: string;
  stepId: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval';
  interactionId?: string;
  result?: Record<string, unknown>;
  error?: string;
}): Promise<void> {
  await db.update(sequenceStepExecutions).set({
    status: input.status,
    interactionId: input.interactionId,
    result: input.result,
    error: input.error ?? null,
    completedAt: input.status === 'awaiting_approval' ? null : new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(sequenceStepExecutions.organizationId, input.organizationId),
    eq(sequenceStepExecutions.enrollmentId, input.enrollmentId),
    eq(sequenceStepExecutions.stepId, input.stepId),
  ));
}

/**
 * Claims one due step and creates the relationship-timeline event that an
 * operator or an approved channel tool can act on. External steps stop at
 * awaiting_approval; internal task steps complete automatically.
 */
export async function prepareDueRevenueStep(input: {
  organizationId: string;
  enrollmentId: string;
  now?: Date;
}): Promise<{
  prepared: boolean;
  executionId?: string;
  approvalRequired?: boolean;
  channel?: string;
  interactionId?: string;
  strategyId?: string;
  reason?: string;
}> {
  const now = input.now ?? new Date();
  const [enrollment] = await db
    .select()
    .from(campaignEnrollments)
    .where(and(
      eq(campaignEnrollments.id, input.enrollmentId),
      eq(campaignEnrollments.organizationId, input.organizationId),
      inArray(campaignEnrollments.status, ['pending', 'active', 'waiting']),
    ))
    .limit(1);
  if (!enrollment) return { prepared: false, reason: 'Enrollment is not active.' };
  if (!enrollment.currentStepId) return { prepared: false, reason: 'Enrollment has no queued step.' };
  if (enrollment.nextActionAt && enrollment.nextActionAt > now) {
    return { prepared: false, reason: 'Step is not due yet.' };
  }

  const [step] = await db.select().from(sequenceSteps).where(eq(sequenceSteps.id, enrollment.currentStepId)).limit(1);
  if (!step) return { prepared: false, reason: 'Current sequence step no longer exists.' };
  const [execution] = await db.select().from(sequenceStepExecutions).where(and(
    eq(sequenceStepExecutions.organizationId, input.organizationId),
    eq(sequenceStepExecutions.enrollmentId, enrollment.id),
    eq(sequenceStepExecutions.stepId, step.id),
    eq(sequenceStepExecutions.status, 'queued'),
  )).limit(1);
  if (!execution) return { prepared: false, reason: 'Step is already claimed or was never queued.' };

  const [claimed] = await db.update(sequenceStepExecutions).set({
    status: 'running',
    attemptCount: execution.attemptCount + 1,
    startedAt: now,
    updatedAt: now,
  }).where(and(
    eq(sequenceStepExecutions.id, execution.id),
    eq(sequenceStepExecutions.status, 'queued'),
  )).returning();
  if (!claimed) return { prepared: false, reason: 'Another worker claimed the step.' };

  const strategy = await ensureStrategyForEnrollment(input);
  const channel = step.channel;
  const interactionId = randomUUID();
  const external = channel === 'email' || channel === 'phone' || channel === 'sms';
  const configuration = step.configuration ?? {};
  const previewTemplate = text(configuration.body) ?? text(configuration.message) ?? strategy.openingAngle;
  const preview = renderRevenueTemplate(previewTemplate, strategy);
  await db.insert(interactions).values({
    id: interactionId,
    organizationId: input.organizationId,
    campaignId: enrollment.campaignId,
    contactId: enrollment.contactId,
    channel: external ? channel : 'internal',
    direction: external ? 'outbound' : 'internal',
    type: external ? channel : 'task',
    status: external ? 'queued' : 'completed',
    subject: text(configuration.subject),
    bodySummary: preview,
    structuredOutcome: {
      executionId: claimed.id,
      strategyId: strategy.id,
      approvalRequired: external,
      channel,
      preview,
      configuration,
    },
    occurredAt: now,
    createdAt: now,
  });

  if (external) {
    await db.update(sequenceStepExecutions).set({
      status: 'awaiting_approval',
      interactionId,
      result: { strategyId: strategy.id, approvalRequired: true, channel, preview },
      updatedAt: new Date(),
    }).where(eq(sequenceStepExecutions.id, claimed.id));
    await db.update(campaignEnrollments).set({ status: 'waiting', updatedAt: new Date() })
      .where(eq(campaignEnrollments.id, enrollment.id));
  } else {
    await markStepExecution({
      organizationId: input.organizationId,
      enrollmentId: enrollment.id,
      stepId: step.id,
      status: 'succeeded',
      interactionId,
      result: { strategyId: strategy.id, channel },
    });
  }

  return {
    prepared: true,
    executionId: claimed.id,
    approvalRequired: external,
    channel,
    interactionId,
    strategyId: strategy.id,
  };
}

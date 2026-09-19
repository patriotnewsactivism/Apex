// ─── Revenue Operations Campaign Engine ─────────────────────────────────────────
//
// Campaign creation, contact enrollment, and sequence orchestration for
// revenue-ops missions. Each campaign links to a mission (goal) and contains
// one or more sequences. Contacts are enrolled with consent + suppression checks.
//
// Enrollment state machine:
//   pending → active → waiting → responded → qualified → booked → completed
//   (suppressed and disqualified are terminal terminal states)
//
// Pause-on-reply: when one enrollment receives a meaningful response, other
// enrollments in the same campaign with pending scheduled touches are paused
// until the response is classified.

import { db } from '@workspace/db';
import {
  campaigns,
  sequences,
  sequenceSteps,
  campaignEnrollments,
  contacts,
  interactions,
  calls,
  goals,
  suppressions,
  consentRecords,
  sequenceStepExecutions,
  meetings,
  meetingAttendees,
  salesOpportunities,
} from '@workspace/db';
import {
  eq,
  and,
  or,
  sql,
  inArray,
  isNull,
  not,
} from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { ToolDefinition } from '../types.js';
import { z } from 'zod';
import {
  ensureStrategyForEnrollment,
  markStepExecution,
  prepareDueRevenueStep,
  queueDurableStepExecution,
} from './workforce-loop.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  organizationId: string;
  missionId: string; // goals.id — the mission this campaign serves
  name: string;
  description?: string;
  sequenceConfigs: SequenceConfig[];
  audienceFilter?: Record<string, unknown>;
  dailyLimits?: Record<string, number>;
}

export interface SequenceConfig {
  name: string;
  steps: StepConfig[];
}

export interface StepConfig {
  channel: 'email' | 'phone' | 'sms' | 'task';
  delaySeconds: number;
  configuration?: Record<string, unknown>;
  templateId?: string;
}

export interface EnrollContactsInput {
  organizationId: string;
  campaignId: string;
  contactIds: string[];
}

export interface EnrollmentResult {
  enrolled: string[];   // enrollment IDs that were newly created
  skipped: Array<{ contactId: string; reason: string }>;
  alreadyEnrolled: string[]; // enrollment IDs that already existed
}

export interface QueueNextStepInput {
  organizationId: string;
  enrollmentId: string;
}

export interface AdvanceEnrollmentInput {
  organizationId: string;
  enrollmentId: string;
  outcome: 'interested' | 'not_interested' | 'no_answer' | 'busy' | 'voicemail' | 'booked' | 'callback' | 'disqualified' | 'responded';
  interactionId?: string;
  callId?: string;
  meetingStartsAt?: string;
  meetingEndsAt?: string;
  meetingUrl?: string;
  amountCents?: number;
}

// ─── Campaign creation ──────────────────────────────────────────────────────────

export async function createCampaign(input: CreateCampaignInput): Promise<string> {
  const now = new Date();
  const id = randomUUID();

  await db.insert(campaigns).values({
    id,
    organizationId: input.organizationId,
    missionId: input.missionId,
    name: input.name,
    description: input.description ?? null,
    status: 'draft',
    audienceFilter: input.audienceFilter ?? null,
    dailyLimits: input.dailyLimits ?? {},
    settings: {},
    createdAt: now,
    updatedAt: now,
  });

  // Create sequences for each config
  for (const seqConfig of input.sequenceConfigs) {
    const sequenceId = randomUUID();
    await db.insert(sequences).values({
      id: sequenceId,
      campaignId: id,
      name: seqConfig.name,
      version: 1,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });

    // Create steps for each sequence
    for (let i = 0; i < seqConfig.steps.length; i++) {
      const step = seqConfig.steps[i];
      await db.insert(sequenceSteps).values({
        id: randomUUID(),
        sequenceId,
        position: i + 1,
        channel: step.channel,
        delaySeconds: step.delaySeconds,
        condition: step.configuration?.['condition'] ?? null,
        templateId: step.templateId ?? null,
        configuration: step.configuration ?? {},
        createdAt: now,
      });
    }
  }

  return id;
}

// ─── Contact enrollment ─────────────────────────────────────────────────────────

export async function enrollContacts(input: EnrollContactsInput): Promise<EnrollmentResult> {
  const result: EnrollmentResult = {
    enrolled: [],
    skipped: [],
    alreadyEnrolled: [],
  };

  const enrolled = new Set<string>();

  for (const contactId of input.contactIds) {
    // Dedup: check if already enrolled
    const existing = await db
      .select({ id: campaignEnrollments.id })
      .from(campaignEnrollments)
      .where(
        and(
          eq(campaignEnrollments.organizationId, input.organizationId),
          eq(campaignEnrollments.campaignId, input.campaignId),
          eq(campaignEnrollments.contactId, contactId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      result.alreadyEnrolled.push(existing[0].id);
      enrolled.add(existing[0].id);
      continue;
    }

    // Suppression check
    const suppressed = await isContactSuppressed(input.organizationId, contactId);
    if (suppressed) {
      result.skipped.push({ contactId, reason: 'Contact is suppressed' });
      continue;
    }

    // Consent check for channels used by this campaign's sequences
    const contact = await getContact(input.organizationId, contactId);
    if (!contact) {
      result.skipped.push({ contactId, reason: 'Contact not found' });
      continue;
    }

    // Check if contact has any valid consent for the channels this campaign uses
    const campaignChannels = await getCampaignChannels(input.organizationId, input.campaignId);
    const hasConsent = await contactHasConsentForChannels(
      input.organizationId,
      contactId,
      campaignChannels,
    );
    if (!hasConsent) {
      result.skipped.push({ contactId, reason: 'No valid consent for campaign channels' });
      continue;
    }

    // Create enrollment
    const enrollmentId = randomUUID();
    const now = new Date();

    await db.insert(campaignEnrollments).values({
      id: enrollmentId,
      organizationId: input.organizationId,
      campaignId: input.campaignId,
      contactId,
      status: 'pending',
      currentStepId: null,
      nextActionAt: now,
      startedAt: now,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });

    result.enrolled.push(enrollmentId);
    enrolled.add(enrollmentId);
  }

  return result;
}

// ─── Queue next step ────────────────────────────────────────────────────────────

export async function queueNextStep(input: QueueNextStepInput): Promise<void> {
  const [enrollment] = await db
    .select({
      id: campaignEnrollments.id,
      status: campaignEnrollments.status,
      currentStepId: campaignEnrollments.currentStepId,
      nextActionAt: campaignEnrollments.nextActionAt,
      campaignId: campaignEnrollments.campaignId,
      contactId: campaignEnrollments.contactId,
    })
    .from(campaignEnrollments)
    .where(
      and(
        eq(campaignEnrollments.id, input.enrollmentId),
        eq(campaignEnrollments.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  if (!enrollment) {
    throw new Error(`Enrollment ${input.enrollmentId} not found`);
  }

  // Strategy creation is part of enrollment progression, not an optional
  // dashboard action. This guarantees every outbound touch has an auditable
  // prospect-specific reason and opening angle before it reaches a channel.
  await ensureStrategyForEnrollment(input);

  if (enrollment.status === 'completed' || enrollment.status === 'failed' ||
      enrollment.status === 'suppressed' || enrollment.status === 'disqualified') {
    return; // Terminal state — do not queue more steps
  }

  // Find the next step to execute
  const sequenceId = await getEnrollmentSequenceId(input.organizationId, enrollment.campaignId);
  if (!sequenceId) return;

  const steps = await getSequenceSteps(sequenceId);
  const executedPositions = await getExecutedStepPositions(input.organizationId, enrollment.id);

  // Find the next pending step
  const nextStep = steps.find(
    (s) => !executedPositions.has(s.position) &&
      (s.channel === 'email' || s.channel === 'phone' || s.channel === 'sms' || s.channel === 'task'),
  );

  if (!nextStep) {
    // All steps executed — mark enrollment completed
    await completeEnrollment(input.organizationId, enrollment.id);
    return;
  }

  // Calculate next action time (now + delay)
  const nextActionAt = new Date(Date.now() + nextStep.delaySeconds * 1000);

  await db
    .update(campaignEnrollments)
    .set({
      currentStepId: nextStep.id,
      nextActionAt,
      status: enrollment.status === 'pending' ? 'active' : enrollment.status,
      updatedAt: new Date(),
    })
    .where(eq(campaignEnrollments.id, enrollment.id));

  await queueDurableStepExecution({
    organizationId: input.organizationId,
    enrollmentId: enrollment.id,
    stepId: nextStep.id,
    scheduledAt: nextActionAt,
  });
}

// ─── Advance enrollment ─────────────────────────────────────────────────────────

export async function advanceEnrollment(
  input: AdvanceEnrollmentInput,
): Promise<void> {
  const [enrollment] = await db
    .select()
    .from(campaignEnrollments)
    .where(
      and(
        eq(campaignEnrollments.id, input.enrollmentId),
        eq(campaignEnrollments.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  if (!enrollment) {
    throw new Error(`Enrollment ${input.enrollmentId} not found`);
  }

  const now = new Date();

  // Record the interaction
  if (input.interactionId) {
    await recordInteractionOutcome(input.interactionId, input.outcome);
  }

  // Determine next status
  let newStatus = enrollment.status;
  if (input.outcome === 'interested' || input.outcome === 'responded') {
    newStatus = 'responded';
  } else if (input.outcome === 'booked') {
    newStatus = 'booked';
  } else if (input.outcome === 'disqualified') {
    newStatus = 'disqualified';
  } else if (input.outcome === 'no_answer' || input.outcome === 'busy' ||
             input.outcome === 'voicemail') {
    // Stay in current status, just record the outcome
  }

  // Pause-on-reply: if this enrollment got a meaningful response, pause others
  if (input.outcome === 'interested' || input.outcome === 'responded' ||
      input.outcome === 'booked') {
    await pauseOtherEnrollments(input.organizationId, enrollment.campaignId, enrollment.id);
  }

  // Mark the current step as executed
  if (enrollment.currentStepId) {
    const interactionId = input.interactionId ?? undefined;
    await markStepExecution({
      organizationId: input.organizationId,
      enrollmentId: enrollment.id,
      stepId: enrollment.currentStepId,
      status: newStatus === 'responded' || newStatus === 'booked' ? 'succeeded' : 'succeeded',
      interactionId,
      result: { outcome: input.outcome },
    });
  }

  await db
    .update(campaignEnrollments)
    .set({
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(campaignEnrollments.id, enrollment.id));

  if (['interested', 'responded', 'booked'].includes(input.outcome)) {
    await upsertRevenueOpportunity({
      organizationId: input.organizationId,
      campaignId: enrollment.campaignId,
      contactId: enrollment.contactId,
      outcome: input.outcome,
      amountCents: input.amountCents,
      meetingStartsAt: input.meetingStartsAt,
      meetingEndsAt: input.meetingEndsAt,
      meetingUrl: input.meetingUrl,
      now,
    });
  }

  // If booked or disqualified, mark as completed
  if (newStatus === 'booked' || newStatus === 'disqualified') {
    await completeEnrollment(input.organizationId, enrollment.id);
  }
}

async function upsertRevenueOpportunity(input: {
  organizationId: string;
  campaignId: string;
  contactId: string;
  outcome: string;
  amountCents?: number;
  meetingStartsAt?: string;
  meetingEndsAt?: string;
  meetingUrl?: string;
  now: Date;
}): Promise<void> {
  const [existing] = await db.select().from(salesOpportunities).where(and(
    eq(salesOpportunities.organizationId, input.organizationId),
    eq(salesOpportunities.contactId, input.contactId),
    inArray(salesOpportunities.status, ['open', 'qualified', 'proposed', 'negotiated']),
  )).limit(1);
  const metadata = { campaignId: input.campaignId, lastOutcome: input.outcome };

  if (existing) {
    await db.update(salesOpportunities).set({
      status: 'qualified',
      amountCents: input.amountCents === undefined ? existing.amountCents : String(input.amountCents),
      nextActionAt: input.meetingStartsAt ? new Date(input.meetingStartsAt) : input.now,
      updatedAt: input.now,
      metadata: { ...(existing.metadata ?? {}), ...metadata },
    }).where(eq(salesOpportunities.id, existing.id));
  } else {
    await db.insert(salesOpportunities).values({
      id: randomUUID(),
      organizationId: input.organizationId,
      contactId: input.contactId,
      name: `Revenue opportunity from campaign ${input.campaignId}`,
      amountCents: input.amountCents === undefined ? null : String(input.amountCents),
      probability: input.outcome === 'booked' ? 0.65 : 0.35,
      probabilitySource: 'rule_based',
      source: 'campaign',
      status: 'qualified',
      nextActionAt: input.meetingStartsAt ? new Date(input.meetingStartsAt) : input.now,
      metadata,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  if (input.outcome !== 'booked' || !input.meetingStartsAt || !input.meetingEndsAt) return;
  const startsAt = new Date(input.meetingStartsAt);
  const endsAt = new Date(input.meetingEndsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return;

  const [existingMeeting] = await db.select({ id: meetings.id }).from(meetings).where(and(
    eq(meetings.organizationId, input.organizationId),
    eq(meetings.contactId, input.contactId),
    eq(meetings.status, 'scheduled'),
  )).limit(1);
  if (existingMeeting) return;

  const [meeting] = await db.insert(meetings).values({
    id: randomUUID(),
    organizationId: input.organizationId,
    contactId: input.contactId,
    provider: 'manual',
    title: 'Revenue qualification meeting',
    startsAt,
    endsAt,
    status: 'scheduled',
    meetingUrl: input.meetingUrl,
    metadata,
    createdAt: input.now,
    updatedAt: input.now,
  }).returning({ id: meetings.id });
  if (meeting) {
    await db.insert(meetingAttendees).values({
      id: randomUUID(),
      meetingId: meeting.id,
      contactId: input.contactId,
      role: 'attendee',
      createdAt: input.now,
    }).onConflictDoNothing();
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────────

async function isContactSuppressed(
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      or(
        and(
          eq(suppressions.organizationId, organizationId),
          eq(suppressions.contactId, contactId),
        ),
        and(
          eq(suppressions.organizationId, organizationId),
          isNull(suppressions.contactId),
          isNull(suppressions.email),
          isNull(suppressions.phoneE164),
        ),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

async function getContact(
  organizationId: string,
  contactId: string,
): Promise<{ id: string; email: string | null; phoneE164: string | null; status: string } | null> {
  const rows = await db
    .select({
      id: contacts.id,
      email: contacts.email,
      phoneE164: contacts.phoneE164,
      status: contacts.status,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.organizationId, organizationId),
      ),
    )
    .limit(1);

  return rows.length > 0 ? rows[0] : null;
}

async function getCampaignChannels(
  organizationId: string,
  campaignId: string,
): Promise<string[]> {
  // Get all steps across all sequences in this campaign
  const sequenceIds = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(eq(sequences.campaignId, campaignId))
    .limit(100);

  if (sequenceIds.length === 0) return [];

  const ids = sequenceIds.map((s) => s.id);
  const steps = await db
    .select({ channel: sequenceSteps.channel })
    .from(sequenceSteps)
    .where(inArray(sequenceSteps.sequenceId, ids))
    .limit(100);

  const channels = new Set<string>();
  for (const step of steps) {
    if (step.channel) channels.add(step.channel);
  }
  return Array.from(channels);
}

async function contactHasConsentForChannels(
  organizationId: string,
  contactId: string,
  channels: string[],
): Promise<boolean> {
  if (channels.length === 0) return true;

  const rows = await db
    .select({
      status: consentRecords.status,
      channel: consentRecords.channel,
    })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.organizationId, organizationId),
        eq(consentRecords.contactId, contactId),
        inArray(consentRecords.channel, channels),
      ),
    )
    .limit(100);

  // Need at least one 'granted' consent for each channel that requires it
  const grantedChannels = new Set<string>();
  for (const row of rows) {
    if (row.status === 'granted') {
      grantedChannels.add(row.channel);
    }
  }

  // Check if all required channels have consent
  for (const channel of channels) {
    if (!grantedChannels.has(channel)) return false;
  }
  return true;
}

async function getEnrollmentSequenceId(
  organizationId: string,
  campaignId: string,
): Promise<string | null> {
  // Get the first active sequence for this campaign
  const sequencesResult = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(eq(sequences.campaignId, campaignId))
    .limit(1);

  return sequencesResult.length > 0 ? sequencesResult[0].id : null;
}

async function getSequenceSteps(sequenceId: string): Promise<{
  id: string;
  position: number;
  channel: string;
  delaySeconds: number;
  configuration: Record<string, unknown>;
}[]> {
  const rows = await db
    .select({
      id: sequenceSteps.id,
      position: sequenceSteps.position,
      channel: sequenceSteps.channel,
      delaySeconds: sequenceSteps.delaySeconds,
      configuration: sequenceSteps.configuration,
    })
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequenceId))
    .orderBy(sequenceSteps.position);

  return rows;
}

async function getExecutedStepPositions(
  organizationId: string,
  enrollmentId: string,
): Promise<Set<number>> {
  const executions = await db
    .select({ stepId: sequenceStepExecutions.stepId })
    .from(sequenceStepExecutions)
    .where(and(
      eq(sequenceStepExecutions.organizationId, organizationId),
      eq(sequenceStepExecutions.enrollmentId, enrollmentId),
      inArray(sequenceStepExecutions.status, ['succeeded', 'skipped']),
    ));

  if (executions.length === 0) return new Set<number>();
  const stepIds = executions.map((execution) => execution.stepId);
  const steps = await db
    .select({ position: sequenceSteps.position })
    .from(sequenceSteps)
    .where(inArray(sequenceSteps.id, stepIds));
  return new Set(steps.map((step) => step.position));
}

async function recordInteractionOutcome(
  interactionId: string,
  outcome: string,
): Promise<void> {
  await db
    .update(interactions)
    .set({
      structuredOutcome: { outcome },
      status: 'responded',
    })
    .where(eq(interactions.id, interactionId));
}

async function completeEnrollment(
  organizationId: string,
  enrollmentId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(campaignEnrollments)
    .set({
      status: 'completed',
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(campaignEnrollments.id, enrollmentId));
}

async function pauseOtherEnrollments(
  organizationId: string,
  campaignId: string,
  excludedEnrollmentId: string,
): Promise<void> {
  // Pause enrollments that have a pending nextActionAt and are in active/waiting status
  const now = new Date();

  await db
    .update(campaignEnrollments)
    .set({
      status: 'waiting',
      updatedAt: now,
    })
    .where(
      and(
        eq(campaignEnrollments.organizationId, organizationId),
        eq(campaignEnrollments.campaignId, campaignId),
        not(eq(campaignEnrollments.id, excludedEnrollmentId)),
        inArray(campaignEnrollments.status, ['active', 'pending']),
      ),
    );
}

// ─── Tool factory ───────────────────────────────────────────────────────────────

export function createCampaignTools(): ToolDefinition[] {
  return [
  {
    name: 'create_revenue_ops_campaign',
    description:
      'Create a new revenue operations campaign linked to a mission. A campaign contains one or more sequences, each with ordered steps (email/phone/sms/task). This creates the campaign and sequences but does NOT enroll contacts or send anything.',
    schema: z.object({
        organizationId: z.string().describe('Organization/project UUID'),
        missionId: z.string().describe('Mission UUID (goals.id) this campaign serves'),
        name: z.string().min(1).max(200).describe('Campaign name'),
        description: z.string().max(2000).optional().describe('Campaign description'),
        sequenceConfigs: z.array(
          z.object({
            name: z.string().min(1).max(200),
            steps: z.array(
              z.object({
                channel: z.enum(['email', 'phone', 'sms', 'task']),
                delaySeconds: z.number().int().min(0).max(86400 * 30), // up to 30 days
                configuration: z.record(z.unknown()).optional(),
                templateId: z.string().optional(),
              }),
            ),
          }),
        ),
        audienceFilter: z.record(z.unknown()).optional(),
        dailyLimits: z.record(z.number()).optional(),
      }),
    requiresApproval: false,
    async execute(input: CreateCampaignInput) {
      const campaignId = await createCampaign(input);
      return {
        campaignId,
        message: `Campaign "${input.name}" created with ${input.sequenceConfigs.length} sequence(s).`,
      };
    },
  },
  {
    name: 'enroll_contacts_in_campaign',
    description:
      'Enroll contacts into a revenue-ops campaign. Performs suppression check, consent check, and dedup before enrolling. Returns which contacts were enrolled, skipped, or already enrolled.',
    schema: z.object({
        organizationId: z.string(),
        campaignId: z.string(),
        contactIds: z.array(z.string()),
      }),
    requiresApproval: false,
    async execute(input: EnrollContactsInput) {
      const result = await enrollContacts(input);
      return {
        enrolled: result.enrolled,
        skipped: result.skipped,
        alreadyEnrolled: result.alreadyEnrolled,
        summary: `${result.enrolled.length} enrolled, ${result.skipped.length} skipped, ${result.alreadyEnrolled.length} already enrolled.`,
      };
    },
  },
  {
    name: 'activate_revenue_ops_campaign',
    description:
      'Activate a prepared revenue-ops campaign. Activation lets the durable workforce coordinator queue and prepare enrolled steps; real external sends remain behind their channel approval gates.',
    schema: z.object({
      organizationId: z.string(),
      campaignId: z.string(),
    }),
    requiresApproval: false,
    async execute(input: { organizationId: string; campaignId: string }) {
      const [updated] = await db.update(campaigns).set({
        status: 'active',
        startedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(campaigns.id, input.campaignId),
        eq(campaigns.organizationId, input.organizationId),
        inArray(campaigns.status, ['draft', 'ready', 'paused']),
      )).returning({ id: campaigns.id, status: campaigns.status });
      if (!updated) throw new Error(`Campaign ${input.campaignId} is missing or cannot be activated.`);
      return { campaignId: updated.id, status: updated.status, message: 'Revenue workforce coordination is active.' };
    },
  },
  {
    name: 'queue_campaign_step',
    description:
      'Queue the next step for a campaign enrollment. Finds the next unexecuted step in the enrollment\'s sequence and schedules it based on the step\'s delay. If all steps are done, marks the enrollment completed.',
    schema: z.object({
        organizationId: z.string(),
        enrollmentId: z.string(),
      }),
    requiresApproval: false,
    async execute(input: QueueNextStepInput) {
      await queueNextStep(input);
      return { ok: true, message: 'Next step queued.' };
    },
  },
  {
    name: 'prepare_revenue_workforce_step',
    description:
      'Prepare one due revenue-workforce step. This creates the prospect strategy and relationship-timeline event, then stops at the existing approval boundary for email, phone, or SMS. Internal task steps may complete automatically.',
    schema: z.object({
      organizationId: z.string(),
      enrollmentId: z.string(),
    }),
    requiresApproval: false,
    async execute(input: { organizationId: string; enrollmentId: string }) {
      return prepareDueRevenueStep(input);
    },
  },
  {
    name: 'advance_campaign_enrollment',
    description:
      'Record an outcome for a campaign enrollment (e.g. interested, not_interested, booked, no_answer). Records the interaction outcome, advances the enrollment status, and triggers pause-on-reply for other enrollments if the outcome is meaningful.',
    schema: z.object({
        organizationId: z.string(),
        enrollmentId: z.string(),
        outcome: z.enum(['interested', 'not_interested', 'no_answer', 'busy', 'voicemail', 'booked', 'callback', 'disqualified', 'responded']),
        interactionId: z.string().optional(),
        callId: z.string().optional(),
        meetingStartsAt: z.string().datetime().optional(),
        meetingEndsAt: z.string().datetime().optional(),
        meetingUrl: z.string().url().optional(),
        amountCents: z.number().int().nonnegative().optional(),
      }),
    requiresApproval: false,
    async execute(input: AdvanceEnrollmentInput) {
      await advanceEnrollment(input);
      return { ok: true, message: `Enrollment advanced with outcome: ${input.outcome}.` };
    },
  },
  {
    name: 'get_campaign_enrollment_status',
    description:
      'Get the current status and details of a campaign enrollment.',
    schema: z.object({
        organizationId: z.string(),
        enrollmentId: z.string(),
      }),
    requiresApproval: false,
    async execute({ organizationId, enrollmentId }) {
      const rows = await db
        .select()
        .from(campaignEnrollments)
        .where(
          and(
            eq(campaignEnrollments.id, enrollmentId),
            eq(campaignEnrollments.organizationId, organizationId),
          ),
        )
        .limit(1);

      if (rows.length === 0) {
        return { found: false, message: `Enrollment ${enrollmentId} not found.` };
      }

      const e = rows[0];
      return {
        found: true,
        enrollment: {
          id: e.id,
          status: e.status,
          currentStepId: e.currentStepId,
          nextActionAt: e.nextActionAt?.toISOString() ?? null,
          startedAt: e.startedAt?.toISOString() ?? null,
          completedAt: e.completedAt?.toISOString() ?? null,
          stopReason: e.stopReason ?? null,
        },
      };
    },
  },
];
}

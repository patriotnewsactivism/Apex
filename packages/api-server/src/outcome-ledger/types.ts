import { z } from 'zod';

export const OUTCOME_SCHEMA_VERSION = 1 as const;

export const canonicalEntityTypes = [
  'Organization',
  'Customer',
  'Lead',
  'Opportunity',
  'Campaign',
  'Conversation',
  'Call',
  'Appointment',
  'Task',
  'AgentRun',
  'WorkflowRun',
  'Deployment',
  'Incident',
  'Approval',
  'Experiment',
  'RevenueEvent',
  'CostEvent',
  'Outcome',
] as const;

export const measurementClasses = ['MEASURED', 'ESTIMATED', 'INFERRED', 'UNKNOWN'] as const;

export const entityTypeSchema = z.enum(canonicalEntityTypes);
export const measurementClassSchema = z.enum(measurementClasses);
const evidenceSchema = z.record(z.unknown());
const scalarValueSchema = z.union([z.number().finite(), z.string().max(1_000), z.boolean(), z.null()]);

export const outcomeEventSchema = z.object({
  schemaVersion: z.literal(OUTCOME_SCHEMA_VERSION).default(OUTCOME_SCHEMA_VERSION),
  idempotencyKey: z.string().min(8).max(240),
  source: z.string().min(1).max(100),
  organizationId: z.string().min(1).max(160),
  tenantId: z.string().min(1).max(160),
  occurredAt: z.string().datetime().optional(),
  traceId: z.string().max(240).optional(),
  intent: z.string().max(2_000).optional(),
  activity: z.object({
    eventType: z.string().min(1).max(160),
    responsibleAgentId: z.string().max(240).optional(),
    responsibleWorkflow: z.string().max(240).optional(),
    agentRunId: z.string().max(240).optional(),
    workflowRunId: z.string().max(240).optional(),
    humanIntervention: z.boolean().default(false),
  }),
  entity: z.object({
    type: entityTypeSchema,
    externalId: z.string().min(1).max(240),
    name: z.string().max(500).optional(),
    attributes: evidenceSchema.optional(),
  }).optional(),
  outcome: z.object({
    outcomeType: z.string().min(1).max(160),
    metricName: z.string().min(1).max(160),
    baseline: scalarValueSchema.optional(),
    target: scalarValueSchema.optional(),
    measuredResult: scalarValueSchema.optional(),
    unit: z.string().max(80).optional(),
    classification: measurementClassSchema.default('UNKNOWN'),
    confidence: z.number().min(0).max(1).optional(),
    attributedRevenue: z.number().finite().optional(),
    influencedRevenue: z.number().finite().optional(),
    directCost: z.number().finite().nonnegative().optional(),
    estimatedLaborSavedHours: z.number().finite().nonnegative().optional(),
    qualityScore: z.number().min(0).max(1).optional(),
    status: z.string().max(80).optional(),
    evidence: evidenceSchema.optional(),
  }).optional(),
  revenueEvents: z.array(z.object({
    idempotencyKey: z.string().min(8).max(240).optional(),
    amount: z.number().finite(),
    currency: z.string().length(3).default('USD'),
    kind: z.enum(['sourced', 'influenced', 'recognized', 'refund']),
    classification: measurementClassSchema.default('UNKNOWN'),
    customerExternalId: z.string().max(240).optional(),
    opportunityExternalId: z.string().max(240).optional(),
    evidence: evidenceSchema.optional(),
  })).default([]),
  costEvents: z.array(z.object({
    idempotencyKey: z.string().min(8).max(240).optional(),
    amount: z.number().finite().nonnegative(),
    currency: z.string().length(3).default('USD'),
    category: z.enum(['ai_provider', 'telephony', 'sms', 'infra', 'human_labor', 'other']),
    provider: z.string().max(160).optional(),
    classification: measurementClassSchema.default('UNKNOWN'),
    evidence: evidenceSchema.optional(),
  })).default([]),
  experiment: z.object({
    experimentId: z.string().min(1).max(240),
    cohort: z.string().min(1).max(120),
    metricName: z.string().min(1).max(160),
    value: z.number().finite(),
    classification: measurementClassSchema.default('UNKNOWN'),
    confidence: z.number().min(0).max(1).optional(),
  }).optional(),
  metadata: evidenceSchema.optional(),
});

export const outcomeBatchSchema = z.union([
  outcomeEventSchema,
  z.object({ events: z.array(outcomeEventSchema).min(1).max(250) }),
]);

export const experimentCreateSchema = z.object({
  id: z.string().min(1).max(240),
  organizationId: z.string().min(1).max(160),
  tenantId: z.string().min(1).max(160),
  name: z.string().min(1).max(300),
  hypothesis: z.string().min(1).max(2_000),
  metricName: z.string().min(1).max(160),
  controlCohort: z.string().min(1).max(120).default('control'),
  treatmentCohorts: z.array(z.string().min(1).max(120)).min(1),
  status: z.enum(['draft', 'running', 'completed', 'stopped']).default('draft'),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  createdBy: z.string().max(240).optional(),
  metadata: evidenceSchema.optional(),
});

export const experimentAssignmentSchema = z.object({
  tenantId: z.string().min(1).max(160),
  entityExternalId: z.string().min(1).max(240),
  entityType: entityTypeSchema,
  cohort: z.string().min(1).max(120),
  assignedAt: z.string().datetime().optional(),
  metadata: evidenceSchema.optional(),
});

export type OutcomeEventInput = z.infer<typeof outcomeEventSchema>;
export type MeasurementClass = z.infer<typeof measurementClassSchema>;
export type ExperimentCreateInput = z.infer<typeof experimentCreateSchema>;
export type ExperimentAssignmentInput = z.infer<typeof experimentAssignmentSchema>;

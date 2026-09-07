import crypto from 'node:crypto';
import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { ensureOutcomeLedgerSchema } from './migrate.js';
import {
  experimentAssignmentSchema,
  experimentCreateSchema,
  outcomeEventSchema,
  type ExperimentAssignmentInput,
  type ExperimentCreateInput,
  type OutcomeEventInput,
} from './types.js';

const stableId = (prefix: string, value: string): string =>
  `${prefix}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;

const json = (value: unknown): string => JSON.stringify(value ?? {});
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export interface IngestResult {
  eventId: string;
  idempotencyKey: string;
  tenantId: string;
}

export async function ingestOutcomeEvent(raw: unknown): Promise<IngestResult> {
  const input = outcomeEventSchema.parse(raw);
  await ensureOutcomeLedgerSchema();
  return persistEvent(input);
}

async function persistEvent(input: OutcomeEventInput): Promise<IngestResult> {
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const eventId = stableId('evt', `${input.source}:${input.tenantId}:${input.idempotencyKey}`);
  const entityId = input.entity
    ? stableId('ent', `${input.source}:${input.tenantId}:${input.entity.type}:${input.entity.externalId}`)
    : null;
  const measurementClass = input.outcome?.classification ?? input.experiment?.classification ?? 'UNKNOWN';

  await db.transaction(async (tx) => {
    if (input.entity && entityId) {
      await tx.execute(sql`
        INSERT INTO outcome_entities (
          id, organization_id, tenant_id, source_system, entity_type, external_id, name, attributes, first_seen_at, last_seen_at
        ) VALUES (
          ${entityId}, ${input.organizationId}, ${input.tenantId}, ${input.source}, ${input.entity.type}, ${input.entity.externalId},
          ${input.entity.name ?? null}, ${json(input.entity.attributes)}::jsonb, ${occurredAt}, ${occurredAt}
        )
        ON CONFLICT (tenant_id, source_system, entity_type, external_id)
        DO UPDATE SET
          name = COALESCE(EXCLUDED.name, outcome_entities.name),
          attributes = outcome_entities.attributes || EXCLUDED.attributes,
          last_seen_at = GREATEST(outcome_entities.last_seen_at, EXCLUDED.last_seen_at)
      `);
    }

    await tx.execute(sql`
      INSERT INTO outcome_events (
        id, idempotency_key, schema_version, organization_id, tenant_id, source_system, event_type,
        entity_id, entity_type, entity_external_id, trace_id, intent, responsible_agent_id, responsible_workflow,
        agent_run_id, workflow_run_id, human_intervention, measurement_class, payload, occurred_at
      ) VALUES (
        ${eventId}, ${input.idempotencyKey}, ${input.schemaVersion}, ${input.organizationId}, ${input.tenantId}, ${input.source},
        ${input.activity.eventType}, ${entityId}, ${input.entity?.type ?? null}, ${input.entity?.externalId ?? null}, ${input.traceId ?? null},
        ${input.intent ?? null}, ${input.activity.responsibleAgentId ?? null}, ${input.activity.responsibleWorkflow ?? null},
        ${input.activity.agentRunId ?? null}, ${input.activity.workflowRunId ?? null}, ${input.activity.humanIntervention},
        ${measurementClass}, ${json({ metadata: input.metadata ?? {}, activity: input.activity, entity: input.entity ?? null })}::jsonb, ${occurredAt}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `);

    if (input.outcome) {
      const outcomeId = stableId('out', eventId);
      await tx.execute(sql`
        INSERT INTO outcomes (
          id, event_id, organization_id, tenant_id, source_system, outcome_type, metric_name, entity_id, trace_id,
          responsible_agent_id, responsible_workflow, baseline, target, measured_result, numeric_baseline, numeric_target,
          numeric_result, unit, measurement_class, confidence, attributed_revenue, influenced_revenue, direct_cost,
          estimated_labor_saved_hours, human_intervention, quality_score, status, evidence, occurred_at
        ) VALUES (
          ${outcomeId}, ${eventId}, ${input.organizationId}, ${input.tenantId}, ${input.source}, ${input.outcome.outcomeType},
          ${input.outcome.metricName}, ${entityId}, ${input.traceId ?? null}, ${input.activity.responsibleAgentId ?? null},
          ${input.activity.responsibleWorkflow ?? null}, ${input.outcome.baseline === undefined ? null : JSON.stringify(input.outcome.baseline)}::jsonb,
          ${input.outcome.target === undefined ? null : JSON.stringify(input.outcome.target)}::jsonb,
          ${input.outcome.measuredResult === undefined ? null : JSON.stringify(input.outcome.measuredResult)}::jsonb,
          ${numeric(input.outcome.baseline)}, ${numeric(input.outcome.target)}, ${numeric(input.outcome.measuredResult)},
          ${input.outcome.unit ?? null}, ${input.outcome.classification}, ${input.outcome.confidence ?? null},
          ${input.outcome.attributedRevenue ?? null}, ${input.outcome.influencedRevenue ?? null}, ${input.outcome.directCost ?? null},
          ${input.outcome.estimatedLaborSavedHours ?? null}, ${input.activity.humanIntervention}, ${input.outcome.qualityScore ?? null},
          ${input.outcome.status ?? null}, ${json(input.outcome.evidence)}::jsonb, ${occurredAt}
        )
        ON CONFLICT (event_id) DO NOTHING
      `);
    }

    const revenueEvents = [...input.revenueEvents];
    if (input.outcome?.attributedRevenue !== undefined && !revenueEvents.some((event) => event.kind === 'sourced')) {
      revenueEvents.push({
        amount: input.outcome.attributedRevenue,
        currency: 'USD',
        kind: 'sourced',
        classification: input.outcome.classification,
        evidence: { origin: 'outcome.attributedRevenue' },
      });
    }
    if (input.outcome?.influencedRevenue !== undefined && !revenueEvents.some((event) => event.kind === 'influenced')) {
      revenueEvents.push({
        amount: input.outcome.influencedRevenue,
        currency: 'USD',
        kind: 'influenced',
        classification: input.outcome.classification,
        evidence: { origin: 'outcome.influencedRevenue' },
      });
    }

    for (let index = 0; index < revenueEvents.length; index++) {
      const revenue = revenueEvents[index]!;
      const idempotencyKey = revenue.idempotencyKey ?? `${input.idempotencyKey}:revenue:${revenue.kind}:${index}`;
      const revenueId = stableId('rev', `${input.source}:${input.tenantId}:${idempotencyKey}`);
      await tx.execute(sql`
        INSERT INTO revenue_events (
          id, idempotency_key, organization_id, tenant_id, source_system, source_event_id, customer_external_id,
          opportunity_external_id, trace_id, responsible_agent_id, responsible_workflow, kind, amount, currency,
          measurement_class, evidence, occurred_at
        ) VALUES (
          ${revenueId}, ${idempotencyKey}, ${input.organizationId}, ${input.tenantId}, ${input.source}, ${eventId},
          ${revenue.customerExternalId ?? null}, ${revenue.opportunityExternalId ?? null}, ${input.traceId ?? null},
          ${input.activity.responsibleAgentId ?? null}, ${input.activity.responsibleWorkflow ?? null}, ${revenue.kind}, ${revenue.amount},
          ${revenue.currency}, ${revenue.classification}, ${json(revenue.evidence)}::jsonb, ${occurredAt}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `);
    }

    const costEvents = [...input.costEvents];
    if (input.outcome?.directCost !== undefined && !costEvents.length) {
      costEvents.push({
        amount: Math.max(0, input.outcome.directCost),
        currency: 'USD',
        category: 'other',
        classification: input.outcome.classification,
        evidence: { origin: 'outcome.directCost' },
      });
    }

    for (let index = 0; index < costEvents.length; index++) {
      const cost = costEvents[index]!;
      const idempotencyKey = cost.idempotencyKey ?? `${input.idempotencyKey}:cost:${cost.category}:${index}`;
      const costId = stableId('cost', `${input.source}:${input.tenantId}:${idempotencyKey}`);
      await tx.execute(sql`
        INSERT INTO cost_events (
          id, idempotency_key, organization_id, tenant_id, source_system, source_event_id, trace_id,
          responsible_agent_id, responsible_workflow, category, provider, amount, currency, measurement_class, evidence, occurred_at
        ) VALUES (
          ${costId}, ${idempotencyKey}, ${input.organizationId}, ${input.tenantId}, ${input.source}, ${eventId}, ${input.traceId ?? null},
          ${input.activity.responsibleAgentId ?? null}, ${input.activity.responsibleWorkflow ?? null}, ${cost.category}, ${cost.provider ?? null},
          ${cost.amount}, ${cost.currency}, ${cost.classification}, ${json(cost.evidence)}::jsonb, ${occurredAt}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `);
    }

    if (input.experiment) {
      const observationId = stableId('obs', `${input.experiment.experimentId}:${eventId}`);
      await tx.execute(sql`
        INSERT INTO experiment_observations (
          id, experiment_id, tenant_id, source_event_id, cohort, metric_name, value, measurement_class, confidence, occurred_at
        ) VALUES (
          ${observationId}, ${input.experiment.experimentId}, ${input.tenantId}, ${eventId}, ${input.experiment.cohort},
          ${input.experiment.metricName}, ${input.experiment.value}, ${input.experiment.classification}, ${input.experiment.confidence ?? null}, ${occurredAt}
        ) ON CONFLICT (source_event_id) DO NOTHING
      `);
    }

    await tx.execute(sql`
      INSERT INTO outcome_audit_log (organization_id, tenant_id, action, object_type, object_id, actor, trace_id, details)
      VALUES (${input.organizationId}, ${input.tenantId}, 'ingest', 'outcome_event', ${eventId}, ${input.source}, ${input.traceId ?? null},
        ${json({ idempotencyKey: input.idempotencyKey, eventType: input.activity.eventType })}::jsonb)
    `);
  });

  return { eventId, idempotencyKey: input.idempotencyKey, tenantId: input.tenantId };
}

export async function createExperiment(raw: unknown): Promise<ExperimentCreateInput> {
  const input = experimentCreateSchema.parse(raw);
  await ensureOutcomeLedgerSchema();
  await db.execute(sql`
    INSERT INTO experiments (
      id, organization_id, tenant_id, name, hypothesis, metric_name, control_cohort, treatment_cohorts,
      status, created_by, metadata, started_at, ended_at, updated_at
    ) VALUES (
      ${input.id}, ${input.organizationId}, ${input.tenantId}, ${input.name}, ${input.hypothesis}, ${input.metricName},
      ${input.controlCohort}, ${json(input.treatmentCohorts)}::jsonb, ${input.status}, ${input.createdBy ?? null},
      ${json(input.metadata)}::jsonb, ${input.startedAt ? new Date(input.startedAt) : null}, ${input.endedAt ? new Date(input.endedAt) : null}, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name, hypothesis=EXCLUDED.hypothesis, metric_name=EXCLUDED.metric_name,
      control_cohort=EXCLUDED.control_cohort, treatment_cohorts=EXCLUDED.treatment_cohorts,
      status=EXCLUDED.status, metadata=EXCLUDED.metadata, started_at=EXCLUDED.started_at, ended_at=EXCLUDED.ended_at, updated_at=now()
  `);
  return input;
}

export async function assignExperiment(experimentId: string, raw: unknown): Promise<ExperimentAssignmentInput> {
  const input = experimentAssignmentSchema.parse(raw);
  await ensureOutcomeLedgerSchema();
  const assignmentId = stableId('asg', `${experimentId}:${input.tenantId}:${input.entityType}:${input.entityExternalId}`);
  await db.execute(sql`
    INSERT INTO experiment_assignments (id, experiment_id, tenant_id, entity_external_id, entity_type, cohort, metadata, assigned_at)
    VALUES (${assignmentId}, ${experimentId}, ${input.tenantId}, ${input.entityExternalId}, ${input.entityType}, ${input.cohort},
      ${json(input.metadata)}::jsonb, ${input.assignedAt ? new Date(input.assignedAt) : new Date()})
    ON CONFLICT (experiment_id, tenant_id, entity_external_id)
    DO UPDATE SET cohort=EXCLUDED.cohort, metadata=EXCLUDED.metadata, assigned_at=EXCLUDED.assigned_at
  `);
  return input;
}

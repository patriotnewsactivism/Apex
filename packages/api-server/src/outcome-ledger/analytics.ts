import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
import { ensureOutcomeLedgerSchema } from './migrate.js';

const WINDOW_DAYS: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };

export function normalizeWindow(value: unknown): { label: string; days: number } {
  const label = String(value ?? '1d');
  return { label: WINDOW_DAYS[label] ? label : '1d', days: WINDOW_DAYS[label] ?? 1 };
}

const rows = <T>(result: unknown): T[] => result as T[];

export async function getOutcomeDashboard(tenantId: string | null, windowValue: unknown) {
  await ensureOutcomeLedgerSchema();
  const window = normalizeWindow(windowValue);
  const tenant = tenantId || null;

  const [eventSummaryResult, moneyResult, laborResult, workflowResult, agentResult, experimentResult] = await Promise.all([
    db.execute(sql`
      SELECT event_type, measurement_class, count(*)::int AS count
      FROM outcome_events
      WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
        AND (${tenant}::text IS NULL OR tenant_id = ${tenant})
      GROUP BY event_type, measurement_class
      ORDER BY count(*) DESC, event_type
      LIMIT 50
    `),
    db.execute(sql`
      WITH revenue AS (
        SELECT
          COALESCE(sum(amount) FILTER (WHERE kind='sourced' AND measurement_class='MEASURED'),0)::float8 AS measured_sourced_revenue,
          COALESCE(sum(amount) FILTER (WHERE kind='influenced' AND measurement_class='MEASURED'),0)::float8 AS measured_influenced_revenue,
          COALESCE(sum(amount) FILTER (WHERE kind='sourced' AND measurement_class='ESTIMATED'),0)::float8 AS estimated_sourced_revenue,
          COALESCE(sum(amount) FILTER (WHERE kind='influenced' AND measurement_class='ESTIMATED'),0)::float8 AS estimated_influenced_revenue
        FROM revenue_events
        WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
          AND (${tenant}::text IS NULL OR tenant_id = ${tenant})
      ), cost AS (
        SELECT
          COALESCE(sum(amount) FILTER (WHERE measurement_class='MEASURED'),0)::float8 AS measured_cost,
          COALESCE(sum(amount) FILTER (WHERE measurement_class='ESTIMATED'),0)::float8 AS estimated_cost,
          COALESCE(sum(amount) FILTER (WHERE measurement_class='INFERRED'),0)::float8 AS inferred_cost
        FROM cost_events
        WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
          AND (${tenant}::text IS NULL OR tenant_id = ${tenant})
      )
      SELECT revenue.*, cost.* FROM revenue CROSS JOIN cost
    `),
    db.execute(sql`
      SELECT measurement_class,
        COALESCE(sum(estimated_labor_saved_hours),0)::float8 AS hours,
        count(*) FILTER (WHERE estimated_labor_saved_hours IS NOT NULL)::int AS samples
      FROM outcomes
      WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
        AND (${tenant}::text IS NULL OR tenant_id = ${tenant})
      GROUP BY measurement_class
      ORDER BY measurement_class
    `),
    db.execute(sql`
      WITH r AS (
        SELECT responsible_workflow AS key,
          COALESCE(sum(amount) FILTER (WHERE kind='sourced' AND measurement_class='MEASURED'),0)::float8 AS revenue,
          COALESCE(sum(amount) FILTER (WHERE kind='influenced' AND measurement_class='MEASURED'),0)::float8 AS influenced
        FROM revenue_events
        WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
          AND (${tenant}::text IS NULL OR tenant_id=${tenant})
          AND responsible_workflow IS NOT NULL
        GROUP BY responsible_workflow
      ), c AS (
        SELECT responsible_workflow AS key,
          COALESCE(sum(amount) FILTER (WHERE measurement_class='MEASURED'),0)::float8 AS cost
        FROM cost_events
        WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
          AND (${tenant}::text IS NULL OR tenant_id=${tenant})
          AND responsible_workflow IS NOT NULL
        GROUP BY responsible_workflow
      ), o AS (
        SELECT responsible_workflow AS key, count(*)::int AS outcomes,
          avg(quality_score) FILTER (WHERE measurement_class='MEASURED' AND quality_score IS NOT NULL)::float8 AS quality
        FROM outcomes
        WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
          AND (${tenant}::text IS NULL OR tenant_id=${tenant})
          AND responsible_workflow IS NOT NULL
        GROUP BY responsible_workflow
      ), keys AS (
        SELECT key FROM r UNION SELECT key FROM c UNION SELECT key FROM o
      )
      SELECT keys.key AS workflow,
        COALESCE(r.revenue,0)::float8 AS measured_sourced_revenue,
        COALESCE(r.influenced,0)::float8 AS measured_influenced_revenue,
        COALESCE(c.cost,0)::float8 AS measured_cost,
        COALESCE(o.outcomes,0)::int AS outcome_count,
        o.quality AS measured_quality,
        (COALESCE(r.revenue,0)-COALESCE(c.cost,0))::float8 AS measured_direct_margin,
        CASE WHEN COALESCE(c.cost,0) > 0 THEN ((COALESCE(r.revenue,0)-COALESCE(c.cost,0))/c.cost)::float8 ELSE NULL END AS measured_direct_roi
      FROM keys LEFT JOIN r USING(key) LEFT JOIN c USING(key) LEFT JOIN o USING(key)
      ORDER BY measured_direct_margin DESC, outcome_count DESC
      LIMIT 50
    `),
    db.execute(sql`
      WITH r AS (
        SELECT responsible_agent_id AS key,
          COALESCE(sum(amount) FILTER (WHERE kind='sourced' AND measurement_class='MEASURED'),0)::float8 AS revenue
        FROM revenue_events
        WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
          AND (${tenant}::text IS NULL OR tenant_id=${tenant}) AND responsible_agent_id IS NOT NULL
        GROUP BY responsible_agent_id
      ), c AS (
        SELECT responsible_agent_id AS key,
          COALESCE(sum(amount) FILTER (WHERE measurement_class='MEASURED'),0)::float8 AS cost
        FROM cost_events
        WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
          AND (${tenant}::text IS NULL OR tenant_id=${tenant}) AND responsible_agent_id IS NOT NULL
        GROUP BY responsible_agent_id
      ), o AS (
        SELECT responsible_agent_id AS key, count(*)::int AS outcomes,
          avg(quality_score) FILTER (WHERE measurement_class='MEASURED' AND quality_score IS NOT NULL)::float8 AS quality
        FROM outcomes
        WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
          AND (${tenant}::text IS NULL OR tenant_id=${tenant}) AND responsible_agent_id IS NOT NULL
        GROUP BY responsible_agent_id
      ), keys AS (SELECT key FROM r UNION SELECT key FROM c UNION SELECT key FROM o)
      SELECT keys.key AS agent,
        COALESCE(r.revenue,0)::float8 AS measured_sourced_revenue,
        COALESCE(c.cost,0)::float8 AS measured_cost,
        COALESCE(o.outcomes,0)::int AS outcome_count,
        o.quality AS measured_quality,
        (COALESCE(r.revenue,0)-COALESCE(c.cost,0))::float8 AS measured_direct_margin
      FROM keys LEFT JOIN r USING(key) LEFT JOIN c USING(key) LEFT JOIN o USING(key)
      ORDER BY measured_cost DESC, outcome_count ASC
      LIMIT 50
    `),
    db.execute(sql`
      SELECT e.id, e.name, e.metric_name, e.status, e.control_cohort,
        o.cohort, o.measurement_class, count(o.id)::int AS observations,
        avg(o.value)::float8 AS average_value,
        stddev_samp(o.value)::float8 AS sample_stddev
      FROM experiments e
      LEFT JOIN experiment_observations o ON o.experiment_id=e.id
        AND o.occurred_at >= now() - (${window.days}::text || ' days')::interval
      WHERE (${tenant}::text IS NULL OR e.tenant_id=${tenant})
      GROUP BY e.id,e.name,e.metric_name,e.status,e.control_cohort,o.cohort,o.measurement_class
      ORDER BY e.created_at DESC, o.cohort
      LIMIT 100
    `),
  ]);

  const money = rows<Record<string, number>>(moneyResult)[0] ?? {};
  const workflows = rows<Record<string, unknown>>(workflowResult);
  const agents = rows<Record<string, unknown>>(agentResult);

  return {
    window,
    tenantId: tenant,
    generatedAt: new Date().toISOString(),
    evidencePolicy: {
      measured: 'Observed from a source event or authoritative business system.',
      estimated: 'Explicit estimate supplied with evidence; never merged into measured totals.',
      inferred: 'Derived from indirect evidence; never merged into measured totals.',
      unknown: 'No defensible numeric assertion is made.',
      roi: 'Measured direct ROI uses measured sourced revenue minus measured cost only; influenced revenue is reported separately.',
    },
    money,
    laborSaved: rows(laborResult),
    accomplishments: rows(eventSummaryResult),
    workflows,
    positiveRoiWorkflows: workflows.filter((row) => typeof row.measured_direct_roi === 'number' && row.measured_direct_roi > 0),
    agents,
    agentsConsumingWithoutMeasuredOutcomes: agents.filter((row) => Number(row.measured_cost ?? 0) > 0 && Number(row.outcome_count ?? 0) === 0),
    experiments: rows(experimentResult),
  };
}

export async function listCanonicalOutcomes(tenantId: string | null, limitValue: unknown) {
  await ensureOutcomeLedgerSchema();
  const limit = Math.min(250, Math.max(1, Number.parseInt(String(limitValue ?? '50'), 10) || 50));
  const tenant = tenantId || null;
  return rows(await db.execute(sql`
    SELECT id,event_id,organization_id,tenant_id,source_system,outcome_type,metric_name,entity_id,trace_id,
      responsible_agent_id,responsible_workflow,baseline,target,measured_result,numeric_baseline,numeric_target,numeric_result,unit,
      measurement_class,confidence,attributed_revenue,influenced_revenue,direct_cost,estimated_labor_saved_hours,human_intervention,
      quality_score,status,evidence,occurred_at
    FROM outcomes
    WHERE (${tenant}::text IS NULL OR tenant_id=${tenant})
    ORDER BY occurred_at DESC LIMIT ${limit}
  `));
}

export async function getAttributionFunnel(tenantId: string | null, windowValue: unknown) {
  await ensureOutcomeLedgerSchema();
  const window = normalizeWindow(windowValue);
  const tenant = tenantId || null;
  const funnelEvents = [
    'lead.sourced','lead.enriched','lead.contacted','lead.responded','lead.qualified','appointment.booked',
    'opportunity.created','revenue.closed','support.resolved','support.deflected','engineering.task.completed',
    'incident.detected','incident.prevented','incident.mitigated','deployment.success',
  ];
  const result = await db.execute(sql`
    SELECT event_type, measurement_class, count(*)::int AS count
    FROM outcome_events
    WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
      AND (${tenant}::text IS NULL OR tenant_id=${tenant})
      AND event_type IN (${sql.join(funnelEvents.map((event) => sql`${event}`), sql`, `)})
    GROUP BY event_type, measurement_class
    ORDER BY event_type, measurement_class
  `);
  return { tenantId: tenant, window, events: rows(result) };
}

export async function listExperiments(tenantId: string | null) {
  await ensureOutcomeLedgerSchema();
  const tenant = tenantId || null;
  const definitions = rows(await db.execute(sql`
    SELECT * FROM experiments WHERE (${tenant}::text IS NULL OR tenant_id=${tenant}) ORDER BY created_at DESC
  `));
  const observations = rows(await db.execute(sql`
    SELECT experiment_id,cohort,metric_name,measurement_class,count(*)::int AS samples,avg(value)::float8 AS average_value,
      stddev_samp(value)::float8 AS sample_stddev,min(occurred_at) AS first_observed_at,max(occurred_at) AS last_observed_at
    FROM experiment_observations
    WHERE (${tenant}::text IS NULL OR tenant_id=${tenant})
    GROUP BY experiment_id,cohort,metric_name,measurement_class
    ORDER BY experiment_id,cohort,measurement_class
  `));
  return { definitions, observations };
}

export async function getBusinessEvaluationEvidence(tenantId: string | null, windowValue: unknown) {
  await ensureOutcomeLedgerSchema();
  const window = normalizeWindow(windowValue);
  const tenant = tenantId || null;
  const result = await db.execute(sql`
    WITH outcome_stats AS (
      SELECT COALESCE(responsible_agent_id,responsible_workflow,'unattributed') AS actor,
        responsible_agent_id, responsible_workflow,
        count(*) FILTER (WHERE measurement_class='MEASURED')::int AS measured_outcomes,
        avg(quality_score) FILTER (WHERE measurement_class='MEASURED' AND quality_score IS NOT NULL)::float8 AS quality,
        avg(CASE WHEN numeric_target IS NOT NULL AND numeric_result IS NOT NULL AND numeric_target <> 0
          THEN LEAST(1.0, GREATEST(0.0, numeric_result / numeric_target)) END)
          FILTER (WHERE measurement_class='MEASURED')::float8 AS target_attainment
      FROM outcomes
      WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
        AND (${tenant}::text IS NULL OR tenant_id=${tenant})
      GROUP BY COALESCE(responsible_agent_id,responsible_workflow,'unattributed'),responsible_agent_id,responsible_workflow
    ), revenue AS (
      SELECT COALESCE(responsible_agent_id,responsible_workflow,'unattributed') AS actor,
        COALESCE(sum(amount) FILTER (WHERE kind='sourced' AND measurement_class='MEASURED'),0)::float8 AS revenue
      FROM revenue_events
      WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
        AND (${tenant}::text IS NULL OR tenant_id=${tenant})
      GROUP BY COALESCE(responsible_agent_id,responsible_workflow,'unattributed')
    ), costs AS (
      SELECT COALESCE(responsible_agent_id,responsible_workflow,'unattributed') AS actor,
        COALESCE(sum(amount) FILTER (WHERE measurement_class='MEASURED'),0)::float8 AS cost
      FROM cost_events
      WHERE occurred_at >= now() - (${window.days}::text || ' days')::interval
        AND (${tenant}::text IS NULL OR tenant_id=${tenant})
      GROUP BY COALESCE(responsible_agent_id,responsible_workflow,'unattributed')
    ), keys AS (SELECT actor FROM outcome_stats UNION SELECT actor FROM revenue UNION SELECT actor FROM costs)
    SELECT keys.actor,o.responsible_agent_id,o.responsible_workflow,COALESCE(o.measured_outcomes,0)::int AS measured_outcomes,
      o.quality,o.target_attainment,COALESCE(r.revenue,0)::float8 AS measured_sourced_revenue,COALESCE(c.cost,0)::float8 AS measured_cost,
      CASE WHEN COALESCE(c.cost,0)>0 THEN ((COALESCE(r.revenue,0)-c.cost)/c.cost)::float8 ELSE NULL END AS measured_direct_roi
    FROM keys LEFT JOIN outcome_stats o USING(actor) LEFT JOIN revenue r USING(actor) LEFT JOIN costs c USING(actor)
    ORDER BY measured_outcomes DESC, actor
  `);
  return { tenantId: tenant, window, rows: rows(result) };
}

-- Outcome Ledger reference analytics
-- These examples intentionally keep MEASURED / ESTIMATED / INFERRED / UNKNOWN
-- separate. Replace :tenant_id and time windows in your SQL client.

-- 1. What did the AI workforce accomplish today?
SELECT event_type, measurement_class, count(*) AS events
FROM outcome_events
WHERE tenant_id = :tenant_id
  AND occurred_at >= date_trunc('day', now())
GROUP BY event_type, measurement_class
ORDER BY events DESC, event_type;

-- 2. How much did it cost? Evidence classes stay separate.
SELECT measurement_class, category, provider, sum(amount) AS cost
FROM cost_events
WHERE tenant_id = :tenant_id
  AND occurred_at >= now() - interval '1 day'
GROUP BY measurement_class, category, provider
ORDER BY measurement_class, cost DESC;

-- 3. What revenue did it source or influence?
SELECT measurement_class, kind, sum(amount) AS revenue
FROM revenue_events
WHERE tenant_id = :tenant_id
  AND occurred_at >= now() - interval '30 days'
GROUP BY measurement_class, kind
ORDER BY measurement_class, kind;

-- 4. How many human hours did it save?
SELECT measurement_class,
       sum(estimated_labor_saved_hours) AS labor_hours,
       count(*) FILTER (WHERE estimated_labor_saved_hours IS NOT NULL) AS samples
FROM outcomes
WHERE tenant_id = :tenant_id
  AND occurred_at >= now() - interval '30 days'
GROUP BY measurement_class;

-- 5. Which workflows prove positive direct ROI?
-- Influenced revenue is intentionally NOT counted as direct revenue.
WITH revenue AS (
  SELECT responsible_workflow,
         sum(amount) FILTER (
           WHERE kind = 'sourced' AND measurement_class = 'MEASURED'
         ) AS sourced_revenue
  FROM revenue_events
  WHERE tenant_id = :tenant_id
    AND occurred_at >= now() - interval '30 days'
    AND responsible_workflow IS NOT NULL
  GROUP BY responsible_workflow
), costs AS (
  SELECT responsible_workflow,
         sum(amount) FILTER (WHERE measurement_class = 'MEASURED') AS cost
  FROM cost_events
  WHERE tenant_id = :tenant_id
    AND occurred_at >= now() - interval '30 days'
    AND responsible_workflow IS NOT NULL
  GROUP BY responsible_workflow
)
SELECT coalesce(r.responsible_workflow, c.responsible_workflow) AS workflow,
       coalesce(r.sourced_revenue, 0) AS measured_sourced_revenue,
       coalesce(c.cost, 0) AS measured_cost,
       coalesce(r.sourced_revenue, 0) - coalesce(c.cost, 0) AS measured_direct_margin,
       CASE WHEN coalesce(c.cost, 0) > 0
            THEN (coalesce(r.sourced_revenue, 0) - c.cost) / c.cost
       END AS measured_direct_roi
FROM revenue r
FULL OUTER JOIN costs c USING (responsible_workflow)
WHERE coalesce(r.sourced_revenue, 0) - coalesce(c.cost, 0) > 0
ORDER BY measured_direct_margin DESC;

-- 6. Which agents consume measured spend without producing measured outcomes?
WITH spend AS (
  SELECT responsible_agent_id, sum(amount) AS measured_cost
  FROM cost_events
  WHERE tenant_id = :tenant_id
    AND occurred_at >= now() - interval '30 days'
    AND measurement_class = 'MEASURED'
    AND responsible_agent_id IS NOT NULL
  GROUP BY responsible_agent_id
), results AS (
  SELECT responsible_agent_id, count(*) AS measured_outcomes
  FROM outcomes
  WHERE tenant_id = :tenant_id
    AND occurred_at >= now() - interval '30 days'
    AND measurement_class = 'MEASURED'
    AND responsible_agent_id IS NOT NULL
  GROUP BY responsible_agent_id
)
SELECT s.responsible_agent_id, s.measured_cost, coalesce(r.measured_outcomes, 0) AS measured_outcomes
FROM spend s
LEFT JOIN results r USING (responsible_agent_id)
WHERE s.measured_cost > 0 AND coalesce(r.measured_outcomes, 0) = 0
ORDER BY s.measured_cost DESC;

-- 7. Control/treatment comparison. Keep evidence class visible.
SELECT e.id AS experiment_id,
       e.name,
       o.metric_name,
       o.cohort,
       o.measurement_class,
       count(*) AS observations,
       avg(o.value) AS average_value,
       stddev_samp(o.value) AS sample_stddev
FROM experiments e
JOIN experiment_observations o ON o.experiment_id = e.id
WHERE e.tenant_id = :tenant_id
GROUP BY e.id, e.name, o.metric_name, o.cohort, o.measurement_class
ORDER BY e.id, o.metric_name, o.cohort, o.measurement_class;

-- 8. Trace one autonomous chain across events/outcomes/economics.
SELECT e.occurred_at,
       e.trace_id,
       e.source_system,
       e.event_type,
       e.responsible_agent_id,
       e.responsible_workflow,
       e.intent,
       o.outcome_type,
       o.metric_name,
       o.measured_result,
       o.measurement_class,
       o.quality_score
FROM outcome_events e
LEFT JOIN outcomes o ON o.event_id = e.id
WHERE e.tenant_id = :tenant_id
  AND e.trace_id = :trace_id
ORDER BY e.occurred_at, e.ingested_at;

-- Revenue and cost for the same trace, kept separate from the event timeline.
SELECT 'revenue' AS fact_type, occurred_at, measurement_class, kind AS category, amount, currency
FROM revenue_events
WHERE tenant_id = :tenant_id AND trace_id = :trace_id
UNION ALL
SELECT 'cost' AS fact_type, occurred_at, measurement_class, category, amount, currency
FROM cost_events
WHERE tenant_id = :tenant_id AND trace_id = :trace_id
ORDER BY occurred_at;

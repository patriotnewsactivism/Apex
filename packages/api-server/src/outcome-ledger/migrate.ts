import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';

let migrationPromise: Promise<void> | null = null;

const ENTITY_TYPES = [
  'Organization','Customer','Lead','Opportunity','Campaign','Conversation','Call','Appointment','Task',
  'AgentRun','WorkflowRun','Deployment','Incident','Approval','Experiment','RevenueEvent','CostEvent','Outcome',
].map((value) => `'${value}'`).join(',');

const MEASUREMENT_CLASSES = "'MEASURED','ESTIMATED','INFERRED','UNKNOWN'";

async function execute(statement: string): Promise<void> {
  await db.execute(sql.raw(statement));
}

async function migrateOutcomeLedger(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS outcome_entities (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      tenant_id text NOT NULL,
      source_system text NOT NULL,
      entity_type text NOT NULL CHECK (entity_type IN (${ENTITY_TYPES})),
      external_id text NOT NULL,
      name text,
      attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, source_system, entity_type, external_id)
    )`,
    `CREATE TABLE IF NOT EXISTS outcome_entity_links (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      tenant_id text NOT NULL,
      from_entity_id text NOT NULL,
      to_entity_id text NOT NULL,
      relationship text NOT NULL,
      source_system text NOT NULL,
      trace_id text,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, from_entity_id, to_entity_id, relationship)
    )`,
    `CREATE TABLE IF NOT EXISTS outcome_events (
      id text PRIMARY KEY,
      idempotency_key text NOT NULL UNIQUE,
      schema_version integer NOT NULL DEFAULT 1,
      organization_id text NOT NULL,
      tenant_id text NOT NULL,
      source_system text NOT NULL,
      event_type text NOT NULL,
      entity_id text,
      entity_type text CHECK (entity_type IS NULL OR entity_type IN (${ENTITY_TYPES})),
      entity_external_id text,
      trace_id text,
      intent text,
      responsible_agent_id text,
      responsible_workflow text,
      agent_run_id text,
      workflow_run_id text,
      human_intervention boolean NOT NULL DEFAULT false,
      measurement_class text NOT NULL DEFAULT 'UNKNOWN' CHECK (measurement_class IN (${MEASUREMENT_CLASSES})),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS outcomes (
      id text PRIMARY KEY,
      event_id text NOT NULL UNIQUE,
      organization_id text NOT NULL,
      tenant_id text NOT NULL,
      source_system text NOT NULL,
      outcome_type text NOT NULL,
      metric_name text NOT NULL,
      entity_id text,
      trace_id text,
      responsible_agent_id text,
      responsible_workflow text,
      baseline jsonb,
      target jsonb,
      measured_result jsonb,
      numeric_baseline double precision,
      numeric_target double precision,
      numeric_result double precision,
      unit text,
      measurement_class text NOT NULL DEFAULT 'UNKNOWN' CHECK (measurement_class IN (${MEASUREMENT_CLASSES})),
      confidence double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      attributed_revenue double precision,
      influenced_revenue double precision,
      direct_cost double precision,
      estimated_labor_saved_hours double precision CHECK (estimated_labor_saved_hours IS NULL OR estimated_labor_saved_hours >= 0),
      human_intervention boolean NOT NULL DEFAULT false,
      quality_score double precision CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
      status text,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS revenue_events (
      id text PRIMARY KEY,
      idempotency_key text NOT NULL UNIQUE,
      organization_id text NOT NULL,
      tenant_id text NOT NULL,
      source_system text NOT NULL,
      source_event_id text,
      customer_external_id text,
      opportunity_external_id text,
      trace_id text,
      responsible_agent_id text,
      responsible_workflow text,
      kind text NOT NULL CHECK (kind IN ('sourced','influenced','recognized','refund')),
      amount double precision NOT NULL,
      currency text NOT NULL DEFAULT 'USD',
      measurement_class text NOT NULL DEFAULT 'UNKNOWN' CHECK (measurement_class IN (${MEASUREMENT_CLASSES})),
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS cost_events (
      id text PRIMARY KEY,
      idempotency_key text NOT NULL UNIQUE,
      organization_id text NOT NULL,
      tenant_id text NOT NULL,
      source_system text NOT NULL,
      source_event_id text,
      trace_id text,
      responsible_agent_id text,
      responsible_workflow text,
      category text NOT NULL CHECK (category IN ('ai_provider','telephony','sms','infra','human_labor','other')),
      provider text,
      amount double precision NOT NULL CHECK (amount >= 0),
      currency text NOT NULL DEFAULT 'USD',
      measurement_class text NOT NULL DEFAULT 'UNKNOWN' CHECK (measurement_class IN (${MEASUREMENT_CLASSES})),
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS experiments (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      tenant_id text NOT NULL,
      name text NOT NULL,
      hypothesis text NOT NULL,
      metric_name text NOT NULL,
      control_cohort text NOT NULL DEFAULT 'control',
      treatment_cohorts jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','completed','stopped')),
      created_by text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      started_at timestamptz,
      ended_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS experiment_assignments (
      id text PRIMARY KEY,
      experiment_id text NOT NULL,
      tenant_id text NOT NULL,
      entity_external_id text NOT NULL,
      entity_type text NOT NULL CHECK (entity_type IN (${ENTITY_TYPES})),
      cohort text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (experiment_id, tenant_id, entity_external_id)
    )`,
    `CREATE TABLE IF NOT EXISTS experiment_observations (
      id text PRIMARY KEY,
      experiment_id text NOT NULL,
      tenant_id text NOT NULL,
      source_event_id text NOT NULL UNIQUE,
      cohort text NOT NULL,
      metric_name text NOT NULL,
      value double precision NOT NULL,
      measurement_class text NOT NULL DEFAULT 'UNKNOWN' CHECK (measurement_class IN (${MEASUREMENT_CLASSES})),
      confidence double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS outcome_audit_log (
      id bigserial PRIMARY KEY,
      organization_id text,
      tenant_id text,
      action text NOT NULL,
      object_type text NOT NULL,
      object_id text,
      actor text,
      trace_id text,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS outcome_events_tenant_time_idx ON outcome_events (tenant_id, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS outcome_events_source_type_idx ON outcome_events (source_system, event_type, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS outcome_events_trace_idx ON outcome_events (trace_id) WHERE trace_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS outcome_events_agent_idx ON outcome_events (responsible_agent_id, occurred_at DESC) WHERE responsible_agent_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS outcome_events_workflow_idx ON outcome_events (responsible_workflow, occurred_at DESC) WHERE responsible_workflow IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS outcomes_tenant_metric_idx ON outcomes (tenant_id, metric_name, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS outcomes_agent_time_idx ON outcomes (responsible_agent_id, occurred_at DESC) WHERE responsible_agent_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS outcomes_workflow_time_idx ON outcomes (responsible_workflow, occurred_at DESC) WHERE responsible_workflow IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS revenue_events_tenant_time_idx ON revenue_events (tenant_id, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS cost_events_tenant_time_idx ON cost_events (tenant_id, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS experiment_observations_experiment_idx ON experiment_observations (experiment_id, cohort, metric_name)`,
    `CREATE OR REPLACE FUNCTION outcome_ledger_reject_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Outcome ledger records are append-only';
      END;
    $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS outcome_events_append_only ON outcome_events`,
    `CREATE TRIGGER outcome_events_append_only BEFORE UPDATE OR DELETE ON outcome_events FOR EACH ROW EXECUTE FUNCTION outcome_ledger_reject_mutation()`,
    `DROP TRIGGER IF EXISTS outcomes_append_only ON outcomes`,
    `CREATE TRIGGER outcomes_append_only BEFORE UPDATE OR DELETE ON outcomes FOR EACH ROW EXECUTE FUNCTION outcome_ledger_reject_mutation()`,
    `DROP TRIGGER IF EXISTS revenue_events_append_only ON revenue_events`,
    `CREATE TRIGGER revenue_events_append_only BEFORE UPDATE OR DELETE ON revenue_events FOR EACH ROW EXECUTE FUNCTION outcome_ledger_reject_mutation()`,
    `DROP TRIGGER IF EXISTS cost_events_append_only ON cost_events`,
    `CREATE TRIGGER cost_events_append_only BEFORE UPDATE OR DELETE ON cost_events FOR EACH ROW EXECUTE FUNCTION outcome_ledger_reject_mutation()`,
    `DROP TRIGGER IF EXISTS experiment_observations_append_only ON experiment_observations`,
    `CREATE TRIGGER experiment_observations_append_only BEFORE UPDATE OR DELETE ON experiment_observations FOR EACH ROW EXECUTE FUNCTION outcome_ledger_reject_mutation()`,
  ];

  for (const statement of statements) await execute(statement);

  // Existing APEX execution evidence is mirrored into the canonical ledger.
  // Money and labor savings are intentionally absent: these triggers only copy
  // facts that the source tables actually know.
  await execute(`CREATE OR REPLACE FUNCTION mirror_task_outcome_to_ledger() RETURNS trigger AS $$
    DECLARE
      v_project text;
      v_org text := COALESCE(current_setting('apex.organization_id', true), 'apex');
      v_event_id text := 'apex-task-outcome-' || NEW.id::text;
      v_entity_id text := 'apex-task-' || md5(NEW.task_id);
    BEGIN
      SELECT COALESCE(g.project_id, 'apex') INTO v_project
      FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id
      WHERE t.id = NEW.task_id;
      v_project := COALESCE(v_project, 'apex');

      INSERT INTO outcome_entities (id, organization_id, tenant_id, source_system, entity_type, external_id, name, attributes)
      SELECT v_entity_id, v_org, v_project, 'apex', 'Task', NEW.task_id, t.title, jsonb_build_object('role', NEW.role)
      FROM tasks t WHERE t.id = NEW.task_id
      ON CONFLICT (tenant_id, source_system, entity_type, external_id)
      DO UPDATE SET last_seen_at = now(), attributes = outcome_entities.attributes || EXCLUDED.attributes;

      INSERT INTO outcome_events (
        id,idempotency_key,schema_version,organization_id,tenant_id,source_system,event_type,entity_id,entity_type,entity_external_id,
        trace_id,responsible_agent_id,responsible_workflow,human_intervention,measurement_class,payload,occurred_at
      ) VALUES (
        v_event_id,v_event_id,1,v_org,v_project,'apex',CASE WHEN NEW.success THEN 'engineering.task.completed' ELSE 'engineering.task.failed' END,
        v_entity_id,'Task',NEW.task_id,NEW.task_id,NEW.agent_id,'agent-task-execution',NEW.required_approvals > 0,'MEASURED',
        jsonb_build_object('durationMs',NEW.duration_ms,'role',NEW.role,'toolExecutions',NEW.tool_executions,'llmCalls',NEW.llm_calls,'iterations',NEW.iterations,'errorType',NEW.error_type),NEW.recorded_at
      ) ON CONFLICT (idempotency_key) DO NOTHING;

      INSERT INTO outcomes (
        id,event_id,organization_id,tenant_id,source_system,outcome_type,metric_name,entity_id,trace_id,responsible_agent_id,responsible_workflow,
        baseline,target,measured_result,numeric_baseline,numeric_target,numeric_result,unit,measurement_class,confidence,human_intervention,quality_score,status,evidence,occurred_at
      ) VALUES (
        'outcome-' || v_event_id,v_event_id,v_org,v_project,'apex','task_execution','task_success',v_entity_id,NEW.task_id,NEW.agent_id,'agent-task-execution',
        '0'::jsonb,'1'::jsonb,to_jsonb(CASE WHEN NEW.success THEN 1 ELSE 0 END),0,1,CASE WHEN NEW.success THEN 1 ELSE 0 END,'boolean','MEASURED',1.0,
        NEW.required_approvals > 0,NEW.quality_score,CASE WHEN NEW.success THEN 'succeeded' ELSE 'failed' END,jsonb_build_object('taskOutcomeId',NEW.id),NEW.recorded_at
      ) ON CONFLICT (event_id) DO NOTHING;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await execute(`DROP TRIGGER IF EXISTS task_outcomes_to_outcome_ledger ON task_outcomes`);
  await execute(`CREATE TRIGGER task_outcomes_to_outcome_ledger AFTER INSERT ON task_outcomes FOR EACH ROW EXECUTE FUNCTION mirror_task_outcome_to_ledger()`);

  await execute(`CREATE OR REPLACE FUNCTION mirror_researched_lead_to_ledger() RETURNS trigger AS $$
    DECLARE
      v_tenant text;
      v_org text := COALESCE(current_setting('apex.organization_id', true), 'apex');
      v_entity_id text := 'apex-lead-' || md5(NEW.id);
      v_event_type text;
      v_key text;
    BEGIN
      SELECT COALESCE(project_id, 'buildmybot') INTO v_tenant FROM lead_campaigns WHERE id = NEW.campaign_id;
      v_tenant := COALESCE(v_tenant, 'buildmybot');
      INSERT INTO outcome_entities (id,organization_id,tenant_id,source_system,entity_type,external_id,name,attributes)
      VALUES (v_entity_id,v_org,v_tenant,'apex','Lead',NEW.id,NEW.company_name,jsonb_build_object('website',NEW.website,'campaignId',NEW.campaign_id,'status',NEW.status,'contactResearchStatus',NEW.contact_research_status))
      ON CONFLICT (tenant_id, source_system, entity_type, external_id)
      DO UPDATE SET last_seen_at=now(), name=EXCLUDED.name, attributes=outcome_entities.attributes || EXCLUDED.attributes;

      IF TG_OP = 'INSERT' THEN
        v_event_type := 'lead.sourced';
        v_key := 'apex-lead-sourced-' || NEW.id;
      ELSIF NEW.contact_research_status IS DISTINCT FROM OLD.contact_research_status THEN
        v_event_type := 'lead.enriched';
        v_key := 'apex-lead-enriched-' || NEW.id || '-' || NEW.contact_research_status;
      ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        v_event_type := 'lead.' || NEW.status;
        v_key := 'apex-lead-status-' || NEW.id || '-' || NEW.status;
      ELSE
        RETURN NEW;
      END IF;

      INSERT INTO outcome_events (id,idempotency_key,schema_version,organization_id,tenant_id,source_system,event_type,entity_id,entity_type,entity_external_id,responsible_agent_id,responsible_workflow,human_intervention,measurement_class,payload,occurred_at)
      VALUES (v_key,v_key,1,v_org,v_tenant,'apex',v_event_type,v_entity_id,'Lead',NEW.id,NEW.researched_by_agent_id,'lead-research',false,'MEASURED',jsonb_build_object('campaignId',NEW.campaign_id,'status',NEW.status,'contactResearchStatus',NEW.contact_research_status),now())
      ON CONFLICT (idempotency_key) DO NOTHING;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await execute(`DROP TRIGGER IF EXISTS researched_leads_to_outcome_ledger ON researched_leads`);
  await execute(`CREATE TRIGGER researched_leads_to_outcome_ledger AFTER INSERT OR UPDATE ON researched_leads FOR EACH ROW EXECUTE FUNCTION mirror_researched_lead_to_ledger()`);

  await execute(`CREATE OR REPLACE FUNCTION mirror_deployment_to_ledger() RETURNS trigger AS $$
    DECLARE
      v_org text := COALESCE(current_setting('apex.organization_id', true), 'apex');
      v_tenant text := 'apex';
      v_entity_id text := 'apex-deployment-' || md5(NEW.id);
      v_key text;
    BEGIN
      v_key := 'apex-deployment-' || NEW.id || '-' || NEW.status;
      INSERT INTO outcome_entities (id,organization_id,tenant_id,source_system,entity_type,external_id,name,attributes)
      VALUES (v_entity_id,v_org,v_tenant,'apex','Deployment',NEW.id,NEW.platform,jsonb_build_object('environment',NEW.environment,'url',NEW.deployment_url,'rolledBack',NEW.rolled_back))
      ON CONFLICT (tenant_id,source_system,entity_type,external_id)
      DO UPDATE SET last_seen_at=now(), attributes=outcome_entities.attributes || EXCLUDED.attributes;
      INSERT INTO outcome_events (id,idempotency_key,schema_version,organization_id,tenant_id,source_system,event_type,entity_id,entity_type,entity_external_id,responsible_workflow,human_intervention,measurement_class,payload,occurred_at)
      VALUES (v_key,v_key,1,v_org,v_tenant,'apex','deployment.' || NEW.status,v_entity_id,'Deployment',NEW.id,'cicd',false,'MEASURED',jsonb_build_object('platform',NEW.platform,'environment',NEW.environment,'rolledBack',NEW.rolled_back,'error',NEW.error),NEW.deployed_at)
      ON CONFLICT (idempotency_key) DO NOTHING;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await execute(`DROP TRIGGER IF EXISTS deployments_to_outcome_ledger ON deployments`);
  await execute(`CREATE TRIGGER deployments_to_outcome_ledger AFTER INSERT OR UPDATE OF status, rolled_back ON deployments FOR EACH ROW EXECUTE FUNCTION mirror_deployment_to_ledger()`);
}

export function ensureOutcomeLedgerSchema(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateOutcomeLedger().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

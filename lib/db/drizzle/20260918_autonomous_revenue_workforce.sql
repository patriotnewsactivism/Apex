-- APEX Autonomous Revenue Workforce loop.
-- Additive migration for durable per-prospect strategy and per-step idempotency.

CREATE TABLE IF NOT EXISTS outreach_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  enrollment_id uuid,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'ready',
  objective text NOT NULL,
  pain_hypothesis text NOT NULL,
  value_proposition text NOT NULL,
  opening_angle text NOT NULL,
  channel_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  personalization jsonb NOT NULL DEFAULT '{}'::jsonb,
  qualification_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_best_action text NOT NULL,
  confidence real NOT NULL DEFAULT 0.5,
  source text NOT NULL DEFAULT 'deterministic',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS outreach_strategies_org_campaign_contact_unique
  ON outreach_strategies (organization_id, campaign_id, contact_id);
CREATE INDEX IF NOT EXISTS outreach_strategies_contact_id_idx ON outreach_strategies (contact_id);
CREATE INDEX IF NOT EXISTS outreach_strategies_campaign_id_idx ON outreach_strategies (campaign_id);
CREATE INDEX IF NOT EXISTS outreach_strategies_status_idx ON outreach_strategies (status);

CREATE TABLE IF NOT EXISTS sequence_step_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  enrollment_id uuid NOT NULL,
  step_id uuid NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  interaction_id uuid,
  result jsonb,
  error text,
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sequence_step_executions_idempotency_unique
  ON sequence_step_executions (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS sequence_step_executions_enrollment_step_unique
  ON sequence_step_executions (organization_id, enrollment_id, step_id);
CREATE INDEX IF NOT EXISTS sequence_step_executions_due_idx
  ON sequence_step_executions (status, scheduled_at);
CREATE INDEX IF NOT EXISTS sequence_step_executions_enrollment_id_idx
  ON sequence_step_executions (enrollment_id);

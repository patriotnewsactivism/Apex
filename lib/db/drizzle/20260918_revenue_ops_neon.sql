-- APEX Revenue Ops / Neon schema alignment
-- Validated on Neon branch apex-migration-validation-2026-09-18.
-- Generated from lib/db/src/schema-revenue-ops.ts.
-- Safe characteristics: additive CREATE TABLE/INDEX IF NOT EXISTS only.
-- Do NOT replace text organization/mission/task ids with UUIDs.

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  name varchar(255) NOT NULL,
  domain varchar(255),
  website text,
  industry varchar(100),
  employee_count integer,
  estimated_revenue numeric(12,2),
  address jsonb,
  linkedin_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_organization_id_idx ON companies (organization_id);
CREATE INDEX IF NOT EXISTS companies_domain_idx ON companies (domain);
CREATE INDEX IF NOT EXISTS companies_name_idx ON companies (name);
CREATE INDEX IF NOT EXISTS companies_industry_idx ON companies (industry);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  company_id uuid,
  first_name varchar(100),
  last_name varchar(100),
  title varchar(200),
  email varchar(255),
  phone_e164 varchar(20),
  phone_type text,
  timezone varchar(50),
  location jsonb,
  source text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_organization_id_idx ON contacts (organization_id);
CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON contacts (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique
  ON contacts (organization_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_phone_unique
  ON contacts (organization_id, phone_e164) WHERE phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  consent_type text,
  scope text,
  source text,
  evidence jsonb,
  granted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS consent_records_org_contact_channel_unique
  ON consent_records (organization_id, contact_id, channel);
CREATE INDEX IF NOT EXISTS consent_records_status_idx ON consent_records (status);

CREATE TABLE IF NOT EXISTS suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid,
  email varchar(255),
  phone_e164 varchar(20),
  channel text NOT NULL,
  reason text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_org_channel_unique
  ON suppressions (organization_id, channel)
  WHERE contact_id IS NULL AND email IS NULL AND phone_e164 IS NULL;
CREATE INDEX IF NOT EXISTS suppressions_contact_id_idx ON suppressions (contact_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text,
  name varchar(200) NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  audience_filter jsonb,
  daily_limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS campaigns_organization_id_idx ON campaigns (organization_id);
CREATE INDEX IF NOT EXISTS campaigns_mission_id_idx ON campaigns (mission_id);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns (status);

CREATE TABLE IF NOT EXISTS sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  name varchar(200) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sequences_campaign_id_idx ON sequences (campaign_id);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id uuid NOT NULL,
  position integer NOT NULL,
  channel text NOT NULL,
  delay_seconds integer NOT NULL DEFAULT 0,
  condition jsonb,
  template_id uuid,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sequence_steps_sequence_id_idx ON sequence_steps (sequence_id);
CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_sequence_position_unique
  ON sequence_steps (sequence_id, position);

CREATE TABLE IF NOT EXISTS campaign_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  current_step_id uuid,
  next_action_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  stop_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_enrollments_org_campaign_contact_unique
  ON campaign_enrollments (organization_id, campaign_id, contact_id);
CREATE INDEX IF NOT EXISTS campaign_enrollments_campaign_id_idx ON campaign_enrollments (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_enrollments_contact_id_idx ON campaign_enrollments (contact_id);
CREATE INDEX IF NOT EXISTS campaign_enrollments_status_idx ON campaign_enrollments (status);

CREATE TABLE IF NOT EXISTS interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text,
  campaign_id uuid,
  contact_id uuid,
  company_id uuid,
  channel text NOT NULL,
  direction text NOT NULL,
  type text,
  provider text,
  external_id text,
  status text,
  subject varchar(500),
  body_summary text,
  structured_outcome jsonb,
  occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interactions_organization_id_idx ON interactions (organization_id);
CREATE INDEX IF NOT EXISTS interactions_mission_id_idx ON interactions (mission_id);
CREATE INDEX IF NOT EXISTS interactions_campaign_id_idx ON interactions (campaign_id);
CREATE INDEX IF NOT EXISTS interactions_contact_id_idx ON interactions (contact_id);
CREATE INDEX IF NOT EXISTS interactions_channel_direction_idx ON interactions (channel, direction);
CREATE INDEX IF NOT EXISTS interactions_occurred_at_idx ON interactions (occurred_at);

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text,
  campaign_id uuid,
  contact_id uuid,
  provider_connection_id uuid,
  external_call_id text,
  call_control_id text,
  call_session_id text,
  from_number varchar(20),
  to_number varchar(20),
  direction text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  disposition text,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  recording_uri text,
  transcript_id uuid,
  ai_provider text,
  cost_cents integer,
  error_code text,
  error_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calls_organization_id_idx ON calls (organization_id);
CREATE INDEX IF NOT EXISTS calls_mission_id_idx ON calls (mission_id);
CREATE INDEX IF NOT EXISTS calls_campaign_id_idx ON calls (campaign_id);
CREATE INDEX IF NOT EXISTS calls_contact_id_idx ON calls (contact_id);
CREATE INDEX IF NOT EXISTS calls_status_idx ON calls (status);
CREATE INDEX IF NOT EXISTS calls_disposition_idx ON calls (disposition);
CREATE UNIQUE INDEX IF NOT EXISTS calls_external_call_id_unique
  ON calls (external_call_id) WHERE external_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received',
  attempt_count integer NOT NULL DEFAULT 1,
  last_error jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_events_provider_event_id_unique
  ON provider_events (provider, external_event_id);
CREATE INDEX IF NOT EXISTS provider_events_status_idx ON provider_events (status);

CREATE TABLE IF NOT EXISTS calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  provider text NOT NULL,
  external_account_id text,
  encrypted_credentials jsonb NOT NULL,
  status text NOT NULL DEFAULT 'connected',
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_connections_organization_id_idx
  ON calendar_connections (organization_id);

CREATE TABLE IF NOT EXISTS meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text,
  contact_id uuid,
  provider text,
  external_event_id text,
  title varchar(500) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  meeting_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meetings_organization_id_idx ON meetings (organization_id);
CREATE INDEX IF NOT EXISTS meetings_contact_id_idx ON meetings (contact_id);
CREATE INDEX IF NOT EXISTS meetings_status_idx ON meetings (status);

CREATE TABLE IF NOT EXISTS meeting_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'attendee',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_attendees_meeting_id_idx ON meeting_attendees (meeting_id);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_attendees_meeting_contact_unique
  ON meeting_attendees (meeting_id, contact_id);

CREATE TABLE IF NOT EXISTS availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid,
  rule jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS availability_rules_organization_id_idx ON availability_rules (organization_id);
CREATE INDEX IF NOT EXISTS availability_rules_contact_id_idx ON availability_rules (contact_id);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  name varchar(100) NOT NULL,
  position integer NOT NULL,
  type text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_stages_organization_id_idx ON pipeline_stages (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_org_position_unique
  ON pipeline_stages (organization_id, position);

-- Existing table: schema-alignment indexes.
CREATE INDEX IF NOT EXISTS sales_opportunities_organization_id_idx
  ON sales_opportunities (organization_id);
CREATE INDEX IF NOT EXISTS sales_opportunities_contact_id_idx
  ON sales_opportunities (contact_id);
CREATE INDEX IF NOT EXISTS sales_opportunities_company_id_idx
  ON sales_opportunities (company_id);
CREATE INDEX IF NOT EXISTS sales_opportunities_stage_id_idx
  ON sales_opportunities (stage_id);
CREATE INDEX IF NOT EXISTS sales_opportunities_mission_id_idx
  ON sales_opportunities (mission_id);
CREATE INDEX IF NOT EXISTS sales_opportunities_status_idx
  ON sales_opportunities (status);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  type text NOT NULL,
  name varchar(200) NOT NULL,
  uri text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_organization_id_idx ON knowledge_sources (organization_id);
CREATE INDEX IF NOT EXISTS knowledge_sources_type_idx ON knowledge_sources (type);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  content_hash varchar(64),
  title varchar(500),
  text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_documents_source_id_idx ON knowledge_documents (source_id);
CREATE INDEX IF NOT EXISTS knowledge_documents_content_hash_idx ON knowledge_documents (content_hash);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  text text NOT NULL,
  embedding jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document_id_idx ON knowledge_chunks (document_id);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text,
  task_id text,
  provider text NOT NULL,
  category text NOT NULL,
  quantity numeric(12,4),
  unit text,
  amount_cents integer NOT NULL DEFAULT 0,
  external_reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_ledger_organization_id_idx ON usage_ledger (organization_id);
CREATE INDEX IF NOT EXISTS usage_ledger_mission_id_idx ON usage_ledger (mission_id);
CREATE INDEX IF NOT EXISTS usage_ledger_provider_idx ON usage_ledger (provider);
CREATE INDEX IF NOT EXISTS usage_ledger_category_idx ON usage_ledger (category);
CREATE INDEX IF NOT EXISTS usage_ledger_created_at_idx ON usage_ledger (created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_organization_id_idx ON audit_events (organization_id);
CREATE INDEX IF NOT EXISTS audit_events_actor_type_idx ON audit_events (actor_type);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action);
CREATE INDEX IF NOT EXISTS audit_events_entity_type_idx ON audit_events (entity_type);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_entity_unique
  ON audit_events (entity_type, entity_id)
  WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_outreach_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid NOT NULL,
  channel text NOT NULL,
  gate text NOT NULL DEFAULT 'pending',
  last_checked_at timestamptz,
  next_review_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_outreach_gates_org_contact_channel_unique
  ON contact_outreach_gates (organization_id, contact_id, channel);
CREATE INDEX IF NOT EXISTS contact_outreach_gates_gate_idx ON contact_outreach_gates (gate);

CREATE TABLE IF NOT EXISTS suppression_propagation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  source_suppression_id uuid NOT NULL,
  target_channel text NOT NULL,
  target_identifier text,
  action text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suppression_propagation_source_suppression_id_idx
  ON suppression_propagation (source_suppression_id);

CREATE TABLE IF NOT EXISTS consent_audit_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  scope text NOT NULL,
  scope_ref text,
  status text NOT NULL DEFAULT 'running',
  contacts_reviewed integer NOT NULL DEFAULT 0,
  contacts_compliant integer NOT NULL DEFAULT 0,
  contacts_non_compliant integer NOT NULL DEFAULT 0,
  findings jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consent_audit_snapshots_organization_id_idx
  ON consent_audit_snapshots (organization_id);
CREATE INDEX IF NOT EXISTS consent_audit_snapshots_scope_idx
  ON consent_audit_snapshots (scope);
CREATE INDEX IF NOT EXISTS consent_audit_snapshots_status_idx
  ON consent_audit_snapshots (status);

CREATE TABLE IF NOT EXISTS mission_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text NOT NULL,
  position integer NOT NULL,
  name varchar(200) NOT NULL,
  description text,
  channel text,
  status text NOT NULL DEFAULT 'pending',
  task_id text,
  outcome jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mission_steps_organization_id_idx ON mission_steps (organization_id);
CREATE INDEX IF NOT EXISTS mission_steps_mission_id_idx ON mission_steps (mission_id);
CREATE INDEX IF NOT EXISTS mission_steps_position_idx ON mission_steps (position);
CREATE INDEX IF NOT EXISTS mission_steps_status_idx ON mission_steps (status);

-- CRM schema repair, applied last.
--
-- Why this exists: the phase-1 migration left production with `contacts.lifecycle_stage`
-- and the lifted-opt-out columns applied, but `crm_tasks` missing, so the dashboard's
-- due list answered 500 while the rest of phase 1 worked. `applyCrmMigration` ran the
-- statements one at a time with no transaction and no verification, so a statement that
-- failed stopped everything after it and nothing said so.
--
-- Two fixes, both here and in lib/db/src/crm-migration.ts: every CRM table the phases
-- create is re-asserted idempotently, and the applier now refuses to boot a half-applied
-- CRM schema instead of serving one.
--
-- Deliberately plain: one statement per object, no DO blocks, so nothing can be merged
-- or mis-split, and every statement is safe to re-run.

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid,
  company_id uuid,
  opportunity_id uuid,
  kind text NOT NULL DEFAULT 'follow_up',
  title text NOT NULL,
  notes text,
  due_at timestamptz,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'open',
  assigned_to text,
  created_by text NOT NULL,
  completed_at timestamptz,
  completed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE INDEX IF NOT EXISTS crm_tasks_status_due_idx ON crm_tasks (organization_id, status, due_at);

-- STATEMENT
CREATE INDEX IF NOT EXISTS crm_tasks_contact_idx ON crm_tasks (contact_id);

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_lead_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  status text NOT NULL DEFAULT 'applied',
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  matched integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  undone_by text,
  undone_at timestamptz,
  notes text
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_lead_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  lead_id text NOT NULL,
  contact_id uuid,
  outcome text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE INDEX IF NOT EXISTS crm_lead_import_rows_batch_idx ON crm_lead_import_rows (batch_id);

-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS crm_lead_import_rows_batch_lead_unique ON crm_lead_import_rows (batch_id, lead_id);

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_migration_markers (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_contact_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid NOT NULL,
  summary text NOT NULL,
  next_step text NOT NULL,
  model text,
  source_events integer NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by text NOT NULL
);

-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS crm_contact_insights_contact_unique ON crm_contact_insights (contact_id);

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  name varchar(80) NOT NULL,
  scope varchar(20) NOT NULL DEFAULT 'contacts',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  pinned boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS crm_saved_views_org_scope_name_unique ON crm_saved_views (organization_id, scope, lower(name));

-- The columns the phases add, re-asserted so a partially applied run is completed by
-- the next boot rather than staying half-done.
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifecycle_stage text NOT NULL DEFAULT 'prospect';

-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifecycle_stage_changed_at timestamptz;

-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifecycle_stage_changed_by text;

-- STATEMENT
CREATE INDEX IF NOT EXISTS contacts_lifecycle_stage_idx ON contacts (organization_id, lifecycle_stage);

-- STATEMENT
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS lifted_at timestamptz;

-- STATEMENT
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS lifted_by text;

-- STATEMENT
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS lift_reason text;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS expected_close_at timestamptz;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS won_reason text;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS lost_reason text;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS next_step text;

-- STATEMENT
CREATE INDEX IF NOT EXISTS sales_opportunities_org_status_close_idx ON sales_opportunities (organization_id, status, expected_close_at);

-- The pipeline stages the board seeds, re-asserted the same way. Only empty positions
-- are filled, so a stage the operator renamed or added is left alone.
-- STATEMENT
INSERT INTO pipeline_stages (organization_id, name, position, type, metadata)
SELECT 'apex', seed.name, seed.position, 'opportunity', '{"seeded":"20261014_crm_repair"}'::jsonb
FROM (VALUES ('Qualified', 1), ('Proposal sent', 2), ('Negotiation', 3), ('Verbal yes', 4)) AS seed(name, position)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages existing
  WHERE existing.organization_id = 'apex' AND existing.position = seed.position
);
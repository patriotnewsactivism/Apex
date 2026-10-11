-- CRM phase 1: the parts you work in daily.
--
-- Adds a client status (lifecycle stage) to every contact, follow-up tasks,
-- a reviewed/undoable copy of researched leads into the contact book, and the
-- columns that let a single opt-out be lifted from the dashboard.
--
-- Additive only: no DROP TABLE, no DROP COLUMN, no data loss. Applied by
-- applyCrmMigration() at the end of the boot migration, so every statement is
-- idempotent and safe to re-run on a database that already has it.

-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifecycle_stage text NOT NULL DEFAULT 'prospect';

-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifecycle_stage_changed_at timestamptz;

-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifecycle_stage_changed_by text;

-- STATEMENT
CREATE INDEX IF NOT EXISTS contacts_lifecycle_stage_idx
  ON contacts (organization_id, lifecycle_stage);

-- STATEMENT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_lifecycle_stage_check') THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_lifecycle_stage_check
      CHECK (lifecycle_stage IN ('prospect', 'lead', 'qualified', 'client', 'churned'));
  END IF;
END $$;

-- One-time marker table. A migration statement runs on every boot, so anything
-- that must happen exactly once (a backfill that must not re-promote a contact
-- the operator deliberately demoted) records a marker instead of guessing from
-- the data.
-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_migration_markers (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill, exactly once: a contact already reached by a send, a call or a
-- reply is at least a lead, not a bare prospect. Contacts with no history stay
-- 'prospect'. The marker keeps this from re-running and undoing a manual edit.
-- STATEMENT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crm_migration_markers WHERE name = '20261011_crm_phase1_lifecycle_backfill') THEN
    UPDATE contacts
       SET lifecycle_stage = 'lead',
           lifecycle_stage_changed_at = now(),
           lifecycle_stage_changed_by = 'migration:20261011_crm_phase1'
     WHERE lifecycle_stage = 'prospect'
       AND (last_contacted_at IS NOT NULL OR last_reply_at IS NOT NULL);
    INSERT INTO crm_migration_markers (name) VALUES ('20261011_crm_phase1_lifecycle_backfill');
  END IF;
END $$;

-- A lifted opt-out. The row is kept, never deleted: the opt-out happened, and
-- the history has to show that it was recorded and then lifted by the operator.
-- Suppression checks ignore a row whose lifted_at is set.
-- STATEMENT
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS lifted_at timestamptz;

-- STATEMENT
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS lifted_by text;

-- STATEMENT
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS lift_reason text;

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
CREATE INDEX IF NOT EXISTS crm_tasks_status_due_idx
  ON crm_tasks (organization_id, status, due_at);

-- STATEMENT
CREATE INDEX IF NOT EXISTS crm_tasks_contact_idx
  ON crm_tasks (contact_id);

-- STATEMENT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_tasks_status_check') THEN
    ALTER TABLE crm_tasks
      ADD CONSTRAINT crm_tasks_status_check
      CHECK (status IN ('open', 'done', 'cancelled'));
  END IF;
END $$;

-- STATEMENT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_tasks_priority_check') THEN
    ALTER TABLE crm_tasks
      ADD CONSTRAINT crm_tasks_priority_check
      CHECK (priority IN ('low', 'normal', 'high'));
  END IF;
END $$;

-- One row per reviewed copy of researched leads into the contact book. The
-- batch is what makes the copy undoable: undo deletes only the contacts this
-- batch created and only while they are still untouched.
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
  -- researched_leads.id is text, not uuid. Matching its type is what keeps the
  -- link honest; a cast here would silently drop rows whose ids are not uuids.
  lead_id text NOT NULL,
  contact_id uuid,
  outcome text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE INDEX IF NOT EXISTS crm_lead_import_rows_batch_idx
  ON crm_lead_import_rows (batch_id);

-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS crm_lead_import_rows_batch_lead_unique
  ON crm_lead_import_rows (batch_id, lead_id);

-- STATEMENT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_lead_import_rows_outcome_check') THEN
    ALTER TABLE crm_lead_import_rows
      ADD CONSTRAINT crm_lead_import_rows_outcome_check
      CHECK (outcome IN ('created', 'matched', 'skipped'));
  END IF;
END $$;

-- STATEMENT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_lead_imports_status_check') THEN
    ALTER TABLE crm_lead_imports
      ADD CONSTRAINT crm_lead_imports_status_check
      CHECK (status IN ('applied', 'undone'));
  END IF;
END $$;
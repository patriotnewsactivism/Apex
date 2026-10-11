-- CRM phase 3: the intelligence layer.
--
-- A cached read on a contact (what happened, and the next step), saved filter
-- views, and nothing else: lead scoring and the reports are computed from the
-- records that already exist rather than stored, so a score can never drift
-- from the history it is derived from. Additive only, and safe to re-run on the
-- boot migration.

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_contact_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid NOT NULL,
  summary text NOT NULL,
  next_step text NOT NULL,
  model text,
  -- How many history rows the summary was built from. A later count that is
  -- higher means the summary is stale and says so, instead of quietly going
  -- out of date.
  source_events integer NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by text NOT NULL
);

-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS crm_contact_insights_contact_unique
  ON crm_contact_insights (contact_id);

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
CREATE UNIQUE INDEX IF NOT EXISTS crm_saved_views_org_scope_name_unique
  ON crm_saved_views (organization_id, scope, lower(name));

-- STATEMENT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_saved_views_scope_check') THEN
    ALTER TABLE crm_saved_views
      ADD CONSTRAINT crm_saved_views_scope_check
      CHECK (scope IN ('contacts', 'leads', 'deals', 'companies'));
  END IF;
END $$;
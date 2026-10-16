-- CRM phase 3: marketing-tool integrations.
--
-- The encrypted provider_connections table already existed but nothing wrote a
-- marketing audience through it. This adds the sync history so a push to
-- Mailchimp / Klaviyo / Active Campaign / HubSpot is auditable ("last sync: 42
-- pushed, 3 skipped"), rather than only a bare "connected" flag. Additive only:
-- nothing existing is removed, and every statement is safe to re-run on boot.

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_marketing_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  provider text NOT NULL,
  connection_id uuid,
  direction text NOT NULL DEFAULT 'push',
  status text NOT NULL DEFAULT 'ok',
  audience text,
  pushed integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  error text,
  created_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- STATEMENT
CREATE INDEX IF NOT EXISTS crm_marketing_syncs_org_provider_idx
  ON crm_marketing_syncs (organization_id, provider, started_at);

-- STATEMENT
CREATE INDEX IF NOT EXISTS crm_marketing_syncs_status_idx
  ON crm_marketing_syncs (status);

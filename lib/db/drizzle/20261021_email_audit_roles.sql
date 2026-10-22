-- APEX email audit gateway, migration 2 of 2: least-privilege roles.
-- Not applied by this PR. Requires approval #3. Roles are NOLOGIN; the
-- operator creates a LOGIN user and sets its password out of band (never in
-- this file, never in git) and grants it membership.

BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apex_audit_writer') THEN
    CREATE ROLE apex_audit_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apex_audit_reader') THEN
    CREATE ROLE apex_audit_reader NOLOGIN;
  END IF;
END $$;

-- Writer: INSERT only, plus the minimum SELECT needed to read the chain tail.
REVOKE ALL ON outbound_audit, email_events FROM apex_audit_writer;
GRANT INSERT ON outbound_audit TO apex_audit_writer;
GRANT SELECT (id, seq, row_hash, chain_version, provider, provider_id) ON outbound_audit TO apex_audit_writer;
GRANT INSERT ON email_events TO apex_audit_writer;
GRANT SELECT (provider, provider_event_id) ON email_events TO apex_audit_writer;
GRANT USAGE ON SEQUENCE outbound_audit_seq TO apex_audit_writer;
GRANT INSERT ON email_reconciliation_runs, email_reconciliation_findings TO apex_audit_writer;

-- Reader: dashboard, reconciliation reads, nightly export.
GRANT SELECT ON outbound_audit, email_events, email_reconciliation_runs, email_reconciliation_findings TO apex_audit_reader;

-- Nobody but the owner may UPDATE/DELETE/TRUNCATE; the triggers block the owner too.
REVOKE UPDATE, DELETE, TRUNCATE ON outbound_audit, email_events FROM PUBLIC;

COMMIT;

-- Operator step (approval #3), run interactively, password from a secret manager:
--   CREATE ROLE apex_audit_gateway LOGIN PASSWORD :'pw' IN ROLE apex_audit_writer;
--   CREATE ROLE apex_audit_viewer  LOGIN PASSWORD :'pw' IN ROLE apex_audit_reader;

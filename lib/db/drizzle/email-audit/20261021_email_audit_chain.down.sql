-- Rollback for 20261021_email_audit_chain.sql + roles. Run only with approval.
-- Export outbound_audit/email_events to Drive BEFORE running (evidence).
-- Legacy rows and their original columns are never touched by up or down.
BEGIN;
DROP TRIGGER IF EXISTS outbound_audit_chain_check ON outbound_audit;
DROP TRIGGER IF EXISTS outbound_audit_no_update ON outbound_audit;
DROP TRIGGER IF EXISTS outbound_audit_no_truncate ON outbound_audit;
DROP TRIGGER IF EXISTS email_events_no_update ON email_events;
DROP FUNCTION IF EXISTS outbound_audit_check_chain();
DROP FUNCTION IF EXISTS outbound_audit_block_mutation();
-- New columns are left in place (nullable, unused by old code) so chained
-- evidence is preserved; dropping them is a separate, explicit decision.
-- email_events / reconciliation tables: rename instead of drop to keep evidence.
ALTER TABLE IF EXISTS email_reconciliation_findings RENAME TO email_reconciliation_findings_retired;
ALTER TABLE IF EXISTS email_reconciliation_runs RENAME TO email_reconciliation_runs_retired;
ALTER TABLE IF EXISTS email_events RENAME TO email_events_retired;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM apex_audit_writer, apex_audit_reader;
COMMIT;
-- Then, if desired: DROP ROLE apex_audit_writer; DROP ROLE apex_audit_reader;

-- APEX email audit gateway (memo Option 3), migration 1 of 2.
-- ADDITIVE ONLY. Not applied by any code path in this PR; an operator runs it
-- after Matthew approves (docs/BUILD_PLAN_EMAIL_AUDIT.md, approval #1).
-- Existing outbound_audit rows (~190) are never updated or deleted: they stay
-- as "legacy" rows (chain_version IS NULL) and are committed to by a single
-- genesis row whose detail carries their count and sha256 digest.
-- Rollback: email-audit/20261021_email_audit_chain.down.sql

BEGIN;

-- 1. New nullable columns on outbound_audit (no defaults that rewrite rows).
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS chain_version smallint;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS agent text;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS persona text;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS from_addr text;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS to_addrs text[];
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS cc_addrs text[];
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS bcc_addrs text[];
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS body_hash text;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS body_ref text;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE outbound_audit ADD COLUMN IF NOT EXISTS row_hash text;

CREATE SEQUENCE IF NOT EXISTS outbound_audit_seq START 1;
CREATE UNIQUE INDEX IF NOT EXISTS outbound_audit_seq_unique ON outbound_audit (seq) WHERE seq IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outbound_audit_row_hash_unique ON outbound_audit (row_hash) WHERE row_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbound_audit_provider_msg_idx ON outbound_audit (provider, provider_id) WHERE provider_id IS NOT NULL;

-- 2. Append-only enforcement for every role (including the table owner).
CREATE OR REPLACE FUNCTION outbound_audit_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outbound_audit is append-only (% blocked)', TG_OP;
END $$;

DROP TRIGGER IF EXISTS outbound_audit_no_update ON outbound_audit;
CREATE TRIGGER outbound_audit_no_update BEFORE UPDATE OR DELETE ON outbound_audit
  FOR EACH ROW EXECUTE FUNCTION outbound_audit_block_mutation();
DROP TRIGGER IF EXISTS outbound_audit_no_truncate ON outbound_audit;
CREATE TRIGGER outbound_audit_no_truncate BEFORE TRUNCATE ON outbound_audit
  FOR EACH STATEMENT EXECUTE FUNCTION outbound_audit_block_mutation();

-- 3. Chain link check on insert. Chained rows (chain_version = 1) must point
-- at the current tail. A transaction advisory lock serialises writers so two
-- concurrent sends cannot both claim the same prev_hash.
CREATE OR REPLACE FUNCTION outbound_audit_check_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE tail text;
BEGIN
  IF NEW.chain_version IS NULL THEN
    RETURN NEW; -- legacy-style insert from older code paths; reconciliation flags these
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('outbound_audit_chain'));
  SELECT row_hash INTO tail FROM outbound_audit
    WHERE chain_version IS NOT NULL ORDER BY seq DESC LIMIT 1;
  IF tail IS NULL THEN
    IF NEW.prev_hash <> repeat('0', 64) THEN
      RAISE EXCEPTION 'first chained row must be genesis (prev_hash = 64 zeros)';
    END IF;
  ELSIF NEW.prev_hash IS DISTINCT FROM tail THEN
    RAISE EXCEPTION 'outbound_audit chain break: prev_hash does not match tail';
  END IF;
  IF NEW.row_hash IS NULL OR length(NEW.row_hash) <> 64 OR NEW.seq IS NULL THEN
    RAISE EXCEPTION 'chained row requires seq and 64-char row_hash';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS outbound_audit_chain_check ON outbound_audit;
CREATE TRIGGER outbound_audit_chain_check BEFORE INSERT ON outbound_audit
  FOR EACH ROW EXECUTE FUNCTION outbound_audit_check_chain();

-- 4. Provider status events (separate table; outbound_audit is never updated).
CREATE TABLE IF NOT EXISTS email_events (
  id text PRIMARY KEY,
  provider text NOT NULL,                 -- resend | brevo | ses
  provider_event_id text NOT NULL,        -- svix-id / Brevo message-id+event+ts / SNS MessageId
  provider_msg_id text,
  audit_id text,                          -- outbound_audit.id when matched
  event_type text NOT NULL,               -- normalised: accepted|delivered|bounced|complained|opened|clicked|deferred|failed|other
  raw_type text,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  signature_verified boolean NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS email_events_provider_event_unique ON email_events (provider, provider_event_id);
CREATE INDEX IF NOT EXISTS email_events_msg_idx ON email_events (provider, provider_msg_id);

DROP TRIGGER IF EXISTS email_events_no_update ON email_events;
CREATE TRIGGER email_events_no_update BEFORE UPDATE OR DELETE ON email_events
  FOR EACH ROW EXECUTE FUNCTION outbound_audit_block_mutation();

-- 5. Reconciliation output (append-only by convention; reader role sees it).
CREATE TABLE IF NOT EXISTS email_reconciliation_runs (
  id text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  chain_ok boolean,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS email_reconciliation_findings (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES email_reconciliation_runs(id),
  kind text NOT NULL,      -- provider_only | audit_only | status_mismatch | chain_break | seq_gap | unchained_insert
  provider text,
  provider_msg_id text,
  audit_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_recon_findings_run_idx ON email_reconciliation_findings (run_id);

COMMIT;

-- 6. Genesis row is NOT inserted here. After this migration, the operator runs
--    `pnpm --filter @workspace/api-server exec tsx src/email-audit/genesis-cli.ts --dry-run`
--    to print the legacy digest, reviews it, and then (approval #2) runs it
--    without --dry-run. See BUILD_PLAN section 4.3.

-- Outbound call outcomes: structured disposition/appointment capture for
-- make_outbound_call, so a booked meeting is a queryable row instead of a
-- sentence buried in a call transcript. See lib/db/src/schema.ts for the
-- write-path explanation (record_meeting_outcome vs end-of-call-report).
--
-- Idempotent: matches the bootstrap DDL in lib/db/src/client.ts exactly.
-- This file is the tracked migration artifact required by
-- scripts/verify-schema-migration-drift.mjs whenever schema.ts changes; the
-- actual runtime bootstrap remains client.ts's migrate(), which every APEX
-- process already runs on boot -- this file is not wired into
-- packages/api-server/src/migrate-production.ts because that runner is for
-- the separate, explicitly-tracked Revenue Ops / Outcome Ledger rollout, not
-- for schema changes like this one that the idempotent bootstrap already
-- covers.

CREATE TABLE IF NOT EXISTS call_outcomes (
  id text PRIMARY KEY,
  call_id text NOT NULL,
  lead_id text,
  customer_number text NOT NULL,
  customer_name text,
  disposition text NOT NULL DEFAULT 'no_decision',
  appointment_at timestamptz,
  appointment_date_raw text,
  appointment_time_raw text,
  appointment_timezone_raw text,
  contact_email text,
  objection text,
  next_action text,
  summary text,
  transcript text,
  ended_reason text,
  cost_usd real,
  created_by_agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Both write paths (the mid-call function and end-of-call-report) upsert by
-- call_id, so this must be unique for ON CONFLICT to target the right row.
CREATE UNIQUE INDEX IF NOT EXISTS call_outcomes_call_id_unique
  ON call_outcomes (call_id);

-- The dashboard's "what's booked" query: future appointments, soonest first.
CREATE INDEX IF NOT EXISTS call_outcomes_appointment_idx
  ON call_outcomes (appointment_at) WHERE appointment_at IS NOT NULL;

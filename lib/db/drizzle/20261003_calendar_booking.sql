-- Additive calendar booking tables.
-- Google is the master calendar. Holds use a btree_gist exclusion constraint
-- so two active holds cannot overlap, even if two workers insert together.
-- Idempotent: safe to re-run. Does not alter or drop existing rows.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS calendar_slot_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'held',
  holder_agent_id text,
  holder_name text,
  contact_id uuid,
  meeting_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_slot_holds_org_status_idx
  ON calendar_slot_holds (organization_id, status, starts_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'calendar_slot_holds_no_overlap'
  ) THEN
    ALTER TABLE calendar_slot_holds
      ADD CONSTRAINT calendar_slot_holds_no_overlap
      EXCLUDE USING gist (
        organization_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      ) WHERE (status = 'held');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS calendar_booking_settings (
  organization_id text PRIMARY KEY,
  timezone text NOT NULL DEFAULT 'America/Chicago',
  working_hours jsonb NOT NULL,
  buffer_before_minutes integer NOT NULL DEFAULT 10,
  buffer_after_minutes integer NOT NULL DEFAULT 10,
  no_book_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_meetings_per_day integer NOT NULL DEFAULT 8,
  minimum_notice_minutes integer NOT NULL DEFAULT 60,
  hold_minutes integer NOT NULL DEFAULT 10,
  slot_minutes integer NOT NULL DEFAULT 30,
  busy_calendar_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  booking_calendar_id text,
  agent_colors jsonb NOT NULL DEFAULT '{}'::jsonb,
  operator_display_name text NOT NULL DEFAULT 'Matthew',
  updated_at timestamptz NOT NULL DEFAULT now()
);

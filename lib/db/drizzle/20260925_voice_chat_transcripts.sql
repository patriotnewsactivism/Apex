-- Durable record of live browser voice calls with Apex
-- (packages/api-server/src/live-voice.ts). Before this, the transcript
-- rendered in QuickChat.tsx existed only in React state -- closing the tab
-- or refreshing the page lost the entire conversation permanently, with no
-- way to review what was said or decided on a call.
--
-- One session row per browser call; turns are their own rows (rather than
-- one accumulated text blob) so they can be appended one at a time as they
-- arrive without a read-modify-write race, matching how call_outcomes and
-- email_sends are one-row-per-event elsewhere in this schema.
--
-- Idempotent: matches the bootstrap DDL in lib/db/src/client.ts exactly.
-- This file is the tracked migration artifact required by
-- scripts/verify-schema-migration-drift.mjs whenever schema.ts changes; the
-- actual runtime bootstrap remains client.ts's migrate().

CREATE TABLE IF NOT EXISTS voice_chat_sessions (
  id text PRIMARY KEY,
  start_page text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS voice_chat_turns (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  role text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_chat_turns_session_idx
ON voice_chat_turns (session_id, created_at);

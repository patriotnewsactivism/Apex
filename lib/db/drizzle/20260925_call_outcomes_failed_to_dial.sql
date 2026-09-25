-- call_outcomes.disposition gains a new documented value: 'failed_to_dial'.
-- No DDL is required -- disposition has always been an untyped `text` column
-- (no CHECK constraint), so this is a pure application-level convention
-- change, added so make_outbound_call can record a call Vapi rejected before
-- it ever rang (previously such an attempt wrote nothing anywhere durable --
-- see packages/core/src/tool-registry.ts and
-- packages/dashboard/src/components/CallLogPanel.tsx for the write/read
-- paths). This file exists only to satisfy
-- scripts/verify-schema-migration-drift.mjs, which requires a migration
-- artifact whenever lib/db/src/schema.ts changes at all, including a
-- comment-only change like this one.
--
-- Idempotent no-op, matching lib/db/src/client.ts (no corresponding DDL
-- change was needed there either).

SELECT 1;

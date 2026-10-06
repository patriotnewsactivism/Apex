-- 2026-09-28 timeout-cap-ms: add timeout capacity column to tasks table
-- This column stores the timeout capacity in milliseconds for LLM calls
-- associated with a task, used for quota enforcement and backpressure.
-- It is nullable with NO default to avoid fabricating historical values.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS timeout_cap_ms integer;
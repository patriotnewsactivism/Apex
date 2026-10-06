-- 2026-09-23 cancellation-audit: add nullable cancellation-attribution columns
-- to BOTH `tasks` and `goals`.
--
-- All columns are nullable with NO default. There is intentionally NO backfill
-- and NO fabricated historical actor: prior rows keep their original status and
-- we never invent a who/why for cancellations that happened before this
-- migration existed. (Incident P1 55109e1b / goal 47b0e1ac.)
--
-- Note: `tasks` shipped this shape earlier; this migration is idempotent and
-- simply guarantees the contract on both tables regardless of apply order.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

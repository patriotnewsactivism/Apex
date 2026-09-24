-- email_sends.body: the resolved HTML body (merge fields already applied),
-- stored at queue time by start_email_campaign/send_email instead of only
-- being computed transiently at send time. Lets the dashboard preview the
-- exact content of a campaign before send_email_campaign_batch is ever
-- approved, and audit exactly what was sent afterward -- see
-- packages/dashboard/src/components/EmailCampaignsPanel.tsx and
-- packages/core/src/tool-registry.ts for the read/write paths.
--
-- Idempotent: matches the bootstrap DDL in lib/db/src/client.ts exactly.
-- This file is the tracked migration artifact required by
-- scripts/verify-schema-migration-drift.mjs whenever schema.ts changes; the
-- actual runtime bootstrap remains client.ts's migrate(), which every APEX
-- process already runs on boot.

ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS body text;

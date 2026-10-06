-- OPTIONAL PERFORMANCE MIGRATION — NOT WIRED INTO migrate-production.ts.
-- Needs operator approval before it is applied. Nothing in the code depends
-- on it: insertDiscoveredLead's pre-insert duplicate check works without these
-- indexes (a ~130 ms sequential scan over ~36k researched_leads rows, measured
-- read-only against production on 2026-10-06). With them, each check is an
-- index lookup.
--
-- The expressions must stay byte-for-byte identical to the ones in
-- packages/background-jobs/src/lead-pipeline.ts (findExistingLeadDuplicate),
-- or Postgres will not use the indexes.
--
-- Plain CREATE INDEX (not CONCURRENTLY) so it can run inside the migration
-- runner's transaction; on ~36k rows each build takes well under a second but
-- briefly blocks writes to researched_leads. Apply during a quiet minute.

CREATE INDEX IF NOT EXISTS researched_leads_dedupe_domain_idx
  ON researched_leads ((lower(regexp_replace(regexp_replace(coalesce(website, ''), '^[a-zA-Z]+://', ''), '^www\.|[/?#:].*$', '', 'g'))));

CREATE INDEX IF NOT EXISTS researched_leads_dedupe_phone_idx
  ON researched_leads ((right(regexp_replace(coalesce(contact_phone, ''), '\D', '', 'g'), 10)));

CREATE INDEX IF NOT EXISTS researched_leads_dedupe_name_city_idx
  ON researched_leads ((lower(regexp_replace(company_name, '[^a-zA-Z0-9]', '', 'g'))), (lower(trim(coalesce(city, '')))));

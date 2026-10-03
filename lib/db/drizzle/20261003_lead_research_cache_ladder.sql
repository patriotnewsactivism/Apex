-- Decision-maker ladder: per-domain research cache.
--
-- Extends lead_research_cache (one row per domain:<domain> or
-- company:<name>|<city>) so that every page fetched, every person/title
-- extracted, every search query + result, and every ladder step run is reused
-- by later lookups for ANY role on the same company.
--
-- Additive and idempotent: nullable jsonb columns only, no backfill, no
-- rewrite of existing rows. Size/TTL limits are enforced in application code
-- (CACHE_LIMITS in packages/background-jobs/src/decision-maker-ladder.ts):
-- <= 30 pages (4 KB text excerpt each), <= 200 people, <= 60 searches.
--
-- Decision-maker outcome and contact validation for each lead are stored in
-- the existing researched_leads.enrichment jsonb (keys decisionMakerSearch,
-- contactValidation, industryFit, locationCheck); no researched_leads columns
-- are added.
--
-- Phones: researched_leads.contact_phone is already `text` and stays E.164
-- text. There is no integer phone column; the +12147483647 values seen in
-- production are INT32_MAX scraped from inline CSS/JS (z-index), fixed in the
-- extractor, not by a column type change.

ALTER TABLE lead_research_cache ADD COLUMN IF NOT EXISTS fetched_pages jsonb;
ALTER TABLE lead_research_cache ADD COLUMN IF NOT EXISTS people jsonb;
ALTER TABLE lead_research_cache ADD COLUMN IF NOT EXISTS search_results jsonb;
ALTER TABLE lead_research_cache ADD COLUMN IF NOT EXISTS ladder_steps jsonb;
ALTER TABLE lead_research_cache ADD COLUMN IF NOT EXISTS layer_stats jsonb;
ALTER TABLE lead_research_cache ADD COLUMN IF NOT EXISTS research_updated_at timestamptz;

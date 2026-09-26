ALTER TABLE researched_leads
  ADD COLUMN IF NOT EXISTS enrichment_data jsonb;

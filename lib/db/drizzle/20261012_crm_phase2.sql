-- CRM phase 2: the pipeline, and the companies behind it.
--
-- The pipeline_stages and sales_opportunities tables already existed but nothing
-- used them. This adds the fields a deal actually needs (a close date, a close
-- moment, why it was won or lost, the next step), the index the board reads on,
-- and the default stages for this organization. Additive only: nothing existing
-- is removed, and every statement is safe to re-run on the boot migration.

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS expected_close_at timestamptz;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS won_reason text;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS lost_reason text;

-- STATEMENT
ALTER TABLE sales_opportunities ADD COLUMN IF NOT EXISTS next_step text;

-- STATEMENT
CREATE INDEX IF NOT EXISTS sales_opportunities_org_status_close_idx
  ON sales_opportunities (organization_id, status, expected_close_at);

-- STATEMENT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_opportunities_status_check') THEN
    ALTER TABLE sales_opportunities
      ADD CONSTRAINT sales_opportunities_status_check
      CHECK (status IN ('open', 'qualified', 'proposed', 'negotiated', 'won', 'lost', 'stalled'));
  END IF;
END $$;

-- The default board, seeded once per position. A stage the operator renames or
-- adds is never overwritten, because the seed only fills empty positions.
-- STATEMENT
INSERT INTO pipeline_stages (organization_id, name, position, type, metadata)
SELECT 'apex', seed.name, seed.position, 'opportunity', '{"seeded":"20261012_crm_phase2"}'::jsonb
FROM (VALUES
  ('Qualified', 1),
  ('Proposal sent', 2),
  ('Negotiation', 3),
  ('Verbal yes', 4)
) AS seed(name, position)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages existing
  WHERE existing.organization_id = 'apex' AND existing.position = seed.position
);
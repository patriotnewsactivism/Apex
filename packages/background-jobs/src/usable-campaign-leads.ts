import { sql } from 'drizzle-orm';

/**
 * Shared SQL for a usable qualified campaign lead.
 *
 * This is the definition behind countUsableCampaignLeads in campaign-runner.ts:
 *   pipeline_state = 'CAMPAIGN_READY'
 *   AND status = 'qualified'
 *   AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
 *   AND enrichment -> 'businessVerification' ->> 'status' = 'verified'
 *
 * Callers add a campaign_id predicate when they are counting one campaign.
 * Empty-string email/phone values still satisfy IS NOT NULL, which is
 * deliberate — the campaign runner has always used IS NOT NULL, not a
 * coalesce-to-empty check.
 *
 * Keep this fragment as the single source of truth. The stats endpoint,
 * campaign list, campaign lead list, and the runner must all use it.
 */
export const usableQualifiedLeadSql = sql`
  pipeline_state = 'CAMPAIGN_READY'
  AND status = 'qualified'
  AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
  AND enrichment -> 'businessVerification' ->> 'status' = 'verified'
`;

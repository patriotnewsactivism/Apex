/**
 * Pure rules extracted from lead-pipeline.ts so they can be tested without a DB.
 */

export const CACHE_REUSE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface CacheReuseInput {
  cachedCity: string | null | undefined;
  cachedHasCampaignDraft: boolean;
  cachedHasContact: boolean;
  cachedVerification: { status?: string; checkedAt?: string } | null | undefined;
  inputCity: string | null | undefined;
  now: Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * A domain-keyed cache hit may hydrate contacts and people, but may only skip
 * verification (lead born CAMPAIGN_READY with the cached first touch) when the
 * cached research is for the SAME city and was verified in the last 14 days.
 * Copying it across cities produced CNN-in-Reno rows with an Atlanta angle.
 */
export function cacheReuseAllowed(input: CacheReuseInput): boolean {
  const env = input.env ?? process.env;
  if (env.APEX_LEADS_CACHE_SKIP_VERIFICATION === 'false') return false;
  if (!input.cachedHasCampaignDraft || !input.cachedHasContact) return false;
  if (input.cachedVerification?.status !== 'verified') return false;
  const norm = (c: string | null | undefined) => (c ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm(input.cachedCity) || norm(input.cachedCity) !== norm(input.inputCity)) return false;
  const checkedAt = Date.parse(String(input.cachedVerification?.checkedAt ?? ''));
  return Number.isFinite(checkedAt) && input.now.getTime() - checkedAt >= 0 && input.now.getTime() - checkedAt < CACHE_REUSE_MAX_AGE_MS;
}

/**
 * Replace whole-word occurrences of the old company name only. Raw split/join
 * turned "Indianapolis" into "Hannah News Servicepolis" when renaming "Indiana".
 */
export function replaceCompanyNameText(value: string | null | undefined, oldName: string, newName: string): string | null | undefined {
  if (!value || !oldName || oldName === newName) return value;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), () => newName);
}

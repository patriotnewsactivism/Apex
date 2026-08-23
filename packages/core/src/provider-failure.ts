/** Stable outer signature emitted only after the full configured LLM chain
 * has been attempted. Immediate task retries cannot improve this condition;
 * recovery is handled separately with a long, bounded backoff. */
export function isLLMProviderChainFailure(error: string | null): boolean {
  return Boolean(error && /All LLM providers failed/i.test(error));
}

/** APEX's own durable workspace-wide daily budget pause. This is not a
 * provider outage and must not consume task retries: it can only clear at the
 * UTC ledger rollover (or after an explicit operator cap change). */
export function isLLMDailyBudgetPause(error: string | null): boolean {
  return Boolean(
    error &&
      /APEX daily token cap reached|APEX_TOKEN_CAP_TOTAL|LLM spend is paused until the UTC daily reset/i.test(
        error,
      ),
  );
}

/** A full-chain failure caused by temporary provider capacity rather than bad
 * credentials or missing configuration. These are normal operating conditions
 * on free tiers: RPM/TPM windows close briefly and then reopen. Treating them
 * as permanent task failures destroys useful queued work and creates a retry
 * stampede when a recovery job later revives many tasks at once. */
export function isLLMTransientCapacityFailure(error: string | null): boolean {
  if (!error || !isLLMProviderChainFailure(error) || isLLMDailyBudgetPause(error)) {
    return false;
  }

  // Authentication/configuration failures require an operator and should not
  // be hidden behind autonomous capacity retries.
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication failed/i.test(error)) {
    return false;
  }

  return /(\b429\b|rate limit|too many requests|credential in cooldown|request timed out|temporarily unavailable|overloaded|\b502\b|\b503\b|\b504\b)/i.test(
    error,
  );
}

/** Failures where a 2s/4s/8s retry can only repeat a known global condition. */
export function shouldSuppressImmediateLLMRetry(error: string | null): boolean {
  return isLLMProviderChainFailure(error) || isLLMDailyBudgetPause(error);
}

/** Provider-chain failures that can recover after quota reset, key repair,
 * model replacement, or a new deploy. Credential-denied 401/403 failures are
 * deliberately excluded from autonomous recovery and remain human-actionable. */
export function isRecoverableLLMProviderFailure(error: string | null): boolean {
  if (!error || !isLLMProviderChainFailure(error)) return false;
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication failed/i.test(error)) {
    return false;
  }
  return /(\b429\b|\b402\b|\b404\b|\b413\b|rate limit|credential in cooldown|insufficient credits|quota|tokens per day|request too large|model is unavailable|temporarily unavailable|overloaded|no providers were configured|no providers .*api keys)/i.test(
    error,
  );
}

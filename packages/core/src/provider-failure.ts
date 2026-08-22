/** Stable outer signature emitted only after the full configured LLM chain
 * has been attempted. Immediate task retries cannot improve this condition;
 * recovery is handled separately with a long, bounded backoff. */
export function isLLMProviderChainFailure(error: string | null): boolean {
  return Boolean(error && /All LLM providers failed/i.test(error));
}

/** Provider-chain failures that can recover after quota reset, key repair,
 * model replacement, or a new deploy. Credential-denied 401/403 failures are
 * deliberately excluded from autonomous recovery and remain human-actionable. */
export function isRecoverableLLMProviderFailure(error: string | null): boolean {
  if (!error || !isLLMProviderChainFailure(error)) return false;
  return /(\b429\b|\b402\b|\b404\b|\b413\b|rate limit|insufficient credits|quota|tokens per day|request too large|model is unavailable|no providers were configured|no providers .*api keys)/i.test(
    error,
  );
}

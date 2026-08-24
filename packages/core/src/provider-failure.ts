import { msUntilDailyReset } from "./token-ledger.js";

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

/** A configured free provider is temporarily unavailable because APEX pacing,
 * an APEX per-provider cap, or a provider rate/quota cooldown says to wait.
 * This is an intentional operating state, not broken work. */
export function isLLMCapacityPause(error: string | null): boolean {
  return Boolean(error && /APEX LLM capacity paused/i.test(error));
}

/** Stable machine-readable timestamp carried by capacity-pause errors. */
export function getLLMCapacityResumeAt(error: string | null): Date | null {
  if (!error || !isLLMCapacityPause(error)) return null;
  const match = error.match(/\bresume-at=([^\s|]+)/i);
  if (!match?.[1]) return null;
  const timestamp = Date.parse(match[1]);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function isLLMIntentionalPause(error: string | null): boolean {
  return isLLMDailyBudgetPause(error) || isLLMCapacityPause(error);
}

/** Exact retry time for a parked task. The stable task-ID jitter spreads the
 * wake-up wave without making the schedule random or untestable. */
export function getLLMPauseRetryAt(
  error: string | null,
  taskId: string,
  now: number = Date.now(),
): Date | null {
  const resumeAt =
    getLLMCapacityResumeAt(error)?.getTime() ??
    (isLLMDailyBudgetPause(error)
      ? now + msUntilDailyReset(now)
      : isLLMIntentionalPause(error)
        ? now + 60_000
        : null);
  if (resumeAt === null) return null;
  const jitterMs =
    [...taskId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 60_000;
  return new Date(Math.max(now + 1_000, resumeAt) + 5_000 + jitterMs);
}

/** Failures where a 2s/4s/8s retry can only repeat a known global condition. */
export function shouldSuppressImmediateLLMRetry(error: string | null): boolean {
  return isLLMProviderChainFailure(error) || isLLMIntentionalPause(error);
}

/** Provider-chain failures that can recover after quota reset, key repair,
 * model replacement, or a new deploy. Credential-denied 401/403 failures are
 * deliberately excluded from autonomous recovery and remain human-actionable. */
export function isRecoverableLLMProviderFailure(error: string | null): boolean {
  if (isLLMCapacityPause(error)) return true;
  if (!error || !isLLMProviderChainFailure(error)) return false;
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication failed/i.test(error)) {
    return false;
  }
  return /(\b429\b|\b402\b|\b404\b|\b413\b|\b50[234]\b|rate limit|credential in cooldown|insufficient credits|quota|tokens per day|request too large|model is unavailable|temporarily unavailable|overloaded|no providers were configured|no providers .*api keys)/i.test(
    error,
  );
}

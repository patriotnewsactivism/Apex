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

/** Conditions inside a chain failure that clear on their own within about a
 * minute: a short credential or provider cooldown, a request that timed out,
 * a rate limit, or a momentary gateway error. */
const TRANSIENT_CHAIN_CONDITION =
  /(credential in cooldown|provider pacing\/cooldown|request timed out|\b429\b|\b50[234]\b|rate limit|overloaded|temporarily unavailable)/i;

/** Conditions no retry can clear on a useful timescale: a missing or rejected
 * credential, an exhausted quota, a model that is gone, or a request too large
 * for the roster. One of these anywhere in the chain failure means waiting is
 * pointless, however transient the rest of it looks. */
const PERSISTENT_CHAIN_CONDITION =
  /(no API key|no usable provider credential|base URL is not configured|insufficient credits|\b40[123]\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication failed|\b404\b|model is unavailable|\b413\b|request too large|tokens per day|per[\s-]?day|daily (?:cap|limit|allowance)|quota exhausted|free quota|free[\s-]?tier)/i;

/** A chain failure whose every reported condition is short and self-clearing.
 *
 * APEX runs a single OpenRouter gateway, so one slow request parks the only
 * credential for its cooldown and every task started in that window sees this
 * error. Dropping those outright is how a lead-generation sweep gets lost to a
 * 30-second cooldown, so these keep their retries. */
export function isTransientLLMChainFailure(error: string | null): boolean {
  if (!error || !isLLMProviderChainFailure(error)) return false;
  if (PERSISTENT_CHAIN_CONDITION.test(error)) return false;
  return TRANSIENT_CHAIN_CONDITION.test(error);
}

/** Longest credential cooldown APEX applies to a transient provider failure,
 * plus room for the request that trips it. The default 1s/2s/4s ladder expires
 * well inside that window, so without this floor all three retries burn before
 * the cooldown ever lifts. */
export const TRANSIENT_LLM_RETRY_FLOOR_MS = 45_000;

/** Deterministic 0..max-1 spread over a task ID. A plain character sum is not
 * enough here: task IDs are UUIDs, whose sums land in a band a few hundred wide,
 * so every task in a swarm would draw nearly the same jitter. Mixing each
 * character into the accumulator spreads them across the whole range while
 * staying a pure function of the ID, so a retry time is still reproducible. */
function taskIdJitterMs(taskId: string, max: number): number {
  let hash = 0;
  for (const char of taskId) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % max;
}

/** Retry delay for a transient chain failure: never shorter than the cooldown
 * that caused it, and spread so a swarm that failed together on one credential
 * does not come back in lockstep and collide on it again. */
export function getTransientLLMRetryDelayMs(
  baseDelayMs: number,
  taskId: string,
): number {
  return Math.min(
    300_000,
    Math.max(baseDelayMs, TRANSIENT_LLM_RETRY_FLOOR_MS) +
      taskIdJitterMs(taskId, 15_000),
  );
}

/** Failures where a 2s/4s/8s retry can only repeat a known global condition.
 * A transient cooldown is not one of those — it clears without intervention,
 * so the task keeps its retries and returns on the longer schedule above. */
export function shouldSuppressImmediateLLMRetry(error: string | null): boolean {
  if (isTransientLLMChainFailure(error)) return false;
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

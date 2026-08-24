/**
 * Pure regression checks for the durable daily-budget pause. No database or
 * provider calls: safe to run on every pull request.
 */
import {
  getLLMCapacityResumeAt,
  getLLMPauseRetryAt,
  isLLMCapacityPause,
  isLLMDailyBudgetPause,
  isLLMIntentionalPause,
  isLLMProviderChainFailure,
  shouldSuppressImmediateLLMRetry,
} from "../packages/core/src/provider-failure.js";
import {
  calculateTokenCapacityWindow,
  msUntilDailyReset,
} from "../packages/core/src/token-ledger.js";

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

const liveBudgetPause =
  'APEX daily token cap reached (APEX_TOKEN_CAP_TOTAL) — LLM spend is paused until the UTC daily reset ' +
  'in ~978 min. Raise APEX_TOKEN_CAP_TOTAL to continue today.';
const providerChain =
  "All LLM providers failed. • groq (status: 429): rate limit • openrouter (status: 402): insufficient credits";
const capacityPause =
  "APEX LLM capacity paused. resume-at=2026-08-25T00:00:00.000Z | groq: daily cap reached";
const taskDefect = "TypeError: Cannot read properties of undefined";

check(
  "live daily-cap error is recognized",
  isLLMDailyBudgetPause(liveBudgetPause),
);
check(
  "daily-cap pause is distinct from a provider-chain outage",
  !isLLMProviderChainFailure(liveBudgetPause),
);
check(
  "daily-cap pause suppresses immediate task retries",
  shouldSuppressImmediateLLMRetry(liveBudgetPause),
);
check(
  "whole-provider-chain failure still suppresses immediate retries",
  shouldSuppressImmediateLLMRetry(providerChain),
);
check("provider-cap pause is recognized", isLLMCapacityPause(capacityPause));
check(
  "capacity pause is an intentional non-error state",
  isLLMIntentionalPause(capacityPause),
);
check(
  "capacity pause suppresses immediate retries",
  shouldSuppressImmediateLLMRetry(capacityPause),
);
check(
  "capacity resume time is machine-readable",
  getLLMCapacityResumeAt(capacityPause)?.toISOString() ===
    "2026-08-25T00:00:00.000Z",
  getLLMCapacityResumeAt(capacityPause),
);
const parkedRetry = getLLMPauseRetryAt(
  capacityPause,
  "apex-task-001",
  Date.UTC(2026, 7, 24, 7, 0, 0, 0),
);
check(
  "parked work wakes after capacity resumes with bounded deterministic jitter",
  Boolean(
    parkedRetry &&
    parkedRetry.getTime() > Date.UTC(2026, 7, 25, 0, 0, 5, 0) &&
    parkedRetry.getTime() < Date.UTC(2026, 7, 25, 0, 1, 6, 0),
  ),
  parkedRetry,
);
check(
  "task-specific defects retain their bounded retry budget",
  !shouldSuppressImmediateLLMRetry(taskDefect),
);

const oneMinuteBeforeReset = Date.UTC(2026, 7, 22, 23, 59, 0, 0);
check(
  'UTC reset calculation is exact',
  msUntilDailyReset(oneMinuteBeforeReset) === 60_000,
  msUntilDailyReset(oneMinuteBeforeReset),
);

const midnight = Date.UTC(2026, 7, 24, 0, 0, 0, 0);
const firstTask = calculateTokenCapacityWindow({
  cap: 200_000,
  usedTokens: 0,
  requestedTokens: 6_000,
  at: midnight,
  pacingEnabled: true,
  burstTokens: 12_000,
});
check("initial burst funds one useful task", firstTask.allowed, firstTask);

const concurrentOversubscription = calculateTokenCapacityWindow({
  cap: 200_000,
  usedTokens: 0,
  reservedTokens: 8_000,
  requestedTokens: 6_000,
  at: midnight,
  pacingEnabled: true,
  burstTokens: 12_000,
});
check(
  "in-flight reservations prevent concurrent cap oversubscription",
  !concurrentOversubscription.allowed &&
    concurrentOversubscription.reason === "paced" &&
    concurrentOversubscription.resumeAt === "2026-08-24T00:15:19.149Z",
  concurrentOversubscription,
);

const hardCap = calculateTokenCapacityWindow({
  cap: 200_000,
  usedTokens: 200_000,
  requestedTokens: 1,
  at: midnight,
  pacingEnabled: true,
  burstTokens: 12_000,
});
check(
  "hard provider cap parks work until the next UTC day",
  !hardCap.allowed &&
    hardCap.reason === "daily_cap" &&
    hardCap.resumeAt === "2026-08-25T00:00:00.000Z",
  hardCap,
);

const pacingDisabled = calculateTokenCapacityWindow({
  cap: 200_000,
  usedTokens: 150_000,
  requestedTokens: 25_000,
  at: midnight,
  pacingEnabled: false,
  burstTokens: 0,
});
check(
  "explicit pacing opt-out still preserves the hard cap",
  pacingDisabled.allowed,
  pacingDisabled,
);

console.log(
  failures === 0
    ? "✅ ALL DAILY-BUDGET GUARDS PASSED"
    : `❌ ${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);

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
  isRecoverableLLMProviderFailure,
  shouldSuppressImmediateLLMRetry,
} from "../packages/core/src/provider-failure.js";
import { isAuthFailure } from "../packages/core/src/llm-client.js";
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
// The shape llm-client.ts now throws when free-tier capacity is exhausted
// (paidOnly) AND the paid rung is separately unaffordable at that same
// moment (spend pacing, not merely "disabled") — previously fell through to
// a generic "no usable provider credential" message that this recognizer
// rejects, so the workforce read a capacity pause as an ordinary task
// failure and retried immediately instead of backing off.
const paidRungAlsoPaused =
  "APEX LLM capacity paused. resume-at=2026-08-25T00:00:00.000Z | " +
  "openrouter-glm-5-3-flashx-paid: upstream paid-provider capacity pause";

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

check(
  "dual free+paid capacity exhaustion is recognized as a capacity pause",
  isLLMCapacityPause(paidRungAlsoPaused),
);
check(
  "dual capacity exhaustion is an intentional non-error state, not a defect",
  isLLMIntentionalPause(paidRungAlsoPaused),
);
check(
  "dual capacity exhaustion suppresses immediate retries instead of burn-looping",
  shouldSuppressImmediateLLMRetry(paidRungAlsoPaused),
);
check(
  "paid-rung pause resume time is machine-readable",
  getLLMCapacityResumeAt(paidRungAlsoPaused)?.toISOString() ===
    "2026-08-25T00:00:00.000Z",
  getLLMCapacityResumeAt(paidRungAlsoPaused),
);

// Auth failure checks (401/403 treated as route unavailable while waiting on other routes)
check("HTTP 403 access denied is recognized as auth failure", isAuthFailure(403, "Access to model denied"));
check("HTTP 401 unauthorized is recognized as auth failure", isAuthFailure(401, "Unauthorized"));
check("text pattern access to model denied is recognized as auth failure", isAuthFailure(undefined, "Access to model denied. Please make sure you are eligible for using the model."));
check("HTTP 429 rate limit is NOT auth failure", !isAuthFailure(429, "Rate limit exceeded"));
check("HTTP 500 server error is NOT auth failure", !isAuthFailure(500, "Internal server error"));

const capacityPauseWithRouteAuthFailure =
  "APEX LLM capacity paused. resume-at=2026-08-25T00:00:00.000Z | " +
  "openrouter: daily cap reached | qwen-dashscope-byok/qwen3.8-flash via QWEN_API_KEY: HTTP 403 Access to model denied";

check(
  "capacity pause with auth failure on one route is recognized as a capacity pause",
  isLLMCapacityPause(capacityPauseWithRouteAuthFailure),
);
check(
  "capacity pause with auth failure on one route suppresses immediate retries",
  shouldSuppressImmediateLLMRetry(capacityPauseWithRouteAuthFailure),
);
check(
  "capacity pause with auth failure on one route preserves resume time",
  getLLMCapacityResumeAt(capacityPauseWithRouteAuthFailure)?.toISOString() ===
    "2026-08-25T00:00:00.000Z",
  getLLMCapacityResumeAt(capacityPauseWithRouteAuthFailure),
);

const allRoutesAuthFailure =
  "All LLM providers failed or were unavailable. qwen-dashscope-byok/qwen3.8-flash via QWEN_API_KEY: HTTP 403 Access to model denied | groq-gpt-oss-120b-byok via GROQ_API_KEY: HTTP 401 Unauthorized";

check(
  "all routes failing auth is NOT a capacity pause",
  !isLLMCapacityPause(allRoutesAuthFailure),
);
check(
  "all routes failing auth is recognized as provider chain failure",
  isLLMProviderChainFailure(allRoutesAuthFailure),
);
check(
  "all routes failing auth is not autonomously recoverable (requires human intervention)",
  !isRecoverableLLMProviderFailure(allRoutesAuthFailure),
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

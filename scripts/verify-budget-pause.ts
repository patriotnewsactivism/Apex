/**
 * Pure regression checks for the durable daily-budget pause. No database or
 * provider calls: safe to run on every pull request.
 */
import {
  isLLMDailyBudgetPause,
  isLLMProviderChainFailure,
  shouldSuppressImmediateLLMRetry,
} from '../packages/core/src/provider-failure.js';
import { msUntilDailyReset } from '../packages/core/src/token-ledger.js';

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
  'All LLM providers failed. • groq (status: 429): rate limit • openrouter (status: 402): insufficient credits';
const taskDefect = 'TypeError: Cannot read properties of undefined';

check('live daily-cap error is recognized', isLLMDailyBudgetPause(liveBudgetPause));
check('daily-cap pause is distinct from a provider-chain outage', !isLLMProviderChainFailure(liveBudgetPause));
check('daily-cap pause suppresses immediate task retries', shouldSuppressImmediateLLMRetry(liveBudgetPause));
check('whole-provider-chain failure still suppresses immediate retries', shouldSuppressImmediateLLMRetry(providerChain));
check('task-specific defects retain their bounded retry budget', !shouldSuppressImmediateLLMRetry(taskDefect));

const oneMinuteBeforeReset = Date.UTC(2026, 7, 22, 23, 59, 0, 0);
check(
  'UTC reset calculation is exact',
  msUntilDailyReset(oneMinuteBeforeReset) === 60_000,
  msUntilDailyReset(oneMinuteBeforeReset),
);

console.log(failures === 0 ? '✅ ALL DAILY-BUDGET GUARDS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

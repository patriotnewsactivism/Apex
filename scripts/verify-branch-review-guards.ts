/**
 * Pure regression checks for branch-review outage classification. Unlike the
 * full autonomy verification, this does not connect to or mutate a database.
 */
import {
  partitionRecoveredProviderFailures,
} from '../packages/background-jobs/src/handlers/index.js';
import {
  isLLMProviderChainFailure,
  isRecoverableLLMProviderFailure,
} from '../packages/core/src/provider-failure.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

const oldAt = new Date('2026-08-22T05:03:41.000Z');
const recoveredAt = new Date('2026-08-22T06:01:43.000Z');
const newAt = new Date('2026-08-22T06:02:00.000Z');

const retiredModel =
  'All LLM providers failed. • openrouter-free (model: openai/gpt-oss-20b:free, status: 404): ' +
  '404 This model is unavailable for free.';
const noProviders =
  'All LLM providers failed. (no providers were configured or had API keys)';
const quotaFailure =
  'All LLM providers failed. • groq (status: 429): rate limit • openrouter (status: 402): insufficient credits';

check('retired-model 404 is recoverable after a deploy', isRecoverableLLMProviderFailure(retiredModel));
check('missing provider configuration is recoverable after a restart', isRecoverableLLMProviderFailure(noProviders));
check('quota exhaustion remains recoverable', isRecoverableLLMProviderFailure(quotaFailure));
check('all-provider failure suppresses immediate task retries', isLLMProviderChainFailure(retiredModel));
check(
  'a real task defect is not classified as provider recovery',
  !isRecoverableLLMProviderFailure('TypeError: Cannot read properties of undefined'),
);

const partitioned = partitionRecoveredProviderFailures(
  [
    { id: 'old-provider', errorMessage: retiredModel, updatedAt: oldAt },
    { id: 'real-defect', errorMessage: 'TypeError: broken task', updatedAt: oldAt },
    { id: 'fresh-provider', errorMessage: quotaFailure, updatedAt: newAt },
  ],
  recoveredAt,
);

check(
  'provider failure older than a later successful task is recovered context',
  partitioned.recovered.map((failure) => failure.id).join(',') === 'old-provider',
  partitioned,
);
check(
  'real defects and provider failures newer than the success remain actionable',
  partitioned.actionable.map((failure) => failure.id).join(',') === 'real-defect,fresh-provider',
  partitioned,
);

console.log(failures === 0 ? '✅ ALL BRANCH-REVIEW GUARDS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

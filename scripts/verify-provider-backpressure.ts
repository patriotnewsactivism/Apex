import { getProviderRequestSpacingMs, isAccountQuotaFailure, isCapacityFailure, parseRetryAfterMs, shouldCooldownCredential } from '../packages/core/src/llm-client.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ✅ ${label}`);
  else { failures++; console.error(`  ❌ ${label}`, detail ?? ''); }
}

check('OpenRouter Nex N2.5 Mini Free default spacing is 500ms', getProviderRequestSpacingMs('openrouter-nex-n2-5-mini-free') === 500);
check('OpenRouter Nemotron Super default spacing is 500ms', getProviderRequestSpacingMs('openrouter-nemotron-super') === 500);
process.env.APEX_LLM_MIN_INTERVAL_MS_OPENROUTER_NEX_N2_5_MINI_FREE = '';
check('empty spacing override falls back safely', getProviderRequestSpacingMs('openrouter-nex-n2-5-mini-free') === 500);
delete process.env.APEX_LLM_MIN_INTERVAL_MS_OPENROUTER_NEX_N2_5_MINI_FREE;
check('Retry-After numeric seconds are honored', parseRetryAfterMs('2', 0) === 2000);
check('Retry-After HTTP dates are honored', parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000) === 4000);
check('invalid Retry-After is ignored', parseRetryAfterMs('nonsense', 0) === undefined);
check(
  'request timeouts are temporary capacity failures',
  isCapacityFailure(undefined, 'request timed out'),
);
check(
  'aborted provider requests are temporary capacity failures',
  isCapacityFailure(undefined, 'This operation was aborted'),
);
check(
  'ordinary provider errors remain task failures',
  !isCapacityFailure(undefined, 'Malformed response: no choices'),
);
check('timeouts never cooldown a valid credential', shouldCooldownCredential(undefined, 'request timed out') === false);
check('aborts never cooldown a valid credential', shouldCooldownCredential(undefined, 'request aborted') === false);
check('HTTP 429 still cools a credential', shouldCooldownCredential(429, 'rate limited') === true);
check('HTTP 402 is a capacity pause, not a paid-model trigger', isCapacityFailure(402, 'Payment required') === true);
check('HTTP 429 is an account-quota failure', isAccountQuotaFailure(429, 'free-models-per-day-high-balance') === true);
check('HTTP 402 is an account-quota failure', isAccountQuotaFailure(402, 'Payment required') === true);

if (failures > 0) {
  console.error(`❌ ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('✅ ALL OPENROUTER BACKPRESSURE GUARDS PASSED');

// The GitHub App cannot edit .github/workflows, so this already-wired guard
// chains the new regression suite before the asynchronous latch suite. Keeping
// one promise chain prevents a failing suite from racing process.exit against
// the other suite's output.
void import('./verify-llm-reliability.js').then(
  () => import('./verify-capacity-latch-release.js'),
).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

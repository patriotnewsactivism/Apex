import { getProviderRequestSpacingMs, parseRetryAfterMs } from '../packages/core/src/llm-client.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ✅ ${label}`);
  else { failures++; console.error(`  ❌ ${label}`, detail ?? ''); }
}

check('primary free batch default spacing is 500ms', getProviderRequestSpacingMs('openrouter-free-agent-primary') === 500);
check('secondary free batch default spacing is 500ms', getProviderRequestSpacingMs('openrouter-free-agent-secondary') === 500);
process.env.APEX_LLM_MIN_INTERVAL_MS_OPENROUTER_FREE_AGENT_PRIMARY = '';
check('empty spacing override falls back safely', getProviderRequestSpacingMs('openrouter-free-agent-primary') === 500);
delete process.env.APEX_LLM_MIN_INTERVAL_MS_OPENROUTER_FREE_AGENT_PRIMARY;
check('Retry-After numeric seconds are honored', parseRetryAfterMs('2', 0) === 2000);
check('Retry-After HTTP dates are honored', parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000) === 4000);
check('invalid Retry-After is ignored', parseRetryAfterMs('nonsense', 0) === undefined);

if (failures > 0) {
  console.error(`❌ ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('✅ ALL OPENROUTER BACKPRESSURE GUARDS PASSED');

// Capacity backpressure is only correct if it also *releases*. The GitHub App
// cannot edit .github/workflows, so this already-wired guard chains it.
void import('./verify-capacity-latch-release.js').catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

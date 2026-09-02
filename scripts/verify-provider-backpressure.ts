import { getProviderRequestSpacingMs, parseRetryAfterMs } from '../packages/core/src/llm-client.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ✅ ${label}`);
  else { failures++; console.error(`  ❌ ${label}`, detail ?? ''); }
}

check('OpenRouter MiniMax default spacing is 500ms', getProviderRequestSpacingMs('openrouter-minimax-m3') === 500);
check('OpenRouter Nemotron default spacing is 500ms', getProviderRequestSpacingMs('openrouter-nemotron-ultra') === 500);
process.env.APEX_LLM_MIN_INTERVAL_MS_OPENROUTER_MINIMAX_M3 = '';
check('empty spacing override falls back safely', getProviderRequestSpacingMs('openrouter-minimax-m3') === 500);
delete process.env.APEX_LLM_MIN_INTERVAL_MS_OPENROUTER_MINIMAX_M3;
check('Retry-After numeric seconds are honored', parseRetryAfterMs('2', 0) === 2000);
check('Retry-After HTTP dates are honored', parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000) === 4000);
check('invalid Retry-After is ignored', parseRetryAfterMs('nonsense', 0) === undefined);

console.log(failures === 0 ? '✅ ALL OPENROUTER BACKPRESSURE GUARDS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

import { getProviderRequestSpacingMs, parseRetryAfterMs } from '../packages/core/src/llm-client.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ✅ ${label}`);
  else { failures++; console.error(`  ❌ ${label}`, detail ?? ''); }
}

check('Gemini default spacing is 4s', getProviderRequestSpacingMs('google-gemini') === 4000);
check('Groq default spacing leaves margin under 30 RPM', getProviderRequestSpacingMs('groq') === 2200);
check('Cohere default spacing leaves margin under 20 RPM', getProviderRequestSpacingMs('cohere') === 3200);
process.env.APEX_LLM_MIN_INTERVAL_MS_GROQ = '';
check('empty spacing override falls back safely', getProviderRequestSpacingMs('groq') === 2200);
delete process.env.APEX_LLM_MIN_INTERVAL_MS_GROQ;
check('Retry-After numeric seconds are honored', parseRetryAfterMs('2', 0) === 2000);
check('Retry-After HTTP dates are honored', parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000) === 4000);
check('invalid Retry-After is ignored', parseRetryAfterMs('nonsense', 0) === undefined);

console.log(failures === 0 ? '✅ ALL PROVIDER BACKPRESSURE GUARDS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

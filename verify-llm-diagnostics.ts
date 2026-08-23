import {
  getProviderRoster,
  logProviderRoster,
  createLLMClient,
  getDefaultLLMConfig,
} from './packages/core/src/llm-client.js';
import { escalationDedupeKey } from './packages/core/src/orchestration-tools.js';

async function main() {
  for (const key of [
    'GEMINI_FREE_API_KEY',
    'GEMINI_FREE_API_KEY_2',
    'COHERE_API_KEY',
    'POOLSIDE_API_KEY',
    'POOLSIDE_FREE_ACCESS_CONFIRMED',
    'QWEN_API_KEY',
    'QWEN_BASE_URL',
    'QWEN_FREE_QUOTA_ONLY',
    'KILO_API_KEY',
    'MISTRAL_API_KEY',
    'APEX_PAID_LLM_MODE',
  ]) delete process.env[key];

  console.log('--- free-first roster with all inference credentials cleared ---');
  logProviderRoster();
  const roster = getProviderRoster();
  console.log(
    `freeSlotsConfigured=${roster.freeSlotsConfigured}/${roster.freeSlots} missing=${roster.emptyFreeSlots.join(',')}`,
  );

  const client = createLLMClient(getDefaultLLMConfig('BACKEND'));
  try {
    await client.complete([{ role: 'user', content: 'hi' }]);
    console.log('!! UNEXPECTED: call succeeded with no keys');
  } catch (err) {
    const msg = (err as Error).message;
    const namesEveryApprovedProvider = [
      'google-gemini',
      'cohere',
      'poolside',
      'qwen',
      'kilo',
      'mistral',
    ].every((name) => msg.includes(name));
    const namesLegacyProvider = /groq|openrouter|cerebras|sambanova|huggingface|nvidia/i.test(msg);
    console.log('\nheadline: ' + msg.split('\n')[0]);
    console.log('names all six approved providers: ' + (namesEveryApprovedProvider ? 'PASS' : 'FAIL'));
    console.log('names no removed legacy provider: ' + (!namesLegacyProvider ? 'PASS' : 'FAIL'));
    console.log('shows Mistral paid fallback disabled: ' + (msg.includes('paid fallback disabled') ? 'PASS' : 'FAIL'));
  }

  const a = escalationDedupeKey('apex-coo-001', 'g1', 'Stripe key missing, cannot bill');
  const b = escalationDedupeKey('apex-coo-001', 'g1', '  STRIPE KEY MISSING, CANNOT BILL!!  ');
  const c = escalationDedupeKey('apex-coo-001', 'g2', 'Stripe key missing, cannot bill');
  const d = escalationDedupeKey('apex-cto-001', 'g1', 'Stripe key missing, cannot bill');
  console.log('\n--- dedupe key ---');
  console.log('reworded casing/punctuation collapses:  ' + (a === b ? 'PASS' : 'FAIL'));
  console.log('different goal stays distinct:          ' + (a !== c ? 'PASS' : 'FAIL'));
  console.log('different agent stays distinct:         ' + (a !== d ? 'PASS' : 'FAIL'));
}
main();

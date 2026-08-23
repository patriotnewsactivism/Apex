import {
  getProviderRoster,
  logProviderRoster,
  createLLMClient,
  getDefaultLLMConfig,
} from './packages/core/src/llm-client.js';
import { escalationDedupeKey } from './packages/core/src/orchestration-tools.js';

async function main() {
  for (const key of [
    'MISTRAL_API_KEY',
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_2',
    'COHERE_API_KEY',
    'QWEN_API_KEY',
    'QWEN_BASE_URL',
    'KILO_API_KEY',
  ]) delete process.env[key];

  console.log('--- approved roster with all inference credentials cleared ---');
  logProviderRoster();
  const roster = getProviderRoster();
  console.log(
    `configuredSlots=${roster.configuredSlots}/${roster.totalSlots} missing=${roster.missingRequirements.join(',')}`,
  );

  const client = createLLMClient(getDefaultLLMConfig('BACKEND'));
  try {
    await client.complete([{ role: 'user', content: 'hi' }]);
    console.log('!! UNEXPECTED: call succeeded with no keys');
  } catch (err) {
    const msg = (err as Error).message;
    const namesEveryApprovedProvider = [
      'mistral',
      'google-gemini',
      'cohere',
      'qwen',
      'kilo',
    ].every((name) => msg.includes(name));
    const namesLegacyProvider = /groq|openrouter|cerebras|sambanova|huggingface|nvidia/i.test(msg);
    console.log('\nheadline: ' + msg.split('\n')[0]);
    console.log('names all five approved providers: ' + (namesEveryApprovedProvider ? 'PASS' : 'FAIL'));
    console.log('names no legacy provider:           ' + (!namesLegacyProvider ? 'PASS' : 'FAIL'));
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

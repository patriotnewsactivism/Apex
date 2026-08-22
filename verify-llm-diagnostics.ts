import { getProviderRoster, logProviderRoster, createLLMClient } from './packages/core/src/llm-client.js';
import { escalationDedupeKey } from './packages/core/src/orchestration-tools.js';

async function main() {
  for (const p of getProviderRoster().providers) delete process.env[p.envVar];

  console.log('--- roster with all keys cleared ---');
  logProviderRoster();
  const r = getProviderRoster();
  console.log('freeSlotsConfigured=' + r.freeSlotsConfigured + '/' + r.freeSlots
    + '  distinct missing env vars=' + r.emptyFreeSlots.length);

  const client = createLLMClient({ provider: 'mistral', model: 'mistral-small-latest' } as any);
  try {
    await client.complete([{ role: 'user', content: 'hi' }]);
    console.log('!! UNEXPECTED: call succeeded with no keys');
  } catch (err) {
    const msg = (err as Error).message;
    console.log('\nheadline: ' + msg.split('\n')[0]);
    console.log('names a reason per provider: '
      + (msg.includes('no API key') && msg.includes('APEX_PAID_LLM_MODE') ? 'PASS' : 'FAIL'));
    console.log('no longer claims "(no providers were configured or had API keys)": '
      + (msg.includes('no providers were configured') ? 'FAIL' : 'PASS'));
  }

  // Real exported function, not a copy of it.
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

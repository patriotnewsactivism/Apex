import { readFileSync } from 'node:fs';

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed += 1;
};

const healthSource = readFileSync('packages/health-monitor/src/index.ts', 'utf8');
const llmSource = readFileSync('packages/core/src/llm-client.ts', 'utf8');

check(
  'health monitor documents that provider status is configuration presence, not a live probe',
  /No live LLM API calls[\s\S]*provider health is reported as "which providers have keys configured"/i.test(healthSource),
);
check(
  'health monitor must not call configured providers live-health "healthy" in its detail text',
  !/`${p\.name}:\$\{p\.configured \? 'ok' : 'missing'\}`/.test(healthSource),
);
check(
  'LLM client exposes a non-spending capacity availability signal',
  /export function llmCapacityAvailableNow\(/.test(llmSource),
);
check(
  'LLM client exposes provider backpressure without a live provider request',
  /export function getProviderBackpressureSnapshot\(/.test(llmSource),
);

if (failed > 0) {
  console.error(`\n${failed} provider-health semantics check(s) failed.`);
  process.exit(1);
}
console.log('\nProvider-health semantics guard passed.');

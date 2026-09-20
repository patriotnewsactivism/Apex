/**
 * Regression guard for the production LLM failures observed 2026-09-20:
 * - transient OpenRouter timeouts became terminal task failures;
 * - Groq received 8,518-13,888 token requests against an 8,000 TPM envelope;
 * - capacity recovery admitted arbitrary engineering work before lead research.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isCapacityFailure,
  prepareProviderRequest,
} from '../packages/core/src/llm-client.js';
import type { LLMMessage, LLMTool } from '../packages/core/src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`, detail ?? '');
}

const messages: LLMMessage[] = [
  { role: 'system', content: 'You are a revenue operations agent.'.repeat(100) },
  { role: 'user', content: 'Research and qualify commercial roofing leads.'.repeat(800) },
];
const tools: LLMTool[] = [{
  name: 'saveResearchedLeadsBatch',
  description: 'Save qualified leads in one batch.',
  parameters: { type: 'object', properties: { leads: { type: 'array' } } },
}];

const groq = prepareProviderRequest(
  'groq-gpt-oss-120b-byok',
  messages,
  tools,
  8_192,
);
check(
  'Groq requests are sized below its verified 8,000-token TPM envelope',
  groq.estimatedTotalTokens <= 7_600,
  groq,
);
check(
  'Groq output is capped before dispatch instead of provoking HTTP 413',
  groq.maxOutputTokens <= 1_536,
  groq,
);
check(
  'large Groq histories are trimmed before the network call',
  groq.trimmed,
  groq,
);

check(
  'upstream empty-error completions are temporary capacity failures',
  isCapacityFailure(undefined, 'empty completion content (finish_reason: error)'),
);
check(
  'missing completion choices are temporary capacity failures',
  isCapacityFailure(undefined, 'provider returned no completion choice'),
);

const client = fs.readFileSync(path.join(root, 'packages/core/src/llm-client.ts'), 'utf8');
const claimGuard = fs.readFileSync(path.join(root, 'packages/core/src/capacity-claim-guard.ts'), 'utf8');
const jobs = fs.readFileSync(path.join(root, 'packages/api-server/src/bootstrap-jobs.ts'), 'utf8');

check(
  'timeouts create a machine-readable capacity block instead of terminal chain failure',
  /else if \(capacityFailure\)[\s\S]{0,900}capacityBlocks\.push/.test(client) &&
    /COOLDOWN_TIMEOUT_MS/.test(client),
);
check(
  'free OpenRouter routes prefer low-latency endpoints without changing the model roster',
  /providerRouting:\s*\{\s*sort: 'latency'/.test(client),
);
check(
  'capacity recovery gives lead research a bounded first claim opportunity',
  /DEFAULT_PRIORITY_AGENTS = \['apex-lead-research-001'\]/.test(claimGuard) &&
    /PRIORITY_GRACE_MS/.test(claimGuard) &&
    /latchReleaseAtMs \+ PRIORITY_GRACE_MS/.test(claimGuard) &&
    /!priorityAgents\.has\(this\.ownerAgentId\(\)\)/.test(claimGuard),
);
check(
  'lead generation is the highest-priority recurring business task',
  /id: 'system-lead-gen-sweep'[\s\S]{0,500}cronExpression: '\*\/10 \* \* \* \*'[\s\S]{0,180}priority: 1/.test(jobs),
);
check(
  'speculative discovery and prompt work are deprioritized behind revenue',
  /id: 'system-opportunity-discovery'[\s\S]{0,300}priority: 8/.test(jobs) &&
    /id: 'system-prompt-evolution'[\s\S]{0,300}priority: 9/.test(jobs),
);

if (failures > 0) {
  console.error(`❌ ${failures} LLM reliability guard(s) failed`);
  process.exit(1);
}
console.log('✅ ALL LLM RELIABILITY GUARDS PASSED');

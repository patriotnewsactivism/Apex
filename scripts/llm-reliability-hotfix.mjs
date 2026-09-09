import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceExact(content, before, after, label) {
  const first = content.indexOf(before);
  const last = content.lastIndexOf(before);
  if (first === -1 || first !== last) {
    throw new Error(`${label}: expected exactly one match`);
  }
  return content.slice(0, first) + after + content.slice(first + before.length);
}

function replaceRegex(content, regex, after, label) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const matches = [...content.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${matches.length}`);
  }
  return content.replace(regex, after);
}

function replaceAllCount(content, before, after, expected, label) {
  const count = content.split(before).length - 1;
  if (count !== expected) {
    throw new Error(`${label}: expected ${expected} matches, found ${count}`);
  }
  return content.split(before).join(after);
}

const corePath = 'packages/core/src/llm-client.ts';
let core = read(corePath);

core = replaceRegex(
  core,
  /const PROVIDER_ORDER: readonly ApexProviderName\[\] = \[[\s\S]*?\n\];\n\n\/\/ Operator tier policy,[\s\S]*?export function getProviderOrderForRole\(role\?: string\): ApexProviderName\[\] \{[\s\S]*?\n\}\n\n\/\*\* Paid inference/,
  `const PROVIDER_ORDER: readonly ApexProviderName[] = [\n  'openrouter-gpt-oss-120b-paid',\n  'openrouter-deepseek-v4-flash-paid',\n  'openrouter-deepseek-v3-paid',\n  // Emergency continuity anchor. This remains last because it is materially\n  // more expensive and is intentionally pinned to Bedrock BYOK.\n  'openrouter-grok-4-6-bedrock',\n];\n\nexport function getProviderOrderForRole(_role?: string): ApexProviderName[] {\n  // Operator policy 2026-09-09: continuity beats free-tier queue latency.\n  // GPT-OSS is the fast/cheap primary observed succeeding in seconds, followed\n  // by DeepSeek V4 for reasoning depth, then V3.2 and the BYOK emergency rung.\n  // Free OpenRouter models are deliberately excluded from automatic fallback.\n  if (hasCustomOpenRouterModelPolicy()) return ['openrouter-gpt-oss-120b-paid'];\n  return [...PROVIDER_ORDER];\n}\n\n/** Paid inference`,
  'core provider order',
);

core = replaceExact(
  core,
  `export const OPENROUTER_MAX_FALLBACK_MODELS = 3;\n\nconst COOLDOWN_429_MS = 30_000;`,
  `export const OPENROUTER_MAX_FALLBACK_MODELS = 3;\n\nconst configuredRequestTimeoutMs = Number(process.env.APEX_LLM_REQUEST_TIMEOUT_MS ?? 30_000);\nexport const LLM_REQUEST_TIMEOUT_MS = Number.isFinite(configuredRequestTimeoutMs)\n  ? Math.min(60_000, Math.max(10_000, Math.floor(configuredRequestTimeoutMs)))\n  : 30_000;\n\nconst COOLDOWN_429_MS = 30_000;`,
  'core request timeout constant',
);

core = replaceExact(
  core,
  `  for (const provider of PROVIDERS) {\n    if (!providerConfigured(provider)) continue;\n    if (providerActivationIssue(provider)) continue;\n    if (!providerBaseURL(provider)) continue;\n    if (configuredCredentials(provider).length === 0) continue;`,
  `  const activeOrder = hasCustomOpenRouterModelPolicy()\n    ? (['openrouter-gpt-oss-120b-paid'] as const)\n    : PROVIDER_ORDER;\n  for (const providerName of activeOrder) {\n    const provider = PROVIDER_BY_NAME.get(providerName);\n    if (!provider) continue;\n    if (!providerConfigured(provider)) continue;\n    if (providerActivationIssue(provider)) continue;\n    if (!providerBaseURL(provider)) continue;\n    if (configuredCredentials(provider).length === 0) continue;`,
  'active capacity provider order',
);

core = replaceExact(
  core,
  `  const timeout = setTimeout(() => controller.abort(), 75_000);`,
  `  const timeout = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);`,
  'core HTTP timeout',
);

core = replaceRegex(
  core,
  /(\s+providerErrors\.push\([\s\S]*?\n\s+\);\n\n)(\s+if \(capacityFailure\) break;)/,
  `$1\n                // A timeout is an endpoint/model latency failure, not evidence\n                // that every credential is bad. Move to the next model instead\n                // of burning another full timeout on the same provider.\n                if (message === 'request timed out') break;\n$2`,
  'timeout failover break',
);

core = replaceExact(
  core,
  `  return {\n    provider: 'openrouter-minimax-m3',\n    model,\n    temperature: 0.7,`,
  `  return {\n    provider: 'openrouter-gpt-oss-120b-paid',\n    model,\n    temperature: 0.7,`,
  'default provider identity',
);

write(corePath, core);

const routingPath = 'packages/core/src/model-routing.ts';
let routing = read(routingPath);
routing = replaceRegex(
  routing,
  /\/\*\*\n \* Reviewed fallback chain used when no operator policy exists or a stored policy\n \* is malformed\.[\s\S]*?export const DEFAULT_OPENROUTER_MODEL_CHAIN = \[[\s\S]*?\n\] as const;/,
  `/**\n * Reliability-first fallback chain used when no operator policy exists or a\n * stored policy is malformed. Free OpenRouter endpoints are intentionally not\n * included: their queue latency can stall the autonomous workforce.\n */\nexport const DEFAULT_OPENROUTER_MODEL_CHAIN = [\n  'openai/gpt-oss-120b',\n  'deepseek/deepseek-v4-flash-0731',\n  'deepseek/deepseek-v3.2',\n] as const;`,
  'default model chain',
);
write(routingPath, routing);

const convexPath = 'packages/convex-backend/convex/llm.ts';
let convex = read(convexPath);
convex = replaceExact(
  convex,
  `import { v } from 'convex/values';\nimport { internalAction } from './_generated/server';`,
  `import { v } from 'convex/values';\nimport { internalAction } from './_generated/server';\n\nconst configuredRequestTimeoutMs = Number(process.env.APEX_LLM_REQUEST_TIMEOUT_MS ?? 30_000);\nconst LLM_REQUEST_TIMEOUT_MS = Number.isFinite(configuredRequestTimeoutMs)\n  ? Math.min(60_000, Math.max(10_000, Math.floor(configuredRequestTimeoutMs)))\n  : 30_000;`,
  'convex timeout constant',
);
convex = replaceRegex(
  convex,
  /const PROVIDERS: Array<\{[\s\S]*?\n\}> = \[[\s\S]*?\n\];/,
  `const PROVIDERS: Array<{\n  name: string;\n  baseURL: string;\n  apiKeyEnv: string;\n  fallbackModel?: string;\n  extraHeaders?: Record<string, string>;\n  protocol?: 'openai' | 'anthropic';\n}> = [\n  // Reliability-first OpenRouter chain. Free endpoints are excluded because\n  // their concurrency queues caused long TTFT stalls and fallback cascades.\n  { name: 'openrouter-gpt-oss-120b-paid', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'openai/gpt-oss-120b', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'APEX Agent Workforce' } },\n  { name: 'openrouter-deepseek-v3-paid', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', fallbackModel: 'deepseek/deepseek-v3.2', extraHeaders: { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'APEX Agent Workforce' } },\n];`,
  'convex provider chain',
);
convex = replaceAllCount(convex, '75_000', 'LLM_REQUEST_TIMEOUT_MS', 4, 'convex 75s timeouts');
write(convexPath, convex);

console.log('LLM continuity hotfix applied successfully.');

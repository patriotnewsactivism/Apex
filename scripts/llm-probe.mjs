// Live-probe every provider in the current fallback chain
// (packages/core/src/llm-client.ts PROVIDERS order) using the LOCAL .env keys.
// Prints status only — never key values. Safe to commit.
//
// Usage: node scripts/llm-probe.mjs   (from repo root)

import { readFileSync } from 'fs';

const env = readFileSync('.env', 'utf8');
const getKey = (name) => env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() || '';

const openaiProbe = async (name, url, key, model, headers = {}) => {
  if (!key) { console.log(`⚪ ${name} — skipped (no key set in .env; chain entry is a no-op)`); return; }
  const r = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 16 }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let detail = '';
  try {
    const j = JSON.parse(text);
    detail = j?.content?.[0]?.text || j?.error?.message || j?.message || text.slice(0, 120);
  } catch {
    detail = text.slice(0, 120);
  }
  console.log(`${r.ok ? '✅' : '❌'} ${name} [${model}] -> ${r.status}${r.ok ? '' : ` :: ${String(detail).slice(0, 160)}`}`);
};

const anthropicProbe = async (name, url, key, model) => {
  if (!key) { console.log(`⚪ ${name} — skipped (no key set in .env; chain entry is a no-op)`); return; }
  const r = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let detail = '';
  try {
    const j = JSON.parse(text);
    detail = j?.content?.[0]?.text || j?.error?.message || text.slice(0, 120);
  } catch {
    detail = text.slice(0, 120);
  }
  console.log(`${r.ok ? '✅' : '❌'} ${name} [${model}] -> ${r.status}${r.ok ? '' : ` :: ${String(detail).slice(0, 160)}`}`);
};

const qwenKey = getKey('QWENCLOUD_API_KEY');

// MUST mirror PROVIDERS in packages/core/src/llm-client.ts one-for-one, in
// chain order — every chain entry gets probed here, no orphans either side.
const tests = [
  () => openaiProbe('cerebras', 'https://api.cerebras.ai/v1', getKey('CEREBRAS_API_KEY'), 'gpt-oss-120b'),
  () => openaiProbe('cerebras-2', 'https://api.cerebras.ai/v1', getKey('CEREBRAS_API_KEY_2'), 'gpt-oss-120b'),
  () => openaiProbe('cerebras-3', 'https://api.cerebras.ai/v1', getKey('CEREBRAS_API_KEY_3'), 'gpt-oss-120b'),
  () => openaiProbe('google-gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', getKey('GEMINI_API_KEY'), 'gemini-3.7-flash'),
  () => openaiProbe('google-gemini-2', 'https://generativelanguage.googleapis.com/v1beta/openai', getKey('GEMINI_API_KEY_2'), 'gemini-3.7-flash'),
  () => openaiProbe('groq', 'https://api.groq.com/openai/v1', getKey('GROQ_API_KEY'), 'llama-3.3-70b-versatile'),
  () => openaiProbe('groq-2', 'https://api.groq.com/openai/v1', getKey('GROQ_API_KEY_2'), 'llama-3.3-70b-versatile'),
  () => openaiProbe('nvidia', 'https://integrate.api.nvidia.com/v1', getKey('NVIDIA_API_KEY'), 'meta/llama-3.3-70b-instruct'),
  () => openaiProbe('poolside', 'https://inference.poolside.ai/v1', getKey('POOLSIDE_API_KEY'), 'poolside/laguna-s-2.1'),
  () => openaiProbe('together', 'https://api.together.xyz/v1', getKey('TOGETHER_API_KEY'), 'meta-llama/Llama-3.3-70B-Instruct-Turbo'),
  () => openaiProbe('deepseek', 'https://api.deepseek.com/v1', getKey('DEEPSEEK_API_KEY'), 'deepseek-chat'),
  // Qwen Cloud — test BOTH models: the standard default AND the premium model
  // the live system is observed using (qwen3.8-max-preview), so we can tell
  // apart "key invalid" from "model id not on Token Plan".
  () => openaiProbe('qwen-cloud', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', qwenKey, 'qwen3.7-plus'),
  () => openaiProbe('qwen-cloud(premium)', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', qwenKey, 'qwen3.8-max-preview'),
  () => openaiProbe('glm-aliyun', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', qwenKey, 'glm-5.2'),
  () => anthropicProbe('qwen-cloud-anthropic', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', qwenKey, 'qwen3.7-plus'),
  () => openaiProbe('glm-zai', 'https://api.z.ai/api/paas/v4', getKey('ZAI_API_KEY'), 'glm-5.2'),
  () => openaiProbe('cohere', 'https://api.cohere.com/compatibility/v1', getKey('COHERE_API_KEY'), 'command-r-plus-08-2024'),
  () => openaiProbe('openrouter-free', 'https://openrouter.ai/api/v1', getKey('OPENROUTER_API_KEY'), 'openai/gpt-oss-20b:free', { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' }),
  () => openaiProbe('openrouter-free-2', 'https://openrouter.ai/api/v1', getKey('OPENROUTER_API_KEY'), 'nvidia/nemotron-3-super-120b-a12b:free', { 'HTTP-Referer': 'https://apex.donmatthews.live', 'X-Title': 'Apex' }),
];

for (const t of tests) {
  try {
    await t();
  } catch (e) {
    console.log(`⚠️ ${e.message}`);
  }
}

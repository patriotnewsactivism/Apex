/** Provider token holds must match the bounded request actually dispatched. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const scratch = mkdtempSync(path.join(tmpdir(), 'apex-provider-token-admission-'));
for (const key of Object.keys(process.env)) if (/^(APEX_|OPENROUTER|QWEN_|GROQ_|GEMINI_)/.test(key)) delete process.env[key];
process.env.DATABASE_URL = 'postgres://guard:guard@127.0.0.1:9/guard';
for (const kind of ['TOKEN','REQUEST','SPEND']) process.env[`APEX_${kind}_LEDGER_PATH`] = path.join(scratch, `${kind}.json`);
process.env.APEX_GROQ_BYOK_ENABLED = 'true';
process.env.GROQ_API_KEY = 'guard-groq';
process.env.APEX_TOKEN_CAPS = 'groq-gpt-oss-120b-byok:10000';
process.env.APEX_TOKEN_PACING_ENABLED = 'false';
process.env.APEX_REQUEST_PACING_ENABLED = 'false';
process.env.APEX_LLM_MIN_INTERVAL_MS_GROQ_GPT_OSS_120B_BYOK = '0';
let calls = 0;
globalThis.fetch = (async (_url, init) => {
  calls++;
  const body = JSON.parse(String(init?.body));
  assert.equal(body.max_tokens, 1536, 'Groq clamps the CEO output allowance before dispatch');
  return new Response(JSON.stringify({ choices: [{ message: { content: 'APEX_CAPACITY_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 1 } }));
}) as typeof fetch;
async function main() {
  const llm = await import('../packages/core/src/llm-client.js');
  const ledger = await import('../packages/core/src/token-ledger.js');
  ledger.recordTokenUsage('groq-gpt-oss-120b-byok', { promptTokens: 2000, completionTokens: 0 });
  const messages = [{ role: 'user' as const, content: 'x'.repeat(8000) }];
  const prepared = llm.prepareProviderRequest('groq-gpt-oss-120b-byok', messages, undefined, 8192);
  assert.ok(prepared.estimatedTotalTokens < 8000);
  assert.ok(llm.estimateLLMRequestTokens(messages, undefined, 8192) > 8000);
  const response = await llm.createLLMClient({ ...llm.getDefaultLLMConfig('CEO'), maxTokens: 8192 }).complete(messages);
  assert.equal(response.content, 'APEX_CAPACITY_OK');
  assert.equal(calls, 1, 'a bounded Groq call must not be refused because the untrimmed CEO request was larger');
  process.env.QWEN_API_KEY = 'guard-qwen';
  process.env.APEX_QWEN_BYOK_ENABLED = 'true';
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(String(body.model).startsWith('qwen'), 'oversize Groq preparation must fall through without a Groq dispatch');
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'FALLBACK_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 1 } }));
  }) as typeof fetch;
  const tools = [{ name: 'large_schema', description: 'x'.repeat(60000), parameters: { type: 'object', properties: {} } }];
  const fallback = await llm.createLLMClient({ ...llm.getDefaultLLMConfig('CEO'), maxTokens: 8192 }).complete(messages, tools);
  assert.equal(fallback.content, 'FALLBACK_OK', 'a provider-specific preparation failure must not abort the fallback chain');
  assert.equal(calls, 2);
  console.log('PASS provider token admission: prepared request sizing and provider-local preparation failure preserve fallback');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => rmSync(scratch, { recursive: true, force: true }));

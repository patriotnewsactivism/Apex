/** Behavioral guard: capacity reports must describe the gates actually used by dispatch. No live inference. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'apex-capacity-admission-'));
for (const key of Object.keys(process.env)) {
  if (/^(OPENROUTER.*KEY|QWEN_|GROQ_|GEMINI_|APEX_.*(?:ENABLED|CAP|PACING|KEY|MODEL_POLICY))/.test(key)) delete process.env[key];
}
process.env.DATABASE_URL = 'postgres://guard:guard@127.0.0.1:9/guard';
process.env.APEX_REQUEST_LEDGER_PATH = path.join(dir, 'requests.json');
process.env.APEX_TOKEN_LEDGER_PATH = path.join(dir, 'tokens.json');
process.env.APEX_SPEND_LEDGER_PATH = path.join(dir, 'spend.json');
process.env.APEX_DAILY_SPEND_USD = '2';
process.env.APEX_SPEND_PACING_ENABLED = 'false';
process.env.APEX_REQUEST_PACING_ENABLED = 'false';
process.env.APEX_QWEN_REQUEST_CAP = '100';
process.env.APEX_LLM_MIN_INTERVAL_MS_QWEN_DASHSCOPE_BYOK = '0';
process.env.APEX_LLM_MIN_INTERVAL_MS_GEMINI_3_8_FLASH_BYOK = '0';
let sent = 0;
let mode: 'entitlement' | 'daily' | 'success' = 'entitlement';
globalThis.fetch = (async () => {
  sent++;
  if (mode === 'entitlement') return new Response(JSON.stringify({ error: { message: 'Access to model denied. AccessDenied.Unpurchased' } }), { status: 403 });
  if (mode === 'daily') return new Response(JSON.stringify({ error: { message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }), { status: 429 });
  return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
}) as typeof fetch;

async function main() {
  const llm = await import('../packages/core/src/llm-client.js');

  const requests = await import('../packages/core/src/request-ledger.js');
  assert.equal(typeof llm.getProviderCapacityReport, 'function', 'capacity report must be exported');
  assert.equal(requests.directProviderRequestCap('gemini'), 20, 'default Gemini daily quota must match verified free allowance');
  const ask = () => llm.createLLMClient(llm.getDefaultLLMConfig('CEO')).complete([{ role: 'user', content: 'Reply OK.' }]);

  process.env.QWEN_API_KEY = 'guard-qwen';
  process.env.APEX_QWEN_BYOK_ENABLED = 'true';
  await ask().catch(() => undefined);
  assert.equal(sent, 1);
  const denied = llm.getProviderCapacityReport().find(p => p.name === 'qwen-dashscope-byok');
  assert.equal(denied?.state, 'access_denied');
  assert.equal(denied?.available, false);
  assert.ok(Date.parse(denied!.resumeAt!) - Date.now() > 5 * 60 * 60 * 1000, 'unentitled model must not be retried every ten minutes');
  assert.equal(llm.llmCapacityAvailableNow(), false);
  await ask().catch(() => undefined);
  assert.equal(sent, 1, 'an entitlement failure must not trigger another dispatch while excluded');
  const roster = llm.getProviderRoster();
  assert.equal(roster.freeSlots, roster.providers.filter(p => !p.paid).length, 'paid Qwen must not count as a free slot');

  delete process.env.QWEN_API_KEY;
  process.env.APEX_QWEN_BYOK_ENABLED = 'false';
  process.env.GEMINI_API_KEY = 'guard-gemini';
  process.env.APEX_GEMINI_BYOK_ENABLED = 'true';
  mode = 'daily';
  await ask().catch(() => undefined);
  const quota = llm.getProviderCapacityReport().find(p => p.name === 'gemini-3-8-flash-byok');
  assert.equal(quota?.state, 'upstream_quota');
  const tomorrow = new Date(); tomorrow.setUTCHours(24, 0, 0, 0);
  assert.equal(quota?.resumeAt, tomorrow.toISOString(), 'daily quota must wait for daily reset, not a 30s retry');
  const afterDaily = sent;
  await ask().catch(() => undefined);
  assert.equal(sent, afterDaily);

  process.env.GROQ_API_KEY = 'guard-groq';
  process.env.APEX_GROQ_BYOK_ENABLED = 'true';
  assert.equal(llm.llmCapacityAvailableNow(), true, 'one denied/exhausted pool must not veto another usable pool');
  delete process.env.GROQ_API_KEY;
  process.env.APEX_GROQ_BYOK_ENABLED = 'false';

  delete process.env.GEMINI_API_KEY;
  process.env.APEX_GEMINI_BYOK_ENABLED = 'false';
  process.env.OPENROUTER_PAID_API_KEY = 'guard-paid';
  process.env.OPENROUTER_API_KEY_3 = 'guard-paid';
  process.env.APEX_PAID_FALLBACK_ENABLED = 'false';
  mode = 'success';
  const beforeOperator = sent;
  await llm.createLLMClient(llm.getDefaultLLMConfig('CEO')).complete([{ role: 'user', content: 'OK' }], undefined, { interactive: true, operatorLane: true }).catch(() => undefined);
  assert.equal(sent, beforeOperator, 'operator lane cannot enable an explicitly disabled paid fallback');
  assert.equal(llm.getProviderCapacityReport().find(p => p.name === llm.PAID_FALLBACK_PROVIDER_NAME)?.state, 'disabled');
  console.log('PASS capacity admission: truthful roster, entitlement exclusion, daily quota reset, and disabled paid-route safety');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => rmSync(dir, { recursive: true, force: true }));

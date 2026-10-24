/** Account-five integration: live client + stubbed transport, never real keys. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const scratch = mkdtempSync(path.join(tmpdir(), 'apex-account5-'));
for (const key of Object.keys(process.env)) if (/^(APEX_|OPENROUTER|GROQ_|GEMINI_|QWEN_)/.test(key)) delete process.env[key];
process.env.DATABASE_URL = 'postgres://guard:guard@127.0.0.1:9/guard';
for (const kind of ['TOKEN','REQUEST','SPEND']) process.env[`APEX_${kind}_LEDGER_PATH`] = path.join(scratch, kind+'.json');
process.env.OPENROUTER_API_KEY_5 = 'mock-account-five';
process.env.APEX_DAILY_SPEND_USD = '2';
process.env.APEX_SPEND_PACING_ENABLED = 'false';
process.env.APEX_REQUEST_PACING_ENABLED = 'false';
process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
const realFetch = globalThis.fetch;
let generations = 0;
globalThis.fetch = (async (url, init) => {
  const auth = new Headers(init?.headers).get('authorization');
  if (String(url).endsWith('/credits')) return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 0 } }));
  if (String(url).endsWith('/key')) return new Response(JSON.stringify({ data: { creator_user_id: null, organization_id: 'mock-organization-five', is_free_tier: false, limit: 2, rate_limit: { requests: -1 } } }));
  assert.ok(String(url).endsWith('/chat/completions'));
  assert.equal(auth, 'Bearer mock-account-five');
  const body = JSON.parse(String(init?.body));
  assert.ok(String(body.model).endsWith(':free') || body.model==='openrouter/free', 'account five is never used for paid inference');
  generations++;
  return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: 'ACCOUNT5_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0 } }));
}) as typeof fetch;
async function main() {
  const llm = await import('../packages/core/src/llm-client.js');
  const credits = await import('../packages/core/src/provider-credits.js');
  assert.ok(llm.OPENROUTER_FREE_KEY_ENVS.includes('OPENROUTER_API_KEY_5'), 'fifth key must be a free inference credential');
  assert.ok(credits.OPENROUTER_CREDIT_KEY_ENVS.includes('OPENROUTER_API_KEY_5'), 'fifth key must appear in credit/account telemetry');
  assert.ok(!llm.OPENROUTER_PAID_KEY_ENVS.includes('OPENROUTER_API_KEY_5'), 'fifth key must not silently fund paid continuity');
  const reply = await llm.createLLMClient(llm.getDefaultLLMConfig('CEO')).complete([{ role: 'user', content: 'Reply OK.' }]);
  assert.equal(reply.content, 'ACCOUNT5_OK'); assert.equal(generations, 1);
  const one = await credits.refreshProviderCredits();
  assert.equal(one?.loadedKeys, 1); assert.equal(one?.uniqueAccounts, 1);
  assert.equal(one?.accounts[0].env, 'OPENROUTER_API_KEY_5');
  assert.ok(one?.accounts[0].account.startsWith('oracct_'), 'organization-scoped keys without creator_user_id need stable account identity');
  process.env.OPENROUTER_API_KEY_2 = 'mock-sibling-same-organization';
  const sibling = await credits.refreshProviderCredits();
  assert.equal(sibling?.loadedKeys, 2); assert.equal(sibling?.uniqueAccounts, 1, 'two keys for the same organization cannot manufacture extra quota');
  const { createSettingsRouter } = await import('../packages/api-server/src/routes/settings.js');
  const { default: express } = await import('../packages/api-server/node_modules/express/index.js');
  const { once } = await import('node:events');
  const app = express(); app.use('/settings', createSettingsRouter());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const result = await realFetch(`http://127.0.0.1:${address.port}/settings/integrations`);
    const catalog = await result.json() as { catalog: Array<{ envVars: Array<{ key: string; secret?: boolean }> }> };
    const fields = catalog.catalog.flatMap(item => item.envVars);
    assert.ok(fields.some(field => field.key === 'OPENROUTER_API_KEY_5' && field.secret), 'fifth slot must be provisionable through the existing authenticated settings API');
  } finally { server.close(); }
  console.log('PASS account five: free-only routing, telemetry, organization dedupe, secret settings slot');
}
main().catch(error => { console.error(error); process.exitCode=1; }).finally(() => rmSync(scratch,{recursive:true,force:true}));

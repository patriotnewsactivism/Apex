/** Drives real complete() with a held, mocked transport. No live providers. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'apex-paid-admission-'));
for (const key of Object.keys(process.env)) {
  if (/^(OPENROUTER|QWEN|GROQ|GEMINI|APEX_)/.test(key)) delete process.env[key];
}
process.env.DATABASE_URL = 'postgres://guard:guard@127.0.0.1:9/guard';
for (const ledger of ['SPEND', 'TOKEN', 'REQUEST']) process.env[`APEX_${ledger}_LEDGER_PATH`] = path.join(dir, `${ledger}.json`);
process.env.OPENROUTER_API_KEY = 'mock-key';
process.env.APEX_PAID_KEY_ENVS = 'OPENROUTER_API_KEY';
process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
process.env.APEX_DAILY_SPEND_USD = '0.07';
process.env.APEX_SPEND_PRIORITY_RESERVE_PCT = '25';
process.env.APEX_SPEND_PACING_ENABLED = 'false';
process.env.APEX_REQUEST_CAP_TOTAL = '1';
process.env.APEX_REQUEST_PACING_ENABLED = 'false';
process.env.APEX_MAX_CONCURRENT_LLM_CALLS = '4';
const waiting: Array<(response: Response) => void> = [];
let sent = 0;
globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  // Free routes are denied without consuming paid capacity.
  if (String(body.model).endsWith(':free') || body.model === 'openrouter/free') return new Response(JSON.stringify({ error: { message: 'free-models-per-day limit exceeded' } }), { status: 429 });
  sent++;
  return new Promise<Response>(resolve => waiting.push(resolve));
}) as typeof fetch;
async function main() {
  const llm = await import('../packages/core/src/llm-client.js');
  const ledger = await import('../packages/core/src/spend-ledger.js');

  const ask = (execution?: { interactive?: boolean; operatorLane?: boolean }) => llm.createLLMClient({ ...llm.getDefaultLLMConfig('CEO'), maxTokens: 256 }).complete([{ role: 'user', content: 'OK' }], undefined, execution);
  const bg = [ask(), ask(), ask()].map(p => p.catch(error => error));
  for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const held = ledger.getSpendLedgerSnapshot();
  assert.equal(sent, 2, 'only two background calls fit their protected budget including max-output reservations');
  assert.ok(held.reservedUsd > 0.04, 'held generations reserve their worst-case completion cost');
  const operator = ask({ interactive: true, operatorLane: true }).catch(error => error);
  for (let i = 0; i < 30 && sent < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent, 3, 'operator can use protected headroom without exceeding total budget');
  assert.ok(ledger.getSpendLedgerSnapshot().reservedUsd <= 0.07);
  for (const resolve of waiting.splice(0)) resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.001 } })));
  await Promise.all([...bg, operator]);
  assert.equal(ledger.getSpendLedgerSnapshot().reservedUsd, 0, 'all holds release after settlement');
  assert.equal(ledger.getSpendLedgerSnapshot().spentUsd, 0.003, 'settled costs booked once');
  const beforeLarge = sent;
  await llm.createLLMClient({ ...llm.getDefaultLLMConfig('CEO'), maxTokens: 131072 }).complete([{ role: 'user', content: 'OK' }], undefined, { interactive: true, operatorLane: true }).catch(() => undefined);
  assert.equal(sent, beforeLarge, 'a generation larger than remaining dollars is refused before transport');
  const beforeUnknown = ledger.getSpendLedgerSnapshot().spentUsd;
  globalThis.fetch = (async () => { throw new TypeError('mock transport failed'); }) as typeof fetch;
  await ask().catch(() => undefined);
  assert.ok(ledger.getSpendLedgerSnapshot().spentUsd - beforeUnknown > 0.02, 'unknown potentially billed failure consumes conservative budget instead of free retries');
  assert.equal(ledger.getSpendLedgerSnapshot().reservedUsd, 0);
  llm.__testClearCooldownMaps();
  const beforeDenied = ledger.getSpendLedgerSnapshot().spentUsd;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 })) as typeof fetch;
  await ask().catch(() => undefined);
  assert.equal(ledger.getSpendLedgerSnapshot().spentUsd, beforeDenied, 'definitive auth rejection releases the hold without a generation charge');
  assert.equal(ledger.getSpendLedgerSnapshot().reservedUsd, 0);
  console.log('PASS paid dispatch: atomic concurrent holds, operator reserve, exact settlement, max-output lookahead, and failure accounting');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const resolve of waiting.splice(0)) resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'cleanup' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.001 } })));
  rmSync(dir, { recursive: true, force: true });
});

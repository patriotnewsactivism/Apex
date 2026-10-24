/**
 * Work-class shares must be measured against the pacing ramp's RELEASED
 * allowance, not only the hard daily cap. Prod 2026-10-23: 26 minutes after the
 * UTC rollover, parked internal loops had consumed all 257 released OpenRouter
 * requests, so the mission task was claimed with nothing left to run on.
 * Drives real complete() with a mocked transport; no live providers.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = mkdtempSync(path.join(tmpdir(), 'apex-paced-share-'));
for (const key of Object.keys(process.env)) if (/^(OPENROUTER|QWEN|GROQ|GEMINI|APEX_)/.test(key)) delete process.env[key];
process.env.DATABASE_URL = 'postgres://guard:guard@127.0.0.1:9/guard';
for (const ledger of ['SPEND', 'TOKEN', 'REQUEST']) process.env[`APEX_${ledger}_LEDGER_PATH`] = path.join(dir, `${ledger}.json`);
process.env.OPENROUTER_FREE_API_KEY = 'mock-free-key';
process.env.APEX_REQUEST_CAPS = 'OPENROUTER_FREE_API_KEY:1000';
process.env.APEX_REQUEST_CAP_TOTAL = '1000';
process.env.APEX_EMERGENCY_REQUEST_CAP_TOTAL = '100000';
process.env.APEX_REQUEST_PACING_ENABLED = 'true';
// Burst == cap: the "released" allowance is exactly 100 at any time of day, so
// the test is deterministic. The hard cap (1000) is far above it.
process.env.APEX_REQUEST_PACING_BURST = '20';
process.env.APEX_REQUEST_CAPS = 'OPENROUTER_FREE_API_KEY:20';
process.env.APEX_REQUEST_CAP_TOTAL = '20';
process.env.APEX_OPENROUTER_FREE_DAILY_REQUESTS = '0'; // isolate the paced share
process.env.APEX_MAX_CONCURRENT_LLM_CALLS = '8';
process.env.APEX_REQUEST_RATE_PER_MIN = '100000';
process.env.APEX_ACCOUNT_REQUEST_RATE_PER_MIN = '0'; // short-window rate limiter is separate from shares

// Per-provider call spacing is a separate governor; zero it so only shares gate.
for (const m of fs.readFileSync(path.join(fs.existsSync(path.join(process.cwd(), 'packages/core')) ? process.cwd() : path.resolve(process.cwd(), '../..'), 'packages/core/src/llm-client.ts'), 'utf8').matchAll(/'(openrouter-[a-z0-9.-]+)'/g)) {
  process.env[`APEX_LLM_MIN_INTERVAL_MS_${m[1].toUpperCase().replace(/-/g, '_')}`] = '0';
}

let served = 0;
globalThis.fetch = (async () => {
  served++;
  return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { status: 200 });
}) as typeof fetch;

const root = fs.existsSync(path.join(process.cwd(), 'packages/core')) ? process.cwd() : path.resolve(process.cwd(), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
function check(label: string, cond: boolean) { assert.ok(cond, label); console.log(`  ok  ${label}`); }

async function main() {
  const llm = await import('../packages/core/src/llm-client.js');
  const wc = await import('../packages/core/src/work-class-budget.js');
  const ask = (exec: Record<string, unknown>) =>
    llm.createLLMClient({ ...llm.getDefaultLLMConfig('CEO'), maxTokens: 64 })
      .complete([{ role: 'user', content: 'OK' }], undefined, exec as never)
      .then(() => 'ok', (e: Error) => `err:${e.message}`);

  const win = (await import('../packages/core/src/request-ledger.js')).requestCapacityWindow(Date.now());
  check('released allowance is the paced 20 (hard cap is not the limiter)', win.pacingAllowance === 20);

  let internalOk = 0;
  let firstDenied = '';
  for (let i = 0; i < 12; i++) {
    const r = await ask({ taskId: `loop-${i}`, workClass: 'internal', workTitle: `Delegation results: gate ${i}${'x'.repeat(i)}` });
    if (r === 'ok') internalOk++; else if (!firstDenied) firstDenied = r;
  }
  check(`internal loops stop at 25% of the released allowance (served ${internalOk})`, internalOk === 5);
  check('denial is a capacity pause naming the work-class share', /capacity paused/i.test(firstDenied) && /work-class share \(internal\)/.test(firstDenied));

  let bgOk = 0;
  for (let i = 0; i < 12; i++) if ((await ask({ taskId: `bg-${i}`, workClass: 'background' })) === 'ok') bgOk++;
  check(`internal+background stop at 40% of released (bg served ${bgOk})`, internalOk + bgOk === 8);

  let missionOk = 0;
  for (let i = 0; i < 16; i++) if ((await ask({ taskId: `m-${i}`, workClass: 'mission' })) === 'ok') missionOk++;
  check(`mission keeps the 60% reserve of the released allowance (served ${missionOk})`, missionOk === 12);

  const operator = await ask({ interactive: true, operatorLane: true, workClass: 'operator' });
  check('operator lane is not throttled by shares', operator === 'ok' || !/work-class share/.test(operator));

  const snap = wc.getWorkClassUsageSnapshot();
  check('usage booked per class on the paced resource', snap.usage['paced:openrouter']?.internal === 5);

  const src = read('packages/core/src/llm-client.ts');
  check('paid spend share is measured against released (paced) micros', src.includes('pacedSpendCapMicros(pacingOverride)'));
  console.log('\npaced-allowance share: all checks passed');
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

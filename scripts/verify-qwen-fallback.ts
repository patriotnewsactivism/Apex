/**
 * Guard: Qwen paid inference is a fully operational fallback.
 *
 * Operator directive 2026-10-10 (P0): free inference whenever practical, Qwen
 * paid whenever necessary, with NO artificial workforce shutdown caused by an
 * exhausted free quota. This drives the real MultiProviderClient with fetch
 * stubbed so it checks the request that actually leaves APEX:
 *
 *   1. free-first: while a free route answers, the request lands on free and
 *      Qwen is NOT touched;
 *   2. failover: when every free route fails (429/402 — the exhausted-pool
 *      case), the request automatically lands on Qwen with no manual step;
 *   3. attribution: the settled spend is recorded against the Qwen provider,
 *      not a free one;
 *   4. no retry storm: each free route is attempted once, then routing moves on.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail).slice(0, 600)}`);
}

type Sent = { url: string; body: Record<string, unknown> };

const ROUTE_ENVS = [
  'OPENROUTER_FREE_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'OPENROUTER_API_KEY_3', 'OPENROUTER_API_KEY_4',
  'QWEN_API_KEY', 'QWEN_API_KEY_2', 'QWEN_BASE_URL', 'QWEN_MODEL', 'APEX_QWEN_BYOK_ENABLED',
  'GROQ_API_KEY', 'GROQ_API_KEY_2', 'APEX_GROQ_BYOK_ENABLED',
  'GEMINI_API_KEY', 'APEX_GEMINI_BYOK_ENABLED',
  'APEX_PAID_FALLBACK_ENABLED', 'APEX_OPENROUTER_MODEL_POLICY', 'APEX_DAILY_SPEND_USD', 'APEX_SPEND_PACING_ENABLED',
  'APEX_QWEN_REQUEST_CAP', 'APEX_REQUEST_CAP_TOTAL', 'APEX_EMERGENCY_REQUEST_CAP_TOTAL', 'APEX_LLM_REQUEST_TIMEOUT_MS',
];

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://guard:***@127.0.0.1:9/no_database';
  for (const env of ROUTE_ENVS) delete process.env[env];
  process.env.APEX_LLM_REQUEST_TIMEOUT_MS = '10000';
  // A generous Qwen ceiling: the whole point is that no artificial cap blocks it.
  process.env.APEX_QWEN_REQUEST_CAP = '100000';

  // The ledger reads its file once, at import; point it somewhere disposable.
  const dir = mkdtempSync(path.join(tmpdir(), 'apex-qwen-fallback-'));
  process.env.APEX_SPEND_LEDGER_PATH = path.join(dir, 'spend.json');
  process.env.APEX_REQUEST_LEDGER_PATH = path.join(dir, 'requests.json');
  process.env.APEX_TOKEN_LEDGER_PATH = path.join(dir, 'tokens.json');

  const sent: Sent[] = [];
  let freeHealthy = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/chat/completions')) return new Response('{}', { status: 404 });
    sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    const isQwen = url.includes('qwencloudapi.com');
    if (!isQwen && !freeHealthy) {
      // An exhausted free pool answers 429. The message is deliberately a plain
      // rate-limit note, NOT an account/quota phrase, so it maps to the 30s
      // COOLDOWN_429_MS rather than an until-quota-reset account cooldown — this
      // test is about routing fallback, not account exhaustion.
      return new Response(JSON.stringify({ error: { code: 429, message: 'temporary upstream error' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        id: 'guard',
        model: isQwen ? 'qwen3.8-flash' : 'free-model',
        choices: [{ index: 0, message: { role: 'assistant', content: isQwen ? 'qwen reply' : 'free reply' }, finish_reason: 'stop' }],
        // No `cost` field: QwenCloud's OpenAI-compatible response omits it (only
        // OpenRouter returns settled cost), so the ledger must derive the cost
        // from the provider's list price — the case this guard covers. The Qwen
        // reply reports half its prompt tokens as cache reads, so the cached
        // slice must be priced at the cached rate, not the fresh rate.
        usage: {
          prompt_tokens: 200_000,
          completion_tokens: 100_000,
          total_tokens: 300_000,
          prompt_tokens_details: { cached_tokens: isQwen ? 100_000 : 0 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  console.log('Verifying Qwen paid inference is a fully operational fallback...\n');
  const llm = (await import(pathToFileURL(path.join(root, 'packages/core/src/llm-client.ts')).href)) as typeof import('../packages/core/src/llm-client.js');
  const ledger = (await import(pathToFileURL(path.join(root, 'packages/core/src/spend-ledger.ts')).href)) as typeof import('../packages/core/src/spend-ledger.js');
  const tools = [{ name: 'noop', description: 'guard tool', parameters: { type: 'object', properties: {} } }];
  const ask = () => llm.createLLMClient(llm.getDefaultLLMConfig('CEO')).complete([{ role: 'user', content: 'ping' }], tools as never);

  // Configure the free roster AND Qwen, so both are callable.
  process.env.OPENROUTER_FREE_API_KEY = 'guard-free-key';
  process.env.APEX_QWEN_BYOK_ENABLED = 'true';
  process.env.QWEN_API_KEY = 'guard-qwen-key';

  // ── 1. Free-first: a healthy free route answers, Qwen is not touched. ──────
  freeHealthy = true;
  const beforeFree = sent.length;
  const freeReply = await ask().then((r) => (r as { content?: string }).content, (e: unknown) => `error: ${e}`);
  const freeSent = sent.slice(beforeFree);
  check('free-first: a healthy free route answers the request', freeReply === 'free reply', freeReply);
  check(
    'free-first: Qwen is NOT touched while free capacity serves',
    freeSent.length > 0 && freeSent.every((r) => !r.url.includes('qwencloudapi.com')),
    freeSent.map((r) => new URL(r.url).host),
  );

  // ── 2. Every free pool is exhausted → routing falls to Qwen automatically. ─
  freeHealthy = false;
  const beforeFail = sent.length;
  const failReply = await ask().then((r) => (r as { content?: string }).content, (e: unknown) => `error: ${e}`);
  const failSent = sent.slice(beforeFail);
  const qwenSent = failSent.filter((r) => r.url.includes('qwencloudapi.com'));
  const freeAttempts = failSent.filter((r) => !r.url.includes('qwencloudapi.com'));
  check(
    'failover: with every free pool exhausted, the request lands on Qwen automatically',
    failReply === 'qwen reply' && qwenSent.length >= 1,
    { reply: failReply, qwen: qwenSent.length, freeAttempts: freeAttempts.length },
  );
  check(
    'failover: the Qwen request asks for the Qwen model',
    qwenSent.every((r) => String(r.body.model).startsWith('qwen')),
    qwenSent.map((r) => r.body.model),
  );
  check(
    'no retry storm: each free route is attempted at most once before moving on',
    freeAttempts.length <= 9,
    freeAttempts.map((r) => new URL(r.url).host),
  );

  // ── 3. Attribution: the settled spend is recorded against Qwen. ────────────
  let snapshot: ReturnType<typeof ledger.getSpendLedgerSnapshot> | { error: string };
  try {
    snapshot = ledger.getSpendLedgerSnapshot();
  } catch (err) {
    snapshot = { error: err instanceof Error ? err.message : String(err) };
  }
  check(
    'attribution: the paid inference is recorded against the Qwen provider',
    'providers' in snapshot && snapshot.providers.some((row) => row.provider.includes('qwen') && row.spentUsd > 0),
    snapshot,
  );

  // 3b. Cached-token accounting: 200k prompt + 100k completion, of which 100k
  // prompt is a cache read. Fresh-rate pricing would be
  // (200k*0.15 + 100k*0.47)/1M = $0.077; the cached slice must drop it toward
  // (100k*0.15 + 100k*0.016 + 100k*0.47)/1M = $0.0636. A cost at or above the
  // fresh figure means the cache discount was ignored.
  const qwenCost = 'providers' in snapshot ? snapshot.providers.find((row) => row.provider.includes('qwen'))?.spentUsd ?? 0 : 0;
  check(
    'cached accounting: the cache-read slice is priced below fresh input',
    qwenCost > 0.062 && qwenCost < 0.066,
    { qwenCost, freshPricing: 0.077, cachedPricing: 0.0636 },
  );

  // ── 4. Free recovery returns APEX to cheaper inference. ────────────────────
  // A 429 cools a provider for COOLDOWN_429_MS (30s), so wait past it — this
  // measures routing, not the cooldown the failover rightly applied.
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  freeHealthy = true;
  const beforeRecover = sent.length;
  const recoverReply = await ask().then((r) => (r as { content?: string }).content, (e: unknown) => `error: ${e}`);
  const recoverSent = sent.slice(beforeRecover);
  check(
    'recovery: when free capacity returns, routing returns to free (not Qwen)',
    recoverReply === 'free reply' && recoverSent.every((r) => !r.url.includes('qwencloudapi.com')),
    { reply: recoverReply, hosts: recoverSent.map((r) => new URL(r.url).host) },
  );

  rmSync(dir, { recursive: true, force: true });
  console.log(
    failures === 0
      ? '\n✅ Qwen paid inference is a fully operational, automatic, attributed fallback.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

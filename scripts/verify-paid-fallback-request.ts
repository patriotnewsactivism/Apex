/**
 * Guard: the paid continuity route sends a request its API accepts.
 *
 * On 2026-10-05 the paid route moved from OpenRouter (GLM FlashX) to Nous
 * Portal (DeepSeek V4 Flash) split against OpenRouter (OPENROUTER_API_KEY_4).
 * On 2026-10-09 the operator cut off all access to the Nous Portal provider,
 * so paid continuity runs on OpenRouter alone (deepseek/deepseek-v4-flash-0731,
 * the funded OPENROUTER_API_KEY_4 account), last behind the free/BYOK chain
 * and only when APEX_PAID_FALLBACK_ENABLED=true.
 *
 * This drives the real MultiProviderClient.complete() with fetch stubbed, so
 * it checks the request that actually leaves APEX, not the source text:
 *   - the OpenRouter paid route alone: it asks for the paid model, sends
 *     OpenRouter's `usage` extension and headers, sorts by latency, applies the
 *     paid output floor, and the reply is used;
 *   - an OpenRouter free route alone: it still gets the role output budget, not
 *     the paid floor;
 *   - the free pool exhausted: paid OpenRouter answers every request, the
 *     model is never retried as free;
 *   - a paid answer slower than the default request timeout still arrives:
 *     the paid route waits PAID_REQUEST_TIMEOUT_MS, free routes keep the
 *     default (here lowered to its 10s floor so the check stays fast);
 *   - the spend ledger loads a same-day file written before it tracked cached
 *     tokens, keeps that file's spend, and the paid OpenRouter route records
 *     settled cost.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

type Sent = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

const ROUTE_ENVS = [
  'OPENROUTER_FREE_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'OPENROUTER_API_KEY_3', 'OPENROUTER_API_KEY_4',
  'QWEN_API_KEY', 'APEX_QWEN_BYOK_ENABLED', 'GROQ_API_KEY', 'GROQ_API_KEY_2', 'APEX_GROQ_BYOK_ENABLED',
  'GEMINI_API_KEY', 'APEX_GEMINI_BYOK_ENABLED', 'APEX_PAID_FALLBACK_ENABLED', 'APEX_OPENROUTER_MODEL_POLICY',
  'APEX_LLM_REQUEST_TIMEOUT_MS', 'APEX_DAILY_SPEND_USD', 'APEX_SPEND_PACING_ENABLED',
];
/** Default request timeout for this guard: the configurable floor, so a paid
 *  answer slower than it can be checked in seconds rather than minutes. */
const GUARD_DEFAULT_TIMEOUT_MS = 10_000;
const SLOW_PAID_ANSWER_MS = 11_000;

async function main(): Promise<void> {
  // No database: telemetry and ledgers are best-effort and must not matter.
  process.env.DATABASE_URL = 'postgres://guard:***@127.0.0.1:9/no_database';
  for (const env of ROUTE_ENVS) delete process.env[env];
  process.env.APEX_LLM_REQUEST_TIMEOUT_MS = String(GUARD_DEFAULT_TIMEOUT_MS);
  // Operator decision 2026-10-10: the paid route is hard-capped by the dollar
  // ledger, so the guard must give it a budget or every paid call is refused.
  // Pacing off makes the window deterministic regardless of wall-clock hour.
  process.env.APEX_DAILY_SPEND_USD = '1';
  process.env.APEX_SPEND_PACING_ENABLED = 'false';
  // Today's ledger as a build from before cached-token tracking wrote it: no
  // cachedTokens map. The ledger reads its file once, at import.
  const ledgerDir = mkdtempSync(path.join(tmpdir(), 'apex-spend-ledger-'));
  process.env.APEX_SPEND_LEDGER_PATH = path.join(ledgerDir, 'spend-ledger.json');
  writeFileSync(
    process.env.APEX_SPEND_LEDGER_PATH,
    JSON.stringify({ day: new Date().toISOString().slice(0, 10), providers: { 'earlier-build-route': 1_000 } }),
  );

  const sent: Sent[] = [];
  let freeQuotaExhausted = false;
  let slowPaidAnswer = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/chat/completions')) return new Response('{}', { status: 404 });
    sent.push({
      url,
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const model = String(sent.at(-1)?.body.model ?? '');
    if (slowPaidAnswer && model === 'deepseek/deepseek-v4-flash-0731') {
      // Answer after the default timeout has passed, unless APEX aborts first.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, SLOW_PAID_ANSWER_MS);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        });
      });
    }
    if (freeQuotaExhausted && url.includes('openrouter.ai') && (model.endsWith(':free') || model === 'openrouter/free')) {
      // OpenRouter's answer once an account's daily free-model quota is spent.
      return new Response(
        JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        id: 'guard',
        model: 'guard-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'guard reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.05 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  console.log('Verifying the paid continuity route sends a request its API accepts...\n');
  const llm = (await import(path.join(root, 'packages/core/src/llm-client.ts'))) as typeof import('../packages/core/src/llm-client.js');
  const ledger = (await import(path.join(root, 'packages/core/src/spend-ledger.ts'))) as typeof import('../packages/core/src/spend-ledger.js');
  const tools = [{ name: 'noop', description: 'guard tool', parameters: { type: 'object', properties: {} } }];
  const ask = () => llm.createLLMClient(llm.getDefaultLLMConfig('CEO')).complete([{ role: 'user', content: 'ping' }], tools as never);
  const roleBudget = llm.getDefaultLLMConfig('CEO').maxTokens ?? 0;

  // 1. Only the paid route is effective, as in production once the free
  //    pool, Groq and Gemini are exhausted. The funded OPENROUTER_API_KEY_4 is
  //    also a member of the free-pool roster, so the free OpenRouter routes
  //    answer 429 and the paid route carries every request.
  process.env.OPENROUTER_API_KEY_4 = 'guard-not-a-real-funded-openrouter-key';
  process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
  freeQuotaExhausted = true;
  const paidReply = await ask().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  const paid = sent.at(-1);
  check('the paid route is called on OpenRouter', paid?.url === 'https://openrouter.ai/api/v1/chat/completions', paid?.url);
  check('it asks for the paid continuity model', paid?.body.model === llm.PAID_FALLBACK_MODEL, paid?.body.model);
  check(
    'it sends OpenRouter`s `usage` extension and headers',
    paid !== undefined && 'usage' in paid.body && 'x-openrouter-metadata' in paid.headers,
    { body: paid?.body, headers: paid?.headers },
  );
  check(
    'the paid route sorts by latency',
    (paid?.body.provider as { sort?: string } | undefined)?.sort === 'latency',
    paid?.body.provider,
  );
  check('tools still go out in the standard OpenAI format', Array.isArray(paid?.body.tools) && paid?.body.tool_choice === 'auto');
  // 2026-10-05: a 4,096-token role budget let DeepSeek's reasoning fill the
  // whole budget and return no content (finish_reason: length).
  check(
    'the paid request leaves room to reason and answer: max_tokens is at least the paid floor',
    paid?.body.max_tokens === Math.max(llm.PAID_MIN_OUTPUT_TOKENS, roleBudget) && llm.PAID_MIN_OUTPUT_TOKENS >= 16_384,
    { max_tokens: paid?.body.max_tokens, roleBudget, floor: llm.PAID_MIN_OUTPUT_TOKENS },
  );
  check(
    'the reply comes back to the agent',
    (paidReply as { content?: string }).content === 'guard reply',
    paidReply,
  );
  let snapshot: ReturnType<typeof ledger.getSpendLedgerSnapshot> | { error: string };
  try {
    snapshot = ledger.getSpendLedgerSnapshot();
  } catch (err) {
    snapshot = { error: err instanceof Error ? err.message : String(err) };
  }
  check(
    "the spend ledger reports from a same-day file written before it tracked cached tokens, keeping that file's spend",
    'providers' in snapshot && snapshot.providers.some((row) => row.provider === 'earlier-build-route' && row.spentUsd === 0.001),
    snapshot,
  );
  check(
    "the paid route's settled cost is recorded",
    'providers' in snapshot && snapshot.providers.some((row) => row.provider === 'openrouter-deepseek-v4-flash-paid' && row.spentUsd > 0),
    snapshot,
  );

  // 2. An OpenRouter free route keeps the role output budget, not the paid floor.
  //    The free providers' 500ms min-interval pacing was reserved by scenario 1's
  //    free attempts, so wait it out before issuing a fresh free request.
  await new Promise<void>((resolve) => setTimeout(resolve, 700));
  delete process.env.OPENROUTER_API_KEY_4;
  delete process.env.APEX_PAID_FALLBACK_ENABLED;
  freeQuotaExhausted = false;
  process.env.OPENROUTER_FREE_API_KEY = 'guard-not-a-real-openrouter-key';
  const before = sent.length;
  await ask().catch(() => undefined);
  const free = sent.slice(before).at(0);
  check('the free route is called on OpenRouter', free?.url === 'https://openrouter.ai/api/v1/chat/completions', free?.url);
  check(
    'it still sends the `usage` extension and OpenRouter headers',
    free !== undefined && 'usage' in free.body && 'x-openrouter-metadata' in free.headers,
    { body: free?.body, headers: free?.headers },
  );
  check(
    'free routes keep the role output budget; the paid floor does not apply to them',
    free?.body.max_tokens === Math.min(roleBudget, 16_384),
    { max_tokens: free?.body.max_tokens, roleBudget },
  );

  // 3. The free pool is spent (only the funded account and a free key on it);
  //    paid OpenRouter continuity carries every request that follows.
  delete process.env.OPENROUTER_FREE_API_KEY;
  process.env.OPENROUTER_API_KEY_4 = 'guard-not-a-real-funded-openrouter-key';
  process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
  freeQuotaExhausted = true;
  const paidStart = sent.length;
  const replies: string[] = [];
  for (let i = 0; i < 5; i++) {
    const reply = await ask().catch((err: unknown) => ({ content: `error: ${err instanceof Error ? err.message : String(err)}` }));
    replies.push(String((reply as { content?: string }).content));
  }
  const paidSent = sent.slice(paidStart);
  const viaOpenRouter = paidSent.filter((req) => req.url.startsWith('https://openrouter.ai/'));
  const onPaidModel = paidSent.filter((req) => req.body.model === llm.PAID_FALLBACK_MODEL);
  check('every request is answered once the free pool is spent', replies.every((r) => r === 'guard reply'), replies);
  check(
    'the paid fallback carries the load on OpenRouter, on the funded account',
    onPaidModel.length === 5 &&
      viaOpenRouter.every((req) => req.headers.authorization === 'Bearer guard-not-a-real-funded-openrouter-key'),
    viaOpenRouter.map((req) => new URL(req.url).host),
  );
  check(
    'the paid OpenRouter request asks for DeepSeek V4 Flash 0731 with usage accounting',
    onPaidModel.every((req) => req.body.model === 'deepseek/deepseek-v4-flash-0731' && 'usage' in req.body),
  );
  check(
    'every paid request gets the output floor',
    onPaidModel.every((req) => Number(req.body.max_tokens) >= llm.PAID_MIN_OUTPUT_TOKENS),
    onPaidModel.map((req) => req.body.max_tokens),
  );

  // 4. A paid answer slower than the default request timeout still arrives.
  //     2026-10-05: deepseek-v4-flash-0731 often needed more than 30s on large
  //     agent contexts; every timeout became a capacity pause and a restart.
  check(
    'paid routes wait longer than the default request timeout; free routes keep it',
    llm.getProviderRequestTimeoutMs('openrouter-deepseek-v4-flash-paid') === llm.PAID_REQUEST_TIMEOUT_MS &&
      llm.getProviderRequestTimeoutMs('openrouter-nemotron-super') === llm.LLM_REQUEST_TIMEOUT_MS &&
      llm.LLM_REQUEST_TIMEOUT_MS === GUARD_DEFAULT_TIMEOUT_MS &&
      llm.PAID_REQUEST_TIMEOUT_MS > SLOW_PAID_ANSWER_MS,
    {
      paid: llm.getProviderRequestTimeoutMs('openrouter-deepseek-v4-flash-paid'),
      free: llm.getProviderRequestTimeoutMs('openrouter-nemotron-super'),
      defaultTimeout: llm.LLM_REQUEST_TIMEOUT_MS,
    },
  );
  slowPaidAnswer = true;
  const slowStart = Date.now();
  const slowReply = await ask().then(
    (reply) => String((reply as { content?: string }).content),
    (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
  );
  slowPaidAnswer = false;
  check(
    `a paid answer that takes ${SLOW_PAID_ANSWER_MS / 1000}s (past the ${GUARD_DEFAULT_TIMEOUT_MS / 1000}s default timeout) is received, not aborted`,
    slowReply === 'guard reply' && Date.now() - slowStart >= SLOW_PAID_ANSWER_MS,
    { reply: slowReply.slice(0, 300), elapsedMs: Date.now() - slowStart },
  );

  rmSync(ledgerDir, { recursive: true, force: true });
  console.log(
    failures === 0
      ? '\n✅ The paid continuity route sends a request its API accepts, and Apex no longer calls Nous Portal.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

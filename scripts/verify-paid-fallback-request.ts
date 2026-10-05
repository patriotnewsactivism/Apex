/**
 * Guard: the paid continuity route sends a request its API accepts.
 *
 * On 2026-10-05 the paid route moved from OpenRouter (GLM FlashX) to Nous
 * Portal (DeepSeek V4 Flash). The route had no request pool, and an unset pool
 * counted as OpenRouter, so every request carried OpenRouter's `provider`
 * routing object. Nous refuses that with HTTP 400. With the free pool, Groq
 * and Gemini already exhausted, the paid route was the only one left, and
 * every task failed: 156 "All LLM providers failed" errors in two hours.
 *
 * Later the same day the operator removed Qwen and split the paid model,
 * deepseek/deepseek-v4-flash-0731, between Nous and OpenRouter
 * (OPENROUTER_API_KEY_4). Nous, the cheaper host, goes first on 9 requests in
 * 10 and OpenRouter on the tenth; each is the other's fallback.
 *
 * This drives the real MultiProviderClient.complete() with fetch stubbed, so
 * it checks the request that actually leaves APEX, not the source text:
 *   - the Nous route alone: no `provider`, no `usage`, no OpenRouter headers,
 *     and the reply is used;
 *   - an OpenRouter free route alone: it still gets OpenRouter's fields;
 *   - the split: once the free pool answers 429, paid requests go 9 to Nous
 *     and 1 to OpenRouter in every 10, and the OpenRouter one runs on the
 *     same account whose free quota ran out;
 *   - an unfunded Nous key: OpenRouter answers instead, no task fails;
 *   - Nous alone and unfunded: a capacity pause, not a failed task;
 *   - a paid answer slower than the default request timeout still arrives:
 *     the paid routes wait PAID_REQUEST_TIMEOUT_MS, free routes keep the
 *     default (here lowered to its 10s floor so the check stays fast);
 *   - the spend ledger loads a same-day file written before it tracked cached
 *     tokens, records the paid route's cache hits, and still reports.
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
  'GEMINI_API_KEY', 'APEX_GEMINI_BYOK_ENABLED', 'NOUS_API_KEY', 'APEX_PAID_FALLBACK_ENABLED', 'APEX_OPENROUTER_MODEL_POLICY',
  'APEX_LLM_REQUEST_TIMEOUT_MS',
];
/** Default request timeout for this guard: the configurable floor, so a paid
 *  answer slower than it can be checked in seconds rather than minutes. */
const GUARD_DEFAULT_TIMEOUT_MS = 10_000;
const SLOW_PAID_ANSWER_MS = 11_000;
/** Prompt tokens the stubbed Nous answer reports as served from its cache. */
const NOUS_CACHED_TOKENS = 8;

async function main(): Promise<void> {
  // No database: telemetry and ledgers are best-effort and must not matter.
  process.env.DATABASE_URL = 'postgres://guard:guard@127.0.0.1:9/no_database';
  for (const env of ROUTE_ENVS) delete process.env[env];
  process.env.APEX_LLM_REQUEST_TIMEOUT_MS = String(GUARD_DEFAULT_TIMEOUT_MS);
  // Today's ledger as a build from before cached-token tracking wrote it: no
  // cachedTokens map. The ledger reads its file once, at import.
  const ledgerDir = mkdtempSync(path.join(tmpdir(), 'apex-spend-ledger-'));
  process.env.APEX_SPEND_LEDGER_PATH = path.join(ledgerDir, 'spend-ledger.json');
  writeFileSync(
    process.env.APEX_SPEND_LEDGER_PATH,
    JSON.stringify({ day: new Date().toISOString().slice(0, 10), providers: { 'earlier-build-route': 1_000 } }),
  );

  const sent: Sent[] = [];
  let nousUnfunded = false;
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
    if (nousUnfunded && url.includes('nousresearch.com')) {
      // Nous Portal's exact answer for an unfunded key on 2026-10-05.
      return new Response(
        JSON.stringify({
          status: 401,
          message: 'Your API key is invalid, blocked or out of funds. Please go visit the portal to sort that out: https://portal.nousresearch.com ',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        id: 'guard',
        model: 'guard-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'guard reply' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          ...(url.includes('nousresearch.com') ? { prompt_tokens_details: { cached_tokens: NOUS_CACHED_TOKENS } } : {}),
        },
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

  // 1. Only the paid route is configured, as in production once the free
  //    pool, Groq and Gemini are exhausted.
  process.env.NOUS_API_KEY = 'guard-not-a-real-key';
  process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
  const paidReply = await ask().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  const paid = sent.at(-1);
  check('the paid route is called on Nous Portal', paid?.url === 'https://inference-api.nousresearch.com/v1/chat/completions', paid?.url);
  check('it asks for the paid continuity model', paid?.body.model === llm.PAID_FALLBACK_MODEL, paid?.body.model);
  check("it sends no OpenRouter `provider` object (Nous answers 400 to one)", paid !== undefined && !('provider' in paid.body), paid?.body);
  check('it sends no OpenRouter `usage` extension', paid !== undefined && !('usage' in paid.body), paid?.body);
  check(
    'it sends no OpenRouter headers',
    paid !== undefined && !('http-referer' in paid.headers) && !('x-openrouter-metadata' in paid.headers),
    paid?.headers,
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
    "the paid route's cached prompt tokens are recorded",
    'cachedTokens' in snapshot &&
      snapshot.cachedTokens.some((row) => row.provider === 'nous-deepseek-v4-flash-paid' && row.tokens === NOUS_CACHED_TOKENS),
    snapshot,
  );

  // 2. An OpenRouter route keeps OpenRouter's fields.
  delete process.env.NOUS_API_KEY;
  delete process.env.APEX_PAID_FALLBACK_ENABLED;
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

  // 3. The split. Only the funded OpenRouter account (also in the free roster)
  //    and Nous are configured, and that account's free quota is spent. The
  //    rotation counter is process-wide, so any 10 consecutive requests hold
  //    exactly one OpenRouter-first request, whatever ran before.
  delete process.env.OPENROUTER_FREE_API_KEY;
  process.env.OPENROUTER_API_KEY_4 = 'guard-not-a-real-funded-openrouter-key';
  process.env.NOUS_API_KEY = 'guard-not-a-real-key';
  process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
  freeQuotaExhausted = true;
  const splitStart = sent.length;
  const splitReplies: string[] = [];
  for (let i = 0; i < 10; i++) {
    const reply = await ask().catch((err: unknown) => ({ content: `error: ${err instanceof Error ? err.message : String(err)}` }));
    splitReplies.push(String((reply as { content?: string }).content));
  }
  const splitSent = sent.slice(splitStart);
  const paidSent = splitSent.filter((req) => req.body.model === llm.PAID_FALLBACK_MODEL);
  const viaOpenRouter = paidSent.filter((req) => req.url.startsWith('https://openrouter.ai/'));
  const viaNous = paidSent.filter((req) => req.url.startsWith('https://inference-api.nousresearch.com/'));
  const freeAttempts = splitSent.filter((req) => req.body.model !== llm.PAID_FALLBACK_MODEL);
  check('every request is answered once the free pool is spent', splitReplies.every((r) => r === 'guard reply'), splitReplies);
  check(
    'paid load splits 90/10: 9 of 10 requests on Nous, 1 on OpenRouter',
    viaNous.length === 9 && viaOpenRouter.length === 1 && paidSent.length === 10,
    { openrouter: viaOpenRouter.length, nous: viaNous.length, paid: paidSent.length },
  );
  check(
    "a free-quota 429 does not block the same account's paid OpenRouter route",
    viaOpenRouter.length > 0 && viaOpenRouter.every((req) => req.headers.authorization === 'Bearer guard-not-a-real-funded-openrouter-key'),
    viaOpenRouter.map((req) => req.headers.authorization?.slice(0, 12)),
  );
  check(
    'the spent free pool is not retried on every request',
    freeAttempts.length === 1,
    freeAttempts.map((req) => req.body.model),
  );
  const orPaid = viaOpenRouter[0];
  check(
    'the OpenRouter paid request asks for DeepSeek V4 Flash 0731 sorted by latency, with usage accounting',
    orPaid?.body.model === 'deepseek/deepseek-v4-flash-0731' &&
      (orPaid?.body.provider as { sort?: string } | undefined)?.sort === 'latency' &&
      'usage' in (orPaid?.body ?? {}),
    orPaid?.body,
  );
  check(
    'both paid routes get the output floor',
    paidSent.length > 0 && paidSent.every((req) => Number(req.body.max_tokens) >= llm.PAID_MIN_OUTPUT_TOKENS),
    paidSent.map((req) => req.body.max_tokens),
  );
  check(
    'the Nous half still carries no OpenRouter fields',
    viaNous.length > 0 && viaNous.every((req) => !('provider' in req.body) && !('usage' in req.body)),
  );

  // 4. Nous runs out of funds mid-split: OpenRouter answers at once, every
  //    request still succeeds.
  nousUnfunded = true;
  const fallbackStart = sent.length;
  const fallbackReplies: string[] = [];
  for (let i = 0; i < 4; i++) {
    const reply = await ask().catch((err: unknown) => ({ content: `error: ${err instanceof Error ? err.message : String(err)}` }));
    fallbackReplies.push(String((reply as { content?: string }).content));
  }
  const fallbackPaid = sent.slice(fallbackStart).filter((req) => req.body.model === llm.PAID_FALLBACK_MODEL);
  check(
    'an unfunded Nous key falls to OpenRouter immediately; no request fails',
    fallbackReplies.every((r) => r === 'guard reply'),
    fallbackReplies,
  );
  check(
    'after one 401, Nous is left alone and OpenRouter takes the load',
    fallbackPaid.filter((req) => req.url.includes('nousresearch.com')).length <= 1 &&
      fallbackPaid.filter((req) => req.url.startsWith('https://openrouter.ai/')).length === 4,
    fallbackPaid.map((req) => new URL(req.url).host),
  );

  // 4b. A paid answer slower than the default request timeout still arrives.
  //     2026-10-05: deepseek-v4-flash-0731 often needed more than 30s on large
  //     agent contexts; every timeout became a capacity pause and a restart.
  check(
    'paid routes wait longer than the default request timeout; free routes keep it',
    llm.getProviderRequestTimeoutMs('openrouter-deepseek-v4-flash-paid') === llm.PAID_REQUEST_TIMEOUT_MS &&
      llm.getProviderRequestTimeoutMs('nous-deepseek-v4-flash-paid') === llm.PAID_REQUEST_TIMEOUT_MS &&
      llm.getProviderRequestTimeoutMs('openrouter-nex-n2-5-mini-free') === llm.LLM_REQUEST_TIMEOUT_MS &&
      llm.LLM_REQUEST_TIMEOUT_MS === GUARD_DEFAULT_TIMEOUT_MS &&
      llm.PAID_REQUEST_TIMEOUT_MS > SLOW_PAID_ANSWER_MS,
    {
      paid: llm.getProviderRequestTimeoutMs('openrouter-deepseek-v4-flash-paid'),
      free: llm.getProviderRequestTimeoutMs('openrouter-nex-n2-5-mini-free'),
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

  // 5. Nous alone and unfunded is a capacity pause, not a failed task: the
  //    work waits, and the route is tried again after the credit cooldown.
  delete process.env.OPENROUTER_API_KEY_4;
  freeQuotaExhausted = false;
  process.env.NOUS_API_KEY = 'guard-not-a-real-key-unfunded';
  process.env.APEX_PAID_FALLBACK_ENABLED = 'true';
  nousUnfunded = true;
  const unfunded = await ask().then(
    () => 'no error',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  const resumeAt = Date.parse(/resume-at=(\S+)/.exec(unfunded)?.[1] ?? '');
  check(
    'an "out of funds" 401 from Nous pauses for capacity instead of failing the task',
    unfunded.startsWith('APEX LLM capacity paused.'),
    unfunded.slice(0, 300),
  );
  check(
    'the paid route is tried again within hours, not only at the next free-pool reset',
    Number.isFinite(resumeAt) && resumeAt - Date.now() > 5 * 3_600_000 && resumeAt - Date.now() <= 6 * 3_600_000 + 60_000,
    { resumeAt: Number.isFinite(resumeAt) ? new Date(resumeAt).toISOString() : null },
  );

  rmSync(ledgerDir, { recursive: true, force: true });
  console.log(
    failures === 0
      ? '\n✅ The paid continuity routes send requests their APIs accept, and share the load.\n'
      : `\n❌ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * OpenRouter credit balance, surfaced so it cannot run out unnoticed.
 *
 * WHY THIS EXISTS
 * ------------------------------------------------------------------
 * On 2026-09-12 APEX was serving HTTP 402 on every single LLM request. The
 * account had $20 of credits against $24.28 of usage, the automatic routing
 * chain was paid-only, and nothing anywhere reported either fact. From outside
 * the failure was invisible in the usual way: /health said `ok`, the task queue
 * said `ok`, the workforce was alive and polling, and tasks were being claimed
 * — and every one of them failed.
 *
 * The balance is a number the provider will happily tell us at any time. Not
 * asking for it was the whole bug, in the same shape as metering tokens while
 * requests were what ran out.
 *
 * Deliberately NOT counted against the daily request budget: this is an account
 * endpoint, not a generation, so it consumes no part of the free allowance.
 * Deliberately cached: /health is polled continuously and this must not turn
 * into its own traffic source.
 */

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const REFRESH_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

/** Balance below which the roster is one busy day from a 402 wall. */
const LOW_BALANCE_USD = 2;

export interface ProviderCreditSnapshot {
  checkedAt: string;
  /** Total credits ever purchased on the account. */
  totalCredits: number;
  /** Total spend to date. */
  totalUsage: number;
  /** What is actually left. Negative means the account is overdrawn. */
  remaining: number;
  status: 'ok' | 'low' | 'exhausted' | 'unknown';
  detail: string | null;
}

let cached: ProviderCreditSnapshot | null = null;
let inFlight: Promise<void> | null = null;
let lastAttemptAt = 0;

function creditKey(): string | undefined {
  for (const env of [
    'OPENROUTER_API_KEY',
    'OPENROUTER_FREE_API_KEY',
    'OPENROUTER_API_KEY_2',
    'OPENROUTER_API_KEY_3',
    'OPENROUTER_BYOK_API_KEY',
  ]) {
    const value = process.env[env];
    if (value) return value;
  }
  return undefined;
}

async function fetchCredits(): Promise<void> {
  const key = creditKey();
  if (!key) {
    cached = {
      checkedAt: new Date().toISOString(),
      totalCredits: 0,
      totalUsage: 0,
      remaining: 0,
      status: 'unknown',
      detail: 'no OpenRouter API key configured',
    };
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CREDITS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      cached = {
        checkedAt: new Date().toISOString(),
        totalCredits: 0,
        totalUsage: 0,
        remaining: 0,
        status: 'unknown',
        detail: `credits endpoint returned HTTP ${response.status}`,
      };
      return;
    }
    const payload = (await response.json()) as {
      data?: { total_credits?: number; total_usage?: number };
    };
    const totalCredits = Number(payload.data?.total_credits ?? 0);
    const totalUsage = Number(payload.data?.total_usage ?? 0);
    const remaining =
      Math.round((totalCredits - totalUsage + Number.EPSILON) * 100) / 100;
    cached = {
      checkedAt: new Date().toISOString(),
      totalCredits,
      totalUsage,
      remaining,
      status: remaining <= 0 ? 'exhausted' : remaining < LOW_BALANCE_USD ? 'low' : 'ok',
      detail:
        remaining <= 0
          ? 'OpenRouter credits are exhausted — every PAID model returns HTTP 402. ' +
            'Free routing is unaffected. Add credits at https://openrouter.ai/settings/credits'
          : remaining < LOW_BALANCE_USD
            ? 'OpenRouter balance is nearly spent; paid rungs will start failing soon.'
            : null,
    };
  } catch (error) {
    cached = {
      checkedAt: new Date().toISOString(),
      totalCredits: 0,
      totalUsage: 0,
      remaining: 0,
      status: 'unknown',
      detail: error instanceof Error ? error.message : 'credits lookup failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Last known balance, refreshing in the background when stale.
 *
 * Never awaits the network: /health has to answer even when OpenRouter is the
 * thing that is down, and a health endpoint that hangs on a third party is a
 * worse outage than the one it is reporting. First call returns null, and the
 * value appears on the next poll.
 */
export function getProviderCreditSnapshot(): ProviderCreditSnapshot | null {
  const now = Date.now();
  const stale = !cached || now - Date.parse(cached.checkedAt) > REFRESH_MS;
  if (stale && !inFlight && now - lastAttemptAt > 30_000) {
    lastAttemptAt = now;
    inFlight = fetchCredits().finally(() => {
      inFlight = null;
    });
  }
  return cached;
}

/** Warm the cache at boot so the first /health already carries a balance. */
export async function initializeProviderCredits(): Promise<ProviderCreditSnapshot | null> {
  lastAttemptAt = Date.now();
  await fetchCredits();
  return cached;
}

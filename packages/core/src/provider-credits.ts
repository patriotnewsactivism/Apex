/**
 * OpenRouter credit balance and account identity, surfaced so a missing or
 * duplicated account cannot hide behind three env names.
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
 * A second, quieter failure mode is keys that look like extra capacity and are
 * not. OpenRouter's free allowance is per ACCOUNT, not per API key. Three env
 * names can hold three strings and still be one account, or two. The request
 * ledger fingerprints the key, so it will happily load-balance across two keys
 * that share a 1,000/day bucket. The only way to see that from outside is to
 * ask OpenRouter which user each live key belongs to.
 *
 * GET /api/v1/key (inference key) returns creator_user_id. That id is hashed
 * before it ever touches /health — the public payload shows `oracct_<8 hex>`,
 * which is enough to tell "three keys, two accounts" without leaking the
 * OpenRouter user id. GET /api/v1/credits is probed per unique key so a single
 * exhausted account cannot paint the whole roster as empty.
 *
 * Optional management keys (OPENROUTER_MGMT_KEY*) cannot run inference. When
 * present they list that account's keys so APEX can say whether the live
 * inference key is actually a member of that account. They never auto-create
 * or rotate credentials; minting a key is an operator action.
 *
 * Deliberately NOT counted against the daily request budget: these are account
 * endpoints, not generations. Deliberately cached: /health is polled
 * continuously and this must not turn into its own traffic source.
 */

import { createHash } from 'crypto';
import { accountFingerprint, setObservedAccounts } from './request-ledger.js';

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const KEYS_URL = 'https://openrouter.ai/api/v1/keys';
const REFRESH_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

/** Balance below which the roster is one busy day from a 402 wall. */
const LOW_BALANCE_USD = 2;

/** Same roster as OPENROUTER_FREE_KEY_ENVS — keep the two lists identical. */
export const OPENROUTER_CREDIT_KEY_ENVS = [
  'OPENROUTER_FREE_API_KEY',
  'OPENROUTER_API_KEY_2',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY_3',
  'OPENROUTER_API_KEY_4',
] as const;

/** One management key per independent OpenRouter account. Cannot infer. */
export const OPENROUTER_MGMT_KEY_ENVS = [
  'OPENROUTER_MGMT_KEY',
  'OPENROUTER_MGMT_KEY_2',
  'OPENROUTER_MGMT_KEY_3',
  'OPENROUTER_MGMT_KEY_4',
] as const;

export interface ProviderAccountSnapshot {
  /** Env names currently holding this key, joined if several names share it. */
  env: string;
  /**
   * Stable public identity of the OpenRouter USER this key belongs to.
   * `oracct_<8 hex>` of creator_user_id, or `keyfp_<16 hex>` when OpenRouter
   * did not return a user id (falls back to the key fingerprint, which cannot
   * prove two keys are different accounts).
   */
  account: string;
  remaining: number | null;
  totalCredits: number | null;
  totalUsage: number | null;
  isFreeTier: boolean | null;
  dailyLimit: number | null;
  status: 'ok' | 'low' | 'exhausted' | 'unknown';
  detail: string | null;
}

export interface ProviderManagementSnapshot {
  env: string;
  listedKeys: number;
  /** True when a live inference key's sha256 appears in this account's list. */
  liveInferenceKeyMatched: boolean;
  detail: string | null;
}

export interface ProviderCreditSnapshot {
  checkedAt: string;
  /** Unique live inference keys (fingerprint of the key, not the env name). */
  loadedKeys: number;
  /** Unique OpenRouter users those keys belong to. */
  uniqueAccounts: number;
  /** True when more keys are loaded than OpenRouter users — shared quota. */
  sharedQuota: boolean;
  /** Total credits ever purchased on the most-alarming probed account. */
  totalCredits: number;
  /** Total spend to date on that same account. */
  totalUsage: number;
  /** What is actually left on the most-alarming probed account. */
  remaining: number;
  status: 'ok' | 'low' | 'exhausted' | 'unknown';
  detail: string | null;
  accounts: ProviderAccountSnapshot[];
  management: ProviderManagementSnapshot[];
}

let cached: ProviderCreditSnapshot | null = null;
let inFlight: Promise<void> | null = null;
let lastAttemptAt = 0;

interface UniqueCredential {
  env: string;
  key: string;
  fingerprint: string;
}

function configuredInferenceCredentials(): UniqueCredential[] {
  const out: UniqueCredential[] = [];
  for (const env of OPENROUTER_CREDIT_KEY_ENVS) {
    const key = process.env[env];
    if (!key) continue;
    const fingerprint = accountFingerprint(key);
    const existing = out.find((entry) => entry.fingerprint === fingerprint);
    if (existing) {
      existing.env = `${existing.env} + ${env}`;
      continue;
    }
    out.push({ env, key, fingerprint });
  }
  return out;
}

function configuredManagementCredentials(): Array<{ env: string; key: string }> {
  const seen = new Set<string>();
  const out: Array<{ env: string; key: string }> = [];
  for (const env of OPENROUTER_MGMT_KEY_ENVS) {
    const key = process.env[env];
    if (!key) continue;
    const fingerprint = accountFingerprint(key);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ env, key });
  }
  return out;
}

function publicAccountId(creatorUserId: string | null | undefined, keyFingerprint: string): string {
  if (!creatorUserId || !creatorUserId.trim()) return `keyfp_${keyFingerprint}`;
  const digest = createHash('sha256').update(creatorUserId.trim()).digest('hex').slice(0, 8);
  return `oracct_${digest}`;
}

function keySha256(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function creditStatus(remaining: number | null): ProviderAccountSnapshot['status'] {
  if (remaining === null || !Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 0) return 'exhausted';
  if (remaining < LOW_BALANCE_USD) return 'low';
  return 'ok';
}

async function fetchJson(
  url: string,
  apiKey: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

interface OpenRouterKeyMetadata {
  creator_user_id?: string | null;
  is_free_tier?: boolean;
  rate_limit?: { requests?: number; interval?: string };
  usage?: number;
  label?: string;
}

interface OpenRouterCredits {
  total_credits?: number;
  total_usage?: number;
}

async function probeInferenceKey(entry: UniqueCredential): Promise<ProviderAccountSnapshot> {
  const [creditsRes, keyRes] = await Promise.all([
    fetchJson(CREDITS_URL, entry.key),
    fetchJson(KEY_URL, entry.key),
  ]);

  const credits = (creditsRes.ok
    ? ((creditsRes.body as { data?: OpenRouterCredits } | null)?.data ?? null)
    : null);
  const meta = (keyRes.ok
    ? ((keyRes.body as { data?: OpenRouterKeyMetadata } | null)?.data ?? null)
    : null);

  const totalCredits = credits && Number.isFinite(Number(credits.total_credits))
    ? Number(credits.total_credits)
    : null;
  const totalUsage = credits && Number.isFinite(Number(credits.total_usage))
    ? Number(credits.total_usage)
    : null;
  const remaining = totalCredits !== null && totalUsage !== null
    ? Math.round((totalCredits - totalUsage + Number.EPSILON) * 100) / 100
    : null;

  const dailyLimit = Number.isFinite(Number(meta?.rate_limit?.requests))
    ? Number(meta?.rate_limit?.requests)
    : null;
  const account = publicAccountId(meta?.creator_user_id ?? null, entry.fingerprint);
  const identityKnown = account.startsWith('oracct_');

  const parts: string[] = [];
  if (!creditsRes.ok) parts.push(`credits HTTP ${creditsRes.status}`);
  if (!keyRes.ok) parts.push(`key HTTP ${keyRes.status}`);
  if (!identityKnown && keyRes.ok) {
    parts.push('OpenRouter did not return creator_user_id; this row cannot prove a distinct account');
  }
  if (remaining !== null && remaining <= 0) {
    parts.push('paid credits exhausted — :free routing is unaffected');
  }

  return {
    env: entry.env,
    account,
    remaining,
    totalCredits,
    totalUsage,
    isFreeTier: typeof meta?.is_free_tier === 'boolean' ? meta.is_free_tier : null,
    dailyLimit,
    status: creditStatus(remaining),
    detail: parts.length > 0 ? parts.join('; ') : null,
  };
}

function listedKeyHashes(body: unknown): string[] {
  const root = body as { data?: unknown } | null;
  const data = root?.data ?? body;
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { keys?: unknown } | null)?.keys)
      ? ((data as { keys: unknown[] }).keys)
      : [];
  const hashes: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const hash = (row as { hash?: unknown }).hash;
    if (typeof hash === 'string' && hash.length > 0) hashes.push(hash.toLowerCase());
  }
  return hashes;
}

async function probeManagementKey(
  entry: { env: string; key: string },
  liveKeyHashes: Set<string>,
): Promise<ProviderManagementSnapshot> {
  try {
    const result = await fetchJson(KEYS_URL, entry.key);
    if (!result.ok) {
      return {
        env: entry.env,
        listedKeys: 0,
        liveInferenceKeyMatched: false,
        detail: `keys HTTP ${result.status} — management keys cannot infer; this endpoint lists this account's inference keys`,
      };
    }
    const hashes = listedKeyHashes(result.body);
    const matched = hashes.some((hash) => liveKeyHashes.has(hash));
    return {
      env: entry.env,
      listedKeys: hashes.length,
      liveInferenceKeyMatched: matched,
      detail: matched
        ? null
        : hashes.length === 0
          ? 'account listed zero inference keys'
          : 'no live APEX inference key is a member of this OpenRouter account',
    };
  } catch (error) {
    return {
      env: entry.env,
      listedKeys: 0,
      liveInferenceKeyMatched: false,
      detail: error instanceof Error ? error.message : 'management key listing failed',
    };
  }
}

function summarize(
  accounts: ProviderAccountSnapshot[],
  management: ProviderManagementSnapshot[],
  identities: ReadonlyMap<string, string>,
): ProviderCreditSnapshot {
  const loadedKeys = accounts.length;
  const knownIds = new Set(accounts.map((account) => account.account));
  const uniqueAccounts = knownIds.size;
  const sharedQuota = loadedKeys > uniqueAccounts && uniqueAccounts > 0;

  // Tell the request ledger which OpenRouter ACCOUNT each key belongs to. Only
  // OpenRouter can answer that: the ledger fingerprints keys, and a fingerprint
  // cannot show that two different keys were issued by one user. Without the
  // mapping both halves of the budget misread the same way — observed
  // 2026-09-14 with 3 keys across 2 accounts:
  //
  //   the cap      read 2,800 against a true ceiling of 2,000;
  //   the balancer levelled keys, driving 1,016 requests through a 1,000/day
  //                account while another finished the window 263 short.
  //
  // Only a resolved mapping is published. A failed probe leaves the configured
  // cap and the existing grouping alone rather than starving the workforce.
  setObservedAccounts(identities.size > 0 ? identities : null);

  const withBalance = accounts.filter((account) => account.remaining !== null);
  const mostAlarming = withBalance.length > 0
    ? withBalance.reduce((worst, account) =>
        (account.remaining ?? 0) < (worst.remaining ?? 0) ? account : worst)
    : null;

  const remaining = mostAlarming?.remaining ?? 0;
  const status = loadedKeys === 0
    ? 'unknown'
    : mostAlarming
      ? creditStatus(mostAlarming.remaining)
      : 'unknown';

  const parts: string[] = [];
  if (loadedKeys === 0) {
    parts.push('no OpenRouter inference key configured');
  } else {
    parts.push(`${loadedKeys} live key${loadedKeys === 1 ? '' : 's'} across ${uniqueAccounts} OpenRouter account${uniqueAccounts === 1 ? '' : 's'}`);
  }
  if (sharedQuota) {
    parts.push('two or more keys share one OpenRouter account and therefore one :free daily bucket');
  }
  const unmatchedMgmt = management.filter((row) => !row.liveInferenceKeyMatched);
  if (unmatchedMgmt.length > 0 && management.length > 0) {
    parts.push(
      `${unmatchedMgmt.map((row) => row.env).join(', ')} did not list a live APEX inference key`,
    );
  }
  if (mostAlarming && mostAlarming.remaining !== null && mostAlarming.remaining <= 0) {
    parts.push('at least one account has exhausted paid credits — :free routing is unaffected');
  }

  return {
    checkedAt: new Date().toISOString(),
    loadedKeys,
    uniqueAccounts,
    sharedQuota,
    totalCredits: mostAlarming?.totalCredits ?? 0,
    totalUsage: mostAlarming?.totalUsage ?? 0,
    remaining,
    status,
    detail: parts.join('. ') + (parts.length > 0 ? '.' : ''),
    accounts,
    management,
  };
}

async function fetchCredits(): Promise<void> {
  const inference = configuredInferenceCredentials();
  if (inference.length === 0) {
    cached = summarize([], [], new Map());
    return;
  }

  const accounts = await Promise.all(
    inference.map((entry) =>
      probeInferenceKey(entry).catch((error): ProviderAccountSnapshot => ({
        env: entry.env,
        account: `keyfp_${entry.fingerprint}`,
        remaining: null,
        totalCredits: null,
        totalUsage: null,
        isFreeTier: null,
        dailyLimit: null,
        status: 'unknown',
        detail: error instanceof Error ? error.message : 'account lookup failed',
      })),
    ),
  );

  // Promise.all preserves order, so each probe result lines up with the
  // credential it came from — which is the only place the key fingerprint and
  // the OpenRouter account id are both in hand. The fingerprint stays here and
  // never reaches the /health payload.
  const identities = new Map<string, string>(
    inference.map((entry, index) => [entry.fingerprint, accounts[index].account]),
  );

  const liveHashes = new Set(inference.map((entry) => keySha256(entry.key)));
  const management = await Promise.all(
    configuredManagementCredentials().map((entry) => probeManagementKey(entry, liveHashes)),
  );

  cached = summarize(accounts, management, identities);
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

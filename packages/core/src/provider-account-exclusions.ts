import { accountFingerprint, observedAccountFor } from "./request-ledger.js";

const COMPONENT_PREFIX = "llm-provider-account-exclusion:";
const CREDIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 30_000;

const DAILY_QUOTA_PATTERN =
  /\b(per[\s-]?day|daily|tokens per day|tpd|quota exhausted|daily limit|daily quota|free tier|free quota|free-models-per-day|openrouter_free_tier_daily|allocationquota)\b/i;
// "out of funds": Nous Portal answers an unfunded key with HTTP 401 "Your API
// key is invalid, blocked or out of funds". Read as an auth error, every task
// failed until midnight UTC; read as exhausted credit, tasks wait and the
// route is tried again after CREDIT_COOLDOWN_MS.
const CREDIT_EXHAUSTED_PATTERN =
  /\b(payment required|insufficient credits?|credits? exhausted|no credits?|negative balance|billing required|out of funds)\b/i;

/**
 * "all" blocks every route on the account. "paid" blocks only paid routing
 * (non-positive balance). "free" blocks only :free routing: OpenRouter's
 * free-model daily quota and per-minute limit do not apply to paid models, so
 * a free-pool 429 must not take the account's paid route down with it.
 */
export type OpenRouterAccountExclusionScope = "all" | "paid" | "free";
export type OpenRouterAccountExclusionKind =
  | "credit_exhausted"
  | "credit_balance"
  | "daily_quota"
  | "rate_limit"
  /** Operator-configured low-balance pause set by the OpenRouter balance
   * monitor (openrouter-balance-monitor.ts). Always scope "paid": the account
   * keeps serving :free models. Held separately from failure exclusions so a
   * daily-quota or rate-limit exclusion can never overwrite (and, on expiry,
   * silently lift) a balance pause. */
  | "balance_pause";

export interface OpenRouterAccountExclusion {
  account: string;
  scope: OpenRouterAccountExclusionScope;
  kind: OpenRouterAccountExclusionKind;
  status: number | null;
  reason: string;
  excludedAt: string;
  resumeAt: string | null;
}

type StoredExclusion = {
  account: string;
  scope: OpenRouterAccountExclusionScope;
  kind: OpenRouterAccountExclusionKind;
  status: number | null;
  reason: string;
  excludedAt: number;
  until: number | null;
};

type ProviderAccountHealthMetadata = {
  version: 1;
  exclusion: OpenRouterAccountExclusion;
};

/** Keyed by exclusionKey(): the account id for "all"/"paid" entries and
 *  `free:<account>` for "free" entries, so a free-pool exclusion and a paid
 *  balance exclusion on one account never overwrite each other. */
const exclusions = new Map<string, StoredExclusion>();

function exclusionKey(entry: { account: string; scope: OpenRouterAccountExclusionScope }): string {
  return entry.scope === "free" ? `free:${entry.account}` : entry.account;
}
let persistenceReady = false;

type BalancePause = { reason: string; since: number };
/** Paid-only pauses owned by the OpenRouter balance monitor, keyed by the
 *  public account id (`oracct_…`). The monitor persists its own state and
 *  re-applies these at boot, so this map is intentionally memory-only. */
const balancePauses = new Map<string, BalancePause>();

function accountIdForKey(apiKey: string): string {
  const fingerprint = accountFingerprint(apiKey);
  return observedAccountFor(fingerprint) ?? `keyfp_${fingerprint}`;
}

function sanitizeReason(reason: string): string {
  return reason
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted credential]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}

function publicExclusion(entry: StoredExclusion): OpenRouterAccountExclusion {
  return {
    account: entry.account,
    scope: entry.scope,
    kind: entry.kind,
    status: entry.status,
    reason: entry.reason,
    excludedAt: new Date(entry.excludedAt).toISOString(),
    resumeAt: entry.until === null ? null : new Date(entry.until).toISOString(),
  };
}

function isStoredExclusion(
  value: unknown,
): value is OpenRouterAccountExclusion {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<OpenRouterAccountExclusion>;
  return (
    typeof entry.account === "string" &&
    (entry.scope === "all" || entry.scope === "paid" || entry.scope === "free") &&
    (entry.kind === "credit_exhausted" ||
      entry.kind === "credit_balance" ||
      entry.kind === "daily_quota" ||
      entry.kind === "rate_limit") &&
    typeof entry.reason === "string" &&
    typeof entry.excludedAt === "string" &&
    (entry.resumeAt === null || typeof entry.resumeAt === "string")
  );
}

function fromPublicExclusion(
  entry: OpenRouterAccountExclusion,
): StoredExclusion | null {
  const excludedAt = Date.parse(entry.excludedAt);
  const until = entry.resumeAt === null ? null : Date.parse(entry.resumeAt);
  if (!Number.isFinite(excludedAt)) return null;
  if (until !== null && !Number.isFinite(until)) return null;
  return {
    account: entry.account,
    scope: entry.scope,
    kind: entry.kind,
    status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : null,
    reason: sanitizeReason(entry.reason),
    excludedAt,
    until,
  };
}

async function persistExclusion(entry: StoredExclusion): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  try {
    const [{ db, componentHealth }] = await Promise.all([
      import("@workspace/db"),
    ]);
    const now = new Date();
    const exclusion = publicExclusion(entry);
    await db
      .insert(componentHealth)
      .values({
        component: `${COMPONENT_PREFIX}${exclusionKey(entry)}`,
        status: "degraded",
        detail: `${entry.kind}: ${entry.reason}`,
        lastCheckTime: now,
        consecutiveFailures: 1,
        metadata: {
          version: 1,
          exclusion,
        } satisfies ProviderAccountHealthMetadata,
      })
      .onConflictDoUpdate({
        target: componentHealth.component,
        set: {
          status: "degraded",
          detail: `${entry.kind}: ${entry.reason}`,
          lastCheckTime: now,
          consecutiveFailures: 1,
          metadata: {
            version: 1,
            exclusion,
          } satisfies ProviderAccountHealthMetadata,
        },
      });
    persistenceReady = true;
  } catch {
    persistenceReady = false;
  }
}

async function removePersistedExclusion(key: string): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  try {
    const [{ db, componentHealth }, { eq }] = await Promise.all([
      import("@workspace/db"),
      import("drizzle-orm"),
    ]);
    await db
      .delete(componentHealth)
      .where(eq(componentHealth.component, `${COMPONENT_PREFIX}${key}`));
    persistenceReady = true;
  } catch {
    persistenceReady = false;
  }
}

function deleteExclusion(key: string): void {
  if (!exclusions.delete(key)) return;
  void removePersistedExclusion(key);
}

function setExclusion(entry: StoredExclusion): void {
  const key = exclusionKey(entry);
  if (entry.scope === "free") {
    // An "all" exclusion that lasts at least as long already covers it.
    const all = exclusions.get(entry.account);
    if (
      all?.scope === "all" &&
      (all.until ?? Number.POSITIVE_INFINITY) >= (entry.until ?? Number.POSITIVE_INFINITY)
    ) {
      return;
    }
  }
  const existing = exclusions.get(key);
  if (existing) {
    const existingScopeRank = existing.scope === "all" ? 2 : 1;
    const nextScopeRank = entry.scope === "all" ? 2 : 1;
    const existingUntil = existing.until ?? Number.POSITIVE_INFINITY;
    const nextUntil = entry.until ?? Number.POSITIVE_INFINITY;
    if (
      existingScopeRank > nextScopeRank ||
      (existingScopeRank === nextScopeRank && existingUntil > nextUntil)
    ) {
      return;
    }
  }
  exclusions.set(key, entry);
  void persistExclusion(entry);
}

function activeExclusion(key: string, now: number): StoredExclusion | null {
  const entry = exclusions.get(key);
  if (!entry) return null;
  if (entry.until !== null && now >= entry.until) {
    deleteExclusion(key);
    return null;
  }
  return entry;
}

function activeExclusionByAccount(
  account: string,
  now: number,
): StoredExclusion | null {
  return activeExclusion(account, now);
}

/** The account's "all"/"paid" entry, or with `free: true` its "free" entry. */
function exclusionForKey(
  apiKey: string,
  now: number,
  options: { free?: boolean } = {},
): StoredExclusion | null {
  const fingerprint = accountFingerprint(apiKey);
  const canonicalAccount = accountIdForKey(apiKey);
  const keyFor = (account: string) => (options.free ? `free:${account}` : account);
  const canonical = activeExclusion(keyFor(canonicalAccount), now);
  if (canonical) return canonical;

  // A failure can occur before the account probe resolves creator_user_id.
  // Once identity becomes known, carry that key-fingerprint exclusion forward
  // so sibling keys from the same account do not become an accidental escape.
  const fallbackAccount = `keyfp_${fingerprint}`;
  if (fallbackAccount === canonicalAccount) return null;
  const fallback = activeExclusion(keyFor(fallbackAccount), now);
  if (!fallback) return null;
  exclusions.delete(keyFor(fallbackAccount));
  void removePersistedExclusion(keyFor(fallbackAccount));
  const migrated = { ...fallback, account: canonicalAccount };
  setExclusion(migrated);
  return migrated;
}

export function classifyOpenRouterAccountFailure(
  status: number | undefined,
  message: string,
  now: number = Date.now(),
  retryAfterMs?: number,
  /** True when the failing request went to a :free route. Its quota and rate
   *  limits are free-pool limits, so they exclude only free routing. */
  freeRoute: boolean = false,
): Omit<StoredExclusion, "account"> | null {
  const reason = sanitizeReason(message);
  let kind: OpenRouterAccountExclusionKind;
  let until: number;

  if (status === 402 || CREDIT_EXHAUSTED_PATTERN.test(message)) {
    kind = "credit_exhausted";
    until = now + CREDIT_COOLDOWN_MS;
  } else if (
    DAILY_QUOTA_PATTERN.test(message) &&
    (status === 401 || status === 403 || status === 429 || status === undefined)
  ) {
    kind = "daily_quota";
    until = nextUtcMidnight(now);
  } else if (status === 429) {
    kind = "rate_limit";
    until = now + RATE_LIMIT_COOLDOWN_MS;
  } else {
    return null;
  }

  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    until = Math.max(until, now + Math.max(0, retryAfterMs));
  }
  return {
    scope: freeRoute && kind !== "credit_exhausted" ? "free" : "all",
    kind,
    status: status ?? null,
    reason: reason || kind,
    excludedAt: now,
    until,
  };
}

export function excludeOpenRouterAccountForFailure(
  apiKey: string,
  status: number | undefined,
  message: string,
  retryAfterMs?: number,
  now: number = Date.now(),
  freeRoute: boolean = false,
): OpenRouterAccountExclusion | null {
  const classified = classifyOpenRouterAccountFailure(
    status,
    message,
    now,
    retryAfterMs,
    freeRoute,
  );
  if (!classified) return null;
  const entry = {
    account: accountIdForKey(apiKey),
    ...classified,
  };
  setExclusion(entry);
  return publicExclusion(entry);
}

function publicBalancePause(
  account: string,
  pause: BalancePause,
): OpenRouterAccountExclusion {
  return {
    account,
    scope: "paid",
    kind: "balance_pause",
    status: null,
    reason: pause.reason,
    excludedAt: new Date(pause.since).toISOString(),
    resumeAt: null,
  };
}

export function getOpenRouterAccountExclusion(
  apiKey: string,
  options: { paid?: boolean; now?: number } = {},
): OpenRouterAccountExclusion | null {
  const now = options.now ?? Date.now();
  const entry = exclusionForKey(apiKey, now);
  if (entry && (entry.scope === "all" || options.paid === true)) {
    return publicExclusion(entry);
  }
  if (options.paid !== true) {
    const free = exclusionForKey(apiKey, now, { free: true });
    if (free) return publicExclusion(free);
  }
  if (options.paid === true) {
    const account = accountIdForKey(apiKey);
    const pause = balancePauses.get(account);
    if (pause) return publicBalancePause(account, pause);
  }
  return null;
}

/**
 * Block PAID routing through one OpenRouter account while leaving its :free
 * routing untouched. Idempotent: re-pausing keeps the original `since`.
 */
export function setOpenRouterPaidBalancePause(
  account: string,
  reason: string,
  now: number = Date.now(),
): void {
  const existing = balancePauses.get(account);
  balancePauses.set(account, {
    reason: sanitizeReason(reason),
    since: existing?.since ?? now,
  });
}

/** Lift a balance pause. Returns true when a pause was actually removed. */
export function clearOpenRouterPaidBalancePause(account: string): boolean {
  return balancePauses.delete(account);
}

export function getOpenRouterPaidBalancePauses(): OpenRouterAccountExclusion[] {
  return [...balancePauses.entries()].map(([account, pause]) =>
    publicBalancePause(account, pause),
  );
}

export function reconcileOpenRouterCreditBalances(
  accounts: ReadonlyArray<{
    account: string;
    remaining: number | null;
  }>,
  now: number = Date.now(),
): void {
  for (const account of accounts) {
    if (account.remaining === null || !Number.isFinite(account.remaining))
      continue;
    const existing = activeExclusionByAccount(account.account, now);
    if (account.remaining <= 0) {
      if (existing?.scope === "all") continue;
      setExclusion({
        account: account.account,
        scope: "paid",
        kind: "credit_balance",
        status: null,
        reason: "OpenRouter account balance is not positive",
        excludedAt: now,
        until: null,
      });
    } else if (existing?.kind === "credit_balance") {
      deleteExclusion(account.account);
    }
  }
}

export function getOpenRouterAccountExclusionReport(
  credentials: ReadonlyArray<{ env: string; key: string }> = [],
  now: number = Date.now(),
): {
  persistence: "postgres+memory" | "memory-only";
  exclusions: Array<OpenRouterAccountExclusion & { credentials: string[] }>;
} {
  const active = [...exclusions.keys()]
    .map((key) => activeExclusion(key, now))
    .filter((entry): entry is StoredExclusion => entry !== null);
  const credentialsFor = (account: string): string[] =>
    credentials
      .filter(({ key }) => accountIdForKey(key) === account)
      .map(({ env }) => env)
      .sort();
  return {
    persistence: persistenceReady ? "postgres+memory" : "memory-only",
    exclusions: [
      ...active.map((entry) => ({
        ...publicExclusion(entry),
        credentials: credentialsFor(entry.account),
      })),
      ...getOpenRouterPaidBalancePauses().map((entry) => ({
        ...entry,
        credentials: credentialsFor(entry.account),
      })),
    ],
  };
}

export async function initializeProviderAccountExclusions(
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const [{ db, componentHealth }, { like }] = await Promise.all([
      import("@workspace/db"),
      import("drizzle-orm"),
    ]);
    const rows = await db
      .select()
      .from(componentHealth)
      .where(like(componentHealth.component, `${COMPONENT_PREFIX}%`));
    for (const row of rows) {
      const metadata =
        row.metadata as Partial<ProviderAccountHealthMetadata> | null;
      if (metadata?.version !== 1 || !isStoredExclusion(metadata.exclusion))
        continue;
      const entry = fromPublicExclusion(metadata.exclusion);
      if (!entry) continue;
      if (entry.until !== null && entry.until <= now) {
        void removePersistedExclusion(exclusionKey(entry));
        continue;
      }
      setExclusion(entry);
    }
    persistenceReady = true;
    return true;
  } catch {
    persistenceReady = false;
    return false;
  }
}

/** Test-only reset for deterministic process-state isolation. */
export function __resetOpenRouterAccountExclusionsForTest(): void {
  exclusions.clear();
  balancePauses.clear();
  persistenceReady = false;
}

import { accountFingerprint, observedAccountFor } from "./request-ledger.js";

const COMPONENT_PREFIX = "llm-provider-account-exclusion:";
const CREDIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 30_000;

const DAILY_QUOTA_PATTERN =
  /\b(per[\s-]?day|daily|tokens per day|tpd|quota exhausted|daily limit|daily quota|free tier|free quota|free-models-per-day|openrouter_free_tier_daily|allocationquota)\b/i;
const CREDIT_EXHAUSTED_PATTERN =
  /\b(payment required|insufficient credits?|credits? exhausted|no credits?|negative balance|billing required)\b/i;

export type OpenRouterAccountExclusionScope = "all" | "paid";
export type OpenRouterAccountExclusionKind =
  | "credit_exhausted"
  | "credit_balance"
  | "daily_quota"
  | "rate_limit";

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

const exclusions = new Map<string, StoredExclusion>();
let persistenceReady = false;

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
    (entry.scope === "all" || entry.scope === "paid") &&
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
        component: `${COMPONENT_PREFIX}${entry.account}`,
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

async function removePersistedExclusion(account: string): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  try {
    const [{ db, componentHealth }, { eq }] = await Promise.all([
      import("@workspace/db"),
      import("drizzle-orm"),
    ]);
    await db
      .delete(componentHealth)
      .where(eq(componentHealth.component, `${COMPONENT_PREFIX}${account}`));
    persistenceReady = true;
  } catch {
    persistenceReady = false;
  }
}

function deleteExclusion(account: string): void {
  if (!exclusions.delete(account)) return;
  void removePersistedExclusion(account);
}

function setExclusion(entry: StoredExclusion): void {
  const existing = exclusions.get(entry.account);
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
  exclusions.set(entry.account, entry);
  void persistExclusion(entry);
}

function activeExclusionByAccount(
  account: string,
  now: number,
): StoredExclusion | null {
  const entry = exclusions.get(account);
  if (!entry) return null;
  if (entry.until !== null && now >= entry.until) {
    deleteExclusion(account);
    return null;
  }
  return entry;
}

function exclusionForKey(apiKey: string, now: number): StoredExclusion | null {
  const fingerprint = accountFingerprint(apiKey);
  const canonicalAccount = accountIdForKey(apiKey);
  const canonical = activeExclusionByAccount(canonicalAccount, now);
  if (canonical) return canonical;

  // A failure can occur before the account probe resolves creator_user_id.
  // Once identity becomes known, carry that key-fingerprint exclusion forward
  // so sibling keys from the same account do not become an accidental escape.
  const fallbackAccount = `keyfp_${fingerprint}`;
  if (fallbackAccount === canonicalAccount) return null;
  const fallback = activeExclusionByAccount(fallbackAccount, now);
  if (!fallback) return null;
  exclusions.delete(fallbackAccount);
  void removePersistedExclusion(fallbackAccount);
  const migrated = { ...fallback, account: canonicalAccount };
  setExclusion(migrated);
  return migrated;
}

export function classifyOpenRouterAccountFailure(
  status: number | undefined,
  message: string,
  now: number = Date.now(),
  retryAfterMs?: number,
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
    scope: "all",
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
): OpenRouterAccountExclusion | null {
  const classified = classifyOpenRouterAccountFailure(
    status,
    message,
    now,
    retryAfterMs,
  );
  if (!classified) return null;
  const entry = {
    account: accountIdForKey(apiKey),
    ...classified,
  };
  setExclusion(entry);
  return publicExclusion(entry);
}

export function getOpenRouterAccountExclusion(
  apiKey: string,
  options: { paid?: boolean; now?: number } = {},
): OpenRouterAccountExclusion | null {
  const entry = exclusionForKey(apiKey, options.now ?? Date.now());
  if (!entry) return null;
  if (entry.scope === "paid" && options.paid !== true) return null;
  return publicExclusion(entry);
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
  const active = [...exclusions.values()]
    .map((entry) => activeExclusionByAccount(entry.account, now))
    .filter((entry): entry is StoredExclusion => entry !== null);
  return {
    persistence: persistenceReady ? "postgres+memory" : "memory-only",
    exclusions: active.map((entry) => ({
      ...publicExclusion(entry),
      credentials: credentials
        .filter(({ key }) => accountIdForKey(key) === entry.account)
        .map(({ env }) => env)
        .sort(),
    })),
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
        void removePersistedExclusion(entry.account);
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
  persistenceReady = false;
}

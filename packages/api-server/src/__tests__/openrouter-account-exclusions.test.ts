import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetOpenRouterAccountExclusionsForTest,
  classifyOpenRouterAccountFailure,
  excludeOpenRouterAccountForFailure,
  getOpenRouterAccountExclusion,
  getOpenRouterAccountExclusionReport,
  reconcileOpenRouterCreditBalances,
} from "../../../core/src/provider-account-exclusions.js";
import {
  accountFingerprint,
  setObservedAccounts,
} from "../../../core/src/request-ledger.js";
import { createLLMClient } from "../../../core/src/llm-client.js";
import {
  __resetProviderCreditIdentityCacheForTest,
  preserveLastKnownOpenRouterAccounts,
  type ProviderAccountSnapshot,
} from "../../../core/src/provider-credits.js";

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({
      values: async () => undefined,
    }),
  },
  logs: {},
  taskOutcomes: {},
}));

const RUN_ID = `${process.pid}-${Date.now()}`;
const ACCOUNT_A_KEY_1 = `test-openrouter-account-a-key-1-${RUN_ID}`;
const ACCOUNT_A_KEY_2 = `test-openrouter-account-a-key-2-${RUN_ID}`;
const ACCOUNT_B_KEY = `test-openrouter-account-b-key-${RUN_ID}`;
const ACCOUNT_A = "oracct_aaaaaaaa";
const ACCOUNT_B = "oracct_bbbbbbbb";

function resolveTestAccounts(): void {
  setObservedAccounts(
    new Map([
      [accountFingerprint(ACCOUNT_A_KEY_1), ACCOUNT_A],
      [accountFingerprint(ACCOUNT_A_KEY_2), ACCOUNT_A],
      [accountFingerprint(ACCOUNT_B_KEY), ACCOUNT_B],
    ]),
  );
}

function configureIsolatedRouter(): void {
  const unset = [
    "QWEN_API_KEY",
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY_2",
    "OPENROUTER_API_KEY_3",
    "OPENROUTER_API_KEY_4",
    "OPENROUTER_FREE_API_KEY",
    "APEX_OPENROUTER_MODEL_POLICY",
  ];
  for (const name of unset) vi.stubEnv(name, "");
  vi.stubEnv("APEX_PAID_FALLBACK_ENABLED", "false");
  vi.stubEnv("APEX_REQUEST_CAP_TOTAL", "0");
  vi.stubEnv("APEX_EMERGENCY_REQUEST_CAP_TOTAL", "0");
  vi.stubEnv("APEX_REQUEST_PACING_ENABLED", "false");
  vi.stubEnv("APEX_TOKEN_CAP_TOTAL", "0");
  vi.stubEnv("APEX_TOKEN_PACING_ENABLED", "false");
}

function providerAccount(
  account: string,
  detail: string | null = null,
): ProviderAccountSnapshot {
  return {
    env: "OPENROUTER_FREE_API_KEY",
    account,
    remaining: null,
    totalCredits: null,
    totalUsage: null,
    isFreeTier: true,
    dailyLimit: 1_000,
    status: "unknown",
    detail,
  };
}

beforeEach(() => {
  configureIsolatedRouter();
  resolveTestAccounts();
  __resetOpenRouterAccountExclusionsForTest();
  __resetProviderCreditIdentityCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setObservedAccounts(null);
  __resetOpenRouterAccountExclusionsForTest();
  __resetProviderCreditIdentityCacheForTest();
});

describe("OpenRouter account exclusions", () => {
  it("excludes every key and paid/free route for an account after a 402 or credit-exhausted error", () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const exclusion = excludeOpenRouterAccountForFailure(
      ACCOUNT_A_KEY_1,
      402,
      "Payment required: insufficient credits",
      undefined,
      now,
    );

    expect(exclusion).toMatchObject({
      account: ACCOUNT_A,
      scope: "all",
      kind: "credit_exhausted",
      status: 402,
    });
    expect(exclusion?.resumeAt).toBe("2026-09-30T18:00:00.000Z");
    expect(
      getOpenRouterAccountExclusion(ACCOUNT_A_KEY_2, { now }),
    ).toMatchObject({
      account: ACCOUNT_A,
      scope: "all",
    });
    expect(
      getOpenRouterAccountExclusion(ACCOUNT_A_KEY_2, { paid: true, now }),
    ).toMatchObject({ account: ACCOUNT_A, scope: "all" });
    expect(getOpenRouterAccountExclusion(ACCOUNT_B_KEY, { now })).toBeNull();

    const messageOnly = classifyOpenRouterAccountFailure(
      undefined,
      "provider rejected request: credit exhausted",
      now,
    );
    expect(messageOnly?.kind).toBe("credit_exhausted");

    const report = getOpenRouterAccountExclusionReport(
      [
        { env: "OPENROUTER_FREE_API_KEY", key: ACCOUNT_A_KEY_1 },
        { env: "OPENROUTER_API_KEY_2", key: ACCOUNT_A_KEY_2 },
        { env: "OPENROUTER_API_KEY", key: ACCOUNT_B_KEY },
      ],
      now,
    );
    expect(report.exclusions).toEqual([
      expect.objectContaining({
        account: ACCOUNT_A,
        credentials: ["OPENROUTER_API_KEY_2", "OPENROUTER_FREE_API_KEY"],
      }),
    ]);
  });

  it("holds free-quota exhaustion until UTC midnight and then readmits the account", () => {
    const now = Date.parse("2026-09-30T23:58:00.000Z");
    const exclusion = excludeOpenRouterAccountForFailure(
      ACCOUNT_A_KEY_1,
      403,
      "free-models-per-day-high-balance allocationquota exhausted",
      undefined,
      now,
    );

    expect(exclusion).toMatchObject({
      account: ACCOUNT_A,
      kind: "daily_quota",
      resumeAt: "2026-10-01T00:00:00.000Z",
    });
    expect(
      getOpenRouterAccountExclusion(ACCOUNT_A_KEY_2, {
        now: Date.parse("2026-09-30T23:59:59.999Z"),
      }),
    ).not.toBeNull();
    expect(
      getOpenRouterAccountExclusion(ACCOUNT_A_KEY_2, {
        now: Date.parse("2026-10-01T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("a free-route quota excludes only free routing, so the account's paid route keeps serving", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    const exclusion = excludeOpenRouterAccountForFailure(
      ACCOUNT_A_KEY_1,
      429,
      "Rate limit exceeded: free-models-per-day-high-balance.",
      undefined,
      now,
      true,
    );
    expect(exclusion).toMatchObject({ account: ACCOUNT_A, scope: "free", kind: "daily_quota" });
    expect(getOpenRouterAccountExclusion(ACCOUNT_A_KEY_2, { paid: false, now })).toMatchObject({
      scope: "free",
      kind: "daily_quota",
    });
    expect(getOpenRouterAccountExclusion(ACCOUNT_A_KEY_2, { paid: true, now })).toBeNull();

    // A non-positive balance excludes paid routing on top; neither entry
    // overwrites the other.
    reconcileOpenRouterCreditBalances([{ account: ACCOUNT_A, remaining: -1 }], now);
    expect(getOpenRouterAccountExclusion(ACCOUNT_A_KEY_1, { paid: true, now })).toMatchObject({
      scope: "paid",
      kind: "credit_balance",
    });
    expect(getOpenRouterAccountExclusion(ACCOUNT_A_KEY_1, { paid: false, now })).toMatchObject({
      scope: "free",
      kind: "daily_quota",
    });

    // The free entry lifts at UTC midnight; the balance entry does not.
    const afterMidnight = Date.parse("2026-10-06T00:00:00.000Z");
    expect(getOpenRouterAccountExclusion(ACCOUNT_A_KEY_1, { paid: false, now: afterMidnight })).toBeNull();
    expect(getOpenRouterAccountExclusion(ACCOUNT_A_KEY_1, { paid: true, now: afterMidnight })).toMatchObject({
      kind: "credit_balance",
    });

    // Credit exhaustion is account-wide even when a free route reports it.
    expect(classifyOpenRouterAccountFailure(402, "insufficient credits", now, undefined, true)?.scope).toBe("all");
    // A paid-route 429 keeps the account-wide default.
    expect(classifyOpenRouterAccountFailure(429, "rate limit", now)?.scope).toBe("all");
  });

  it("uses balance probes to exclude paid routing and readmits it after funding", () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    reconcileOpenRouterCreditBalances(
      [{ account: ACCOUNT_A, remaining: -0.2 }],
      now,
    );

    expect(
      getOpenRouterAccountExclusion(ACCOUNT_A_KEY_1, { paid: true, now }),
    ).toMatchObject({
      account: ACCOUNT_A,
      scope: "paid",
      kind: "credit_balance",
    });
    expect(
      getOpenRouterAccountExclusion(ACCOUNT_A_KEY_1, { paid: false, now }),
    ).toBeNull();

    reconcileOpenRouterCreditBalances(
      [{ account: ACCOUNT_A, remaining: 5 }],
      now + 60_000,
    );
    expect(
      getOpenRouterAccountExclusion(ACCOUNT_A_KEY_2, {
        paid: true,
        now: now + 60_000,
      }),
    ).toBeNull();
  });

  it("preserves resolved account grouping through a transient identity-probe failure", () => {
    const credential = {
      fingerprint: accountFingerprint(ACCOUNT_A_KEY_1),
    };
    expect(
      preserveLastKnownOpenRouterAccounts(
        [credential],
        [providerAccount(ACCOUNT_A)],
      )[0]?.account,
    ).toBe(ACCOUNT_A);

    const refreshed = preserveLastKnownOpenRouterAccounts(
      [credential],
      [providerAccount(`keyfp_${credential.fingerprint}`, "key HTTP 503")],
    )[0];

    expect(refreshed?.account).toBe(ACCOUNT_A);
    expect(refreshed?.detail).toContain(
      "using last-known OpenRouter account identity",
    );
  });

  it("skips sibling keys after account A fails and succeeds through account B", async () => {
    vi.stubEnv("OPENROUTER_FREE_API_KEY", ACCOUNT_A_KEY_1);
    vi.stubEnv("OPENROUTER_API_KEY_2", ACCOUNT_A_KEY_2);
    vi.stubEnv("OPENROUTER_API_KEY", ACCOUNT_B_KEY);

    const attemptedKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const authorization =
          new Headers(init?.headers).get("authorization") ?? "";
        const key = authorization.replace(/^Bearer\s+/i, "");
        attemptedKeys.push(key);
        if (key === ACCOUNT_A_KEY_1) {
          return new Response(
            JSON.stringify({
              error: { message: "Payment required: insufficient credits" },
            }),
            { status: 402, headers: { "Content-Type": "application/json" } },
          );
        }
        if (key === ACCOUNT_A_KEY_2) {
          throw new Error(
            "sibling key from exhausted account must not be attempted",
          );
        }
        return new Response(
          JSON.stringify({
            model: "nvidia/nemotron-3-super-120b-a12b:free",
            choices: [{ message: { content: "account B served the request" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const client = createLLMClient({ role: "QA", maxTokens: 256 });
    const result = await client.complete([
      { role: "user", content: "prove account rotation" },
    ]);

    expect(result.content).toBe("account B served the request");
    expect(attemptedKeys).toEqual([ACCOUNT_A_KEY_1, ACCOUNT_B_KEY]);
    expect(getOpenRouterAccountExclusion(ACCOUNT_A_KEY_2)).toMatchObject({
      account: ACCOUNT_A,
      scope: "all",
      kind: "credit_exhausted",
    });
  });
});

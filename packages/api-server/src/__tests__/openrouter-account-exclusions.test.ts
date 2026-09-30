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

beforeEach(() => {
  configureIsolatedRouter();
  resolveTestAccounts();
  __resetOpenRouterAccountExclusionsForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setObservedAccounts(null);
  __resetOpenRouterAccountExclusionsForTest();
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
            model: "nex-agi/nex-n2.5-mini:free",
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

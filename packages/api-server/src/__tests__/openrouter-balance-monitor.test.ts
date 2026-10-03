import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBalanceMonitorForTest,
  __setBalanceMonitorSinksForTest,
  evaluateBalanceObservations,
  getOpenRouterBalanceMonitorStatus,
  initializeOpenRouterBalanceMonitor,
  readBalanceMonitorConfig,
  restoreOpenRouterKeyLimit,
  runOpenRouterBalanceMonitor,
  type AccountBalanceState,
  type BalanceMonitorConfig,
  type BalanceMonitorSinks,
} from "../../../core/src/openrouter-balance-monitor.js";
import {
  __resetOpenRouterAccountExclusionsForTest,
  excludeOpenRouterAccountForFailure,
  getOpenRouterAccountExclusion,
  getOpenRouterAccountExclusionReport,
} from "../../../core/src/provider-account-exclusions.js";
import { accountFingerprint, setObservedAccounts } from "../../../core/src/request-ledger.js";
import { balanceObservations } from "../../../core/src/provider-credits.js";

vi.mock("@workspace/db", () => ({
  db: { insert: () => ({ values: async () => undefined }) },
  logs: {},
  taskOutcomes: {},
}));

const RUN_ID = `${process.pid}-${Date.now()}`;
const KEY_A = `test-or-balance-key-a-${RUN_ID}`;
const KEY_B = `test-or-balance-key-b-${RUN_ID}`;
const MGMT_A = `test-or-balance-mgmt-a-${RUN_ID}`;
const ACCOUNT_A = "oracct_aaaa1111";
const ACCOUNT_B = "oracct_bbbb2222";
const T0 = Date.UTC(2026, 9, 3, 20, 0, 0);

function config(overrides: Partial<BalanceMonitorConfig> = {}): BalanceMonitorConfig {
  return { ...readBalanceMonitorConfig({}), ...overrides };
}

function obs(remaining: number | null, account = ACCOUNT_A, env = "OPENROUTER_API_KEY_4") {
  return [{ account, env, remaining }];
}

type Recorded = { escalations: unknown[]; audits: unknown[]; webhooks: unknown[]; persisted: unknown[] };

function stubSinks(fetchImpl?: typeof fetch, load: Record<string, unknown> | null = null): Recorded {
  const recorded: Recorded = { escalations: [], audits: [], webhooks: [], persisted: [] };
  const sinks: Partial<BalanceMonitorSinks> = {
    escalate: async (action) => void recorded.escalations.push(action),
    audit: async (entry) => void recorded.audits.push(entry),
    webhook: async (url, payload) => void recorded.webhooks.push({ url, payload }),
    persist: async (state) => void recorded.persisted.push(state),
    load: async () => load,
    fetch: fetchImpl ?? (async () => {
      throw new Error("network must not be used");
    }),
  };
  __setBalanceMonitorSinksForTest(sinks);
  return recorded;
}

beforeEach(() => {
  __resetBalanceMonitorForTest();
  __resetOpenRouterAccountExclusionsForTest();
  setObservedAccounts(
    new Map([
      [accountFingerprint(KEY_A), ACCOUNT_A],
      [accountFingerprint(KEY_B), ACCOUNT_B],
    ]),
  );
});

afterEach(() => {
  __resetBalanceMonitorForTest();
  __resetOpenRouterAccountExclusionsForTest();
  setObservedAccounts(null);
  vi.unstubAllEnvs();
});

describe("balance monitor config", () => {
  it("uses the approved defaults", () => {
    const c = readBalanceMonitorConfig({});
    expect(c).toMatchObject({
      warnUsd: 2,
      criticalUsd: 1,
      pauseUsd: 0.5,
      floorUsd: 0.01,
      resumeUsd: 3,
      resumeConsecutiveChecks: 2,
      fastIntervalMs: 60_000,
      idleIntervalMs: 300_000,
      autoKeyLimit: false,
      webhookUrl: null,
    });
  });

  it("never lets the pause threshold go below the $0.01 hard floor and only accepts https webhooks", () => {
    const c = readBalanceMonitorConfig({
      APEX_OR_BALANCE_PAUSE_USD: "0",
      APEX_OR_BALANCE_WARN_USD: "5",
      APEX_OR_AUTO_KEY_LIMIT: "true",
      APEX_OR_BALANCE_ALERT_WEBHOOK_URL: "http://insecure.example/hook",
    });
    expect(c.pauseUsd).toBe(0.01);
    expect(c.warnUsd).toBe(5);
    expect(c.autoKeyLimit).toBe(true);
    expect(c.webhookUrl).toBeNull();
    expect(
      readBalanceMonitorConfig({ APEX_OR_BALANCE_ALERT_WEBHOOK_URL: "https://hooks.example/x" }).webhookUrl,
    ).toBe("https://hooks.example/x");
  });
});

describe("evaluateBalanceObservations", () => {
  it("warns at $2.00, escalates to critical below $1.00, and does not repeat an alert every check", () => {
    const c = config();
    let state = new Map<string, AccountBalanceState>();
    let r = evaluateBalanceObservations(state, obs(2.0), c, T0);
    expect(r.actions.map((a) => a.type === "alert" && a.level)).toEqual(["warn"]);
    state = r.next;
    r = evaluateBalanceObservations(state, obs(1.9), c, T0 + 60_000);
    expect(r.actions).toEqual([]);
    state = r.next;
    r = evaluateBalanceObservations(state, obs(0.99), c, T0 + 120_000);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ type: "alert", severity: "critical", level: "critical" });
    state = r.next;
    // Re-alerts only after the realert window.
    r = evaluateBalanceObservations(state, obs(0.98), c, T0 + 180_000);
    expect(r.actions).toEqual([]);
    r = evaluateBalanceObservations(r.next, obs(0.97), c, T0 + 180_000 + c.realertMs);
    expect(r.actions).toHaveLength(1);
  });

  it("pauses paid at $0.50 without a key-limit step while APEX_OR_AUTO_KEY_LIMIT is off", () => {
    const r = evaluateBalanceObservations(new Map(), obs(0.5), config(), T0);
    expect(r.actions.map((a) => a.type)).toEqual(["pause", "alert"]);
    expect(r.next.get(ACCOUNT_A)).toMatchObject({ paidPaused: true, level: "paused" });
  });

  it("adds the key-limit step only when the flag is on, and pauses at the hard floor", () => {
    const r = evaluateBalanceObservations(new Map(), obs(0.01), config({ autoKeyLimit: true }), T0);
    expect(r.actions.map((a) => a.type)).toEqual(["pause", "key_limit", "alert"]);
    expect(r.next.get(ACCOUNT_A)?.pauseReason).toContain("hard floor");
  });

  it("resumes only after two consecutive checks at or above $3.00; a dip resets the streak", () => {
    const c = config();
    let r = evaluateBalanceObservations(new Map(), obs(0.4), c, T0);
    r = evaluateBalanceObservations(r.next, obs(3.0), c, T0 + 60_000);
    expect(r.actions).toEqual([]);
    expect(r.next.get(ACCOUNT_A)).toMatchObject({ paidPaused: true, resumeStreak: 1 });
    r = evaluateBalanceObservations(r.next, obs(2.99), c, T0 + 120_000);
    expect(r.next.get(ACCOUNT_A)).toMatchObject({ paidPaused: true, resumeStreak: 0 });
    r = evaluateBalanceObservations(r.next, obs(3.5), c, T0 + 180_000);
    expect(r.actions).toEqual([]);
    r = evaluateBalanceObservations(r.next, obs(3.6), c, T0 + 240_000);
    expect(r.actions.map((a) => a.type)).toEqual(["resume", "alert"]);
    expect(r.next.get(ACCOUNT_A)).toMatchObject({ paidPaused: false, level: "ok" });
  });

  it("alerts once after three unreadable checks and keeps an existing pause", () => {
    const c = config();
    let r = evaluateBalanceObservations(new Map(), obs(0.2), c, T0);
    for (let i = 1; i <= 2; i++) {
      r = evaluateBalanceObservations(r.next, obs(null), c, T0 + i * 60_000);
      expect(r.actions).toEqual([]);
    }
    r = evaluateBalanceObservations(r.next, obs(null), c, T0 + 180_000);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ type: "alert", level: "unknown" });
    expect(r.next.get(ACCOUNT_A)?.paidPaused).toBe(true);
    r = evaluateBalanceObservations(r.next, obs(null), c, T0 + 240_000);
    expect(r.actions).toEqual([]);
  });

  it("collapses several env names on one account into one observation", () => {
    const rows = balanceObservations([
      { env: "OPENROUTER_API_KEY", account: ACCOUNT_A, remaining: 4, totalCredits: 10, totalUsage: 6, isFreeTier: false, dailyLimit: -1, status: "ok", detail: null },
      { env: "OPENROUTER_API_KEY_4", account: ACCOUNT_A, remaining: 4, totalCredits: 10, totalUsage: 6, isFreeTier: false, dailyLimit: -1, status: "ok", detail: null },
      { env: "OPENROUTER_FREE_API_KEY", account: "keyfp_123", remaining: null, totalCredits: null, totalUsage: null, isFreeTier: null, dailyLimit: null, status: "unknown", detail: null },
    ]);
    expect(rows).toEqual([{ account: ACCOUNT_A, env: "OPENROUTER_API_KEY + OPENROUTER_API_KEY_4", remaining: 4 }]);
  });
});

describe("runOpenRouterBalanceMonitor (routing + sinks)", () => {
  it("blocks PAID routing for the paused account only; free routing and other accounts keep flowing", async () => {
    const recorded = stubSinks();
    await runOpenRouterBalanceMonitor(
      [
        { account: ACCOUNT_A, env: "OPENROUTER_API_KEY_4", remaining: 0.45 },
        { account: ACCOUNT_B, env: "OPENROUTER_API_KEY", remaining: 4.8 },
      ],
      new Map(),
      { config: config(), now: T0 },
    );
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: true })).toMatchObject({
      account: ACCOUNT_A,
      scope: "paid",
      kind: "balance_pause",
    });
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: false })).toBeNull();
    expect(getOpenRouterAccountExclusion(KEY_B, { paid: true })).toBeNull();
    expect(getOpenRouterAccountExclusionReport([{ env: "OPENROUTER_API_KEY_4", key: KEY_A }]).exclusions).toEqual([
      expect.objectContaining({ kind: "balance_pause", credentials: ["OPENROUTER_API_KEY_4"] }),
    ]);
    expect(recorded.escalations).toHaveLength(1);
    expect(recorded.escalations[0]).toMatchObject({ dedupeKey: `openrouter-balance:${ACCOUNT_A}:paused` });
    expect(recorded.webhooks).toEqual([]);
    expect(recorded.persisted).toHaveLength(1);
  });

  it("a daily-quota exclusion cannot erase a balance pause when it expires", async () => {
    stubSinks();
    await runOpenRouterBalanceMonitor(obs(0.3), new Map(), { config: config(), now: T0 });
    const now = Date.now();
    excludeOpenRouterAccountForFailure(KEY_A, 429, "Rate limit exceeded: free-models-per-day-high-balance.", undefined, now);
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: false, now })).toMatchObject({ kind: "daily_quota" });
    const afterMidnight = now + 25 * 60 * 60 * 1000;
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: false, now: afterMidnight })).toBeNull();
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: true, now: afterMidnight })).toMatchObject({ kind: "balance_pause" });
  });

  it("lifts the pause after the resume streak and posts the optional webhook only when configured", async () => {
    const recorded = stubSinks();
    const c = config({ webhookUrl: "https://hooks.example/bot-room" });
    await runOpenRouterBalanceMonitor(obs(0.3), new Map(), { config: c, now: T0 });
    await runOpenRouterBalanceMonitor(obs(5), new Map(), { config: c, now: T0 + 60_000 });
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: true })).not.toBeNull();
    await runOpenRouterBalanceMonitor(obs(5), new Map(), { config: c, now: T0 + 120_000 });
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: true })).toBeNull();
    expect(recorded.webhooks).toHaveLength(2);
    expect(recorded.webhooks[0]).toMatchObject({ url: "https://hooks.example/bot-room", payload: { level: "paused", account: ACCOUNT_A } });
    expect(JSON.stringify(recorded.webhooks)).not.toContain(KEY_A);
  });

  it("restores persisted pauses at boot", async () => {
    stubSinks(undefined, {
      version: 1,
      accounts: [
        {
          account: ACCOUNT_A,
          env: "OPENROUTER_API_KEY_4",
          remaining: 0.2,
          level: "paused",
          paidPaused: true,
          pausedAt: new Date(T0).toISOString(),
          pauseReason: "balance $0.20 at or below the $0.50 pause threshold",
          resumeStreak: 0,
          unknownStreak: 0,
          lastAlertLevel: "paused",
          lastAlertAt: T0,
          lastCheckedAt: new Date(T0).toISOString(),
          keyLimit: null,
        },
      ],
    });
    expect(await initializeOpenRouterBalanceMonitor()).toBe(true);
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: true })).toMatchObject({ kind: "balance_pause" });
    expect(getOpenRouterBalanceMonitorStatus().pausedAccounts).toEqual([ACCOUNT_A]);
  });
});

describe("optional OpenRouter key-limit step (APEX_OR_AUTO_KEY_LIMIT)", () => {
  const keyHash = createHash("sha256").update(KEY_A).digest("hex");

  function fakeOpenRouter(prior: { limit: number | null; limit_reset?: string | null }) {
    const calls: Array<{ method: string; url: string; body: unknown; auth: string }> = [];
    const impl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.Authorization });
      const payload = method === "GET"
        ? { data: [{ hash: "someotherkey", limit: null }, { hash: keyHash, limit: prior.limit, limit_reset: prior.limit_reset ?? null }] }
        : { data: { hash: keyHash } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("never calls OpenRouter when the flag is off", async () => {
    const fake = fakeOpenRouter({ limit: null });
    stubSinks(fake.impl);
    await runOpenRouterBalanceMonitor(obs(0.2), new Map([[ACCOUNT_A, { inferenceKey: KEY_A, managementKey: MGMT_A }]]), { config: config(), now: T0 });
    expect(fake.calls).toEqual([]);
    expect(getOpenRouterBalanceMonitorStatus().accounts[0].keyLimit).toBeNull();
  });

  it("saves the prior limit, sets $0 once, and only an operator restore puts it back", async () => {
    const fake = fakeOpenRouter({ limit: 12.5, limit_reset: "monthly" });
    stubSinks(fake.impl);
    const creds = new Map([[ACCOUNT_A, { inferenceKey: KEY_A, managementKey: MGMT_A }]]);
    const c = config({ autoKeyLimit: true });
    await runOpenRouterBalanceMonitor(obs(0.2), creds, { config: c, now: T0 });
    expect(fake.calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(fake.calls[1]).toMatchObject({ url: `https://openrouter.ai/api/v1/keys/${keyHash}`, body: { limit: 0 }, auth: `Bearer ${MGMT_A}` });

    let status = getOpenRouterBalanceMonitorStatus(c);
    expect(status.accounts[0].keyLimit).toMatchObject({ status: "applied", priorLimit: 12.5, keyHashSuffix: keyHash.slice(-6), restoreRequiresOperator: true });
    expect(JSON.stringify(status)).not.toContain(keyHash);
    expect(JSON.stringify(status)).not.toContain(KEY_A);

    // Recovery resumes APEX paid routing but does NOT touch the key limit.
    await runOpenRouterBalanceMonitor(obs(5), creds, { config: c, now: T0 + 60_000 });
    await runOpenRouterBalanceMonitor(obs(5), creds, { config: c, now: T0 + 120_000 });
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: true })).toBeNull();
    expect(fake.calls).toHaveLength(2);

    const restored = await restoreOpenRouterKeyLimit(ACCOUNT_A, creds.get(ACCOUNT_A), "matthew");
    expect(restored.ok).toBe(true);
    expect(fake.calls[2]).toMatchObject({ method: "PATCH", body: { limit: 12.5, limit_reset: "monthly" } });
    status = getOpenRouterBalanceMonitorStatus(c);
    expect(status.accounts[0].keyLimit).toMatchObject({ status: "restored", restoreRequiresOperator: false });
    expect(await restoreOpenRouterKeyLimit(ACCOUNT_A, creds.get(ACCOUNT_A))).toMatchObject({ ok: false });
  });

  it("restores an unlimited key to limit:null and never overwrites a saved prior limit with $0", async () => {
    const fake = fakeOpenRouter({ limit: null });
    stubSinks(fake.impl);
    const creds = new Map([[ACCOUNT_A, { inferenceKey: KEY_A, managementKey: MGMT_A }]]);
    const c = config({ autoKeyLimit: true, resumeConsecutiveChecks: 1 });
    await runOpenRouterBalanceMonitor(obs(0.2), creds, { config: c, now: T0 });
    await runOpenRouterBalanceMonitor(obs(5), creds, { config: c, now: T0 + 60_000 });
    await runOpenRouterBalanceMonitor(obs(0.2), creds, { config: c, now: T0 + 120_000 });
    // Second pause: prior limit (null) already saved and still applied -> no new GET/PATCH.
    expect(fake.calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    await restoreOpenRouterKeyLimit(ACCOUNT_A, creds.get(ACCOUNT_A));
    expect(fake.calls[2]).toMatchObject({ method: "PATCH", body: { limit: null } });
  });

  it("records a failure (and still pauses in APEX) when no management key is mapped", async () => {
    const recorded = stubSinks();
    await runOpenRouterBalanceMonitor(obs(0.2), new Map([[ACCOUNT_A, { inferenceKey: KEY_A, managementKey: null }]]), { config: config({ autoKeyLimit: true }), now: T0 });
    expect(getOpenRouterAccountExclusion(KEY_A, { paid: true })).toMatchObject({ kind: "balance_pause" });
    expect(getOpenRouterBalanceMonitorStatus().accounts[0].keyLimit).toMatchObject({ status: "failed" });
    expect(JSON.stringify(recorded.audits)).toContain("no management key");
  });
});

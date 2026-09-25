/**
 * Guard: APEX → BuildMyBot lead handoff uses the authenticated ingest API.
 *
 * A local HTTP server stands in for BuildMyBot. No database and no live token.
 *
 * Usage: pnpm --filter @workspace/core exec tsx scripts/verify-buildmybot-lead-ingest.ts
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

const TOKEN = "super-secret-ingest-token";

process.env.BUILDMYBOT_APP_URL = "https://www.buildmybot.app";
process.env.APEX_OPERATOR_AUTO_APPROVE_ALL = "false";
process.env.BUILDMYBOT_LEAD_INGEST_TOKEN = TOKEN;

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: string;
}

type Mode =
  | { kind: "echo" }
  | { kind: "status"; status: number; body: unknown }
  | { kind: "flaky"; remaining: number }
  | { kind: "hang"; ms: number }
  | { kind: "sequence"; statuses: number[] };

let mode: Mode = { kind: "echo" };
const requests: RecordedRequest[] = [];
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((part) => String(part)).join(" "));
};

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(
    ok
      ? `  ✅ ${label}`
      : `  ❌ ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function ignoreSocketError(stream: {
  on: (event: "error", listener: () => void) => void;
}): void {
  stream.on("error", () => undefined);
}

function echoBody(recorded: RecordedRequest): unknown {
  if (recorded.method === "GET")
    return { leads: [{ externalId: "apex:existing", company: "Existing Co" }] };
  const parsed = recorded.body
    ? (JSON.parse(recorded.body) as { dryRun?: boolean; leads?: unknown[] })
    : {};
  const count = Array.isArray(parsed.leads) ? parsed.leads.length : 0;
  return {
    dryRun: parsed.dryRun === true,
    accepted: count,
    updated: 0,
    duplicates: 0,
    rejected: [],
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  ignoreSocketError(req);
  ignoreSocketError(res);
  const body = await readBody(req);
  const recorded: RecordedRequest = {
    method: req.method ?? "GET",
    url: req.url ?? "",
    authorization: String(req.headers.authorization ?? ""),
    body,
  };
  requests.push(recorded);

  let status = 200;
  let payload: unknown = echoBody(recorded);
  let delay = 0;
  if (mode.kind === "status") {
    status = mode.status;
    payload = mode.body;
  } else if (mode.kind === "flaky") {
    if (mode.remaining > 0) {
      mode.remaining -= 1;
      status = 500;
      payload = { error: "temporary" };
    }
  } else if (mode.kind === "hang") {
    delay = mode.ms;
  } else if (mode.kind === "sequence") {
    const next = mode.statuses.shift();
    if (next && next !== 200) {
      status = next;
      payload = { error: `status ${next}`, token: TOKEN };
    }
  }

  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function postedBodies(): Array<{
  dryRun?: boolean;
  leads?: Array<{ externalId?: string }>;
}> {
  return requests
    .filter((req) => req.method === "POST")
    .map(
      (req) =>
        JSON.parse(req.body) as {
          dryRun?: boolean;
          leads?: Array<{ externalId?: string }>;
        },
    );
}

const lead = {
  id: "lead-1",
  companyName: "Acme Plumbing",
  website: "https://acme.example",
  industry: "Home Services",
  city: "Austin",
  decisionMakerName: "Ada",
  contactEmail: "ada@acme.example",
  contactPhone: "+15555550100",
  fitReason: "Matches ICP",
  outreachAngle: "Missed calls",
  researchedByAgentId: "apex-lead-research-001",
  campaignId: "camp-1",
};

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  process.env.BUILDMYBOT_API_BASE_URL = `http://127.0.0.1:${address.port}`;

  const client = await import("../packages/core/src/buildmybot-lead-client.js");
  const connector =
    await import("../packages/core/src/buildmybot-connector.js");
  const { getToolRegistry } =
    await import("../packages/core/src/tool-registry.js");
  const { HARD_GATED_TOOLS } =
    await import("../packages/core/src/approval-policy.js");

  const fast = { retryDelayMs: 0, sleepImpl: async () => undefined };
  const marked: string[] = [];
  let loads = 0;
  connector.setBuildMyBotPushDepsForTests({
    loadCandidates: async () => {
      loads += 1;
      return { candidatesScanned: 1, leads: [lead] };
    },
    markPushed: async (ids) => {
      marked.push(...ids);
    },
  });

  try {
    console.log("── registration ──");
    const names = connector.createBuildMyBotTools().map((tool) => tool.name);
    check("push leads is registered", names.includes("buildmybot_push_leads"));
    check(
      "recent leads is registered",
      names.includes("buildmybot_recent_leads"),
    );
    check("status tool stays retired", !names.includes("buildmybot_status"));
    check(
      "briefing tool stays retired",
      !names.includes("buildmybot_send_briefing"),
    );
    check(
      "open errors tool stays retired",
      !names.includes("buildmybot_open_errors"),
    );
    check(
      "resolve error tool stays retired",
      !names.includes("buildmybot_resolve_error"),
    );
    const pushTool = connector
      .createBuildMyBotTools()
      .find((tool) => tool.name === "buildmybot_push_leads");
    check(
      "live push tool requires approval",
      pushTool?.requiresApproval === true,
    );
    check(
      "push leads stays hard-gated",
      HARD_GATED_TOOLS.has("buildmybot_push_leads"),
    );
    check(
      "external id is stable",
      client.apexLeadExternalId("lead-1") === "apex:lead-1" &&
        client.apexLeadExternalId("lead-1") ===
          client.apexLeadExternalId("lead-1"),
    );
    check(
      "blank base URL falls back to production",
      (() => {
        const previous = process.env.BUILDMYBOT_API_BASE_URL;
        process.env.BUILDMYBOT_API_BASE_URL = "  ";
        const blank = client.buildMyBotApiBaseUrl();
        process.env.BUILDMYBOT_API_BASE_URL = "https://www.buildmybot.app/";
        const trimmed = client.buildMyBotApiBaseUrl();
        process.env.BUILDMYBOT_API_BASE_URL = previous;
        return (
          blank === "https://www.buildmybot.app" &&
          trimmed === "https://www.buildmybot.app"
        );
      })(),
    );

    console.log("\n── not configured ──");
    process.env.BUILDMYBOT_LEAD_INGEST_TOKEN = "   ";
    check(
      "blank token is not configured",
      client.isBuildMyBotLeadIngestConfigured() === false,
    );
    delete process.env.BUILDMYBOT_LEAD_INGEST_TOKEN;
    requests.length = 0;
    loads = 0;
    const missing = await client.pushBuildMyBotLeads(
      { dryRun: true, leads: [{ externalId: "apex:lead-1" }] },
      fast,
    );
    check(
      "client reports not configured",
      missing.ok === false &&
        missing.configured === false &&
        missing.code === "not_configured" &&
        missing.message.includes("not configured"),
      missing,
    );
    check("not configured does not call BuildMyBot", requests.length === 0);
    const registry = getToolRegistry(process.cwd());
    const toolResult = await registry.execute(
      "buildmybot_push_leads",
      { source: "backlog", dryRun: true },
      {
        agentId: "guard-script-test-agent",
        workspaceRoot: process.cwd(),
        requestApproval: async () => true,
      },
    );
    const toolData = toolResult.data as
      | { code?: string; message?: string; configured?: boolean }
      | undefined;
    check(
      "tool returns not configured without throwing",
      toolResult.success === true &&
        toolData?.configured === false &&
        toolData.message?.includes("not configured") === true,
      toolResult,
    );
    check(
      "not configured tool does not load APEX leads",
      loads === 0 && requests.length === 0,
      { loads, requests: requests.length },
    );
    const recentMissing = await client.listBuildMyBotLeads(
      { orgId: "org-1" },
      fast,
    );
    check(
      "recent leads reports not configured",
      recentMissing.ok === false &&
        recentMissing.message.includes("not configured"),
    );
    process.env.BUILDMYBOT_LEAD_INGEST_TOKEN = TOKEN;

    console.log("\n── dry run ──");
    requests.length = 0;
    marked.length = 0;
    mode = { kind: "echo" };
    const dry = await registry.execute(
      "buildmybot_push_leads",
      { source: "campaign", campaignId: "camp-1" },
      {
        agentId: "guard-script-test-agent",
        workspaceRoot: process.cwd(),
        requestApproval: async () => true,
      },
    );
    const dryData = dry.data as
      | { dryRun?: boolean; markedPushed?: number }
      | undefined;
    const dryBody = postedBodies()[0];
    check(
      "omitted dryRun posts dryRun true",
      dry.success === true &&
        dryData?.dryRun === true &&
        dryBody?.dryRun === true,
      { dryData, dryBody },
    );
    check(
      "dry run does not mark APEX leads pushed",
      dryData?.markedPushed === 0 && marked.length === 0,
      { marked, dryData },
    );
    check(
      "dry run sends bearer token",
      requests[0]?.authorization === `Bearer ${TOKEN}`,
    );
    check(
      "dry run uses stable external id",
      dryBody?.leads?.[0]?.externalId === "apex:lead-1",
    );

    console.log("\n── approval required for live push ──");
    requests.length = 0;
    marked.length = 0;
    let approvalRequested: string | null = null;
    const rejected = await registry.execute(
      "buildmybot_push_leads",
      { source: "campaign", campaignId: "camp-1", dryRun: false },
      {
        agentId: "guard-script-test-agent",
        workspaceRoot: process.cwd(),
        requestApproval: async (toolName) => {
          approvalRequested = toolName;
          return false;
        },
      },
    );
    check(
      "live push requests approval",
      approvalRequested === "buildmybot_push_leads",
      { approvalRequested },
    );
    check(
      "rejected live push does not call BuildMyBot",
      rejected.success === false &&
        rejected.error === "Action rejected by user" &&
        requests.length === 0,
      rejected,
    );
    check("rejected live push does not mark leads", marked.length === 0);

    const approved = await registry.execute(
      "buildmybot_push_leads",
      {
        source: "campaign",
        campaignId: "camp-1",
        dryRun: false,
        orgId: "org-1",
      },
      {
        agentId: "guard-script-test-agent",
        workspaceRoot: process.cwd(),
        requestApproval: async () => true,
      },
    );
    const approvedData = approved.data as
      | { dryRun?: boolean; markedPushed?: number; accepted?: number }
      | undefined;
    const liveBody = postedBodies().at(-1);
    check(
      "approved live push sends dryRun false",
      approved.success === true &&
        approvedData?.dryRun === false &&
        liveBody?.dryRun === false,
      { approvedData, liveBody },
    );
    check(
      "approved live push marks the APEX lead",
      approvedData?.markedPushed === 1 && marked.includes("lead-1"),
      { marked, approvedData },
    );
    check(
      "retry uses the same external id",
      liveBody?.leads?.[0]?.externalId === "apex:lead-1" &&
        dryBody?.leads?.[0]?.externalId === liveBody?.leads?.[0]?.externalId,
    );

    console.log("\n── chunking ──");
    requests.length = 0;
    mode = { kind: "echo" };
    const many = Array.from({ length: 201 }, (_, index) => ({
      externalId: `apex:bulk-${index}`,
      company: `Co ${index}`,
    }));
    const chunked = await client.pushBuildMyBotLeads(
      { dryRun: true, leads: many, ownerEmail: "owner@example.com" },
      fast,
    );
    const bodies = postedBodies();
    check(
      "201 leads become two calls",
      requests.length === 2 &&
        bodies[0]?.leads?.length === 200 &&
        bodies[1]?.leads?.length === 1,
      {
        requests: requests.length,
        sizes: bodies.map((body) => body.leads?.length),
      },
    );
    check(
      "chunk totals add up",
      chunked.ok === true &&
        chunked.chunks === 2 &&
        chunked.accepted === 201 &&
        chunked.dryRun === true,
      chunked,
    );
    check(
      "chunk calls stay on the ingest path",
      requests.every((req) =>
        req.url.startsWith("/api/integrations/apex/leads"),
      ),
    );
    check(
      "each chunk includes ownerEmail",
      bodies.every((body) =>
        JSON.stringify(body).includes("owner@example.com"),
      ),
    );

    requests.length = 0;
    mode = { kind: "sequence", statuses: [200, 401] };
    const partial = await client.pushBuildMyBotLeads(
      { dryRun: false, leads: many },
      fast,
    );
    check(
      "401 on the second chunk stops the batch",
      partial.ok === false &&
        partial.code === "unauthorized" &&
        requests.length === 2,
      partial,
    );
    check(
      "only the successful chunk is applicable",
      partial.appliedExternalIds.length === 200 &&
        partial.appliedExternalIds[0] === "apex:bulk-0",
      {
        applied: partial.appliedExternalIds.length,
      },
    );

    console.log("\n── 401 / 503 ──");
    requests.length = 0;
    warnings.length = 0;
    mode = { kind: "status", status: 401, body: { error: `bad ${TOKEN}` } };
    const unauthorized = await client.pushBuildMyBotLeads(
      { dryRun: false, leads: [{ externalId: "apex:lead-1" }] },
      fast,
    );
    check(
      "401 is unauthorized and not retried",
      unauthorized.ok === false &&
        unauthorized.code === "unauthorized" &&
        unauthorized.status === 401 &&
        requests.length === 1,
      unauthorized,
    );
    check(
      "401 result does not echo the token",
      !JSON.stringify(unauthorized).includes(TOKEN),
    );
    requests.length = 0;
    const recentUnauthorized = await client.listBuildMyBotLeads(
      { orgId: "org-1", since: "2026-09-01T00:00:00.000Z", limit: 5 },
      fast,
    );
    check(
      "recent leads 401 is unauthorized",
      recentUnauthorized.ok === false &&
        recentUnauthorized.code === "unauthorized" &&
        requests.length === 1 &&
        requests[0]?.url.includes("orgId=org-1"),
      recentUnauthorized,
    );

    requests.length = 0;
    mode = { kind: "status", status: 503, body: { error: "disabled" } };
    const disabled = await client.pushBuildMyBotLeads(
      { dryRun: false, leads: [{ externalId: "apex:lead-1" }] },
      fast,
    );
    check(
      "503 is ingest disabled and not retried",
      disabled.ok === false &&
        disabled.code === "ingest_disabled" &&
        disabled.status === 503 &&
        requests.length === 1,
      disabled,
    );
    check(
      "503 message says ingest is disabled",
      disabled.message.includes("503") &&
        disabled.message.toLowerCase().includes("disabled"),
    );

    console.log("\n── retries and timeout ──");
    requests.length = 0;
    mode = { kind: "flaky", remaining: 1 };
    const recovered = await client.pushBuildMyBotLeads(
      { dryRun: true, leads: [{ externalId: "apex:lead-1" }] },
      { ...fast, maxAttempts: 3 },
    );
    check(
      "500 is retried and then accepted",
      recovered.ok === true &&
        recovered.accepted === 1 &&
        requests.length === 2,
      { recovered, requests: requests.length },
    );

    requests.length = 0;
    mode = { kind: "hang", ms: 1_000 };
    const timedOut = await client.pushBuildMyBotLeads(
      { dryRun: true, leads: [{ externalId: "apex:lead-1" }] },
      { ...fast, timeoutMs: 40, maxAttempts: 2 },
    );
    check(
      "timeouts fail after the attempt cap",
      timedOut.ok === false &&
        timedOut.code === "network" &&
        requests.length === 2,
      { timedOut, requests: requests.length },
    );
    check(
      "timeout result does not include the token",
      !JSON.stringify(timedOut).includes(TOKEN),
    );

    console.log("\n── recent leads ──");
    requests.length = 0;
    mode = { kind: "echo" };
    const recent = await registry.execute(
      "buildmybot_recent_leads",
      { orgId: "org-9", limit: 5 },
      {
        agentId: "guard-script-test-agent",
        workspaceRoot: process.cwd(),
        requestApproval: async () => {
          throw new Error("recent leads must not request approval");
        },
      },
    );
    const recentData = recent.data as
      | { ok?: boolean; leads?: Array<{ externalId?: string }> }
      | undefined;
    check(
      "recent leads GET returns the payload",
      recent.success === true &&
        recentData?.ok === true &&
        recentData.leads?.[0]?.externalId === "apex:existing",
      recent,
    );
    check(
      "recent leads query is scoped",
      requests[0]?.method === "GET" &&
        requests[0]?.url.includes("orgId=org-9") &&
        requests[0]?.url.includes("limit=5"),
    );
    check(
      "recent leads sends the bearer token",
      requests[0]?.authorization === `Bearer ${TOKEN}`,
    );

    check(
      "logs never contain the ingest token",
      warnings.every((line) => !line.includes(TOKEN)),
      warnings,
    );
    check(
      "logs never contain an Authorization header",
      warnings.every((line) => !/authorization/i.test(line)),
    );
  } finally {
    connector.setBuildMyBotPushDepsForTests(null);
    console.warn = originalWarn;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  console.log(
    `\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.warn = originalWarn;
  console.error(err);
  process.exit(1);
});

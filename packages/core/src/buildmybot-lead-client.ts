// Authenticated HTTP client for the BuildMyBot lead-ingest API.
//
// BuildMyBot stores its own product data in Supabase. APEX does not open that
// database. Lead handoff is POST/GET {base}/api/integrations/apex/leads.
//
// Env:
//   BUILDMYBOT_API_BASE_URL       default https://www.buildmybot.app (blank counts as unset)
//   BUILDMYBOT_LEAD_INGEST_TOKEN  Bearer token; blank/unset → not-configured result, no throw
//
// The token is never written to logs. 5xx responses are retried a bounded
// number of times, except 503, which means ingest is disabled on the
// BuildMyBot side and will not succeed on retry. 401 is a bad token.

export const LEAD_INGEST_PATH = "/api/integrations/apex/leads";
export const LEAD_INGEST_CHUNK_SIZE = 200;
export const LEAD_INGEST_DEFAULT_TIMEOUT_MS = 15_000;
export const LEAD_INGEST_DEFAULT_MAX_ATTEMPTS = 3;
export const LEAD_INGEST_DEFAULT_RETRY_DELAY_MS = 250;

export const LEAD_INGEST_NOT_CONFIGURED_MESSAGE =
  "BuildMyBot lead ingest is not configured. Set BUILDMYBOT_LEAD_INGEST_TOKEN before pushing or reading leads.";

export interface ApexIngestLead {
  externalId: string;
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  website?: string;
  source?: string;
  notes?: string;
  tags?: string[];
}

export interface LeadIngestRejection {
  externalId?: string;
  reason: string;
}

export interface LeadIngestTotals {
  dryRun: boolean;
  accepted: number;
  updated: number;
  duplicates: number;
  rejected: LeadIngestRejection[];
  chunks: number;
  /** External ids from successful live (non-dry-run) chunks, excluding rejected rows. */
  appliedExternalIds: string[];
}

export interface LeadIngestSuccess extends LeadIngestTotals {
  ok: true;
  configured: true;
}

export interface LeadIngestFailure extends LeadIngestTotals {
  ok: false;
  configured: boolean;
  code:
    | "not_configured"
    | "unauthorized"
    | "ingest_disabled"
    | "http_error"
    | "network"
    | "invalid_response";
  status?: number;
  message: string;
}

export type LeadIngestResult = LeadIngestSuccess | LeadIngestFailure;

export interface BuildMyBotRecentLeadsQuery {
  orgId?: string;
  ownerEmail?: string;
  since?: string;
  limit?: number;
}

export type BuildMyBotRecentLeadsResult =
  | { ok: true; configured: true; leads: unknown[] }
  | {
      ok: false;
      configured: boolean;
      code: LeadIngestFailure["code"];
      status?: number;
      message: string;
      leads: unknown[];
    };

export interface LeadClientOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface ResolvedLeadClientOptions {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
}

const emptyTotals = (dryRun: boolean): LeadIngestTotals => ({
  dryRun,
  accepted: 0,
  updated: 0,
  duplicates: 0,
  rejected: [],
  chunks: 0,
  appliedExternalIds: [],
});

/** Stable across retries. BuildMyBot de-dupes on this id. */
export function apexLeadExternalId(leadId: string): string {
  return `apex:${leadId}`;
}

export function apexLeadIdFromExternalId(externalId: string): string | null {
  const prefix = "apex:";
  if (!externalId.startsWith(prefix)) return null;
  const id = externalId.slice(prefix.length);
  return id.length > 0 ? id : null;
}

export function buildMyBotApiBaseUrl(): string {
  const configured = process.env.BUILDMYBOT_API_BASE_URL?.trim();
  const base =
    configured && configured.length > 0
      ? configured
      : "https://www.buildmybot.app";
  return base.replace(/\/+$/, "");
}

export function buildMyBotLeadIngestToken(): string {
  return process.env.BUILDMYBOT_LEAD_INGEST_TOKEN?.trim() ?? "";
}

export function isBuildMyBotLeadIngestConfigured(): boolean {
  return buildMyBotLeadIngestToken().length > 0;
}

export function leadIngestNotConfigured(dryRun = true): LeadIngestFailure {
  return {
    ok: false,
    configured: false,
    code: "not_configured",
    message: LEAD_INGEST_NOT_CONFIGURED_MESSAGE,
    ...emptyTotals(dryRun),
  };
}

export function chunkLeads<T>(
  leads: readonly T[],
  size = LEAD_INGEST_CHUNK_SIZE,
): T[][] {
  if (size < 1) throw new Error("lead ingest chunk size must be at least 1");
  const chunks: T[][] = [];
  for (let i = 0; i < leads.length; i += size)
    chunks.push(leads.slice(i, i + size));
  return chunks;
}

function resolveOptions(
  options?: LeadClientOptions,
): ResolvedLeadClientOptions {
  return {
    timeoutMs: options?.timeoutMs ?? LEAD_INGEST_DEFAULT_TIMEOUT_MS,
    maxAttempts: Math.max(
      1,
      options?.maxAttempts ?? LEAD_INGEST_DEFAULT_MAX_ATTEMPTS,
    ),
    retryDelayMs: options?.retryDelayMs ?? LEAD_INGEST_DEFAULT_RETRY_DELAY_MS,
    fetchImpl: options?.fetchImpl ?? fetch,
    sleepImpl:
      options?.sleepImpl ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** Strip bearer tokens from any text that might be returned to a tool result. */
export function redactLeadIngestSecrets(text: string): string {
  const token = buildMyBotLeadIngestToken();
  let out = text;
  if (token) out = out.split(token).join("[redacted]");
  return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

function logLeadIngestFailure(
  method: string,
  status: number | "network",
  attempt: number,
): void {
  // Path only — never the bearer token, Authorization header, or query string.
  console.warn(
    `[buildmybot-lead-ingest] ${method} ${LEAD_INGEST_PATH} failed status=${status} attempt=${attempt}`,
  );
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status !== 503;
}

async function requestWithRetries(
  url: string,
  init: RequestInit,
  method: string,
  options: ResolvedLeadClientOptions,
): Promise<{ response?: Response; networkMessage?: string }> {
  let lastNetwork = "request failed";
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const response = await options.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (
        !isRetryableStatus(response.status) ||
        attempt === options.maxAttempts
      ) {
        if (!response.ok)
          logLeadIngestFailure(method, response.status, attempt);
        return { response };
      }
      logLeadIngestFailure(method, response.status, attempt);
      await response.arrayBuffer().catch(() => undefined);
    } catch (err) {
      lastNetwork = err instanceof Error ? err.message : String(err);
      logLeadIngestFailure(method, "network", attempt);
      if (attempt === options.maxAttempts) {
        return { networkMessage: redactLeadIngestSecrets(lastNetwork) };
      }
    }
    if (options.retryDelayMs > 0)
      await options.sleepImpl(options.retryDelayMs * attempt);
  }
  return { networkMessage: redactLeadIngestSecrets(lastNetwork) };
}

function authHeader(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseIngestBody(
  payload: unknown,
  fallbackDryRun: boolean,
): LeadIngestTotals | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const body = payload as Record<string, unknown>;
  const rejectedRaw = Array.isArray(body.rejected) ? body.rejected : [];
  const rejected: LeadIngestRejection[] = rejectedRaw.map((item) => {
    const row =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      ...(typeof row.externalId === "string"
        ? { externalId: row.externalId }
        : {}),
      reason:
        typeof row.reason === "string" && row.reason.trim()
          ? row.reason
          : "rejected",
    };
  });
  return {
    dryRun: typeof body.dryRun === "boolean" ? body.dryRun : fallbackDryRun,
    accepted: numberField(body.accepted),
    updated: numberField(body.updated),
    duplicates: numberField(body.duplicates),
    rejected,
    chunks: 1,
    appliedExternalIds: [],
  };
}

function failureFromStatus(
  status: number,
  dryRun: boolean,
  partial: LeadIngestTotals,
): LeadIngestFailure {
  if (status === 401) {
    return {
      ok: false,
      configured: true,
      code: "unauthorized",
      status,
      message:
        "BuildMyBot lead ingest rejected the bearer token (401). BUILDMYBOT_LEAD_INGEST_TOKEN does not match the BuildMyBot ingest token.",
      ...partial,
      dryRun,
    };
  }
  if (status === 503) {
    return {
      ok: false,
      configured: true,
      code: "ingest_disabled",
      status,
      message:
        "BuildMyBot lead ingest is disabled (503). BuildMyBot is not accepting APEX leads.",
      ...partial,
      dryRun,
    };
  }
  return {
    ok: false,
    configured: true,
    code: "http_error",
    status,
    message: `BuildMyBot lead ingest request failed (HTTP ${status}).`,
    ...partial,
    dryRun,
  };
}

function omitEmpty<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = entry;
  }
  return out as T;
}

export async function pushBuildMyBotLeads(
  input: {
    orgId?: string;
    ownerEmail?: string;
    dryRun?: boolean;
    leads: readonly ApexIngestLead[];
  },
  options?: LeadClientOptions,
): Promise<LeadIngestResult> {
  const dryRun = input.dryRun !== false;
  if (!isBuildMyBotLeadIngestConfigured())
    return leadIngestNotConfigured(dryRun);
  const token = buildMyBotLeadIngestToken();
  const resolved = resolveOptions(options);
  const chunks = chunkLeads(input.leads, LEAD_INGEST_CHUNK_SIZE);
  if (chunks.length === 0) {
    return { ok: true, configured: true, ...emptyTotals(dryRun) };
  }

  const totals = emptyTotals(dryRun);
  const url = `${buildMyBotApiBaseUrl()}${LEAD_INGEST_PATH}`;

  for (const chunk of chunks) {
    const body = omitEmpty({
      orgId: input.orgId,
      ownerEmail: input.ownerEmail,
      dryRun,
      leads: chunk,
    });
    const attempt = await requestWithRetries(
      url,
      {
        method: "POST",
        headers: { ...authHeader(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "POST",
      resolved,
    );
    if (!attempt.response) {
      return {
        ok: false,
        configured: true,
        code: "network",
        message: `BuildMyBot lead ingest request failed: ${attempt.networkMessage ?? "network error"}`,
        ...totals,
      };
    }
    if (!attempt.response.ok) {
      return failureFromStatus(attempt.response.status, dryRun, totals);
    }
    let parsedJson: unknown;
    try {
      parsedJson = await attempt.response.json();
    } catch {
      return {
        ok: false,
        configured: true,
        code: "invalid_response",
        status: attempt.response.status,
        message: "BuildMyBot lead ingest returned a non-JSON success response.",
        ...totals,
      };
    }
    const parsed = parseIngestBody(parsedJson, dryRun);
    if (!parsed) {
      return {
        ok: false,
        configured: true,
        code: "invalid_response",
        status: attempt.response.status,
        message:
          "BuildMyBot lead ingest returned an unexpected response shape.",
        ...totals,
      };
    }
    totals.accepted += parsed.accepted;
    totals.updated += parsed.updated;
    totals.duplicates += parsed.duplicates;
    totals.rejected.push(...parsed.rejected);
    totals.chunks += 1;
    // A chunk that the server treated as a dry run did not write, even if we asked to.
    totals.dryRun = totals.dryRun || parsed.dryRun;
    if (dryRun === false && parsed.dryRun === false) {
      const rejectedIds = new Set(
        parsed.rejected
          .map((row) => row.externalId)
          .filter((id): id is string => Boolean(id)),
      );
      for (const lead of chunk) {
        if (!rejectedIds.has(lead.externalId))
          totals.appliedExternalIds.push(lead.externalId);
      }
    }
  }

  return { ok: true, configured: true, ...totals };
}

export async function listBuildMyBotLeads(
  query: BuildMyBotRecentLeadsQuery = {},
  options?: LeadClientOptions,
): Promise<BuildMyBotRecentLeadsResult> {
  if (!isBuildMyBotLeadIngestConfigured()) {
    return {
      ok: false,
      configured: false,
      code: "not_configured",
      message: LEAD_INGEST_NOT_CONFIGURED_MESSAGE,
      leads: [],
    };
  }
  const token = buildMyBotLeadIngestToken();
  const resolved = resolveOptions(options);
  const params = new URLSearchParams();
  if (query.orgId) params.set("orgId", query.orgId);
  if (query.ownerEmail) params.set("ownerEmail", query.ownerEmail);
  if (query.since) params.set("since", query.since);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  const url = `${buildMyBotApiBaseUrl()}${LEAD_INGEST_PATH}${qs ? `?${qs}` : ""}`;
  const attempt = await requestWithRetries(
    url,
    { method: "GET", headers: authHeader(token) },
    "GET",
    resolved,
  );
  if (!attempt.response) {
    return {
      ok: false,
      configured: true,
      code: "network",
      message: `BuildMyBot lead ingest request failed: ${attempt.networkMessage ?? "network error"}`,
      leads: [],
    };
  }
  if (attempt.response.status === 401) {
    return {
      ok: false,
      configured: true,
      code: "unauthorized",
      status: 401,
      message:
        "BuildMyBot lead ingest rejected the bearer token (401). BUILDMYBOT_LEAD_INGEST_TOKEN does not match the BuildMyBot ingest token.",
      leads: [],
    };
  }
  if (attempt.response.status === 503) {
    return {
      ok: false,
      configured: true,
      code: "ingest_disabled",
      status: 503,
      message:
        "BuildMyBot lead ingest is disabled (503). BuildMyBot is not accepting APEX leads.",
      leads: [],
    };
  }
  if (!attempt.response.ok) {
    return {
      ok: false,
      configured: true,
      code: "http_error",
      status: attempt.response.status,
      message: `BuildMyBot lead ingest request failed (HTTP ${attempt.response.status}).`,
      leads: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = await attempt.response.json();
  } catch {
    return {
      ok: false,
      configured: true,
      code: "invalid_response",
      status: attempt.response.status,
      message: "BuildMyBot lead ingest returned a non-JSON success response.",
      leads: [],
    };
  }
  const body =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  if (!body || !Array.isArray(body.leads)) {
    return {
      ok: false,
      configured: true,
      code: "invalid_response",
      status: attempt.response.status,
      message: "BuildMyBot lead ingest returned an unexpected response shape.",
      leads: [],
    };
  }
  return { ok: true, configured: true, leads: body.leads };
}
